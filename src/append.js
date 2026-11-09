/**
 * Validation for owner-signed append events (M1 phase 2).
 *
 * The Worker is still a pure channel on the read path (ADR-030), but the
 * network write path MUST verify what it accepts: the owner signs a commit in
 * the browser/CLI with a P-256 key, and we check the commit/CAR/signature
 * before handing it to the Firehose ledger DO.
 *
 * This module is intentionally dependency-light (WebCrypto + shared CBOR/CID
 * helpers) so it runs in Workers, Node 22+, and the browser.
 */

import {
  base64ToBytes,
  cborEncode,
  commitCid as canonicalCommitCid,
  commitToCbor,
  computeCID,
  readCarFile
} from './shared.js'
import { parseMultikey, verifyP256 } from './keys.js'
import { isValidDID, isValidNsid, isValidRecordKey } from './utils.js'

// Request / event size guards. atproto records are small; these are meant to
// stop accidental or abusive giant payloads, not to be protocol limits.
export const MAX_APPEND_BODY_BYTES = 4 * 1024 * 1024 // JSON request body
export const MAX_BLOCKS_B64_BYTES = 3 * 1024 * 1024 // base64 CAR string
export const MAX_RECORD_BYTES = 1 * 1024 * 1024 // canonical CBOR of record
export const MAX_CAR_BLOCKS = 5000
export const MAX_FUTURE_REV_MS = 5 * 60 * 1000

const TID_RE = /^[234567abcdefghijklmnopqrstuvwxyz]{13}$/
const TID_ALPHABET = '234567abcdefghijklmnopqrstuvwxyz'

/**
 * Error carrying the HTTP/XRPC status to return. The xrpc handler forwards
 * `status`/`error`/`message` (and optional `details`) directly.
 */
export class AppendValidationError extends Error {
  constructor(status, error, message, details = {}) {
    super(message)
    this.name = 'AppendValidationError'
    this.status = status
    this.error = error
    this.details = details
  }
}

function fail(status, error, message, details) {
  throw new AppendValidationError(status, error, message, details)
}

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)
}

function bytesEqual(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Decode a TID's embedded timestamp (microseconds). Returns null when the
 * string is not a valid 13-char TID.
 */
export function tidToMicros(tid) {
  if (typeof tid !== 'string' || !TID_RE.test(tid)) return null
  let n = 0n
  for (const ch of tid) {
    const idx = TID_ALPHABET.indexOf(ch)
    if (idx === -1) return null
    n = (n << 5n) | BigInt(idx)
  }
  return Number(n >> 10n)
}

/**
 * Pure head-CAS/dedupe decision used by the ledger DO. Kept here so it can be
 * unit-tested without a SQLite shim, and shared with the DO to avoid two
 * subtly different implementations.
 *
 * @returns {{type:'duplicate'|'conflict'|'append', head?:object, existing?:object}}
 */
export function classifyAppend({ existing = null, head = null, expectedHead = null, expectedRev = null } = {}) {
  if (existing) return { type: 'duplicate', existing, head }
  const currentHead = head?.commitCid ?? null
  const currentRev = head?.rev ?? null
  const wantHead = expectedHead ?? null
  const wantRev = expectedRev ?? null
  if (currentHead !== wantHead || currentRev !== wantRev) {
    return { type: 'conflict', head }
  }
  return { type: 'append' }
}

/**
 * Validate an append event against the current head and the DID's resolved
 * `#atproto` key. Throws AppendValidationError on any problem.
 *
 * @param {object} event - the event from the client
 * @param {object} opts
 * @param {{commitCid:string|null, rev:string|null, mstRoot?:string|null}|null} opts.head
 * @param {string|null} [opts.resolvedKey] - publicKeyMultibase from the DID doc
 * @param {number} [opts.now] - current epoch ms (tests/injected clock)
 * @returns {Promise<{ok:true}>}
 */
export async function validateAppendEvent(event, { head = null, resolvedKey = null, now = Date.now() } = {}) {
  if (!isPlainObject(event)) {
    fail(400, 'InvalidRequest', 'append event must be a JSON object')
  }

  // --- Required fields / basic shape -------------------------------------
  const { did, op, collection, rkey, record, recordCid, rev, commit, commitCid, mstRoot, blocksB64, signingKey } = event

  if (!isValidDID(did)) fail(400, 'InvalidRequest', 'event.did is required and must be a valid DID')
  if (op !== 'create' && op !== 'update' && op !== 'delete') {
    fail(400, 'InvalidRequest', 'event.op must be create, update, or delete')
  }
  if (!isValidNsid(collection)) fail(400, 'InvalidRequest', 'event.collection must be a valid NSID')
  if (!isValidRecordKey(rkey)) fail(400, 'InvalidRequest', 'event.rkey must be a valid record key')
  // atproto revs are TIDs, but we accept any short non-whitespace token and
  // only apply the "too far in the future" clock check when it parses as a
  // TID. This keeps older/simple test revs and explicit client revs usable.
  if (typeof rev !== 'string' || !rev || rev.length > 64 || /\s/.test(rev)) {
    fail(400, 'InvalidRev', 'event.rev must be a non-empty revision string')
  }
  if (!isPlainObject(commit)) fail(400, 'InvalidRequest', 'event.commit is required')
  if (typeof commitCid !== 'string' || !commitCid) fail(400, 'InvalidRequest', 'event.commitCid is required')
  if (typeof mstRoot !== 'string' || !mstRoot) fail(400, 'InvalidRequest', 'event.mstRoot is required')
  if (typeof blocksB64 !== 'string' || !blocksB64) fail(400, 'InvalidRequest', 'event.blocksB64 is required')
  if (typeof signingKey !== 'string' || !signingKey) fail(400, 'InvalidRequest', 'event.signingKey is required')

  if (op !== 'delete') {
    if (!isPlainObject(record)) fail(400, 'InvalidRequest', 'event.record is required for create/update')
    if (typeof recordCid !== 'string' || !recordCid) fail(400, 'InvalidRequest', 'event.recordCid is required')
  } else if (record !== undefined && record !== null && !isPlainObject(record)) {
    fail(400, 'InvalidRequest', 'event.record must be an object when supplied')
  }
  if (event.prev !== undefined && event.prev !== null && typeof event.prev !== 'string') {
    fail(400, 'InvalidRequest', 'event.prev must be a CID string or null')
  }

  // --- Size limits --------------------------------------------------------
  if (blocksB64.length > MAX_BLOCKS_B64_BYTES) {
    fail(413, 'PayloadTooLarge', `event.blocksB64 exceeds ${MAX_BLOCKS_B64_BYTES} characters`)
  }
  let recordBytes = null
  if (op !== 'delete') {
    try {
      recordBytes = cborEncode(record)
    } catch (e) {
      fail(400, 'InvalidRecord', `event.record is not valid dag-cbor: ${e.message}`)
    }
    if (recordBytes.length > MAX_RECORD_BYTES) {
      fail(413, 'PayloadTooLarge', `event.record exceeds ${MAX_RECORD_BYTES} bytes`)
    }
  }

  // --- CID / commit self-consistency -------------------------------------
  let expectedRecordCid = null
  if (op !== 'delete') {
    try {
      expectedRecordCid = await computeCID(record)
    } catch (e) {
      fail(400, 'InvalidRecord', `could not compute record CID: ${e.message}`)
    }
    if (recordCid !== expectedRecordCid) {
      fail(400, 'InvalidRecordCid', `event.recordCid does not match the record (expected ${expectedRecordCid})`)
    }
  }

  let expectedCommitCid
  try {
    expectedCommitCid = await canonicalCommitCid(commit)
  } catch (e) {
    fail(400, 'InvalidCommit', `event.commit is not valid commit v3 CBOR: ${e.message}`)
  }
  if (commitCid !== expectedCommitCid) {
    fail(400, 'InvalidCommitCid', `event.commitCid does not match the commit (expected ${expectedCommitCid})`)
  }
  if (commit.did !== did) fail(400, 'InvalidCommit', 'commit.did does not match event.did')
  if (commit.rev !== rev) fail(400, 'InvalidCommit', 'commit.rev does not match event.rev')
  if (commit.version !== 3) fail(400, 'InvalidCommit', 'commit.version must be 3')
  if (commit.data !== mstRoot) fail(400, 'InvalidCommit', 'commit.data does not match event.mstRoot')

  // --- Head / chain checks (fork protection) -----------------------------
  const headCid = head?.commitCid ?? null
  const headRev = head?.rev ?? null

  if ((commit.prev ?? null) !== headCid) {
    fail(409, 'RepoConflict', 'commit.prev does not match the current head', { head })
  }
  // The event-level prev is redundant with commit.prev but clients may send
  // it; if they do, it must agree with the head we are chaining onto.
  if (has(event, 'prev') && (event.prev ?? null) !== headCid) {
    fail(409, 'RepoConflict', 'event.prev does not match the current head', { head })
  }

  if (headRev) {
    if (rev <= headRev) {
      fail(409, 'RepoConflict', `rev must be greater than the current head rev (${headRev})`, { head })
    }
  }
  const revMicros = tidToMicros(rev)
  if (revMicros !== null && revMicros > now * 1000 + MAX_FUTURE_REV_MS * 1000) {
    fail(400, 'InvalidRev', 'rev is more than 5 minutes in the future')
  }

  // --- Signature ----------------------------------------------------------
  let parsed
  try {
    parsed = parseMultikey(signingKey)
  } catch (e) {
    fail(400, 'InvalidSigningKey', `event.signingKey is not a valid multikey: ${e.message}`)
  }
  if (parsed.curve !== 'p256') {
    // M1 only accepts P-256 network writes; K-256 accounts must rotate first.
    fail(400, 'UnsupportedKeyType', 'Only P-256 signing keys are accepted for network writes')
  }
  if (parsed.compressed.length !== 33) {
    fail(400, 'InvalidSigningKey', 'P-256 signing key must be a 33-byte compressed point')
  }
  if (resolvedKey && resolvedKey !== signingKey) {
    fail(401, 'IdentityMismatch', 'event.signingKey does not match the DID document #atproto key')
  }

  if (typeof commit.sig !== 'string' || !/^[0-9a-fA-F]{128}$/.test(commit.sig)) {
    fail(400, 'BadSignature', 'commit.sig must be a 128-character hex string (64-byte low-S)')
  }
  const { sig, ...unsigned } = commit
  const signatureOk = await verifyP256(signingKey, commitToCbor(unsigned), sig)
  if (!signatureOk) {
    fail(401, 'BadSignature', 'Commit signature verification failed (invalid, wrong key, or high-S)')
  }

  // --- CAR blocks ---------------------------------------------------------
  let car
  try {
    car = readCarFile(base64ToBytes(blocksB64))
  } catch (e) {
    fail(400, 'InvalidBlocks', `event.blocksB64 is not a valid CAR: ${e.message}`)
  }
  if (car.blocks.size > MAX_CAR_BLOCKS) {
    fail(413, 'PayloadTooLarge', `CAR contains more than ${MAX_CAR_BLOCKS} blocks`)
  }
  if (car.roots.length !== 1 || car.roots[0] !== commitCid) {
    fail(400, 'InvalidBlocks', 'CAR root must equal event.commitCid')
  }
  if (!car.blocks.has(commitCid)) {
    fail(400, 'InvalidBlocks', 'CAR does not contain the commit block')
  }
  if (!bytesEqual(car.blocks.get(commitCid), commitToCbor(commit))) {
    fail(400, 'InvalidBlocks', 'CAR commit block does not match event.commit')
  }
  if (op !== 'delete' && expectedRecordCid) {
    if (!car.blocks.has(expectedRecordCid)) {
      fail(400, 'InvalidBlocks', 'CAR does not contain the record block')
    }
    if (!bytesEqual(car.blocks.get(expectedRecordCid), recordBytes)) {
      fail(400, 'InvalidBlocks', 'CAR record block does not match event.record')
    }
  }
  if (!car.blocks.has(mstRoot)) {
    fail(400, 'InvalidBlocks', 'CAR does not contain the MST root block')
  }

  // NOTE: full MST path verification (record leaf is reachable from mstRoot)
  // is intentionally deferred. The owner controls the signing key, and a bad
  // MST only breaks that owner's own repo; the read endpoints/CAR already
  // come from the same signed material.

  return { ok: true }
}
