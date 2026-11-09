/**
 * CAR v1 reader/writer tests. Exercises block counts, roots, empty and large
 * blocks (multi-byte varints), malformed input, and the P-256 spike CAR.
 */

import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  cborDecode,
  computeCidFromBytes,
  createCarFile,
  decodeVarint,
  readCarFile,
} from '../src/shared.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

test('car - round-trip with multiple blocks and roots', async () => {
  const payloads = [
    new TextEncoder().encode('hello car'),
    new TextEncoder().encode('second block'),
    new Uint8Array([0, 1, 2, 3, 255]),
  ]

  const blocks = []
  for (const data of payloads) {
    blocks.push({ cid: await computeCidFromBytes(data), data })
  }

  const car = createCarFile(blocks[0].cid, blocks)
  const parsed = readCarFile(car)

  assert.deepStrictEqual(parsed.roots, [blocks[0].cid])
  assert.strictEqual(parsed.blocks.size, blocks.length)
  for (const { cid, data } of blocks) {
    assert.deepStrictEqual(parsed.blocks.get(cid), data, `block ${cid} mismatch`)
  }

  // Map preserves CAR section order.
  assert.deepStrictEqual([...parsed.blocks.keys()], blocks.map((b) => b.cid))
})

test('car - empty block payload round-trips', async () => {
  const empty = new Uint8Array(0)
  const cid = await computeCidFromBytes(empty)
  const car = createCarFile(cid, [{ cid, data: empty }])

  const parsed = readCarFile(car)
  assert.deepStrictEqual(parsed.roots, [cid])
  assert.strictEqual(parsed.blocks.get(cid).length, 0)
})

test('car - large blocks use multi-byte varints', async () => {
  const small = new TextEncoder().encode('root block')
  const mediumData = new Uint8Array(500).fill(7)
  const largeData = new Uint8Array(20_000).fill(9)

  const smallCid = await computeCidFromBytes(small)
  const mediumCid = await computeCidFromBytes(mediumData)
  const largeCid = await computeCidFromBytes(largeData)

  const car = createCarFile(smallCid, [
    { cid: smallCid, data: small },
    { cid: mediumCid, data: mediumData },
    { cid: largeCid, data: largeData },
  ])

  const parsed = readCarFile(car)
  assert.strictEqual(parsed.blocks.size, 3)
  assert.deepStrictEqual(parsed.blocks.get(mediumCid), mediumData)
  assert.deepStrictEqual(parsed.blocks.get(largeCid), largeData)

  // Walk sections and check encoded varint widths: 36-byte CID + payload.
  const headerLen = decodeVarint(car, 0)
  let offset = headerLen.offset + headerLen.value
  const expectedWidths = [small.length, mediumData.length, largeData.length].map((len) => {
    const sectionLen = decodeVarint(car, offset)
    assert.strictEqual(sectionLen.value, 36 + len)
    const width = sectionLen.offset - offset
    offset = sectionLen.offset + sectionLen.value
    return width
  })

  assert.strictEqual(expectedWidths[0], 1, 'small section varint should be 1 byte')
  assert.strictEqual(expectedWidths[1], 2, '500-byte section varint should be 2 bytes')
  assert.strictEqual(expectedWidths[2], 3, '20 KB section varint should be 3 bytes')
  assert.strictEqual(offset, car.length)
})

test('car - rejects truncated block sections', async () => {
  const data = new TextEncoder().encode('truncate me')
  const cid = await computeCidFromBytes(data)
  const car = createCarFile(cid, [{ cid, data }])
  const truncated = car.slice(0, car.length - 1)

  assert.throws(() => readCarFile(truncated), /extends past end/)
})

test('car - reads the p256 spike CAR when present', async (t) => {
  const spikeCar = path.resolve(HERE, '../.tmp/p256-spike/repo.car')
  if (!fs.existsSync(spikeCar)) {
    t.skip('spike CAR not present')
    return
  }

  const bytes = new Uint8Array(fs.readFileSync(spikeCar))
  const parsed = readCarFile(bytes)

  assert.strictEqual(parsed.header.version, 1)
  assert.strictEqual(parsed.roots.length, 1)
  assert.strictEqual(parsed.blocks.size, 3, 'spike CAR has commit + MST node + record')

  const root = parsed.roots[0]
  const commit = cborDecode(parsed.blocks.get(root))
  assert.strictEqual(commit.version, 3)
  assert.strictEqual(commit.did, 'did:web:test.example')
  assert.ok(commit.data && commit.data.$link, 'commit.data is a CID link')
  assert.ok(parsed.blocks.has(commit.data.$link), 'MST root block is in the CAR')
  assert.ok(commit.sig instanceof Uint8Array)
  assert.strictEqual(commit.sig.length, 64)
})
