/**
 * Cryptographic utilities for ATProto signing
 * Uses Web Crypto API (works in Node.js 19+ and Cloudflare Workers)
 * 
 * For local CLI, we use @noble/secp256k1 for secp256k1 operations
 * since Web Crypto doesn't directly support secp256k1
 */

import { webcrypto } from 'node:crypto'

// Base32 charset for encoding
const B32_CHARSET = 'abcdefghijklmnopqrstuvwxyz234567'

/**
 * Generate a new secp256k1 keypair
 * Returns { privateKey, publicKey } as hex strings
 */
export async function generateKeypair() {
  // Generate 32 random bytes for private key
  const privateKeyBytes = new Uint8Array(32)
  webcrypto.getRandomValues(privateKeyBytes)

  // Import @noble/secp256k1 dynamically (installed as dev dependency)
  const secp = await import('@noble/secp256k1')

  // Derive public key
  const publicKeyBytes = secp.getPublicKey(privateKeyBytes, true) // compressed

  return {
    privateKey: bytesToHex(privateKeyBytes),
    publicKey: bytesToHex(publicKeyBytes)
  }
}

/**
 * Sign a message with secp256k1
 */
export async function sign(message, privateKeyHex) {
  const secp = await import('@noble/secp256k1')

  // Hash the message with SHA-256
  const messageBytes = typeof message === 'string'
    ? new TextEncoder().encode(message)
    : message
  const hash = await webcrypto.subtle.digest('SHA-256', messageBytes)

  // Sign the hash
  const privateKey = hexToBytes(privateKeyHex)
  const signature = await secp.signAsync(new Uint8Array(hash), privateKey)

  return bytesToHex(signature.toCompactRawBytes())
}

/**
 * Verify a signature
 */
export async function verify(message, signatureHex, publicKeyHex) {
  const secp = await import('@noble/secp256k1')

  const messageBytes = typeof message === 'string'
    ? new TextEncoder().encode(message)
    : message
  const hash = await webcrypto.subtle.digest('SHA-256', messageBytes)

  const signature = hexToBytes(signatureHex)
  const publicKey = hexToBytes(publicKeyHex)

  return secp.verify(signature, new Uint8Array(hash), publicKey)
}

/**
 * Generate a multibase-encoded public key (for DID documents)
 * Uses multicodec 0xe7 (secp256k1-pub) with base58btc
 */
export function publicKeyToMultibase(publicKeyHex) {
  const publicKeyBytes = hexToBytes(publicKeyHex)
  // Multicodec prefix for secp256k1-pub: 0xe7 0x01
  const prefixed = new Uint8Array([0xe7, 0x01, ...publicKeyBytes])
  // Base58btc encode with 'z' prefix
  return 'z' + base58Encode(prefixed)
}

/**
 * CBOR encode a value (minimal implementation for commits)
 */
export function cborEncode(value) {
  const chunks = []

  function encode(val) {
    if (val === null || val === undefined) {
      chunks.push(new Uint8Array([0xf6]))
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
      // Check for CID tag
      if (val.$link) {
        // CBOR tag 42 for CID
        chunks.push(new Uint8Array([0xd8, 0x2a]))
        // CID bytes with 0x00 prefix (raw multibase)
        const cidBytes = cidToBytes(val.$link)
        encodeUint(2, cidBytes.length + 1)
        chunks.push(new Uint8Array([0x00]))
        chunks.push(cidBytes)
      } else {
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
 * Compute CID v1 (dag-cbor, sha-256) for a value
 */
export async function computeCID(value) {
  const cbor = cborEncode(value)
  const hash = await webcrypto.subtle.digest('SHA-256', cbor)

  // CID v1: version(1) + codec(dag-cbor=0x71) + hash-type(sha256=0x12) + hash-len(32) + hash
  const cid = new Uint8Array(2 + 2 + 32)
  cid[0] = 0x01 // CID version 1
  cid[1] = 0x71 // dag-cbor codec
  cid[2] = 0x12 // sha2-256 hash
  cid[3] = 0x20 // 32 bytes
  cid.set(new Uint8Array(hash), 4)

  // Encode as base32lower with 'b' prefix (multibase)
  return 'b' + base32Encode(cid)
}

/**
 * Convert CID string to bytes (for CBOR encoding)
 */
function cidToBytes(cidStr) {
  if (cidStr.startsWith('b')) {
    return base32Decode(cidStr.slice(1))
  }
  throw new Error('Unsupported CID format: ' + cidStr)
}

// ============ Encoding helpers ============

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
  }
  return bytes
}

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

function base32Decode(str) {
  const result = []
  let bits = 0
  let value = 0

  for (const char of str.toLowerCase()) {
    const idx = B32_CHARSET.indexOf(char)
    if (idx === -1) continue

    value = (value << 5) | idx
    bits += 5

    if (bits >= 8) {
      bits -= 8
      result.push((value >> bits) & 0xff)
    }
  }

  return new Uint8Array(result)
}

// Base58 alphabet (Bitcoin)
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58Encode(bytes) {
  // Convert bytes to big integer
  let num = 0n
  for (const byte of bytes) {
    num = num * 256n + BigInt(byte)
  }

  // Convert to base58
  let result = ''
  while (num > 0n) {
    const remainder = num % 58n
    num = num / 58n
    result = B58_ALPHABET[Number(remainder)] + result
  }

  // Handle leading zeros
  for (const byte of bytes) {
    if (byte === 0) {
      result = '1' + result
    } else {
      break
    }
  }

  return result
}
