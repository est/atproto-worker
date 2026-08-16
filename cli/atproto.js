/**
 * atproto repo primitives for the CLI
 * - commit v3 construction and signing (signCommit/verifyCommitSig)
 * - record CID computation (CID of the record itself, dag-cbor)
 * - CAR assembly for commit events (root = commit CID)
 * - image embed construction (app.bsky.embed.images, blob refs)
 *
 * Signing follows the reference implementation exactly:
 *   sig = k256_lowS( sha256( CBOR({did, version:3, data, rev, prev}) ) )
 *   output is 64-byte compact raw bytes (hex here for JSON storage)
 */

import fs from 'node:fs'
import { imageSize } from 'image-size'
import { computeCID, computeBlobCid, commitToCbor, commitCid as canonicalCommitCid, createCarFile } from '../src/shared.js'
import { sign, verify } from './crypto.js'

const IMAGE_MIME = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
}

/**
 * Build an app.bsky.embed.images record from local image files.
 * @param {Array<{path: string, alt?: string}>} images - 1-4 images
 * @returns {Promise<{embed: object, uploads: Array<{cid, ext, bytes}>}>}
 *   uploads are the blob files the caller must stage (public/uploads/<cid>.<ext>)
 */
export async function buildImageEmbed(images) {
    if (images.length < 1 || images.length > 4) {
        throw new Error('app.bsky.embed.images supports 1-4 images')
    }
    const embedImages = []
    const uploads = []
    for (const { path, alt } of images) {
        const bytes = fs.readFileSync(path)
        const cid = await computeBlobCid(bytes)
        const dims = imageSize(bytes)
        const ext = (dims.type || path.split('.').pop() || 'bin').toLowerCase()
        const mime = IMAGE_MIME[ext] || 'application/octet-stream'

        const img = {
            image: { $type: 'blob', ref: { $link: cid }, mimeType: mime, size: bytes.length },
            alt: alt || '',
        }
        if (dims.width && dims.height) {
            img.aspectRatio = { width: dims.width, height: dims.height }
        }
        embedImages.push(img)
        uploads.push({ cid, ext, bytes })
    }
    return { embed: { $type: 'app.bsky.embed.images', images: embedImages }, uploads }
}

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
