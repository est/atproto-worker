#!/usr/bin/env node
/**
 * ATProto signing CLI
 * 
 * Usage:
 *   node cli/sign.js init              # Generate keypair
 *   node cli/sign.js post "Hello!"     # Create a post
 *   node cli/sign.js like at://...     # Like a post
 *   node cli/sign.js repost at://...   # Repost
 *   node cli/sign.js follow did:...    # Follow someone
 *   node cli/sign.js validate          # Validate journal
 *   node cli/sign.js list              # List all records
 */

import fs from 'node:fs'
import path from 'node:path'
import { generateKeypair, sign, publicKeyToMultibase, computeCID } from './crypto.js'
import { JournalWriter } from './journal.js'

const CONFIG_PATH = './config.json'
const JOURNAL_PATH = './journal.ndjson'

// TID generation
const B32_CHARSET = '234567abcdefghijklmnopqrstuvwxyz'
let lastTimestamp = 0
let clockSeq = 0

function generateTID() {
    let timestamp = Date.now() * 1000

    if (timestamp === lastTimestamp) {
        clockSeq++
    } else {
        lastTimestamp = timestamp
        clockSeq = 0
    }

    const combined = BigInt(timestamp) << 10n | BigInt(clockSeq & 0x3ff)

    let tid = ''
    let n = combined
    for (let i = 0; i < 13; i++) {
        tid = B32_CHARSET[Number(n & 31n)] + tid
        n >>= 5n
    }

    return tid
}

/**
 * Load or create config
 */
function loadConfig() {
    if (fs.existsSync(CONFIG_PATH)) {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
    }
    return null
}

function saveConfig(config) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
}

/**
 * Initialize - generate keypair
 */
async function init() {
    if (fs.existsSync(CONFIG_PATH)) {
        console.log('Config already exists. Delete config.json to reinitialize.')
        return
    }

    console.log('Generating secp256k1 keypair...')
    const { privateKey, publicKey } = await generateKeypair()

    // Prompt for DID and handle
    const did = process.argv[3] || `did:web:localhost`
    const handle = process.argv[4] || 'localhost'

    const config = {
        did,
        handle,
        privateKey,
        publicKey,
        publicKeyMultibase: publicKeyToMultibase(publicKey)
    }

    saveConfig(config)

    console.log('✓ Keypair generated')
    console.log(`  DID: ${did}`)
    console.log(`  Handle: ${handle}`)
    console.log(`  Public Key: ${publicKey.slice(0, 16)}...`)
    console.log(`  Multibase: ${config.publicKeyMultibase.slice(0, 20)}...`)
    console.log('')
    console.log('Config saved to config.json (local only, already in .gitignore)')
    console.log('')
    console.log('Next steps for deployment:')
    console.log(`  wrangler secret put PRIVATE_KEY       # paste: ${privateKey}`)
    console.log(`  wrangler secret put OWNER_PUBLIC_KEY  # paste: ${config.publicKeyMultibase}`)
    console.log('  # Then update OWNER_DID and OWNER_HANDLE in wrangler.toml or as secrets')
}

/**
 * Rotate key - generate a new keypair
 */
async function rotateKey() {
    const config = loadConfig()
    if (!config) {
        console.error('Not initialized. Run: node cli/sign.js init')
        process.exit(1)
    }

    console.log('Rotating secp256k1 keypair...')
    const { privateKey, publicKey } = await generateKeypair()

    config.privateKey = privateKey
    config.publicKey = publicKey
    config.publicKeyMultibase = publicKeyToMultibase(publicKey)

    saveConfig(config)

    console.log('✓ Keypair rotated')
    console.log(`  New Public Key: ${publicKey.slice(0, 16)}...`)
    console.log(`  New Multibase: ${config.publicKeyMultibase}`)
    console.log('')
    console.log('Config updated in config.json (local only)')
    console.log('')
    console.log('Next steps for deployment:')
    console.log(`  wrangler secret put PRIVATE_KEY       # paste: ${privateKey}`)
    console.log(`  wrangler secret put OWNER_PUBLIC_KEY  # paste: ${config.publicKeyMultibase}`)
    console.log('  # Then redeploy: wrangler deploy')
}

/**
 * Create a post
 */
async function createPost(text) {
    const config = loadConfig()
    if (!config) {
        console.error('Not initialized. Run: node cli/sign.js init')
        process.exit(1)
    }

    const journal = new JournalWriter(JOURNAL_PATH)
    const rkey = generateTID()

    const record = {
        $type: 'app.bsky.feed.post',
        text,
        createdAt: new Date().toISOString()
    }

    // Create commit data
    const commitData = {
        op: 'create',
        collection: 'app.bsky.feed.post',
        rkey,
        record,
        prev: journal.prevCid
    }

    // Compute CID
    const cid = await computeCID(commitData)

    // Sign the CID
    const sig = await sign(cid, config.privateKey)

    // Append to journal
    const event = await journal.append({
        ...commitData,
        cid,
        sig,
        did: config.did
    })

    console.log('✓ Post created')
    console.log(`  URI: at://${config.did}/app.bsky.feed.post/${rkey}`)
    console.log(`  CID: ${cid}`)
    console.log(`  Offset: ${event.offset}`)
}

/**
 * Create a like
 */
async function createLike(subjectUri) {
    const config = loadConfig()
    if (!config) {
        console.error('Not initialized. Run: node cli/sign.js init')
        process.exit(1)
    }

    const journal = new JournalWriter(JOURNAL_PATH)
    const rkey = generateTID()

    // Parse subject URI to get CID (simplified - in real impl would fetch)
    const subjectCid = 'bafyreiexample' // Placeholder

    const record = {
        $type: 'app.bsky.feed.like',
        subject: {
            uri: subjectUri,
            cid: subjectCid
        },
        createdAt: new Date().toISOString()
    }

    const commitData = {
        op: 'create',
        collection: 'app.bsky.feed.like',
        rkey,
        record,
        prev: journal.prevCid
    }

    const cid = await computeCID(commitData)
    const sig = await sign(cid, config.privateKey)

    const event = await journal.append({
        ...commitData,
        cid,
        sig,
        did: config.did
    })

    console.log('✓ Like created')
    console.log(`  URI: at://${config.did}/app.bsky.feed.like/${rkey}`)
    console.log(`  Subject: ${subjectUri}`)
}

/**
 * Create a follow
 */
async function createFollow(subjectDid) {
    const config = loadConfig()
    if (!config) {
        console.error('Not initialized. Run: node cli/sign.js init')
        process.exit(1)
    }

    const journal = new JournalWriter(JOURNAL_PATH)
    const rkey = generateTID()

    const record = {
        $type: 'app.bsky.graph.follow',
        subject: subjectDid,
        createdAt: new Date().toISOString()
    }

    const commitData = {
        op: 'create',
        collection: 'app.bsky.graph.follow',
        rkey,
        record,
        prev: journal.prevCid
    }

    const cid = await computeCID(commitData)
    const sig = await sign(cid, config.privateKey)

    const event = await journal.append({
        ...commitData,
        cid,
        sig,
        did: config.did
    })

    console.log('✓ Follow created')
    console.log(`  URI: at://${config.did}/app.bsky.graph.follow/${rkey}`)
    console.log(`  Subject: ${subjectDid}`)
}

/**
 * Validate journal
 */
async function validate() {
    const journal = new JournalWriter(JOURNAL_PATH)

    try {
        const result = await journal.validate()
        console.log('✓ Journal is valid')
        console.log(`  Events: ${result.eventCount}`)
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

// Main CLI
const command = process.argv[2]

switch (command) {
    case 'init':
        init()
        break
    case 'rotate-key':
        rotateKey()
        break
    case 'post':
        createPost(process.argv[3] || 'Hello from atproto-worker!')
        break
    case 'like':
        createLike(process.argv[3])
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
  node cli/seal.js init [did] [handle]   Initialize with keypair
  node cli/seal.js rotate-key            Generate a new keypair
  node cli/seal.js post "text"           Create a post
  node cli/seal.js like at://...         Like a post
  node cli/seal.js follow did:...        Follow someone
  node cli/seal.js validate              Validate journal integrity
  node cli/seal.js list                  List all records
`)
}
