/**
 * DID and identity handling for AT Protocol PDS
 */

/**
 * Generate .well-known/atproto-did response
 */
export function handleAtprotoDid(did) {
    return new Response(did, {
        headers: { 'Content-Type': 'text/plain' }
    })
}

/**
 * Generate a did:web document for the host
 * @param {string} host - The hostname (e.g., "pds.example.com")
 * @param {string} handle - The handle (e.g., "alice.example.com") 
 */
export function generateDidWebDocument(host, handle) {
    const did = `did:web:${host}`

    return {
        '@context': [
            'https://www.w3.org/ns/did/v1',
            'https://w3id.org/security/multikey/v1',
            'https://w3id.org/security/suites/secp256k1-2019/v1'
        ],
        id: did,
        alsoKnownAs: [`at://${handle}`],
        verificationMethod: [
            {
                id: `${did}#atproto`,
                type: 'Multikey',
                controller: did,
                // Placeholder - in production, this would be a real public key
                publicKeyMultibase: 'zQ3shXjHeiBuRCKmM36cuYnm7YEMzhGnCmCyW92sRJ9pribSF'
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
 * Handle /.well-known/did.json for did:web
 */
export function handleDidJson(host, handle) {
    const doc = generateDidWebDocument(host, handle)
    return new Response(JSON.stringify(doc, null, 2), {
        headers: { 'Content-Type': 'application/did+ld+json' }
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

    // For external handles, try to resolve via DNS or HTTP
    // First, try /.well-known/atproto-did on the handle's domain
    try {
        const url = `https://${handle}/.well-known/atproto-did`
        const resp = await fetch(url, {
            headers: { 'Accept': 'text/plain' },
            cf: { cacheTtl: 300 } // Cache for 5 minutes
        })
        if (resp.ok) {
            const did = (await resp.text()).trim()
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

/**
 * Validate that a DID matches expected format
 */
export function validateDid(did) {
    if (!did || typeof did !== 'string') return false

    // did:plc or did:web format
    if (did.startsWith('did:plc:')) {
        return /^did:plc:[a-z2-7]{24}$/.test(did)
    }
    if (did.startsWith('did:web:')) {
        return /^did:web:[a-zA-Z0-9._:%-]+$/.test(did)
    }

    return false
}
