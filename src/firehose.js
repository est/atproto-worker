/**
 * Firehose (subscribeRepos) - Durable Object for WebSocket subscriptions
 * Uses SQLite storage (free tier) for subscriber state
 */

import { cborEncode, nowISO } from './utils.js'

/**
 * Firehose Durable Object
 * Manages WebSocket connections for com.atproto.sync.subscribeRepos
 */
export class Firehose {
    constructor(state, env) {
        this.state = state
        this.env = env
        this.sessions = new Set()
    }

    async fetch(request) {
        const url = new URL(request.url)

        if (url.pathname === '/subscribe') {
            return this.handleWebSocket(request, url)
        }

        if (url.pathname === '/notify') {
            // Internal endpoint to notify of new events
            return this.handleNotify(request)
        }

        return new Response('Not Found', { status: 404 })
    }

    /**
     * Handle WebSocket upgrade and subscription
     */
    async handleWebSocket(request, url) {
        const upgradeHeader = request.headers.get('Upgrade')
        if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
            return new Response('Expected WebSocket', { status: 426 })
        }

        const cursor = url.searchParams.get('cursor')
        const [client, server] = Object.values(new WebSocketPair())

        // Accept the WebSocket
        this.state.acceptWebSocket(server)

        // Store cursor in WebSocket attachment for backfill
        server.serializeAttachment({ cursor: cursor ? parseInt(cursor) : null })

        // Start backfill if cursor provided
        if (cursor !== null) {
            this.state.waitUntil(this.backfill(server, parseInt(cursor)))
        }

        return new Response(null, { status: 101, webSocket: client })
    }

    /**
     * Backfill events from cursor to current
     */
    async backfill(ws, cursor) {
        try {
            const db = this.env.DB
            const events = await db.prepare(`
        SELECT * FROM sequences WHERE seq > ? ORDER BY seq ASC LIMIT 1000
      `).bind(cursor).all()

            for (const row of events.results) {
                const event = JSON.parse(row.event)
                const message = this.formatEvent(row.event_type, row.seq, row.created_at, event)

                try {
                    ws.send(cborEncode(message))
                } catch (e) {
                    // Client disconnected
                    return
                }
            }

            // Update cursor attachment
            if (events.results.length > 0) {
                const lastSeq = events.results[events.results.length - 1].seq
                ws.serializeAttachment({ cursor: lastSeq })
            }
        } catch (e) {
            console.error('Backfill error:', e)
        }
    }

    /**
     * Format an event for the firehose
     */
    formatEvent(type, seq, time, event) {
        switch (type) {
            case 'commit':
                return {
                    $type: '#commit',
                    seq,
                    time,
                    rebase: false,
                    tooBig: false,
                    repo: event.repo,
                    commit: event.commit,
                    rev: event.rev,
                    since: null,
                    blocks: new Uint8Array(0), // Simplified - no CAR blocks
                    ops: event.ops.map(op => ({
                        action: op.action,
                        path: op.path,
                        cid: op.cid
                    })),
                    blobs: event.blobs || []
                }

            case 'identity':
                return {
                    $type: '#identity',
                    seq,
                    time,
                    did: event.did,
                    handle: event.handle
                }

            case 'account':
                return {
                    $type: '#account',
                    seq,
                    time,
                    did: event.did,
                    active: event.active,
                    status: event.status
                }

            default:
                return { $type: `#${type}`, seq, time, ...event }
        }
    }

    /**
     * Handle internal notification of new events
     */
    async handleNotify(request) {
        try {
            const event = await request.json()
            await this.broadcast(event)
            return new Response('OK')
        } catch (e) {
            return new Response(e.message, { status: 500 })
        }
    }

    /**
     * Broadcast event to all connected WebSockets
     */
    async broadcast(event) {
        const message = this.formatEvent(event.type, event.seq, event.time, event.event)
        const encoded = cborEncode(message)

        // Get all connected WebSockets from Durable Object
        const sockets = this.state.getWebSockets()

        for (const ws of sockets) {
            try {
                ws.send(encoded)
            } catch (e) {
                // Client disconnected, will be cleaned up
            }
        }
    }

    /**
     * WebSocket message handler (Durable Object API)
     */
    async webSocketMessage(ws, message) {
        // Client shouldn't send messages, but handle gracefully
        // Could be used for ping/pong in the future
    }

    /**
     * WebSocket close handler (Durable Object API)
     */
    async webSocketClose(ws, code, reason) {
        // Cleanup handled automatically by Durable Object
    }

    /**
     * WebSocket error handler (Durable Object API)
     */
    async webSocketError(ws, error) {
        console.error('WebSocket error:', error)
    }
}
