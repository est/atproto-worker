/**
 * Firehose (subscribeRepos) - Durable Object for WebSocket subscriptions
 * Streams events from journal
 */

import { cborEncode } from './utils.js'

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

        const cursor = url.searchParams.get('cursor')
        const [client, server] = Object.values(new WebSocketPair())

        this.state.acceptWebSocket(server)
        server.serializeAttachment({ cursor: cursor ? parseInt(cursor) : null })

        // Backfill from journal
        if (cursor !== null) {
            this.state.waitUntil(this.backfill(server, parseInt(cursor)))
        }

        return new Response(null, { status: 101, webSocket: client })
    }

    /**
     * Backfill events from journal
     */
    async backfill(ws, cursor) {
        try {
            // Load journal
            const { Journal } = await import('./journal.js')
            const journal = new Journal(this.env)
            await journal.load()

            const events = journal.getEventsFromCursor(cursor, 1000)

            for (const event of events) {
                const message = this.formatEvent(event)

                try {
                    ws.send(cborEncode(message))
                } catch (e) {
                    return // Client disconnected
                }
            }

            // Update cursor
            if (events.length > 0) {
                const lastOffset = events[events.length - 1].offset
                ws.serializeAttachment({ cursor: lastOffset })
            }
        } catch (e) {
            console.error('Backfill error:', e)
        }
    }

    /**
     * Format event for firehose (AT Protocol compliant)
     */
    formatEvent(event) {
        return {
            $type: '#commit',
            seq: event.offset,
            time: event.time,
            rebase: false,
            tooBig: false,
            repo: event.did,
            commit: event.cid,
            rev: String(event.offset),
            since: event.prev,
            blocks: new Uint8Array(0), // No CAR blocks in static model
            ops: [{
                action: event.op,
                path: `${event.collection}/${event.rkey}`,
                cid: event.op === 'delete' ? null : event.cid
            }],
            blobs: []
        }
    }

    async webSocketMessage(ws, message) {
        // Client shouldn't send messages
    }

    async webSocketClose(ws, code, reason) {
        // Cleanup handled by DO
    }

    async webSocketError(ws, error) {
        console.error('WebSocket error:', error)
    }
}
