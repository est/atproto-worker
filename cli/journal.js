/**
 * Journal management for ATProto event-sourced publisher
 * Append-only NDJSON log of signed commits
 */

import fs from 'node:fs'
import path from 'node:path'
import { computeCID, cborEncode } from './crypto.js'

const DEFAULT_JOURNAL_PATH = './journal.ndjson'

/**
 * Journal writer for appending events
 */
export class JournalWriter {
    constructor(journalPath = DEFAULT_JOURNAL_PATH) {
        this.journalPath = journalPath
        this.prevCid = null

        // Load existing journal to get prev CID
        if (fs.existsSync(journalPath)) {
            const content = fs.readFileSync(journalPath, 'utf-8').trim()
            if (content) {
                const lines = content.split('\n')
                const lastLine = lines[lines.length - 1]
                if (lastLine) {
                    const lastEvent = JSON.parse(lastLine)
                    this.prevCid = lastEvent.cid
                }
            }
        }
    }

    /**
     * Get current byte offset (for seq)
     */
    getOffset() {
        if (!fs.existsSync(this.journalPath)) {
            return 0
        }
        const stats = fs.statSync(this.journalPath)
        return stats.size
    }

    /**
     * Append a signed event to the journal
     */
    async append(event) {
        const offset = this.getOffset()

        // Add metadata
        const fullEvent = {
            offset,
            ...event,
            prev: this.prevCid,
            time: new Date().toISOString()
        }

        // Compute CID if not provided
        if (!fullEvent.cid) {
            fullEvent.cid = await computeCID({
                op: fullEvent.op,
                collection: fullEvent.collection,
                rkey: fullEvent.rkey,
                record: fullEvent.record,
                prev: fullEvent.prev
            })
        }

        // Write line
        const line = JSON.stringify(fullEvent) + '\n'
        fs.appendFileSync(this.journalPath, line)

        // Update prev
        this.prevCid = fullEvent.cid

        return fullEvent
    }

    /**
     * Read all events from journal
     */
    readAll() {
        if (!fs.existsSync(this.journalPath)) {
            return []
        }

        const content = fs.readFileSync(this.journalPath, 'utf-8').trim()
        if (!content) return []

        return content.split('\n').map(line => JSON.parse(line))
    }

    /**
     * Validate journal integrity (CID chain)
     */
    async validate() {
        const events = this.readAll()
        let prevCid = null

        for (const event of events) {
            // Check prev chain
            if (event.prev !== prevCid) {
                throw new Error(`Chain broken at offset ${event.offset}: expected prev=${prevCid}, got ${event.prev}`)
            }

            // Verify CID
            const expectedCid = await computeCID({
                op: event.op,
                collection: event.collection,
                rkey: event.rkey,
                record: event.record,
                prev: event.prev
            })

            if (event.cid !== expectedCid) {
                throw new Error(`CID mismatch at offset ${event.offset}: expected ${expectedCid}, got ${event.cid}`)
            }

            prevCid = event.cid
        }

        return { valid: true, eventCount: events.length }
    }
}

/**
 * Read-only journal reader (for worker)
 */
export class JournalReader {
    constructor(events = []) {
        this.events = events
        this.byCollection = new Map()
        this.byUri = new Map()

        // Index events
        for (const event of events) {
            if (event.op === 'delete') {
                this.byUri.delete(`${event.collection}/${event.rkey}`)
            } else {
                this.byUri.set(`${event.collection}/${event.rkey}`, event)

                if (!this.byCollection.has(event.collection)) {
                    this.byCollection.set(event.collection, [])
                }
                // Only keep latest per rkey
                const col = this.byCollection.get(event.collection)
                const idx = col.findIndex(e => e.rkey === event.rkey)
                if (idx >= 0) {
                    col[idx] = event
                } else {
                    col.push(event)
                }
            }
        }
    }

    /**
     * Get current state of a record
     */
    getRecord(collection, rkey) {
        return this.byUri.get(`${collection}/${rkey}`) || null
    }

    /**
     * List records in a collection
     */
    listRecords(collection, { limit = 50, cursor } = {}) {
        const records = this.byCollection.get(collection) || []

        // Sort by offset descending (newest first)
        const sorted = [...records].sort((a, b) => b.offset - a.offset)

        // Apply cursor
        let startIdx = 0
        if (cursor) {
            startIdx = sorted.findIndex(r => r.offset < cursor)
            if (startIdx === -1) startIdx = sorted.length
        }

        const slice = sorted.slice(startIdx, startIdx + limit + 1)
        const hasMore = slice.length > limit
        const result = slice.slice(0, limit)

        return {
            records: result,
            cursor: hasMore ? result[result.length - 1]?.offset : null
        }
    }

    /**
     * Get events from cursor for firehose
     */
    getEventsFromCursor(cursor, limit = 100) {
        const startIdx = cursor !== undefined && cursor !== null
            ? this.events.findIndex(e => e.offset > cursor)
            : 0

        if (startIdx === -1) return []

        return this.events.slice(startIdx, startIdx + limit)
    }
}
