/**
 * XRPC endpoint routing and handling for AT Protocol PDS
 */

import { parseAtUri, nowISO, isValidDID, generateTID } from './utils.js'
import { resolveHandle } from './did.js'

/**
 * XRPC error response helper
 */
function xrpcError(status, error, message) {
    return new Response(JSON.stringify({ error, message }), {
        status,
        headers: { 'Content-Type': 'application/json' }
    })
}

/**
 * XRPC success response helper
 */
function xrpcSuccess(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' }
    })
}

/**
 * Handle XRPC requests
 */
export async function handleXrpc(request, { repo, db, did, handle, env }) {
    const url = new URL(request.url)
    const method = url.pathname.replace('/xrpc/', '')

    // Route to appropriate handler
    switch (method) {
        case 'com.atproto.repo.createRecord':
            return handleCreateRecord(request, repo, did)

        case 'com.atproto.repo.getRecord':
            return handleGetRecord(url, repo, did)

        case 'com.atproto.repo.listRecords':
            return handleListRecords(url, repo, did)

        case 'com.atproto.repo.deleteRecord':
            return handleDeleteRecord(request, repo, did)

        case 'com.atproto.repo.putRecord':
            return handlePutRecord(request, repo, did)

        case 'com.atproto.identity.resolveHandle':
            return handleResolveHandle(url, handle, did)

        case 'com.atproto.server.describeServer':
            return handleDescribeServer(url, did)

        case 'com.atproto.sync.subscribeRepos':
            // WebSocket upgrade - delegated to Durable Object
            return handleSubscribeRepos(request, env, db)

        case 'com.atproto.sync.getRepo':
            return handleGetRepo(url, repo, did)

        case 'com.atproto.sync.listRepos':
            return handleListRepos(did)

        default:
            return xrpcError(501, 'MethodNotImplemented', `Method ${method} is not implemented`)
    }
}

/**
 * com.atproto.repo.createRecord
 */
async function handleCreateRecord(request, repo, ownerDid) {
    if (request.method !== 'POST') {
        return xrpcError(405, 'InvalidRequest', 'Method must be POST')
    }

    let body
    try {
        body = await request.json()
    } catch (e) {
        return xrpcError(400, 'InvalidRequest', 'Invalid JSON body')
    }

    const { repo: repoDid, collection, rkey, record, validate } = body

    // Validate repo DID matches owner
    if (repoDid !== ownerDid) {
        return xrpcError(403, 'AuthRequired', 'Can only create records in your own repo')
    }

    if (!collection) {
        return xrpcError(400, 'InvalidRequest', 'collection is required')
    }

    if (!record) {
        return xrpcError(400, 'InvalidRequest', 'record is required')
    }

    // Validate record has $type
    if (!record.$type) {
        record.$type = collection
    }

    // Validate createdAt for posts
    if (collection === 'app.bsky.feed.post' && !record.createdAt) {
        record.createdAt = nowISO()
    }

    try {
        const result = await repo.createRecord(collection, record, rkey)
        return xrpcSuccess({
            uri: result.uri,
            cid: result.cid,
            validationStatus: validate === false ? undefined : 'valid'
        })
    } catch (e) {
        if (e.message?.includes('UNIQUE constraint')) {
            return xrpcError(400, 'RecordExists', 'Record with this rkey already exists')
        }
        return xrpcError(500, 'InternalError', e.message)
    }
}

/**
 * com.atproto.repo.getRecord
 */
async function handleGetRecord(url, repo, ownerDid) {
    const repoDid = url.searchParams.get('repo')
    const collection = url.searchParams.get('collection')
    const rkey = url.searchParams.get('rkey')

    if (!repoDid || !collection || !rkey) {
        return xrpcError(400, 'InvalidRequest', 'repo, collection, and rkey are required')
    }

    // Only serve records from own repo
    if (repoDid !== ownerDid) {
        return xrpcError(400, 'InvalidRequest', 'Can only get records from this PDS')
    }

    const result = await repo.getRecord(collection, rkey)
    if (!result) {
        return xrpcError(404, 'RecordNotFound', 'Record not found')
    }

    return xrpcSuccess({
        uri: result.uri,
        cid: result.cid,
        value: result.value
    })
}

/**
 * com.atproto.repo.listRecords
 */
async function handleListRecords(url, repo, ownerDid) {
    const repoDid = url.searchParams.get('repo')
    const collection = url.searchParams.get('collection')
    const limit = Math.min(parseInt(url.searchParams.get('limit')) || 50, 100)
    const cursor = url.searchParams.get('cursor')
    const reverse = url.searchParams.get('reverse') !== 'false'

    if (!repoDid || !collection) {
        return xrpcError(400, 'InvalidRequest', 'repo and collection are required')
    }

    if (repoDid !== ownerDid) {
        return xrpcError(400, 'InvalidRequest', 'Can only list records from this PDS')
    }

    const result = await repo.listRecords(collection, { limit, cursor, reverse })

    return xrpcSuccess({
        records: result.records,
        cursor: result.cursor
    })
}

/**
 * com.atproto.repo.deleteRecord
 */
async function handleDeleteRecord(request, repo, ownerDid) {
    if (request.method !== 'POST') {
        return xrpcError(405, 'InvalidRequest', 'Method must be POST')
    }

    let body
    try {
        body = await request.json()
    } catch (e) {
        return xrpcError(400, 'InvalidRequest', 'Invalid JSON body')
    }

    const { repo: repoDid, collection, rkey } = body

    if (repoDid !== ownerDid) {
        return xrpcError(403, 'AuthRequired', 'Can only delete records from your own repo')
    }

    if (!collection || !rkey) {
        return xrpcError(400, 'InvalidRequest', 'collection and rkey are required')
    }

    const deleted = await repo.deleteRecord(collection, rkey)
    if (!deleted) {
        return xrpcError(404, 'RecordNotFound', 'Record not found')
    }

    return xrpcSuccess({})
}

/**
 * com.atproto.repo.putRecord
 */
async function handlePutRecord(request, repo, ownerDid) {
    if (request.method !== 'POST') {
        return xrpcError(405, 'InvalidRequest', 'Method must be POST')
    }

    let body
    try {
        body = await request.json()
    } catch (e) {
        return xrpcError(400, 'InvalidRequest', 'Invalid JSON body')
    }

    const { repo: repoDid, collection, rkey, record } = body

    if (repoDid !== ownerDid) {
        return xrpcError(403, 'AuthRequired', 'Can only put records in your own repo')
    }

    if (!collection || !rkey || !record) {
        return xrpcError(400, 'InvalidRequest', 'collection, rkey, and record are required')
    }

    try {
        const result = await repo.putRecord(collection, rkey, record)
        return xrpcSuccess({
            uri: result.uri,
            cid: result.cid
        })
    } catch (e) {
        return xrpcError(500, 'InternalError', e.message)
    }
}

/**
 * com.atproto.identity.resolveHandle
 */
async function handleResolveHandle(url, ownerHandle, ownerDid) {
    const handle = url.searchParams.get('handle')

    if (!handle) {
        return xrpcError(400, 'InvalidRequest', 'handle is required')
    }

    const did = await resolveHandle(handle, ownerHandle, ownerDid)
    if (!did) {
        return xrpcError(400, 'HandleNotFound', 'Unable to resolve handle')
    }

    return xrpcSuccess({ did })
}

/**
 * com.atproto.server.describeServer
 */
async function handleDescribeServer(url, did) {
    const host = url.host

    return xrpcSuccess({
        did: `did:web:${host}`,
        availableUserDomains: [],
        inviteCodeRequired: false,
        phoneVerificationRequired: false,
        links: {}
    })
}

/**
 * com.atproto.sync.subscribeRepos - WebSocket handler
 * Delegates to Durable Object for persistent connection
 */
async function handleSubscribeRepos(request, env, db) {
    // Check for WebSocket upgrade
    const upgradeHeader = request.headers.get('Upgrade')
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
        return xrpcError(400, 'InvalidRequest', 'WebSocket upgrade required')
    }

    // Get cursor from query params
    const url = new URL(request.url)
    const cursor = url.searchParams.get('cursor')

    // Get Durable Object for firehose
    const id = env.FIREHOSE.idFromName('main')
    const stub = env.FIREHOSE.get(id)

    // Forward request to Durable Object
    const newUrl = new URL(request.url)
    newUrl.pathname = '/subscribe'
    if (cursor) {
        newUrl.searchParams.set('cursor', cursor)
    }

    return stub.fetch(newUrl.toString(), request)
}

/**
 * com.atproto.sync.getRepo
 */
async function handleGetRepo(url, repo, ownerDid) {
    const did = url.searchParams.get('did')

    if (did !== ownerDid) {
        return xrpcError(400, 'InvalidRequest', 'Can only get repo from this PDS')
    }

    // Return a simple JSON representation of the repo
    // A full implementation would return a CAR file
    const records = await repo.getAllRecords()

    return xrpcSuccess({
        did: ownerDid,
        records: records.map(r => ({
            collection: r.collection,
            rkey: r.rkey,
            cid: r.cid
        }))
    })
}

/**
 * com.atproto.sync.listRepos
 */
async function handleListRepos(did) {
    // Single-user PDS, only one repo
    return xrpcSuccess({
        repos: [{
            did,
            head: generateTID(), // placeholder
            rev: generateTID()
        }]
    })
}
