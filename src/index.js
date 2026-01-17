/**
 * AT Protocol Personal Data Server - Cloudflare Worker
 * 
 * A minimal PDS implementation for self-hosting your AT Protocol identity.
 * 
 * Features:
 * - Personal posts stored in D1 database
 * - WebSocket firehose (subscribeRepos) via Durable Object
 * - Periodic interaction syncing from Bluesky
 * - Custom domain support for maximum independence
 */

import { Database } from './db.js'
import { Repo } from './repo.js'
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

        // CORS headers for API access
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        }

        // Handle CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders })
        }

        // Initialize database and repo
        const db = new Database(env.DB)
        const did = env.OWNER_DID || `did:web:${url.host}`
        const handle = env.OWNER_HANDLE || url.host
        const repo = new Repo(db, did)

        try {
            let response

            // Route requests
            if (path === '/.well-known/atproto-did') {
                // Handle verification for handle
                response = handleAtprotoDid(did)
            } else if (path === '/.well-known/did.json') {
                // Handle did:web resolution
                response = handleDidJson(url.host, handle)
            } else if (path.startsWith('/xrpc/')) {
                // Handle XRPC API calls
                response = await handleXrpc(request, { repo, db, did, handle, env })
            } else if (path === '/') {
                // Root - simple info page
                response = new Response(JSON.stringify({
                    name: 'atproto-worker',
                    description: 'Personal AT Protocol Data Server',
                    did,
                    handle,
                    endpoints: {
                        xrpc: '/xrpc/',
                        atprotoDid: '/.well-known/atproto-did',
                        didJson: '/.well-known/did.json'
                    }
                }, null, 2), {
                    headers: { 'Content-Type': 'application/json' }
                })
            } else {
                response = new Response('Not Found', { status: 404 })
            }

            // Add CORS headers to response
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
     * Handle scheduled cron triggers
     * Used for syncing interactions from Bluesky
     */
    async scheduled(controller, env, ctx) {
        console.log('Running scheduled sync...')

        const db = new Database(env.DB)
        const did = env.OWNER_DID
        const handle = env.OWNER_HANDLE

        if (!did) {
            console.log('OWNER_DID not configured, skipping sync')
            return
        }

        // Sync interactions from Bluesky
        ctx.waitUntil(syncInteractions(db, did, handle))
        ctx.waitUntil(syncFollowers(db, did))
    }
}
