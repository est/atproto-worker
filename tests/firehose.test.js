import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import { Firehose } from '../src/firehose.js'
import { JournalWriter } from '../cli/journal.js'
import { cborEncode, cborDecode, computeCID, createCarFile } from '../src/shared.js'

const DID = 'did:web:test.local'
const TEST_JOURNAL = './test-firehose-journal.ndjson'

/**
 * subscribeRepos frames are CBOR(header) + CBOR(body) concatenated.
 * cborDecode parses the first value and ignores trailing bytes, and the
 * encoder is canonical, so re-encoding the decoded header yields the exact
 * header byte length.
 */
function decodeFrame(frame) {
    const header = cborDecode(frame)
    const headerBytes = cborEncode(header)
    const body = cborDecode(frame.slice(headerBytes.length))
    return { header, body }
}

function fakeWs() {
    return {
        sent: [],
        attachment: null,
        send(msg) { this.sent.push(msg) },
        serializeAttachment(att) { this.attachment = att }
    }
}

function fakeState(ws) {
    return {
        waitUntil() {},
        acceptWebSocket() {},
        getWebSockets() { return ws ? [ws] : [] }
    }
}

function makeFirehose(env, ws) {
    return new Firehose(fakeState(ws), env)
}

/**
 * Build a valid journal containing two OWNER_DID events and one foreign
 * event, returning the raw NDJSON content and the three events.
 */
async function buildJournal() {
    if (fs.existsSync(TEST_JOURNAL)) fs.unlinkSync(TEST_JOURNAL)
    const writer = new JournalWriter(TEST_JOURNAL)

    const mkCommit = (rev, prev) => ({ did: DID, version: 3, data: 'bafyreimst', rev, prev, sig: 'x' })

    const c1 = mkCommit('3aa1', null)
    const commitCid1 = await computeCID(c1)
    const e1 = await writer.append({
        op: 'create', collection: 'app.bsky.feed.post', rkey: '3p1',
        record: { text: 'one' }, did: DID, rev: '3aa1',
        recordCid: 'bafyreir1', commit: c1, commitCid: commitCid1,
        prevMstRoot: null, blocksB64: 'b25l'
    })

    const c2 = mkCommit('3aa2', commitCid1)
    const commitCid2 = await computeCID(c2)
    const e2 = await writer.append({
        op: 'create', collection: 'app.bsky.feed.post', rkey: '3p2',
        record: { text: 'two' }, did: DID, rev: '3aa2',
        recordCid: 'bafyreir2', commit: c2, commitCid: commitCid2,
        prevMstRoot: null, blocksB64: 'dHdv'
    })

    const c3 = mkCommit('3aa3', commitCid2)
    const commitCid3 = await computeCID(c3)
    const e3 = await writer.append({
        op: 'create', collection: 'app.bsky.feed.post', rkey: '3p3',
        record: { text: 'three' }, did: 'did:web:foreign', rev: '3aa3',
        recordCid: 'bafyreir3', commit: c3, commitCid: commitCid3,
        prevMstRoot: null, blocksB64: 'dGhyZWU='
    })

    const content = fs.readFileSync(TEST_JOURNAL, 'utf-8')
    fs.unlinkSync(TEST_JOURNAL)
    return { content, e1, e2, e3 }
}

test('firehose - frame header is op=1 t=#commit', () => {
    const firehose = makeFirehose({})
    const frame = firehose.formatEvent({
        offset: 100, time: '2026-01-01T00:00:00.000Z',
        op: 'create', collection: 'app.bsky.feed.post', rkey: '3p1',
        did: DID, rev: '3aa1', commitCid: 'bafyreicomm1',
        prevRev: null, prevMstRoot: null, blocksB64: 'aGVsbG8='
    })

    const { header, body } = decodeFrame(frame)
    assert.deepStrictEqual(header, { op: 1, t: '#commit' })
    assert.strictEqual(body.seq, 100)
})

test('firehose - v1 event body carries full atproto fields', () => {
    const event = {
        offset: 100, time: '2026-01-01T00:00:00.000Z',
        op: 'create', collection: 'app.bsky.feed.post', rkey: '3p1',
        record: { $type: 'app.bsky.feed.post', text: 'hello' },
        did: DID, rev: '3aa1',
        recordCid: 'bafyreir1',
        commit: { did: DID, version: 3, data: 'bafyreimst', rev: '3aa1', prev: null, sig: 'x' },
        commitCid: 'bafyreicomm1',
        prevRev: null, prevMstRoot: null,
        blocksB64: 'aGVsbG8=' // "hello"
    }
    const { header, body } = decodeFrame(makeFirehose({}).formatEvent(event))

    assert.deepStrictEqual(header, { op: 1, t: '#commit' })
    assert.strictEqual(body.seq, event.offset)
    assert.strictEqual(body.time, event.time)
    assert.strictEqual(body.rebase, false)
    assert.strictEqual(body.tooBig, false)
    assert.strictEqual(body.repo, DID)
    assert.strictEqual(body.commit, event.commitCid)
    assert.strictEqual(body.rev, '3aa1')
    assert.strictEqual(body.since, null)
    assert.strictEqual(body.prevData, null)
    assert.ok(body.blocks instanceof Uint8Array)
    assert.deepStrictEqual(Array.from(body.blocks), Array.from(new TextEncoder().encode('hello')))
    assert.deepStrictEqual(body.ops, [{
        action: 'create',
        path: 'app.bsky.feed.post/3p1',
        cid: event.recordCid
    }])
    assert.deepStrictEqual(body.blobs, [])
})

test('firehose - v0 legacy event (cid, no commitCid) formats with empty CAR', async () => {
    const event = {
        offset: 0, time: '2026-01-01T00:00:00.000Z',
        op: 'create', collection: 'app.bsky.feed.post', rkey: '3p1',
        record: { text: 'legacy' }, did: DID, rev: '3aa0',
        cid: 'bafyreilegacy', prevRev: null
    }
    const { header, body } = decodeFrame(makeFirehose({}).formatEvent(event))

    assert.deepStrictEqual(header, { op: 1, t: '#commit' })
    assert.strictEqual(body.commit, event.cid)
    assert.strictEqual(body.rev, event.rev)
    assert.deepStrictEqual(body.ops, [{ action: 'create', path: 'app.bsky.feed.post/3p1', cid: event.cid }])
    // Legacy body ships an empty CAR rooted at the event CID
    const expectedCar = createCarFile(event.cid, [])
    assert.deepStrictEqual(body.blocks, expectedCar)
})

test('firehose - delete op carries null cid', () => {
    const event = {
        offset: 200, time: '2026-01-01T00:00:00.000Z',
        op: 'delete', collection: 'app.bsky.feed.post', rkey: '3pdel',
        did: DID, rev: '3aa9', commitCid: 'bafyreicomm9',
        prevRev: '3aa8', prevMstRoot: null, blocksB64: 'ZGVs'
    }
    const { body } = decodeFrame(makeFirehose({}).formatEvent(event))
    assert.deepStrictEqual(body.ops, [{ action: 'delete', path: 'app.bsky.feed.post/3pdel', cid: null }])
})

test('firehose - backfill with null cursor delivers full history', async () => {
    const { content, e1, e2, e3 } = await buildJournal()
    const ws = fakeWs()
    const firehose = makeFirehose({ JOURNAL_CONTENT: content, OWNER_DID: DID })
    await firehose.backfill(ws, -1)

    assert.strictEqual(ws.sent.length, 2)
    const seqs = ws.sent.map(m => decodeFrame(m).body.seq)
    assert.deepStrictEqual(seqs, [e1.offset, e2.offset])
    // Cursor advances past the last journal offset (even foreign-did events)
    assert.deepStrictEqual(ws.attachment, { cursor: e3.offset })
})

test('firehose - backfill with cursor N delivers only later events', async () => {
    const { content, e1, e2 } = await buildJournal()
    const ws = fakeWs()
    const firehose = makeFirehose({ JOURNAL_CONTENT: content, OWNER_DID: DID })
    await firehose.backfill(ws, e1.offset)

    assert.strictEqual(ws.sent.length, 1)
    const { header, body } = decodeFrame(ws.sent[0])
    assert.deepStrictEqual(header, { op: 1, t: '#commit' })
    assert.strictEqual(body.seq, e2.offset)
    assert.strictEqual(body.commit, e2.commitCid)
})

test('firehose - broadcast filters foreign events and formats frames', async () => {
    const { content, e1, e2, e3 } = await buildJournal()
    const ws = fakeWs()
    const firehose = makeFirehose({ JOURNAL_CONTENT: content, OWNER_DID: DID }, ws)

    await firehose.broadcast([e1, e2, e3])

    assert.strictEqual(ws.sent.length, 2)
    const bodies = ws.sent.map(m => decodeFrame(m).body)
    assert.deepStrictEqual(bodies.map(b => b.seq), [e1.offset, e2.offset])
    assert.deepStrictEqual(bodies.map(b => b.commit), [e1.commitCid, e2.commitCid])
})

test('firehose - error frame has op=-1 header', () => {
    const firehose = makeFirehose({})
    const frame = firehose.sendErrorFrame('InternalError', 'boom')

    const { header, body } = decodeFrame(frame)
    assert.deepStrictEqual(header, { op: -1 })
    assert.deepStrictEqual(body, { error: 'InternalError', message: 'boom' })
})
