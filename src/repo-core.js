/**
 * Browser / Worker-safe atproto repo core.
 *
 * This is the fs/Buffer-free counterpart of `cli/repo.js`:
 * - loads an existing repo from a CAR (`Repo.fromCar`)
 * - creates an empty repo (`Repo.create`)
 * - applies create/update/delete writes to the MST
 * - builds and signs commit v3 (signature injected via `signFn`)
 * - produces an incremental CAR for the new commit (`buildCar`)
 *
 * The blockstore is a plain `Map<cid, Uint8Array>`, so IndexedDB, DO SQLite,
 * R2, or an in-memory cache can all back it without changing this module.
 * Signing is injected: the browser/CLI passes `signP256`, but any
 * `(encoded: Uint8Array) => Promise<hexSig>` works.
 */

import {
  cborDecode,
  cborEncode,
  commitToCbor,
  createCarFile,
  nextTID,
  readCarFile,
  bytesToHex,
} from './shared.js'
import {
  buildUnsignedCommit,
  commitCid,
  recordCid,
  signCommit,
} from './commit.js'
import { MST, isValidMstKey } from '../cli/mst.js'
import { signP256 } from './keys.js'

/** Accepts the CBOR-decoded commit shape and returns the JSON shape used here. */
function normalizeCommit(decoded) {
  const link = (value) => {
    if (value === null || value === undefined) return null
    return typeof value === 'object' && value.$link ? value.$link : value
  }

  return {
    did: decoded.did,
    version: decoded.version,
    data: link(decoded.data),
    rev: decoded.rev,
    prev: link(decoded.prev),
    sig: decoded.sig instanceof Uint8Array ? bytesToHex(decoded.sig) : decoded.sig,
  }
}

export class Repo {
  /**
   * @param {object} opts
   * @param {string} opts.did
   * @param {any} [opts.signingKey] - P-256 CryptoKey / JWK / PKCS#8 string, or
   *   any value accepted by `signP256` when `applyWrite` has no `signFn`.
   * @param {Map<string, Uint8Array>} [opts.blockstore]
   * @param {MST|null} [opts.mst]
   * @param {string|null} [opts.commitCid]
   * @param {string|null} [opts.rev]
   */
  constructor({ did, signingKey = null, blockstore, mst = null, commitCid = null, rev = null }) {
    if (!did || typeof did !== 'string') throw new Error('Repo requires a did')
    this.did = did
    this.signingKey = signingKey
    this.blockstore = blockstore instanceof Map ? blockstore : new Map()
    this.mst = mst
    this.commitCid = commitCid
    this.rev = rev
  }

  /**
   * Create a repo handle. With `mstRoot` the MST is loaded lazily from the
   * blockstore; without it the repo starts empty (first `applyWrite` builds
   * the first tree).
   */
  static async create({
    did,
    signingKey = null,
    blockstore,
    mstRoot = null,
    commitCid = null,
    rev = null,
  } = {}) {
    if (!did || typeof did !== 'string') throw new Error('Repo.create requires a did')
    const store = blockstore instanceof Map ? blockstore : new Map()

    let mst = null
    if (mstRoot) {
      if (!store.has(mstRoot)) throw new Error(`Missing MST root block: ${mstRoot}`)
      mst = MST.load(store, mstRoot)
    }

    return new Repo({ did, signingKey, blockstore: store, mst, commitCid, rev })
  }

  /**
   * Load a repo from a CAR (`getRepo` output or a full-repo export).
   *
   * The CAR root must be the head commit; the commit block and MST root block
   * must be present. `did` and commit `version` are validated, and the head
   * commit CID is recomputed from its canonical encoding.
   */
  static async fromCar(carBytes, { did, signingKey = null } = {}) {
    if (!did || typeof did !== 'string') throw new Error('Repo.fromCar requires a did')

    const { roots, blocks, header } = readCarFile(carBytes)
    if (header?.version !== 1) {
      throw new Error(`Unsupported CAR version: ${header?.version}`)
    }
    if (roots.length !== 1) {
      throw new Error(`Expected exactly one CAR root, got ${roots.length}`)
    }

    const root = roots[0]
    const blockstore = new Map(blocks)
    const commitBytes = blockstore.get(root)
    if (!commitBytes) throw new Error(`CAR is missing its root commit block: ${root}`)

    const commit = normalizeCommit(cborDecode(commitBytes))
    if (commit.did !== did) {
      throw new Error(`Repo did mismatch: expected ${did}, got ${commit.did}`)
    }
    if (commit.version !== 3) {
      throw new Error(`Unsupported repo commit version: ${commit.version}`)
    }
    if (!commit.rev || typeof commit.rev !== 'string') {
      throw new Error('Commit is missing a valid rev')
    }
    if (!commit.data || typeof commit.data !== 'string') {
      throw new Error('Commit is missing its MST root (data)')
    }

    const derived = await commitCid(commit)
    if (derived !== root) {
      throw new Error(`Commit CID mismatch: CAR root ${root}, canonical ${derived}`)
    }
    if (!blockstore.has(commit.data)) {
      throw new Error(`CAR is missing the MST root block: ${commit.data}`)
    }

    return new Repo({
      did,
      signingKey,
      blockstore,
      mst: MST.load(blockstore, commit.data),
      commitCid: root,
      rev: commit.rev,
    })
  }

  /** Merge all blocks from a CAR into this repo's blockstore. */
  loadBlocksFromCar(carBytes) {
    const { roots, blocks } = readCarFile(carBytes)
    for (const [cid, bytes] of blocks) this.blockstore.set(cid, bytes)
    return { roots, blocks }
  }

  /**
   * Apply one write and produce a signed commit v3.
   *
   * @param {{action: 'create'|'update'|'delete', collection: string,
   *   rkey: string, record?: object}} write
   * @param {(encoded: Uint8Array) => Promise<string>} [signFn]
   *   Optional signer. Defaults to `signP256(this.signingKey, encoded)`.
   * @returns {Promise<{recordCid: string|null, mstRoot: string,
   *   prevMstRoot: string|null, commit: object, commitCid: string,
   *   rev: string, newBlocks: Map<string, Uint8Array>}>}
   */
  async applyWrite({ action, collection, rkey, record } = {}, signFn) {
    if (!['create', 'update', 'delete'].includes(action)) {
      throw new Error(`Unsupported write action: ${action}`)
    }
    if (typeof collection !== 'string' || typeof rkey !== 'string') {
      throw new Error('applyWrite requires collection and rkey strings')
    }
    const key = `${collection}/${rkey}`
    if (!isValidMstKey(key)) throw new Error(`Invalid MST key: ${key}`)
    if (action !== 'delete' && (record === undefined || record === null)) {
      throw new Error(`applyWrite ${action} requires a record`)
    }

    const recCid = action === 'delete' ? null : await recordCid(record)

    let mst = this.mst || (await MST.create(this.blockstore, [], 0))
    const prevMstRoot = this.mst ? await this.mst.getPointer() : null

    if (action === 'delete') {
      mst = await mst.delete(key)
    } else if (action === 'update') {
      mst = await mst.update(key, recCid)
    } else {
      mst = await mst.add(key, recCid)
    }

    // New MST node blocks (absent from the current blockstore).
    const { root: mstRoot, blocks } = await mst.getUnstoredBlocks()

    // Include the record block when it is new to this blockstore.
    if (recCid && !this.blockstore.has(recCid) && !blocks.has(recCid)) {
      blocks.set(recCid, cborEncode(record))
    }

    const rev = nextTID(this.rev)
    const unsigned = buildUnsignedCommit(this.did, mstRoot, rev, this.commitCid)

    const sign = signFn || ((encoded) => {
      if (!this.signingKey) throw new Error('No signFn or signingKey provided')
      return signP256(this.signingKey, encoded)
    })
    const commit = await signCommit(unsigned, sign)
    const cid = await commitCid(commit)

    // The commit block is always part of this write's CAR.
    blocks.set(cid, commitToCbor(commit))

    // Commit state only after signing succeeded.
    for (const [bcid, bytes] of blocks) this.blockstore.set(bcid, bytes)
    this.mst = mst
    this.commitCid = cid
    this.rev = rev

    return {
      recordCid: recCid,
      mstRoot,
      prevMstRoot,
      commit,
      commitCid: cid,
      rev,
      newBlocks: blocks,
    }
  }

  /**
   * Build the incremental CAR for one `applyWrite` result: root = new commit,
   * blocks = new commit + new MST nodes + new record. This is the payload for
   * a firehose-style `#commit` event / append endpoint.
   */
  buildCar(result) {
    if (!result || !result.commitCid || !result.newBlocks) {
      throw new Error('buildCar requires an applyWrite result')
    }
    const blocks = []
    for (const [cid, data] of result.newBlocks) {
      blocks.push({ cid, data })
    }
    return createCarFile(result.commitCid, blocks)
  }

  /**
   * Build a complete CAR containing the current head and every block in the
   * blockstore. Use this for export/backup and for full-repo verification.
   */
  buildFullCar() {
    if (!this.commitCid) throw new Error('Cannot build a CAR for an empty repo')
    if (!this.blockstore.has(this.commitCid)) {
      throw new Error(`Missing head commit block: ${this.commitCid}`)
    }
    const blocks = []
    for (const [cid, data] of this.blockstore) {
      blocks.push({ cid, data })
    }
    return createCarFile(this.commitCid, blocks)
  }

  getHead() {
    return { commitCid: this.commitCid, rev: this.rev }
  }

  /**
   * Read all leaves from the MST and decode their record blocks.
   * @returns {Promise<Array<{collection: string, rkey: string, cid: string,
   *   record: object}>>}
   */
  async getRecords() {
    if (!this.mst) return []
    const leaves = await this.mst.leaves()
    const records = []
    for (const leaf of leaves) {
      const split = leaf.key.indexOf('/')
      if (split < 0) continue
      const bytes = this.blockstore.get(leaf.value)
      if (!bytes) throw new Error(`Missing record block: ${leaf.value}`)
      records.push({
        collection: leaf.key.slice(0, split),
        rkey: leaf.key.slice(split + 1),
        cid: leaf.value,
        record: cborDecode(bytes),
      })
    }
    return records
  }

  /** Read and decode one record, or null if the key is absent. */
  async getRecord(collection, rkey) {
    if (!this.mst) return null
    const cid = await this.mst.get(`${collection}/${rkey}`)
    if (!cid) return null
    const bytes = this.blockstore.get(cid)
    if (!bytes) throw new Error(`Missing record block: ${cid}`)
    return cborDecode(bytes)
  }

  /** CID of one record key from the MST, or null. */
  async getRecordCid(collection, rkey) {
    if (!this.mst) return null
    return this.mst.get(`${collection}/${rkey}`)
  }
}
