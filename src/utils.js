/**
 * AT Protocol utilities - minimal, no external dependencies
 */

// TID: Timestamp Identifier (used as record keys)
// Format: 13 chars, base32-sortish encoding of timestamp + clock sequence
const B32_CHARSET = '234567abcdefghijklmnopqrstuvwxyz'

// Base32 lowercase charset (RFC 4648) - used for CID encoding
const B32_LOWER = 'abcdefghijklmnopqrstuvwxyz234567'
let lastTimestamp = 0
let clockSeq = 0

/**
 * Generate a TID (Timestamp Identifier)
 * TIDs are 13-character strings that are lexicographically sortable by time
 */
export function generateTID() {
  let timestamp = Date.now() * 1000 // microseconds

  if (timestamp === lastTimestamp) {
    clockSeq++
  } else {
    lastTimestamp = timestamp
    clockSeq = 0
  }

  // Combine timestamp with clock sequence
  const combined = BigInt(timestamp) << 10n | BigInt(clockSeq & 0x3ff)

  let tid = ''
  let n = combined
  for (let i = 0; i < 13; i++) {
    tid = B32_CHARSET[Number(n & 31n)] + tid
    n >>= 5n
  }

  return tid
}

/**
 * Parse an AT-URI: at://did/collection/rkey
 */
export function parseAtUri(uri) {
  if (!uri || !uri.startsWith('at://') || uri.length > 8192 || uri.endsWith('/') || uri.includes(' ')) return null

  // Check for fragments - allowed but not by our simple splitter logic usually
  const fragmentParts = uri.split('#')
  if (fragmentParts.length > 2) return null // Multiple #

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

  // Basic segment validation
  if (!repo || !isValidHandle(repo) && !/^did:[a-z]+:[a-zA-Z0-9._:%-]+$/.test(repo)) return null

  // Lexicon/NSID rules for collection
  if (parts.length > 1) {
    if (!isValidNsid(collection)) return null
  }

  if (parts.length > 2) {
    if (!isValidRecordKey(rkey)) return null
  }

  return { repo, collection, rkey }
}

const NSID_REGEX = /^[a-zA-Z](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?:\.[a-zA-Z](?:[a-zA-Z0-9]{0,62})?)$/

/**
 * Validate an NSID (official atproto implementation)
 */
export function isValidNsid(nsid) {
  if (!nsid || typeof nsid !== 'string') return false
  if (nsid.length > 317) return false
  return NSID_REGEX.test(nsid)
}

const RECORD_KEY_REGEX = /^[a-zA-Z0-9_~.:-]{1,512}$/
const RECORD_KEY_INVALID_VALUES = new Set(['.', '..'])

/**
 * Validate a record key (official atproto implementation)
 */
export function isValidRecordKey(rkey) {
  if (!rkey || typeof rkey !== 'string') return false
  if (rkey.length < 1 || rkey.length > 512) return false
  if (RECORD_KEY_INVALID_VALUES.has(rkey)) return false
  return RECORD_KEY_REGEX.test(rkey)
}

/**
 * Build an AT-URI from components
 */
export function buildAtUri(did, collection, rkey) {
  return `at://${did}/${collection}/${rkey}`
}

/**
 * Simple CID-like hash generation (not a real CID, but sufficient for our needs)
 * Uses SubtleCrypto for SHA-256
 */
export async function generateCID(data) {
  const encoder = new TextEncoder()
  const dataBytes = encoder.encode(JSON.stringify(data))
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBytes)
  const hashArray = new Uint8Array(hashBuffer)

  // Encode as base32 (similar to CID v1 format, simplified)
  return 'baf' + base32Encode(hashArray).slice(0, 56)
}

/**
 * Base32 encoding (RFC 4648, lowercase)
 */
function base32Encode(bytes) {
  let result = ''
  let bits = 0
  let value = 0

  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8

    while (bits >= 5) {
      bits -= 5
      result += B32_CHARSET[(value >> bits) & 31]
    }
  }

  if (bits > 0) {
    result += B32_CHARSET[(value << (5 - bits)) & 31]
  }

  return result
}

/**
 * Validate a handle format
 */
const HANDLE_REGEX = /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/

/**
 * Validate a handle format (official atproto implementation)
 */
export function isValidHandle(handle) {
  if (!handle || typeof handle !== 'string') return false
  if (handle.length > 253) return false
  return HANDLE_REGEX.test(handle)
}

/**
 * Validate a DID format (official atproto implementation)
 */
export function isValidDID(did) {
  if (!did || typeof did !== 'string') return false
  if (did.length > 2048) return false
  if (did.endsWith(':') || did.endsWith('%')) return false
  return /^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$/.test(did)
}

/**
 * Get current ISO datetime
 */
export function nowISO() {
  return new Date().toISOString()
}

/**
 * CBOR encoding - minimal implementation for AT Protocol
 * Only handles the subset needed: objects, arrays, strings, integers, bytes, null
 */
export function cborEncode(value) {
  const chunks = []

  function encode(val) {
    if (val === null || val === undefined) {
      chunks.push(new Uint8Array([0xf6])) // null
    } else if (typeof val === 'boolean') {
      chunks.push(new Uint8Array([val ? 0xf5 : 0xf4]))
    } else if (typeof val === 'number') {
      if (Number.isInteger(val)) {
        if (val >= 0) {
          encodeUint(0, val)
        } else {
          encodeUint(1, -1 - val)
        }
      } else {
        // Float64
        const buf = new ArrayBuffer(9)
        const view = new DataView(buf)
        view.setUint8(0, 0xfb)
        view.setFloat64(1, val, false)
        chunks.push(new Uint8Array(buf))
      }
    } else if (typeof val === 'string') {
      const bytes = new TextEncoder().encode(val)
      encodeUint(3, bytes.length)
      chunks.push(bytes)
    } else if (val instanceof Uint8Array) {
      encodeUint(2, val.length)
      chunks.push(val)
    } else if (Array.isArray(val)) {
      encodeUint(4, val.length)
      for (const item of val) encode(item)
    } else if (typeof val === 'object') {
      const keys = Object.keys(val).sort((a, b) => {
        if (a.length !== b.length) return a.length - b.length
        return a < b ? -1 : 1
      })
      encodeUint(5, keys.length)
      for (const key of keys) {
        encode(key)
        encode(val[key])
      }
    }
  }

  function encodeUint(major, n) {
    if (n < 24) {
      chunks.push(new Uint8Array([(major << 5) | n]))
    } else if (n < 256) {
      chunks.push(new Uint8Array([(major << 5) | 24, n]))
    } else if (n < 65536) {
      const buf = new Uint8Array(3)
      buf[0] = (major << 5) | 25
      buf[1] = n >> 8
      buf[2] = n & 0xff
      chunks.push(buf)
    } else if (n < 4294967296) {
      const buf = new Uint8Array(5)
      buf[0] = (major << 5) | 26
      new DataView(buf.buffer).setUint32(1, n, false)
      chunks.push(buf)
    } else {
      const buf = new Uint8Array(9)
      buf[0] = (major << 5) | 27
      new DataView(buf.buffer).setBigUint64(1, BigInt(n), false)
      chunks.push(buf)
    }
  }

  encode(value)

  // Concatenate all chunks
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }

  return result
}

/**
 * CBOR decoding - minimal implementation
 */
export function cborDecode(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    bytes = new Uint8Array(bytes)
  }

  let pos = 0

  function decode() {
    if (pos >= bytes.length) throw new Error('Unexpected end of CBOR data')

    const initial = bytes[pos++]
    const major = initial >> 5
    const additional = initial & 0x1f

    let value = readUint(additional)

    switch (major) {
      case 0: return value // unsigned int
      case 1: return -1 - value // negative int
      case 2: { // byte string
        const result = bytes.slice(pos, pos + value)
        pos += value
        return result
      }
      case 3: { // text string
        const result = new TextDecoder().decode(bytes.slice(pos, pos + value))
        pos += value
        return result
      }
      case 4: { // array
        const arr = []
        for (let i = 0; i < value; i++) arr.push(decode())
        return arr
      }
      case 5: { // map
        const obj = {}
        for (let i = 0; i < value; i++) {
          const key = decode()
          obj[key] = decode()
        }
        return obj
      }
      case 7: // simple/float
        if (additional === 20) return false
        if (additional === 21) return true
        if (additional === 22) return null
        if (additional === 23) return undefined
        if (additional === 25) { // float16 (not fully implemented)
          pos += 2
          return 0
        }
        if (additional === 26) { // float32
          const view = new DataView(bytes.buffer, bytes.byteOffset + pos, 4)
          pos += 4
          return view.getFloat32(0, false)
        }
        if (additional === 27) { // float64
          const view = new DataView(bytes.buffer, bytes.byteOffset + pos, 8)
          pos += 8
          return view.getFloat64(0, false)
        }
        throw new Error(`Unknown simple value: ${additional}`)
      default:
        throw new Error(`Unknown CBOR major type: ${major}`)
    }
  }

  function readUint(additional) {
    if (additional < 24) return additional
    if (additional === 24) return bytes[pos++]
    if (additional === 25) {
      const val = (bytes[pos] << 8) | bytes[pos + 1]
      pos += 2
      return val
    }
    if (additional === 26) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + pos, 4)
      pos += 4
      return view.getUint32(0, false)
    }
    if (additional === 27) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + pos, 8)
      pos += 8
      return Number(view.getBigUint64(0, false))
    }
    throw new Error(`Invalid additional value: ${additional}`)
  }

  return decode()
}

/**
 * Base32 lowercase encoding (RFC 4648) - for CID encoding
 */
function base32LowerEncode(bytes) {
  let result = ''
  let bits = 0
  let value = 0

  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8

    while (bits >= 5) {
      bits -= 5
      result += B32_LOWER[(value >> bits) & 31]
    }
  }

  if (bits > 0) {
    result += B32_LOWER[(value << (5 - bits)) & 31]
  }

  return result
}

/**
 * Compute CID v1 (dag-cbor, sha-256) for a value
 * Matches CLI implementation for journal chain validation
 */
export async function computeCID(value) {
  const cbor = cborEncode(value)
  const hash = await crypto.subtle.digest('SHA-256', cbor)

  // CID v1: version(1) + codec(dag-cbor=0x71) + hash-type(sha256=0x12) + hash-len(32) + hash
  const cid = new Uint8Array(2 + 2 + 32)
  cid[0] = 0x01 // CID version 1
  cid[1] = 0x71 // dag-cbor codec
  cid[2] = 0x12 // sha2-256 hash
  cid[3] = 0x20 // 32 bytes
  cid.set(new Uint8Array(hash), 4)

  // Encode as base32lower with 'b' prefix (multibase)
  return 'b' + base32LowerEncode(cid)
}
