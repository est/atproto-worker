import test from 'node:test'
import assert from 'node:assert'

import { MST } from '../cli/mst.js'
import {
  generateP256Keypair,
  signP256,
  multikeyEncode,
  isLowS,
  P256_N,
  bytesToBigInt,
  bigIntToBytes
} from '../src/keys.js'
import {
  buildUnsignedCommit,
  signCommit,
  commitCid as computeCommitCid,
  commitToCbor,
  computeCID
} from '../src/commit.js'
import {
  cborEncode,
  createCarFile,
  readCarFile,
  bytesToBase64,
  base64ToBytes,
  bytesToHex,
  hexToBytes,
  nextTID
} from '../src/shared.js'
import {
  validateAppendEvent,
  classifyAppend,
  AppendValidationError,
  tidToMicros
} from '../src/append.js'

const DID = 'did:web:phase2.test'
const COLLECTION = 'app.bsky.feed.post'
const keypair = await generateP256Keypair()

/**
 * Build a minimal but structurally valid repo event: a one-leaf MST, a
 * record block, a signed commit v3, and a CAR rooted at the commit.
 */
async function buildEvent({
  did = DID,
  privateKey = keypair.privateKey,
  signingKey = keypair.publicKeyMultibase,
  head = null,
  op = 'create',
  collection = COLLECTION,
  rkey = '3p1',
  record = { $type: COLLECTION, text: 'hello phase2', createdAt: '2026-11-09T00:00:00.000Z' },
  rev = null
} = {}) {
  const blockstore = new Map()
  let mst = await MST.create(blockstore, [], 0)
  let recCid = null

  if (op !== 'delete') {
    recCid = await computeCID(record)
    mst = await mst.add(`${collection}/${rkey}`, recCid)
  }

  const { root: mstRoot, blocks } = await mst.getUnstoredBlocks()
  if (recCid) blocks.set(recCid, cborEncode(record))

  const finalRev = rev || nextTID(head?.rev || null)
  const unsigned = buildUnsignedCommit(did, mstRoot, finalRev, head?.commitCid || null)
  const commit = await signCommit(unsigned, encoded => signP256(privateKey, encoded))
  const commitCid = await computeCommitCid(commit)

  blocks.set(commitCid, commitToCbor(commit))
  const car = createCarFile(commitCid, [...blocks].map(([cid, data]) => ({ cid, data })))

  return {
    event: {
      did,
      op,
      collection,
      rkey,
      record: op === 'delete' ? undefined : record,
      recordCid: recCid,
      rev: finalRev,
      commit,
      commitCid,
      mstRoot,
      blocksB64: bytesToBase64(car),
      signingKey
    },
    head: { commitCid, rev: finalRev, mstRoot }
  }
}

async function rebuildEvent(event, mutateCommit) {
  const commit = await mutateCommit({ ...event.commit })
  const commitCid = await computeCommitCid(commit)
  const car = readCarFile(base64ToBytes(event.blocksB64))
  const blocks = new Map(car.blocks)
  blocks.delete(event.commitCid)
  blocks.set(commitCid, commitToCbor(commit))
  const rebuilt = createCarFile(commitCid, [...blocks].map(([cid, data]) => ({ cid, data })))
  return { ...event, commit, commitCid, blocksB64: bytesToBase64(rebuilt) }
}

function toHighS(sigHex) {
  const sig = hexToBytes(sigHex)
  const s = bytesToBigInt(sig.slice(32))
  const high = P256_N - s
  const out = new Uint8Array(sig)
  out.set(bigIntToBytes(high, 32), 32)
  return bytesToHex(out)
}

async function expectValidationError(event, opts, status, error) {
  try {
    await validateAppendEvent(event, opts)
    assert.fail('expected validation to fail')
  } catch (e) {
    assert.ok(e instanceof AppendValidationError, `expected AppendValidationError, got ${e}`)
    if (status !== undefined) assert.strictEqual(e.status, status)
    if (error !== undefined) assert.strictEqual(e.error, error)
    return e
  }
}

test('append - happy path validates a P-256 signed event', async () => {
  const { event } = await buildEvent()
  const result = await validateAppendEvent(event, {
    head: { commitCid: null, rev: null, mstRoot: null },
    resolvedKey: keypair.publicKeyMultibase
  })
  assert.deepStrictEqual(result, { ok: true })
  assert.strictEqual(event.commit.version, 3)
  assert.strictEqual(event.commit.data, event.mstRoot)
  assert.strictEqual(event.commitCid, await computeCommitCid(event.commit))
  assert.strictEqual(event.recordCid, await computeCID(event.record))
})

test('append - second event chains onto the previous head', async () => {
  const first = await buildEvent({ rkey: '3p1' })
  const second = await buildEvent({ rkey: '3p2', head: first.head })
  await validateAppendEvent(second.event, {
    head: first.head,
    resolvedKey: keypair.publicKeyMultibase
  })
  assert.strictEqual(second.event.commit.prev, first.event.commitCid)
})

test('append - bad signature is rejected (401 BadSignature)', async () => {
  const { event } = await buildEvent()
  const bad = await rebuildEvent(event, commit => {
    const sig = '00'.repeat(64)
    assert.strictEqual(isLowS(hexToBytes(sig)), true)
    return { ...commit, sig }
  })
  await expectValidationError(bad, {
    head: { commitCid: null, rev: null },
    resolvedKey: keypair.publicKeyMultibase
  }, 401, 'BadSignature')
})

test('append - high-S signature is rejected (401 BadSignature)', async () => {
  const { event } = await buildEvent()
  const highS = await rebuildEvent(event, commit => ({
    ...commit,
    sig: toHighS(commit.sig)
  }))
  assert.strictEqual(isLowS(hexToBytes(highS.commit.sig)), false)
  await expectValidationError(highS, {
    head: { commitCid: null, rev: null },
    resolvedKey: keypair.publicKeyMultibase
  }, 401, 'BadSignature')
})

test('append - recordCid mismatch is rejected', async () => {
  const { event } = await buildEvent()
  const bad = { ...event, recordCid: await computeCID({ not: 'the record' }) }
  await expectValidationError(bad, {
    head: { commitCid: null, rev: null },
    resolvedKey: keypair.publicKeyMultibase
  }, 400, 'InvalidRecordCid')
})

test('append - commitCid mismatch is rejected', async () => {
  const { event } = await buildEvent()
  const bad = { ...event, commitCid: 'bafyreifakefakefakefakefakefakefakefakefakefakefakefakefake' }
  await expectValidationError(bad, {
    head: { commitCid: null, rev: null },
    resolvedKey: keypair.publicKeyMultibase
  }, 400, 'InvalidCommitCid')
})

test('append - wrong prev (fork) is rejected (409 RepoConflict)', async () => {
  const first = await buildEvent({ rkey: '3p1' })
  const second = await buildEvent({ rkey: '3p2', head: first.head })
  await expectValidationError(second.event, {
    head: { commitCid: 'bafyreiwronghead', rev: first.head.rev },
    resolvedKey: keypair.publicKeyMultibase
  }, 409, 'RepoConflict')
})

test('append - event.prev mismatch is rejected even if commit.prev matches', async () => {
  const first = await buildEvent({ rkey: '3p1' })
  const second = await buildEvent({ rkey: '3p2', head: first.head })
  const bad = { ...second.event, prev: 'bafyreiwrongeventprev' }
  await expectValidationError(bad, {
    head: first.head,
    resolvedKey: keypair.publicKeyMultibase
  }, 409, 'RepoConflict')
})

test('append - rev regression is rejected (409 RepoConflict)', async () => {
  const first = await buildEvent({ rkey: '3p1' })
  const second = await buildEvent({ rkey: '3p2', head: first.head })
  await expectValidationError(second.event, {
    head: { commitCid: first.head.commitCid, rev: nextTID(second.event.rev) },
    resolvedKey: keypair.publicKeyMultibase
  }, 409, 'RepoConflict')
})

test('append - rev more than 5 minutes in the future is rejected', async () => {
  const future = nextTID(nextTID(nextTID(null)))
  const { event } = await buildEvent({ rev: future })
  const futureMillis = tidToMicros(future) / 1000
  await expectValidationError(event, {
    head: { commitCid: null, rev: null },
    resolvedKey: keypair.publicKeyMultibase,
    now: futureMillis - 10 * 60 * 1000
  }, 400, 'InvalidRev')
})

test('append - K-256 signing keys are rejected (400 UnsupportedKeyType)', async () => {
  const { event } = await buildEvent()
  const k256 = multikeyEncode('k256', hexToBytes(keypair.publicKeyCompressedHex))
  const bad = { ...event, signingKey: k256 }
  await expectValidationError(bad, {
    head: { commitCid: null, rev: null },
    resolvedKey: k256
  }, 400, 'UnsupportedKeyType')
})

test('append - signing key must match the resolved DID document key', async () => {
  const { event } = await buildEvent()
  await expectValidationError(event, {
    head: { commitCid: null, rev: null },
    resolvedKey: 'zDnaeotherkey'
  }, 401, 'IdentityMismatch')
})

test('append - CAR missing the record block is rejected', async () => {
  const { event } = await buildEvent()
  const car = readCarFile(base64ToBytes(event.blocksB64))
  const blocks = new Map(car.blocks)
  blocks.delete(event.recordCid)
  const missing = createCarFile(event.commitCid, [...blocks].map(([cid, data]) => ({ cid, data })))
  const bad = { ...event, blocksB64: bytesToBase64(missing) }
  await expectValidationError(bad, {
    head: { commitCid: null, rev: null },
    resolvedKey: keypair.publicKeyMultibase
  }, 400, 'InvalidBlocks')
})

test('append - CAR missing the MST root is rejected', async () => {
  const { event } = await buildEvent()
  const car = readCarFile(base64ToBytes(event.blocksB64))
  const blocks = new Map(car.blocks)
  blocks.delete(event.mstRoot)
  const missing = createCarFile(event.commitCid, [...blocks].map(([cid, data]) => ({ cid, data })))
  const bad = { ...event, blocksB64: bytesToBase64(missing) }
  await expectValidationError(bad, {
    head: { commitCid: null, rev: null },
    resolvedKey: keypair.publicKeyMultibase
  }, 400, 'InvalidBlocks')
})

test('append - missing required fields are rejected', async () => {
  const { event } = await buildEvent()
  const bad = { ...event }
  delete bad.signingKey
  await expectValidationError(bad, {
    head: { commitCid: null, rev: null },
    resolvedKey: keypair.publicKeyMultibase
  }, 400, 'InvalidRequest')
})

test('append - classifyAppend: dedupe, conflict, and append decisions', () => {
  const existing = { event: { commitCid: 'bafyexisting' }, seq: 7 }
  assert.strictEqual(
    classifyAppend({ existing, head: { commitCid: 'bafynew', rev: '3aaaaaaaaaaaa' }, expectedHead: 'bafyold', expectedRev: '3bbbbbbbbbbbb' }).type,
    'duplicate'
  )

  assert.strictEqual(
    classifyAppend({ head: { commitCid: 'bafynew', rev: '3aaaaaaaaaaaa' }, expectedHead: 'bafyold', expectedRev: '3aaaaaaaaaaaa' }).type,
    'conflict'
  )
  assert.strictEqual(
    classifyAppend({ head: { commitCid: 'bafynew', rev: '3aaaaaaaaaaaa' }, expectedHead: 'bafynew', expectedRev: '3aaaaaaaaaaaa' }).type,
    'append'
  )
  // First event in an empty repo.
  assert.strictEqual(classifyAppend({ head: null, expectedHead: null, expectedRev: null }).type, 'append')
})
