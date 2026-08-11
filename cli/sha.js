/**
 * SHA-256 helper (CLI-side, Node.js webcrypto)
 */

import { webcrypto } from 'node:crypto'

export async function sha256(input) {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input
  const hash = await webcrypto.subtle.digest('SHA-256', data)
  return new Uint8Array(hash)
}
