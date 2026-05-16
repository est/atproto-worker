/**
 * AT Protocol Personal Data Server - Cloudflare Worker
 * Event-Sourced Static Publisher
 * 
 * Uses an append-only journal as single source of truth.
 * No database, no mutable state, stateless worker.
 */

import { Journal } from './journal.js'
import { handleXrpc } from './xrpc.js'
import { handleAtprotoDid, handleDidJson } from './did.js'
import { syncInteractions, syncFollowers } from './interactions.js'

// Re-export Durable Object
export { Firehose } from './firehose.js'

export default {
    /**
     * Handle HTTP requests
     */
    async fetch(request, env, ctx) {
        const url = new URL(request.url)
        const path = url.pathname

        // CORS headers
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        }

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders })
        }

        // Initialize journal
        const journal = new Journal(env)
        await journal.load()

        const did = env.OWNER_DID || `did:web:${url.host}`
        const handle = env.OWNER_HANDLE || url.host

        try {
            let response

            // Refresh endpoint - sync journal from HTTP source
            if (path === '/refresh') {
                const oldEventCount = journal.events.length
                const result = await journal.refresh()
                const newEvents = journal.events.slice(oldEventCount)

                // Broadcast new events to firehose
                if (newEvents.length > 0) {
                    const id = env.FIREHOSE.idFromName('main')
                    const stub = env.FIREHOSE.get(id)
                    ctx.waitUntil(stub.fetch('http://localhost/broadcast', {
                        method: 'POST',
                        body: JSON.stringify({ events: newEvents }),
                        headers: { 'Content-Type': 'application/json' }
                    }))
                }

                response = new Response(JSON.stringify({
                    ok: true,
                    message: `Journal refreshed, ${newEvents.length} new events broadcasted`,
                    ...result
                }), {
                    headers: { 'Content-Type': 'application/json' }
                })
            }
            // Well-known endpoints
            else if (path === '/.well-known/atproto-did') {
                response = handleAtprotoDid(did)
            }
            else if (path === '/.well-known/did.json') {
                response = handleDidJson(url.host, handle, env.OWNER_PUBLIC_KEY)
            }
            // XRPC API
            else if (path.startsWith('/xrpc/')) {
                response = await handleXrpc(request, { journal, did, handle, env })
            }
            // Root info
            else if (path === '/') {
                response = new Response(JSON.stringify({
                    name: 'atproto-worker',
                    description: 'Event-Sourced AT Protocol Publisher',
                    did,
                    handle,
                    journal: {
                        events: journal.events.length,
                        currentSeq: journal.getCurrentSeq()
                    },
                    endpoints: {
                        xrpc: '/xrpc/',
                        refresh: '/refresh',
                        atprotoDid: '/.well-known/atproto-did'
                    }
                }, null, 2), {
                    headers: { 'Content-Type': 'application/json' }
                })
            }
            else {
                response = new Response('Not Found', { status: 404 })
            }

            // Add CORS (except for 101 Switching Protocols)
            if (response.status === 101) {
                return response
            }

            const newHeaders = new Headers(response.headers)
            for (const [key, value] of Object.entries(corsHeaders)) {
                newHeaders.set(key, value)
            }

            return new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers: newHeaders
            })
        } catch (e) {
            console.error('Request error:', e)
            return new Response(JSON.stringify({
                error: 'InternalError',
                message: e.message
            }), {
                status: 500,
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            })
        }
    },

    /**
     * Scheduled cron - sync interactions from Bluesky
     */
    async scheduled(controller, env, ctx) {
        const journal = new Journal(env)
        await journal.load()
        const oldEventCount = journal.events.length

        const did = env.OWNER_DID
        const handle = env.OWNER_HANDLE

        if (!did) return

        // Optionally refresh journal on cron
        if (env.JOURNAL_URL) {
            try {
                await journal.refresh()
                const newEvents = journal.events.slice(oldEventCount)

                if (newEvents.length > 0) {
                    const id = env.FIREHOSE.idFromName('main')
                    const stub = env.FIREHOSE.get(id)
                    ctx.waitUntil(stub.fetch('http://localhost/broadcast', {
                        method: 'POST',
                        body: JSON.stringify({ events: newEvents }),
                        headers: { 'Content-Type': 'application/json' }
                    }))
                }
            } catch (e) {
                console.error('Journal refresh failed:', e)
            }
        }

        // Sync interactions (these go to separate KV, not journal)
        ctx.waitUntil(syncInteractions(journal, did, handle))
    }
}
