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
export const MAX_CONCURRENT_SOCKETS = 8

/**
 * Sliding-window connect limiter decision. `recentAttempts` are timestamps
 * of prior attempts from the same client; returns whether a new attempt is
 * allowed plus the trimmed list to persist.
 */
export function shouldAllowConnect(recentAttempts, now, max = MAX_CONNECTS_PER_WINDOW, windowMs = CONNECT_WINDOW_MS) {
    const recent = recentAttempts.filter(t => now - t < windowMs)
    return { allowed: recent.length < max, recent }
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
            await this.broadcast(body.events)
            return new Response('OK')
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

        // Per-IP connect rate limit (protects the DO free-tier quota from
        // reconnect storms; see shouldAllowConnect).
        const ipKey = `ws-attempts:${cfConnectingIp}`
        const prevAttempts = (await this.state.storage.get(ipKey)) || []
        const { allowed, recent } = shouldAllowConnect(prevAttempts, Date.now())
        if (!allowed) {
            console.warn(`[firehose] rate-limiting WS connects from ${cfConnectingIp} (${userAgent}): ${recent.length} in the last minute`)
            return new Response(JSON.stringify({
                error: 'RateLimited',
                message: 'Too many connection attempts, retry later'
            }), { status: 429, headers: { 'Content-Type': 'application/json' } })
        }
        await this.state.storage.put(ipKey, [...recent, Date.now()], { expirationTtl: 120 })

        // Cap concurrent sockets so one client can't pile up open connections
        const openSockets = this.state.getWebSockets()
        if (openSockets.length >= MAX_CONCURRENT_SOCKETS) {
            console.warn(`[firehose] rejecting WS connect from ${cfConnectingIp}: ${openSockets.length} sockets open`)
            return new Response(JSON.stringify({
                error: 'TooManyClients',
                message: 'Too many active connections'
            }), { status: 503, headers: { 'Content-Type': 'application/json' } })
        }

        const cursorParam = url.searchParams.get('cursor')
        const cursor = cursorParam === null || Number.isNaN(parseInt(cursorParam)) ? null : parseInt(cursorParam)
        console.log(`[firehose] WS connect from ${cfConnectingIp} (${userAgent}) cursor=${cursor} path=${url.pathname}`)

        const [client, server] = Object.values(new WebSocketPair())

        // Need to accept the server-side websocket via state to handle events
        this.state.acceptWebSocket(server)
        server.serializeAttachment({ cursor })

        // Backfill from journal: no cursor = new subscriber, send everything
        // (matches relay expectations: a fresh host subscription gets the
        // full history so it can index the repo without prior events)
        this.state.waitUntil(this.backfill(server, cursor === null ? -1 : cursor))

        console.log(`New WebSocket client connected, cursor: ${cursor}`)

        return new Response(null, { status: 101, webSocket: client })
    }

    /**
     * Backfill events from journal
     */
    async backfill(ws, cursor) {
        try {
            // Load journal
            const journal = new Journal(this.env)
            await journal.load()

            const allEvents = journal.getEventsFromCursor(cursor, 1000)

            // Filter by OWNER_DID
            const events = allEvents.filter(e => e.did === this.env.OWNER_DID)

            for (const event of events) {
                const message = this.formatEvent(event)

                try {
                    ws.send(message)
                } catch (e) {
                    return // Client disconnected
                }
            }

            // Update cursor based on actual journal offset, 
            // even if filtered out, so we don't re-process
            if (allEvents.length > 0) {
                const lastOffset = allEvents[allEvents.length - 1].offset
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
     */
    async broadcast(events) {
        const filteredEvents = events.filter(e => e.did === this.env.OWNER_DID)
        if (filteredEvents.length === 0) return

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
        // Client shouldn't send messages for subscribeRepos
        // But we should handle it gracefully
        console.warn('Unexpected message from client')
    }

    async webSocketClose(ws, code, reason) {
        console.log(`WebSocket client disconnected: ${code} ${reason}`)
    }    async webSocketError(ws, error) {
        console.error('WebSocket error:', error)
    }
}
