import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import { JournalWriter } from '../cli/journal.js'
import { Journal } from '../src/journal.js'
import { Firehose } from '../src/firehose.js'
import { handleXrpc } from '../src/xrpc.js'
import { broadcastNewEvents } from '../src/index.js'
import { computeCID, cborEncode, cborDecode, commitToCbor } from '../src/shared.js'
import { createCar, carToBase64, commitCid } from '../cli/atproto.js'

const DID = 'did:web:e2e.local'
const TEST_JOURNAL = './test-e2e-journal.ndjson'

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
    return { waitUntil() {}, acceptWebSocket() {}, getWebSockets() { return ws ? [ws] : [] } }
}

/**
 * Write two v1 posts with real commit-object data & CAR for blocksB64.
 * Returns the events and raw NDJSON content; cleans up the file.
 */
async function writeJournal() {
    if (fs.existsSync(TEST_JOURNAL)) fs.unlinkSync(TEST_JOURNAL)
    const writer = new JournalWriter(TEST_JOURNAL)

    const mkCommit = (rev, prev) => ({ did: DID, version: 3, data: 'bafyreimst', rev, prev })
    const mkCarB64 = async (commit) => carToBase64(createCar(await commitCid(commit), [{ cid: await commitCid(commit), data: commitToCbor(commit) }]))

    // --- event 1 ---
    const c1 = mkCommit('3aa1', null)
    const commitCid1 = await commitCid(c1)
    const record1 = { $type: 'app.bsky.feed.post', text: 'hello atproto' }
    const recordCid1 = await computeCID(record1)
    const e1 = await writer.append({
        op: 'create', collection: 'app.bsky.feed.post', rkey: '3p1',
        record: record1, did: DID, rev: '3aa1', recordCid: recordCid1,
        commit: c1, commitCid: commitCid1,
        mstRoot: 'bafyreimst1', prevMstRoot: null,
        blocksB64: await mkCarB64(c1)
    })

    // --- event 2 ---
    const c2 = mkCommit('3aa2', commitCid1)
    const commitCid2 = await commitCid(c2)
    const record2 = { $type: 'app.bsky.feed.post', text: 'second post' }
    const recordCid2 = await computeCID(record2)
    const e2 = await writer.append({
        op: 'create', collection: 'app.bsky.feed.post', rkey: '3p2',
        record: record2, did: DID, rev: '3aa2', recordCid: recordCid2,
        commit: c2, commitCid: commitCid2,
        mstRoot: 'bafyreimst2', prevMstRoot: commitCid1,
        blocksB64: await mkCarB64(c2)
    })

    const content = fs.readFileSync(TEST_JOURNAL, 'utf-8')
    if (fs.existsSync(TEST_JOURNAL)) fs.unlinkSync(TEST_JOURNAL)
    return { e1, e2, content }
}

test('e2e - JournalWriter produces a valid journal', async () => {
    if (fs.existsSync(TEST_JOURNAL)) fs.unlinkSync(TEST_JOURNAL)

    const writer = new JournalWriter(TEST_JOURNAL)

    const c1 = { did: DID, version: 3, data: 'bafyreimst', rev: '3aa1', prev: null }
    const commitCid1 = await commitCid(c1)
    await writer.append({
        op: 'create', collection: 'app.bsky.feed.post', rkey: '3p1',
        record: { text: 'a' }, did: DID, rev: '3aa1', recordCid: 'r1',
        commit: c1, commitCid: commitCid1, prevMstRoot: null,
        blocksB64: carToBase64(createCar(commitCid1, [{ cid: commitCid1, data: commitToCbor(c1) }]))
    })

    const c2 = { did: DID, version: 3, data: 'bafyreimst', rev: '3aa2', prev: commitCid1 }
    const commitCid2 = await commitCid(c2)
    await writer.append({
        op: 'create', collection: 'app.bsky.feed.post', rkey: '3p2',
        record: { text: 'b' }, did: DID, rev: '3aa2', recordCid: 'r2',
        commit: c2, commitCid: commitCid2, prevMstRoot: null,
        blocksB64: carToBase64(createCar(commitCid2, [{ cid: commitCid2, data: commitToCbor(c2) }]))
    })

    // Validate chain integrity (CLI-level: CIDs + commit chain)
    const status = await writer.validate()
    assert.strictEqual(status.valid, true)
    assert.strictEqual(status.eventCount, 2)

    const all = writer.readAll()
    assert.strictEqual(all.length, 2)

    if (fs.existsSync(TEST_JOURNAL)) fs.unlinkSync(TEST_JOURNAL)
})

test('e2e - worker Journal loads, validates, indexes, serves records', async () => {
    const { e1, e2, content } = await writeJournal()

    const journal = new Journal({ JOURNAL_CONTENT: content })
    await journal.load()

    assert.strictEqual(journal.events.length, 2)
    assert.strictEqual(journal.loaded, true)

    // getRecord returns the latest event for a path
    const rec = journal.getRecord(DID, 'app.bsky.feed.post', '3p2')
    assert.ok(rec)
    assert.strictEqual(rec.record.text, 'second post')

    // getEventsFromCursor(null cursor = -1) returns all
    const all = journal.getEventsFromCursor(null)
    assert.strictEqual(all.length, 2)

    // getEventsFromCursor after e1 offset returns only e2
    const after = journal.getEventsFromCursor(e1.offset)
    assert.strictEqual(after.length, 1)
    assert.strictEqual(after[0].rkey, '3p2')

    // getCurrentSeq returns the last event's offset
    assert.strictEqual(journal.getCurrentSeq(), e2.offset)
})

test('e2e - refresh from fake ASSETS loads journal', async () => {
    const { e1, e2, content } = await writeJournal()

    const fakeAssets = {
        fetch: async () => new Response(content, { status: 200 })
    }
    const journal = new Journal({ ASSETS: fakeAssets, OWNER_DID: DID })
    const result = await journal.refresh()

    assert.strictEqual(result.eventCount, 2)
    assert.strictEqual(journal.events.length, 2)

    const rec = journal.getRecord(DID, 'app.bsky.feed.post', '3p1')
    assert.ok(rec)
    assert.strictEqual(rec.record.text, 'hello atproto')
})

test('e2e - refresh→getEventsFromCursor→firehose broadcast chain', async () => {
    const { e1, e2, content } = await writeJournal()

    // Phase 1: load with only the first event
    const lines = content.trim().split('\n')
    const content1 = lines[0] + '\n'
    const content2 = content

    let currentContent = content1
    const fakeAssets = {
        fetch: async () => new Response(currentContent, { status: 200 })
    }

    const journal = new Journal({ ASSETS: fakeAssets, OWNER_DID: DID })
    await journal.load()
    assert.strictEqual(journal.events.length, 1)

    // Phase 2: swap to full content and refresh
    currentContent = content2
    const lastOffset = journal.getCurrentSeq()
    await journal.refresh()
    assert.strictEqual(journal.events.length, 2)

    // New events retrievable via getEventsFromCursor
    const newEvents = journal.getEventsFromCursor(lastOffset)
    assert.strictEqual(newEvents.length, 1)
    assert.strictEqual(newEvents[0].commitCid, e2.commitCid)

    // Format matches firehose #commit frame
    const firehose = new Firehose(fakeState(), {})
    const frame = firehose.formatEvent(newEvents[0])
    const { header, body } = decodeFrame(frame)
    assert.deepStrictEqual(header, { op: 1, t: '#commit' })
    assert.strictEqual(body.seq, e2.offset)
    assert.strictEqual(body.repo, DID)
    assert.strictEqual(body.commit.$link, e2.commitCid)
    assert.strictEqual(body.ops[0].path, 'app.bsky.feed.post/3p2')

    // Broadcast to fake subscriber
    const ws = fakeWs()
    const fh2 = new Firehose(fakeState(ws), { OWNER_DID: DID })
    await fh2.broadcast(newEvents)

    assert.strictEqual(ws.sent.length, 1)
    const { body: bCast } = decodeFrame(ws.sent[0])
    assert.strictEqual(bCast.commit.$link, e2.commitCid)
})

test('e2e - worker rejects journal with broken commit CID chain', async () => {
    const { content } = await writeJournal()
    const lines = content.trim().split('\n')
    const tampered = lines.map(l => {
        const e = JSON.parse(l)
        if (e.commitCid) e.commitCid = 'bafyreifake'
        return JSON.stringify(e)
    }).join('\n')

    const journal = new Journal({ JOURNAL_CONTENT: tampered })
    await assert.rejects(
        () => journal.load(),
        /Commit CID mismatch/
    )
})

test('e2e - worker rejects journal with broken prev link', async () => {
    const { content } = await writeJournal()
    const lines = content.trim().split('\n')
    const parsed = lines.map(l => JSON.parse(l))
    parsed[0].prev = 'bafyreiwrong'
    const tampered = parsed.map(e => JSON.stringify(e)).join('\n')

    const journal = new Journal({ JOURNAL_CONTENT: tampered })
    await assert.rejects(
        () => journal.load(),
        /Journal chain broken/
    )
})

test('e2e - describeServer returns did + didDoc (relay HostChecker contract)', async () => {
    const { content } = await writeJournal()
    const journal = new Journal({ JOURNAL_CONTENT: content })
    await journal.load()

    // describeServer self-discovers the main identity from the static
    // .well-known/did.json (ASSETS), like the real worker.
    const fakeAssets = {
        fetch: async (url) => {
            if (new URL(url).pathname === '/.well-known/did.json') {
                return new Response(JSON.stringify({
                    id: DID,
                    verificationMethod: [{ id: `${DID}#atproto`, publicKeyMultibase: 'zQ3shXjHeiBuRCKmM36cuYnm7YEMzhGnCmCyW92sRJ9pribSF' }]
                }), { status: 200 })
            }
            return new Response('nf', { status: 404 })
        }
    }

    const res = await handleXrpc(
        new Request('http://localhost/xrpc/com.atproto.server.describeServer'),
        { journal, did: DID, handle: 'e2e.local', env: { ASSETS: fakeAssets }, ownHost: 'e2e.local' }
    )

    assert.strictEqual(res.status, 200)
    const data = await res.json()
    assert.strictEqual(data.did, DID)
    assert.strictEqual(data.didDoc.id, DID)
    assert.strictEqual(data.didDoc.service[0].type, 'AtprotoPersonalDataServer')
    assert.strictEqual(data.didDoc.service[0].serviceEndpoint, 'https://e2e.local')
    assert.deepStrictEqual(data.availableUserDomains, [])
    assert.strictEqual(data.inviteCodeRequired, false)
})

// A fake Firehose DO stub that mirrors the real one: /cursor returns the
// persisted cursor, /broadcast advances it (max, monotonic) on success.
function fakeFirehose(advanceOnBroadcast = true) {
    let cursor = -1
    const broadcasts = []
    return {
        broadcasts,
        getCursor: () => cursor,
        env: {
            FIREHOSE: {
                idFromName: () => 'main',
                get: () => ({
                    fetch: async (u, opts) => {
                        const url = new URL(u)
                        if (url.pathname === '/cursor') {
                            return new Response(JSON.stringify({ cursor }))
                        }
                        if (url.pathname === '/broadcast' && opts.method === 'POST') {
                            const events = JSON.parse(opts.body).events
                            broadcasts.push(events)
                            if (advanceOnBroadcast && events.length > 0) {
                                cursor = Math.max(cursor, events[events.length - 1].offset)
                            }
                            return new Response('OK')
                        }
                        return new Response('Not Found', { status: 404 })
                    }
                })
            }
        }
    }
}

test('e2e - broadcastNewEvents advances cursor only after a successful broadcast', async () => {
    const { content, e2 } = await writeJournal()
    const journal = new Journal({ JOURNAL_CONTENT: content })
    await journal.load()

    const fh = fakeFirehose()
    const first = await broadcastNewEvents(journal, fh.env)
    assert.strictEqual(first.length, 2)
    assert.strictEqual(fh.broadcasts.length, 1)
    assert.strictEqual(fh.getCursor(), e2.offset)

    // second run: nothing new
    const second = await broadcastNewEvents(journal, fh.env)
    assert.strictEqual(second.length, 0)
    assert.strictEqual(fh.broadcasts.length, 1)
})

test('e2e - broadcastNewEvents does not advance cursor when broadcast fails', async () => {
    const { content } = await writeJournal()
    const journal = new Journal({ JOURNAL_CONTENT: content })
    await journal.load()

    // broadcast fails -> cursor untouched, events NOT lost (retried later)
    const failing = fakeFirehose(false)
    failing.env.FIREHOSE.get = () => ({
        fetch: async (u, opts) => {
            if (new URL(u).pathname === '/cursor') {
                return new Response(JSON.stringify({ cursor: failing.getCursor() }))
            }
            return new Response('ERR', { status: 500 })
        }
    })

    const result = await broadcastNewEvents(journal, failing.env)
    assert.strictEqual(result.length, 0)
    assert.strictEqual(failing.getCursor(), -1)

    // a later successful broadcast still delivers all events
    const healthy = fakeFirehose()
    const retried = await broadcastNewEvents(journal, healthy.env)
    assert.strictEqual(retried.length, 2)
})

test('e2e - getRecord returns the record cid for v1 events', async () => {
    const { content, e2 } = await writeJournal()
    const journal = new Journal({ JOURNAL_CONTENT: content })
    await journal.load()

    const res = await handleXrpc(
        new Request(`http://localhost/xrpc/com.atproto.repo.getRecord?repo=${DID}&collection=app.bsky.feed.post&rkey=${e2.rkey}`),
        { journal, did: DID, handle: 'e2e.local', env: {} }
    )

    assert.strictEqual(res.status, 200)
    const data = await res.json()
    assert.strictEqual(data.cid, e2.recordCid)
})