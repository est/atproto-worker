/**
 * M3 authentication / account layer.
 *
 * This module is the Worker-side boundary between standard atproto clients and
 * the Firehose Durable Object (which owns accounts/sessions/repo_keys rows):
 *
 *   - password hashing (PBKDF2-SHA256, WebCrypto)
 *   - HS256 JWT issuing/verification (access + refresh scopes)
 *   - owner account bootstrap (did:web + Worker-held P-256 repo key)
 *   - standard com.atproto.server.{createSession,getSession,refreshSession,
 *     deleteSession} handlers
 *
 * Secrets come from the environment (`JWT_SECRET`, `BOOTSTRAP_TOKEN`); none
 * are hardcoded. Passwords, JWTs and private keys are never logged.
 */

import { generateP256Keypair } from './keys.js'
import { generateDidWebDocument } from './did.js'
import { isValidHandle } from './utils.js'
import { bytesToBase64, base64ToBytes, sha256 } from './shared.js'

export const ACCESS_SCOPE = 'com.atproto.access'
export const REFRESH_SCOPE = 'com.atproto.refresh'
export const DEFAULT_ACCESS_TTL_SEC = 7200
export const DEFAULT_REFRESH_TTL_SEC = 90 * 24 * 3600
export const PASSWORD_ITERATIONS = 210_000

const SALT_BYTES = 16
const JWT_CLOCK_SKEW_MS = 60_000

/**
 * An error that maps directly onto an XRPC error response
 * (`{error, message}` with an HTTP status).
 */
export class AuthError extends Error {
    constructor(status, error, message) {
        super(message)
        this.name = 'AuthError'
        this.status = status
        this.error = error
        this.message = message
    }
}

// ============ Byte/string helpers ============

function timingSafeEqualBytes(a, b) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false
    if (a.length !== b.length) return false
    let diff = 0
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
    return diff === 0
}

/** Hash both values before comparing so length differences don't leak. */
async function timingSafeEqualString(a, b) {
    const ha = await sha256(new TextEncoder().encode(String(a)))
    const hb = await sha256(new TextEncoder().encode(String(b)))
    return timingSafeEqualBytes(ha, hb)
}

async function sha256Base64(value) {
    return bytesToBase64(await sha256(value))
}

function base64UrlEncode(bytes) {
    return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlDecode(value) {
    let b64 = String(value).replace(/-/g, '+').replace(/_/g, '/')
    while (b64.length % 4 !== 0) b64 += '='
    return base64ToBytes(b64)
}

function bearerToken(request) {
    const header = request?.headers?.get('Authorization') || request?.headers?.get('authorization')
    if (!header || typeof header !== 'string') return null
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    return match ? match[1].trim() : null
}

function requireSecret(env, name) {
    const value = env?.[name]
    if (typeof value !== 'string' || value.length === 0) {
        throw new AuthError(503, 'AuthNotConfigured', `${name} is not configured`)
    }
    return value
}

// ============ Password hashing ============

/**
 * Derive a PBKDF2-SHA256 password hash.
 * @param {string} password
 * @param {{iterations?: number}} [opts]
 * @returns {Promise<{hash: string, salt: string, iterations: number}>}
 */
export async function hashPassword(password, { iterations = PASSWORD_ITERATIONS } = {}) {
    if (typeof password !== 'string') throw new TypeError('password must be a string')
    if (!Number.isInteger(iterations) || iterations < 1) {
        throw new TypeError('iterations must be a positive integer')
    }

    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(password),
        'PBKDF2',
        false,
        ['deriveBits']
    )
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
        keyMaterial,
        256
    )

    return {
        hash: bytesToBase64(new Uint8Array(bits)),
        salt: bytesToBase64(salt),
        iterations
    }
}

/**
 * Verify a password against a stored account row. Accepts both the DO's
 * camelCase JSON and raw snake_case SQL rows. Constant-time byte compare.
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, account) {
    if (!account || typeof password !== 'string') return false

    const storedHash = account.passwordHash ?? account.password_hash
    const storedSalt = account.passwordSalt ?? account.password_salt
    const iterations = account.passwordIterations ?? account.password_iterations

    if (typeof storedHash !== 'string' || typeof storedSalt !== 'string') return false
    if (!Number.isInteger(iterations) || iterations < 1) return false

    let salt
    let expected
    try {
        salt = base64ToBytes(storedSalt)
        expected = base64ToBytes(storedHash)
    } catch {
        return false
    }
    if (salt.length === 0 || expected.length === 0) return false

    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(password),
        'PBKDF2',
        false,
        ['deriveBits']
    )
    const derived = new Uint8Array(await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
        keyMaterial,
        expected.length * 8
    ))

    return timingSafeEqualBytes(derived, expected)
}

// ============ JWT (HS256) ============

/**
 * Sign a JWT with HS256. Segments are base64url without padding.
 * @param {object} payload
 * @param {string} secret
 * @returns {Promise<string>}
 */
export async function signJwt(payload, secret) {
    if (typeof secret !== 'string' || secret.length === 0) {
        throw new AuthError(503, 'AuthNotConfigured', 'JWT secret is not configured')
    }

    const header = base64UrlEncode(new TextEncoder().encode(
        JSON.stringify({ alg: 'HS256', typ: 'JWT' })
    ))
    const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload ?? {})))
    const signingInput = `${header}.${body}`

    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    )
    const signature = new Uint8Array(await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(signingInput)
    ))

    return `${signingInput}.${base64UrlEncode(signature)}`
}

/**
 * Verify an HS256 JWT and its time claims.
 * @returns {Promise<object|null>} payload, or null for malformed/bad-sig/expired
 */
export async function verifyJwt(token, secret) {
    if (typeof token !== 'string' || typeof secret !== 'string' || secret.length === 0) return null
    const parts = token.split('.')
    if (parts.length !== 3) return null

    const [headerB64, payloadB64, signatureB64] = parts
    let header
    let payload
    let signature
    try {
        header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64)))
        payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)))
        signature = base64UrlDecode(signatureB64)
    } catch {
        return null
    }

    if (!header || header.alg !== 'HS256') return null
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null

    let expected
    try {
        const key = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(secret),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        )
        expected = new Uint8Array(await crypto.subtle.sign(
            'HMAC',
            key,
            new TextEncoder().encode(`${headerB64}.${payloadB64}`)
        ))
    } catch {
        return null
    }
    if (!timingSafeEqualBytes(expected, signature)) return null

    const now = Date.now()
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null
    if (now >= payload.exp * 1000) return null
    if (typeof payload.iat === 'number' && payload.iat * 1000 > now + JWT_CLOCK_SKEW_MS) return null
    if (typeof payload.nbf === 'number' && payload.nbf * 1000 > now + JWT_CLOCK_SKEW_MS) return null

    return payload
}

// ============ Firehose DO access ============

function firehoseStub(env) {
    if (!env?.FIREHOSE) {
        throw new AuthError(503, 'AuthNotConfigured', 'Firehose ledger binding is not configured')
    }
    const id = env.FIREHOSE.idFromName('main')
    return env.FIREHOSE.get(id)
}

/**
 * Call one internal ledger route. Returns the Response plus parsed JSON.
 * Route errors are surfaced by callers, not logged (bodies are sensitive).
 */
async function ledgerRequest(env, path, { method = 'GET', body } = {}) {
    const stub = firehoseStub(env)
    const init = { method, headers: {} }
    if (body !== undefined) {
        init.headers['Content-Type'] = 'application/json'
        init.body = JSON.stringify(body)
    }

    let response
    try {
        response = await stub.fetch(`http://ledger${path}`, init)
    } catch {
        throw new AuthError(503, 'LedgerUnavailable', 'Failed to reach the ledger')
    }

    let data = null
    try {
        data = await response.json()
    } catch {
        data = null
    }

    return { response, status: response.status, ok: response.ok, data }
}

export async function getAccount(env, { did, handle } = {}) {
    const params = new URLSearchParams()
    if (did) params.set('did', did)
    else if (handle) params.set('handle', handle)
    else return null

    const { status, ok, data } = await ledgerRequest(env, `/account?${params.toString()}`)
    if (status === 404) return null
    if (!ok) throw new AuthError(503, 'LedgerUnavailable', `Account lookup failed (${status})`)
    return data?.account ?? null
}

export async function getRepoKey(env, did) {
    if (!did) return null
    const { status, ok, data } = await ledgerRequest(
        env,
        `/repo-key?did=${encodeURIComponent(did)}`
    )
    if (status === 404) return null
    if (!ok) throw new AuthError(503, 'LedgerUnavailable', `Repo key lookup failed (${status})`)
    return data?.key ?? null
}

async function saveAccount(env, account) {
    const { status, ok, data } = await ledgerRequest(env, '/account', {
        method: 'POST',
        body: { account }
    })
    if (ok) return data?.account ?? null
    if (status === 409) {
        throw new AuthError(409, 'AccountConflict', data?.message || 'Account already exists')
    }
    throw new AuthError(503, 'LedgerUnavailable', `Failed to store account (${status})`)
}

async function createRepoKey(env, did) {
    const keypair = await generateP256Keypair()
    if (!keypair.privateKeyPkcs8) {
        throw new AuthError(500, 'InternalError', 'Failed to export the repo signing key')
    }

    const key = {
        id: crypto.randomUUID(),
        did,
        curve: 'p256',
        publicKeyMultibase: keypair.publicKeyMultibase,
        privateKeyPkcs8: keypair.privateKeyPkcs8,
        createdAt: new Date().toISOString()
    }
    const { status, ok } = await ledgerRequest(env, '/repo-key', {
        method: 'POST',
        body: { key }
    })
    if (!ok) throw new AuthError(503, 'LedgerUnavailable', `Failed to store repo key (${status})`)
    return key
}

async function getSessionRecord(env, jti) {
    if (!jti) return null
    const { status, ok, data } = await ledgerRequest(
        env,
        `/session?jti=${encodeURIComponent(jti)}`
    )
    if (status === 404) return null
    if (!ok) throw new AuthError(503, 'LedgerUnavailable', `Session lookup failed (${status})`)
    return data?.session ?? null
}

async function revokeSession(env, jti) {
    const { status, ok } = await ledgerRequest(env, '/session/revoke', {
        method: 'POST',
        body: { jti, revokedAt: new Date().toISOString() }
    })
    if (!ok && status !== 404) {
        throw new AuthError(503, 'LedgerUnavailable', `Session revoke failed (${status})`)
    }
}

// ============ Sessions ============

/**
 * Issue an access/refresh JWT pair and persist the refresh session (jti +
 * SHA-256 of the refresh token) in the Firehose DO.
 */
export async function createSessionForAccount(env, account, {
    accessTtlSec = DEFAULT_ACCESS_TTL_SEC,
    refreshTtlSec = DEFAULT_REFRESH_TTL_SEC
} = {}) {
    if (!account?.did) throw new AuthError(400, 'InvalidRequest', 'A did is required')
    requireSecret(env, 'JWT_SECRET')

    const nowSec = Math.floor(Date.now() / 1000)
    const accessJti = crypto.randomUUID()
    const refreshJti = crypto.randomUUID()

    const base = { iss: account.did, aud: account.did, sub: account.did }
    const accessJwt = await signJwt({
        ...base,
        scope: ACCESS_SCOPE,
        iat: nowSec,
        exp: nowSec + accessTtlSec,
        jti: accessJti
    }, env.JWT_SECRET)
    const refreshJwt = await signJwt({
        ...base,
        scope: REFRESH_SCOPE,
        iat: nowSec,
        exp: nowSec + refreshTtlSec,
        jti: refreshJti,
        typ: 'refresh+jwt'
    }, env.JWT_SECRET)

    const session = {
        jti: refreshJti,
        did: account.did,
        refreshHash: await sha256Base64(refreshJwt),
        accessExpiresAt: new Date((nowSec + accessTtlSec) * 1000).toISOString(),
        refreshExpiresAt: new Date((nowSec + refreshTtlSec) * 1000).toISOString(),
        createdAt: new Date().toISOString()
    }

    const { status, ok } = await ledgerRequest(env, '/session', {
        method: 'POST',
        body: { session }
    })
    if (!ok) throw new AuthError(503, 'LedgerUnavailable', `Failed to store session (${status})`)

    return { accessJwt, refreshJwt, accessJti, refreshJti }
}

// ============ Request authentication ============

/**
 * Validate `Authorization: Bearer <accessJwt>` and load the account.
 * @returns {Promise<{did: string, handle: string, account: object}>}
 */
export async function requireAuth(request, env) {
    const secret = requireSecret(env, 'JWT_SECRET')
    const token = bearerToken(request)
    if (!token) throw new AuthError(401, 'AuthRequired', 'Authentication required')

    const payload = await verifyJwt(token, secret)
    if (!payload) throw new AuthError(401, 'AuthRequired', 'Invalid or expired access token')
    if (payload.scope !== ACCESS_SCOPE) {
        throw new AuthError(401, 'AuthRequired', 'Token scope does not permit this request')
    }

    const did = payload.sub || payload.iss
    if (typeof did !== 'string' || !did) {
        throw new AuthError(401, 'AuthRequired', 'Invalid access token')
    }

    const account = await getAccount(env, { did })
    if (!account) throw new AuthError(401, 'AuthRequired', 'Account not found')
    if (!isActive(account)) throw new AuthError(403, 'AccountDisabled', 'This account is disabled')

    return { did, handle: account.handle, account }
}

/**
 * Validate `Authorization: Bearer <BOOTSTRAP_TOKEN>`.
 * @returns {Promise<void>}
 */
export async function requireBootstrapAuth(request, env) {
    const expected = requireSecret(env, 'BOOTSTRAP_TOKEN')
    const token = bearerToken(request)
    if (!token) throw new AuthError(401, 'AuthRequired', 'Bootstrap token required')
    if (!(await timingSafeEqualString(token, expected))) {
        throw new AuthError(401, 'AuthRequired', 'Invalid bootstrap token')
    }
}

async function requireRefreshAuth(request, env) {
    const secret = requireSecret(env, 'JWT_SECRET')
    const token = bearerToken(request)
    if (!token) throw new AuthError(401, 'AuthRequired', 'Authentication required')

    const payload = await verifyJwt(token, secret)
    if (!payload || payload.scope !== REFRESH_SCOPE) {
        throw new AuthError(401, 'AuthRequired', 'Invalid or expired refresh token')
    }
    return { token, payload }
}

// ============ Account bootstrap ============

function isActive(account) {
    return !!account && account.active !== false && account.active !== 0
}

function isValidBootstrapDid(did, handle) {
    if (typeof did !== 'string' || !did.startsWith('did:web:')) return false
    const rest = did.slice('did:web:'.length)
    if (!rest) return false

    // Dev escape hatch: did:web:localhost[:PORT] with handle "localhost" or
    // the exact authority (handles normally require a dot, so bypass syntax).
    if (/^localhost(?::\d+)?$/.test(rest)) {
        return handle === 'localhost' || handle === rest
    }

    if (rest !== handle) return false
    return isValidHandle(handle)
}

function buildDidDoc(account, key, pdsEndpoint) {
    return generateDidWebDocument(
        account.handle,
        account.handle,
        key.publicKeyMultibase,
        account.did,
        pdsEndpoint || `https://${account.handle}`
    )
}

async function ensureRepoKey(env, account) {
    let key = await getRepoKey(env, account.did)
    if (key) return key

    key = await createRepoKey(env, account.did)
    await saveAccount(env, { ...account, repoKeyId: key.id })
    return key
}

function bootstrapResponse(account, key, pdsEndpoint) {
    return {
        did: account.did,
        handle: account.handle,
        publicKeyMultibase: key.publicKeyMultibase,
        didDoc: buildDidDoc(account, key, pdsEndpoint)
    }
}

async function handleBootstrapAccount(request, env) {
    if (request.method !== 'POST') {
        throw new AuthError(400, 'InvalidRequest', 'bootstrapAccount requires POST')
    }
    await requireBootstrapAuth(request, env)

    const body = await readJsonBody(request)
    const { did, handle, password } = body
    const mode = body.mode ?? 'worker-signed'

    if (typeof did !== 'string' || typeof handle !== 'string' ||
        typeof password !== 'string' || password.length === 0) {
        throw new AuthError(400, 'InvalidRequest', 'did, handle and password are required')
    }
    if (mode !== 'worker-signed') {
        throw new AuthError(400, 'InvalidRequest', "Only mode 'worker-signed' is supported")
    }
    if (!isValidBootstrapDid(did, handle)) {
        throw new AuthError(400, 'InvalidRequest', 'did must be did:web:<handle>')
    }

    const byHandle = await getAccount(env, { handle })
    if (byHandle && byHandle.did !== did) {
        throw new AuthError(409, 'AccountConflict', 'Handle is already bound to another account')
    }

    let account = await getAccount(env, { did })
    if (account && account.handle !== handle) {
        throw new AuthError(409, 'AccountConflict', 'DID is already bound to a different handle')
    }

    if (account) {
        if (body.resetPassword === true) {
            const pw = await hashPassword(password)
            account = {
                ...account,
                passwordHash: pw.hash,
                passwordSalt: pw.salt,
                passwordIterations: pw.iterations
            }
            await saveAccount(env, account)
        }
        const key = await ensureRepoKey(env, account)
        return jsonResponse(bootstrapResponse(account, key, body.pdsEndpoint))
    }

    const key = await createRepoKey(env, did)
    const pw = await hashPassword(password)
    account = {
        did,
        handle,
        mode,
        passwordHash: pw.hash,
        passwordSalt: pw.salt,
        passwordIterations: pw.iterations,
        repoKeyId: key.id,
        active: true,
        createdAt: new Date().toISOString()
    }
    await saveAccount(env, account)

    return jsonResponse(bootstrapResponse(account, key, body.pdsEndpoint))
}

// ============ XRPC handlers ============

async function readJsonBody(request) {
    try {
        const body = await request.json()
        return body && typeof body === 'object' ? body : {}
    } catch {
        throw new AuthError(400, 'InvalidRequest', 'Request body must be valid JSON')
    }
}

async function handleCreateSession(request, env) {
    if (request.method !== 'POST') {
        throw new AuthError(400, 'InvalidRequest', 'createSession requires POST')
    }

    const body = await readJsonBody(request)
    const { identifier, password } = body
    if (typeof identifier !== 'string' || identifier.length === 0 || typeof password !== 'string') {
        throw new AuthError(400, 'InvalidRequest', 'identifier and password are required')
    }

    const account = identifier.startsWith('did:')
        ? await getAccount(env, { did: identifier })
        : await getAccount(env, { handle: identifier })

    // Same error for unknown account and bad password: no user enumeration.
    if (!account || !(await verifyPassword(password, account))) {
        throw new AuthError(401, 'AuthenticationRequired', 'Invalid identifier or password')
    }
    if (!isActive(account)) {
        throw new AuthError(403, 'AccountDisabled', 'This account is disabled')
    }

    const key = await getRepoKey(env, account.did)
    if (!key) {
        throw new AuthError(503, 'AuthNotConfigured', 'Account has no active repo key')
    }

    const tokens = await createSessionForAccount(env, account)
    return jsonResponse({
        accessJwt: tokens.accessJwt,
        refreshJwt: tokens.refreshJwt,
        did: account.did,
        didDoc: buildDidDoc(account, key),
        handle: account.handle,
        active: true
    })
}

async function handleGetSession(request, env) {
    const { did, handle, account } = await requireAuth(request, env)
    const key = await getRepoKey(env, did)

    return jsonResponse({
        did,
        didDoc: key ? buildDidDoc(account, key) : null,
        handle: handle || account.handle,
        active: true
    })
}

function isExpired(iso) {
    if (typeof iso !== 'string') return false
    const at = Date.parse(iso)
    return Number.isFinite(at) && at <= Date.now()
}

async function handleRefreshSession(request, env) {
    if (request.method !== 'POST') {
        throw new AuthError(400, 'InvalidRequest', 'refreshSession requires POST')
    }

    const { token, payload } = await requireRefreshAuth(request, env)
    const session = await getSessionRecord(env, payload.jti)
    if (!session || session.did !== payload.sub) {
        throw new AuthError(401, 'AuthRequired', 'Session not found')
    }
    if (session.revokedAt) {
        throw new AuthError(401, 'AuthRequired', 'Session is revoked')
    }
    if (isExpired(session.refreshExpiresAt)) {
        throw new AuthError(401, 'AuthRequired', 'Session is expired')
    }

    const presentedHash = await sha256Base64(token)
    if (!timingSafeEqualString(presentedHash, session.refreshHash)) {
        throw new AuthError(401, 'AuthRequired', 'Invalid refresh token')
    }

    const account = await getAccount(env, { did: session.did })
    if (!account) throw new AuthError(401, 'AuthRequired', 'Account not found')
    if (!isActive(account)) throw new AuthError(403, 'AccountDisabled', 'This account is disabled')

    const key = await getRepoKey(env, account.did)
    if (!key) {
        throw new AuthError(503, 'AuthNotConfigured', 'Account has no active repo key')
    }

    // Rotate: the old refresh jti can never be replayed.
    await revokeSession(env, session.jti)
    const tokens = await createSessionForAccount(env, account)

    return jsonResponse({
        accessJwt: tokens.accessJwt,
        refreshJwt: tokens.refreshJwt,
        did: account.did,
        didDoc: buildDidDoc(account, key),
        handle: account.handle,
        active: true
    })
}

async function handleDeleteSession(request, env) {
    if (request.method !== 'POST') {
        throw new AuthError(400, 'InvalidRequest', 'deleteSession requires POST')
    }

    const { payload } = await requireRefreshAuth(request, env)
    const session = await getSessionRecord(env, payload.jti)
    if (session) {
        if (session.did !== payload.sub) {
            throw new AuthError(401, 'AuthRequired', 'Invalid refresh token')
        }
        if (!session.revokedAt) await revokeSession(env, session.jti)
    }

    return jsonResponse({})
}

async function handleAccountDidDoc(request, env, url) {
    let did = url.searchParams.get('did')
    if (!did && request.method === 'POST') {
        const body = await readJsonBody(request)
        did = typeof body.did === 'string' ? body.did : null
    }
    if (!did) throw new AuthError(400, 'InvalidRequest', 'did is required')

    const account = await getAccount(env, { did })
    if (!account) throw new AuthError(404, 'AccountNotFound', 'Account not found')

    const key = await getRepoKey(env, did)
    if (!key) {
        throw new AuthError(503, 'AuthNotConfigured', 'Account has no active repo key')
    }

    return jsonResponse({
        did: account.did,
        handle: account.handle,
        didDoc: buildDidDoc(account, key)
    })
}

// ============ Response helpers ============

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store'
        }
    })
}

function authErrorResponse(status, error, message) {
    return jsonResponse({ error, message }, status)
}

/**
 * Dispatch one auth XRPC method.
 *
 * @param {Request} request
 * @param {string} method - the NSID (not the URL path)
 * @param {object} env - worker env (`JWT_SECRET`, `BOOTSTRAP_TOKEN`, `FIREHOSE`)
 * @param {object} [ctx]
 * @returns {Promise<Response>}
 */
export async function handleAuthXrpc(request, method, env, ctx) {
    const url = new URL(request.url)

    try {
        switch (method) {
            case 'com.atproto.server.createSession':
                return await handleCreateSession(request, env)

            case 'com.atproto.server.getSession':
                return await handleGetSession(request, env)

            case 'com.atproto.server.refreshSession':
                return await handleRefreshSession(request, env)

            case 'com.atproto.server.deleteSession':
                return await handleDeleteSession(request, env)

            case 'com.atproto.worker.bootstrapAccount':
                return await handleBootstrapAccount(request, env)

            case 'com.atproto.worker.accountDidDoc':
                return await handleAccountDidDoc(request, env, url)

            default:
                return authErrorResponse(404, 'MethodNotImplemented', `Method ${method} is not implemented`)
        }
    } catch (e) {
        if (e instanceof AuthError) {
            return authErrorResponse(e.status, e.error, e.message)
        }
        // Never log request bodies: they may contain passwords/JWTs.
        console.error('[auth] unexpected error:', e?.message || 'unknown error')
        return authErrorResponse(500, 'InternalError', 'Authentication request failed')
    }
}
