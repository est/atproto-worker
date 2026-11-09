/**
 * Firehose (subscribeRepos) - Durable Object for WebSocket subscriptions and
 * the append-only SQLite ledger (M1 phase 2).
 *
 * Ledger schema v2 (meta.schema_version = '2'):
 *   events(seq, did, collection, rkey, op, rev, commit_cid UNIQUE,
 *          record_cid, time, json)
 *   heads(did, commit_cid, rev, seq, mst_root)
 *   meta(k, v)
 *
 * `seq` / the legacy journal field `offset` is now a logical ledger sequence,
 * not a file byte offset. Seed events keep their original static-journal
 * offset as seq; new appends use max(seq)+1. Reads still see the same
 * monotonic cursor semantics firehose/listRecords expect.
 */

import { cborEncode, createCarFile, base64ToBytes } from './shared.js'
import { Journal } from './journal.js'
import { classifyAppend } from './append.js'

// Connection limits for the firehose. A client whose stream dies right after
// the upgrade (e.g. a relay failing commit verification) will otherwise
// reconnect at seconds-per-attempt with no backoff — indigo's slurper only
// backs off on *dial* failure, and each attempt is one DO request. On the
// free tier that burns the monthly DO quota within hours. Rejecting the
// upgrade with a non-101 status turns each attempt into a dial failure,
// which does trigger client-side backoff.
export const CONNECT_WINDOW_MS = 60_000
export const MAX_CONNECTS_PER_WINDOW = 8
export const MAX_GLOBAL_CONNECTS_PER_WINDOW = 15
export const MAX_CONCURRENT_SOCKETS = 8
export const MAX_SOCKETS_PER_IP = 2

/**
 * Sliding-window connect limiter decision. `recentAttempts` are timestamps
 * of prior attempts from the same client; returns whether a new attempt is
 * allowed plus the trimmed list to persist.
 */
export function shouldAllowConnect(recentAttempts, now, max = MAX_CONNECTS_PER_WINDOW, windowMs = CONNECT_WINDOW_MS) {
    const recent = recentAttempts.filter(t => now - t < windowMs)
    return { allowed: recent.length < max, recent }
}

// Every inbound WS message to a hibernating DO is one DO request, and
// subscribeRepos is server→client only — any data message is client
// misbehavior. Close instead of just logging so a client can't burn quota.
export async function closeOnUnexpectedMessage(ws) {
    try {
        ws.close(1008, 'Unexpected message')
    } catch (e) {
        // socket already gone
    }
}

/**
 * Collect blob refs from a record (values shaped {$type: 'blob', ref: {$link}}).
 * The relay verifies every blob referenced by a record is declared in the
 * commit's `blobs` array, so this must walk the whole record.
 */
export function collectBlobRefs(value, refs = []) {
    if (Array.isArray(value)) {
        for (const item of value) collectBlobRefs(item, refs)
    } else if (value && typeof value === 'object') {
        if (value.$type === 'blob' && value.ref && value.ref.$link) {
            refs.push({ $link: value.ref.$link })
        }
        for (const key of Object.keys(value)) collectBlobRefs(value[key], refs)
    }
    return refs
}

/**
 * Firehose Durable Object
 */
export class Firehose {
    constructor(state, env) {
        this.state = state
        this.env = env
        this._schemaReady = false
        // The DO processes storage operations serially; /append still checks
        // the expected head/rev explicitly before inserting (CAS semantics).
    }

    /**
     * The DO SQLite handle, with schema initialized lazily. Returns null in
     * unit tests that use a plain fake state (those fall back to the legacy
     * Journal path for backfill).
     */
    sql() {
        const sql = this.state?.storage?.sql
        if (!sql) return null
        if (!this._schemaReady) {
            this.ensureSchema(sql)
            this._schemaReady = true
        }
        return sql
    }

    ensureSchema(sql) {
        sql.exec(`
            CREATE TABLE IF NOT EXISTS events (
                seq        INTEGER PRIMARY KEY,
                did        TEXT NOT NULL,
                collection TEXT NOT NULL,
                rkey       TEXT NOT NULL,
                op         TEXT NOT NULL,
                rev        TEXT NOT NULL,
                commit_cid TEXT UNIQUE,
                record_cid TEXT,
                time       TEXT NOT NULL,
                json       TEXT NOT NULL
            )
        `)
        sql.exec('CREATE INDEX IF NOT EXISTS idx_events_did_seq ON events(did, seq)')
        sql.exec('CREATE INDEX IF NOT EXISTS idx_events_did_coll ON events(did, collection, rkey)')
        sql.exec(`
            CREATE TABLE IF NOT EXISTS heads (
                did        TEXT PRIMARY KEY,
                commit_cid TEXT NOT NULL,
                rev        TEXT NOT NULL,
                seq        INTEGER NOT NULL,
                mst_root   TEXT
            )
        `)
        // Older draft schemas may lack mst_root; add it once if needed.
        let hasMstRoot = false
        for (const row of sql.exec('PRAGMA table_info(heads)')) {
            if (row.name === 'mst_root') { hasMstRoot = true; break }
        }
        if (!hasMstRoot) sql.exec('ALTER TABLE heads ADD COLUMN mst_root TEXT')
        sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)')
        sql.exec("INSERT OR IGNORE INTO meta(k, v) VALUES('schema_version', '2')")
    }

    jsonResponse(data, status = 200) {
        return new Response(JSON.stringify(data), {
            status,
            headers: { 'Content-Type': 'application/json' }
        })
    }

    /**
     * Cloudflare's `.one()` throws when the result set is empty, unlike the
     * Node SQLite shim used in tests. Use this helper for optional rows.
     */
    one(sql, query, ...bindings) {
        const rows = sql.exec(query, ...bindings).toArray()
        return rows.length > 0 ? rows[0] : null
    }

    /** Turn a stored row into the journal event object. */
    rowToEvent(row) {
        const event = JSON.parse(row.json)
        // `seq` is authoritative; keep the legacy field name `offset` in sync
        // (schema v2: offset is a logical sequence, not a file byte offset).
        event.offset = row.seq
        return event
    }

    getHeadFromSql(sql, did) {
        const row = this.one(
            sql,
            'SELECT did, commit_cid, rev, seq, mst_root FROM heads WHERE did = ?',
            did
        )
        if (!row) return null
        return {
            did: row.did,
            commitCid: row.commit_cid,
            rev: row.rev,
            seq: row.seq,
            mstRoot: row.mst_root ?? null
        }
    }

    getEventByCommitCid(sql, commitCid) {
        const row = this.one(
            sql,
            'SELECT seq, json FROM events WHERE commit_cid = ?',
            commitCid
        )
        return row ? { seq: row.seq, event: this.rowToEvent(row) } : null
    }

    nextSeq(sql) {
        const row = this.one(sql, 'SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM events')
        return row?.next ?? 0
    }

    async fetch(request) {
        const url = new URL(request.url)
        const sql = this.sql()

        if (url.pathname === '/subscribe') {
            return this.handleWebSocket(request, url)
        }

        if (url.pathname === '/append' && request.method === 'POST') {
            return this.handleAppend(request, sql)
        }

        if (url.pathname === '/head' && request.method === 'GET') {
            if (!sql) return this.jsonResponse({ commitCid: null, rev: null, seq: null, mstRoot: null })
            const head = this.getHeadFromSql(sql, url.searchParams.get('did') || '')
            return this.jsonResponse(head
                ? { commitCid: head.commitCid, rev: head.rev, seq: head.seq, mstRoot: head.mstRoot }
                : { commitCid: null, rev: null, seq: null, mstRoot: null })
        }

        if (url.pathname === '/event' && request.method === 'GET') {
            if (!sql) return this.jsonResponse({ error: 'LedgerUnavailable' }, 503)
            const found = this.getEventByCommitCid(sql, url.searchParams.get('commitCid') || '')
            if (!found) return new Response('Not Found', { status: 404 })
            const head = this.getHeadFromSql(sql, found.event.did)
            return this.jsonResponse({ event: found.event, head })
        }

        if (url.pathname === '/stats' && request.method === 'GET') {
            if (!sql) return this.jsonResponse({ maxSeq: -1, eventCount: 0, heads: [] })
            const row = this.one(
                sql,
                'SELECT COUNT(*) AS count, COALESCE(MAX(seq), -1) AS maxSeq FROM events'
            )
            return this.jsonResponse({
                maxSeq: row?.maxSeq ?? -1,
                eventCount: row?.count ?? 0
            })
        }

        if (url.pathname === '/snapshot' && request.method === 'GET') {
            if (!sql) return new Response('', { headers: { 'Content-Type': 'application/x-ndjson' } })
            const afterParam = url.searchParams.get('after')
            const parsedAfter = afterParam === null ? -1 : parseInt(afterParam)
            const after = Number.isFinite(parsedAfter) ? parsedAfter : -1
            const limitParam = url.searchParams.get('limit')
            const parsedLimit = limitParam === null ? -1 : Math.max(0, parseInt(limitParam))
            const limit = Number.isFinite(parsedLimit) ? parsedLimit : -1
            const rows = (limit >= 0)
                ? sql.exec('SELECT seq, json FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?', after, limit).toArray()
                : sql.exec('SELECT seq, json FROM events WHERE seq > ? ORDER BY seq ASC', after).toArray()
            const lines = rows.map(row => JSON.stringify(this.rowToEvent(row))).join('\n')
            return new Response(lines ? lines + '\n' : '', {
                headers: { 'Content-Type': 'application/x-ndjson' }
            })
        }

        if (url.pathname === '/seed' && request.method === 'POST') {
            return this.handleSeed(request, sql)
        }

        if (url.pathname === '/broadcast' && request.method === 'POST') {
            const body = await request.json()
            // `dids` is the explicit hosted set (multi-account). `ownerDid`
            // remains supported as a single-account filter; null explicitly
            // means "no filter".
            const filter = Array.isArray(body.dids) ? body.dids : (body.ownerDid === undefined ? undefined : body.ownerDid)
            const lastOffset = await this.broadcast(body.events, filter)
            // Persist the broadcast cursor in DO storage: it survives across
            // requests without KV (the worker is otherwise stateless).
            const prev = parseInt(await this.state.storage.get('broadcast-cursor')) || -1
            const next = Math.max(prev, lastOffset)
            await this.state.storage.put('broadcast-cursor', String(next))
            return new Response('OK')
        }

        // Read back the last-broadcast offset (used by /refresh and the cron
        // to decide which journal events are new).
        if (url.pathname === '/cursor') {
            const cursor = parseInt(await this.state.storage.get('broadcast-cursor')) || -1
            return new Response(JSON.stringify({ cursor }), {
                headers: { 'Content-Type': 'application/json' }
            })
        }

        return new Response('Not Found', { status: 404 })
    }

    /**
     * Atomically append one owner-signed event, broadcast it, and advance the
     * per-DID head. Idempotent on commitCid; 409 on head/rev CAS failure.
     */
    async handleAppend(request, sql) {
        if (!sql) return this.jsonResponse({ error: 'LedgerUnavailable', message: 'SQLite storage unavailable' }, 503)

        const body = await request.json()
        const event = body?.event
        if (!event || typeof event !== 'object' || !event.did || !event.commitCid) {
            return this.jsonResponse({ error: 'InvalidRequest', message: 'event.did and event.commitCid are required' }, 400)
        }

        const did = event.did
        const existing = this.getEventByCommitCid(sql, event.commitCid)
        const head = this.getHeadFromSql(sql, did)
        const decision = classifyAppend({
            existing,
            head,
            expectedHead: body.expectedHead ?? null,
            expectedRev: body.expectedRev ?? null
        })

        if (decision.type === 'duplicate') {
            return this.jsonResponse({
                ok: true,
                duplicate: true,
                event: existing.event,
                head: this.getHeadFromSql(sql, did)
            })
        }
        if (decision.type === 'conflict') {
            return this.jsonResponse({
                error: 'RepoConflict',
                message: 'Repository head changed; fetch the new head and rebase',
                head
            }, 409)
        }

        const seq = this.nextSeq(sql)
        const prevMstRoot = head?.mstRoot ?? null
        const fullEvent = {
            ...event,
            offset: seq,
            prev: head?.commitCid ?? null,
            prevRev: head?.rev ?? null,
            prevMstRoot,
            time: new Date().toISOString(),
            v: 2
        }

        try {
            sql.exec(
                `INSERT INTO events(seq, did, collection, rkey, op, rev, commit_cid, record_cid, time, json)
                 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                seq,
                fullEvent.did,
                fullEvent.collection,
                fullEvent.rkey,
                fullEvent.op,
                fullEvent.rev,
                fullEvent.commitCid,
                fullEvent.recordCid ?? null,
                fullEvent.time,
                JSON.stringify(fullEvent)
            )
            sql.exec(
                `INSERT INTO heads(did, commit_cid, rev, seq, mst_root)
                 VALUES(?, ?, ?, ?, ?)
                 ON CONFLICT(did) DO UPDATE SET
                   commit_cid = excluded.commit_cid,
                   rev = excluded.rev,
                   seq = excluded.seq,
                   mst_root = excluded.mst_root`,
                did,
                fullEvent.commitCid,
                fullEvent.rev,
                seq,
                fullEvent.mstRoot ?? null
            )
        } catch (e) {
            // A concurrent append with the same commitCid is the only expected
            // conflict; return the stored event instead of a 500.
            const raced = this.getEventByCommitCid(sql, event.commitCid)
            if (raced) {
                return this.jsonResponse({
                    ok: true,
                    duplicate: true,
                    event: raced.event,
                    head: this.getHeadFromSql(sql, did)
                })
            }
            throw e
        }

        // The event was already validated for its own did; don't re-apply the
        // legacy OWNER_DID fallback (that would drop non-owner accounts).
        await this.broadcast([fullEvent], null)

        // The append path broadcasts immediately; advance the cursor so the
        // cron/refresh broadcast path does not send the same event again.
        const prevCursor = parseInt(await this.state.storage.get('broadcast-cursor')) || -1
        await this.state.storage.put('broadcast-cursor', String(Math.max(prevCursor, seq)))

        return this.jsonResponse({
            ok: true,
            event: fullEvent,
            head: this.getHeadFromSql(sql, did)
        })
    }

    /**
     * Seed the ledger from NDJSON (explicit body for tests, otherwise the
     * deployed public/journal.ndjson asset). Idempotent by commitCid/seq;
     * never overwrites live events.
     */
    async handleSeed(request, sql) {
        if (!sql) return this.jsonResponse({ error: 'LedgerUnavailable', message: 'SQLite storage unavailable' }, 503)

        const existingCount = this.one(sql, 'SELECT COUNT(*) AS count FROM events')?.count ?? 0
        // Fast path: a populated ledger is never overwritten by the static
        // journal. This is the "seed-only until first write" rule (phase6 §6.5).
        if (existingCount > 0) {
            return this.jsonResponse({
                ok: true,
                alreadySeeded: true,
                imported: 0,
                skipped: existingCount,
                total: existingCount
            })
        }

        let content = ''
        const contentType = request.headers.get('content-type') || ''
        let text = ''
        try {
            text = await request.text()
        } catch {
            text = ''
        }

        if (text.trim()) {
            if (contentType.includes('application/json')) {
                const parsed = JSON.parse(text)
                if (typeof parsed?.ndjson === 'string') content = parsed.ndjson
                else if (typeof parsed?.content === 'string') content = parsed.content
                else if (Array.isArray(parsed?.events)) content = parsed.events.map(e => JSON.stringify(e)).join('\n')
                else content = ''
            } else {
                content = text
            }
        }

        if (!content.trim()) {
            if (!this.env.ASSETS) {
                return this.jsonResponse({ ok: false, error: 'NoSeedSource', message: 'No NDJSON body and no ASSETS binding' }, 400)
            }
            const resp = await this.env.ASSETS.fetch('https://worker/journal.ndjson')
            if (!resp.ok) {
                return this.jsonResponse({ ok: false, error: 'NoSeedSource', message: `ASSETS journal returned ${resp.status}` }, 400)
            }
            content = await resp.text()
        }

        const lines = content.trim() ? content.trim().split('\n') : []
        let imported = 0
        let skipped = 0
        let next = this.nextSeq(sql)

        for (const line of lines) {
            if (!line.trim()) continue
            let event
            try {
                event = JSON.parse(line)
            } catch {
                skipped++
                continue
            }
            const commitCid = event.commitCid || event.cid || null
            if (!commitCid) { skipped++; continue }

            const dup = this.getEventByCommitCid(sql, commitCid)
            if (dup) { skipped++; continue }

            let seq = Number.isInteger(event.offset) ? event.offset : next
            // If a live event already occupies this seq, keep monotonicity by
            // placing the seed event after the current maximum instead.
            const clash = this.one(sql, 'SELECT 1 AS x FROM events WHERE seq = ?', seq)
            if (clash) { seq = next }

            if (seq >= next) next = seq + 1

            const mstRoot = event.mstRoot || event.commit?.data || null
            const stored = { ...event, offset: seq, v: event.v ?? (event.commit ? 2 : undefined) }
            if (stored.v === undefined) delete stored.v

            sql.exec(
                `INSERT INTO events(seq, did, collection, rkey, op, rev, commit_cid, record_cid, time, json)
                 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                seq,
                event.did || '',
                event.collection || '',
                event.rkey || '',
                event.op || 'create',
                event.rev || '',
                commitCid,
                event.recordCid ?? null,
                event.time || new Date().toISOString(),
                JSON.stringify(stored)
            )

            const current = this.getHeadFromSql(sql, event.did || '')
            if (!current || seq > current.seq) {
                const head = {
                    did: event.did || '',
                    commitCid,
                    rev: event.rev || '',
                    seq,
                    mstRoot
                }
                sql.exec(
                    `INSERT INTO heads(did, commit_cid, rev, seq, mst_root)
                     VALUES(?, ?, ?, ?, ?)
                     ON CONFLICT(did) DO UPDATE SET
                       commit_cid = excluded.commit_cid,
                       rev = excluded.rev,
                       seq = excluded.seq,
                       mst_root = excluded.mst_root`,
                    head.did, head.commitCid, head.rev, head.seq, head.mstRoot
                )
            }
            imported++
        }

        sql.exec("INSERT OR REPLACE INTO meta(k, v) VALUES('seeded', '1')")
        const total = this.one(sql, 'SELECT COUNT(*) AS count FROM events')?.count ?? 0
        return this.jsonResponse({ ok: true, imported, skipped, total })
    }

    /**
     * Handle WebSocket subscription
     */
    async handleWebSocket(request, url) {
        const upgradeHeader = request.headers.get('Upgrade')
        if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
            return new Response('Expected WebSocket', { status: 426 })
        }

        const cfConnectingIp = request.headers.get('CF-Connecting-IP') || 'unknown'
        const userAgent = request.headers.get('User-Agent') || 'unknown'
        const now = Date.now()

        // Global connect cap: per-IP limits don't protect the DO quota from
        // multi-IP clients; every attempt (allowed or rejected) is one DO
        // request, so cap the total across all IPs.
        const globalKey = 'ws-attempts:global'
        const globalPrev = (await this.safeStorageGet(globalKey)) || []
        const globalLimit = shouldAllowConnect(globalPrev, now, MAX_GLOBAL_CONNECTS_PER_WINDOW)
        if (!globalLimit.allowed) {
            console.warn(`[firehose] global connect rate-limit hit from ${cfConnectingIp} (${userAgent})`)
            return this.rateLimitResponse()
        }

        // Per-IP connect rate limit (protects the DO free-tier quota from
        // reconnect storms; see shouldAllowConnect).
        const ipKey = `ws-attempts:${cfConnectingIp}`
        const prevAttempts = (await this.safeStorageGet(ipKey)) || []
        const { allowed, recent } = shouldAllowConnect(prevAttempts, now)
        if (!allowed) {
            console.warn(`[firehose] rate-limiting WS connects from ${cfConnectingIp} (${userAgent}): ${recent.length} in the last minute`)
            return this.rateLimitResponse()
        }

        // Socket caps (global + per-IP) so one client can't hold all slots.
        const openSockets = this.state.getWebSockets()
        if (openSockets.length >= MAX_CONCURRENT_SOCKETS) {
            console.warn(`[firehose] rejecting WS connect from ${cfConnectingIp}: ${openSockets.length} sockets open`)
            return new Response(JSON.stringify({
                error: 'TooManyClients',
                message: 'Too many active connections'
            }), { status: 503, headers: { 'Content-Type': 'application/json' } })
        }
        const mySockets = openSockets.filter(s => (s.deserializeAttachment ? (s.deserializeAttachment() || {}).ip : null) === cfConnectingIp)
        if (mySockets.length >= MAX_SOCKETS_PER_IP) {
            console.warn(`[firehose] rejecting WS connect from ${cfConnectingIp}: already has ${mySockets.length} sockets`)
            return new Response(JSON.stringify({
                error: 'TooManyClients',
                message: 'Too many connections from this IP'
            }), { status: 503, headers: { 'Content-Type': 'application/json' } })
        }

        // Record attempts only after every rejection check, so rejected
        // clients don't burn other clients' rate-limit budget.
        await this.safeStoragePut(ipKey, [...recent, now], { expirationTtl: 120 })
        await this.safeStoragePut(globalKey, [...globalLimit.recent, now], { expirationTtl: 120 })

        const cursorParam = url.searchParams.get('cursor')
        const cursor = cursorParam === null || Number.isNaN(parseInt(cursorParam)) ? null : parseInt(cursorParam)
        console.log(`[firehose] WS connect from ${cfConnectingIp} (${userAgent}) cursor=${cursor} path=${url.pathname}`)

        const [client, server] = Object.values(new WebSocketPair())

        // Need to accept the server-side websocket via state to handle events
        this.state.acceptWebSocket(server)
        server.serializeAttachment({ cursor, ip: cfConnectingIp })

        // Backfill from journal: no cursor = new subscriber, send everything
        // (matches relay expectations: a fresh host subscription gets the
        // full history so it can index the repo without prior events)
        this.state.waitUntil(this.backfill(server, cursor === null ? -1 : cursor))

        console.log(`New WebSocket client connected, cursor: ${cursor}`)

        return new Response(null, { status: 101, webSocket: client })
    }

    rateLimitResponse() {
        return new Response(JSON.stringify({
            error: 'RateLimited',
            message: 'Too many connection attempts, retry later'
        }), { status: 429, headers: { 'Content-Type': 'application/json' } })
    }

    // Storage failures must not break legitimate subscribers: fail open.
    async safeStorageGet(key) {
        try {
            return await this.state.storage.get(key)
        } catch (e) {
            console.error('[firehose] storage.get failed:', e.message)
            return null
        }
    }

    async safeStoragePut(key, value, opts) {
        try {
            await this.state.storage.put(key, value, opts)
        } catch (e) {
            console.error('[firehose] storage.put failed:', e.message)
        }
    }

    /**
     * Backfill events. The ledger (DO SQLite) is the source of truth so new
     * subscribers see appended events; the legacy Journal path is kept only
     * for unit tests / a pre-ledger deployment.
     */
    async backfill(ws, cursor) {
        const sql = this.sql()
        if (sql) return this.backfillSql(ws, cursor)

        try {
            // Legacy fallback (tests and seed-only deployments).
            const journal = new Journal(this.env)
            await journal.load()

            // Page through the whole journal past the cursor — a fresh
            // subscriber must get every event of every hosted account or it
            // indexes a partial repo. The journal only ever contains hosted
            // accounts' events (CLI-authored), so no did filter is needed.
            let lastOffset = cursor
            while (true) {
                const batch = journal.getEventsFromCursor(lastOffset, 1000)
                if (batch.length === 0) break

                for (const event of batch) {
                    const message = this.formatEvent(event)

                    try {
                        ws.send(message)
                    } catch (e) {
                        return // Client disconnected
                    }
                }

                lastOffset = batch[batch.length - 1].offset
            }

            // Update cursor based on actual journal offset,
            // even if filtered out, so we don't re-process
            if (lastOffset !== cursor) {
                ws.serializeAttachment({ cursor: lastOffset })
            }
        } catch (e) {
            console.error('Backfill error:', e)
            this.sendError(ws, 'InternalError', 'Failed to backfill events')
        }
    }

    /** Page through ledger events in seq order and send firehose frames. */
    async backfillSql(ws, cursor) {
        try {
            let lastSeq = cursor
            const page = 1000
            while (true) {
                const rows = this.state.storage.sql
                    .exec('SELECT seq, json FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?', lastSeq, page)
                    .toArray()
                if (rows.length === 0) break

                for (const row of rows) {
                    let message
                    try {
                        message = this.formatEvent(this.rowToEvent(row))
                    } catch (e) {
                        console.error('Backfill format error:', e)
                        continue
                    }
                    try {
                        ws.send(message)
                    } catch (e) {
                        return // Client disconnected
                    }
                }
                lastSeq = rows[rows.length - 1].seq
            }

            if (lastSeq !== cursor) {
                ws.serializeAttachment({ cursor: lastSeq })
            }
        } catch (e) {
            console.error('Backfill error:', e)
            this.sendError(ws, 'InternalError', 'Failed to backfill events')
        }
    }

    /**
     * Send error frame to client (header {op:-1} + body {error, message})
     */
    sendError(ws, error, message) {
        try {
            ws.send(this.sendErrorFrame(error, message))
        } catch (e) {
            console.error('Failed to send error frame:', e)
        }
    }

    /**
     * Broadcast new events to all connected clients.
     *
     * Multi-account note: a single-host PDS hosts several DIDs, and dropping
     * other accounts' events silently breaks their firehose consumers. The
     * filter is therefore opt-in:
     *   - array       -> broadcast only events whose did is in the array
     *   - string      -> broadcast only that did
     *   - null        -> broadcast everything (explicit "no filter")
     *   - undefined   -> legacy behavior: env.OWNER_DID if set, else everything
     *
     * The Worker passes the explicit hosted-DID array, so all hosted accounts
     * are broadcast even when OWNER_DID is set.
     *
     * @returns {Promise<number>} the max offset of the broadcast events (-1 if none)
     */
    async broadcast(events, filter) {
        let dids = null
        if (Array.isArray(filter)) dids = new Set(filter)
        else if (typeof filter === 'string') dids = new Set([filter])
        else if (filter === null) dids = null
        else if (this.env.OWNER_DID) dids = new Set([this.env.OWNER_DID])

        const filteredEvents = dids ? events.filter(e => dids.has(e.did)) : events
        if (filteredEvents.length === 0) return -1

        const formattedEvents = filteredEvents.map(e => this.formatEvent(e))
        const sockets = this.state.getWebSockets()

        console.log(`Broadcasting ${filteredEvents.length} events to ${sockets.length} clients`)

        for (const ws of sockets) {
            for (const msg of formattedEvents) {
                try {
                    ws.send(msg)
                } catch (e) {
                    console.error('Failed to send to client:', e)
                    // socket closed, will be removed by DO eventually
                }
            }
        }
        return filteredEvents[filteredEvents.length - 1].offset
    }

    /**
     * Format event for firehose (AT Protocol compliant)
     *
     * New format: blocks is the real CAR built by the CLI (commit v3 +
     * MST nodes + record), commit is the commit CID, ops carry record CIDs.
     * Legacy format: empty CAR fallback (see ADR-006).
     *
     * NOTE: subscribeRepos frames are CBOR(header) + CBOR(body), where
     * header = {op: 1 (Message), t: "#commit"}. The body carries the
     * event payload. Sending only the body breaks relay parsing.
     */
    formatEvent(event) {
        let body
        // New model: journal lines carry commitCid + blocksB64.
        // NOTE: commit / ops[].cid / prevData must be CID links (CBOR tag 42,
        // {$link: ...}), not plain strings — the relay's LexLink.UnmarshalCBOR
        // (cbg.ReadCid) fails on strings and drops the connection, which was
        // the source of its reconnect loop.
        if (event.commitCid && event.blocksB64) {
            body = {
                seq: event.offset,
                time: event.time,
                rebase: false,
                tooBig: false,
                repo: event.did,
                commit: { $link: event.commitCid },
                rev: event.rev,
                since: event.prevRev || null,
                prevData: event.prevMstRoot ? { $link: event.prevMstRoot } : null,
                blocks: base64ToBytes(event.blocksB64),
                ops: [{
                    action: event.op,
                    path: `${event.collection}/${event.rkey}`,
                    cid: event.op === 'delete' ? null : { $link: event.recordCid || event.commitCid }
                }],
                blobs: collectBlobRefs(event.record)
            }
        } else {
            // Legacy fallback: empty CAR
            body = {
                seq: event.offset,
                time: event.time,
                rebase: false,
                tooBig: false,
                repo: event.did,
                commit: { $link: event.cid },
                rev: event.rev,
                since: event.prevRev || null,
                blocks: createCarFile(event.cid, []),
                ops: [{
                    action: event.op,
                    path: `${event.collection}/${event.rkey}`,
                    cid: event.op === 'delete' ? null : { $link: event.cid }
                }],
                blobs: collectBlobRefs(event.record)
            }
        }

        // Frame = CBOR(header {op:1, t:'#commit'}) + CBOR(body)
        const header = cborEncode({ op: 1, t: '#commit' })
        const bodyBytes = cborEncode(body)
        const frame = new Uint8Array(header.length + bodyBytes.length)
        frame.set(header, 0)
        frame.set(bodyBytes, header.length)
        return frame
    }

    /**
     * Send error frame: CBOR(header {op:-1}) + CBOR({error, message})
     */
    sendErrorFrame(error, message) {
        const header = cborEncode({ op: -1 })
        const body = cborEncode({ error, message })
        const frame = new Uint8Array(header.length + body.length)
        frame.set(header, 0)
        frame.set(body, header.length)
        return frame
    }

    async webSocketMessage(ws, message) {
        // subscribeRepos is server→client only. Any inbound data message is
        // client misbehavior — and each one bills a DO request — so close
        // the socket instead of just logging.
        console.warn('Unexpected message from client, closing socket')
        await closeOnUnexpectedMessage(ws)
    }

    async webSocketClose(ws, code, reason) {
        console.log(`WebSocket client disconnected: ${code} ${reason}`)
    }    async webSocketError(ws, error) {
        console.error('WebSocket error:', error)
    }
}
