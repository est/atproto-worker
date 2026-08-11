#!/usr/bin/env node
/**
 * Federation status checker
 * Verifies the worker's atproto repo is indexable by bsky relay/appview.
 *
 * Usage: node cli/check-federation.js
 *
 * Checks:
 * 1. Local journal integrity (commit chain + signatures)
 * 2. Deployed repo (getRepoStatus / getRepo via XRPC)
 * 3. bsky appview resolveHandle (identity resolution)
 * 4. bsky appview getProfile (indexing - works only after relay indexes us)
 * 5. relay getRepoStatus (host/repo known to bsky.network)
 */

import fs from 'node:fs'
import { JournalWriter } from './journal.js'

const WORKER = process.env.WORKER_URL || 'https://atproto-worker.yiesty.workers.dev'
const DID = process.env.OWNER_DID || 'did:web:atproto-worker.yiesty.workers.dev'
const HANDLE = process.env.OWNER_HANDLE || 'atproto-worker.yiesty.workers.dev'

async function main() {
    const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'))

    console.log('=== 1. Local journal integrity ===')
    try {
        const journal = new JournalWriter('./journal.ndjson')
        const events = journal.readAll()
        const { verifyCommitSig, recordCid, commitCid } = await import('./atproto.js')
        let ok = 0
        for (const e of events) {
            if (e.commitCid) {
                const sigOk = await verifyCommitSig(e.commit, config.publicKey)
                const cidOk = (await commitCid(e.commit)) === e.commitCid
                if (sigOk && cidOk) ok++
            }
        }
        console.log(`  ${ok}/${events.length} commits verified`)
    } catch (e) {
        console.log(`  FAIL: ${e.message}`)
    }

    console.log('\n=== 2. Deployed worker ===')
    for (const path of ['xrpc/com.atproto.sync.getRepoStatus?did=' + DID, 'xrpc/_health']) {
        try {
            const r = await fetch(`${WORKER}/${path}`)
            const body = await r.text()
            console.log(`  ${path.split('?')[0].split('/').pop()}: HTTP ${r.status} ${body.slice(0, 80)}`)
        } catch (e) {
            console.log(`  ${path}: FAIL ${e.message}`)
        }
    }

    console.log('\n=== 3. appview resolveHandle (identity) ===')
    try {
        const r = await fetch(`https://api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${HANDLE}`)
        const body = await r.text()
        console.log(`  HTTP ${r.status} ${body.slice(0, 100)}`)
    } catch (e) {
        console.log(`  FAIL ${e.message}`)
    }

    console.log('\n=== 4. appview getProfile (indexing) ===')
    try {
        const r = await fetch(`https://api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${DID}`)
        const body = await r.text()
        console.log(`  HTTP ${r.status} ${body.slice(0, 150)}`)
    } catch (e) {
        console.log(`  FAIL ${e.message}`)
    }

    console.log('\n=== 5. bsky.network relay getRepoStatus ===')
    try {
        const r = await fetch(`https://bsky.network/xrpc/com.atproto.sync.getRepoStatus?did=${DID}`)
        const body = await r.text()
        console.log(`  HTTP ${r.status} ${body.slice(0, 100)}`)
    } catch (e) {
        console.log(`  FAIL ${e.message}`)
    }

    console.log('\nDone. Items 3+ indicate federation progress:')
    console.log('  3 OK = identity resolvable (relay knows your handle)')
    console.log('  4 OK = profile visible on bsky.app')
    console.log('  5 OK = repo indexed by relay')
}

main().catch(e => { console.error(e); process.exit(1) })
