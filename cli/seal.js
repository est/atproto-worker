#!/usr/bin/env node
/**
 * ATProto signing CLI
 * 
 * Usage:
 *   node cli/seal.js init              # Generate keypair
 *   node cli/seal.js post "Hello!"     # Create a post
 *   node cli/seal.js like at://...     # Like a post
 *   node cli/seal.js repost at://...   # Repost
 *   node cli/seal.js follow did:...    # Follow someone
 *   node cli/seal.js validate          # Validate journal
 *   node cli/seal.js list              # List all records
 */

import fs from 'node:fs'
import path from 'node:path'
import { generateKeypair, generateKeypairP256, publicKeyToMultibase, normalizeKey } from './crypto.js'
import { JournalWriter } from './journal.js'
import { RepoManager } from './repo.js'
import { carToBase64, buildImageEmbed } from './atproto.js'
import { generateTID, readCarFile, base64ToBytes, bytesToBase64 } from '../src/shared.js'
import { generateDidWebDocument } from '../src/did.js'

const CONFIG_PATH = './config.json'
const JOURNAL_PATH = './journal.ndjson'
const STATE_PATH = './.repo-state.json'
const UPLOADS_DIR = './public/uploads'
const ACCOUNTS_LOCAL = './config.accounts.json'      // local only, holds private keys (gitignored)

/**
 * Load local account configs (private keys). Gitignored.
 */
function loadAccountsLocal() {
    if (fs.existsSync(ACCOUNTS_LOCAL)) {
        return JSON.parse(fs.readFileSync(ACCOUNTS_LOCAL, 'utf-8'))
    }
    return {}
}

function saveAccountsLocal(accounts) {
    fs.writeFileSync(ACCOUNTS_LOCAL, JSON.stringify(accounts, null, 2))
}

/**
 * Extract --curve from an argument list (default p256). Returns the remaining
 * positional args plus the validated curve.
 */
function takeCurveArg(args, fallback = 'p256') {
    let curve = fallback
    const positional = []
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg === '--curve') {
            curve = args[++i]
        } else if (arg.startsWith('--curve=')) {
            curve = arg.slice('--curve='.length)
        } else {
            positional.push(arg)
        }
    }
    if (curve !== 'p256' && curve !== 'k256') {
        throw new Error(`Unsupported curve "${curve}" (expected p256 or k256)`)
    }
    return { curve, positional }
}

/**
 * Generate a keypair for the requested curve, normalized to the config shape.
 */
async function generateKeyForCurve(curve) {
    if (curve === 'p256') return generateKeypairP256()
    const { privateKey, publicKey } = await generateKeypair()
    return {
        curve: 'k256',
        privateKey,
        publicKey,
        publicKeyMultibase: publicKeyToMultibase(publicKey)
    }
}

/**
 * Write the static identity files the Worker serves and self-discovers:
 * public/.well-known/did.json + public/.well-known/atproto-did.
 */
function writeIdentityFiles(did, handle, publicKeyMultibase, pdsEndpoint) {
    const didDoc = generateDidWebDocument(handle, handle, publicKeyMultibase, did, pdsEndpoint)
    fs.mkdirSync('./public/.well-known', { recursive: true })
    fs.writeFileSync('./public/.well-known/did.json', JSON.stringify(didDoc, null, 2))
    fs.writeFileSync('./public/.well-known/atproto-did', did + '\n')
    return didDoc
}

/**
 * Add a publishing account: generate a keypair (kept locally for signing)
 * and print the two static files the account owner must host on their
 * domain (/.well-known/atproto-did + /.well-known/did.json). No registry
 * file is needed — the worker discovers accounts from the journal itself.
 */
async function accountAdd(args) {
    let curve = 'p256'
    let handle = null
    try {
        const parsed = takeCurveArg(args, 'p256')
        curve = parsed.curve
        handle = parsed.positional[0]
    } catch (e) {
        console.error(e.message)
        process.exit(1)
    }

    if (!handle || !handle.includes('.')) {
        console.error('Usage: node cli/seal.js account add <handle> [--curve p256|k256]   # e.g. pub1.example.com')
        process.exit(1)
    }

    const main = loadConfig()
    const pdsUrl = main && main.handle ? `https://${main.handle}` : 'https://<your-worker>.workers.dev'
    const did = `did:web:${handle}`
    const id = handle.split('.')[0]

    const accounts = loadAccountsLocal()
    if (accounts[id]) {
        console.error(`Account id "${id}" already exists in ${ACCOUNTS_LOCAL}`)
        process.exit(1)
    }

    const key = await generateKeyForCurve(curve)
    const { privateKey, publicKey, publicKeyMultibase } = key

    const didDoc = generateDidWebDocument(handle, handle, publicKeyMultibase, did, pdsUrl)

    // Local config only (signing key); no deployable registry — the worker
    // derives hosted accounts from the journal and keys from well-known.
    accounts[id] = { handle, did, curve, privateKey, publicKey, publicKeyMultibase }
    saveAccountsLocal(accounts)

    console.log('✓ Publishing account created')
    console.log(`  id: ${id}`)
    console.log(`  DID: ${did}`)
    console.log(`  Handle: ${handle}`)
    console.log(`  Curve: ${curve}`)
    console.log('')
    console.log('请让账号持有者在其域名（无需 DNS 配置，放两个静态文件即可）放置：')
    console.log('')
    console.log(`1) https://${handle}/.well-known/atproto-did  （纯文本，内容：）`)
    console.log(`   ${did}`)
    console.log('')
    console.log(`2) https://${handle}/.well-known/did.json  （内容：）`)
    console.log(JSON.stringify(didDoc, null, 2))
    console.log('')
    console.log('   （可选替代 DNS：在 _atproto.' + handle + ' 加 TXT "did=' + did + '" 也可以，二选一即可）')
    console.log('')
    console.log(`3) 发布：node cli/seal.js post --account ${id} "内容" [--image x.jpg]`)
    console.log('   然后 cp journal.ndjson public/journal.ndjson && 部署（Worker 从 journal 自动发现该账号）')
}

/**
 * Load config and normalize the key fields. Configs written before curves
 * existed have no `curve` and are treated as k256.
 * Returns { ...rawConfig, curve, privateKey, publicKey, publicKeyMultibase,
 *           previousPublicKeys: string[] } or null.
 */
function loadConfig() {
    if (fs.existsSync(CONFIG_PATH)) {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
        const key = normalizeKey(raw)
        return {
            ...raw,
            ...key,
            previousPublicKeys: Array.isArray(raw.previousPublicKeys) ? raw.previousPublicKeys : []
        }
    }
    return null
}

function saveConfig(config) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
}

/**
 * Initialize - generate keypair (default curve: p256)
 */
async function init(args) {
    if (fs.existsSync(CONFIG_PATH)) {
        console.log('Config already exists. Delete config.json to reinitialize.')
        return
    }

    let curve = 'p256'
    let didArg, handleArg
    try {
        const parsed = takeCurveArg(args, 'p256')
        curve = parsed.curve
        didArg = parsed.positional[0]
        handleArg = parsed.positional[1]
    } catch (e) {
        console.error(e.message)
        process.exit(1)
    }

    console.log(`Generating ${curve} keypair...`)
    const key = await generateKeyForCurve(curve)

    // Prompt for DID and handle
    const did = didArg || `did:web:localhost`
    const handle = handleArg || 'localhost'

    const config = {
        did,
        handle,
        curve,
        privateKey: key.privateKey,
        publicKey: key.publicKey,
        publicKeyMultibase: key.publicKeyMultibase
    }

    saveConfig(config)

    // Write the static identity files the Worker serves and self-discovers
    // (no env vars needed): /.well-known/did.json + /.well-known/atproto-did
    writeIdentityFiles(config.did, config.handle, config.publicKeyMultibase)

    console.log('✓ Keypair generated')
    console.log(`  DID: ${did}`)
    console.log(`  Handle: ${handle}`)
    console.log(`  Curve: ${curve}`)
    console.log(`  Public Key: ${key.publicKey.slice(0, 16)}...`)
    console.log(`  Multibase: ${config.publicKeyMultibase.slice(0, 20)}...`)
    console.log('')
    console.log('✓ 身份文件已生成（公钥自发现，无需环境变量）：')
    console.log('  public/.well-known/did.json')
    console.log('  public/.well-known/atproto-did')
    console.log('')
    console.log('下一步：提交 public/.well-known/ 并部署（npm run deploy）。')
    console.log('私钥保存在 config.json（本地，已 gitignore），Worker 永不接触。')
}

/**
 * Rotate key - generate a new keypair, back up the old config, and rewrite
 * the identity files. Does NOT append a journal event and does NOT deploy:
 * the next real write with the new key completes the rotation.
 */
async function rotateKey(args) {
    const config = loadConfig()
    if (!config) {
        console.error('Not initialized. Run: node cli/seal.js init')
        process.exit(1)
    }

    let curve = config.curve || 'k256'
    try {
        // Default to the account's current curve; use --curve to migrate.
        curve = takeCurveArg(args, curve).curve
    } catch (e) {
        console.error(e.message)
        process.exit(1)
    }

    console.log(`Rotating ${config.curve || 'k256'} key to ${curve}...`)

    // Back up the current config (contains the old private key) before
    // overwriting it. config.json.bak is gitignored.
    fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.bak')

    const key = await generateKeyForCurve(curve)

    const previousPublicKeys = Array.isArray(config.previousPublicKeys)
        ? [...config.previousPublicKeys]
        : []
    if (config.publicKeyMultibase && !previousPublicKeys.includes(config.publicKeyMultibase)) {
        previousPublicKeys.push(config.publicKeyMultibase)
    }

    const updated = {
        ...config,
        curve,
        privateKey: key.privateKey,
        publicKey: key.publicKey,
        publicKeyMultibase: key.publicKeyMultibase,
        previousPublicKeys
    }
    // Don't persist the normalized `previousPublicKeys: []` default twice etc.
    saveConfig(updated)

    // Regenerate the served identity files with the new key. The DID and
    // handle are preserved.
    writeIdentityFiles(updated.did, updated.handle, updated.publicKeyMultibase)

    console.log('✓ Keypair rotated')
    console.log(`  Curve: ${curve}`)
    console.log(`  Old Multibase: ${config.publicKeyMultibase}`)
    console.log(`  New Multibase: ${updated.publicKeyMultibase}`)
    console.log('')
    console.log(`✓ Config backed up to ${CONFIG_PATH}.bak (gitignored)`)
    console.log('✓ public/.well-known/did.json regenerated with the new key')
    console.log('')
    console.log('IMPORTANT:')
    console.log('  1. Publish/deploy public/.well-known/did.json NOW (npm run deploy),')
    console.log('     before the next write. Relays/appviews cache the old key briefly.')
    console.log('  2. The next write signed with the new key completes the rotation;')
    console.log('     no journal event is appended by this command.')
}

/**
 * Re-sign the current repo head with the current key without changing any
 * record content. Used to complete a key rotation (did.json already points at
 * the new key, but the head commit is still signed with the old one).
 *
 * It performs an `update` of the latest record with identical content, so the
 * MST root is unchanged and the firehose diff is empty. The new head is a
 * normal commit signed by the new key.
 */
async function rotateHead() {
    const config = loadConfig()
    if (!config) {
        console.error('Not initialized. Run: node cli/seal.js init')
        process.exit(1)
    }

    const all = new JournalWriter(JOURNAL_PATH).readAll()
    const latest = [...all].reverse().find(e =>
        e.did === config.did && e.op !== 'delete' && e.record && e.collection && e.rkey
    )
    if (!latest) {
        console.error('No existing record to re-sign. Run a normal write (e.g. post) first.')
        process.exit(1)
    }

    const repo = new RepoManager(config.did, config, STATE_PATH)
    const result = await repo.applyWrite({
        action: 'update',
        collection: latest.collection,
        rkey: latest.rkey,
        record: latest.record
    })

    // Include the full blockstore: the MST root/record blocks may be unchanged
    // (so applyWrite returns no new MST blocks), but the Worker append check
    // requires them to be present in the CAR.
    const blocks = new Map(repo.blockstore)
    const car = await repo.buildCar(result.commitCid, blocks)

    const event = await new JournalWriter(JOURNAL_PATH, config.did).append({
        op: 'update',
        collection: latest.collection,
        rkey: latest.rkey,
        record: latest.record,
        did: config.did,
        rev: result.rev,
        recordCid: result.recordCid,
        commit: result.commit,
        commitCid: result.commitCid,
        mstRoot: result.mstRoot,
        prevMstRoot: result.prevMstRoot,
        blocksB64: carToBase64(car),
        signingKey: config.publicKeyMultibase
    })

    console.log('✓ Head re-signed (no content change)')
    console.log(`  Curve: ${config.curve}`)
    console.log(`  URI: at://${config.did}/${latest.collection}/${latest.rkey}`)
    console.log(`  Commit CID: ${result.commitCid}`)
    console.log(`  Rev: ${result.rev}`)
    console.log(`  Offset: ${event.offset}`)
}

// ============ Remote ledger sync (push / pull) ============

function parseRemoteArgs(args) {
    let remote = process.env.ATPROTO_WORKER_URL || null
    let accountId = null
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--remote') remote = args[++i]
        else if (args[i] === '--account') accountId = args[++i]
    }
    return { remote, accountId }
}

function resolveAccount(accountId) {
    if (accountId) {
        const acct = loadAccountsLocal()[accountId]
        if (!acct) {
            console.error(`Account "${accountId}" not found.`)
            process.exit(1)
        }
        return {
            did: acct.did,
            handle: acct.handle,
            key: normalizeKey(acct),
            statePath: `./.repo-state-${accountId}.json`
        }
    }
    const config = loadConfig()
    if (!config) {
        console.error('Not initialized. Run: node cli/seal.js init')
        process.exit(1)
    }
    return { did: config.did, handle: config.handle, key: config, statePath: STATE_PATH }
}

function defaultRemote(handle) {
    if (!handle) return null
    return handle.startsWith('localhost') || handle.startsWith('127.0.0.1')
        ? `http://${handle}`
        : `https://${handle}`
}

async function fetchRemoteSnapshot(remote) {
    const resp = await fetch(`${remote.replace(/\/$/, '')}/xrpc/com.atproto.worker.snapshot`, {
        headers: { 'Accept': 'application/x-ndjson' }
    })
    if (!resp.ok) {
        throw new Error(`snapshot failed: HTTP ${resp.status} ${await resp.text().catch(() => '')}`)
    }
    const text = (await resp.text()).trim()
    return text ? text.split('\n').map(line => JSON.parse(line)) : []
}

function rebuildRepoState(events, did, statePath) {
    const blocks = new Map()
    for (const event of events) {
        if (event.did !== did || !event.blocksB64) continue
        const car = readCarFile(base64ToBytes(event.blocksB64))
        for (const [cid, bytes] of car.blocks) blocks.set(cid, bytes)
    }
    const last = [...events].reverse().find(e => e.did === did && (e.commitCid || e.cid))
    if (!last) {
        console.warn(`  No events for ${did}; local repo state left untouched.`)
        return
    }
    const state = {
        mstRoot: last.commit?.data || last.mstRoot || null,
        commitCid: last.commitCid || last.cid || null,
        rev: last.rev || null,
        blocks: Object.fromEntries([...blocks].map(([cid, bytes]) => [cid, bytesToBase64(bytes)]))
    }
    fs.writeFileSync(statePath, JSON.stringify(state))
    console.log(`  Rebuilt ${statePath} (head ${state.commitCid}, rev ${state.rev})`)
}

/**
 * Push local journal events that the remote ledger does not have yet.
 * The events are already signed; this never re-signs.
 */
async function push(args) {
    const { remote: remoteArg, accountId } = parseRemoteArgs(args)
    const account = resolveAccount(accountId)
    const remote = (remoteArg || defaultRemote(account.handle))
    if (!remote) {
        console.error('No remote URL. Pass --remote https://your-worker or set ATPROTO_WORKER_URL.')
        process.exit(1)
    }

    const all = new JournalWriter(JOURNAL_PATH).readAll()
    const local = all.filter(e => e.did === account.did)
    const remoteEvents = await fetchRemoteSnapshot(remote)
    const remoteCids = new Set(
        remoteEvents.filter(e => e.did === account.did).map(e => e.commitCid || e.cid)
    )
    const missing = local.filter(e => {
        const cid = e.commitCid || e.cid
        return cid && !remoteCids.has(cid)
    })

    console.log(`Remote: ${remote}`)
    console.log(`Local events: ${local.length}, already remote: ${local.length - missing.length}, to push: ${missing.length}`)

    if (missing.length === 0) {
        console.log('✓ Already in sync')
        return
    }

    for (const event of missing) {
        if (!event.signingKey) {
            console.error(`  ✗ ${event.commitCid || event.cid}: missing signingKey (pre-v2 event not in the remote seed); cannot push`)
            process.exit(1)
        }
        const resp = await fetch(`${remote.replace(/\/$/, '')}/xrpc/com.atproto.worker.appendEvent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event })
        })
        const body = await resp.json().catch(() => ({}))
        if (resp.status === 409) {
            console.error('  ✗ 409 RepoConflict: the remote head moved. Run `node cli/seal.js pull` first, then retry.')
            console.error('    remote head:', body.head || body.details?.head || '(unknown)')
            process.exit(1)
        }
        if (!resp.ok) {
            console.error(`  ✗ ${event.commitCid || event.cid}: ${resp.status} ${body.error || ''} ${body.message || ''}`)
            process.exit(1)
        }
        console.log(`  ✓ pushed ${event.commitCid || event.cid} (seq ${body.seq})`)
    }
    console.log('✓ Push complete')
}

/**
 * Pull the live ledger into local journal/public/journal.ndjson and rebuild
 * the local repo state so the next CLI write is based on the current head.
 */
async function pull(args) {
    const { remote: remoteArg, accountId } = parseRemoteArgs(args)
    const account = resolveAccount(accountId)
    const remote = (remoteArg || defaultRemote(account.handle))
    if (!remote) {
        console.error('No remote URL. Pass --remote https://your-worker or set ATPROTO_WORKER_URL.')
        process.exit(1)
    }

    const events = await fetchRemoteSnapshot(remote)
    if (events.length === 0) {
        console.log('Remote ledger is empty (or only the static seed is available); nothing to pull.')
        return
    }

    const ndjson = events.map(e => JSON.stringify(e)).join('\n') + '\n'
    fs.writeFileSync(JOURNAL_PATH, ndjson)
    fs.mkdirSync('./public', { recursive: true })
    fs.writeFileSync('./public/journal.ndjson', ndjson)
    console.log(`✓ Pulled ${events.length} events into ${JOURNAL_PATH} and public/journal.ndjson`)
    rebuildRepoState(events, account.did, account.statePath)
}

/**
 * Create a post
 * @param {string} text
 * @param {{images?: Array<{path: string, alt?: string}>, accountId?: string}} options
 */
async function createPost(text, options = {}) {
    // Publishing account: load its config (did + private key). Otherwise the
    // main account (config.json) is used.
    let config = loadConfig()
    let statePath = STATE_PATH
    let uploadsDir = UPLOADS_DIR
    let did
    let key
    if (options.accountId) {
        const accounts = loadAccountsLocal()
        const acct = accounts[options.accountId]
        if (!acct) {
            console.error(`Account "${options.accountId}" not found. Run: node cli/seal.js account add <handle>`)
            process.exit(1)
        }
        did = acct.did
        key = normalizeKey(acct)
        statePath = `./.repo-state-${options.accountId}.json`
        uploadsDir = path.join(UPLOADS_DIR, options.accountId)
    } else {
        if (!config) {
            console.error('Not initialized. Run: node cli/seal.js init')
            process.exit(1)
        }
        did = config.did
        key = config
    }

    const repo = new RepoManager(did, key, statePath)
    const journal = new JournalWriter(JOURNAL_PATH, did)
    const rkey = generateTID()

    const record = {
        $type: 'app.bsky.feed.post',
        text,
        createdAt: new Date().toISOString()
    }

    // Optional images: build the embed record and stage blob files into
    // the account's uploads dir (deployed with the Worker as static assets).
    if (options.images && options.images.length > 0) {
        const { embed, uploads } = await buildImageEmbed(options.images)
        record.embed = embed
        fs.mkdirSync(uploadsDir, { recursive: true })
        for (const u of uploads) {
            const file = path.join(uploadsDir, `${u.cid}.${u.ext}`)
            fs.writeFileSync(file, u.bytes)
            console.log(`  Blob: ${u.cid}.${u.ext} (${u.bytes.length} bytes)`)
        }
    }

    // Apply write to repo -> commit v3 + blocks
    const result = await repo.applyWrite({
        action: 'create',
        collection: 'app.bsky.feed.post',
        rkey,
        record
    })

    // Build firehose CAR (commit + MST nodes + record)
    const car = await repo.buildCar(result.commitCid, result.newBlocks)
    const carB64 = carToBase64(car)

    // Append to journal with full atproto data
    const event = await journal.append({
        op: 'create',
        collection: 'app.bsky.feed.post',
        rkey,
        record,
        did,
        rev: result.rev,
        recordCid: result.recordCid,
        commit: result.commit,
        commitCid: result.commitCid,
        mstRoot: result.mstRoot,
        prevMstRoot: result.prevMstRoot,
        blocksB64: carB64,
        signingKey: key.publicKeyMultibase
    })

    console.log('✓ Post created')
    console.log(`  URI: at://${did}/app.bsky.feed.post/${rkey}`)
    console.log(`  Record CID: ${result.recordCid}`)
    console.log(`  Commit CID: ${result.commitCid}`)
    console.log(`  MST root: ${result.mstRoot}`)
    console.log(`  Offset: ${event.offset}`)
}

/**
 * Create a like
 */
async function createLike(subjectUri, subjectCid) {
    const config = loadConfig()
    if (!config) {
        console.error('Not initialized. Run: node cli/seal.js init')
        process.exit(1)
    }

    if (!subjectUri) {
        console.error('Usage: node cli/seal.js like <at-uri> <cid>')
        console.error('  subjectUri is required (e.g., at://did:plc:xxx/app.bsky.feed.post/yyy)')
        process.exit(1)
    }

    if (!subjectCid) {
        console.error('subjectCid is required for like records')
        console.error('Usage: node cli/seal.js like <at-uri> <cid>')
        console.error('  The CID identifies the specific version of the record being liked')
        process.exit(1)
    }

    const key = config
    const repo = new RepoManager(config.did, key, STATE_PATH)
    const journal = new JournalWriter(JOURNAL_PATH)
    const rkey = generateTID()

    const record = {
        $type: 'app.bsky.feed.like',
        subject: {
            uri: subjectUri,
            cid: subjectCid
        },
        createdAt: new Date().toISOString()
    }

    const result = await repo.applyWrite({
        action: 'create',
        collection: 'app.bsky.feed.like',
        rkey,
        record
    })
    const carB64 = carToBase64(await repo.buildCar(result.commitCid, result.newBlocks))

    const event = await journal.append({
        op: 'create',
        collection: 'app.bsky.feed.like',
        rkey,
        record,
        did: config.did,
        rev: result.rev,
        recordCid: result.recordCid,
        commit: result.commit,
        commitCid: result.commitCid,
        mstRoot: result.mstRoot,
        prevMstRoot: result.prevMstRoot,
        blocksB64: carB64,
        signingKey: key.publicKeyMultibase
    })

    console.log('✓ Like created')
    console.log(`  URI: at://${config.did}/app.bsky.feed.like/${rkey}`)
    console.log(`  Subject: ${subjectUri}`)
    console.log(`  Subject CID: ${subjectCid}`)
}

/**
 * Create a repost
 */
async function createRepost(subjectUri, subjectCid) {
    const config = loadConfig()
    if (!config) {
        console.error('Not initialized. Run: node cli/seal.js init')
        process.exit(1)
    }

    if (!subjectUri) {
        console.error('Usage: node cli/seal.js repost <at-uri> <cid>')
        console.error('  subjectUri is required (e.g., at://did:plc:xxx/app.bsky.feed.post/yyy)')
        process.exit(1)
    }

    if (!subjectCid) {
        console.error('subjectCid is required for repost records')
        console.error('Usage: node cli/seal.js repost <at-uri> <cid>')
        console.error('  The CID identifies the specific version of the record being reposted')
        process.exit(1)
    }

    const key = config
    const repo = new RepoManager(config.did, key, STATE_PATH)
    const journal = new JournalWriter(JOURNAL_PATH)
    const rkey = generateTID()

    const record = {
        $type: 'app.bsky.feed.repost',
        subject: {
            uri: subjectUri,
            cid: subjectCid
        },
        createdAt: new Date().toISOString()
    }

    const result = await repo.applyWrite({
        action: 'create',
        collection: 'app.bsky.feed.repost',
        rkey,
        record
    })
    const carB64 = carToBase64(await repo.buildCar(result.commitCid, result.newBlocks))

    const event = await journal.append({
        op: 'create',
        collection: 'app.bsky.feed.repost',
        rkey,
        record,
        did: config.did,
        rev: result.rev,
        recordCid: result.recordCid,
        commit: result.commit,
        commitCid: result.commitCid,
        mstRoot: result.mstRoot,
        prevMstRoot: result.prevMstRoot,
        blocksB64: carB64,
        signingKey: key.publicKeyMultibase
    })

    console.log('✓ Repost created')
    console.log(`  URI: at://${config.did}/app.bsky.feed.repost/${rkey}`)
    console.log(`  Subject: ${subjectUri}`)
    console.log(`  Subject CID: ${subjectCid}`)
}

/**
 * Create a follow
 */
async function createFollow(subjectDid) {
    const config = loadConfig()
    if (!config) {
        console.error('Not initialized. Run: node cli/seal.js init')
        process.exit(1)
    }

    const key = config
    const repo = new RepoManager(config.did, key, STATE_PATH)
    const journal = new JournalWriter(JOURNAL_PATH)
    const rkey = generateTID()

    const record = {
        $type: 'app.bsky.graph.follow',
        subject: subjectDid,
        createdAt: new Date().toISOString()
    }

    const result = await repo.applyWrite({
        action: 'create',
        collection: 'app.bsky.graph.follow',
        rkey,
        record
    })
    const carB64 = carToBase64(await repo.buildCar(result.commitCid, result.newBlocks))

    const event = await journal.append({
        op: 'create',
        collection: 'app.bsky.graph.follow',
        rkey,
        record,
        did: config.did,
        rev: result.rev,
        recordCid: result.recordCid,
        commit: result.commit,
        commitCid: result.commitCid,
        mstRoot: result.mstRoot,
        prevMstRoot: result.prevMstRoot,
        blocksB64: carB64,
        signingKey: key.publicKeyMultibase
    })

    console.log('✓ Follow created')
    console.log(`  URI: at://${config.did}/app.bsky.graph.follow/${rkey}`)
    console.log(`  Subject: ${subjectDid}`)
}

/**
 * Validate journal (chain integrity + commit signatures)
 */
async function validate() {
    const config = loadConfig()
    const journal = new JournalWriter(JOURNAL_PATH)

    try {
        const events = journal.readAll()
        const { verifyCommitSig, verifyCommitSigWithMultikey, recordCid } = await import('./atproto.js')

        // Chain integrity
        const chainResult = await journal.validate()
        let sigErrors = 0
        let warnings = 0
        let verified = 0

        // Per-event signature verification:
        // - event.signingKey (schema v2) is authoritative for that event;
        // - otherwise try the account's current key + previousPublicKeys.
        // Events that cannot be checked (e.g. history signed by a key we no
        // longer have) produce a warning, not a hard failure.
        const accounts = loadAccountsLocal()
        const keyForDid = (did) => {
            if (config && did === config.did) {
                return { current: config, previous: config.previousPublicKeys || [] }
            }
            const acct = Object.values(accounts).find(a => a.did === did)
            if (!acct) return null
            return {
                current: normalizeKey(acct),
                previous: Array.isArray(acct.previousPublicKeys) ? acct.previousPublicKeys : []
            }
        }

        for (const event of events) {
            if (!event.commitCid) continue

            let sigOk = false
            let checked = false
            let sigError = null

            if (event.signingKey) {
                checked = true
                try {
                    sigOk = await verifyCommitSigWithMultikey(event.commit, event.signingKey)
                } catch (e) {
                    sigError = e
                }
                if (!sigOk) {
                    sigErrors++
                    console.error(`  ✗ Commit signature invalid at offset ${event.offset} (signingKey ${String(event.signingKey).slice(0, 12)}...)${sigError ? ': ' + sigError.message : ''}`)
                }
            } else {
                const entry = keyForDid(event.did)
                if (entry) {
                    for (const candidate of [entry.current, ...entry.previous]) {
                        if (!candidate) continue
                        checked = true
                        try {
                            sigOk = typeof candidate === 'string'
                                ? await verifyCommitSigWithMultikey(event.commit, candidate)
                                : await verifyCommitSig(event.commit, candidate)
                        } catch {
                            sigOk = false
                        }
                        if (sigOk) break
                    }
                }
                if (!sigOk) {
                    warnings++
                    console.warn(`  ⚠ Cannot verify commit signature at offset ${event.offset} (${checked ? 'no current/previous key matched' : 'no key available'}) — legacy event left unverified`)
                }
            }

            if (sigOk) verified++

            if (event.recordCid && event.record) {
                const expected = await recordCid(event.record)
                if (event.recordCid !== expected) {
                    sigErrors++
                    console.error(`  ✗ Record CID mismatch at offset ${event.offset}`)
                }
            }
        }

        if (sigErrors > 0) {
            throw new Error(`${sigErrors} signature/CID verification failure(s)`)
        }

        console.log('✓ Journal is valid')
        console.log(`  Events: ${chainResult.eventCount}`)
        console.log(`  Commits verified: ${verified}/${events.filter(e => e.commitCid).length}`)
        if (warnings > 0) {
            console.log(`  Warnings: ${warnings} legacy commit(s) could not be verified (no matching key)`)
        }
    } catch (e) {
        console.error('✗ Journal validation failed:', e.message)
        process.exit(1)
    }
}

/**
 * List all records
 */
function listRecords() {
    const journal = new JournalWriter(JOURNAL_PATH)
    const events = journal.readAll()

    if (events.length === 0) {
        console.log('No records in journal')
        return
    }

    console.log(`Journal contains ${events.length} events:\n`)

    for (const event of events) {
        const preview = event.record?.text
            ? event.record.text.slice(0, 50)
            : JSON.stringify(event.record).slice(0, 50)

        console.log(`  [${event.offset}] ${event.op} ${event.collection}/${event.rkey}`)
        console.log(`       ${preview}...`)
    }
}

/**
 * Parse `post` arguments: positional text + repeatable --image/--alt + --account.
 */
function parsePostArgs(args) {
    let text = 'Hello from atproto-worker!'
    let accountId = null
    const images = []
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--image' && args[i + 1]) {
            images.push({ path: args[++i] })
        } else if (args[i] === '--alt' && args[i + 1]) {
            images[images.length - 1] && (images[images.length - 1].alt = args[++i])
        } else if (args[i] === '--account' && args[i + 1]) {
            accountId = args[++i]
        } else {
            text = args[i]
        }
    }
    return { text, images, accountId }
}

// Main CLI
const command = process.argv[2]

switch (command) {
    case 'init':
        init(process.argv.slice(3))
        break
    case 'rotate-key':
        rotateKey(process.argv.slice(3))
        break
    case 'rotate-head':
        rotateHead()
        break
    case 'push':
        push(process.argv.slice(3))
        break
    case 'pull':
        pull(process.argv.slice(3))
        break
    case 'account':
        if (process.argv[3] === 'add') accountAdd(process.argv.slice(4))
        else console.error('Usage: node cli/seal.js account add <handle> [--curve p256|k256]')
        break
    case 'post': {
        const { text, images, accountId } = parsePostArgs(process.argv.slice(3))
        createPost(text, { images, accountId })
        break
    }
    case 'like':
        createLike(process.argv[3], process.argv[4])
        break
    case 'repost':
        createRepost(process.argv[3], process.argv[4])
        break
    case 'follow':
        createFollow(process.argv[3])
        break
    case 'validate':
        validate()
        break
    case 'list':
        listRecords()
        break
    default:
        console.log(`
ATProto Signing CLI

Usage:
  node cli/seal.js init [did] [handle] [--curve p256|k256]   Initialize (default curve: p256)
  node cli/seal.js rotate-key [--curve p256|k256]            Rotate key + rewrite did.json (no journal write)
  node cli/seal.js rotate-head                               Re-sign the current head with the current key (no content change)
  node cli/seal.js push [--remote URL] [--account id]        Push local signed events missing from the remote ledger
  node cli/seal.js pull [--remote URL] [--account id]        Pull the live ledger + rebuild local repo state
  node cli/seal.js account add <handle> [--curve p256|k256]  注册发布账号（输出 did.json + TXT 粘贴内容）
  node cli/seal.js post "text" [--image path.jpg] [--alt "描述"] [--account <id>]  发帖（最多 4 图；--account 用发布账号）
  node cli/seal.js like <at-uri> <cid>   Like a post (requires subject CID)
  node cli/seal.js repost <at-uri> <cid> Repost (requires subject CID)
  node cli/seal.js follow did:...        Follow someone
  node cli/seal.js validate              Validate journal integrity
  node cli/seal.js list                  List all records
`)
}
