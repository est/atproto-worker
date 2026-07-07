/**
 * AT Protocol utilities for the Worker
 * Re-exports from shared + Worker-specific helpers
 */

export {
  generateTID,
  base32Encode,
  base32Decode,
  cidToBytes,
  computeCID,
  cborEncode,
  cborDecode,
  encodeVarint,
  createCarFile
} from './shared.js'

// TID: Timestamp Identifier (used as record keys)
// Format: 13 chars, base32-sortish encoding of timestamp + clock sequence

/**
 * Parse an AT-URI: at://did/collection/rkey
 */
export function parseAtUri(uri) {
  if (!uri || !uri.startsWith('at://') || uri.length > 8192 || uri.endsWith('/') || uri.includes(' ')) return null

  const fragmentParts = uri.split('#')
  if (fragmentParts.length > 2) return null

  let base = uri
  if (fragmentParts.length === 2) {
    const fragment = fragmentParts[1]
    if (!fragment || fragment.includes('/')) return null
    base = fragmentParts[0]
  }

  const parts = base.slice(5).split('/')
  if (parts.length < 1 || parts.length > 3) return null

  const repo = parts[0]
  const collection = parts[1] || null
  const rkey = parts[2] || null

  if (!repo || !isValidHandle(repo) && !/^did:[a-z]+:[a-zA-Z0-9._:%-]+$/.test(repo)) return null

  if (parts.length > 1) {
    if (!isValidNsid(collection)) return null
  }

  if (parts.length > 2) {
    if (!isValidRecordKey(rkey)) return null
  }

  return { repo, collection, rkey }
}

const NSID_REGEX = /^[a-zA-Z](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?:\.[a-zA-Z](?:[a-zA-Z0-9]{0,62})?)$/

export function isValidNsid(nsid) {
  if (!nsid || typeof nsid !== 'string') return false
  if (nsid.length > 317) return false
  return NSID_REGEX.test(nsid)
}

const RECORD_KEY_REGEX = /^[a-zA-Z0-9_~.:-]{1,512}$/
const RECORD_KEY_INVALID_VALUES = new Set(['.', '..'])

export function isValidRecordKey(rkey) {
  if (!rkey || typeof rkey !== 'string') return false
  if (rkey.length < 1 || rkey.length > 512) return false
  if (RECORD_KEY_INVALID_VALUES.has(rkey)) return false
  return RECORD_KEY_REGEX.test(rkey)
}

export function buildAtUri(did, collection, rkey) {
  return `at://${did}/${collection}/${rkey}`
}

const HANDLE_REGEX = /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/

export function isValidHandle(handle) {
  if (!handle || typeof handle !== 'string') return false
  if (handle.length > 253) return false
  return HANDLE_REGEX.test(handle)
}

/**
 * Validate a DID format
 */
export function isValidDID(did) {
  if (!did || typeof did !== 'string') return false
  if (did.length > 2048) return false
  if (did.endsWith(':') || did.endsWith('%')) return false
  return /^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$/.test(did)
}

export function nowISO() {
  return new Date().toISOString()
}
