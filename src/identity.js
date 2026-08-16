/**
 * Identity self-discovery.
 *
 * Every hosted account is discoverable from the journal: each event line
 * carries its did, and did:web accounts are `did:web:<handle>`. Their
 * public key comes from the account's own well-known document:
 *   https://<handle>/.well-known/did.json
 *
 * Own-host DIDs (did:web:<this worker's host>) can't be fetched over the
 * network (the edge blocks loopback to the worker's own domain), so the
 * static identity file is read from the ASSETS binding instead — the file
 * is written by `node cli/seal.js init` and deployed with the worker.
 * External accounts are fetched and cached with the Cache API.
 */

const WELL_KNOWN_CACHE_SECONDS = 300

/**
 * Extract the hostname from a did:web DID, or null.
 */
export function handleFromDid(did) {
    return did && did.startsWith('did:web:') ? did.slice('did:web:'.length) : null
}

/**
 * Extract the #atproto verification key from a DID document.
 */
export function keyFromDidDoc(doc) {
    const vms = (doc && doc.verificationMethod) || []
    const vm = vms.find(v => v.id && v.id.endsWith('#atproto')) || vms[0]
    return (vm && (vm.publicKeyMultibase || vm.publicKeyBase58)) || null
}

/**
 * Resolve the identity of a did:web account.
 * @param {object} env - worker env (ASSETS binding)
 * @param {string} did - did:web:...
 * @param {string} ownHost - this worker's own host (main account)
 * @returns {Promise<{handle: string, publicKeyMultibase: string|null}|null>}
 */
export async function resolveIdentity(env, did, ownHost) {
    const handle = handleFromDid(did)
    if (!handle) return null

    if (ownHost && handle === ownHost) {
        // Own host: loopback fetch is blocked at the edge — read the static
        // identity file from ASSETS instead.
        const doc = await readOwnDidDoc(env)
        return doc ? { handle, publicKeyMultibase: keyFromDidDoc(doc) } : null
    }

    // External account: fetch its well-known did.json, cached via Cache API.
    const url = `https://${handle}/.well-known/did.json`
    let resp = null
    try {
        resp = await cachedFetch(url)
    } catch (e) {
        return null
    }
    if (!resp || !resp.ok) return null

    try {
        const doc = await resp.json()
        return { handle, publicKeyMultibase: keyFromDidDoc(doc) }
    } catch (e) {
        return null
    }
}

async function readOwnDidDoc(env) {
    if (!env.ASSETS) return null
    const resp = await env.ASSETS.fetch('https://worker/.well-known/did.json')
    if (!resp.ok) return null
    try {
        return await resp.json()
    } catch (e) {
        return null
    }
}

async function cachedFetch(url) {
    const cache = typeof caches !== 'undefined' ? caches.default : null
    if (cache) {
        const hit = await cache.match(url)
        if (hit) return hit
    }
    const resp = await fetch(url, { headers: { 'Accept': 'application/did+ld+json' } })
    if (cache && resp.ok) {
        // Clone with explicit cache headers (the Cache API honors them)
        const cached = new Response(resp.clone().body, {
            headers: {
                'Content-Type': 'application/did+ld+json',
                'Cache-Control': `public, max-age=${WELL_KNOWN_CACHE_SECONDS}`
            }
        })
        try {
            await cache.put(url, cached)
        } catch (e) {
            // cache full / eviction — non-fatal
        }
    }
    return resp
}
