/**
 * D1 Database operations for AT Protocol PDS
 */

import { generateCID, nowISO } from './utils.js'

/**
 * Database wrapper for D1 operations
 */
export class Database {
    constructor(d1) {
        this.d1 = d1
    }

    // ============ Records ============

    /**
     * Create a new record
     */
    async createRecord(collection, rkey, record) {
        const cid = await generateCID(record)
        const now = nowISO()

        await this.d1.prepare(`
      INSERT INTO records (collection, rkey, record, cid, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(collection, rkey, JSON.stringify(record), cid, now, now).run()

        return { cid, createdAt: now }
    }

    /**
     * Get a single record
     */
    async getRecord(collection, rkey) {
        const row = await this.d1.prepare(`
      SELECT * FROM records WHERE collection = ? AND rkey = ?
    `).bind(collection, rkey).first()

        if (!row) return null

        return {
            collection: row.collection,
            rkey: row.rkey,
            record: JSON.parse(row.record),
            cid: row.cid,
            createdAt: row.created_at
        }
    }

    /**
     * List records in a collection
     */
    async listRecords(collection, { limit = 50, cursor, reverse = true } = {}) {
        const order = reverse ? 'DESC' : 'ASC'
        const op = reverse ? '<' : '>'

        let query = `SELECT * FROM records WHERE collection = ?`
        const bindings = [collection]

        if (cursor) {
            query += ` AND created_at ${op} ?`
            bindings.push(cursor)
        }

        query += ` ORDER BY created_at ${order} LIMIT ?`
        bindings.push(limit + 1) // Fetch one extra for cursor

        const stmt = this.d1.prepare(query)
        const { results } = await stmt.bind(...bindings).all()

        const hasMore = results.length > limit
        const records = results.slice(0, limit).map(row => ({
            collection: row.collection,
            rkey: row.rkey,
            record: JSON.parse(row.record),
            cid: row.cid,
            createdAt: row.created_at
        }))

        return {
            records,
            cursor: hasMore ? records[records.length - 1]?.createdAt : null
        }
    }

    /**
     * Update a record
     */
    async updateRecord(collection, rkey, record) {
        const cid = await generateCID(record)
        const now = nowISO()

        const result = await this.d1.prepare(`
      UPDATE records SET record = ?, cid = ?, updated_at = ?
      WHERE collection = ? AND rkey = ?
    `).bind(JSON.stringify(record), cid, now, collection, rkey).run()

        if (result.meta.changes === 0) return null

        return { cid, updatedAt: now }
    }

    /**
     * Delete a record
     */
    async deleteRecord(collection, rkey) {
        const result = await this.d1.prepare(`
      DELETE FROM records WHERE collection = ? AND rkey = ?
    `).bind(collection, rkey).run()

        return result.meta.changes > 0
    }

    // ============ Sequences (Firehose) ============

    /**
     * Append an event to the sequence log
     */
    async appendSequence(eventType, did, event) {
        const result = await this.d1.prepare(`
      INSERT INTO sequences (event_type, did, event, created_at)
      VALUES (?, ?, ?, ?)
    `).bind(eventType, did, JSON.stringify(event), nowISO()).run()

        return result.meta.last_row_id
    }

    /**
     * Get sequence events from cursor
     */
    async getSequenceRange(cursor, limit = 100) {
        let query = `SELECT * FROM sequences`
        const bindings = []

        if (cursor !== undefined && cursor !== null) {
            query += ` WHERE seq > ?`
            bindings.push(cursor)
        }

        query += ` ORDER BY seq ASC LIMIT ?`
        bindings.push(limit)

        const stmt = this.d1.prepare(query)
        const { results } = await stmt.bind(...bindings).all()

        return results.map(row => ({
            seq: row.seq,
            type: row.event_type,
            did: row.did,
            event: JSON.parse(row.event),
            time: row.created_at
        }))
    }

    /**
     * Get the current (latest) sequence number
     */
    async getCurrentSeq() {
        const row = await this.d1.prepare(`
      SELECT MAX(seq) as seq FROM sequences
    `).first()

        return row?.seq ?? 0
    }

    // ============ Interactions ============

    /**
     * Save an interaction (like, repost, reply)
     */
    async saveInteraction(interaction) {
        await this.d1.prepare(`
      INSERT OR REPLACE INTO interactions 
        (uri, type, actor_did, actor_handle, target_uri, record, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
            interaction.uri,
            interaction.type,
            interaction.actorDid,
            interaction.actorHandle || null,
            interaction.targetUri,
            JSON.stringify(interaction.record),
            nowISO()
        ).run()
    }

    /**
     * Get interactions for a target URI
     */
    async getInteractions(targetUri, type = null) {
        let query = `SELECT * FROM interactions WHERE target_uri = ?`
        const bindings = [targetUri]

        if (type) {
            query += ` AND type = ?`
            bindings.push(type)
        }

        query += ` ORDER BY indexed_at DESC`

        const stmt = this.d1.prepare(query)
        const { results } = await stmt.bind(...bindings).all()

        return results.map(row => ({
            uri: row.uri,
            type: row.type,
            actorDid: row.actor_did,
            actorHandle: row.actor_handle,
            targetUri: row.target_uri,
            record: JSON.parse(row.record),
            indexedAt: row.indexed_at
        }))
    }

    // ============ Blobs ============

    /**
     * Save blob metadata
     */
    async saveBlob(cid, mimeType, size) {
        await this.d1.prepare(`
      INSERT OR REPLACE INTO blobs (cid, mime_type, size, created_at)
      VALUES (?, ?, ?, ?)
    `).bind(cid, mimeType, size, nowISO()).run()
    }

    /**
     * Get blob metadata
     */
    async getBlob(cid) {
        return await this.d1.prepare(`
      SELECT * FROM blobs WHERE cid = ?
    `).bind(cid).first()
    }
}
