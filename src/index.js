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
            // worker/KV quota by hammering this endpoint.
            if (path === '/refresh') {
                if (env.REFRESH_TOKEN && request.headers.get('Authorization') !== `Bearer ${env.REFRESH_TOKEN}`) {
                    response = new Response(JSON.stringify({
                        error: 'Unauthorized',
                        message: 'Missing or invalid refresh token'
                    }), { status: 401, headers: { 'Content-Type': 'application/json' } })
                } else {
                    await journal.refresh()
                    const newEvents = await broadcastNewEvents(journal, env, ctx)

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
                await broadcastNewEvents(journal, env, ctx)
            } catch (e) {
                console.error('Journal refresh failed:', e)
            }
        }

        // Sync interactions (these go to separate KV, not journal)
        // Sync interactions (these go to separate KV, not journal).
        // Throttled to every 6h: each run makes up to 40 external bsky
        // fetches whose results are only logged (see ADR-015), so running
        // them every 15 min is wasted work and quota.
        if (env.JOURNAL_KV) {
            const lastInteractions = parseInt(await env.JOURNAL_KV.get('interactions-last')) || 0
            if (Date.now() - lastInteractions >= INTERACTIONS_THROTTLE_MS) {
                ctx.waitUntil(syncInteractions(journal, did, handle).then(
                    () => env.JOURNAL_KV.put('interactions-last', String(Date.now())),
                    () => {}
                ))
            }
        }

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
const INTERACTIONS_THROTTLE_MS = 6 * 60 * 60 * 1000 // 6 h
const FIREHOSE_CURSOR_KEY = 'firehose-cursor'

/**
 * Broadcast journal events past the last-broadcast offset to connected
 * firehose subscribers. The cursor is persisted in KV so it survives across
 * requests — the journal is a static asset, so a CID-diff between load() and
 * refresh() (both reading the same ASSETS) would never detect new events.
 *
 * The cursor advances ONLY after the DO broadcast succeeds, and never
 * backwards (monotonic max) so concurrent refreshes can't drop or regress it.
 * @returns {Promise<Array>} the events that were broadcast
 */
async function broadcastNewEvents(journal, env, ctx) {
    if (!env.FIREHOSE || !env.JOURNAL_KV) return []

    const lastOffset = parseInt(await env.JOURNAL_KV.get(FIREHOSE_CURSOR_KEY)) || -1
    const newEvents = journal.events.filter(e => e.offset > lastOffset)
    if (newEvents.length === 0) return []

    const id = env.FIREHOSE.idFromName('main')
    const stub = env.FIREHOSE.get(id)
    const resp = await stub.fetch('http://localhost/broadcast', {
        method: 'POST',
        body: JSON.stringify({ events: newEvents }),
        headers: { 'Content-Type': 'application/json' }
    })
    if (!resp.ok) {
        console.error(`[firehose] broadcast failed (${resp.status}), cursor not advanced`)
        return []
    }

    const nextCursor = Math.max(lastOffset, newEvents[newEvents.length - 1].offset)
    await env.JOURNAL_KV.put(FIREHOSE_CURSOR_KEY, String(nextCursor))
    return newEvents
}

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
