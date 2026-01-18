/**
 * XRPC endpoint handling for event-sourced ATProto PDS
 * Read-only from journal, no write operations on worker
 */

import { resolveHandle } from './did.js'

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
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
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
    const currentSeq = journal.getCurrentSeq()

    return xrpcSuccess({
        repos: [{
            did,
            head: journal.events.length > 0 ? journal.events[journal.events.length - 1].cid : null,
            rev: String(currentSeq)
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
        rev: String(latest.offset)
    })
}
