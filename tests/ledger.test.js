import test from 'node:test'
import assert from 'node:assert'
import { DatabaseSync } from 'node:sqlite'

import { Firehose } from '../src/firehose.js'
import { Journal } from '../src/journal.js'
import { handleXrpc } from '../src/xrpc.js'
import { MST } from '../cli/mst.js'
import { generateP256Keypair, signP256 } from '../src/keys.js'
import {
  buildUnsignedCommit,
  signCommit,
  commitToCbor,
  commitCid as computeCommitCid,
  computeCID
} from '../src/commit.js'
import {
  cborEncode,
  cborDecode,
  createCarFile,
  bytesToBase64,
  nextTID
} from '../src/shared.js'

const DID_A = 'did:web:a.phase2.test'
const DID_B = 'did:web:b.phase2.test'
const COLLECTION = 'app.bsky.feed.post'

/**
 * Minimal `state.storage.sql` shim backed by Node's built-in SQLite. The
 * Cloudflare API is synchronous and returns a cursor with toArray()/one()
 * and iteration; that is all the ledger DO uses.
 */
function makeSqlShim() {
  const db = new DatabaseSync(':memory:')
  return {
    _db: db,
    exec(sql, ...bindings) {
      const stmt = db.prepare(sql)
      const columns = stmt.columns()
      if (columns.length > 0) {
        return cursor(stmt.all(...bindings))
      }
      stmt.run(...bindings)
      return cursor([])
    }
  }
}

function cursor(rows) {
  return {
    toArray: () => rows,
    // Cloudflare's `.one()` throws on an empty result set (unlike a plain
    // Node SQLite shim). Match that behavior so production-only bugs surface
    // in tests too. Prefer `.toArray()[0]` / the DO's `one()` helper.
    one: () => {
      if (rows.length === 0) throw new Error('Expected exactly one result from SQL query, but got no results.')
      return rows[0]
    },
    [Symbol.iterator]: () => rows[Symbol.iterator]()
  }
}

function fakeWs() {
  return {
    sent: [],
    attachment: null,
    send(msg) { this.sent.push(msg) },
    serializeAttachment(att) { this.attachment = att }
  }
}

function makeLedger({ sockets = [] } = {}) {
  const kv = new Map()
  const sql = makeSqlShim()
  const state = {
    storage: {
      sql,
      get: async key => kv.get(key),
      put: async (key, value) => { kv.set(key, value) }
    },
    waitUntil() {},
    acceptWebSocket() {},
    getWebSockets() { return sockets }
  }
  const env = {}
  const firehose = new Firehose(state, env)
  return { firehose, sql, state, kv, env, sockets }
}

function decodeFrame(frame) {
  const header = cborDecode(frame)
  const headerBytes = cborEncode(header)
  const body = cborDecode(frame.slice(headerBytes.length))
  return { header, body }
}

async function makeEvent({ did, prev = null, rev = null, rkey = '3p1', text = 'hello', offset } = {}) {
  const record = { $type: COLLECTION, text, createdAt: '2026-11-09T00:00:00.000Z' }
  const recordCid = await computeCID(record)
  const mstRoot = await computeCID({ mst: `${did}/${rkey}/${rev || 'r'}` })
  const commit = {
    did,
    version: 3,
    data: mstRoot,
    rev: rev || nextTID(null),
    prev,
    sig: '00'.repeat(64)
  }
  const commitCid = await computeCommitCid(commit)
  return {
    offset,
    op: 'create',
    collection: COLLECTION,
    rkey,
    record,
    did,
    rev: commit.rev,
    recordCid,
    commit,
    commitCid,
    mstRoot,
    prev,
    prevMstRoot: null,
    prevRev: null,
    time: '2026-11-09T00:00:00.000Z',
    // formatEvent only needs valid base64 bytes here; the DO does not parse it.
    blocksB64: bytesToBase64(cborEncode(record))
  }
}

async function makeSignedEvent({ did, key, head = null, rkey = '3p1', text = 'hello' }) {
  const blockstore = new Map()
  let mst = await MST.create(blockstore, [], 0)
  const record = { $type: COLLECTION, text, createdAt: '2026-11-09T00:00:00.000Z' }
  const recordCid = await computeCID(record)
  mst = await mst.add(`${COLLECTION}/${rkey}`, recordCid)
  const { root: mstRoot, blocks } = await mst.getUnstoredBlocks()
  blocks.set(recordCid, cborEncode(record))

  const rev = nextTID(head?.rev || null)
  const unsigned = buildUnsignedCommit(did, mstRoot, rev, head?.commitCid || null)
  const commit = await signCommit(unsigned, encoded => signP256(key.privateKey, encoded))
  const commitCid = await computeCommitCid(commit)
  blocks.set(commitCid, commitToCbor(commit))
  const car = createCarFile(commitCid, [...blocks].map(([cid, data]) => ({ cid, data })))

  return {
    event: {
      did,
      op: 'create',
      collection: COLLECTION,
      rkey,
      record,
      recordCid,
      rev,
      commit,
      commitCid,
      mstRoot,
      blocksB64: bytesToBase64(car),
      signingKey: key.publicKeyMultibase
    },
    head: { commitCid, rev, mstRoot }
  }
}

async function seedLedger(ledger, events) {
  const response = await ledger.firehose.fetch(new Request('http://ledger/seed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-ndjson' },
    body: events.map(e => JSON.stringify(e)).join('\n') + '\n'
  }))
  return { response, data: await response.json() }
}

async function appendEvent(ledger, event, expectedHead, expectedRev) {
  const response = await ledger.firehose.fetch(new Request('http://ledger/append', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, expectedHead, expectedRev })
  }))
  return { response, data: await response.json() }
}

async function snapshot(ledger, after) {
  const suffix = after === undefined ? '' : `?after=${after}`
  const response = await ledger.firehose.fetch(new Request(`http://ledger/snapshot${suffix}`))
  const text = await response.text()
  return text.trim() ? text.trim().split('\n').map(line => JSON.parse(line)) : []
}

test('ledger - seed preserves offsets as seq and is idempotent', async () => {
  const ledger = makeLedger()
  const a1 = await makeEvent({ did: DID_A, offset: 0, rev: '3aaaaaaaaaaab', rkey: 'r1' })
  const a2 = await makeEvent({ did: DID_A, offset: 1595, rev: '3aaaaaaaaaaac', rkey: 'r2', prev: a1.commitCid })
  const b1 = await makeEvent({ did: DID_B, offset: 2000, rev: '3bbbbbbbbbbbc', rkey: 'rb1' })

  const first = await seedLedger(ledger, [a1, a2, b1])
  assert.strictEqual(first.response.status, 200)
  assert.strictEqual(first.data.imported, 3)
  assert.strictEqual(first.data.total, 3)

  const events = await snapshot(ledger)
  assert.deepStrictEqual(events.map(e => e.offset), [0, 1595, 2000])
  assert.strictEqual(events[0].v, 2) // seed marks v1 journal rows as schema v2

  const headA = await (await ledger.firehose.fetch(new Request(`http://ledger/head?did=${encodeURIComponent(DID_A)}`))).json()
  assert.deepStrictEqual(headA, {
    commitCid: a2.commitCid,
    rev: a2.rev,
    seq: 1595,
    mstRoot: a2.mstRoot
  })
  const headB = await (await ledger.firehose.fetch(new Request(`http://ledger/head?did=${encodeURIComponent(DID_B)}`))).json()
  assert.strictEqual(headB.seq, 2000)

  const stats = await (await ledger.firehose.fetch(new Request('http://ledger/stats'))).json()
  assert.deepStrictEqual(stats, { maxSeq: 2000, eventCount: 3 })

  const second = await seedLedger(ledger, [a1, a2, b1])
  assert.strictEqual(second.data.imported, 0)
  assert.strictEqual(second.data.alreadySeeded, true)
  assert.strictEqual(second.data.total, 3)

  const schema = ledger.sql._db.prepare("SELECT v FROM meta WHERE k = 'schema_version'").get()
  assert.strictEqual(schema.v, '2')
})

test('ledger - append assigns max(seq)+1, updates the head, and broadcasts', async () => {
  const ws = fakeWs()
  const ledger = makeLedger({ sockets: [ws] })
  // Legacy OWNER_DID must not filter another hosted account's append.
  ledger.env.OWNER_DID = DID_B
  const a1 = await makeEvent({ did: DID_A, offset: 0, rev: '3aaaaaaaaaaab', rkey: 'r1' })
  await seedLedger(ledger, [a1])

  const rev = nextTID(a1.rev)
  const next = await makeEvent({ did: DID_A, prev: a1.commitCid, rev, rkey: 'r2' })
  const { response, data } = await appendEvent(ledger, next, a1.commitCid, a1.rev)

  assert.strictEqual(response.status, 200)
  assert.strictEqual(data.ok, true)
  assert.strictEqual(data.event.offset, 1)
  assert.strictEqual(data.event.prev, a1.commitCid)
  assert.strictEqual(data.event.prevRev, a1.rev)
  assert.strictEqual(data.event.prevMstRoot, a1.mstRoot)
  assert.strictEqual(data.event.v, 2)
  assert.ok(data.event.time)
  assert.deepStrictEqual(data.head, {
    did: DID_A,
    commitCid: next.commitCid,
    rev,
    seq: 1,
    mstRoot: next.mstRoot
  })

  // The append path broadcasts immediately and advances the cursor.
  assert.strictEqual(ws.sent.length, 1)
  const { header, body } = decodeFrame(ws.sent[0])
  assert.deepStrictEqual(header, { op: 1, t: '#commit' })
  assert.strictEqual(body.seq, 1)
  assert.strictEqual(body.repo, DID_A)
  assert.deepStrictEqual(body.commit, { $link: next.commitCid })
  const cursor = await (await ledger.firehose.fetch(new Request('http://ledger/cursor'))).json()
  assert.strictEqual(cursor.cursor, 1)

  const stored = await snapshot(ledger, a1.offset)
  assert.strictEqual(stored.length, 1)
  assert.strictEqual(stored[0].commitCid, next.commitCid)
})

test('ledger - append is idempotent by commitCid (no duplicate broadcast)', async () => {
  const ws = fakeWs()
  const ledger = makeLedger({ sockets: [ws] })
  const a1 = await makeEvent({ did: DID_A, offset: 0, rev: '3aaaaaaaaaaab', rkey: 'r1' })
  await seedLedger(ledger, [a1])

  const next = await makeEvent({ did: DID_A, prev: a1.commitCid, rev: nextTID(a1.rev), rkey: 'r2' })
  const first = await appendEvent(ledger, next, a1.commitCid, a1.rev)
  assert.strictEqual(first.response.status, 200)
  assert.strictEqual(ws.sent.length, 1)

  // Replay with a now-stale expected head: dedupe happens before the CAS.
  const replay = await appendEvent(ledger, next, a1.commitCid, a1.rev)
  assert.strictEqual(replay.response.status, 200)
  assert.strictEqual(replay.data.duplicate, true)
  assert.strictEqual(replay.data.event.offset, first.data.event.offset)
  assert.strictEqual(ws.sent.length, 1, 'replay must not broadcast again')

  const lookup = await (await ledger.firehose.fetch(
    new Request(`http://ledger/event?commitCid=${encodeURIComponent(next.commitCid)}`)
  )).json()
  assert.strictEqual(lookup.event.commitCid, next.commitCid)
  assert.strictEqual(lookup.head.commitCid, next.commitCid)
})

test('ledger - append returns 409 with the current head on CAS failure', async () => {
  const ledger = makeLedger()
  const a1 = await makeEvent({ did: DID_A, offset: 0, rev: '3aaaaaaaaaaab', rkey: 'r1' })
  await seedLedger(ledger, [a1])

  const next = await makeEvent({ did: DID_A, prev: a1.commitCid, rev: nextTID(a1.rev), rkey: 'r2' })
  const { response, data } = await appendEvent(ledger, next, 'bafyreiwronghead', a1.rev)
  assert.strictEqual(response.status, 409)
  assert.strictEqual(data.error, 'RepoConflict')
  assert.strictEqual(data.head.commitCid, a1.commitCid)
  assert.strictEqual(data.head.rev, a1.rev)
})

test('ledger - first append to an empty repo is accepted with a null head', async () => {
  const ledger = makeLedger()
  const first = await makeEvent({ did: DID_B, rev: '3bbbbbbbbbbbc', rkey: 'rb1' })
  const { response, data } = await appendEvent(ledger, first, null, null)
  assert.strictEqual(response.status, 200)
  assert.strictEqual(data.event.offset, 0)
  assert.strictEqual(data.event.prev, null)
  assert.strictEqual(data.head.commitCid, first.commitCid)
})

test('ledger - backfill reads from SQL and pages past the cursor', async () => {
  const ledger = makeLedger()
  const a1 = await makeEvent({ did: DID_A, offset: 0, rev: '3aaaaaaaaaaab', rkey: 'r1' })
  const a2 = await makeEvent({ did: DID_A, offset: 10, rev: '3aaaaaaaaaaac', rkey: 'r2', prev: a1.commitCid })
  const b1 = await makeEvent({ did: DID_B, offset: 20, rev: '3bbbbbbbbbbbc', rkey: 'rb1' })
  await seedLedger(ledger, [a1, a2, b1])

  const ws = fakeWs()
  await ledger.firehose.backfill(ws, -1)
  assert.strictEqual(ws.sent.length, 3)
  assert.deepStrictEqual(ws.sent.map(f => decodeFrame(f).body.seq), [0, 10, 20])
  assert.deepStrictEqual(ws.attachment, { cursor: 20 })

  const tail = fakeWs()
  await ledger.firehose.backfill(tail, 10)
  assert.strictEqual(tail.sent.length, 1)
  assert.strictEqual(decodeFrame(tail.sent[0]).body.seq, 20)
  assert.deepStrictEqual(tail.attachment, { cursor: 20 })
})

test('ledger - /broadcast uses the explicit hosted DID set', async () => {
  const ws = fakeWs()
  const ledger = makeLedger({ sockets: [ws] })
  const a1 = await makeEvent({ did: DID_A, rev: '3aaaaaaaaaaab', rkey: 'r1' })
  const b1 = await makeEvent({ did: DID_B, rev: '3bbbbbbbbbbbc', rkey: 'rb1' })

  await ledger.firehose.fetch(new Request('http://ledger/broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: [a1, b1], dids: [DID_A, DID_B] })
  }))
  assert.strictEqual(ws.sent.length, 2)

  ws.sent.length = 0
  await ledger.firehose.fetch(new Request('http://ledger/broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: [a1, b1], ownerDid: DID_B })
  }))
  assert.strictEqual(ws.sent.length, 1)
  assert.strictEqual(decodeFrame(ws.sent[0]).body.repo, DID_B)
})

test('ledger - Journal loads from the ledger and refreshes after an append', async () => {
  const ledger = makeLedger()
  const a1 = await makeEvent({ did: DID_A, offset: 0, rev: '3aaaaaaaaaaab', rkey: 'r1' })
  await seedLedger(ledger, [a1])

  // A stub adapter so Journal sees the same DO implementation.
  const binding = {
    idFromName: () => 'main',
    get: () => ({
      fetch: (url, opts) => ledger.firehose.fetch(new Request(url, opts))
    })
  }
  const env = { FIREHOSE: binding }

  const journal = new Journal(env)
  await journal.load()
  assert.strictEqual(journal.events.length, 1)
  assert.strictEqual(journal.getRecord(DID_A, COLLECTION, 'r1').record.text, 'hello')
  assert.strictEqual(journal.getCurrentSeq(), 0)

  const next = await makeEvent({ did: DID_A, prev: a1.commitCid, rev: nextTID(a1.rev), rkey: 'r2', text: 'second' })
  const appended = await appendEvent(ledger, next, a1.commitCid, a1.rev)
  assert.strictEqual(appended.response.status, 200)

  const fresh = new Journal(env)
  await fresh.load()
  assert.strictEqual(fresh.events.length, 2)
  assert.strictEqual(fresh.getRecord(DID_A, COLLECTION, 'r2').record.text, 'second')
  assert.strictEqual(fresh.getCurrentSeq(), appended.data.event.offset)
})

test('ledger - XRPC appendEvent verifies P-256 and writes through the DO', async () => {
  const ledger = makeLedger()
  const key = await generateP256Keypair()
  const didDoc = {
    id: DID_A,
    verificationMethod: [{
      id: `${DID_A}#atproto`,
      type: 'Multikey',
      publicKeyMultibase: key.publicKeyMultibase
    }]
  }
  ledger.env.ASSETS = {
    fetch: async url => {
      if (new URL(url).pathname === '/.well-known/did.json') {
        return new Response(JSON.stringify(didDoc), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    }
  }
  ledger.env.FIREHOSE = {
    idFromName: () => 'main',
    get: () => ({ fetch: (url, opts) => ledger.firehose.fetch(new Request(url, opts)) })
  }

  const journal = { events: [], loaded: true, distinctDids: () => new Set([DID_A]) }
  const ctx = { waitUntil(p) { this.pending = p } }
  const xrpc = event => new Request('http://a.phase2.test/xrpc/com.atproto.worker.appendEvent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event })
  })
  const call = event => handleXrpc(xrpc(event), {
    journal, did: DID_A, handle: 'a.phase2.test', env: ledger.env,
    hosted: new Set([DID_A]), ownHost: 'a.phase2.test', ctx
  })

  const first = await makeSignedEvent({ did: DID_A, key, rkey: 'r1', text: 'first' })
  const r1 = await call(first.event)
  const d1 = await r1.json()
  assert.strictEqual(r1.status, 200, JSON.stringify(d1))
  assert.deepStrictEqual({
    uri: d1.uri,
    cid: d1.cid,
    commit: d1.commit,
    seq: d1.seq
  }, {
    uri: `at://${DID_A}/${COLLECTION}/r1`,
    cid: first.event.recordCid,
    commit: { cid: first.event.commitCid, rev: first.event.rev },
    seq: 0
  })

  // Replay is idempotent and does not append a second event.
  const replay = await call(first.event)
  assert.strictEqual(replay.status, 200)
  assert.deepStrictEqual(await replay.json(), d1)
  assert.strictEqual((await snapshot(ledger)).length, 1)

  const head = await (await ledger.firehose.fetch(new Request(`http://ledger/head?did=${encodeURIComponent(DID_A)}`))).json()
  const second = await makeSignedEvent({ did: DID_A, key, head, rkey: 'r2', text: 'second' })
  const r2 = await call(second.event)
  const d2 = await r2.json()
  assert.strictEqual(r2.status, 200, JSON.stringify(d2))
  assert.strictEqual(d2.seq, 1)
  assert.strictEqual((await snapshot(ledger)).length, 2)
})

test('ledger - Journal falls back to ASSETS when the ledger is empty', async () => {
  const ledger = makeLedger()
  const a1 = await makeEvent({ did: DID_A, offset: 0, rev: '3aaaaaaaaaaab', rkey: 'r1' })
  const assets = {
    fetch: async () => new Response(JSON.stringify(a1) + '\n', { status: 200 })
  }
  const binding = {
    idFromName: () => 'main',
    get: () => ({
      fetch: (url, opts) => ledger.firehose.fetch(new Request(url, opts))
    })
  }
  const journal = new Journal({ FIREHOSE: binding, ASSETS: assets })
  await journal.load()
  assert.strictEqual(journal.events.length, 1)
  assert.strictEqual(journal.events[0].commitCid, a1.commitCid)
})
