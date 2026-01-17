/**
 * Repository operations for AT Protocol PDS
 * Handles record CRUD with proper AT-URI generation and firehose sequencing
 */

import { generateTID, buildAtUri, generateCID, nowISO } from './utils.js'

/**
 * Repository manager
 */
export class Repo {
    constructor(db, did) {
        this.db = db
        this.did = did
    }

    /**
     * Create a new record in the repository
     * Returns { uri, cid, commit }
     */
    async createRecord(collection, record, rkey = null) {
        // Generate rkey if not provided
        if (!rkey) {
            rkey = generateTID()
        }

        // Ensure record has $type
        if (!record.$type) {
            record.$type = collection
        }

        // Create the record in D1
        const { cid, createdAt } = await this.db.createRecord(collection, rkey, record)
        const uri = buildAtUri(this.did, collection, rkey)

        // Append to sequence for firehose
        await this.db.appendSequence('commit', this.did, {
            ops: [{ action: 'create', path: `${collection}/${rkey}`, cid }],
            repo: this.did,
            rev: generateTID(),
            time: createdAt,
            commit: cid,
            blobs: []
        })

        return { uri, cid }
    }

    /**
     * Get a record from the repository
     */
    async getRecord(collection, rkey) {
        const result = await this.db.getRecord(collection, rkey)
        if (!result) return null

        return {
            uri: buildAtUri(this.did, collection, rkey),
            cid: result.cid,
            value: result.record
        }
    }

    /**
     * List records in a collection
     */
    async listRecords(collection, { limit = 50, cursor, reverse = true } = {}) {
        const result = await this.db.listRecords(collection, { limit, cursor, reverse })

        return {
            records: result.records.map(r => ({
                uri: buildAtUri(this.did, r.collection, r.rkey),
                cid: r.cid,
                value: r.record
            })),
            cursor: result.cursor
        }
    }

    /**
     * Update a record (put)
     */
    async putRecord(collection, rkey, record) {
        // Ensure record has $type
        if (!record.$type) {
            record.$type = collection
        }

        // Check if record exists
        const existing = await this.db.getRecord(collection, rkey)
        const isUpdate = !!existing

        if (isUpdate) {
            const { cid, updatedAt } = await this.db.updateRecord(collection, rkey, record)
            const uri = buildAtUri(this.did, collection, rkey)

            // Append update to sequence
            await this.db.appendSequence('commit', this.did, {
                ops: [{ action: 'update', path: `${collection}/${rkey}`, cid, prev: existing.cid }],
                repo: this.did,
                rev: generateTID(),
                time: updatedAt,
                commit: cid,
                blobs: []
            })

            return { uri, cid }
        } else {
            // Create new record
            return this.createRecord(collection, record, rkey)
        }
    }

    /**
     * Delete a record
     */
    async deleteRecord(collection, rkey) {
        const existing = await this.db.getRecord(collection, rkey)
        if (!existing) return false

        await this.db.deleteRecord(collection, rkey)

        // Append delete to sequence
        await this.db.appendSequence('commit', this.did, {
            ops: [{ action: 'delete', path: `${collection}/${rkey}`, cid: null, prev: existing.cid }],
            repo: this.did,
            rev: generateTID(),
            time: nowISO(),
            commit: await generateCID({ deleted: `${collection}/${rkey}` }),
            blobs: []
        })

        return true
    }

    /**
     * Get all records (for repo export)
     */
    async getAllRecords() {
        const collections = ['app.bsky.feed.post', 'app.bsky.feed.like', 'app.bsky.feed.repost', 'app.bsky.graph.follow']
        const allRecords = []

        for (const collection of collections) {
            let cursor = null
            do {
                const result = await this.db.listRecords(collection, { limit: 100, cursor, reverse: false })
                allRecords.push(...result.records)
                cursor = result.cursor
            } while (cursor)
        }

        return allRecords
    }
}
