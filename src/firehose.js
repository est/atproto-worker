/**
 * Firehose (subscribeRepos) - Durable Object for WebSocket subscriptions
 * Streams events from journal
 */

import { cborEncode, createCarFile } from './shared.js'
import { Journal } from './journal.js'

// Base64 (standard) -> Uint8Array (works in both CF Workers and Node.js)
function base64ToBytes(b64) {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytes
}

// Connection limits for the firehose. A client whose stream dies right after
// the upgrade (e.g. a relay failing commit verification) will otherwise
// reconnect at seconds-per-attempt with no backoff — indigo's slurper only
// backs off on *dial* failure, and each attempt is one DO request. On the
// free tier that burns the monthly DO quota within hours. Rejecting the
// upgrade with a non-101 status turns each attempt into a dial failure,
// which does trigger client-side backoff.
export const CONNECT_WINDOW_MS = 60_000
export const MAX_CONNECTS_PER_WINDOW = 8
export const MAX_GLOBAL_CONNECTS_PER_WINDOW = 15
export const MAX_CONCURRENT_SOCKETS = 8
export const MAX_SOCKETS_PER_IP = 2

/**
 * Sliding-window connect limiter decision. `recentAttempts` are timestamps
 * of prior attempts from the same client; returns whether a new attempt is
 * allowed plus the trimmed list to persist.
 */
export function shouldAllowConnect(recentAttempts, now, max = MAX_CONNECTS_PER_WINDOW, windowMs = CONNECT_WINDOW_MS) {
    const recent = recentAttempts.filter(t => now - t < windowMs)
    return { allowed: recent.length < max, recent }
}

// Every inbound WS message to a hibernating DO is one DO request, and
// subscribeRepos is server→client only — any data message is client
// misbehavior. Close instead of just logging so a client can't burn quota.
export async function closeOnUnexpectedMessage(ws) {
    try {
        ws.close(1008, 'Unexpected message')
    } catch (e) {
        // socket already gone
    }
}

/**
 * Firehose Durable Object
 */
export class Firehose {
    constructor(state, env) {
        this.state = state
        this.env = env
    }

    async fetch(request) {
        const url = new URL(request.url)

        if (url.pathname === '/subscribe') {
            return this.handleWebSocket(request, url)
        }

        if (url.pathname === '/broadcast' && request.method === 'POST') {
            const body = await request.json()
            const lastOffset = await this.broadcast(body.events)
            // Persist the broadcast cursor in DO storage: it survives across
            // requests without KV (the worker is otherwise stateless).
            const prev = parseInt(await this.state.storage.get('broadcast-cursor')) || -1
            const next = Math.max(prev, lastOffset)
            await this.state.storage.put('broadcast-cursor', String(next))
            return new Response('OK')
        }

        // Read back the last-broadcast offset (used by /refresh and the cron
        // to decide which journal events are new).
        if (url.pathname === '/cursor') {
            const cursor = parseInt(await this.state.storage.get('broadcast-cursor')) || -1
            return new Response(JSON.stringify({ cursor }), {
                headers: { 'Content-Type': 'application/json' }
            })
        }

        return new Response('Not Found', { status: 404 })
    }

    /**
     * Handle WebSocket subscription
     */
    async handleWebSocket(request, url) {
        const upgradeHeader = request.headers.get('Upgrade')
        if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
            return new Response('Expected WebSocket', { status: 426 })
        }

        const cfConnectingIp = request.headers.get('CF-Connecting-IP') || 'unknown'
        const userAgent = request.headers.get('User-Agent') || 'unknown'
        const now = Date.now()

        // Global connect cap: per-IP limits don't protect the DO quota from
        // multi-IP clients; every attempt (allowed or rejected) is one DO
        // request, so cap the total across all IPs.
        const globalKey = 'ws-attempts:global'
        const globalPrev = (await this.safeStorageGet(globalKey)) || []
        const globalLimit = shouldAllowConnect(globalPrev, now, MAX_GLOBAL_CONNECTS_PER_WINDOW)
        if (!globalLimit.allowed) {
            console.warn(`[firehose] global connect rate-limit hit from ${cfConnectingIp} (${userAgent})`)
            return this.rateLimitResponse()
        }

        // Per-IP connect rate limit (protects the DO free-tier quota from
        // reconnect storms; see shouldAllowConnect).
        const ipKey = `ws-attempts:${cfConnectingIp}`
        const prevAttempts = (await this.safeStorageGet(ipKey)) || []
        const { allowed, recent } = shouldAllowConnect(prevAttempts, now)
        if (!allowed) {
            console.warn(`[firehose] rate-limiting WS connects from ${cfConnectingIp} (${userAgent}): ${recent.length} in the last minute`)
            return this.rateLimitResponse()
        }

        // Socket caps (global + per-IP) so one client can't hold all slots.
        const openSockets = this.state.getWebSockets()
        if (openSockets.length >= MAX_CONCURRENT_SOCKETS) {
            console.warn(`[firehose] rejecting WS connect from ${cfConnectingIp}: ${openSockets.length} sockets open`)
            return new Response(JSON.stringify({
                error: 'TooManyClients',
                message: 'Too many active connections'
            }), { status: 503, headers: { 'Content-Type': 'application/json' } })
        }
        const mySockets = openSockets.filter(s => (s.deserializeAttachment ? (s.deserializeAttachment() || {}).ip : null) === cfConnectingIp)
        if (mySockets.length >= MAX_SOCKETS_PER_IP) {
            console.warn(`[firehose] rejecting WS connect from ${cfConnectingIp}: already has ${mySockets.length} sockets`)
            return new Response(JSON.stringify({
                error: 'TooManyClients',
                message: 'Too many connections from this IP'
            }), { status: 503, headers: { 'Content-Type': 'application/json' } })
        }

        // Record attempts only after every rejection check, so rejected
        // clients don't burn other clients' rate-limit budget.
        await this.safeStoragePut(ipKey, [...recent, now], { expirationTtl: 120 })
        await this.safeStoragePut(globalKey, [...globalLimit.recent, now], { expirationTtl: 120 })

        const cursorParam = url.searchParams.get('cursor')
        const cursor = cursorParam === null || Number.isNaN(parseInt(cursorParam)) ? null : parseInt(cursorParam)
        console.log(`[firehose] WS connect from ${cfConnectingIp} (${userAgent}) cursor=${cursor} path=${url.pathname}`)

        const [client, server] = Object.values(new WebSocketPair())

        // Need to accept the server-side websocket via state to handle events
        this.state.acceptWebSocket(server)
        server.serializeAttachment({ cursor, ip: cfConnectingIp })

        // Backfill from journal: no cursor = new subscriber, send everything
        // (matches relay expectations: a fresh host subscription gets the
        // full history so it can index the repo without prior events)
        this.state.waitUntil(this.backfill(server, cursor === null ? -1 : cursor))

        console.log(`New WebSocket client connected, cursor: ${cursor}`)

        return new Response(null, { status: 101, webSocket: client })
    }

    rateLimitResponse() {
        return new Response(JSON.stringify({
            error: 'RateLimited',
            message: 'Too many connection attempts, retry later'
        }), { status: 429, headers: { 'Content-Type': 'application/json' } })
    }

    // Storage failures must not break legitimate subscribers: fail open.
    async safeStorageGet(key) {
        try {
            return await this.state.storage.get(key)
        } catch (e) {
            console.error('[firehose] storage.get failed:', e.message)
            return null
        }
    }

    async safeStoragePut(key, value, opts) {
        try {
            await this.state.storage.put(key, value, opts)
        } catch (e) {
            console.error('[firehose] storage.put failed:', e.message)
        }
    }

    /**
     * Backfill events from journal
     */
    async backfill(ws, cursor) {
        try {
            // Load journal
            const journal = new Journal(this.env)
            await journal.load()

            // Page through the whole journal past the cursor — a fresh
            // subscriber must get every event or it indexes a partial repo.
            let lastOffset = cursor
            while (true) {
                const batch = journal.getEventsFromCursor(lastOffset, 1000)
                if (batch.length === 0) break

                // Filter by OWNER_DID
                const events = batch.filter(e => e.did === this.env.OWNER_DID)

                for (const event of events) {
                    const message = this.formatEvent(event)

                    try {
                        ws.send(message)
                    } catch (e) {
                        return // Client disconnected
                    }
                }

                lastOffset = batch[batch.length - 1].offset
            }

            // Update cursor based on actual journal offset,
            // even if filtered out, so we don't re-process
            if (lastOffset !== cursor) {
                ws.serializeAttachment({ cursor: lastOffset })
            }
        } catch (e) {
            console.error('Backfill error:', e)
            this.sendError(ws, 'InternalError', 'Failed to backfill events')
        }
    }

    /**
     * Send error frame to client (header {op:-1} + body {error, message})
     */
    sendError(ws, error, message) {
        try {
            ws.send(this.sendErrorFrame(error, message))
        } catch (e) {
            console.error('Failed to send error frame:', e)
        }
    }

    /**
     * Broadcast new events to all connected clients
     * @param {Array} events - New events from journal
     * @returns {Promise<number>} the max offset of the broadcast events (-1 if none)
     */
    async broadcast(events) {
        const filteredEvents = events.filter(e => e.did === this.env.OWNER_DID)
        if (filteredEvents.length === 0) return -1

        const formattedEvents = filteredEvents.map(e => this.formatEvent(e))
        const sockets = this.state.getWebSockets()

        console.log(`Broadcasting ${filteredEvents.length} events to ${sockets.length} clients`)

        for (const ws of sockets) {
            for (const msg of formattedEvents) {
                try {
                    ws.send(msg)
                } catch (e) {
                    console.error('Failed to send to client:', e)
                    // socket closed, will be removed by DO eventually
                }
            }
        }
        return filteredEvents[filteredEvents.length - 1].offset
    }

    /**
     * Format event for firehose (AT Protocol compliant)
     *
     * New format: blocks is the real CAR built by the CLI (commit v3 +
     * MST nodes + record), commit is the commit CID, ops carry record CIDs.
     * Legacy format: empty CAR fallback (see ADR-006).
     *
     * NOTE: subscribeRepos frames are CBOR(header) + CBOR(body), where
     * header = {op: 1 (Message), t: "#commit"}. The body carries the
     * event payload. Sending only the body breaks relay parsing.
     */
    formatEvent(event) {
        let body
        // New model: journal lines carry commitCid + blocksB64.
        // NOTE: commit / ops[].cid / prevData must be CID links (CBOR tag 42,
        // {$link: ...}), not plain strings — the relay's LexLink.UnmarshalCBOR
        // (cbg.ReadCid) fails on strings and drops the connection, which was
        // the source of its reconnect loop.
        if (event.commitCid && event.blocksB64) {
            body = {
                seq: event.offset,
                time: event.time,
                rebase: false,
                tooBig: false,
                repo: event.did,
                commit: { $link: event.commitCid },
                rev: event.rev,
                since: event.prevRev || null,
                prevData: event.prevMstRoot ? { $link: event.prevMstRoot } : null,
                blocks: base64ToBytes(event.blocksB64),
                ops: [{
                    action: event.op,
                    path: `${event.collection}/${event.rkey}`,
                    cid: event.op === 'delete' ? null : { $link: event.recordCid || event.commitCid }
                }],
                blobs: []
            }
        } else {
            // Legacy fallback: empty CAR
            body = {
                seq: event.offset,
                time: event.time,
                rebase: false,
                tooBig: false,
                repo: event.did,
                commit: { $link: event.cid },
                rev: event.rev,
                since: event.prevRev || null,
                blocks: createCarFile(event.cid, []),
                ops: [{
                    action: event.op,
                    path: `${event.collection}/${event.rkey}`,
                    cid: event.op === 'delete' ? null : { $link: event.cid }
                }],
                blobs: []
            }
        }

        // Frame = CBOR(header {op:1, t:'#commit'}) + CBOR(body)
        const header = cborEncode({ op: 1, t: '#commit' })
        const bodyBytes = cborEncode(body)
        const frame = new Uint8Array(header.length + bodyBytes.length)
        frame.set(header, 0)
        frame.set(bodyBytes, header.length)
        return frame
    }

    /**
     * Send error frame: CBOR(header {op:-1}) + CBOR({error, message})
     */
    sendErrorFrame(error, message) {
        const header = cborEncode({ op: -1 })
        const body = cborEncode({ error, message })
        const frame = new Uint8Array(header.length + body.length)
        frame.set(header, 0)
        frame.set(body, header.length)
        return frame
    }

    async webSocketMessage(ws, message) {
        // subscribeRepos is server→client only. Any inbound data message is
        // client misbehavior — and each one bills a DO request — so close
        // the socket instead of just logging.
        console.warn('Unexpected message from client, closing socket')
        await closeOnUnexpectedMessage(ws)
    }

    async webSocketClose(ws, code, reason) {
        console.log(`WebSocket client disconnected: ${code} ${reason}`)
    }    async webSocketError(ws, error) {
        console.error('WebSocket error:', error)
    }
}
