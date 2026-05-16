/**
 * Journal management for ATProto event-sourced publisher
 * Worker-side: reads local journal file, syncs from HTTP on refresh
 */

import { computeCID } from './utils.js'

/**
 * Parse NDJSON journal content into events array
 */
export function parseJournal(content) {
    if (!content || !content.trim()) return []
    return content.trim().split('\n').map(line => JSON.parse(line))
}

/**
 * Journal state manager for worker
 * - Reads from local file (via KV or env)
 * - Syncs from HTTP on /refresh call
 */
export class Journal {
    constructor(env) {
        this.env = env
        this.events = []
        this.byCollection = new Map()
        this.byUri = new Map()
        this.loaded = false
    }

    /**
     * Load journal from KV storage (cached) or initial env
     */
    async load() {
        if (this.loaded) return

        // Try KV cache first
        let content = null
        if (this.env.JOURNAL_KV) {
            content = await this.env.JOURNAL_KV.get('journal')
        }

        // Fall back to inline content if provided
        if (!content && this.env.JOURNAL_CONTENT) {
            content = this.env.JOURNAL_CONTENT
        }

        if (content) {
            const events = parseJournal(content)
            await this.validate(events)
            this.events = events
            this.index()
        }

        this.loaded = true
    }

    /**
     * Refresh journal from HTTP source
     * Validates chain integrity before accepting new data
     */
    async refresh() {
        const url = this.env.JOURNAL_URL
        if (!url) {
            throw new Error('JOURNAL_URL not configured')
        }

        const resp = await fetch(url, {
            headers: { 'Accept': 'text/plain' }
        })

        if (!resp.ok) {
            throw new Error(`Failed to fetch journal: ${resp.status}`)
        }

        const content = await resp.text()
        const newEvents = parseJournal(content)

        // Validate before accepting - preserves old data on failure
        await this.validate(newEvents)

        this.events = newEvents
        this.index()

        // Cache in KV
        if (this.env.JOURNAL_KV) {
            await this.env.JOURNAL_KV.put('journal', content)
        }

        return { eventCount: this.events.length }
    }

    /**
     * Validate journal chain integrity (CID chain and prev links)
     * Throws on validation failure
     */
    async validate(events) {
        let prevCid = null

        for (const event of events) {
            // Check prev chain
            if (event.prev !== prevCid) {
                throw new Error(`Journal chain broken at offset ${event.offset}: expected prev=${prevCid}, got ${event.prev}`)
            }

            // Verify CID if present
            if (event.cid) {
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
            }

            prevCid = event.cid
        }

        return true
    }

    /**
     * Index events for fast lookup
     */
    index() {
        this.byCollection = new Map()
        this.byUri = new Map()

        for (const event of this.events) {
            const key = `${event.collection}/${event.rkey}`

            if (event.op === 'delete') {
                this.byUri.delete(key)
                // Remove from collection
                const col = this.byCollection.get(event.collection)
                if (col) {
                    const idx = col.findIndex(e => e.rkey === event.rkey)
                    if (idx >= 0) col.splice(idx, 1)
                }
            } else {
                this.byUri.set(key, event)

                if (!this.byCollection.has(event.collection)) {
                    this.byCollection.set(event.collection, [])
                }
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

        // Apply cursor (offset-based)
        let startIdx = 0
        if (cursor !== undefined && cursor !== null) {
            startIdx = sorted.findIndex(r => r.offset < parseInt(cursor))
            if (startIdx === -1) startIdx = sorted.length
        }

        const slice = sorted.slice(startIdx, startIdx + limit + 1)
        const hasMore = slice.length > limit
        const result = slice.slice(0, limit)

        return {
            records: result,
            cursor: hasMore ? String(result[result.length - 1]?.offset) : null
        }
    }

    /**
     * Get events from cursor for firehose (seq = offset)
     */
    getEventsFromCursor(cursor, limit = 100) {
        const cursorNum = cursor !== undefined && cursor !== null ? parseInt(cursor) : -1

        const filtered = this.events.filter(e => e.offset > cursorNum)
        return filtered.slice(0, limit)
    }

    /**
     * Get current max seq (offset)
     */
    getCurrentSeq() {
        if (this.events.length === 0) return 0
        return this.events[this.events.length - 1].offset
    }
}
