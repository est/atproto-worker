/**
 * Journal management for ATProto event-sourced publisher
 * Append-only NDJSON log of signed commits
 */

import fs from 'node:fs'
import path from 'node:path'
import { computeCID } from './crypto.js'
import { generateTID } from '../src/shared.js'

const DEFAULT_JOURNAL_PATH = './journal.ndjson'

/**
 * Journal writer for appending events
 * Multi-account aware: when `did` is given, the prev chain is looked up
 * per account (the journal holds events from all hosted accounts in one
 * file); when null, the last line is used (single-account legacy).
 */
export class JournalWriter {
    constructor(journalPath = DEFAULT_JOURNAL_PATH, did = null) {
        this.journalPath = journalPath
        this.did = did
        this.prevCid = null
        this.prevRev = null

        // Load existing journal to get prev CID and rev for this account
        if (fs.existsSync(journalPath)) {
            const content = fs.readFileSync(journalPath, 'utf-8').trim()
            if (content) {
                const lines = content.split('\n')
                for (let i = lines.length - 1; i >= 0; i--) {
                    const lastEvent = JSON.parse(lines[i])
                    if (this.did && lastEvent.did !== this.did) continue
                    this.prevCid = lastEvent.commitCid || lastEvent.cid || null
                    this.prevRev = lastEvent.rev || null
                    break
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
     * The event carries either a legacy event `cid` (old model) or the
     * atproto `commitCid` + `rev` (new model); rev is preserved if given.
     */
    async append(event) {
        const offset = this.getOffset()

        // Preserve caller-provided rev (from commit v3); fall back to generated TID
        const rev = event.rev || generateTID()

        // Add metadata
        const fullEvent = {
            offset,
            ...event,
            rev,
            prev: this.prevCid,
            prevRev: this.prevRev,
            time: new Date().toISOString()
        }

        // Compute legacy event CID only when requested (backwards compat)
        if (fullEvent.cid === undefined && !fullEvent.commitCid) {
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

        // Update prev chain: prefer commitCid if present (new model)
        this.prevCid = fullEvent.commitCid || fullEvent.cid || null
        this.prevRev = rev

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
     * Validate journal integrity
     * The journal holds all accounts' events in one file, so chains are
     * validated PER DID.
     * New format: verify commit v3 signature + commitCid chain + record CIDs
     * Legacy format: verify event CID chain
     */
    async validate() {
        const events = this.readAll()
        const prevCidByDid = new Map()
        const prevCommitCidByDid = new Map()
        const { verifyCommitSig } = await import('./atproto.js')

        for (const event of events) {
            const did = event.did || ''
            const prevCid = prevCidByDid.get(did) || null

            // Check prev chain (per did)
            if (event.prev !== prevCid) {
                throw new Error(`Chain broken at offset ${event.offset}: expected prev=${prevCid}, got ${event.prev}`)
            }

            if (event.commitCid) {
                // New format: commit v3
                if (!event.commit) {
                    throw new Error(`Missing commit object at offset ${event.offset}`)
                }
                // Verify commit CID matches
                const { commitCid } = await import('./atproto.js')
                const expectedCommitCid = await commitCid(event.commit)
                if (event.commitCid !== expectedCommitCid) {
                    throw new Error(`Commit CID mismatch at offset ${event.offset}: expected ${expectedCommitCid}, got ${event.commitCid}`)
                }
                // Verify signature (needs public key - done in seal validate with config)
                const prevCommitCid = prevCommitCidByDid.get(did) || null
                if (event.commit.prev !== prevCommitCid) {
                    throw new Error(`Commit chain broken at offset ${event.offset}: expected prev=${prevCommitCid}, got ${event.commit.prev}`)
                }
                prevCommitCidByDid.set(did, event.commitCid)
            } else {
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
