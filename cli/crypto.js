/**
 * Cryptographic utilities for ATProto signing (CLI-only)
 * Uses @noble/secp256k1 for key operations (Node.js)
 * Shared CBOR/CID/encoding utilities imported from src/shared.js
 */

import { webcrypto } from 'node:crypto'
import { cborEncode, computeCID } from '../src/shared.js'

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
 * Generate a multibase-encoded public key (for DID documents)
 * Uses multicodec 0xe7 (secp256k1-pub) with base58btc
 */
export function publicKeyToMultibase(publicKeyHex) {
  const publicKeyBytes = hexToBytes(publicKeyHex)
  const prefixed = new Uint8Array([0xe7, 0x01, ...publicKeyBytes])
  return 'z' + base58Encode(prefixed)
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
