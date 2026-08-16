/**
 * XRPC endpoint handling for event-sourced ATProto PDS
 * Read-only from journal, no write operations on worker
 */

import { resolveHandle, generateDidWebDocument } from './did.js'
import { resolveIdentity, handleFromDid } from './identity.js'
import { createCarFile, cborEncode, cborDecode, cidToBytes, encodeVarint, base32Encode, base64ToBytes, isValidCidString } from './shared.js'

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
 * Handle XRPC requests (journal-based, read-only)
 * `hosted` is the set of DIDs this PDS serves (main did:web + publishing
 * accounts); falls back to the single main did when not provided.
 */
export async function handleXrpc(request, { journal, did, handle, env, hosted, ownHost }) {
    const url = new URL(request.url)
    const method = url.pathname.replace('/xrpc/', '')
    const hostedSet = hosted || journal.distinctDids()

    switch (method) {
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

        case 'com.atproto.repo.describeRepo':
            return handleDescribeRepo(url, journal, handle, did, env, hostedSet, ownHost)

        case '_health':
            return handleHealth(journal)

        // Write operations not supported (use CLI)
        case 'com.atproto.repo.createRecord':
        case 'com.atproto.repo.putRecord':
        case 'com.atproto.repo.deleteRecord':
            return xrpcError(501, 'MethodNotImplemented',
                'Write operations not supported. Use the local CLI to add records.')

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

    if (!hosted.has(did) || !isValidCidString(cid)) {
        return xrpcError(404, 'BlobNotFound', 'Blob not found')
    }
    if (!env.ASSETS) {
        return xrpcError(404, 'BlobNotFound', 'Blob not found')
    }

    // The main did:web account keeps blobs at uploads/ root (backward
    // compatible); publishing accounts use uploads/<handle>/ (derived from
    // the did — no registry needed).
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

    return xrpcError(404, 'BlobNotFound', 'Blob not found')
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
