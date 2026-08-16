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
export { broadcastNewEvents }

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

            // Refresh endpoint - sync journal from HTTP source.
            // Optional shared-secret gate: if REFRESH_TOKEN is set, require
            // `Authorization: Bearer <token>` — otherwise anyone can burn
            // worker quota by hammering this endpoint.
            if (path === '/refresh') {
                if (env.REFRESH_TOKEN && request.headers.get('Authorization') !== `Bearer ${env.REFRESH_TOKEN}`) {
                    response = new Response(JSON.stringify({
                        error: 'Unauthorized',
                        message: 'Missing or invalid refresh token'
                    }), { status: 401, headers: { 'Content-Type': 'application/json' } })
                } else {
                    await journal.refresh()
                    const newEvents = await broadcastNewEvents(journal, env)

                    // Publishing is the moment the relay should re-crawl us
                    // (like the reference PDS Crawlers.notifyOfUpdate).
                    // No throttle needed: /refresh is human-triggered, rare.
                    ctx.waitUntil(notifyRelay(env))

                    response = new Response(JSON.stringify({
                        ok: true,
                        message: `Journal refreshed, ${newEvents.length} new events broadcasted`,
                        eventCount: journal.events.length
                    }), {
                        headers: { 'Content-Type': 'application/json' }
                    })
                }
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
                await journal.refresh()
                await broadcastNewEvents(journal, env)
            } catch (e) {
                console.error('Journal refresh failed:', e)
            }
        }

        // Sync interactions (log-only, see ADR-015): fetch like/repost
        // counts from the bsky public API and log them. Results are not
        // persisted anywhere — no KV, no journal.
        ctx.waitUntil(syncInteractions(journal, did, handle))
    }
}

const RELAY_CRAWL_URL = 'https://bsky.network/xrpc/com.atproto.sync.requestCrawl'

/**
 * Broadcast journal events past the last-broadcast offset to connected
 * firehose subscribers. The cursor lives in the Firehose DO's storage — the
 * worker itself is stateless (no KV, no database). The DO advances it only
 * after a successful broadcast, monotonically, so concurrent refreshes can't
 * drop or regress events.
 * @returns {Promise<Array>} the events that were broadcast
 */
async function broadcastNewEvents(journal, env) {
    if (!env.FIREHOSE) return []

    const id = env.FIREHOSE.idFromName('main')
    const stub = env.FIREHOSE.get(id)

    const cursorResp = await stub.fetch('http://localhost/cursor')
    if (!cursorResp.ok) {
        console.error('[firehose] cursor read failed, skipping broadcast')
        return []
    }
    const { cursor = -1 } = await cursorResp.json()

    const newEvents = journal.events.filter(e => e.offset > cursor)
    if (newEvents.length === 0) return []

    const resp = await stub.fetch('http://localhost/broadcast', {
        method: 'POST',
        body: JSON.stringify({ events: newEvents }),
        headers: { 'Content-Type': 'application/json' }
    })
    if (!resp.ok) {
        console.error(`[firehose] broadcast failed (${resp.status}), cursor not advanced`)
        return []
    }
    return newEvents
}

/**
 * POST com.atproto.sync.requestCrawl to the relay so it crawls our repo.
 * Called on publish (/refresh), not on a timer — no throttle needed.
 */
async function notifyRelay(env) {
    if (!env.OWNER_HANDLE) return
    try {
        const resp = await fetch(RELAY_CRAWL_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hostname: env.OWNER_HANDLE })
        })
        console.log(`[relay] requestCrawl for ${env.OWNER_HANDLE}: ${resp.status}`)
    } catch (e) {
        console.error('[relay] requestCrawl failed:', e.message)
    }
}
