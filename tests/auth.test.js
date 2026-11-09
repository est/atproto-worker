import test from 'node:test'
import assert from 'node:assert'
import { DatabaseSync } from 'node:sqlite'

import { Firehose } from '../src/firehose.js'
import {
  AuthError,
  hashPassword,
  verifyPassword,
  signJwt,
  verifyJwt,
  requireAuth,
  requireBootstrapAuth,
  getAccount,
  getRepoKey,
  createSessionForAccount,
  handleAuthXrpc
} from '../src/auth.js'
import { bytesToBase64, sha256 } from '../src/shared.js'

const DID = 'did:web:alice.example'
const HANDLE = 'alice.example'
const PASSWORD = 'correct horse battery staple'
const BOOTSTRAP = 'test-bootstrap-token'
const JWT_SECRET = 'test-jwt-secret'

/**
 * Minimal `state.storage.sql` shim backed by Node's built-in SQLite, mirroring
 * the approach in tests/ledger.test.js. `.one()` throws on empty results to
 * match Cloudflare's DO SQL API.
 */
function makeSqlShim() {
  const db = new DatabaseSync(':memory:')
  return {
    _db: db,
    exec(sql, ...bindings) {
      const stmt = db.prepare(sql)
      const columns = stmt.columns()
      if (columns.length > 0) {
        return cursor(stmt.all(...bindings))
      }
      stmt.run(...bindings)
      return cursor([])
    }
  }
}

function cursor(rows) {
  return {
    toArray: () => rows,
    one: () => {
      if (rows.length === 0) throw new Error('Expected exactly one result from SQL query, but got no results.')
      return rows[0]
    },
    [Symbol.iterator]: () => rows[Symbol.iterator]()
  }
}

function makeEnv(overrides = {}) {
  const kv = new Map()
  const sql = makeSqlShim()
  const state = {
    storage: {
      sql,
      get: async key => kv.get(key),
      put: async (key, value) => { kv.set(key, value) }
    },
    waitUntil() {},
    acceptWebSocket() {},
    getWebSockets() { return [] }
  }
  const firehose = new Firehose(state, {})
  const env = {
    JWT_SECRET,
    BOOTSTRAP_TOKEN: BOOTSTRAP,
    ...overrides,
    FIREHOSE: {
      idFromName: () => 'main',
      get: () => ({
        fetch: (url, opts) => firehose.fetch(new Request(url, opts))
      })
    }
  }
  return { env, firehose, sql }
}

function bearer(token) {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function call(env, method, body, { token, query, httpMethod } = {}) {
  const suffix = query ? `?${query}` : ''
  const url = `http://pds.test/xrpc/${method}${suffix}`
  const hasBody = body !== undefined
  const request = new Request(url, {
    method: httpMethod || (hasBody ? 'POST' : 'GET'),
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...bearer(token)
    },
    body: hasBody ? JSON.stringify(body) : undefined
  })
  const response = await handleAuthXrpc(request, method, env, {})
  const data = await response.json().catch(() => null)
  return { status: response.status, data }
}

async function bootstrap(env, body = {}) {
  return call(env, 'com.atproto.worker.bootstrapAccount', {
    did: DID,
    handle: HANDLE,
    password: PASSWORD,
    ...body
  }, { token: BOOTSTRAP })
}

async function login(env, password = PASSWORD) {
  return call(env, 'com.atproto.server.createSession', { identifier: HANDLE, password })
}

// ============ Password hashing ============

test('auth - PBKDF2 hash/verify round trip, salt uniqueness, constant-shape errors', async () => {
  const first = await hashPassword('hunter2')
  assert.strictEqual(first.iterations, 210000)
  assert.ok(first.hash.length > 0)
  assert.ok(first.salt.length > 0)

  const account = {
    passwordHash: first.hash,
    passwordSalt: first.salt,
    passwordIterations: first.iterations
  }
  assert.strictEqual(await verifyPassword('hunter2', account), true)
  assert.strictEqual(await verifyPassword('wrong', account), false)

  // Raw snake_case SQL rows are accepted too (migration/tooling paths).
  assert.strictEqual(await verifyPassword('hunter2', {
    password_hash: first.hash,
    password_salt: first.salt,
    password_iterations: first.iterations
  }), true)
  assert.strictEqual(await verifyPassword('hunter2', {}), false)
  assert.strictEqual(await verifyPassword('hunter2', null), false)

  const second = await hashPassword('hunter2')
  assert.notStrictEqual(first.salt, second.salt, 'salt must be random per hash')
  assert.notStrictEqual(first.hash, second.hash)
})

// ============ JWT ============

test('auth - JWT sign/verify, tampering, expiry, future iat, no padding', async () => {
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    iss: DID,
    aud: DID,
    sub: DID,
    scope: 'com.atproto.access',
    iat: now,
    exp: now + 60,
    jti: 'jwt-test-jti'
  }
  const token = await signJwt(payload, 'secret')
  assert.ok(!token.includes('='), 'JWT segments must be unpadded base64url')
  assert.deepStrictEqual(await verifyJwt(token, 'secret'), payload)

  // Wrong secret.
  assert.strictEqual(await verifyJwt(token, 'other-secret'), null)

  const [header, body, signature] = token.split('.')

  // Payload tamper: first base64 character is always significant.
  const tamperedBody = (body[0] === 'e' ? 'f' : 'e') + body.slice(1)
  assert.strictEqual(await verifyJwt(`${header}.${tamperedBody}.${signature}`, 'secret'), null)

  // Signature tamper.
  const tamperedSig = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1)
  assert.strictEqual(await verifyJwt(`${header}.${body}.${tamperedSig}`, 'secret'), null)

  // Expired.
  const expired = await signJwt({ ...payload, iat: now - 100, exp: now - 1 }, 'secret')
  assert.strictEqual(await verifyJwt(expired, 'secret'), null)

  // Missing exp is rejected.
  const noExp = await signJwt({ sub: DID }, 'secret')
  assert.strictEqual(await verifyJwt(noExp, 'secret'), null)

  // Issued in the future (beyond clock skew) is rejected.
  const future = await signJwt({ ...payload, iat: now + 3600, exp: now + 7200 }, 'secret')
  assert.strictEqual(await verifyJwt(future, 'secret'), null)

  // Malformed tokens.
  assert.strictEqual(await verifyJwt('not-a-jwt', 'secret'), null)
  assert.strictEqual(await verifyJwt('a.b', 'secret'), null)
})

// ============ Bootstrap ============

test('auth - bootstrapAccount creates an idempotent worker-signed account + P-256 repo key', async () => {
  const { env } = makeEnv()

  const first = await bootstrap(env)
  assert.strictEqual(first.status, 200, JSON.stringify(first.data))
  assert.strictEqual(first.data.did, DID)
  assert.strictEqual(first.data.handle, HANDLE)
  assert.ok(first.data.publicKeyMultibase.startsWith('zDna'), 'P-256 Multikey expected')
  assert.strictEqual(first.data.didDoc.id, DID)
  assert.strictEqual(first.data.didDoc.verificationMethod[0].id, `${DID}#atproto`)
  assert.strictEqual(
    first.data.didDoc.verificationMethod[0].publicKeyMultibase,
    first.data.publicKeyMultibase
  )
  assert.strictEqual(first.data.didDoc.service[0].serviceEndpoint, `https://${HANDLE}`)

  const account = await getAccount(env, { did: DID })
  assert.ok(account)
  assert.strictEqual(account.handle, HANDLE)
  assert.strictEqual(account.mode, 'worker-signed')
  assert.strictEqual(account.active, true)
  assert.notStrictEqual(account.passwordHash, PASSWORD)
  assert.ok(account.passwordSalt)
  assert.strictEqual(account.passwordIterations, 210000)

  const key = await getRepoKey(env, DID)
  assert.ok(key)
  assert.strictEqual(key.curve, 'p256')
  assert.strictEqual(key.publicKeyMultibase, first.data.publicKeyMultibase)
  assert.ok(key.privateKeyPkcs8.length > 0)

  // Idempotent: a second bootstrap returns the same key and does NOT reset the
  // password (the different password only takes effect with resetPassword).
  const again = await bootstrap(env, { password: 'a different password' })
  assert.strictEqual(again.status, 200)
  assert.strictEqual(again.data.publicKeyMultibase, first.data.publicKeyMultibase)
  assert.strictEqual(again.data.didDoc.id, first.data.didDoc.id)

  const original = await login(env, PASSWORD)
  assert.strictEqual(original.status, 200, JSON.stringify(original.data))
  assert.strictEqual((await login(env, 'a different password')).status, 401)
})

test('auth - bootstrapAccount password reset keeps the repo key and swaps the hash', async () => {
  const { env } = makeEnv()
  const first = await bootstrap(env)

  const reset = await bootstrap(env, { password: 'brand new password', resetPassword: true })
  assert.strictEqual(reset.status, 200, JSON.stringify(reset.data))
  assert.strictEqual(reset.data.publicKeyMultibase, first.data.publicKeyMultibase)

  assert.strictEqual((await login(env, PASSWORD)).status, 401)
  const fresh = await login(env, 'brand new password')
  assert.strictEqual(fresh.status, 200, JSON.stringify(fresh.data))

  // Login by DID works as well as by handle.
  const byDid = await call(env, 'com.atproto.server.createSession', {
    identifier: DID,
    password: 'brand new password'
  })
  assert.strictEqual(byDid.status, 200)
})

test('auth - bootstrapAccount validates identity/mode and the bootstrap token', async () => {
  const { env } = makeEnv()

  const missingToken = await call(env, 'com.atproto.worker.bootstrapAccount', {
    did: DID, handle: HANDLE, password: PASSWORD
  })
  assert.strictEqual(missingToken.status, 401)
  assert.strictEqual(missingToken.data.error, 'AuthRequired')

  const wrongToken = await bootstrap(env).then(() =>
    call(env, 'com.atproto.worker.bootstrapAccount', {
      did: DID, handle: HANDLE, password: PASSWORD
    }, { token: 'wrong-token' })
  )
  assert.strictEqual(wrongToken.status, 401)

  const badDid = await bootstrap(env, { did: 'did:plc:abc123', handle: HANDLE })
  assert.strictEqual(badDid.status, 400)

  const mismatched = await bootstrap(env, {
    did: 'did:web:bob.example', handle: HANDLE
  })
  assert.strictEqual(mismatched.status, 400)

  const badMode = await bootstrap(env, { mode: 'owner-signed' })
  assert.strictEqual(badMode.status, 400)

  const noConfiguredToken = makeEnv()
  delete noConfiguredToken.env.BOOTSTRAP_TOKEN
  const unavailable = await call(noConfiguredToken.env, 'com.atproto.worker.bootstrapAccount', {
    did: DID, handle: HANDLE, password: PASSWORD
  }, { token: 'anything' })
  assert.strictEqual(unavailable.status, 503)
  assert.strictEqual(unavailable.data.error, 'AuthNotConfigured')

  await assert.rejects(
    () => requireBootstrapAuth(new Request('http://pds.test/x', { headers: bearer('anything') }), noConfiguredToken.env),
    e => e instanceof AuthError && e.status === 503 && e.error === 'AuthNotConfigured'
  )

  // Localhost dev DIDs are accepted.
  const dev = await bootstrap(env, {
    did: 'did:web:localhost:8787', handle: 'localhost:8787'
  })
  assert.strictEqual(dev.status, 200, JSON.stringify(dev.data))
})

// ============ Session lifecycle ============

test('auth - createSession/getSession/refreshSession/deleteSession', async () => {
  const { env, sql } = makeEnv()
  assert.strictEqual((await bootstrap(env)).status, 200)

  const created = await login(env)
  assert.strictEqual(created.status, 200, JSON.stringify(created.data))
  const { accessJwt, refreshJwt, did, didDoc, handle, active } = created.data
  assert.strictEqual(did, DID)
  assert.strictEqual(handle, HANDLE)
  assert.strictEqual(active, true)
  assert.ok(accessJwt && refreshJwt && didDoc)
  assert.notStrictEqual(accessJwt, refreshJwt)

  const access = await verifyJwt(accessJwt, env.JWT_SECRET)
  assert.strictEqual(access.scope, 'com.atproto.access')
  assert.strictEqual(access.iss, DID)
  assert.strictEqual(access.aud, DID)
  assert.strictEqual(access.sub, DID)
  assert.ok(access.jti)
  assert.ok(access.exp > access.iat)

  const refresh = await verifyJwt(refreshJwt, env.JWT_SECRET)
  assert.strictEqual(refresh.scope, 'com.atproto.refresh')
  assert.strictEqual(refresh.typ, 'refresh+jwt')
  assert.strictEqual(refresh.sub, DID)

  // getSession (GET semantics, Bearer access).
  const got = await call(env, 'com.atproto.server.getSession', undefined, { token: accessJwt })
  assert.strictEqual(got.status, 200, JSON.stringify(got.data))
  assert.strictEqual(got.data.did, DID)
  assert.strictEqual(got.data.handle, HANDLE)
  assert.strictEqual(got.data.active, true)
  assert.deepStrictEqual(got.data.didDoc, didDoc)

  // requireAuth returns the account.
  const authorized = await requireAuth(
    new Request('http://pds.test/x', { headers: bearer(accessJwt) }),
    env
  )
  assert.strictEqual(authorized.did, DID)
  assert.strictEqual(authorized.handle, HANDLE)
  assert.strictEqual(authorized.account.did, DID)

  // refreshSession rotates both tokens.
  const refreshed = await call(env, 'com.atproto.server.refreshSession', {}, { token: refreshJwt })
  assert.strictEqual(refreshed.status, 200, JSON.stringify(refreshed.data))
  assert.notStrictEqual(refreshed.data.accessJwt, accessJwt)
  assert.notStrictEqual(refreshed.data.refreshJwt, refreshJwt)
  assert.strictEqual(refreshed.data.did, DID)

  // The old refresh jti is revoked and cannot be replayed.
  const oldRow = sql._db.prepare('SELECT revoked_at FROM sessions WHERE jti = ?').get(refresh.jti)
  assert.ok(oldRow.revoked_at, 'old session must be revoked')
  const replay = await call(env, 'com.atproto.server.refreshSession', {}, { token: refreshJwt })
  assert.strictEqual(replay.status, 401)

  // The rotated access token still authenticates.
  const got2 = await call(env, 'com.atproto.server.getSession', undefined, {
    token: refreshed.data.accessJwt
  })
  assert.strictEqual(got2.status, 200)

  // deleteSession revokes the current refresh token.
  const deleted = await call(env, 'com.atproto.server.deleteSession', {}, {
    token: refreshed.data.refreshJwt
  })
  assert.strictEqual(deleted.status, 200)
  assert.deepStrictEqual(deleted.data, {})

  const afterDelete = await call(env, 'com.atproto.server.refreshSession', {}, {
    token: refreshed.data.refreshJwt
  })
  assert.strictEqual(afterDelete.status, 401)
})

test('auth - createSessionForAccount stores refresh jti + SHA-256 hash', async () => {
  const { env, sql } = makeEnv()
  assert.strictEqual((await bootstrap(env)).status, 200)
  const account = await getAccount(env, { did: DID })

  const tokens = await createSessionForAccount(env, account, {
    accessTtlSec: 60,
    refreshTtlSec: 120
  })
  assert.ok(tokens.accessJwt && tokens.refreshJwt)
  assert.strictEqual(tokens.accessJti.length > 0, true)
  assert.strictEqual(tokens.refreshJti.length > 0, true)

  const row = sql._db.prepare('SELECT * FROM sessions WHERE jti = ?').get(tokens.refreshJti)
  assert.ok(row)
  assert.strictEqual(row.did, DID)
  const expectedHash = bytesToBase64(await sha256(tokens.refreshJwt))
  assert.strictEqual(row.refresh_hash, expectedHash)
  assert.notStrictEqual(row.refresh_hash, tokens.refreshJwt)
  assert.ok(row.access_expires_at)
  assert.ok(row.refresh_expires_at)
})

test('auth - createSession rejects bad passwords, unknown accounts and inactive accounts', async () => {
  const { env, firehose } = makeEnv()
  assert.strictEqual((await bootstrap(env)).status, 200)

  const badPassword = await login(env, 'definitely wrong')
  assert.strictEqual(badPassword.status, 401)
  assert.strictEqual(badPassword.data.error, 'AuthenticationRequired')

  const unknown = await call(env, 'com.atproto.server.createSession', {
    identifier: 'nobody.example',
    password: PASSWORD
  })
  assert.strictEqual(unknown.status, 401, 'unknown users must not be enumerable')

  const missing = await call(env, 'com.atproto.server.createSession', { identifier: HANDLE })
  assert.strictEqual(missing.status, 400)

  // Disable the account through the internal DO route.
  const account = await getAccount(env, { did: DID })
  const disabled = await firehose.fetch(new Request('http://ledger/account', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: { ...account, active: false } })
  }))
  assert.strictEqual(disabled.status, 200)
  assert.strictEqual((await getAccount(env, { did: DID })).active, false)

  const rejected = await login(env)
  assert.strictEqual(rejected.status, 403)
  assert.strictEqual(rejected.data.error, 'AccountDisabled')
})

test('auth - accountDidDoc is public, key-bearing, and 404s for unknown DIDs', async () => {
  const { env } = makeEnv()
  const first = await bootstrap(env)

  const doc = await call(env, 'com.atproto.worker.accountDidDoc', undefined, {
    query: `did=${encodeURIComponent(DID)}`
  })
  assert.strictEqual(doc.status, 200)
  assert.strictEqual(doc.data.did, DID)
  assert.strictEqual(doc.data.handle, HANDLE)
  assert.deepStrictEqual(doc.data.didDoc, first.data.didDoc)

  const missing = await call(env, 'com.atproto.worker.accountDidDoc', undefined, {
    query: `did=${encodeURIComponent('did:web:missing.example')}`
  })
  assert.strictEqual(missing.status, 404)
})

// ============ requireAuth ============

test('auth - requireAuth rejects missing/expired/tampered/wrong-scope tokens', async () => {
  const { env } = makeEnv()
  assert.strictEqual((await bootstrap(env)).status, 200)

  const req = token => new Request('http://pds.test/xrpc/x', { headers: bearer(token) })
  const isAuthRequired = e => e instanceof AuthError && e.status === 401 && e.error === 'AuthRequired'

  await assert.rejects(() => requireAuth(req(null), env), isAuthRequired)

  const now = Math.floor(Date.now() / 1000)
  const base = { iss: DID, aud: DID, sub: DID, jti: 'j' }

  const expired = await signJwt({
    ...base, scope: 'com.atproto.access', iat: now - 100, exp: now - 1
  }, env.JWT_SECRET)
  await assert.rejects(() => requireAuth(req(expired), env), isAuthRequired)

  const wrongScope = await signJwt({
    ...base, scope: 'com.atproto.refresh', iat: now, exp: now + 60
  }, env.JWT_SECRET)
  await assert.rejects(() => requireAuth(req(wrongScope), env), isAuthRequired)

  const valid = await signJwt({
    ...base, scope: 'com.atproto.access', iat: now, exp: now + 60
  }, env.JWT_SECRET)
  const [h, p, s] = valid.split('.')
  const tampered = `${h}.${p}.${(s[0] === 'A' ? 'B' : 'A') + s.slice(1)}`
  await assert.rejects(() => requireAuth(req(tampered), env), isAuthRequired)

  // Unknown DID signed with the right secret.
  const unknownDid = await signJwt({
    ...base, sub: 'did:web:unknown.example', iss: 'did:web:unknown.example',
    scope: 'com.atproto.access', iat: now, exp: now + 60
  }, env.JWT_SECRET)
  await assert.rejects(() => requireAuth(req(unknownDid), env), isAuthRequired)

  // Valid access token succeeds.
  const ok = await requireAuth(req(valid), env)
  assert.strictEqual(ok.did, DID)

  // Missing JWT_SECRET is a configuration error, not an auth failure.
  const noSecret = makeEnv()
  delete noSecret.env.JWT_SECRET
  await assert.rejects(
    () => requireAuth(req(valid), noSecret.env),
    e => e instanceof AuthError && e.status === 503 && e.error === 'AuthNotConfigured'
  )
})

// ============ Internal DO routes ============

test('auth - DO routes upsert account, filter retired repo keys, and revoke sessions', async () => {
  const { firehose, sql } = makeEnv()
  const post = (path, body) => firehose.fetch(new Request(`http://ledger${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }))
  const get = path => firehose.fetch(new Request(`http://ledger${path}`))

  const account = {
    did: DID, handle: HANDLE, mode: 'worker-signed',
    passwordHash: 'h', passwordSalt: 's', passwordIterations: 210000,
    repoKeyId: 'key-1', active: true, createdAt: '2026-01-01T00:00:00.000Z'
  }
  const created = await post('/account', { account })
  assert.strictEqual(created.status, 200)
  assert.strictEqual((await created.json()).account.did, DID)

  // Upsert by did updates the password without changing identity.
  const updated = await post('/account', {
    account: { ...account, passwordHash: 'h2', handle: HANDLE }
  })
  assert.strictEqual(updated.status, 200)
  const byHandle = await (await get(`/account?handle=${encodeURIComponent(HANDLE)}`)).json()
  assert.strictEqual(byHandle.account.passwordHash, 'h2')

  // Unique handle protection.
  const conflict = await post('/account', {
    account: { ...account, did: 'did:web:other.example' }
  })
  assert.strictEqual(conflict.status, 409)
  assert.strictEqual((await conflict.json()).error, 'AccountConflict')

  assert.strictEqual((await get(`/account?did=${encodeURIComponent('did:web:nope.example')}`)).status, 404)

  const baseKey = {
    id: 'key-1', did: DID, curve: 'p256',
    publicKeyMultibase: 'zDnaexample', privateKeyPkcs8: 'cGtjczg=',
    createdAt: '2026-01-01T00:00:00.000Z'
  }
  assert.strictEqual((await post('/repo-key', { key: baseKey })).status, 200)
  // Retire key-1, then a newer key becomes the active one.
  sql._db.prepare('UPDATE repo_keys SET retired_at = ? WHERE id = ?').run('2026-02-01T00:00:00.000Z', 'key-1')
  assert.strictEqual((await get(`/repo-key?did=${encodeURIComponent(DID)}`)).status, 404)

  const key2 = { ...baseKey, id: 'key-2', publicKeyMultibase: 'zDnaexample2', createdAt: '2026-03-01T00:00:00.000Z' }
  assert.strictEqual((await post('/repo-key', { key: key2 })).status, 200)
  const active = await (await get(`/repo-key?did=${encodeURIComponent(DID)}`)).json()
  assert.strictEqual(active.key.id, 'key-2')

  const session = {
    jti: 'sess-1', did: DID, refreshHash: 'hash',
    accessExpiresAt: '2026-01-01T01:00:00.000Z',
    refreshExpiresAt: '2026-04-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z'
  }
  assert.strictEqual((await post('/session', { session })).status, 200)
  const stored = await (await get('/session?jti=sess-1')).json()
  assert.strictEqual(stored.session.refreshHash, 'hash')
  assert.strictEqual(stored.session.revokedAt, null)

  const revoked = await post('/session/revoke', { jti: 'sess-1', revokedAt: '2026-01-02T00:00:00.000Z' })
  assert.strictEqual(revoked.status, 200)
  const after = await (await get('/session?jti=sess-1')).json()
  assert.strictEqual(after.session.revokedAt, '2026-01-02T00:00:00.000Z')
  assert.strictEqual((await post('/session/revoke', { jti: 'missing' })).status, 404)
})
