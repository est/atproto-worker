import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import { MST } from '../cli/mst.js'
import { NodeWrangler, NodeStore, MemoryBlockStore } from '@atcute/mst'
import * as CID from '@atcute/cid'

const fixtures = JSON.parse(
  fs.readFileSync('atproto-interop-tests/firehose/commit-proof-fixtures.json', 'utf8'),
)

/**
 * Build an MST from the given keys using OUR hand-rolled implementation
 * (cli/mst.js). All leaves get the same `leafValue`.
 * Returns the root CID string.
 */
async function ourRoot(keys, leafValue) {
  const bs = new Map()
  let mst = await MST.create(bs, [], 0)
  for (const k of keys) mst = await mst.add(k, leafValue)
  return await mst.getPointer()
}

/**
 * Build an MST from the given keys using @atcute/mst.
 * Adapted to its API: its own MemoryBlockStore/NodeStore/NodeWrangler, and
 * values must be CidLink objects parsed from strings via @atcute/cid.
 * Returns the root CID string.
 */
async function atcuteRoot(keys, leafValue) {
  const store = new MemoryBlockStore()
  const ns = new NodeStore(store)
  const wrangler = new NodeWrangler(ns)
  const val = CID.toCidLink(CID.fromString(leafValue))
  let root = null // null root = empty tree
  for (const k of keys) {
    root = await wrangler.putRecord(root, k, val)
  }
  return root // putRecord already returns the `$link` string
}

/** @atcute/mst empty-tree node CID (no keys inserted). */
async function atcuteEmptyTreeCid() {
  const ns = new NodeStore(new MemoryBlockStore())
  const emptyNode = await ns.get(null)
  return (await emptyNode.cid()).$link
}

test('mst-atcute - empty tree pointer agrees between implementations', async () => {
  const bs = new Map()
  const ours = await MST.create(bs, [], 0)
  const ourPointer = await ours.getPointer()
  assert.strictEqual(ourPointer, await atcuteEmptyTreeCid(), 'empty-tree CID mismatch')
})

test('mst-atcute - all 6 commit-proof fixtures match with BOTH implementations', async () => {
  console.log('\nfixture | ourRoot | atcuteRoot | expected | pass')
  let allPass = true
  for (const f of fixtures) {
    const our = await ourRoot(f.keys, f.leafValue)
    const atcute = await atcuteRoot(f.keys, f.leafValue)
    const ourMatches = our === f.rootBeforeCommit
    const atcuteMatches = atcute === f.rootBeforeCommit
    const pass = ourMatches && atcuteMatches
    if (!pass) allPass = false
    // Sanity: both implementations agree with each other too
    assert.strictEqual(
      our,
      f.rootBeforeCommit,
      `OUR MST root mismatch for "${f.comment}"`,
    )
    assert.strictEqual(
      atcute,
      f.rootBeforeCommit,
      `@atcute/mst root mismatch for "${f.comment}"`,
    )
    assert.strictEqual(atcute, our, `implementations disagree for "${f.comment}"`)
    console.log(
      `${f.comment} | ${our} | ${atcute} | ${f.rootBeforeCommit} | ${pass ? 'PASS' : 'FAIL'}`,
    )
  }
  assert.ok(allPass, 'one or more fixtures failed')
})