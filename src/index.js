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
import { syncInteractions } from './interactions.js'
import { renderChecklistPage } from './setup.js'

// Re-export Durable Object
export { Firehose } from './firehose.js'

export default {
    /**
     * Handle HTTP requests
     */
    async fetch(request, env, ctx) {
        const url = new URL(request.url)
        const path = url.pathname

        // Log all incoming requests for debugging federation behavior
        const cfConnectingIp = request.headers.get('CF-Connecting-IP') || 'unknown'
        const userAgent = request.headers.get('User-Agent') || 'unknown'
        if (path.startsWith('/xrpc/') || path.startsWith('/.well-known/')) {
            console.log(`[req] ${request.method} ${path} from ${cfConnectingIp} (${userAgent})`)
        }

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
        try {
            await journal.load()
        } catch (e) {
            console.error('Journal load failed:', e)
            return new Response(JSON.stringify({
                error: 'JournalLoadError',
                message: `Failed to load journal: ${e.message}`
            }), {
                status: 500,
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            })
        }

        const did = env.OWNER_DID || `did:web:${url.host}`
        const handle = env.OWNER_HANDLE || url.host

        try {
            let response

            // Refresh endpoint - sync journal from HTTP source
            if (path === '/refresh') {
                const lastCidBefore = journal.events.length > 0
                    ? journal.events[journal.events.length - 1].cid
                    : null

                const result = await journal.refresh()

                // Find new events by matching last known CID
                // This protects against non-append-only journals
                let newEvents
                if (lastCidBefore) {
                    const lastIdx = journal.events.findIndex(e => e.cid === lastCidBefore)
                    if (lastIdx === -1) {
                        // Journal was completely rewritten - treat all as new
                        // This shouldn't happen in append-only mode
                        console.warn('Journal was rewritten (last CID not found), broadcasting all events')
                        newEvents = journal.events
                    } else {
                        newEvents = journal.events.slice(lastIdx + 1)
                    }
                } else {
                    newEvents = journal.events
                }

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
                response = handleDidJson(url.host, handle, env.OWNER_PUBLIC_KEY, did)
            }
            // XRPC API
            else if (path.startsWith('/xrpc/')) {
                response = await handleXrpc(request, { journal, did, handle, env })
            }
            // Root: deployment checklist page (HTML) or server info (JSON)
            else if (path === '/') {
                const wantsJson = (request.headers.get('Accept') || '').includes('application/json')
                if (!wantsJson) {
                    response = renderChecklistPage(env, journal, url.host)
                } else {
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
                message: 'An internal error occurred'
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

        const did = env.OWNER_DID
        const handle = env.OWNER_HANDLE

        if (!did) return

        // Optionally refresh journal on cron
        if (env.JOURNAL_URL) {
            try {
                const lastCidBefore = journal.events.length > 0
                    ? journal.events[journal.events.length - 1].cid
                    : null

                await journal.refresh()

                // Find new events by matching last known CID
                let newEvents
                if (lastCidBefore) {
                    const lastIdx = journal.events.findIndex(e => e.cid === lastCidBefore)
                    if (lastIdx === -1) {
                        console.warn('Journal was rewritten (last CID not found), broadcasting all events')
                        newEvents = journal.events
                    } else {
                        newEvents = journal.events.slice(lastIdx + 1)
                    }
                } else {
                    newEvents = journal.events
                }

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

        // Declare ourselves to the relay (like the reference PDS
        // Crawlers.notifyOfUpdate, 20-min throttle). Lets the relay know
        // we exist so it can subscribe and index our repo.
        if (env.OWNER_HANDLE && env.JOURNAL_KV) {
            ctx.waitUntil(notifyRelay(env))
        }
    }
}

const RELAY_CRAWL_URL = 'https://bsky.network/xrpc/com.atproto.sync.requestCrawl'
const RELAY_NOTIFY_THROTTLE_MS = 20 * 60 * 1000 // 20 min

/**
 * POST com.atproto.sync.requestCrawl to the relay so it crawls our repo.
 * Throttled via KV (last notification timestamp) to avoid spam.
 */
async function notifyRelay(env) {
    try {
        const now = Date.now()
        const last = parseInt(await env.JOURNAL_KV.get('relay-notify-ts')) || 0
        if (now - last < RELAY_NOTIFY_THROTTLE_MS) return

        const resp = await fetch(RELAY_CRAWL_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hostname: env.OWNER_HANDLE })
        })
        console.log(`[relay] requestCrawl for ${env.OWNER_HANDLE}: ${resp.status}`)
        if (resp.ok) {
            await env.JOURNAL_KV.put('relay-notify-ts', String(now))
        }
    } catch (e) {
        console.error('[relay] requestCrawl failed:', e.message)
    }
}
