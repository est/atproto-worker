/**
 * Shared atproto commit v3 helpers. Browser / Worker / CLI safe.
 *
 * The signature scheme is injected:
 * - CLI k256: sign(encoded, privateKeyHex) -> hex
 * - CLI/browser p256: signP256(privateKey, encoded) -> hex
 *
 * The signed preimage is always commitToCbor(unsigned) and the sig is always
 * a 64-byte low-S compact signature stored as hex in the journal.
 */

import {
  cborEncode,
  computeCID,
  commitCid as canonicalCommitCid,
  commitToCbor,
  createCarFile,
  bytesToBase64,
  base64ToBytes
} from './shared.js'

export { cborEncode, computeCID, commitToCbor }

export function buildUnsignedCommit(did, dataCid, rev, prevCid) {
  return {
    did,
    version: 3,
    data: dataCid,
    rev,
    prev: prevCid || null
  }
}

export async function recordCid(record) {
  return computeCID(record)
}

export async function commitCid(commit) {
  return canonicalCommitCid(commit)
}

/**
 * @param {object} unsigned
 * @param {(encoded: Uint8Array) => Promise<string>} signFn
 */
export async function signCommit(unsigned, signFn) {
  const encoded = commitToCbor(unsigned)
  const sig = await signFn(encoded)
  return { ...unsigned, sig }
}

/**
 * @param {object} commit
 * @param {(encoded: Uint8Array, sigHex: string) => Promise<boolean>} verifyFn
 */
export async function verifyCommitSig(commit, verifyFn) {
  const { sig, ...rest } = commit
  const encoded = commitToCbor(rest)
  return verifyFn(encoded, sig)
}

export function carToBase64(carBytes) {
  return bytesToBase64(carBytes)
}

export function base64ToCar(b64) {
  return base64ToBytes(b64)
}

export { createCarFile as createCar }
