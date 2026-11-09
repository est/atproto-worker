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

// Module-level snapshot cache. The Worker isolate serves many requests; the
// ledger head seq is a cheap cache key, so an unchanged ledger is not re-sent
// on every request. Keyed by the FIREHOSE binding object (tests create a new
// binding per case, so they don't leak into each other).
const ledgerCaches = new WeakMap()

function cacheFor(env) {
    const key = env?.FIREHOSE
    if (!key || (typeof key !== 'object' && typeof key !== 'function')) return null
    let cache = ledgerCaches.get(key)
    if (!cache) {
        cache = { seq: -1, events: null }
        ledgerCaches.set(key, cache)
    }
    return cache
}

function ledgerStub(env) {
    if (!env?.FIREHOSE) return null
    const id = env.FIREHOSE.idFromName('main')
    return env.FIREHOSE.get(id)
}

/**
 * Journal state manager for worker
 * - Reads from the Firehose ledger DO (SQLite), falling back to static assets
 *   (ASSETS) or inline JOURNAL_CONTENT for seed-only/dev mode
 * - /refresh pulls the ledger snapshot (seeding it first only when empty)
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
     * Load journal. Primary source: ledger DO /snapshot (ADR-040 / phase6
     * §4.4). Fallbacks: ASSETS binding → JOURNAL_CONTENT (local dev).
     */
    async load() {
        if (this.loaded) return

        const fromLedger = await this.loadFromLedger()
        if (!fromLedger) await this.loadFromAssets()

        this.loaded = true
    }

    async loadFromAssets() {
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
    }

    /**
     * Load the full ledger snapshot, reusing the module cache when the head
     * seq has not changed. Returns false when the ledger is unavailable/empty.
     */
    async loadFromLedger() {
        const stub = ledgerStub(this.env)
        if (!stub) return false

        try {
            let maxSeq = null
            const statsResp = await stub.fetch('http://ledger/stats')
            if (statsResp.ok) {
                const stats = await statsResp.json()
                maxSeq = stats.maxSeq
                if ((stats.eventCount ?? 0) === 0) return false
            }

            const cache = cacheFor(this.env)
            if (cache && cache.events && maxSeq !== null && cache.seq === maxSeq) {
                this.events = cache.events
                this.index()
                return true
            }

            const resp = await stub.fetch('http://ledger/snapshot')
            if (!resp.ok) return false
            const events = parseJournal(await resp.text())
            if (events.length === 0) return false

            await this.validate(events)
            this.events = events
            this.index()

            if (cache) {
                cache.seq = events[events.length - 1].offset ?? maxSeq ?? -1
                cache.events = events
            }
            return true
        } catch (e) {
            console.error('Ledger load failed, falling back to ASSETS:', e.message)
            return false
        }
    }

    /**
     * DIDs hosted by this PDS — derived from the journal itself (every
     * event carries its account's did; the journal is the source of truth,
     * so no separate account registry is needed).
     */
    distinctDids() {
        const dids = new Set()
        for (const e of this.events) {
            if (e.did) dids.add(e.did)
        }
        return dids
    }

    /**
     * Refresh journal. Once a ledger exists it is the only write target: we
     * re-snapshot it instead of re-importing ASSETS (phase6 §6.5). When the
     * ledger is empty we seed it from ASSETS once, then snapshot. The old
     * ASSETS/JOURNAL_URL behavior remains as a seed-only/dev fallback.
     */
    async refresh() {
        const stub = ledgerStub(this.env)
        if (stub) {
            try {
                const statsResp = await stub.fetch('http://ledger/stats')
                let empty = false
                if (statsResp.ok) {
                    const stats = await statsResp.json()
                    empty = (stats.eventCount ?? 0) === 0
                }

                if (empty) {
                    // Seed only when empty; /seed is idempotent and never
                    // overwrites live events.
                    const seedResp = await stub.fetch('http://ledger/seed', { method: 'POST' })
                    if (!seedResp.ok) {
                        console.warn(`[journal] ledger seed failed: ${seedResp.status}`)
                    }
                }

                const resp = await stub.fetch('http://ledger/snapshot')
                if (resp.ok) {
                    const events = parseJournal(await resp.text())
                    if (events.length > 0) {
                        await this.validate(events)
                        this.events = events
                        this.index()
                        const cache = cacheFor(this.env)
                        if (cache) {
                            cache.seq = events[events.length - 1].offset ?? -1
                            cache.events = events
                        }
                        return { eventCount: this.events.length }
                    }
                }
            } catch (e) {
                console.error('[journal] ledger refresh failed, falling back to ASSETS:', e.message)
            }
        }

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
            throw new Error('No journal source available (ledger, ASSETS, or JOURNAL_URL)')
        }
        const newEvents = parseJournal(content)

        // Validate before accepting - preserves old data on failure
        await this.validate(newEvents)

        this.events = newEvents
        this.index()

        return { eventCount: this.events.length }
    }

    /**
     * Validate journal chain integrity (CID chain and prev links).
     * The journal holds events from all hosted accounts in one file, so
     * chain integrity is tracked PER DID (each account has its own commit
     * chain). Offsets stay globally monotonic; schema v2 redefines `offset`
     * as a logical ledger seq rather than a file byte offset, but the
     * monotonicity requirement is unchanged. Signature verification is NOT
     * done here (ADR-030: reads don't verify; the append write path does).
     * Unknown/extra v2 fields (v, signingKey, ...) are tolerated.
     * Throws on validation failure
     */
    async validate(events) {
        const prevCidByDid = new Map()
        const prevCommitCidByDid = new Map()
        let prevOffset = -1

        for (const event of events) {
            // Offsets must be strictly increasing: the firehose broadcast
            // cursor and listRecords cursors key off offsets, so a rebuilt
            // (non-append) journal silently invalidates them.
            if (event.offset !== undefined && event.offset !== null && event.offset <= prevOffset) {
                throw new Error(`Journal offsets not strictly increasing at offset ${event.offset}`)
            }
            if (typeof event.offset === 'number') prevOffset = event.offset

            const did = event.did || ''
            const prevCid = prevCidByDid.get(did) || null

            // Check prev chain (per did)
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
                const prevCommitCid = prevCommitCidByDid.get(did) || null
                if (event.commit.prev !== prevCommitCid) {
                    throw new Error(`Commit chain broken at offset ${event.offset}: expected prev=${prevCommitCid}, got ${event.commit.prev}`)
                }
                prevCommitCidByDid.set(did, event.commitCid)
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

            prevCidByDid.set(did, event.commitCid || event.cid || null)
        }

        return true
    }

    /**
     * Index events for fast lookup, namespaced by did so multiple accounts
     * in one journal don't collide on rkeys.
     */
    index() {
        this.byCollection = new Map()
        this.byUri = new Map()

        for (const event of this.events) {
            // A batch commit (applyWrites) carries multiple ops in `writes`;
            // expand it so getRecord/listRecords see every record, not just
            // the first op in the ledger row.
            const ops = Array.isArray(event.writes) && event.writes.length
                ? event.writes
                : [{ op: event.op, collection: event.collection, rkey: event.rkey, record: event.record, recordCid: event.recordCid }]

            for (const op of ops) {
                if (!op || !op.collection || !op.rkey) continue
                const isFirst = op.collection === event.collection && op.rkey === event.rkey
                const view = {
                    ...event,
                    op: op.op,
                    collection: op.collection,
                    rkey: op.rkey,
                    record: op.record !== undefined ? op.record : (isFirst ? event.record : undefined),
                    recordCid: op.recordCid !== undefined ? op.recordCid : (isFirst ? event.recordCid : null)
                }
                const key = `${view.did}/${view.collection}/${view.rkey}`
                const colKey = `${view.did}/${view.collection}`

                if (view.op === 'delete') {
                    this.byUri.delete(key)
                    const col = this.byCollection.get(colKey)
                    if (col) {
                        const idx = col.findIndex(e => e.rkey === view.rkey)
                        if (idx >= 0) col.splice(idx, 1)
                    }
                } else {
                    this.byUri.set(key, view)

                    if (!this.byCollection.has(colKey)) {
                        this.byCollection.set(colKey, [])
                    }
                    const col = this.byCollection.get(colKey)
                    const idx = col.findIndex(e => e.rkey === view.rkey)
                    if (idx >= 0) {
                        col[idx] = view
                    } else {
                        col.push(view)
                    }
                }
            }
        }
    }

    /**
     * Get current state of a record for a specific account
     */
    getRecord(did, collection, rkey) {
        return this.byUri.get(`${did}/${collection}/${rkey}`) || null
    }

    /**
     * List records in a collection for a specific account
     */
    listRecords(did, collection, { limit = 50, cursor } = {}) {
        const records = this.byCollection.get(`${did}/${collection}`) || []

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
        let max = -1
        for (const event of this.events) {
            if (typeof event.offset === 'number' && event.offset > max) max = event.offset
        }
        return max >= 0 ? max : 0
    }
}
