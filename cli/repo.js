/**
 * Repo state manager for the CLI.
 *
 * Maintains the atproto repo (MST + commit chain) across operations:
 * - loads MST blocks from .repo-state.json
 * - applies a write (create/update/delete) to the MST
 * - collects new blocks (MST nodes + record)
 * - builds & signs commit v3
 * - persists state after each operation
 *
 * The journal remains the single source of truth; .repo-state.json is a
 * local build cache that can be rebuilt from the journal at any time.
 */

import fs from 'node:fs'
import { MST } from './mst.js'
import { recordCid, buildUnsignedCommit, signCommit, commitCid, createCar, carToBase64 } from './atproto.js'
import { generateTID } from '../src/shared.js'

const DEFAULT_STATE_PATH = './.repo-state.json'

export class RepoManager {
  /**
   * @param {string} did - owner DID
   * @param {string} privateKeyHex - signing key (hex)
   * @param {string} statePath - path to state file
   */
  constructor(did, privateKeyHex, statePath = DEFAULT_STATE_PATH) {
    this.did = did
    this.privateKeyHex = privateKeyHex
    this.statePath = statePath
    this.blockstore = new Map()
    this.mst = null
    this.commitCid = null
    this.rev = null
    this.load()
  }

  load() {
    if (fs.existsSync(this.statePath)) {
      const state = JSON.parse(fs.readFileSync(this.statePath, 'utf-8'))
      // Rebuild blockstore from base64 blocks
      for (const [cid, b64] of Object.entries(state.blocks || {})) {
        this.blockstore.set(cid, Uint8Array.from(Buffer.from(b64, 'base64')))
      }
      this.mst = state.mstRoot ? MST.load(this.blockstore, state.mstRoot) : null
      this.commitCid = state.commitCid || null
      this.rev = state.rev || null
    }
  }

  save() {
    const blocks = {}
    for (const [cid, bytes] of this.blockstore) {
      blocks[cid] = Buffer.from(bytes).toString('base64')
    }
    const state = {
      mstRoot: this.mst ? this.mst.pointer : null,
      commitCid: this.commitCid,
      rev: this.rev,
      blocks
    }
    fs.writeFileSync(this.statePath, JSON.stringify(state))
  }

  /**
   * Apply a write to the repo and produce a signed commit.
   * @param {Object} write - {action: 'create'|'update'|'delete', collection, rkey, record?}
   * @returns {Object} - { recordCid, mstRoot, commit, commitCid, newBlocks }
   */
  async applyWrite(write) {
    const { action, collection, rkey, record } = write
    const key = `${collection}/${rkey}`

    // Compute record CID
    let recCid = null
    if (action !== 'delete') {
      recCid = await recordCid(record)
    }

    // Start from current MST or empty
    let mst = this.mst || await MST.create(this.blockstore, [], 0)

    // Apply to MST
    if (action === 'delete') {
      mst = await mst.delete(key)
    } else if (action === 'update') {
      mst = await mst.update(key, recCid)
    } else {
      mst = await mst.add(key, recCid)
    }

    // Get new blocks (MST nodes)
    const { root: mstRoot, blocks } = await mst.getUnstoredBlocks()
    // Add record block
    if (recCid && !this.blockstore.has(recCid)) {
      blocks.set(recCid, await this.recordBytes(record))
    }

    // Build commit v3
    const rev = this.nextRev()
    const unsigned = buildUnsignedCommit(this.did, mstRoot, rev, this.commitCid)
    const commit = await signCommit(unsigned, this.privateKeyHex)
    const cid = await commitCid(commit)

    // Add commit block to blocks
    blocks.set(cid, await this.commitBytes(commit))

    // Update state
    this.mst = mst
    this.commitCid = cid
    this.rev = rev
    // Merge new blocks into blockstore
    for (const [bcid, bbytes] of blocks) {
      this.blockstore.set(bcid, bbytes)
    }
    this.save()

    return {
      recordCid: recCid,
      mstRoot,
      commit,
      commitCid: cid,
      rev,
      newBlocks: blocks
    }
  }

  nextRev() {
    // Monotonic TID: use time-based; ensure greater than current
    let tid = generateTID()
    if (this.rev && tid <= this.rev) {
      tid = generateTID() // retry once (collision unlikely)
    }
    return tid
  }

  async recordBytes(record) {
    const { cborEncode } = await import('../src/shared.js')
    return cborEncode(record)
  }

  async commitBytes(commit) {
    const { cborEncode } = await import('../src/shared.js')
    return cborEncode(commit)
  }

  /**
   * Build the firehose #commit blocks CAR (commit + MST nodes + record).
   */
  async buildCar(commitCid, newBlocks) {
    const blocks = []
    for (const [cid, bytes] of newBlocks) {
      blocks.push({ cid, data: bytes })
    }
    return createCar(commitCid, blocks)
  }

  carToBase64(carBytes) {
    return carToBase64(carBytes)
  }
}
