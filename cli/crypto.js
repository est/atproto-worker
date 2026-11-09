/**
 * Cryptographic utilities for ATProto signing (CLI-only)
 * - k256 (secp256k1) via @noble/secp256k1
 * - p256 (secp256r1) via WebCrypto (src/keys.js)
 * Shared CBOR/CID/encoding utilities imported from src/shared.js
 */

import { webcrypto } from 'node:crypto'
import { cborEncode, computeCID } from '../src/shared.js'
import {
  generateP256Keypair,
  signP256 as signP256Raw,
  verifyP256 as verifyP256Raw,
  multikeyEncode,
  parseMultikey,
  compressP256Point
} from '../src/keys.js'

export { cborEncode, computeCID }

/**
 * Generate a new secp256k1 keypair
 * Returns { privateKey, publicKey } as hex strings
 */
export async function generateKeypair() {
  const privateKeyBytes = new Uint8Array(32)
  webcrypto.getRandomValues(privateKeyBytes)

  const secp = await import('@noble/secp256k1')
  const publicKeyBytes = secp.getPublicKey(privateKeyBytes, true) // compressed

  return {
    privateKey: bytesToHex(privateKeyBytes),
    publicKey: bytesToHex(publicKeyBytes)
  }
}

/**
 * Generate a new P-256 keypair.
 * Returns:
 *   curve: 'p256'
 *   privateKey: base64 PKCS#8 (what config.json stores)
 *   publicKey: compressed 33-byte hex
 *   publicKeyMultibase: zDna... Multikey
 */
export async function generateKeypairP256() {
  const kp = await generateP256Keypair({ extractable: true })
  return {
    curve: 'p256',
    privateKey: kp.privateKeyPkcs8,
    publicKey: kp.publicKeyCompressedHex,
    publicKeyMultibase: kp.publicKeyMultibase
  }
}

/**
 * Sign a message with secp256k1
 */
export async function sign(message, privateKeyHex) {
  const secp = await import('@noble/secp256k1')

  const messageBytes = typeof message === 'string'
    ? new TextEncoder().encode(message)
    : message
  const hash = await webcrypto.subtle.digest('SHA-256', messageBytes)

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
 * Sign a message with P-256 (WebCrypto ECDSA/SHA-256).
 * Accepts the src/keys order (privateKey, message) and, for consistency with
 * the k256 `sign`, the legacy CLI order (message, privateKey). `privateKey`
 * may be a base64 PKCS#8 string (config.json format), a JWK/JWK JSON string,
 * or a CryptoKey. Returns a 128-char hex low-S signature.
 */
export async function signP256(a, b) {
  if (isPrivateKeyInput(a)) return signP256Raw(a, b)
  if (isPrivateKeyInput(b)) return signP256Raw(b, a)
  throw new Error('signP256 requires a P-256 private key (PKCS#8 base64, JWK, or CryptoKey)')
}

/**
 * Verify a P-256 signature (64-byte compact + low-S + WebCrypto verify).
 * Supports (publicKey, message, signature) and (message, signature, publicKey).
 * `publicKey` may be a Multikey/did:key string, compressed/uncompressed hex,
 * or raw bytes.
 */
export async function verifyP256(a, b, c) {
  const aIsKey = isPublicKeyInput(a)
  const cIsKey = isPublicKeyInput(c)

  // Prefer the explicit (message, signature, publicKey) form when the third
  // argument is unambiguously a key; otherwise use src/keys order.
  if (cIsKey || !aIsKey) return verifyP256Raw(c, a, b)
  return verifyP256Raw(a, b, c)
}

/**
 * Heuristic: does this value look like a P-256 private key input?
 */
function isPrivateKeyInput(value) {
  if (value && typeof value === 'object') {
    return value.type === 'private' || value.kty === 'EC'
  }
  if (typeof value !== 'string') return false
  if (value.startsWith('{')) return true // JWK JSON
  // base64 PKCS#8 is long; avoid mistaking a short message for a key.
  return value.length >= 100 && /^[A-Za-z0-9+/=]+$/.test(value)
}

/**
 * Heuristic: does this value look like a P-256 public key input?
 */
function isPublicKeyInput(value) {
  if (value instanceof Uint8Array) return value.length === 33 || value.length === 65
  if (value && typeof value === 'object') {
    return value.type === 'public' || value.kty === 'EC'
  }
  if (typeof value !== 'string') return false
  if (value.startsWith('z') || value.startsWith('did:key:')) return true
  return value.length === 66 || value.length === 130 // compressed / uncompressed hex
}

/**
 * Generate a multibase-encoded public key (for DID documents)
 * Uses multicodec 0xe7 (secp256k1-pub) with base58btc by default; pass
 * curve='p256' for the 0x1200 (zDna...) encoding.
 * Backwards compatible with the old single-argument call.
 */
export function publicKeyToMultibase(publicKeyHex, curve = 'k256') {
  if (curve === 'p256') return publicKeyToMultibaseP256(publicKeyHex)
  if (curve !== 'k256') throw new Error(`Unsupported curve: ${curve}`)

  const publicKeyBytes = hexToBytes(publicKeyHex)
  const prefixed = new Uint8Array([0xe7, 0x01, ...publicKeyBytes])
  return 'z' + base58Encode(prefixed)
}

/**
 * Encode a P-256 public key as a Multikey (multicodec 0x1200 + compressed 33).
 * Accepts compressed/uncompressed hex or raw bytes.
 */
export function publicKeyToMultibaseP256(publicKey) {
  let bytes = typeof publicKey === 'string' ? hexToBytes(publicKey) : publicKey
  if (bytes.length === 65 && bytes[0] === 4) {
    bytes = compressP256Point(bytes)
  }
  if (bytes.length !== 33) {
    throw new Error('Expected a 33-byte compressed or 65-byte uncompressed P-256 public key')
  }
  return multikeyEncode('p256', bytes)
}

/**
 * Normalize a config/account key object. Configs written before curves were
 * introduced have no `curve` field and are k256.
 *
 * @returns {{curve: 'p256'|'k256', privateKey: string, publicKey: string,
 *   publicKeyMultibase: string}}
 */
export function normalizeKey(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('Missing key config')
  }

  const curve = config.curve || 'k256'
  if (curve !== 'p256' && curve !== 'k256') {
    throw new Error(`Unsupported curve: ${curve}`)
  }

  let privateKey = config.privateKey
  let publicKey = config.publicKey
  let publicKeyMultibase = config.publicKeyMultibase

  if (curve === 'p256') {
    // Accept an uncompressed public key and normalize to compressed hex.
    if (publicKey && publicKey.length === 130) {
      publicKey = bytesToHex(compressP256Point(hexToBytes(publicKey)))
    }
    // Derive whichever representation is missing.
    if (!publicKey && publicKeyMultibase) {
      const parsed = parseMultikey(publicKeyMultibase)
      if (parsed.curve !== 'p256') throw new Error('Not a P-256 Multikey')
      publicKey = bytesToHex(parsed.compressed)
    }
    if (!publicKeyMultibase && publicKey) {
      publicKeyMultibase = publicKeyToMultibaseP256(publicKey)
    }
  } else {
    if (!publicKey && publicKeyMultibase) {
      const parsed = parseMultikey(publicKeyMultibase)
      if (parsed.curve !== 'k256') throw new Error('Not a K-256 Multikey')
      publicKey = bytesToHex(parsed.compressed)
    }
    if (!publicKeyMultibase && publicKey) {
      publicKeyMultibase = publicKeyToMultibase(publicKey)
    }
  }

  return { curve, privateKey, publicKey, publicKeyMultibase }
}

// ============ Hex helpers ============

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

// ============ Base58 (Bitcoin alphabet) ============

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58Encode(bytes) {
  let num = 0n
  for (const byte of bytes) {
    num = num * 256n + BigInt(byte)
  }

  let result = ''
  while (num > 0n) {
    const remainder = num % 58n
    num = num / 58n
    result = B58_ALPHABET[Number(remainder)] + result
  }

  for (const byte of bytes) {
    if (byte === 0) {
      result = '1' + result
    } else {
      break
    }
  }

  return result
}
