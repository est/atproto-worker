import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import { JournalWriter, JournalReader } from '../cli/journal.js'
import { computeCID } from '../cli/crypto.js'

const TEST_JOURNAL = './test-journal.ndjson'

test('journal - write and read', async () => {
    if (fs.existsSync(TEST_JOURNAL)) fs.unlinkSync(TEST_JOURNAL)

    const writer = new JournalWriter(TEST_JOURNAL)

    const event1 = await writer.append({
        op: 'create',
        collection: 'app.bsky.feed.post',
        rkey: 'post1',
        record: { text: 'first' }
    })

    assert.strictEqual(event1.offset, 0)
    assert.strictEqual(event1.prev, null)

    const event2 = await writer.append({
        op: 'create',
        collection: 'app.bsky.feed.post',
        rkey: 'post2',
        record: { text: 'second' }
    })

    assert.ok(event2.offset > 0)
    assert.strictEqual(event2.prev, event1.cid)

    // Reader test
    const events = writer.readAll()
    const reader = new JournalReader(events)

    assert.strictEqual(reader.events.length, 2)
    const record1 = reader.getRecord('app.bsky.feed.post', 'post1')
    assert.strictEqual(record1.record.text, 'first')

    const list = reader.listRecords('app.bsky.feed.post')
    assert.strictEqual(list.records.length, 2)

    if (fs.existsSync(TEST_JOURNAL)) fs.unlinkSync(TEST_JOURNAL)
})

test('journal - validation', async () => {
    if (fs.existsSync(TEST_JOURNAL)) fs.unlinkSync(TEST_JOURNAL)

    const writer = new JournalWriter(TEST_JOURNAL)
    await writer.append({ op: 'create', collection: 'c', rkey: 'r', record: { v: 1 } })

    const status = await writer.validate()
    assert.strictEqual(status.valid, true)

    if (fs.existsSync(TEST_JOURNAL)) fs.unlinkSync(TEST_JOURNAL)
})
