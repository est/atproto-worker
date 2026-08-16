/**
 * atproto repo primitives for the CLI
 * - commit v3 construction and signing (signCommit/verifyCommitSig)
 * - record CID computation (CID of the record itself, dag-cbor)
 * - CAR assembly for commit events (root = commit CID)
 *
 * Signing follows the reference implementation exactly:
 *   sig = k256_lowS( sha256( CBOR({did, version:3, data, rev, prev}) ) )
 *   output is 64-byte compact raw bytes (hex here for JSON storage)
 */

import { computeCID, commitToCbor, commitCid as canonicalCommitCid, createCarFile } from '../src/shared.js'
import { sign, verify } from './crypto.js'

/**
 * Build the unsigned commit object.
 * @param {string} did - owner DID
 * @param {string} dataCid - MST root CID
 * @param {string} rev - TID revision
 * @param {string|null} prevCid - previous commit CID or null
 */
export function buildUnsignedCommit(did, dataCid, rev, prevCid) {
  return {
    did,
    version: 3,
    data: dataCid,
    rev,
    prev: prevCid
  }
}

/**
 * Sign an unsigned commit with the owner private key.
 * Returns the full commit v3 object (with sig as hex string).
 * The signature is computed over the canonical commit CBOR (data/prev as
 * CID links, cbor-gen field order), matching the reference implementation
 * so the relay's VerifySignature accepts it.
 */
export async function signCommit(unsignedCommit, privateKeyHex) {
  const encoded = commitToCbor(unsignedCommit)
  const sig = await sign(encoded, privateKeyHex)
  return { ...unsignedCommit, sig }
}

/**
 * Verify a commit v3 signature against a hex public key.
 */
export async function verifyCommitSig(commit, publicKeyHex) {
  const { sig, ...rest } = commit
  const encoded = commitToCbor(rest)
  return verify(encoded, sig, publicKeyHex)
}

/**
 * Compute the CID of a record (dag-cbor, sha256) - the atproto record CID.
 */
export async function recordCid(record) {
  return computeCID(record)
}

/**
 * Compute the CID of the commit object itself (canonical encoding).
 */
export async function commitCid(commit) {
  return canonicalCommitCid(commit)
}

/**
 * Assemble a CAR v1 file with the commit as root.
 * Single implementation lives in src/shared.js (createCarFile); re-exported
 * here under the historical name `createCar`.
 * @param {string} rootCid - commit CID (also root of the CAR)
 * @param {Array<{cid: string, data: any}>} blocks - extra blocks (MST nodes, records)
 * @returns {Uint8Array}
 */
export { createCarFile as createCar }

/**
 * Encode a CAR file to base64 string for storage in JSON journal lines.
 */
export function carToBase64(carBytes) {
  return Buffer.from(carBytes).toString('base64')
}
