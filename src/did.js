/**
 * DID and identity handling for AT Protocol PDS
 */

import { isValidDID, isValidHandle } from './utils.js'

export { isValidDID as validateDid } from './utils.js'

/**
 * Generate .well-known/atproto-did response
 */
export function handleAtprotoDid(did) {
    return new Response(did, {
        headers: {
            'Content-Type': 'text/plain',
            'Cache-Control': 'public, max-age=300'
        }
    })
}

/**
 * Generate a did:web document for the host
 * @param {string} host - The hostname (e.g., "pds.example.com")
 * @param {string} handle - The handle (e.g., "alice.example.com") 
 * @param {string} publicKeyMultibase - The public key multibase string
 * @param {string} [did] - Override DID (defaults to did:web:{host})
 */
export function generateDidWebDocument(host, handle, publicKeyMultibase, did) {
    did = did || `did:web:${host}`

    return {
        '@context': [
            'https://www.w3.org/ns/did/v1',
            'https://w3id.org/security/multikey/multikey-v1.jsonld',
            'https://w3id.org/security/suites/secp256k1-2019/v1'
        ],
        id: did,
        alsoKnownAs: [`at://${handle}`],
        verificationMethod: [
            {
                id: `${did}#atproto`,
                type: 'Multikey',
                controller: did,
                publicKeyMultibase: publicKeyMultibase || 'zQ3shXjHeiBuRCKmM36cuYnm7YEMzhGnCmCyW92sRJ9pribSF'
            }
        ],
        service: [
            {
                id: '#atproto_pds',
                type: 'AtprotoPersonalDataServer',
                serviceEndpoint: `https://${host}`
            }
        ]
    }
}

/**
 * Handle /.well-known/did.json for the main did:web identity.
 * The document is a STATIC FILE (public/.well-known/did.json, written by
 * `node cli/seal.js init`) served from the ASSETS binding — no env var key
 * needed, and the same file backs the self-discovery path (identity.js).
 */
export async function handleDidJson(env) {
    if (env.ASSETS) {
        const resp = await env.ASSETS.fetch('https://worker/.well-known/did.json')
        if (resp.ok) {
            return new Response(resp.body, {
                headers: {
                    'Content-Type': 'application/did+ld+json',
                    'Cache-Control': 'public, max-age=300'
                }
            })
        }
    }
    return new Response(JSON.stringify({
        error: 'IdentityNotConfigured',
        message: '身份文件未部署：本地运行 `node cli/seal.js init` 生成 public/.well-known/did.json 后重新部署'
    }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
    })
}

/**
 * Resolve a handle to a DID
 * For self-hosted PDS, the handle should resolve to our own DID
 */
export async function resolveHandle(handle, ownerHandle, ownerDid) {
    // If it's our handle, return our DID
    if (handle === ownerHandle) {
        return ownerDid
    }

    // For external handles, try to resolve via DNS or HTTP.
    // First, try /.well-known/atproto-did on the handle's domain.
    // Guard against SSRF: only valid handle syntax, hard timeout, size cap.
    if (!isValidHandle(handle)) return null

    try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 5000)
        const url = `https://${handle}/.well-known/atproto-did`
        const resp = await fetch(url, {
            headers: { 'Accept': 'text/plain' },
            signal: controller.signal,
            cf: { cacheTtl: 300 } // Cache for 5 minutes
        })
        clearTimeout(timer)
        if (resp.ok) {
            const text = await resp.text()
            const did = text.trim().slice(0, 2048)
            if (did.startsWith('did:')) {
                return did
            }
        }
    } catch (e) {
        // Fall through to DNS resolution
    }

    // TODO: DNS TXT record resolution (_atproto.handle)

    return null
}


