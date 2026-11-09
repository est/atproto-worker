/**
 * atproto repo primitives for the CLI
 * - commit v3 construction and signing (signCommit/verifyCommitSig)
 * - record CID computation (CID of the record itself, dag-cbor)
 * - CAR assembly for commit events (root = commit CID)
 * - image embed construction (app.bsky.embed.images, blob refs)
 *
 * The shared commit/CAR implementation lives in src/commit.js; this module
 * keeps the historical CLI export names and adds multi-curve key dispatch:
 *   - legacy k256 hex string -> @noble/secp256k1 (cli/crypto.sign)
 *   - {curve:'p256'}       -> WebCrypto P-256 (cli/crypto.signP256)
 *   - {curve:'k256'}       -> @noble/secp256k1
 */

import fs from 'node:fs'
import { imageSize } from 'image-size'
import { computeBlobCid, bytesToHex } from '../src/shared.js'
import {
  buildUnsignedCommit,
  recordCid,
  commitCid,
  createCar,
  carToBase64,
  signCommit as signCommitShared,
  verifyCommitSig as verifyCommitSigShared
} from '../src/commit.js'
import { parseMultikey } from '../src/keys.js'
import { sign, verify, signP256, verifyP256 } from './crypto.js'

export { buildUnsignedCommit, recordCid, commitCid, createCar, carToBase64 }

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
 * Sign an unsigned commit with the owner key.
 * @param {object} unsignedCommit
 * @param {string|{curve?: string, privateKey: string}} key - legacy k256 hex
 *   string, or a normalized key object ({curve, privateKey})
 * Returns the full commit v3 object (with sig as hex string).
 */
export async function signCommit(unsignedCommit, key) {
  if (typeof key === 'string') {
    return signCommitShared(unsignedCommit, (encoded) => sign(encoded, key))
  }
  if (!key || !key.privateKey) throw new Error('signCommit requires a private key')

  const curve = key.curve || 'k256'
  if (curve === 'p256') {
    return signCommitShared(unsignedCommit, (encoded) => signP256(key.privateKey, encoded))
  }
  if (curve === 'k256') {
    return signCommitShared(unsignedCommit, (encoded) => sign(encoded, key.privateKey))
  }
  throw new Error(`Unsupported curve: ${curve}`)
}

/**
 * Verify a commit v3 signature.
 * @param {object} commit
 * @param {string|{curve?: string, publicKey?: string, publicKeyMultibase?: string}} key
 *   legacy k256 hex string, or a key object with a public key
 */
export async function verifyCommitSig(commit, key) {
  if (typeof key === 'string') {
    return verifyCommitSigShared(commit, (encoded, sig) => verify(encoded, sig, key))
  }
  if (!key) return false

  const curve = key.curve || 'k256'
  if (curve === 'p256') {
    const publicKey = key.publicKeyMultibase || key.publicKey
    if (!publicKey) return false
    return verifyCommitSigShared(commit, (encoded, sig) => verifyP256(publicKey, encoded, sig))
  }
  if (curve === 'k256') {
    if (!key.publicKey) return false
    return verifyCommitSigShared(commit, (encoded, sig) => verify(encoded, sig, key.publicKey))
  }
  return false
}

/**
 * Verify a commit against a Multikey string (z...), dispatching by curve:
 * k256 via the CLI's secp256k1 verifier, p256 via src/keys.verifyP256.
 */
export async function verifyCommitSigWithMultikey(commit, multibase) {
  let parsed
  try {
    parsed = parseMultikey(multibase)
  } catch {
    return false
  }

  if (parsed.curve === 'p256') {
    return verifyCommitSig(commit, { curve: 'p256', publicKeyMultibase: multibase })
  }
  return verifyCommitSig(commit, {
    curve: 'k256',
    publicKey: bytesToHex(parsed.compressed)
  })
}
