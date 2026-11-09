/**
 * Repo core tests: build/sign a repo in pure JS, round-trip through a CAR,
 * then continue writing from the loaded repo. These tests use only the
 * project's WebCrypto P-256 helpers (no Node crypto primitives).
 */

import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Repo } from '../src/repo-core.js'
import { generateP256Keypair, signP256, verifyP256 } from '../src/keys.js'
import {
  cborDecode,
  commitToCbor,
  computeCID,
  createCarFile,
  hexToBytes,
  nextTID,
  readCarFile,
} from '../src/shared.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const COLLECTION = 'app.bsky.feed.post'
const DID = 'did:web:phase1.test'

const post = (text) => ({
  $type: COLLECTION,
  text,
  createdAt: '2026-11-09T00:00:00.000Z',
})

async function assertCommitSignature(commit, publicKey) {
  const { sig, ...unsigned } = commit
  assert.strictEqual(typeof sig, 'string')
  assert.strictEqual(sig.length, 128)
  assert.strictEqual(
    await verifyP256(publicKey, commitToCbor(unsigned), sig),
    true,
    'commit signature must verify with low-S P-256',
  )
}

test('repo-core - empty repo, create, CAR round-trip, continue from CAR', async () => {
  const keypair = await generateP256Keypair()
  const repo = await Repo.create({ did: DID, signingKey: keypair.privateKey })

  assert.deepStrictEqual(repo.getHead(), { commitCid: null, rev: null })
  assert.deepStrictEqual(await repo.getRecords(), [])
  assert.strictEqual(await repo.getRecord(COLLECTION, 'missing'), null)

  const rkey1 = '3mzuyazashc22'
  const record1 = post('hello from phase1')
  const write1 = await repo.applyWrite({
    action: 'create',
    collection: COLLECTION,
    rkey: rkey1,
    record: record1,
  })

  const expectedRecordCid = await computeCID(record1)
  assert.strictEqual(write1.recordCid, expectedRecordCid)
  assert.strictEqual(write1.prevMstRoot, null)
  assert.match(write1.rev, /^[234567abcdefghijklmnopqrstuvwxyz]{13}$/)
  assert.strictEqual(write1.commit.did, DID)
  assert.strictEqual(write1.commit.version, 3)
  assert.strictEqual(write1.commit.data, write1.mstRoot)
  assert.strictEqual(write1.commit.prev, null)
  assert.strictEqual(write1.commit.rev, write1.rev)

  // MST leaf points at the record CID.
  assert.strictEqual(await repo.mst.get(`${COLLECTION}/${rkey1}`), expectedRecordCid)
  assert.strictEqual(await repo.getRecordCid(COLLECTION, rkey1), expectedRecordCid)
  assert.deepStrictEqual(await repo.getRecord(COLLECTION, rkey1), record1)

  // Incremental CAR contains exactly the commit, MST root, and record blocks.
  assert.deepStrictEqual(
    new Set(write1.newBlocks.keys()),
    new Set([write1.commitCid, write1.mstRoot, expectedRecordCid]),
  )

  await assertCommitSignature(write1.commit, keypair.publicKey)

  const tampered = { ...write1.commit, rev: nextTID(write1.rev) }
  const { sig: _sig, ...tamperedUnsigned } = tampered
  assert.strictEqual(
    await verifyP256(keypair.publicKey, commitToCbor(tamperedUnsigned), tampered.sig),
    false,
    'tampered commit must not verify',
  )

  const car1 = repo.buildCar(write1)
  const parsed1 = readCarFile(car1)
  assert.deepStrictEqual(parsed1.roots, [write1.commitCid])
  assert.deepStrictEqual(
    new Set(parsed1.blocks.keys()),
    new Set([write1.commitCid, write1.mstRoot, expectedRecordCid]),
  )
  assert.deepStrictEqual(
    parsed1.blocks.get(write1.commitCid),
    commitToCbor(write1.commit),
  )

  const decodedCommit = cborDecode(parsed1.blocks.get(write1.commitCid))
  assert.strictEqual(decodedCommit.did, DID)
  assert.strictEqual(decodedCommit.version, 3)
  assert.deepStrictEqual(decodedCommit.data, { $link: write1.mstRoot })
  assert.deepStrictEqual(decodedCommit.sig, hexToBytes(write1.commit.sig))

  // Load the repo back from the CAR.
  const repo2 = await Repo.fromCar(car1, {
    did: DID,
    signingKey: keypair.privateKey,
  })
  assert.deepStrictEqual(repo2.getHead(), {
    commitCid: write1.commitCid,
    rev: write1.rev,
  })
  assert.deepStrictEqual(await repo2.getRecord(COLLECTION, rkey1), record1)
  assert.deepStrictEqual(await repo2.getRecords(), [
    { collection: COLLECTION, rkey: rkey1, cid: expectedRecordCid, record: record1 },
  ])

  // Continue writing from the loaded repo.
  const rkey2 = '3mzuyazashc23'
  const record2 = post('second post after reload')
  const write2 = await repo2.applyWrite(
    { action: 'create', collection: COLLECTION, rkey: rkey2, record: record2 },
    (encoded) => signP256(keypair.privateKey, encoded),
  )

  assert.strictEqual(write2.prevMstRoot, write1.mstRoot)
  assert.strictEqual(write2.commit.prev, write1.commitCid)
  assert.ok(write2.rev > write1.rev, 'rev must increase monotonically')
  await assertCommitSignature(write2.commit, keypair.publicKey)

  assert.strictEqual(
    await repo2.mst.get(`${COLLECTION}/${rkey2}`),
    write2.recordCid,
  )
  assert.strictEqual((await repo2.getRecords()).length, 2)

  // Full export must be a self-contained repo CAR.
  const fullCar2 = repo2.buildFullCar()
  const fullParsed2 = readCarFile(fullCar2)
  assert.deepStrictEqual(fullParsed2.roots, [write2.commitCid])
  assert.ok(fullParsed2.blocks.has(write2.commitCid))
  assert.ok(fullParsed2.blocks.has(write2.mstRoot))
  assert.ok(fullParsed2.blocks.has(write2.recordCid))
  assert.ok(fullParsed2.blocks.has(expectedRecordCid))

  const repo3 = await Repo.fromCar(fullCar2, {
    did: DID,
    signingKey: keypair.privateKey,
  })
  assert.deepStrictEqual(repo3.getHead(), {
    commitCid: write2.commitCid,
    rev: write2.rev,
  })
  assert.deepStrictEqual(
    (await repo3.getRecords()).map((r) => r.rkey),
    [rkey1, rkey2],
  )

  // Update: the leaf must move to the new record CID.
  const updatedRecord = post('edited text')
  const write3 = await repo3.applyWrite({
    action: 'update',
    collection: COLLECTION,
    rkey: rkey1,
    record: updatedRecord,
  })
  assert.strictEqual(write3.commit.prev, write2.commitCid)
  assert.strictEqual(await repo3.getRecordCid(COLLECTION, rkey1), write3.recordCid)
  assert.strictEqual(write3.recordCid, await computeCID(updatedRecord))
  assert.deepStrictEqual(await repo3.getRecord(COLLECTION, rkey1), updatedRecord)
  await assertCommitSignature(write3.commit, keypair.publicKey)

  // Delete: the leaf is removed and the commit has no record block.
  const write4 = await repo3.applyWrite({
    action: 'delete',
    collection: COLLECTION,
    rkey: rkey1,
  })
  assert.strictEqual(write4.recordCid, null)
  assert.strictEqual(write4.commit.prev, write3.commitCid)
  assert.ok(write4.rev > write3.rev)
  assert.strictEqual(await repo3.getRecordCid(COLLECTION, rkey1), null)
  assert.strictEqual(await repo3.getRecord(COLLECTION, rkey1), null)
  assert.deepStrictEqual(
    (await repo3.getRecords()).map((r) => r.rkey),
    [rkey2],
  )
  assert.ok(!write4.newBlocks.has(write3.recordCid))
  await assertCommitSignature(write4.commit, keypair.publicKey)

  const car4 = repo3.buildCar(write4)
  const parsed4 = readCarFile(car4)
  assert.deepStrictEqual(parsed4.roots, [write4.commitCid])
  assert.ok(parsed4.blocks.has(write4.commitCid))
  assert.ok(parsed4.blocks.has(write4.mstRoot))

  const repo4 = await Repo.fromCar(repo3.buildFullCar(), {
    did: DID,
    signingKey: keypair.privateKey,
  })
  assert.strictEqual(await repo4.getRecord(COLLECTION, rkey1), null)
  assert.deepStrictEqual(await repo4.getRecord(COLLECTION, rkey2), record2)
})

test('repo-core - default signer uses repo.signingKey', async () => {
  const keypair = await generateP256Keypair()
  const repo = await Repo.create({ did: DID, signingKey: keypair.privateKey })

  const write = await repo.applyWrite({
    action: 'create',
    collection: COLLECTION,
    rkey: '3mdefaultsigner',
    record: post('default signer'),
  })

  await assertCommitSignature(write.commit, keypair.publicKey)
  assert.strictEqual(repo.getHead().commitCid, write.commitCid)
})

test('repo-core - two repos in one process are independent', async () => {
  const keyA = await generateP256Keypair()
  const keyB = await generateP256Keypair()
  const didA = 'did:web:a.phase1.test'
  const didB = 'did:web:b.phase1.test'

  const [repoA, repoB] = await Promise.all([
    Repo.create({ did: didA, signingKey: keyA.privateKey }),
    Repo.create({ did: didB, signingKey: keyB.privateKey }),
  ])

  const writeA = await repoA.applyWrite({
    action: 'create',
    collection: COLLECTION,
    rkey: '3ma',
    record: post('A'),
  })
  const writeB = await repoB.applyWrite({
    action: 'create',
    collection: COLLECTION,
    rkey: '3mb',
    record: post('B'),
  })

  assert.notStrictEqual(writeA.commitCid, writeB.commitCid)
  assert.notStrictEqual(writeA.mstRoot, writeB.mstRoot)
  assert.strictEqual(writeA.commit.prev, null)
  assert.strictEqual(writeB.commit.prev, null)
  assert.strictEqual(repoA.getHead().commitCid, writeA.commitCid)
  assert.strictEqual(repoB.getHead().commitCid, writeB.commitCid)
  assert.strictEqual(await repoA.getRecordCid(COLLECTION, '3ma'), writeA.recordCid)
  assert.strictEqual(await repoA.getRecordCid(COLLECTION, '3mb'), null)
  assert.strictEqual(await repoB.getRecordCid(COLLECTION, '3ma'), null)

  // Loading A's CAR must not leak B's blocks or head.
  const loadedA = await Repo.fromCar(repoA.buildCar(writeA), {
    did: didA,
    signingKey: keyA.privateKey,
  })
  assert.strictEqual(await loadedA.getRecordCid(COLLECTION, '3mb'), null)
  assert.strictEqual(loadedA.getHead().commitCid, writeA.commitCid)
})

test('repo-core - rejects invalid input and mismatched CARs', async () => {
  const keypair = await generateP256Keypair()
  const repo = await Repo.create({ did: DID, signingKey: keypair.privateKey })
  const write = await repo.applyWrite({
    action: 'create',
    collection: COLLECTION,
    rkey: '3minvalid',
    record: post('x'),
  })
  const car = repo.buildCar(write)

  await assert.rejects(
    Repo.fromCar(car, { did: 'did:web:wrong.test' }),
    /Repo did mismatch/,
  )
  await assert.rejects(Repo.fromCar(car, {}), /requires a did/)
  await assert.rejects(Repo.create({}), /requires a did/)

  await assert.rejects(
    repo.applyWrite({ action: 'create', collection: COLLECTION, rkey: '3mnorecord' }),
    /requires a record/,
  )
  await assert.rejects(
    repo.applyWrite({ action: 'create', collection: COLLECTION, rkey: '3minvalid', record: post('dup') }),
    /already a value/,
  )
  await assert.rejects(
    repo.applyWrite({ action: 'update', collection: COLLECTION, rkey: '3mmissing', record: post('x') }),
    /Could not find a record/,
  )
  await assert.rejects(
    repo.applyWrite({ action: 'delete', collection: COLLECTION, rkey: '3mmissing' }),
    /Could not find a record/,
  )
  await assert.rejects(
    repo.applyWrite({ action: 'move', collection: COLLECTION, rkey: '3m', record: post('x') }),
    /Unsupported write action/,
  )
  await assert.rejects(
    repo.applyWrite({ action: 'create', collection: 'bad collection', rkey: '3m', record: post('x') }),
    /Invalid MST key/,
  )

  // A CAR whose root is not present in its blocks must be rejected.
  const truncatedBlocks = new Map(readCarFile(car).blocks)
  truncatedBlocks.delete(write.commitCid)
  const badCar = createCarFile(
    write.commitCid,
    [...truncatedBlocks].map(([cid, data]) => ({ cid, data })),
  )
  await assert.rejects(Repo.fromCar(badCar, { did: DID }), /missing its root commit block/)

  // A CAR without the MST root block must be rejected.
  const noMstBlocks = new Map(readCarFile(car).blocks)
  noMstBlocks.delete(write.mstRoot)
  const noMstCar = createCarFile(
    write.commitCid,
    [...noMstBlocks].map(([cid, data]) => ({ cid, data })),
  )
  await assert.rejects(Repo.fromCar(noMstCar, { did: DID }), /missing the MST root block/)
})

test('repo-core - spike CAR loads if present', async (t) => {
  const spikeCar = path.resolve(HERE, '../.tmp/p256-spike/repo.car')
  if (!fs.existsSync(spikeCar)) {
    t.skip('spike CAR not present')
    return
  }

  const bytes = new Uint8Array(fs.readFileSync(spikeCar))
  const parsed = readCarFile(bytes)
  assert.strictEqual(parsed.roots.length, 1)

  const commit = cborDecode(parsed.blocks.get(parsed.roots[0]))
  assert.strictEqual(commit.version, 3)

  const repo = await Repo.fromCar(bytes, {
    did: commit.did,
    // No signing key needed just to read; the key would only be used for writes.
  })
  assert.deepStrictEqual(repo.getHead(), {
    commitCid: parsed.roots[0],
    rev: commit.rev,
  })
  const records = await repo.getRecords()
  assert.strictEqual(records.length, 1)
  assert.strictEqual(records[0].collection, 'app.bsky.feed.post')
})
