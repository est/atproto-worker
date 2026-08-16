/**
 * Journal management for ATProto event-sourced publisher
 * Worker-side: reads local journal file, syncs from HTTP on refresh
 */

import { computeCID, commitCid } from './utils.js'

/**
 * Parse NDJSON journal content into events array
 */
export function parseJournal(content) {
    if (!content || !content.trim()) return []
    return content.trim().split('\n').map(line => JSON.parse(line))
}

/**
 * Journal state manager for worker
 * - Reads from static assets (ASSETS binding) or inline JOURNAL_CONTENT
 * - Syncs from ASSETS on /refresh call
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
     * Load journal from static assets or inline content
     * Order: ASSETS binding → JOURNAL_CONTENT (local dev)
     */
    async load() {
        if (this.loaded) return

        let content = null

        // Prefer static assets (journal.ndjson deployed with the Worker)
        if (this.env.ASSETS) {
            const resp = await this.env.ASSETS.fetch('https://worker/journal.ndjson')
            if (resp.ok) {
                content = await resp.text()
            }
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
     * Refresh journal from static assets (self-hosted) or HTTP source
     * Validates chain integrity before accepting new data
     */
    async refresh() {
        let content = null

        // Prefer static assets: journal.ndjson is deployed with the Worker,
        // so no loopback subrequest to our own domain is needed.
        if (this.env.ASSETS) {
            const resp = await this.env.ASSETS.fetch('https://worker/journal.ndjson')
            if (resp.ok) {
                content = await resp.text()
            }
        }

        // Fall back to external JOURNAL_URL
        if (!content && this.env.JOURNAL_URL) {
            const resp = await fetch(this.env.JOURNAL_URL, {
                headers: { 'Accept': 'text/plain' }
            })

            if (!resp.ok) {
                throw new Error(`Failed to fetch journal: ${resp.status}`)
            }

            content = await resp.text()
        }

        if (!content) {
            throw new Error('No journal source available (ASSETS or JOURNAL_URL)')
        }
        const newEvents = parseJournal(content)

        // Validate before accepting - preserves old data on failure
        await this.validate(newEvents)

        this.events = newEvents
        this.index()

        return { eventCount: this.events.length }
    }

    /**
     * Validate journal chain integrity (CID chain and prev links)
     * New format: commitCid chain + commit object CID. Legacy: event CID chain.
     * Throws on validation failure
     */
    async validate(events) {
        let prevCid = null
        let prevCommitCid = null
        let prevOffset = -1

        for (const event of events) {
            // Offsets must be strictly increasing: the firehose broadcast
            // cursor and listRecords cursors key off offsets, so a rebuilt
            // (non-append) journal silently invalidates them.
            if (event.offset !== undefined && event.offset !== null && event.offset <= prevOffset) {
                throw new Error(`Journal offsets not strictly increasing at offset ${event.offset}`)
            }
            if (typeof event.offset === 'number') prevOffset = event.offset

            // Check prev chain
            if (event.prev !== prevCid) {
                throw new Error(`Journal chain broken at offset ${event.offset}: expected prev=${prevCid}, got ${event.prev}`)
            }

            if (event.commitCid) {
                // New format: verify commit CID matches the commit object
                if (!event.commit) {
                    throw new Error(`Missing commit object at offset ${event.offset}`)
                }
                const expectedCommitCid = await commitCid(event.commit)
                if (event.commitCid !== expectedCommitCid) {
                    throw new Error(`Commit CID mismatch at offset ${event.offset}: expected ${expectedCommitCid}, got ${event.commitCid}`)
                }
                if (event.commit.prev !== prevCommitCid) {
                    throw new Error(`Commit chain broken at offset ${event.offset}: expected prev=${prevCommitCid}, got ${event.commit.prev}`)
                }
                prevCommitCid = event.commitCid
            } else if (event.cid) {
                // Legacy format: event CID chain
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

            prevCid = event.commitCid || event.cid || null
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
