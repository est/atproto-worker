/**
 * P-256 (secp256r1) key/signature/multikey helpers.
 *
 * Browser / Worker / Node 22+ safe: uses only WebCrypto and BigInt.
 * K-256 (secp256k1) stays in the CLI (needs @noble/secp256k1); this module
 * handles the curve we want to use for owner-signed browser writes.
 *
 * atproto rules implemented here:
 * - signature is 64 raw bytes r||s, low-S, never DER
 * - public key in DID docs is a Multikey: base58btc(0x1200 || compressed33)
 * - P-256 multicodec 0x1200 = varint bytes [0x80, 0x24]
 */

import { bytesToBase64, base64ToBytes, bytesToHex, hexToBytes } from './shared.js'

export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
export const P256_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn
const P256_A = P256_P - 3n
const P256_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn

const P256_PREFIX = new Uint8Array([0x80, 0x24]) // multicodec 0x1200
const K256_PREFIX = new Uint8Array([0xe7, 0x01]) // multicodec 0xe7

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

// ============ Bytes / BigInt ============

export function bigIntToBytes(n, length = 32) {
  const out = new Uint8Array(length)
  let v = n
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  if (v !== 0n) throw new Error('BigInt does not fit in ' + length + ' bytes')
  return out
}

export function bytesToBigInt(bytes) {
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  return n
}

function mod(a, m) {
  const r = a % m
  return r >= 0n ? r : r + m
}

function modPow(base, exp, m) {
  let result = 1n
  let b = mod(base, m)
  let e = exp
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m
    b = (b * b) % m
    e >>= 1n
  }
  return result
}

// ============ Base58btc ============

export function base58Encode(bytes) {
  let num = 0n
  for (const byte of bytes) num = num * 256n + BigInt(byte)

  let result = ''
  while (num > 0n) {
    result = B58_ALPHABET[Number(num % 58n)] + result
    num /= 58n
  }

  for (const byte of bytes) {
    if (byte !== 0) break
    result = '1' + result
  }
  return result
}

export function base58Decode(str) {
  let num = 0n
  for (const ch of str) {
    const idx = B58_ALPHABET.indexOf(ch)
    if (idx === -1) throw new Error('Invalid base58 character: ' + ch)
    num = num * 58n + BigInt(idx)
  }

  const bytes = []
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn))
    num >>= 8n
  }
  for (const ch of str) {
    if (ch !== '1') break
    bytes.unshift(0)
  }
  return new Uint8Array(bytes)
}

// ============ P-256 point encoding ============

export function compressP256Point(uncompressed) {
  if (!(uncompressed instanceof Uint8Array) || uncompressed.length !== 65 || uncompressed[0] !== 4) {
    throw new Error('Expected 65-byte uncompressed P-256 point')
  }
  const out = new Uint8Array(33)
  out[0] = 2 + (uncompressed[64] & 1)
  out.set(uncompressed.slice(1, 33), 1)
  return out
}

export function decompressP256Point(compressed) {
  if (!(compressed instanceof Uint8Array) || compressed.length !== 33) {
    throw new Error('Expected 33-byte compressed P-256 point')
  }
  if (compressed[0] !== 2 && compressed[0] !== 3) {
    throw new Error('Invalid compressed P-256 point prefix')
  }

  const x = bytesToBigInt(compressed.slice(1))
  if (x >= P256_P) throw new Error('P-256 x coordinate out of range')

  // y^2 = x^3 + ax + b (mod p); p === 3 (mod 4)
  const y2 = mod(x * x * x + P256_A * x + P256_B, P256_P)
  let y = modPow(y2, (P256_P + 1n) / 4n, P256_P)

  if (mod(y * y - y2, P256_P) !== 0n) {
    throw new Error('P-256 point is not on the curve')
  }
  if ((y & 1n) !== BigInt(compressed[0] & 1)) y = P256_P - y

  const out = new Uint8Array(65)
  out[0] = 4
  out.set(compressed.slice(1), 1)
  out.set(bigIntToBytes(y, 32), 33)
  return out
}

// ============ Multikey ============

export function multikeyEncode(curve, compressed33) {
  if (!(compressed33 instanceof Uint8Array) || compressed33.length !== 33) {
    throw new Error('Expected 33-byte compressed public key')
  }
  const prefix = curve === 'p256' ? P256_PREFIX : curve === 'k256' ? K256_PREFIX : null
  if (!prefix) throw new Error('Unsupported curve: ' + curve)

  const bytes = new Uint8Array(prefix.length + compressed33.length)
  bytes.set(prefix, 0)
  bytes.set(compressed33, prefix.length)
  return 'z' + base58Encode(bytes)
}

/**
 * Parse a multibase public key. Accepts the prefixed Multikey form (what we
 * publish) and, for interop fixtures, a bare compressed key if `hintCurve`
 * is supplied.
 */
export function parseMultikey(multibase, hintCurve) {
  if (typeof multibase !== 'string' || !multibase.startsWith('z')) {
    throw new Error('Expected z-prefixed base58btc multikey')
  }
  const bytes = base58Decode(multibase.slice(1))

  if (bytes[0] === 0x80 && bytes[1] === 0x24) {
    return { curve: 'p256', compressed: bytes.slice(2), multibase }
  }
  if (bytes[0] === 0xe7 && bytes[1] === 0x01) {
    return { curve: 'k256', compressed: bytes.slice(2), multibase }
  }
  if (hintCurve && bytes.length === 33) {
    return { curve: hintCurve, compressed: bytes, multibase }
  }
  throw new Error('Unsupported multikey prefix')
}

export function multikeyToDidKey(multibase) {
  return 'did:key:' + multibase
}

// ============ Low-S ============

export function isLowS(signature64) {
  if (!(signature64 instanceof Uint8Array) || signature64.length !== 64) return false
  return bytesToBigInt(signature64.slice(32)) <= P256_N / 2n
}

export function normalizeLowS(signature64) {
  if (!(signature64 instanceof Uint8Array) || signature64.length !== 64) {
    throw new Error('Expected 64-byte compact ECDSA signature')
  }
  const s = bytesToBigInt(signature64.slice(32))
  if (s <= P256_N / 2n) return signature64

  const out = new Uint8Array(signature64)
  out.set(bigIntToBytes(P256_N - s, 32), 32)
  return out
}

// ============ P-256 keys ============

function base64UrlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/')
  return base64ToBytes(b64)
}

/**
 * Generate a P-256 keypair.
 * @param {{extractable?: boolean}} opts
 * @returns {Promise<{privateKey: CryptoKey, publicKey: CryptoKey, publicKeyJwk: object,
 *   privateKeyJwk?: object, privateKeyPkcs8?: string, publicKeyUncompressedHex: string,
 *   publicKeyCompressedHex: string, publicKeyMultibase: string, didKey: string}>}
 */
export async function generateP256Keypair({ extractable = true } = {}) {
  const keypair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    extractable,
    ['sign', 'verify']
  )

  const publicKeyJwk = await crypto.subtle.exportKey('jwk', keypair.publicKey)
  const x = base64UrlToBytes(publicKeyJwk.x)
  const y = base64UrlToBytes(publicKeyJwk.y)
  if (x.length !== 32 || y.length !== 32) throw new Error('Unexpected P-256 coordinate length')

  const uncompressed = new Uint8Array(65)
  uncompressed[0] = 4
  uncompressed.set(x, 1)
  uncompressed.set(y, 33)

  const compressed = compressP256Point(uncompressed)
  const multikey = multikeyEncode('p256', compressed)

  const result = {
    privateKey: keypair.privateKey,
    publicKey: keypair.publicKey,
    publicKeyJwk,
    publicKeyUncompressedHex: bytesToHex(uncompressed),
    publicKeyCompressedHex: bytesToHex(compressed),
    publicKeyMultibase: multikey,
    didKey: multikeyToDidKey(multikey)
  }

  if (extractable) {
    result.privateKeyJwk = await crypto.subtle.exportKey('jwk', keypair.privateKey)
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', keypair.privateKey)
    result.privateKeyPkcs8 = bytesToBase64(new Uint8Array(pkcs8))
  }

  return result
}

/**
 * Import a P-256 signing key. Accepts a CryptoKey, a private JWK object, a JWK
 * JSON string, or a base64 PKCS#8 string (what the CLI stores).
 */
export async function importP256PrivateKey(input) {
  if (input && input.type === 'private' && input.algorithm?.name === 'ECDSA') return input

  if (input && typeof input === 'object' && input.kty === 'EC') {
    return crypto.subtle.importKey('jwk', input, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
  }

  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (trimmed.startsWith('{')) {
      return crypto.subtle.importKey('jwk', JSON.parse(trimmed), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
    }
    return crypto.subtle.importKey('pkcs8', base64ToBytes(trimmed), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
  }

  throw new Error('Unsupported P-256 private key input')
}

/**
 * Import a P-256 verification key. Accepts a CryptoKey, a public JWK, a
 * multikey string, a did:key string, a 33-byte compressed point, a 65-byte
 * uncompressed point, or hex strings of either.
 */
export async function importP256PublicKey(input) {
  if (input && input.type === 'public' && input.algorithm?.name === 'ECDSA') return input

  if (input && typeof input === 'object' && input.kty === 'EC' && !(input instanceof Uint8Array)) {
    return crypto.subtle.importKey('jwk', input, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  }

  let raw
  if (typeof input === 'string') {
    const value = input.startsWith('did:key:') ? input.slice('did:key:'.length) : input
    if (value.startsWith('z')) {
      const parsed = parseMultikey(value, 'p256')
      if (parsed.curve !== 'p256') throw new Error('Not a P-256 key')
      raw = decompressP256Point(parsed.compressed)
    } else if (value.length === 66) {
      raw = decompressP256Point(hexToBytes(value))
    } else if (value.length === 130) {
      raw = hexToBytes(value)
    } else {
      throw new Error('Unrecognized P-256 public key string')
    }
  } else if (input instanceof Uint8Array) {
    raw = input.length === 33 ? decompressP256Point(input) : input
  } else {
    throw new Error('Unsupported P-256 public key input')
  }

  if (!(raw instanceof Uint8Array) || raw.length !== 65 || raw[0] !== 4) {
    throw new Error('Expected 65-byte uncompressed P-256 public key')
  }
  return crypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
}

/**
 * Sign bytes with P-256/ECDSA/SHA-256. WebCrypto hashes internally, so pass
 * the raw atproto preimage (canonical commit CBOR), not a pre-hash.
 * Returns a 128-char hex string (64-byte low-S r||s).
 */
export async function signP256(privateKeyInput, message) {
  const key = await importP256PrivateKey(privateKeyInput)
  const data = typeof message === 'string' ? new TextEncoder().encode(message) : message
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data))
  if (signature.length !== 64) {
    throw new Error('Unexpected ECDSA signature length: ' + signature.length)
  }
  return bytesToHex(normalizeLowS(signature))
}

/**
 * Strict atproto verification: 64-byte compact + low-S + WebCrypto verify.
 * WebCrypto alone accepts high-S, so never use it directly for atproto.
 */
export async function verifyP256(publicKeyInput, message, signatureInput) {
  const signature = typeof signatureInput === 'string' ? hexToBytes(signatureInput) : new Uint8Array(signatureInput)
  if (signature.length !== 64) return false
  if (!isLowS(signature)) return false

  let key
  try {
    key = await importP256PublicKey(publicKeyInput)
  } catch {
    return false
  }

  const data = typeof message === 'string' ? new TextEncoder().encode(message) : message
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, data)
}
