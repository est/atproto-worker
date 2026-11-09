/**
 * M3 blob upload/read tests.
 *
 * Uses the real Firehose DO (backed by Node's `node:sqlite`) plus an in-test
 * `auth` module stub. Covers the R2 preferred path, the SQLite fallback, the
 * size caps and the XRPC error shapes.
 */

import test from 'node:test'
import assert from 'node:assert'
import { DatabaseSync } from 'node:sqlite'

import { Firehose } from '../src/firehose.js'
import {
    handleUploadBlob,
    getBlobBytes,
    blobExists,
    listBlobCids,
    MAX_BLOB_BYTES,
    MAX_DO_BLOB_BASE64_BYTES,
} from '../src/blobs.js'
import { computeBlobCid, bytesToBase64 } from '../src/shared.js'

const DID = 'did:web:blobs.phase3.test'
const HANDLE = 'blobs.phase3.test'
const OWNER_DID = 'did:web:owner.phase3.test'
const OWNER_HANDLE = 'owner.phase3.test'

// Minimal valid 1x1 PNG (same fixture as tests/blob.test.js).
const TINY_PNG = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082',
    'hex'
)

// ============ Firehose SQLite shim (same shape as tests/ledger.test.js) ============

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
            if (rows.length === 0) {
                throw new Error('Expected exactly one result from SQL query, but got no results.')
            }
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
        ...overrides,
        FIREHOSE: {
            idFromName: () => 'main',
            get: () => ({
                fetch: (url, opts) => firehose.fetch(new Request(url, opts))
            })
        }
    }
    return { env, firehose, sql, kv }
}

// ============ Auth stub ============

function makeAuth() {
    class AuthError extends Error {
        constructor(status, error, message) {
            super(message)
            this.name = 'AuthError'
            this.status = status
            this.error = error
        }
    }

    const accounts = {
        [DID]: { did: DID, handle: HANDLE, mode: 'worker-signed' },
        [OWNER_DID]: { did: OWNER_DID, handle: OWNER_HANDLE, mode: 'owner-signed' }
    }

    return {
        AuthError,
        async requireAuth(request) {
            if (request.headers.get('x-test-auth') === 'missing') {
                throw new AuthError(401, 'AuthRequired', 'Authentication required')
            }
            const did = request.headers.get('x-test-did') || DID
            const account = accounts[did]
            if (!account) throw new AuthError(401, 'AuthRequired', 'Account not found')
            return { did, handle: account.handle, account }
        },
        async getAccount(env, { did, handle } = {}) {
            if (did) return accounts[did] ?? null
            if (handle) return Object.values(accounts).find(a => a.handle === handle) ?? null
            return null
        }
    }
}

async function upload(ctx, bytes, {
    did,
    contentType = 'image/png',
    omitContentType = false,
    method = 'POST',
    authHeader,
} = {}) {
    const headers = {}
    if (!omitContentType) headers['Content-Type'] = contentType
    if (did) headers['x-test-did'] = did
    if (authHeader) headers['x-test-auth'] = authHeader

    const request = new Request('https://pds.test/xrpc/com.atproto.repo.uploadBlob', {
        method,
        headers,
        body: method === 'POST' ? bytes : undefined,
    })
    const response = await handleUploadBlob(request, ctx.env, {}, { auth: ctx.auth })
    const data = await response.json().catch(() => null)
    return { response, data }
}

function blobCount(ctx) {
    // The DO creates its schema lazily on first use; tests that never reach
    // the DO (rejections / R2-only uploads) still need the table to exist.
    ctx.firehose.sql()
    return ctx.sql._db.prepare('SELECT COUNT(*) AS n FROM blobs').get().n
}

// ============ Upload ============

test('blobs - upload stores a small PNG in the DO fallback and returns a raw-codec blob ref', async () => {
    const ctx = makeEnv()
    ctx.auth = makeAuth()
    const expectedCid = await computeBlobCid(TINY_PNG)

    const { response, data } = await upload(ctx, TINY_PNG)
    assert.strictEqual(response.status, 200, JSON.stringify(data))
    assert.deepStrictEqual(data, {
        blob: {
            $type: 'blob',
            ref: { $link: expectedCid },
            mimeType: 'image/png',
            size: TINY_PNG.length,
        },
    })
    assert.ok(expectedCid.startsWith('bafkrei'), 'blob CID must use the raw codec')

    // Stored in SQLite with the account DID, no R2 binding present.
    assert.strictEqual(blobCount(ctx), 1)
    const row = ctx.sql._db.prepare('SELECT * FROM blobs WHERE cid = ?').get(expectedCid)
    assert.strictEqual(row.did, DID)
    assert.strictEqual(row.mime_type, 'image/png')
    assert.strictEqual(row.size, TINY_PNG.length)
    assert.strictEqual(row.data_b64, bytesToBase64(TINY_PNG))
})

test('blobs - missing Content-Type falls back to application/octet-stream', async () => {
    const ctx = makeEnv()
    ctx.auth = makeAuth()
    const bytes = new TextEncoder().encode('hello')
    const cid = await computeBlobCid(bytes)

    const { response, data } = await upload(ctx, bytes, { omitContentType: true })
    assert.strictEqual(response.status, 200, JSON.stringify(data))
    assert.strictEqual(data.blob.mimeType, 'application/octet-stream')
    assert.strictEqual(data.blob.ref.$link, cid)

    const blob = await getBlobBytes(ctx.env, cid)
    assert.ok(blob)
    assert.strictEqual(blob.mimeType, 'application/octet-stream')
})

test('blobs - rejects owner-signed accounts with 403 OwnerSignedMode', async () => {
    const ctx = makeEnv()
    ctx.auth = makeAuth()

    const { response, data } = await upload(ctx, TINY_PNG, { did: OWNER_DID })
    assert.strictEqual(response.status, 403)
    assert.strictEqual(data.error, 'OwnerSignedMode')
    assert.strictEqual(blobCount(ctx), 0)
})

test('blobs - upload requires auth and POST', async () => {
    const ctx = makeEnv()
    ctx.auth = makeAuth()

    const noAuth = await upload(ctx, TINY_PNG, { authHeader: 'missing' })
    assert.strictEqual(noAuth.response.status, 401)
    assert.strictEqual(noAuth.data.error, 'AuthRequired')

    const wrongMethod = await upload(ctx, undefined, { method: 'GET' })
    assert.strictEqual(wrongMethod.response.status, 405)
})

test('blobs - enforces the 5 MB upload limit', async () => {
    const ctx = makeEnv()
    ctx.auth = makeAuth()
    const tooBig = new Uint8Array(MAX_BLOB_BYTES + 1)

    const { response, data } = await upload(ctx, tooBig)
    assert.strictEqual(response.status, 413)
    assert.strictEqual(data.error, 'BlobTooLarge')
    assert.strictEqual(blobCount(ctx), 0)
})

test('blobs - DO fallback caps base64 rows at 2 MB and points at R2', async () => {
    const ctx = makeEnv()
    ctx.auth = makeAuth()

    // 1.6 MB raw encodes to ~2.13 MB base64: over the DO row cap, under the
    // 5 MB upload cap.
    const raw = new Uint8Array(1_600_000)
    assert.ok(Math.ceil(raw.length / 3) * 4 > MAX_DO_BLOB_BASE64_BYTES)

    const { response, data } = await upload(ctx, raw, { contentType: 'application/octet-stream' })
    assert.strictEqual(response.status, 413)
    assert.strictEqual(data.error, 'BlobTooLarge')
    assert.match(data.message, /R2/i)
    assert.strictEqual(blobCount(ctx), 0)
})

// ============ Read ============

test('blobs - getBlobBytes reads the DO fallback, unknown CID returns null', async () => {
    const ctx = makeEnv()
    ctx.auth = makeAuth()
    const cid = await computeBlobCid(TINY_PNG)

    const uploaded = await upload(ctx, TINY_PNG)
    assert.strictEqual(uploaded.response.status, 200)

    const blob = await getBlobBytes(ctx.env, cid)
    assert.ok(blob)
    assert.strictEqual(blob.mimeType, 'image/png')
    assert.strictEqual(blob.size, TINY_PNG.length)
    assert.strictEqual(Buffer.compare(Buffer.from(blob.bytes), TINY_PNG), 0)

    const unknownCid = await computeBlobCid(new TextEncoder().encode('never uploaded'))
    assert.strictEqual(await getBlobBytes(ctx.env, unknownCid), null)
    assert.strictEqual(await getBlobBytes(ctx.env, 'not-a-cid'), null)

    assert.strictEqual(await blobExists(ctx.env, cid), true)
    assert.strictEqual(await blobExists(ctx.env, unknownCid), false)
    assert.strictEqual(await blobExists(ctx.env, 'not-a-cid'), false)
})

test('blobs - listBlobCids returns per-account metadata', async () => {
    const ctx = makeEnv()
    ctx.auth = makeAuth()

    const hello = new TextEncoder().encode('hello')
    const helloCid = await computeBlobCid(hello)
    const pngCid = await computeBlobCid(TINY_PNG)
    assert.strictEqual((await upload(ctx, TINY_PNG)).response.status, 200)
    assert.strictEqual((await upload(ctx, hello, { contentType: 'text/plain' })).response.status, 200)

    const list = await listBlobCids(ctx.env, DID)
    assert.strictEqual(list.length, 2)
    const byCid = new Map(list.map(item => [item.cid, item]))
    assert.deepStrictEqual(byCid.get(pngCid), { cid: pngCid, mimeType: 'image/png', size: TINY_PNG.length })
    assert.deepStrictEqual(byCid.get(helloCid), { cid: helloCid, mimeType: 'text/plain', size: hello.length })

    assert.deepStrictEqual(await listBlobCids(ctx.env, 'did:web:nobody.test'), [])
})

// ============ R2 ============

function makeR2(initial = new Map()) {
    const objects = new Map(initial)
    const puts = []
    return {
        puts,
        objects,
        async put(cid, bytes, options) {
            const copy = new Uint8Array(bytes)
            puts.push({ cid, bytes: copy, options })
            objects.set(cid, {
                bytes: copy,
                size: copy.length,
                httpMetadata: options?.httpMetadata ?? {},
            })
        },
        async get(cid) {
            const object = objects.get(cid)
            if (!object) return null
            // Mirror the R2ObjectBody surface used by src/blobs.js.
            return {
                size: object.size,
                httpMetadata: object.httpMetadata,
                async arrayBuffer() {
                    const copy = new Uint8Array(object.bytes)
                    return copy.buffer
                },
            }
        },
        async head(cid) {
            const object = objects.get(cid)
            return object ? { size: object.size, httpMetadata: object.httpMetadata } : null
        },
    }
}

test('blobs - R2 is preferred over the DO fallback and serves the same bytes', async () => {
    const r2 = makeR2()
    const ctx = makeEnv({ BLOBS: r2 })
    ctx.auth = makeAuth()
    const cid = await computeBlobCid(TINY_PNG)

    const { response, data } = await upload(ctx, TINY_PNG)
    assert.strictEqual(response.status, 200, JSON.stringify(data))
    assert.strictEqual(data.blob.ref.$link, cid)

    assert.strictEqual(r2.puts.length, 1)
    assert.strictEqual(r2.puts[0].cid, cid)
    assert.strictEqual(Buffer.compare(Buffer.from(r2.puts[0].bytes), TINY_PNG), 0)
    assert.deepStrictEqual(r2.puts[0].options, {
        httpMetadata: { contentType: 'image/png' },
    })

    // The DO fallback must not have been used.
    assert.strictEqual(blobCount(ctx), 0)

    const blob = await getBlobBytes(ctx.env, cid)
    assert.ok(blob)
    assert.strictEqual(blob.mimeType, 'image/png')
    assert.strictEqual(blob.size, TINY_PNG.length)
    assert.strictEqual(Buffer.compare(Buffer.from(blob.bytes), TINY_PNG), 0)

    assert.strictEqual(await blobExists(ctx.env, cid), true)
    assert.strictEqual(await blobExists(ctx.env, await computeBlobCid(new TextEncoder().encode('nope'))), false)
})

test('blobs - falls back to the DO when R2 has no object', async () => {
    const r2 = makeR2()
    const ctx = makeEnv({ BLOBS: r2 })
    ctx.auth = makeAuth()
    const cid = await computeBlobCid(TINY_PNG)

    // Upload straight into the DO (bypassing uploadBlob's R2 preference).
    const stored = await ctx.firehose.fetch(new Request('http://ledger/blob', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            cid,
            did: DID,
            mimeType: 'image/png',
            size: TINY_PNG.length,
            dataB64: bytesToBase64(TINY_PNG),
        }),
    }))
    assert.strictEqual(stored.status, 200)
    assert.strictEqual(r2.objects.size, 0)

    const blob = await getBlobBytes(ctx.env, cid, { did: DID })
    assert.ok(blob)
    assert.strictEqual(Buffer.compare(Buffer.from(blob.bytes), TINY_PNG), 0)
    assert.strictEqual(await blobExists(ctx.env, cid), true)
})

// ============ DO routes ============

test('blobs - DO /blob routes are idempotent by CID and support GET/HEAD', async () => {
    const ctx = makeEnv()
    const body = {
        cid: 'bafkreitest',
        did: DID,
        mimeType: 'image/png',
        size: 3,
        dataB64: bytesToBase64(new Uint8Array([1, 2, 3])),
    }
    const post = payload => ctx.firehose.fetch(new Request('http://ledger/blob', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    }))

    const first = await post(body)
    assert.strictEqual(first.status, 200)
    assert.strictEqual((await first.json()).ok, true)

    const second = await post({ ...body, did: 'did:web:other.test' })
    assert.strictEqual(second.status, 200)
    const secondData = await second.json()
    assert.strictEqual(secondData.ok, true)
    assert.strictEqual(secondData.existing, true)

    // First writer wins (content-addressed duplicate).
    const row = ctx.sql._db.prepare('SELECT did FROM blobs WHERE cid = ?').get(body.cid)
    assert.strictEqual(row.did, DID)

    const getResponse = await ctx.firehose.fetch(new Request(`http://ledger/blob?cid=${body.cid}`))
    assert.strictEqual(getResponse.status, 200)
    const stored = await getResponse.json()
    assert.deepStrictEqual({
        cid: stored.cid,
        did: stored.did,
        mimeType: stored.mimeType,
        size: stored.size,
        dataB64: stored.dataB64,
    }, {
        cid: body.cid,
        did: DID,
        mimeType: 'image/png',
        size: 3,
        dataB64: body.dataB64,
    })
    assert.ok(stored.createdAt)

    const head = await ctx.firehose.fetch(new Request(`http://ledger/blob?cid=${body.cid}`, { method: 'HEAD' }))
    assert.strictEqual(head.status, 200)

    const missing = await ctx.firehose.fetch(new Request('http://ledger/blob?cid=bafkreimissing', { method: 'HEAD' }))
    assert.strictEqual(missing.status, 404)

    const tooBig = await post({
        ...body,
        cid: 'bafkreibig',
        dataB64: 'a'.repeat(MAX_DO_BLOB_BASE64_BYTES + 1),
    })
    assert.strictEqual(tooBig.status, 413)
    assert.strictEqual((await tooBig.json()).error, 'BlobTooLarge')
})
