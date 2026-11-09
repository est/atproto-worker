/**
 * M3 blob upload/read (com.atproto.repo.uploadBlob + sync.getBlob storage).
 *
 * Storage order:
 *   1. R2 (`env.BLOBS` binding) when configured — recommended for images,
 *      videos and anything bigger than a couple of MB.
 *   2. Firehose Durable Object SQLite `blobs` table — a zero-config fallback
 *      for local dev/small deployments. Rows store base64, so the fallback is
 *      capped at 2 MB of base64 (≈1.5 MB of raw bytes).
 *
 * Blobs are content-addressed: the CID is the raw-codec (`0x55`) CID of the
 * exact bytes (see `computeBlobCid`), so uploads are naturally idempotent and
 * `sync.getBlob` needs no per-account registry.
 *
 * This module never logs blob bytes or auth tokens; errors only carry an
 * XRPC-shaped `{error, message}`.
 */

import { computeBlobCid, isValidCidString, bytesToBase64, base64ToBytes } from './shared.js'

/** Maximum accepted upload size (5 MB), matching the standard PDS default. */
export const MAX_BLOB_BYTES = 5 * 1024 * 1024

/**
 * Maximum base64 payload the DO SQLite fallback accepts (2 MB row value).
 * ~1.5 MB of raw bytes once base64 overhead is included.
 */
export const MAX_DO_BLOB_BASE64_BYTES = 2 * 1024 * 1024

const DEFAULT_MIME_TYPE = 'application/octet-stream'

/**
 * Error carrying the HTTP/XRPC status to return for upload failures.
 * `getBlobBytes` / `blobExists` / `listBlobCids` never throw this (reads must
 * degrade to "not found" rather than break an XRPC read path).
 */
export class BlobError extends Error {
    constructor(status, error, message) {
        super(message)
        this.name = 'BlobError'
        this.status = status
        this.error = error
        this.message = message
    }
}

function fail(status, error, message) {
    throw new BlobError(status, error, message)
}

function xrpcError(status, error, message) {
    return new Response(JSON.stringify({ error, message }), {
        status,
        headers: { 'Content-Type': 'application/json' }
    })
}

function xrpcSuccess(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' }
    })
}

// ============ Auth / ledger plumbing ============

let cachedAuthModule = null

async function resolveAuthModule(override) {
    if (override) return override
    if (!cachedAuthModule) cachedAuthModule = import('./auth.js')
    return cachedAuthModule
}

function isAuthError(error, authModule) {
    if (!error) return false
    if (authModule?.AuthError && error instanceof authModule.AuthError) return true
    return typeof error.status === 'number' && typeof error.error === 'string'
}

function firehoseStub(env) {
    if (!env?.FIREHOSE) {
        fail(502, 'BlobStoreError', 'Blob storage is not configured')
    }
    const id = env.FIREHOSE.idFromName('main')
    return env.FIREHOSE.get(id)
}

async function authenticate(request, env, authModule) {
    let session
    try {
        session = await authModule.requireAuth(request, env)
    } catch (error) {
        if (isAuthError(error, authModule)) {
            fail(
                error.status ?? 401,
                error.error ?? 'AuthRequired',
                error.message ?? 'Authentication required'
            )
        }
        throw error
    }

    if (!session?.did) {
        fail(401, 'AuthRequired', 'Authentication required')
    }

    let account = session.account ?? null
    if (!account && typeof authModule.getAccount === 'function') {
        try {
            account = await authModule.getAccount(env, { did: session.did, handle: session.handle })
        } catch {
            account = null
        }
    }
    if (!account) {
        fail(401, 'AuthRequired', 'Authenticated account was not found')
    }

    return { session, account }
}

// ============ R2 helpers ============

async function r2ObjectToBlob(object) {
    if (!object) return null

    let bytes
    if (object instanceof Uint8Array) {
        bytes = object
    } else if (typeof object.arrayBuffer === 'function') {
        bytes = new Uint8Array(await object.arrayBuffer())
    } else if (object.body) {
        bytes = new Uint8Array(await new Response(object.body).arrayBuffer())
    } else {
        return null
    }

    return {
        bytes,
        mimeType: object.httpMetadata?.contentType || DEFAULT_MIME_TYPE,
        size: typeof object.size === 'number' ? object.size : bytes.length
    }
}

// ============ Upload ============

/**
 * Handle `com.atproto.repo.uploadBlob`.
 *
 * @param {Request} request
 * @param {object} env - Worker env (`BLOBS` R2 optional, `FIREHOSE` DO)
 * @param {ExecutionContext} [ctx]
 * @param {{auth?: object}} [options] - `auth` is a test seam; production uses
 *   `src/auth.js`.
 * @returns {Promise<Response>}
 */
export async function handleUploadBlob(request, env, ctx, { auth } = {}) {
    try {
        if (request.method !== 'POST') {
            return xrpcError(405, 'MethodNotAllowed', 'uploadBlob requires POST')
        }

        const authModule = await resolveAuthModule(auth)
        const { session, account } = await authenticate(request, env, authModule)

        if (account.mode !== 'worker-signed') {
            fail(
                403,
                'OwnerSignedMode',
                'Blob upload requires a worker-signed account; use the owner-signed workflow for this account'
            )
        }

        // Content-Length guard before reading a potentially huge body.
        const declaredLength = parseInt(request.headers.get('Content-Length') || '', 10)
        if (Number.isFinite(declaredLength) && declaredLength > MAX_BLOB_BYTES) {
            fail(413, 'BlobTooLarge', `blob exceeds the ${MAX_BLOB_BYTES} byte limit`)
        }

        let bytes
        try {
            bytes = new Uint8Array(await request.arrayBuffer())
        } catch {
            fail(400, 'InvalidRequest', 'could not read the request body')
        }
        if (bytes.length > MAX_BLOB_BYTES) {
            fail(413, 'BlobTooLarge', `blob exceeds the ${MAX_BLOB_BYTES} byte limit`)
        }
        if (bytes.length === 0) {
            fail(400, 'InvalidRequest', 'request body is required')
        }

        const contentType = (request.headers.get('Content-Type') || '').trim()
        const mimeType = contentType || DEFAULT_MIME_TYPE

        let cid
        try {
            cid = await computeBlobCid(bytes)
        } catch {
            fail(400, 'InvalidRequest', 'failed to compute the blob CID')
        }

        const size = bytes.length

        // Prefer R2. A configured binding that throws is a store failure (do
        // not silently fall back to SQLite for an oversized production blob).
        if (env?.BLOBS && typeof env.BLOBS.put === 'function') {
            try {
                await env.BLOBS.put(cid, bytes, { httpMetadata: { contentType: mimeType } })
            } catch {
                fail(502, 'BlobStoreError', 'Failed to store the blob')
            }
        } else {
            await storeInLedger(env, { cid, did: session.did, mimeType, size, bytes })
        }

        return xrpcSuccess({
            blob: {
                $type: 'blob',
                ref: { $link: cid },
                mimeType,
                size
            }
        })
    } catch (error) {
        if (error instanceof BlobError) {
            return xrpcError(error.status, error.error, error.message)
        }
        // Never log the request body: it is the blob itself.
        console.error('[blobs] unexpected upload error:', error?.message || 'unknown error')
        return xrpcError(500, 'InternalError', 'Failed to upload blob')
    }
}

async function storeInLedger(env, { cid, did, mimeType, size, bytes }) {
    const dataB64 = bytesToBase64(bytes)
    if (dataB64.length > MAX_DO_BLOB_BASE64_BYTES) {
        fail(
            413,
            'BlobTooLarge',
            'Blob is too large for the built-in SQLite store; configure the optional R2 binding (BLOBS) for larger files'
        )
    }

    const stub = firehoseStub(env)

    let response
    try {
        response = await stub.fetch('http://ledger/blob', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cid, did, mimeType, size, dataB64 })
        })
    } catch {
        fail(502, 'BlobStoreError', 'Failed to reach blob storage')
    }

    if (response.status === 413) {
        const data = await response.json().catch(() => null)
        fail(
            413,
            'BlobTooLarge',
            data?.message || 'Blob is too large for the built-in SQLite store'
        )
    }
    if (!response.ok) {
        fail(502, 'BlobStoreError', `Failed to store the blob (${response.status})`)
    }
}

// ============ Read ============

/**
 * Load blob bytes by CID. R2 first, then the Firehose DO fallback.
 *
 * Reads never throw: an unknown CID and a storage outage both return null so
 * `sync.getBlob` can answer 404 without turning into a 500.
 *
 * @param {object} env
 * @param {string} cid
 * @param {{did?: string}} [options] - reserved for future per-account checks;
 *   blobs are content-addressed and public by CID in atproto.
 * @returns {Promise<{bytes: Uint8Array, mimeType: string, size: number}|null>}
 */
export async function getBlobBytes(env, cid, { did } = {}) {
    if (!isValidCidString(cid)) return null

    if (env?.BLOBS && typeof env.BLOBS.get === 'function') {
        try {
            const object = await env.BLOBS.get(cid)
            const blob = await r2ObjectToBlob(object)
            if (blob) return blob
        } catch {
            // R2 read failure: fall through to the DO fallback (read path).
        }
    }

    if (!env?.FIREHOSE) return null

    try {
        const stub = firehoseStub(env)
        const response = await stub.fetch(`http://ledger/blob?cid=${encodeURIComponent(cid)}`)
        if (response.status === 404) return null
        if (!response.ok) return null

        const data = await response.json()
        if (!data || typeof data.dataB64 !== 'string' || !data.dataB64) return null

        const bytes = base64ToBytes(data.dataB64)
        return {
            bytes,
            mimeType: data.mimeType || DEFAULT_MIME_TYPE,
            size: typeof data.size === 'number' ? data.size : bytes.length
        }
    } catch {
        return null
    }
}

/**
 * Whether a blob exists in R2 or the DO fallback.
 * @returns {Promise<boolean>}
 */
export async function blobExists(env, cid) {
    if (!isValidCidString(cid)) return false

    if (env?.BLOBS && typeof env.BLOBS.head === 'function') {
        try {
            const object = await env.BLOBS.head(cid)
            if (object) return true
        } catch {
            // fall through to the DO fallback
        }
    }

    if (!env?.FIREHOSE) return false

    try {
        const stub = firehoseStub(env)
        const response = await stub.fetch(`http://ledger/blob?cid=${encodeURIComponent(cid)}`, {
            method: 'HEAD'
        })
        return response.status === 200
    } catch {
        return false
    }
}

/**
 * Blob metadata for one account (used by `com.atproto.sync.listBlobs`).
 *
 * The R2 layout is content-addressed (`<cid>`), so there is no per-DID index
 * in R2; this reads the DO fallback's `blobs` table. Deployments that put
 * everything in R2 can still return an empty list (the endpoint is optional).
 *
 * @returns {Promise<Array<{cid: string, mimeType: string, size: number}>>}
 */
export async function listBlobCids(env, did) {
    if (typeof did !== 'string' || !did || !env?.FIREHOSE) return []

    try {
        const stub = firehoseStub(env)
        const response = await stub.fetch(`http://ledger/blobs?did=${encodeURIComponent(did)}`)
        if (!response.ok) return []

        const data = await response.json()
        const rows = Array.isArray(data) ? data : (Array.isArray(data?.blobs) ? data.blobs : [])
        return rows.map(row => ({
            cid: row.cid,
            mimeType: row.mimeType || DEFAULT_MIME_TYPE,
            size: typeof row.size === 'number' ? row.size : 0
        }))
    } catch {
        return []
    }
}
