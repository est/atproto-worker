/**
 * XRPC endpoint handling for event-sourced ATProto PDS
 * Read-only from journal, no write operations on worker
 */

import { resolveHandle, generateDidWebDocument } from './did.js'
import { resolveIdentity, handleFromDid } from './identity.js'
import { createCarFile, cborEncode, cborDecode, cidToBytes, encodeVarint, base32Encode, base64ToBytes, isValidCidString } from './shared.js'
import { validateAppendEvent, AppendValidationError, MAX_APPEND_BODY_BYTES } from './append.js'
import { handleAuthXrpc, getAccount } from './auth.js'
import { handleRepoWriteXrpc } from './writes.js'
import { handleUploadBlob, getBlobBytes, listBlobCids } from './blobs.js'

function xrpcError(status, error, message, details = null) {
    const body = { error, message }
    if (details && typeof details === 'object') Object.assign(body, details)
    return new Response(JSON.stringify(body), {
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

/**
 * Deterministic read responses get Cache-Control so Workers Cache serves
 * them WITHOUT running the Worker (no CPU billing, no journal reload).
 */
function cachedJson(data, maxAge = 60) {
    return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${maxAge}` }
    })
}

/**
 * Events of one hosted account (journal holds all accounts in one file).
 */
function eventsForDid(journal, did) {
    return journal.events.filter(e => e.did === did)
}

/**
 * Hosted = has a ledger event, OR exists as an M3 account. A freshly
 * bootstrapped worker-signed account has blobs/session before its first
 * record, so blob reads must consult the accounts table too.
 */
async function isHosted(env, hosted, did) {
    if (hosted.has(did)) return true
    try {
        const account = await getAccount(env, { did })
        return !!account && (account.active === undefined || account.active === 1 || account.active === true)
    } catch {
        return false
    }
}

/**
 * Handle XRPC requests (journal-based, read-only)
 * `hosted` is the set of DIDs this PDS serves (main did:web + publishing
 * accounts); falls back to the single main did when not provided.
 */
export async function handleXrpc(request, { journal, did, handle, env, hosted, ownHost, ctx, notifyRelay }) {
    const url = new URL(request.url)
    const method = url.pathname.replace('/xrpc/', '')
    const hostedSet = hosted || journal.distinctDids()

    switch (method) {
        case 'com.atproto.worker.appendEvent':
            return handleAppendEvent(request, {
                journal, did, handle, env, hosted: hostedSet, ownHost, ctx, notifyRelay
            })
        case 'com.atproto.repo.getRecord':
            return handleGetRecord(url, journal, hostedSet)

        case 'com.atproto.repo.listRecords':
            return handleListRecords(url, journal, hostedSet)

        case 'com.atproto.identity.resolveHandle':
            return handleResolveHandle(url, handle, did)

        case 'com.atproto.server.describeServer':
            return handleDescribeServer(url, did, handle, env, ownHost)

        case 'com.atproto.sync.subscribeRepos':
            return handleSubscribeRepos(request, env, journal)

        case 'com.atproto.sync.listRepos':
            return handleListRepos(did, journal, hostedSet)

        case 'com.atproto.sync.getLatestCommit':
            return handleGetLatestCommit(url, journal, hostedSet)

        case 'com.atproto.sync.getRepoStatus':
            return handleGetRepoStatus(url, journal, hostedSet)

        case 'com.atproto.sync.getRepo':
            return handleGetRepo(url, journal, hostedSet)

        case 'com.atproto.sync.getBlob':
            return handleGetBlob(url, journal, hostedSet, env, ownHost)

        case 'com.atproto.sync.listBlobs':
            return handleListBlobs(url, journal, hostedSet, env)

        case 'com.atproto.repo.uploadBlob':
            return handleUploadBlob(request, env, ctx)

        case 'com.atproto.repo.describeRepo':
            return handleDescribeRepo(url, journal, handle, did, env, hostedSet, ownHost)

        case 'com.atproto.worker.snapshot':
            return handleSnapshot(request, env, journal)

        case 'com.atproto.server.createSession':
        case 'com.atproto.server.getSession':
        case 'com.atproto.server.refreshSession':
        case 'com.atproto.server.deleteSession':
        case 'com.atproto.worker.bootstrapAccount':
        case 'com.atproto.worker.accountDidDoc':
            return handleAuthXrpc(request, method, env, ctx)

        case 'com.atproto.repo.createRecord':
        case 'com.atproto.repo.putRecord':
        case 'com.atproto.repo.deleteRecord':
        case 'com.atproto.repo.applyWrites':
            return handleRepoWriteXrpc(request, method, env, ctx, { journal, ownHost })

        case '_health':
            return handleHealth(journal)

        default:
            return xrpcError(501, 'MethodNotImplemented', `Method ${method} is not implemented`)
    }
}

/**
 * /xrpc/_health - health check
 */
function handleHealth(journal) {
    const version = '0.2.0'
    if (!journal.loaded) {
        return xrpcError(503, 'ServiceUnavailable', 'Journal not loaded')
    }
    return xrpcSuccess({ version })
}

/**
 * com.atproto.worker.snapshot - the live ledger (or the static seed) as
 * NDJSON. Public data; used by CLI pull/backup and external tooling.
 * Supports ?after=<seq>&limit=<n>.
 */
async function handleSnapshot(request, env, journal) {
    if (request.method !== 'GET') {
        return xrpcError(405, 'MethodNotAllowed', 'snapshot requires GET')
    }

    const headers = {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store'
    }

    if (env.FIREHOSE) {
        const id = env.FIREHOSE.idFromName('main')
        const stub = env.FIREHOSE.get(id)
        const url = new URL(request.url)
        const qs = new URLSearchParams()
        for (const key of ['after', 'limit']) {
            const value = url.searchParams.get(key)
            if (value !== null) qs.set(key, value)
        }
        const suffix = qs.toString() ? `?${qs.toString()}` : ''
        try {
            const resp = await stub.fetch(`http://ledger/snapshot${suffix}`)
            if (resp.ok) {
                const text = await resp.text()
                // An empty ledger before the first append: fall back to the
                // static seed so `pull`/backup works on a fresh deployment.
                // An empty `after=` tail is a legitimate empty result.
                if (text.trim() || qs.has('after')) {
                    return new Response(text, { headers })
                }
            }
        } catch (e) {
            console.error('[snapshot] ledger read failed:', e.message)
        }
    }

    // Fallback: the static seed (also what a fresh deployment serves before
    // the first append seeds the ledger).
    if (env.ASSETS) {
        const resp = await env.ASSETS.fetch('https://worker/journal.ndjson')
        if (resp.ok) return new Response(resp.body, { headers })
    }

    // Last resort: the already-loaded journal (JOURNAL_CONTENT / tests).
    const body = journal.events.length
        ? journal.events.map(e => JSON.stringify(e)).join('\n') + '\n'
        : ''
    return new Response(body, { headers })
}

/**
 * com.atproto.worker.appendEvent - owner-signed write path (M1 phase 2).
 *
 * The owner (browser/CLI) builds the MST/commit/CAR and signs the commit with
 * a P-256 key. The Worker verifies it, the Firehose ledger DO does the head
 * CAS + append + firehose broadcast, and we ask the relay to re-crawl.
 */
async function handleAppendEvent(request, { did: mainDid, handle, env, hosted, ownHost, ctx, notifyRelay }) {
    if (request.method !== 'POST') {
        return xrpcError(405, 'MethodNotAllowed', 'appendEvent requires POST')
    }

    const declaredLength = parseInt(request.headers.get('Content-Length') || '0', 10)
    if (Number.isFinite(declaredLength) && declaredLength > MAX_APPEND_BODY_BYTES) {
        return xrpcError(413, 'PayloadTooLarge', `request body exceeds ${MAX_APPEND_BODY_BYTES} bytes`)
    }

    let text
    try {
        text = await request.text()
    } catch (e) {
        return xrpcError(400, 'InvalidRequest', `could not read request body: ${e.message}`)
    }
    if (text.length > MAX_APPEND_BODY_BYTES) {
        return xrpcError(413, 'PayloadTooLarge', `request body exceeds ${MAX_APPEND_BODY_BYTES} bytes`)
    }

    let body
    try {
        body = JSON.parse(text)
    } catch (e) {
        return xrpcError(400, 'InvalidRequest', `request body is not valid JSON: ${e.message}`)
    }

    const event = body?.event
    if (!event || typeof event !== 'object') {
        return xrpcError(400, 'InvalidRequest', 'body.event is required')
    }
    if (typeof event.did !== 'string' || !event.did) {
        return xrpcError(400, 'InvalidRequest', 'event.did is required')
    }
    if (typeof event.commitCid !== 'string' || !event.commitCid) {
        return xrpcError(400, 'InvalidRequest', 'event.commitCid is required')
    }

    // Admission: existing hosted accounts, or the Worker's main did (which
    // lets a fresh ledger accept its first event before the seed exists).
    if (!hosted.has(event.did) && event.did !== mainDid) {
        return xrpcError(400, 'NotHosted', 'Can only append to hosted accounts')
    }

    if (!env.FIREHOSE) {
        return xrpcError(503, 'LedgerUnavailable', 'Firehose ledger binding is not configured')
    }
    const id = env.FIREHOSE.idFromName('main')
    const stub = env.FIREHOSE.get(id)

    // Idempotent replay: return the already-stored event *before* checking
    // the head, so retries still work after the head advanced (and after a
    // key rotation, since the old event was valid when it was appended).
    try {
        const existingResp = await stub.fetch(`http://ledger/event?commitCid=${encodeURIComponent(event.commitCid)}`)
        if (existingResp.ok) {
            const existing = await existingResp.json()
            if (existing.event?.did !== event.did) {
                return xrpcError(409, 'RepoConflict', 'commitCid already exists for a different account', { head: existing.head || null })
            }
            return xrpcSuccess(appendResponse(existing.event))
        }
    } catch (e) {
        console.error('[append] dedupe lookup failed:', e.message)
    }

    const head = await fetchLedgerHead(stub, event.did)

    // First append against an empty ledger: seed the static journal so the
    // client's expectedHead (read from ASSETS) matches the ledger head.
    if (!head?.commitCid) {
        try {
            const seedResp = await stub.fetch('http://ledger/seed', { method: 'POST' })
            if (seedResp.ok) {
                const seeded = await fetchLedgerHead(stub, event.did)
                if (seeded?.commitCid) Object.assign(head, seeded)
            }
        } catch (e) {
            console.error('[append] ledger seed failed:', e.message)
        }
    }

    // Identity: the DID document's current #atproto key is the only key that
    // may sign new events.
    const ident = await resolveIdentity(env, event.did, ownHost)
    if (!ident || !ident.publicKeyMultibase) {
        return xrpcError(400, 'IdentityNotFound', 'Cannot resolve the account DID document / #atproto key')
    }

    try {
        await validateAppendEvent(event, {
            head,
            resolvedKey: ident.publicKeyMultibase
        })
    } catch (e) {
        if (e instanceof AppendValidationError) {
            const details = { ...(e.details || {}) }
            if (e.status === 409 && !details.head) details.head = head
            return xrpcError(e.status, e.error, e.message, details)
        }
        console.error('[append] validation error:', e)
        return xrpcError(500, 'InternalError', 'Failed to validate append event')
    }

    let appendResp
    try {
        appendResp = await stub.fetch('http://ledger/append', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                event,
                expectedHead: head?.commitCid ?? null,
                expectedRev: head?.rev ?? null
            })
        })
    } catch (e) {
        console.error('[append] ledger append failed:', e.message)
        return xrpcError(502, 'LedgerError', 'Failed to write to the ledger')
    }

    if (appendResp.status === 409) {
        const conflict = await appendResp.json().catch(() => ({}))
        return xrpcError(409, 'RepoConflict',
            conflict.message || 'Repository head changed; fetch the new head and rebase',
            { head: conflict.head ?? head })
    }
    if (!appendResp.ok) {
        const err = await appendResp.json().catch(() => ({}))
        return xrpcError(502, 'LedgerError', err.message || `ledger append failed (${appendResp.status})`)
    }

    const result = await appendResp.json()

    // New data is immediately visible to this Worker's read model (next
    // request re-snapshots the ledger); tell the relay so it re-crawls.
    if (ctx && typeof ctx.waitUntil === 'function' && typeof notifyRelay === 'function') {
        ctx.waitUntil(notifyRelay(env, handle))
    }

    return xrpcSuccess(appendResponse(result.event))
}

function appendResponse(event) {
    return {
        uri: `at://${event.did}/${event.collection}/${event.rkey}`,
        cid: event.recordCid ?? null,
        commit: { cid: event.commitCid, rev: event.rev },
        seq: event.offset
    }
}

async function fetchLedgerHead(stub, did) {
    try {
        const resp = await stub.fetch(`http://ledger/head?did=${encodeURIComponent(did)}`)
        if (!resp.ok) return { commitCid: null, rev: null, seq: null, mstRoot: null }
        return await resp.json()
    } catch (e) {
        console.error('[append] head lookup failed:', e.message)
        return { commitCid: null, rev: null, seq: null, mstRoot: null }
    }
}

/**
 * com.atproto.repo.getRecord - read from journal
 */
function handleGetRecord(url, journal, hosted) {
    const repoDid = url.searchParams.get('repo')
    const collection = url.searchParams.get('collection')
    const rkey = url.searchParams.get('rkey')

    if (!repoDid || !collection || !rkey) {
        return xrpcError(400, 'InvalidRequest', 'repo, collection, and rkey are required')
    }

    if (!hosted.has(repoDid)) {
        return xrpcError(400, 'InvalidRequest', 'Can only get records from hosted accounts')
    }

    const event = journal.getRecord(repoDid, collection, rkey)
    if (!event) {
        return xrpcError(404, 'RecordNotFound', 'Record not found')
    }

    return xrpcSuccess({
        uri: `at://${repoDid}/${collection}/${rkey}`,
        cid: event.recordCid || event.commitCid || event.cid,
        value: event.record
    })
}

/**
 * com.atproto.repo.listRecords - list from journal
 */
function handleListRecords(url, journal, hosted) {
    const repoDid = url.searchParams.get('repo')
    const collection = url.searchParams.get('collection')
    const limit = Math.min(parseInt(url.searchParams.get('limit')) || 50, 100)
    const cursor = url.searchParams.get('cursor')

    if (!repoDid || !collection) {
        return xrpcError(400, 'InvalidRequest', 'repo and collection are required')
    }

    if (!hosted.has(repoDid)) {
        return xrpcError(400, 'InvalidRequest', 'Can only list records from hosted accounts')
    }

    const result = journal.listRecords(repoDid, collection, { limit, cursor })

    return xrpcSuccess({
        records: result.records.map(e => ({
            uri: `at://${repoDid}/${collection}/${e.rkey}`,
            cid: e.recordCid || e.commitCid || e.cid,
            value: e.record
        })),
        cursor: result.cursor
    })
}

/**
 * com.atproto.identity.resolveHandle
 */
async function handleResolveHandle(url, ownerHandle, ownerDid) {
    const handleParam = url.searchParams.get('handle')

    if (!handleParam) {
        return xrpcError(400, 'InvalidRequest', 'handle is required')
    }

    const resolvedDid = await resolveHandle(handleParam, ownerHandle, ownerDid)
    if (!resolvedDid) {
        return xrpcError(400, 'HandleNotFound', 'Unable to resolve handle')
    }

    return xrpcSuccess({ did: resolvedDid })
}

/**
 * com.atproto.server.describeServer
 * The relay's HostChecker calls this once to decide we're a PDS; any HTTP
 * error becomes ErrHostNotPDS. Include the DID doc like the reference PDS.
 */
/**
 * com.atproto.server.describeServer
 * The relay's HostChecker calls this once to decide we're a PDS; any HTTP
 * error becomes ErrHostNotPDS. The didDoc is self-discovered: the main
 * account's identity comes from the static .well-known/did.json (ASSETS).
 */
async function handleDescribeServer(url, did, handle, env, ownHost) {
    const ident = await resolveIdentity(env, did, ownHost)
    const didDoc = ident
        ? generateDidWebDocument(ident.handle, ident.handle, ident.publicKeyMultibase, did)
        : null
    return cachedJson({
        did: did,
        didDoc,
        availableUserDomains: [],
        inviteCodeRequired: false,
        phoneVerificationRequired: false,
        links: {}
    }, 60)
}

/**
 * com.atproto.sync.subscribeRepos - WebSocket handler
 */
async function handleSubscribeRepos(request, env, journal) {
    const upgradeHeader = request.headers.get('Upgrade')
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        return xrpcError(400, 'InvalidRequest', 'WebSocket upgrade required')
    }

    const url = new URL(request.url)
    const cursor = url.searchParams.get('cursor')

    // Get Durable Object
    const id = env.FIREHOSE.idFromName('main')
    const stub = env.FIREHOSE.get(id)

    const newUrl = new URL(request.url)
    newUrl.pathname = '/subscribe'
    if (cursor) {
        newUrl.searchParams.set('cursor', cursor)
    }

    return stub.fetch(newUrl.toString(), request)
}

/**
 * com.atproto.sync.listRepos
 */
function handleListRepos(mainDid, journal, hosted) {
    const repos = []
    for (const did of hosted) {
        const events = eventsForDid(journal, did)
        const latest = events.length > 0 ? events[events.length - 1] : null
        repos.push({
            did,
            head: latest ? (latest.commitCid || latest.cid) : null,
            rev: latest ? latest.rev : null
        })
    }
    return cachedJson({ repos }, 30)
}

/**
 * com.atproto.sync.getLatestCommit
 */
function handleGetLatestCommit(url, journal, hosted) {
    const repoDid = url.searchParams.get('did')

    if (!hosted.has(repoDid)) {
        return xrpcError(400, 'InvalidRequest', 'Can only get commits from hosted accounts')
    }

    const events = eventsForDid(journal, repoDid)
    if (events.length === 0) {
        return xrpcError(404, 'RepoNotFound', 'No commits found')
    }

    const latest = events[events.length - 1]

    return cachedJson({
        cid: latest.commitCid || latest.cid,
        rev: latest.rev
    }, 30)
}

/**
 * com.atproto.sync.getRepoStatus
 * Hosting status for a repository on this server.
 */
function handleGetRepoStatus(url, journal, hosted) {
    const repoDid = url.searchParams.get('did')

    if (!hosted.has(repoDid)) {
        return xrpcError(400, 'InvalidRequest', 'Can only get status of hosted repos')
    }

    const events = eventsForDid(journal, repoDid)
    const latest = events.length > 0 ? events[events.length - 1] : null

    return cachedJson({
        did: repoDid,
        active: true,
        rev: latest ? latest.rev : null
    }, 30)
}

/**
 * com.atproto.sync.getRepo
 * Download repository export as CAR file.
 * New format: rebuilds full CAR from all per-commit blocks in the journal.
 * Legacy fallback: empty CAR (see ADR-006).
 */
function handleGetRepo(url, journal, hosted) {
    const repoDid = url.searchParams.get('did')

    if (!hosted.has(repoDid)) {
        return xrpcError(400, 'InvalidRequest', 'Can only get repos from hosted accounts')
    }

    const events = eventsForDid(journal, repoDid)
    if (events.length === 0) {
        return xrpcError(404, 'RepoNotFound', 'No commits found')
    }

    const latest = events[events.length - 1]

    // New format: rebuild full CAR from per-commit CAR blocks
    if (latest.commitCid && latest.blocksB64) {
        const car = rebuildRepoCar(events, latest.commitCid)
        if (car) {
            return new Response(car, {
                status: 200,
                headers: {
                    'Content-Type': 'application/vnd.ipld.car',
                    'Content-Disposition': `attachment; filename=${repoDid}.car`
                }
            })
        }
    }

    // Legacy fallback: empty CAR with latest commit root
    const car = createCarFile(latest.commitCid || latest.cid, [])
    return new Response(car, {
        status: 200,
        headers: {
            'Content-Type': 'application/vnd.ipld.car',
            'Content-Disposition': `attachment; filename=${repoDid}.car`
        }
    })
}

/**
 * Read a LEB128 varint from a byte array starting at `pos`.
 * Accumulates in Number (the old `|=` coerced to int32 and silently wrapped
 * for 5+ byte varints); throws on EOF or if it would exceed the safe
 * integer range.
 */
function readCarVarint(carBytes, pos) {
    let value = 0
    let shift = 0
    while (true) {
        if (pos >= carBytes.length) {
            throw new Error('CAR varint is truncated: unexpected end of data')
        }
        const b = carBytes[pos++]
        value += (b & 0x7f) * Math.pow(2, shift)
        if (!(b & 0x80)) return { value, pos }
        shift += 7
        if (shift > 53) {
            throw new Error('CAR varint is too long (exceeds safe integer range)')
        }
    }
}

/**
 * Merge all per-commit CAR blocks from the journal into a single CAR
 * rooted at the latest commit. Returns Uint8Array.
 * @throws {Error} If any CAR data is malformed, truncated, contains trailing
 * garbage, or exceeds the total size cap.
 */
const MAX_CAR_REBUILD_BYTES = 64 * 1024 * 1024 // 64 MB guard

function rebuildRepoCar(events, rootCid) {
    const allBlocks = new Map()
    let totalBytes = 0

    for (const event of events) {
        if (!event.blocksB64) continue
        const carBytes = base64ToBytes(event.blocksB64)

        // --- CAR header: varint(headerLen) + CBOR header ---
        const { value: headerLen, pos: afterHeaderVarint } = readCarVarint(carBytes, 0)
        const headerEnd = afterHeaderVarint + headerLen
        if (headerEnd > carBytes.length) {
            throw new Error(
                `CAR header is truncated: claims ${headerLen} bytes but only ${carBytes.length - afterHeaderVarint} remain`
            )
        }

        // Validate header is valid CBOR (catches corruption early)
        try {
            cborDecode(carBytes.slice(afterHeaderVarint, headerEnd))
        } catch (e) {
            throw new Error(`CAR header CBOR decode failed: ${e.message}`)
        }

        // --- Blocks: [varint(cidLen + dataLen) cidBytes data]* ---
        let pos = headerEnd
        while (pos < carBytes.length) {
            const block = readCarVarint(carBytes, pos)
            const blockLen = block.value
            pos = block.pos
            if (blockLen === 0) {
                // A zero-length block marks the end of blocks (padding allowed after)
                break
            }
            if (pos + blockLen > carBytes.length) {
                throw new Error(
                    `CAR block is truncated: header claims ${blockLen} bytes but only ${carBytes.length - pos} remain`
                )
            }
            const blockBytes = carBytes.slice(pos, pos + blockLen)
            pos += blockLen
            totalBytes += blockBytes.length
            if (totalBytes > MAX_CAR_REBUILD_BYTES) {
                throw new Error(`CAR rebuild exceeds ${MAX_CAR_REBUILD_BYTES} bytes`)
            }

            // CID v1: version(1) + codec(1) + multihash(type(1) + len(1) + digest).
            // Parse the digest length instead of assuming a fixed 36 bytes, so
            // non-sha256 CIDs don't leak bytes into the block data.
            if (blockBytes.length < 4 || blockBytes[0] !== 1) {
                throw new Error('CAR block is missing a CID v1 header')
            }
            const cidLen = 2 + 2 + blockBytes[3]
            if (blockBytes.length < cidLen) {
                throw new Error('CAR block is too short to contain its CID')
            }
            const cidBytes = blockBytes.slice(0, cidLen)
            const cidStr = 'b' + base32Encode(cidBytes)
            allBlocks.set(cidStr, blockBytes.slice(cidLen))
        }

        // Allow trailing zero padding; anything else is corruption
        while (pos < carBytes.length) {
            if (carBytes[pos] !== 0) {
                throw new Error(
                    `Unexpected trailing byte 0x${carBytes[pos].toString(16)} after CAR blocks at offset ${pos}`
                )
            }
            pos++
        }
    }

    // Build final CAR
    const parts = []
    const header = cborEncode({ version: 1, roots: [{ $link: rootCid }] })
    parts.push(encodeVarint(header.length))
    parts.push(header)
    for (const [cid, data] of allBlocks) {
        const cidBytes = cidToBytes(cid)
        parts.push(encodeVarint(cidBytes.length + data.length))
        parts.push(cidBytes)
        parts.push(data)
    }
    const total = parts.reduce((s, p) => s + p.length, 0)
    const result = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
        result.set(part, offset)
        offset += part.length
    }
    return result
}

/**
 * com.atproto.sync.getBlob
 * Serve a blob (image/attachment) stored in Worker Static Assets.
 * Blobs live at public/uploads/<cid>.<ext> (deployed alongside the journal
 * asset), so the extension is probed from a fixed candidate list and maps
 * to the mime type. Responses are edge-cached by CID.
 */
const BLOB_CANDIDATES = [
    ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'],
    ['png', 'image/png'],
    ['gif', 'image/gif'],
    ['webp', 'image/webp'],
    ['avif', 'image/avif'],
]

async function handleGetBlob(url, journal, hosted, env, ownHost) {
    const did = url.searchParams.get('did')
    const cid = url.searchParams.get('cid')

    if (!isValidCidString(cid) || !(await isHosted(env, hosted, did))) {
        return xrpcError(404, 'BlobNotFound', 'Blob not found')
    }

    // Static ASSETS blobs (M1/CLI-published) keep their historical layout:
    // main did:web at uploads/ root; publishing accounts at uploads/<handle>/.
    if (env.ASSETS) {
        const handle = handleFromDid(did)
        const prefix = handle && handle !== ownHost ? `uploads/${handle}/` : 'uploads/'

        for (const [ext, mime] of BLOB_CANDIDATES) {
            const resp = await env.ASSETS.fetch(`https://worker/${prefix}${cid}.${ext}`)
            if (resp.ok) {
                return new Response(resp.body, {
                    status: 200,
                    headers: {
                        'Content-Type': mime,
                        'Cache-Control': 'public, max-age=86400'
                    }
                })
            }
        }
    }

    // Mutable M3 blob store: R2 (env.BLOBS) or the Firehose DO fallback.
    const blob = await getBlobBytes(env, cid, { did })
    if (blob) {
        return new Response(blob.bytes, {
            status: 200,
            headers: {
                'Content-Type': blob.mimeType || 'application/octet-stream',
                'Content-Length': String(blob.size ?? blob.bytes.length),
                'Cache-Control': 'public, max-age=86400'
            }
        })
    }

    return xrpcError(404, 'BlobNotFound', 'Blob not found')
}

/**
 * com.atproto.sync.listBlobs - list blob CIDs for a DID.
 * The store returns metadata; pagination is by CID (opaque cursor).
 */
async function handleListBlobs(url, journal, hosted, env) {
    const did = url.searchParams.get('did')
    if (!(await isHosted(env, hosted, did))) {
        return xrpcError(404, 'RepoNotFound', 'Repo not found')
    }

    const cursor = url.searchParams.get('cursor')
    const rawLimit = parseInt(url.searchParams.get('limit') || '500', 10)
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(1000, rawLimit)) : 500

    const all = (await listBlobCids(env, did)).map(b => b.cid).sort()
    const start = cursor ? all.findIndex(cid => cid > cursor) : 0
    const from = start < 0 ? all.length : start
    const cids = all.slice(from, from + limit)
    const hasMore = from + limit < all.length

    return xrpcSuccess({
        cids,
        ...(hasMore ? { cursor: cids[cids.length - 1] } : {})
    })
}

/**
 * com.atproto.repo.describeRepo
 * Get information about an account and its repository.
 * The account's handle + public key are self-discovered via well-known
 * (own host → static ASSETS file; external did:web → cached fetch).
 */
async function handleDescribeRepo(url, journal, mainHandle, mainDid, env, hosted, ownHost) {
    const repo = url.searchParams.get('repo')

    if (!repo) {
        return xrpcError(400, 'InvalidRequest', 'repo is required')
    }

    // Resolve repo (did or handle) to a hosted account
    let did = repo.startsWith('did:') ? repo : null
    if (!did) {
        for (const d of hosted) {
            if (handleFromDid(d) === repo) { did = d; break }
        }
        if (!did && repo === mainHandle) did = mainDid
    }
    if (!did || !hosted.has(did)) {
        return xrpcError(400, 'InvalidRequest', 'Can only describe hosted repos')
    }

    const ident = await resolveIdentity(env, did, ownHost)
    if (!ident) {
        return xrpcError(400, 'InvalidRequest', 'Cannot resolve account identity (well-known not hosted?)')
    }

    const didDoc = generateDidWebDocument(ident.handle, ident.handle, ident.publicKeyMultibase, did)

    // Collections belonging to this account (index keys are did-prefixed)
    const collections = [...journal.byCollection.keys()]
        .filter(k => k.startsWith(`${did}/`))
        .map(k => k.slice(did.length + 1))

    return xrpcSuccess({
        handle: ident.handle,
        did,
        didDoc,
        collections,
        handleIsCorrect: true
    })
}
