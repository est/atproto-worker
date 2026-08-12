/**
 * XRPC endpoint handling for event-sourced ATProto PDS
 * Read-only from journal, no write operations on worker
 */

import { resolveHandle, generateDidWebDocument } from './did.js'
import { createCarFile, cborEncode, cborDecode, cidToBytes, encodeVarint, base32Encode } from './shared.js'

function base64ToBytes(b64) {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytes
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

/**
 * Handle XRPC requests (journal-based, read-only)
 */
export async function handleXrpc(request, { journal, did, handle, env }) {
    const url = new URL(request.url)
    const method = url.pathname.replace('/xrpc/', '')

    switch (method) {
        case 'com.atproto.repo.getRecord':
            return handleGetRecord(url, journal, did)

        case 'com.atproto.repo.listRecords':
            return handleListRecords(url, journal, did)

        case 'com.atproto.identity.resolveHandle':
            return handleResolveHandle(url, handle, did)

        case 'com.atproto.server.describeServer':
            return handleDescribeServer(url, did)

        case 'com.atproto.sync.subscribeRepos':
            return handleSubscribeRepos(request, env, journal)

        case 'com.atproto.sync.listRepos':
            return handleListRepos(did, journal)

        case 'com.atproto.sync.getLatestCommit':
            return handleGetLatestCommit(url, journal, did)

        case 'com.atproto.sync.getRepoStatus':
            return handleGetRepoStatus(url, journal, did)

        case 'com.atproto.sync.getRepo':
            return handleGetRepo(url, journal, did)

        case 'com.atproto.repo.describeRepo':
            return handleDescribeRepo(url, journal, handle, did, env)

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
function handleGetRecord(url, journal, ownerDid) {
    const repoDid = url.searchParams.get('repo')
    const collection = url.searchParams.get('collection')
    const rkey = url.searchParams.get('rkey')

    if (!repoDid || !collection || !rkey) {
        return xrpcError(400, 'InvalidRequest', 'repo, collection, and rkey are required')
    }

    if (repoDid !== ownerDid) {
        return xrpcError(400, 'InvalidRequest', 'Can only get records from this PDS')
    }

    const event = journal.getRecord(collection, rkey)
    if (!event) {
        return xrpcError(404, 'RecordNotFound', 'Record not found')
    }

    return xrpcSuccess({
        uri: `at://${ownerDid}/${collection}/${rkey}`,
        cid: event.cid,
        value: event.record
    })
}

/**
 * com.atproto.repo.listRecords - list from journal
 */
function handleListRecords(url, journal, ownerDid) {
    const repoDid = url.searchParams.get('repo')
    const collection = url.searchParams.get('collection')
    const limit = Math.min(parseInt(url.searchParams.get('limit')) || 50, 100)
    const cursor = url.searchParams.get('cursor')

    if (!repoDid || !collection) {
        return xrpcError(400, 'InvalidRequest', 'repo and collection are required')
    }

    if (repoDid !== ownerDid) {
        return xrpcError(400, 'InvalidRequest', 'Can only list records from this PDS')
    }

    const result = journal.listRecords(collection, { limit, cursor })

    return xrpcSuccess({
        records: result.records.map(e => ({
            uri: `at://${ownerDid}/${collection}/${e.rkey}`,
            cid: e.cid,
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
 */
function handleDescribeServer(url, did) {
    return xrpcSuccess({
        did: did,
        availableUserDomains: [],
        inviteCodeRequired: false,
        phoneVerificationRequired: false,
        links: {}
    })
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
function handleListRepos(did, journal) {
    const latest = journal.events.length > 0 ? journal.events[journal.events.length - 1] : null

    return xrpcSuccess({
        repos: [{
            did,
            head: latest ? latest.cid : null,
            rev: latest ? latest.rev : null
        }]
    })
}

/**
 * com.atproto.sync.getLatestCommit
 */
function handleGetLatestCommit(url, journal, ownerDid) {
    const repoDid = url.searchParams.get('did')

    if (repoDid !== ownerDid) {
        return xrpcError(400, 'InvalidRequest', 'Can only get commits from this PDS')
    }

    if (journal.events.length === 0) {
        return xrpcError(404, 'RepoNotFound', 'No commits found')
    }

    const latest = journal.events[journal.events.length - 1]

    return xrpcSuccess({
        cid: latest.cid,
        rev: latest.rev
    })
}

/**
 * com.atproto.sync.getRepoStatus
 * Hosting status for a repository on this server.
 */
function handleGetRepoStatus(url, journal, ownerDid) {
    const repoDid = url.searchParams.get('did')

    if (repoDid !== ownerDid) {
        return xrpcError(400, 'InvalidRequest', 'Can only get status of repos on this PDS')
    }

    const latest = journal.events.length > 0 ? journal.events[journal.events.length - 1] : null

    return xrpcSuccess({
        did: repoDid,
        active: true,
        rev: latest ? latest.rev : null
    })
}

/**
 * com.atproto.sync.getRepo
 * Download repository export as CAR file.
 * New format: rebuilds full CAR from all per-commit blocks in the journal.
 * Legacy fallback: empty CAR (see ADR-006).
 */
function handleGetRepo(url, journal, ownerDid) {
    const repoDid = url.searchParams.get('did')

    if (repoDid !== ownerDid) {
        return xrpcError(400, 'InvalidRequest', 'Can only get repos on this PDS')
    }

    if (journal.events.length === 0) {
        return xrpcError(404, 'RepoNotFound', 'No commits found')
    }

    const latest = journal.events[journal.events.length - 1]

    // New format: rebuild full CAR from per-commit CAR blocks
    if (latest.commitCid && latest.blocksB64) {
        const car = rebuildRepoCar(journal.events, latest.commitCid)
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
 * Throws if the varint is unterminated (EOF before the continuation bit clears).
 */
function readCarVarint(carBytes, pos) {
    let value = 0
    let shift = 0
    while (true) {
        if (pos >= carBytes.length) {
            throw new Error('CAR varint is truncated: unexpected end of data')
        }
        const b = carBytes[pos++]
        value |= (b & 0x7f) << shift
        if (!(b & 0x80)) return { value, pos }
        shift += 7
        if (shift > 63) {
            throw new Error('CAR varint is too long (exceeds 64-bit range)')
        }
    }
}

/**
 * Merge all per-commit CAR blocks from the journal into a single CAR
 * rooted at the latest commit. Returns Uint8Array.
 * @throws {Error} If any CAR data is malformed, truncated, or contains trailing garbage.
 */
function rebuildRepoCar(events, rootCid) {
    const allBlocks = new Map()

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
            if (blockBytes.length < 36) {
                throw new Error('CAR block is too short to contain a CID')
            }
            const cidBytes = blockBytes.slice(0, 36)
            const cidStr = 'b' + base32Encode(cidBytes)
            allBlocks.set(cidStr, blockBytes.slice(36))
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
 * com.atproto.repo.describeRepo
 * Get information about the account and repository.
 */
function handleDescribeRepo(url, journal, ownerHandle, ownerDid, env) {
    const repo = url.searchParams.get('repo')

    if (!repo) {
        return xrpcError(400, 'InvalidRequest', 'repo is required')
    }

    // Resolve handle or DID to our DID
    if (repo.startsWith('did:')) {
        if (repo !== ownerDid) {
            return xrpcError(400, 'InvalidRequest', 'Can only describe repos on this PDS')
        }
    } else if (repo !== ownerHandle) {
        return xrpcError(400, 'InvalidRequest', 'Can only describe repos on this PDS')
    }

    const didDoc = generateDidWebDocument(
        env.OWNER_HANDLE || url.hostname,
        ownerHandle,
        env.OWNER_PUBLIC_KEY,
        ownerDid
    )

    // Collect distinct collections from journal
    const collections = [...journal.byCollection.keys()]

    return xrpcSuccess({
        handle: ownerHandle,
        did: ownerDid,
        didDoc,
        collections,
        handleIsCorrect: true
    })
}
