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
 *
 * Requires either a direct network route to workers.dev/bsky endpoints
 * or an HTTPS proxy via the standard env vars (https_proxy / http_proxy).
 */

import fs from 'node:fs'
import { JournalWriter } from './journal.js'

const WORKER = process.env.WORKER_URL || 'https://atproto-worker.yiesty.workers.dev'
const DID = process.env.OWNER_DID || 'did:web:atproto-worker.yiesty.workers.dev'
const HANDLE = process.env.OWNER_HANDLE || 'atproto-worker.yiesty.workers.dev'

const FETCH_TIMEOUT_MS = 15000

async function fetchWithTimeout(url) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
        return await fetch(url, { signal: controller.signal })
    } finally {
        clearTimeout(timer)
    }
}

async function report(name, url, sliceLen = 100) {
    try {
        const r = await fetchWithTimeout(url)
        const body = await r.text()
        console.log(`  ${name}: HTTP ${r.status} ${body.slice(0, sliceLen)}`)
    } catch (e) {
        console.log(`  ${name}: FAIL ${e.name === 'AbortError' ? 'timeout' : e.message}`)
    }
}

async function main() {
    console.log('=== 1. Local journal integrity ===')
    try {
        const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'))
        if (!config.publicKey) {
            throw new Error('config.json missing publicKey (run `node cli/seal.js init` first)')
        }
        const journal = new JournalWriter('./journal.ndjson')
        const events = journal.readAll()
        const { verifyCommitSig, commitCid } = await import('./atproto.js')
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
    await report('getRepoStatus', `${WORKER}/xrpc/com.atproto.sync.getRepoStatus?did=${DID}`)
    await report('_health', `${WORKER}/xrpc/_health`)

    console.log('\n=== 3. appview resolveHandle (identity) ===')
    await report('resolveHandle', `https://api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${HANDLE}`)

    console.log('\n=== 4. appview getProfile (indexing) ===')
    await report('getProfile', `https://api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${DID}`, 150)

    console.log('\n=== 5. bsky.network relay getRepoStatus ===')
    await report('relay getRepoStatus', `https://bsky.network/xrpc/com.atproto.sync.getRepoStatus?did=${DID}`)

    console.log('\nDone. Items 3+ indicate federation progress:')
    console.log('  3 OK = identity resolvable (relay knows your handle)')
    console.log('  4 OK = profile visible on bsky.app')
    console.log('  5 OK = repo indexed by relay')
}

main().catch(e => { console.error(e); process.exit(1) })
