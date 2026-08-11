import test from 'node:test'
import assert from 'node:assert'
import { MST, serializeNodeData, deserializeNodeData, leadingZerosOnHash, Leaf, readObj } from '../cli/mst.js'
import { cborEncode, computeCID } from '../src/shared.js'
import { recordCid, buildUnsignedCommit, signCommit, verifyCommitSig, createCar } from '../cli/atproto.js'
import { generateKeypair } from '../cli/crypto.js'

function newBlockstore() {
  return new Map()
}

test('mst - empty tree pointer is a valid cid', async () => {
  const bs = newBlockstore()
  const mst = await MST.create(bs, [], 0)
  const pointer = await mst.getPointer()
  assert.ok(pointer.startsWith('bafyre'))
  // Empty tree serializes to { l: null, e: [] }
  const data = serializeNodeData([])
  const expected = await computeCID(data)
  assert.strictEqual(pointer, expected)
})

test('mst - add and get', async () => {
  const bs = newBlockstore()
  const cid1 = await recordCid({ $type: 'app.bsky.feed.post', text: 'hello' })
  let mst = await MST.create(bs, [], 0)
  mst = await mst.add('app.bsky.feed.post/3abc', cid1)
  const got = await mst.get('app.bsky.feed.post/3abc')
  assert.strictEqual(got, cid1)
  const missing = await mst.get('app.bsky.feed.post/nope')
  assert.strictEqual(missing, null)
})

test('mst - update and delete', async () => {
  const bs = newBlockstore()
  const cid1 = await recordCid({ text: 'v1' })
  const cid2 = await recordCid({ text: 'v2' })
  let mst = await MST.create(bs, [], 0)
  mst = await mst.add('app.bsky.graph.follow/did1', cid1)
  mst = await mst.update('app.bsky.graph.follow/did1', cid2)
  assert.strictEqual(await mst.get('app.bsky.graph.follow/did1'), cid2)
  mst = await mst.delete('app.bsky.graph.follow/did1')
  assert.strictEqual(await mst.get('app.bsky.graph.follow/did1'), null)
})

test('mst - deterministic root regardless of insert order', async () => {
  const keys = ['app.bsky.feed.post/a1', 'app.bsky.feed.post/b2', 'app.bsky.graph.follow/c3', 'app.bsky.feed.like/d4']
  const cids = []
  for (const k of keys) {
    cids.push(await recordCid({ text: k }))
  }

  // Insert in forward order
  const bs1 = newBlockstore()
  let m1 = await MST.create(bs1, [], 0)
  for (let i = 0; i < keys.length; i++) m1 = await m1.add(keys[i], cids[i])

  // Insert in reverse order
  const bs2 = newBlockstore()
  let m2 = await MST.create(bs2, [], 0)
  for (let i = keys.length - 1; i >= 0; i--) m2 = await m2.add(keys[i], cids[i])

  const p1 = await m1.getPointer()
  const p2 = await m2.getPointer()
  assert.strictEqual(p1, p2, 'MST root must be insert-order-independent')
})

test('mst - serialization round-trip', async () => {
  const bs = newBlockstore()
  const cids = []
  for (const k of ['app.bsky.feed.post/x1', 'app.bsky.feed.post/y2', 'app.bsky.feed.post/z3']) {
    cids.push(await recordCid({ text: k }))
  }
  let mst = await MST.create(bs, [], 0)
  for (let i = 0; i < 3; i++) mst = await mst.add(['app.bsky.feed.post/x1', 'app.bsky.feed.post/y2', 'app.bsky.feed.post/z3'][i], cids[i])

  const { root, blocks } = await mst.getUnstoredBlocks()
  // Populate a fresh blockstore from the collected blocks
  const bs2 = new Map()
  for (const [cid, bytes] of blocks) bs2.set(cid, bytes)

  const reloaded = MST.load(bs2, root)
  assert.strictEqual(await reloaded.get('app.bsky.feed.post/x1'), cids[0])
  assert.strictEqual(await reloaded.get('app.bsky.feed.post/y2'), cids[1])
  assert.strictEqual(await reloaded.get('app.bsky.feed.post/z3'), cids[2])
  const root2 = await reloaded.getPointer()
  assert.strictEqual(root, root2)
})

test('commit v3 - sign and verify round-trip', async () => {
  const { privateKey, publicKey } = await generateKeypair()
  const unsigned = buildUnsignedCommit(
    'did:web:atproto-worker.yiesty.workers.dev',
    'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '3msss7ozp7k22',
    null,
  )
  const commit = await signCommit(unsigned, privateKey)
  assert.ok(commit.sig)
  assert.strictEqual(commit.version, 3)
  const valid = await verifyCommitSig(commit, publicKey)
  assert.strictEqual(valid, true)

  // Tampered commit must fail
  const tampered = { ...commit, rev: '3msss7ozp7k23' }
  const invalid = await verifyCommitSig(tampered, publicKey)
  assert.strictEqual(invalid, false)
})

test('commit v3 - stable cid across runs', async () => {
  const unsigned = buildUnsignedCommit(
    'did:web:example.com',
    'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '3msss7ozp7k22',
    null,
  )
  const cid1 = await computeCID(unsigned)
  const cid2 = await computeCID(unsigned)
  assert.strictEqual(cid1, cid2)
})

test('car - createCar produces valid root', async () => {
  const commit = {
    did: 'did:web:example.com',
    version: 3,
    data: 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    rev: '3msss7ozp7k22',
    prev: null,
    sig: 'abc'
  }
  const commitCid = await computeCID(commit)
  const car = createCar(commitCid, [{ cid: commitCid, data: commit }])
  assert.ok(car.length > 50)
  // Header CBOR: map with keys sorted by length then lexicographic:
  // "roots" (5) then "version" (7) -> map(2)=0xa2, string(5), string(7)
  assert.strictEqual(car[1], 0xa2)
})

test('mst - getLayer of non-empty tree', async () => {
  const bs = newBlockstore()
  const cid = await recordCid({ text: 'x' })
  let mst = await MST.create(bs, [], 0)
  mst = await mst.add('app.bsky.feed.post/3abc', cid)
  const layer = await mst.getLayer()
  assert.strictEqual(typeof layer, 'number')
  assert.ok(layer >= 0)
})
