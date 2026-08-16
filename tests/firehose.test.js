import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import { Firehose, shouldAllowConnect } from '../src/firehose.js'
import { JournalWriter } from '../cli/journal.js'
import { cborEncode, cborDecode, computeCID, createCarFile } from '../src/shared.js'
import { commitCid } from '../cli/atproto.js'

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

// --- handleWebSocket-level helpers (quota protection) ---

// Node's Response rejects status 101 (the Workers runtime allows it), so wrap
// it to let the upgrade path be tested; success responses carry a
// `switchingProtocols` flag instead.
globalThis.Response = class extends Response {
    constructor(body, init) {
        if (init?.status === 101) {
            super(body, { ...init, status: 200 })
            this.switchingProtocols = true
        } else {
            super(body, init)
        }
    }
}

// Minimal WebSocketPair stand-in: Object.values(new WebSocketPair()) must
// return [client, server].
globalThis.WebSocketPair = class {
    constructor() {
        this[0] = { send() {}, close() {} }
        this[1] = { send() {}, serializeAttachment() {} }
    }
}

function fakeStorage() {
    const m = new Map()
    return {
        async get(k) { return m.get(k) },
        async put(k, v) { m.set(k, v) }
    }
}

function fakeWsState(wsList = []) {
    const state = {
        storage: fakeStorage(),
        accepted: [],
        waitUntil(p) { if (p && p.catch) p.catch(() => {}) },
        acceptWebSocket(ws) { this.accepted.push(ws) },
        getWebSockets() { return wsList }
    }
    return state
}

// Fake request object for handleWebSocket (avoids undici's forbidden-header
// rules for `Upgrade`).
function wsRequest(ip, ua) {
    const headers = new Map()
    headers.set('upgrade', 'websocket')
    if (ip) headers.set('cf-connecting-ip', ip)
    if (ua) headers.set('user-agent', ua)
    return { headers: { get: k => headers.get(k.toLowerCase()) ?? null } }
}

/**
 * Build a valid journal containing two OWNER_DID events and one foreign
 * event, returning the raw NDJSON content and the three events.
 */
async function buildJournal() {
    if (fs.existsSync(TEST_JOURNAL)) fs.unlinkSync(TEST_JOURNAL)
    const writer = new JournalWriter(TEST_JOURNAL)

    const mkCommit = (rev, prev) => ({ did: DID, version: 3, data: 'bafyreimst', rev, prev })

    const c1 = mkCommit('3aa1', null)
    const commitCid1 = await commitCid(c1)
    const e1 = await writer.append({
        op: 'create', collection: 'app.bsky.feed.post', rkey: '3p1',
        record: { text: 'one' }, did: DID, rev: '3aa1',
        recordCid: 'bafyreir1', commit: c1, commitCid: commitCid1,
        prevMstRoot: null, blocksB64: 'b25l'
    })

    const c2 = mkCommit('3aa2', commitCid1)
    const commitCid2 = await commitCid(c2)
    const e2 = await writer.append({
        op: 'create', collection: 'app.bsky.feed.post', rkey: '3p2',
        record: { text: 'two' }, did: DID, rev: '3aa2',
        recordCid: 'bafyreir2', commit: c2, commitCid: commitCid2,
        prevMstRoot: null, blocksB64: 'dHdv'
    })

    const c3 = mkCommit('3aa3', null) // independent chain for the foreign account
    const commitCid3 = await commitCid(c3)
    // per-did writer so the foreign account's event.prev starts its own chain
    const foreignWriter = new JournalWriter(TEST_JOURNAL, 'did:web:foreign')
    const e3 = await foreignWriter.append({
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

test('firehose - v1 event body carries full atproto fields', async () => {
    const commit = { did: DID, version: 3, data: 'bafyreimst', rev: '3aa1', prev: null, sig: 'x' }
    const commitCid = await computeCID(commit)
    const record = { $type: 'app.bsky.feed.post', text: 'hello' }
    const recordCid = await computeCID(record)
    const event = {
        offset: 100, time: '2026-01-01T00:00:00.000Z',
        op: 'create', collection: 'app.bsky.feed.post', rkey: '3p1',
        record,
        did: DID, rev: '3aa1',
        recordCid,
        commit,
        commitCid,
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
    assert.deepStrictEqual(body.commit, { $link: event.commitCid })
    assert.strictEqual(body.rev, '3aa1')
    assert.strictEqual(body.since, null)
    assert.strictEqual(body.prevData, null)
    assert.ok(body.blocks instanceof Uint8Array)
    assert.deepStrictEqual(Array.from(body.blocks), Array.from(new TextEncoder().encode('hello')))
    assert.deepStrictEqual(body.ops, [{
        action: 'create',
        path: 'app.bsky.feed.post/3p1',
        cid: { $link: event.recordCid }
    }])
    assert.deepStrictEqual(body.blobs, [])
})

test('firehose - v0 legacy event (cid, no commitCid) formats with empty CAR', async () => {
    const cid = await computeCID({ legacy: true })
    const event = {
        offset: 0, time: '2026-01-01T00:00:00.000Z',
        op: 'create', collection: 'app.bsky.feed.post', rkey: '3p1',
        record: { text: 'legacy' }, did: DID, rev: '3aa0',
        cid, prevRev: null
    }
    const { header, body } = decodeFrame(makeFirehose({}).formatEvent(event))

    assert.deepStrictEqual(header, { op: 1, t: '#commit' })
    assert.strictEqual(body.commit.$link, event.cid)
    assert.strictEqual(body.rev, event.rev)
    assert.deepStrictEqual(body.ops, [{ action: 'create', path: 'app.bsky.feed.post/3p1', cid: { $link: event.cid } }])
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

    // All journal events pass through (the journal only ever contains
    // CLI-authored, hosted-account events; multi-account PDS emits them all).
    assert.strictEqual(ws.sent.length, 3)
    const seqs = ws.sent.map(m => decodeFrame(m).body.seq)
    assert.deepStrictEqual(seqs, [e1.offset, e2.offset, e3.offset])
    // Cursor advances past the last journal offset
    assert.deepStrictEqual(ws.attachment, { cursor: e3.offset })
})

test('firehose - backfill with cursor N delivers only later events', async () => {
    const { content, e1, e2, e3 } = await buildJournal()
    const ws = fakeWs()
    const firehose = makeFirehose({ JOURNAL_CONTENT: content, OWNER_DID: DID })
    await firehose.backfill(ws, e1.offset)

    assert.strictEqual(ws.sent.length, 2)
    const bodies = ws.sent.map(m => decodeFrame(m).body)
    assert.deepStrictEqual(bodies.map(b => b.seq), [e2.offset, e3.offset])
    assert.strictEqual(bodies[0].commit.$link, e2.commitCid)
})

test('firehose - broadcast filters foreign events and formats frames', async () => {
    const { content, e1, e2, e3 } = await buildJournal()
    const ws = fakeWs()
    const firehose = makeFirehose({ JOURNAL_CONTENT: content, OWNER_DID: DID }, ws)

    await firehose.broadcast([e1, e2, e3])

    assert.strictEqual(ws.sent.length, 2)
    const bodies = ws.sent.map(m => decodeFrame(m).body)
    assert.deepStrictEqual(bodies.map(b => b.seq), [e1.offset, e2.offset])
    assert.deepStrictEqual(bodies.map(b => b.commit.$link), [e1.commitCid, e2.commitCid])
})

test('firehose - broadcast uses the passed ownerDid and does not drop events when unset', async () => {
    const CID = 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq'
    const evt = (offset) => ({ offset, did: DID, time: 't', op: 'create', collection: 'app.bsky.feed.post', rkey: `r${offset}`, rev: `3aa${offset}`, prevRev: null, commitCid: CID, blocksB64: 'eA==' })

    // no env OWNER_DID (deploy-button config): the worker passes ownerDid
    const ws1 = fakeWs()
    const fh1 = new Firehose(fakeWsState([ws1]), { JOURNAL_CONTENT: '', OWNER_DID: undefined })
    await fh1.broadcast([evt(1)], DID)
    assert.strictEqual(ws1.sent.length, 1, 'ownerDid param must filter correctly')

    // neither env nor param: fail-open (pass everything), never silently drop
    const ws2 = fakeWs()
    const fh2 = new Firehose(fakeWsState([ws2]), { JOURNAL_CONTENT: '', OWNER_DID: undefined })
    await fh2.broadcast([evt(1)])
    assert.strictEqual(ws2.sent.length, 1, 'unset owner must not filter everything out')
})

test('firehose - error frame has op=-1 header', () => {
    const firehose = makeFirehose({})
    const frame = firehose.sendErrorFrame('InternalError', 'boom')

    const { header, body } = decodeFrame(frame)
    assert.deepStrictEqual(header, { op: -1 })
    assert.deepStrictEqual(body, { error: 'InternalError', message: 'boom' })
})

test('firehose - shouldAllowConnect allows up to the window limit then blocks', () => {
    const now = 1_000_000
    let attempts = []
    for (let i = 0; i < 8; i++) {
        const r = shouldAllowConnect(attempts, now)
        assert.strictEqual(r.allowed, true, `attempt ${i} should be allowed`)
        attempts = [...r.recent, now + i]
    }
    assert.strictEqual(shouldAllowConnect(attempts, now + 8).allowed, false)
})

test('firehose - shouldAllowConnect forgets attempts outside the window', () => {
    const now = 1_000_000
    const r = shouldAllowConnect([now - 120_000, now - 90_000], now)
    assert.strictEqual(r.allowed, true)
    assert.deepStrictEqual(r.recent, [])
})

test('firehose - handleWebSocket rate-limits rapid reconnects from same IP', async () => {
    const firehose = new Firehose(fakeWsState(), { JOURNAL_CONTENT: '', OWNER_DID: DID })
    const url = new URL('http://localhost/subscribe')

    let last
    for (let i = 0; i < 8; i++) {
        last = await firehose.handleWebSocket(wsRequest('1.2.3.4', 'indigo-relay'), url)
    }
    assert.strictEqual(last.switchingProtocols, true)

    const rejected = await firehose.handleWebSocket(wsRequest('1.2.3.4', 'indigo-relay'), url)
    assert.strictEqual(rejected.status, 429)

    // a different IP is unaffected
    const other = await firehose.handleWebSocket(wsRequest('5.6.7.8', 'indigo-relay'), url)
    assert.strictEqual(other.switchingProtocols, true)
})

test('firehose - handleWebSocket rejects when concurrent socket cap is reached', async () => {
    const open = Array.from({ length: 8 }, () => ({ send() {} }))
    const firehose = new Firehose(fakeWsState(open), {})
    const res = await firehose.handleWebSocket(wsRequest('9.9.9.9'), new URL('http://localhost/subscribe'))
    assert.strictEqual(res.status, 503)
})

test('firehose - handleWebSocket requires a websocket upgrade', async () => {
    const firehose = new Firehose(fakeWsState(), {})
    const req = { headers: { get: () => null } }
    const res = await firehose.handleWebSocket(req, new URL('http://localhost/subscribe'))
    assert.strictEqual(res.status, 426)
})

test('firehose - global connect cap protects against multi-IP floods', async () => {
    const firehose = new Firehose(fakeWsState(), { JOURNAL_CONTENT: '', OWNER_DID: DID })
    const url = new URL('http://localhost/subscribe')

    let last
    for (let i = 0; i < 15; i++) {
        last = await firehose.handleWebSocket(wsRequest(`10.0.0.${i}`, 'bot'), url)
    }
    assert.strictEqual(last.switchingProtocols, true)

    const rejected = await firehose.handleWebSocket(wsRequest('10.0.0.99', 'bot'), url)
    assert.strictEqual(rejected.status, 429)
})

test('firehose - per-IP socket cap rejects a second socket from the same IP', async () => {
    const open = Array.from({ length: 2 }, () => ({
        deserializeAttachment: () => ({ ip: '1.1.1.1' })
    }))
    const firehose = new Firehose(fakeWsState(open), { JOURNAL_CONTENT: '', OWNER_DID: DID })

    // same IP already holds 2 sockets -> 503
    const same = await firehose.handleWebSocket(wsRequest('1.1.1.1'), new URL('http://localhost/subscribe'))
    assert.strictEqual(same.status, 503)

    // a different IP is fine (2 open < global cap 8)
    const other = await firehose.handleWebSocket(wsRequest('2.2.2.2'), new URL('http://localhost/subscribe'))
    assert.strictEqual(other.switchingProtocols, true)
})

test('firehose - /broadcast persists cursor in DO storage, /cursor reads it', async () => {
    const firehose = new Firehose(fakeWsState(), { OWNER_DID: DID })
    const evt = (offset) => ({
        offset, did: DID, time: 't', op: 'create',
        collection: 'app.bsky.feed.post', rkey: `r${offset}`, rev: `3aa${offset}`,
        prevRev: null, commitCid: 'bafyreicomm' + offset, blocksB64: 'aGVsbG8='
    })

    await firehose.fetch(new Request('http://localhost/broadcast', {
        method: 'POST',
        body: JSON.stringify({ events: [evt(5), evt(6)] }),
        headers: { 'Content-Type': 'application/json' }
    }))

    const cur = await firehose.fetch(new Request('http://localhost/cursor'))
    assert.strictEqual(cur.status, 200)
    assert.deepStrictEqual(await cur.json(), { cursor: 6 })
})

test('firehose - unexpected client message closes the socket', async () => {
    let closed = false
    const ws = { close: () => { closed = true } }
    const firehose = makeFirehose({})
    await firehose.webSocketMessage(ws, 'garbage')
    assert.strictEqual(closed, true)
})

test('firehose - backfill pages through more than 1000 events', async () => {
    const JOURNAL = './test-firehose-big-journal.ndjson'
    if (fs.existsSync(JOURNAL)) fs.unlinkSync(JOURNAL)
    const writer = new JournalWriter(JOURNAL)

    const N = 1005
    for (let i = 0; i < N; i++) {
        await writer.append({
            op: 'create', collection: 'app.bsky.feed.post', rkey: `3p${i}`,
            record: { text: `post ${i}` }, did: DID, rev: `3aa${i}`
        })
    }
    const content = fs.readFileSync(JOURNAL, 'utf-8')
    fs.unlinkSync(JOURNAL)

    const ws = fakeWs()
    const firehose = makeFirehose({ JOURNAL_CONTENT: content, OWNER_DID: DID })
    await firehose.backfill(ws, -1)

    assert.strictEqual(ws.sent.length, N)
    const lastEvent = content.trim().split('\n').map(JSON.parse).pop()
    assert.deepStrictEqual(ws.attachment, { cursor: lastEvent.offset })
})
