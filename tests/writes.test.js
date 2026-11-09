/**
 * M3 worker-signed repo write path tests.
 *
 * Uses the real Firehose DO (backed by Node's `node:sqlite`) plus an
 * in-test `auth` module stub (src/auth.js is implemented separately).
 */

import test from 'node:test'
import assert from 'node:assert'
import { DatabaseSync } from 'node:sqlite'

import { Firehose } from '../src/firehose.js'
import { Journal } from '../src/journal.js'
import { Repo } from '../src/repo-core.js'
import {
  RepoWriteError,
  appendEventInternal,
  buildEvent,
  handleRepoWriteXrpc,
  loadRepoForDid,
  MAX_APPLY_WRITES,
} from '../src/writes.js'
import { generateP256Keypair, signP256, verifyP256 } from '../src/keys.js'
import {
  base64ToBytes,
  cborDecode,
  cborEncode,
  commitToCbor,
  computeCID,
  readCarFile,
} from '../src/shared.js'

const DID = 'did:web:writer.phase3.test'
const HANDLE = 'writer.phase3.test'
const OTHER_DID = 'did:web:other.phase3.test'
const COLLECTION = 'app.bsky.feed.post'

const post = text => ({
  $type: COLLECTION,
  text,
  createdAt: '2026-11-09T00:00:00.000Z',
})

// ============ Firehose ledger shim (same shape as tests/ledger.test.js) ===

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
    },
  }
}

function cursor(rows) {
  return {
    toArray: () => rows,
    one: () => {
      if (rows.length === 0) {
        throw new Error('Expected exactly one result from SQL query, but got no results.')
      }
      return rows[0]
    },
    [Symbol.iterator]: () => rows[Symbol.iterator](),
  }
}

function makeLedger() {
  const kv = new Map()
  const sql = makeSqlShim()
  const state = {
    storage: {
      sql,
      get: async key => kv.get(key),
      put: async (key, value) => { kv.set(key, value) },
    },
    waitUntil() {},
    acceptWebSocket() {},
    getWebSockets() { return [] },
  }
  const firehose = new Firehose(state, {})
  return { firehose, sql, state, kv }
}

async function snapshot(ledger) {
  const response = await ledger.firehose.fetch(new Request('http://ledger/snapshot'))
  const text = await response.text()
  return text.trim() ? text.trim().split('\n').map(line => JSON.parse(line)) : []
}

async function headOf(ledger, did) {
  const response = await ledger.firehose.fetch(
    new Request(`http://ledger/head?did=${encodeURIComponent(did)}`),
  )
  return response.json()
}

async function journalFromLedger(ledger) {
  const events = await snapshot(ledger)
  return {
    events,
    loaded: true,
    distinctDids: () => new Set(events.map(e => e.did)),
  }
}

// ============ Auth stub / harness ============

async function setup({ mode = 'worker-signed', withKey = true } = {}) {
  const ledger = makeLedger()
  const key = await generateP256Keypair()

  const env = {
    FIREHOSE: {
      idFromName: () => 'main',
      get: () => ({
        fetch: (url, opts) => ledger.firehose.fetch(new Request(url, opts)),
      }),
    },
    __mode: mode,
    __key: withKey ? key : null,
    __sessionDid: DID,
    __authError: null,
  }

  class AuthError extends Error {
    constructor(status, error, message) {
      super(message)
      this.name = 'AuthError'
      this.status = status
      this.error = error
    }
  }

  const account = did => ({ did, handle: did === DID ? HANDLE : 'other.phase3.test', mode: env.__mode })

  const auth = {
    AuthError,
    async requireAuth(request, e) {
      if (e.__authError) throw e.__authError
      const did = request.headers.get('x-test-did') || e.__sessionDid
      return { did, handle: did === DID ? HANDLE : 'other.phase3.test', account: account(did) }
    },
    async getAccount(e, { did, handle } = {}) {
      if (did) return did === DID ? account(DID) : null
      if (handle === HANDLE) return account(DID)
      return null
    },
    async getRepoKey(e, did) {
      if (did !== DID || !e.__key) return null
      return {
        id: 'repo-key-1',
        did,
        curve: 'p256',
        publicKeyMultibase: e.__key.publicKeyMultibase,
        privateKeyPkcs8: e.__key.privateKeyPkcs8,
      }
    },
  }

  return { ledger, key, env, auth, journal: { events: [], loaded: true } }
}

async function call(ctx, method, body, { journal, headers = {} } = {}) {
  const request = new Request(`https://worker.test/xrpc/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const response = await handleRepoWriteXrpc(request, method, ctx.env, {}, {
    journal: journal ?? ctx.journal,
    auth: ctx.auth,
    ownHost: 'worker.test',
  })
  let data = null
  try {
    data = await response.json()
  } catch {
    data = null
  }
  return { response, data }
}

async function assertEventSignature(key, event) {
  const { sig, ...unsigned } = event.commit
  assert.strictEqual(typeof sig, 'string')
  assert.strictEqual(sig.length, 128)
  assert.strictEqual(
    await verifyP256(key.publicKey, commitToCbor(unsigned), sig),
    true,
    'commit signature must verify with the worker P-256 key',
  )
}

function parseEventCar(event) {
  return readCarFile(base64ToBytes(event.blocksB64))
}

// ============ Repo.applyWrites ============

test('repo-core applyWrites - mixed writes produce one signed commit in order', async () => {
  const key = await generateP256Keypair()
  const repo = await Repo.create({ did: DID, signingKey: key.privateKey })

  await repo.applyWrite({ action: 'create', collection: COLLECTION, rkey: 'b', record: post('B') })
  await repo.applyWrite({ action: 'create', collection: COLLECTION, rkey: 'c', record: post('C') })
  const before = repo.getHead()
  const beforeMstRoot = await repo.mst.getPointer()

  const result = await repo.applyWrites(
    [
      { action: 'create', collection: COLLECTION, rkey: 'a', record: post('A') },
      { action: 'update', collection: COLLECTION, rkey: 'b', record: post('B2') },
      { action: 'delete', collection: COLLECTION, rkey: 'c' },
    ],
    encoded => signP256(key.privateKey, encoded),
  )

  assert.deepStrictEqual(result.results.map(r => r.action), ['create', 'update', 'delete'])
  assert.deepStrictEqual(result.results.map(r => r.rkey), ['a', 'b', 'c'])
  assert.strictEqual(result.results[0].recordCid, await computeCID(post('A')))
  assert.strictEqual(result.results[1].recordCid, await computeCID(post('B2')))
  assert.strictEqual(result.results[2].recordCid, null)

  assert.strictEqual(result.commit.prev, before.commitCid)
  assert.strictEqual(result.commit.data, result.mstRoot)
  assert.strictEqual(result.prevMstRoot, beforeMstRoot)
  assert.ok(result.newBlocks.has(result.commitCid))
  assert.ok(result.newBlocks.has(result.mstRoot))

  await assertEventSignature(key, { commit: result.commit })
  assert.deepStrictEqual(await repo.getRecord(COLLECTION, 'a'), post('A'))
  assert.deepStrictEqual(await repo.getRecord(COLLECTION, 'b'), post('B2'))
  assert.strictEqual(await repo.getRecordCid(COLLECTION, 'c'), null)
  assert.deepStrictEqual(repo.getHead(), { commitCid: result.commitCid, rev: result.rev })
})

test('repo-core applyWrites - rejects duplicate create, missing update/delete, empty', async () => {
  const key = await generateP256Keypair()
  const repo = await Repo.create({ did: DID, signingKey: key.privateKey })
  await repo.applyWrite({ action: 'create', collection: COLLECTION, rkey: 'x', record: post('X') })

  await assert.rejects(
    repo.applyWrites([{ action: 'create', collection: COLLECTION, rkey: 'x', record: post('dup') }]),
    /already a value/,
  )
  await assert.rejects(
    repo.applyWrites([{ action: 'update', collection: COLLECTION, rkey: 'missing', record: post('m') }]),
    /Could not find a record/,
  )
  await assert.rejects(
    repo.applyWrites([{ action: 'delete', collection: COLLECTION, rkey: 'missing' }]),
    /Could not find a record/,
  )
  await assert.rejects(repo.applyWrites([]), /non-empty array/)

  // Failed batches must not advance the head.
  assert.strictEqual(repo.getHead().rev, repo.rev)
})

// ============ createRecord ============

test('writes - createRecord signs, appends, and is readable from the ledger', async () => {
  const ctx = await setup()
  const record = post('hello m3')

  const { response, data } = await call(ctx, 'com.atproto.repo.createRecord', {
    repo: HANDLE,
    collection: COLLECTION,
    record,
  })
  assert.strictEqual(response.status, 200, JSON.stringify(data))
  assert.strictEqual(response.headers.get('content-type'), 'application/json')

  const rkey = data.uri.split('/').pop()
  assert.match(rkey, /^[234567abcdefghijklmnopqrstuvwxyz]{13}$/)
  assert.strictEqual(data.uri, `at://${DID}/${COLLECTION}/${rkey}`)
  assert.strictEqual(data.cid, await computeCID(record))
  assert.strictEqual(data.validationStatus, 'valid')
  assert.ok(data.commit.cid)
  assert.ok(data.commit.rev)

  const head = await headOf(ctx.ledger, DID)
  assert.strictEqual(head.commitCid, data.commit.cid)
  assert.strictEqual(head.rev, data.commit.rev)
  assert.match(head.mstRoot, /^b[a-z2-7]{58}$/)

  const events = await snapshot(ctx.ledger)
  assert.strictEqual(events.length, 1)
  const event = events[0]
  assert.strictEqual(event.did, DID)
  assert.strictEqual(event.op, 'create')
  assert.strictEqual(event.collection, COLLECTION)
  assert.strictEqual(event.rkey, rkey)
  assert.deepStrictEqual(event.record, record)
  assert.strictEqual(event.recordCid, data.cid)
  assert.strictEqual(event.rev, data.commit.rev)
  assert.strictEqual(event.commitCid, data.commit.cid)
  assert.strictEqual(event.mstRoot, event.commit.data)
  assert.strictEqual(event.prev, null)
  assert.strictEqual(event.prevMstRoot, null)
  assert.strictEqual(event.signingKey, ctx.key.publicKeyMultibase)
  assert.strictEqual(event.offset, 0)

  await assertEventSignature(ctx.key, event)

  const car = parseEventCar(event)
  assert.deepStrictEqual(car.roots, [event.commitCid])
  for (const cid of [event.commitCid, event.mstRoot, event.recordCid]) {
    assert.ok(car.blocks.has(cid), `CAR must contain ${cid}`)
  }
  const decoded = cborDecode(car.blocks.get(event.commitCid))
  assert.strictEqual(decoded.did, DID)
  assert.strictEqual(decoded.version, 3)
  assert.strictEqual(decoded.rev, event.rev)
  assert.deepStrictEqual(decoded.data, { $link: event.mstRoot })
  assert.deepStrictEqual(decoded.prev, null)

  // The normal read model sees the new record immediately.
  const journal = new Journal(ctx.env)
  await journal.load()
  assert.deepStrictEqual(journal.getRecord(DID, COLLECTION, rkey).record, record)

  // The write path can also reload its own repo from the ledger events.
  const repo = await loadRepoForDid({ events }, DID, ctx.key.privateKeyPkcs8)
  assert.deepStrictEqual(repo.getHead(), {
    commitCid: data.commit.cid,
    rev: data.commit.rev,
  })
  assert.deepStrictEqual(await repo.getRecord(COLLECTION, rkey), record)
})

test('writes - createRecord validates rkey/collection/$type and rejects duplicates', async () => {
  const ctx = await setup()

  const ok = await call(ctx, 'com.atproto.repo.createRecord', {
    repo: DID,
    collection: COLLECTION,
    rkey: 'fixedkey',
    record: post('one'),
  })
  assert.strictEqual(ok.response.status, 200, JSON.stringify(ok.data))

  let journal = await journalFromLedger(ctx.ledger)

  const dup = await call(ctx, 'com.atproto.repo.createRecord', {
    repo: DID,
    collection: COLLECTION,
    rkey: 'fixedkey',
    record: post('two'),
  }, { journal })
  assert.strictEqual(dup.response.status, 400)
  assert.strictEqual(dup.data.error, 'InvalidRequest')

  const badType = await call(ctx, 'com.atproto.repo.createRecord', {
    repo: DID,
    collection: COLLECTION,
    rkey: 'otherkey',
    record: { ...post('x'), $type: 'app.bsky.feed.like' },
  }, { journal })
  assert.strictEqual(badType.response.status, 400)
  assert.strictEqual(badType.data.error, 'InvalidRequest')

  const badCollection = await call(ctx, 'com.atproto.repo.createRecord', {
    repo: DID,
    collection: 'not an nsid',
    record: { text: 'x' },
  }, { journal })
  assert.strictEqual(badCollection.response.status, 400)

  // Only the successful write reached the ledger.
  assert.strictEqual((await snapshot(ctx.ledger)).length, 1)
})

// ============ putRecord ============

test('writes - putRecord updates existing, creates missing, and enforces swaps', async () => {
  const ctx = await setup()

  const created = await call(ctx, 'com.atproto.repo.createRecord', {
    repo: DID,
    collection: COLLECTION,
    rkey: 'p1',
    record: post('v1'),
  })
  assert.strictEqual(created.response.status, 200, JSON.stringify(created.data))

  let journal = await journalFromLedger(ctx.ledger)
  const updated = await call(ctx, 'com.atproto.repo.putRecord', {
    repo: DID,
    collection: COLLECTION,
    rkey: 'p1',
    record: post('v2'),
    swapRecord: created.data.cid,
    swapCommit: created.data.commit.cid,
  }, { journal })
  assert.strictEqual(updated.response.status, 200, JSON.stringify(updated.data))
  assert.strictEqual(updated.data.uri, `at://${DID}/${COLLECTION}/p1`)
  assert.strictEqual(updated.data.cid, await computeCID(post('v2')))
  assert.strictEqual(updated.data.validationStatus, 'valid')
  assert.strictEqual(updated.data.commit.cid, (await headOf(ctx.ledger, DID)).commitCid)

  journal = await journalFromLedger(ctx.ledger)
  const lastUpdate = (await snapshot(ctx.ledger)).at(-1)
  assert.strictEqual(lastUpdate.op, 'update')
  assert.strictEqual(lastUpdate.prev, created.data.commit.cid)
  await assertEventSignature(ctx.key, lastUpdate)

  const createdMissing = await call(ctx, 'com.atproto.repo.putRecord', {
    repo: DID,
    collection: COLLECTION,
    rkey: 'p2',
    record: post('new'),
  }, { journal })
  assert.strictEqual(createdMissing.response.status, 200, JSON.stringify(createdMissing.data))
  assert.strictEqual((await snapshot(ctx.ledger)).at(-1).op, 'create')

  journal = await journalFromLedger(ctx.ledger)

  const badRecordSwap = await call(ctx, 'com.atproto.repo.putRecord', {
    repo: DID,
    collection: COLLECTION,
    rkey: 'p1',
    record: post('v3'),
    swapRecord: 'b' + 'a'.repeat(58),
  }, { journal })
  assert.strictEqual(badRecordSwap.response.status, 400)
  assert.strictEqual(badRecordSwap.data.error, 'InvalidSwap')

  const badCommitSwap = await call(ctx, 'com.atproto.repo.putRecord', {
    repo: DID,
    collection: COLLECTION,
    rkey: 'p1',
    record: post('v3'),
    swapCommit: 'b' + 'a'.repeat(58),
  }, { journal })
  assert.strictEqual(badCommitSwap.response.status, 400)
  assert.strictEqual(badCommitSwap.data.error, 'InvalidSwap')

  // Nothing was appended by the failed swaps.
  assert.strictEqual((await snapshot(ctx.ledger)).length, 3)
})

// ============ deleteRecord ============

test('writes - deleteRecord removes an existing record and 404s when absent', async () => {
  const ctx = await setup()

  const created = await call(ctx, 'com.atproto.repo.createRecord', {
    repo: DID,
    collection: COLLECTION,
    rkey: 'd1',
    record: post('to delete'),
  })
  assert.strictEqual(created.response.status, 200, JSON.stringify(created.data))

  let journal = await journalFromLedger(ctx.ledger)

  const badSwap = await call(ctx, 'com.atproto.repo.deleteRecord', {
    repo: DID,
    collection: COLLECTION,
    rkey: 'd1',
    swapRecord: 'b' + 'a'.repeat(58),
  }, { journal })
  assert.strictEqual(badSwap.response.status, 400)
  assert.strictEqual(badSwap.data.error, 'InvalidSwap')

  const deleted = await call(ctx, 'com.atproto.repo.deleteRecord', {
    repo: DID,
    collection: COLLECTION,
    rkey: 'd1',
    swapRecord: created.data.cid,
    swapCommit: created.data.commit.cid,
  }, { journal })
  assert.strictEqual(deleted.response.status, 200, JSON.stringify(deleted.data))
  assert.deepStrictEqual(Object.keys(deleted.data).sort(), ['commit'])
  assert.ok(deleted.data.commit.cid)
  assert.ok(deleted.data.commit.rev > created.data.commit.rev)

  const last = (await snapshot(ctx.ledger)).at(-1)
  assert.strictEqual(last.op, 'delete')
  assert.strictEqual(last.recordCid, null)
  assert.strictEqual(last.commitCid, deleted.data.commit.cid)
  await assertEventSignature(ctx.key, last)

  journal = await journalFromLedger(ctx.ledger)
  const missing = await call(ctx, 'com.atproto.repo.deleteRecord', {
    repo: DID,
    collection: COLLECTION,
    rkey: 'd1',
  }, { journal })
  assert.strictEqual(missing.response.status, 404)
  assert.strictEqual(missing.data.error, 'RecordNotFound')

  const repo = await loadRepoForDid(journal, DID, ctx.key.privateKeyPkcs8)
  assert.strictEqual(await repo.getRecordCid(COLLECTION, 'd1'), null)
})

// ============ applyWrites ============

test('writes - applyWrites applies mixed ops in one commit and preserves result order', async () => {
  const ctx = await setup()

  const b = await call(ctx, 'com.atproto.repo.createRecord', {
    repo: DID,
    collection: COLLECTION,
    rkey: 'b',
    record: post('B'),
  })
  assert.strictEqual(b.response.status, 200, JSON.stringify(b.data))
  let journal = await journalFromLedger(ctx.ledger)

  const c = await call(ctx, 'com.atproto.repo.createRecord', {
    repo: DID,
    collection: COLLECTION,
    rkey: 'c',
    record: post('C'),
  }, { journal })
  assert.strictEqual(c.response.status, 200, JSON.stringify(c.data))
  journal = await journalFromLedger(ctx.ledger)

  const beforeEvents = await snapshot(ctx.ledger)
  const beforeHead = beforeEvents.at(-1)

  const applied = await call(ctx, 'com.atproto.repo.applyWrites', {
    repo: DID,
    writes: [
      {
        $type: 'com.atproto.repo.applyWrites#create',
        collection: COLLECTION,
        rkey: 'a',
        value: post('A'),
      },
      { action: 'update', collection: COLLECTION, rkey: 'b', record: post('B2') },
      { action: 'delete', collection: COLLECTION, rkey: 'c' },
    ],
  }, { journal })
  assert.strictEqual(applied.response.status, 200, JSON.stringify(applied.data))

  assert.ok(applied.data.commit.cid)
  assert.ok(applied.data.commit.rev > beforeHead.rev)

  const results = applied.data.results
  assert.strictEqual(results.length, 3)
  assert.deepStrictEqual(results.map(r => r.uri), [
    `at://${DID}/${COLLECTION}/a`,
    `at://${DID}/${COLLECTION}/b`,
    `at://${DID}/${COLLECTION}/c`,
  ])
  assert.strictEqual(results[0].cid, await computeCID(post('A')))
  assert.strictEqual(results[1].cid, await computeCID(post('B2')))
  assert.deepStrictEqual(results[2], {
    uri: `at://${DID}/${COLLECTION}/c`,
    validationStatus: 'valid',
  })
  assert.strictEqual(results[0].validationStatus, 'valid')
  assert.strictEqual(results[1].validationStatus, 'valid')

  const afterEvents = await snapshot(ctx.ledger)
  assert.strictEqual(afterEvents.length, beforeEvents.length + 1, 'one commit => one ledger event')
  const batchEvent = afterEvents.at(-1)
  assert.strictEqual(batchEvent.commitCid, applied.data.commit.cid)
  assert.strictEqual(batchEvent.prev, beforeHead.commitCid)
  assert.strictEqual(batchEvent.commit.prev, beforeHead.commitCid)
  assert.strictEqual(batchEvent.commit.data, batchEvent.mstRoot)
  assert.deepStrictEqual(batchEvent.writes.map(w => w.op), ['create', 'update', 'delete'])
  await assertEventSignature(ctx.key, batchEvent)

  const car = parseEventCar(batchEvent)
  assert.deepStrictEqual(car.roots, [batchEvent.commitCid])
  assert.ok(car.blocks.has(batchEvent.commitCid))
  assert.ok(car.blocks.has(batchEvent.mstRoot))
  for (const result of results.slice(0, 2)) {
    assert.ok(car.blocks.has(result.cid), `CAR must contain batch record ${result.cid}`)
  }

  const repo = await loadRepoForDid({ events: afterEvents }, DID, ctx.key.privateKeyPkcs8)
  assert.deepStrictEqual(repo.getHead(), {
    commitCid: applied.data.commit.cid,
    rev: applied.data.commit.rev,
  })
  assert.deepStrictEqual(await repo.getRecord(COLLECTION, 'a'), post('A'))
  assert.deepStrictEqual(await repo.getRecord(COLLECTION, 'b'), post('B2'))
  assert.strictEqual(await repo.getRecordCid(COLLECTION, 'c'), null)
})

test('writes - applyWrites rejects more than 200 writes', async () => {
  const ctx = await setup()

  const writes = Array.from({ length: MAX_APPLY_WRITES + 1 }, (_, i) => ({
    action: 'create',
    collection: COLLECTION,
    rkey: `k${i}`,
    record: post(`x${i}`),
  }))

  const { response, data } = await call(ctx, 'com.atproto.repo.applyWrites', {
    repo: DID,
    writes,
  })
  assert.strictEqual(response.status, 413)
  assert.strictEqual(data.error, 'PayloadTooLarge')
  assert.strictEqual((await snapshot(ctx.ledger)).length, 0)
})

// ============ auth / mode / key errors ============

test('writes - owner-signed accounts are rejected with OwnerSignedMode', async () => {
  const ctx = await setup({ mode: 'owner-signed' })

  const { response, data } = await call(ctx, 'com.atproto.repo.createRecord', {
    repo: DID,
    collection: COLLECTION,
    record: post('nope'),
  })
  assert.strictEqual(response.status, 403)
  assert.strictEqual(data.error, 'OwnerSignedMode')
  assert.match(data.message, /owner-signed append endpoint/)
  assert.strictEqual((await snapshot(ctx.ledger)).length, 0)
})

test('writes - only the authenticated DID may write to its own repo', async () => {
  const ctx = await setup()

  const { response, data } = await call(ctx, 'com.atproto.repo.createRecord', {
    repo: DID,
    collection: COLLECTION,
    record: post('nope'),
  }, { headers: { 'x-test-did': OTHER_DID } })
  assert.strictEqual(response.status, 403)
  assert.strictEqual(data.error, 'Forbidden')
  assert.strictEqual((await snapshot(ctx.ledger)).length, 0)

  // A handle that resolves to a different account is rejected too.
  const other = await call(ctx, 'com.atproto.repo.createRecord', {
    repo: 'other.phase3.test',
    collection: COLLECTION,
    record: post('nope'),
  })
  assert.strictEqual(other.response.status, 403)
})

test('writes - auth failures and missing repo keys surface as XRPC errors', async () => {
  const denied = await setup()
  denied.env.__authError = new denied.auth.AuthError(
    401,
    'AuthenticationRequired',
    'Invalid or expired token',
  )
  const unauthorized = await call(denied, 'com.atproto.repo.createRecord', {
    repo: DID,
    collection: COLLECTION,
    record: post('nope'),
  })
  assert.strictEqual(unauthorized.response.status, 401)
  assert.strictEqual(unauthorized.data.error, 'AuthenticationRequired')

  const noKey = await setup({ withKey: false })
  const missingKey = await call(noKey, 'com.atproto.repo.createRecord', {
    repo: DID,
    collection: COLLECTION,
    record: post('nope'),
  })
  assert.strictEqual(missingKey.response.status, 500)
  assert.strictEqual(missingKey.data.error, 'RepoKeyUnavailable')
})

// ============ exported helpers ============

test('writes - buildEvent/appendEventInternal expose the ledger event contract', async () => {
  const ctx = await setup()
  const repo = await Repo.create({
    did: DID,
    signingKey: ctx.key.privateKey,
  })
  const record = post('helpers')
  const result = await repo.applyWrite(
    { action: 'create', collection: COLLECTION, rkey: 'h1', record },
    encoded => signP256(ctx.key.privateKey, encoded),
  )

  const event = buildEvent({
    repo,
    did: DID,
    action: 'create',
    collection: COLLECTION,
    rkey: 'h1',
    record,
    result,
    signingKey: ctx.key.publicKeyMultibase,
  })
  assert.strictEqual(event.did, DID)
  assert.strictEqual(event.op, 'create')
  assert.strictEqual(event.commitCid, result.commitCid)
  assert.deepStrictEqual(parseEventCar(event).roots, [result.commitCid])

  const appended = await appendEventInternal(ctx.env, event, null, null)
  assert.strictEqual(appended.ok, true)
  assert.strictEqual(appended.event.commitCid, result.commitCid)

  // A different commit against the now-stale empty head is a 409 RepoConflict.
  const secondRecord = post('helpers 2')
  const secondResult = await repo.applyWrite(
    { action: 'create', collection: COLLECTION, rkey: 'h2', record: secondRecord },
    encoded => signP256(ctx.key.privateKey, encoded),
  )
  const secondEvent = buildEvent({
    repo,
    did: DID,
    action: 'create',
    collection: COLLECTION,
    rkey: 'h2',
    record: secondRecord,
    result: secondResult,
    signingKey: ctx.key.publicKeyMultibase,
  })
  await assert.rejects(
    appendEventInternal(ctx.env, secondEvent, null, null),
    error => error instanceof RepoWriteError && error.status === 409,
  )
})

test('writes - batch event expands into Journal indexes and firehose ops', async () => {
  const ctx = await setup()

  const batch = await call(ctx, 'com.atproto.repo.applyWrites', {
    repo: DID,
    writes: [
      { action: 'create', collection: COLLECTION, rkey: 'a', record: post('A') },
      { action: 'create', collection: COLLECTION, rkey: 'b', record: post('B') },
    ],
  })
  assert.strictEqual(batch.response.status, 200, JSON.stringify(batch.data))

  const events = await snapshot(ctx.ledger)
  const batchEvent = events.at(-1)
  assert.strictEqual(batchEvent.writes.length, 2)

  // The read model must expose every op, not just the first ledger row.
  const journal = new Journal(ctx.env)
  await journal.load()
  assert.strictEqual(journal.getRecord(DID, COLLECTION, 'a')?.record?.text, 'A')
  assert.strictEqual(journal.getRecord(DID, COLLECTION, 'b')?.record?.text, 'B')
  assert.strictEqual(journal.listRecords(DID, COLLECTION).records.length, 2)

  // The firehose frame must carry one op per write.
  const frame = ctx.ledger.firehose.formatEvent(batchEvent)
  const headerLen = cborEncode({ op: 1, t: '#commit' }).length
  const body = cborDecode(frame.slice(headerLen))
  assert.deepStrictEqual(
    body.ops.map(op => op.path),
    [`${COLLECTION}/a`, `${COLLECTION}/b`],
  )
  assert.ok(body.ops.every(op => op.action === 'create'))
})
