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
import { RepoManager } from './repo.js'
import { carToBase64, buildImageEmbed } from './atproto.js'
import { generateTID } from '../src/shared.js'

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
 * Add a publishing account: generate a keypair (kept locally for signing)
 * and print the two static files the account owner must host on their
 * domain (/.well-known/atproto-did + /.well-known/did.json). No registry
 * file is needed — the worker discovers accounts from the journal itself.
 */
async function accountAdd(handle) {
    if (!handle || !handle.includes('.')) {
        console.error('Usage: node cli/seal.js account add <handle>   # e.g. pub1.example.com')
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

    const { privateKey, publicKey } = await generateKeypair()
    const publicKeyMultibase = publicKeyToMultibase(publicKey)

    const didDoc = buildDidDoc(did, handle, publicKeyMultibase, pdsUrl)

    // Local config only (signing key); no deployable registry — the worker
    // derives hosted accounts from the journal and keys from well-known.
    accounts[id] = { handle, did, privateKey, publicKey, publicKeyMultibase }
    saveAccountsLocal(accounts)

    console.log('✓ Publishing account created')
    console.log(`  id: ${id}`)
    console.log(`  DID: ${did}`)
    console.log(`  Handle: ${handle}`)
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

    // Write the static identity files the Worker serves and self-discovers
    // (no env vars needed): /.well-known/did.json + /.well-known/atproto-did
    const didDoc = buildDidDoc(config.did, config.handle, config.publicKeyMultibase)
    fs.mkdirSync('./public/.well-known', { recursive: true })
    fs.writeFileSync('./public/.well-known/did.json', JSON.stringify(didDoc, null, 2))
    fs.writeFileSync('./public/.well-known/atproto-did', config.did + '\n')

    console.log('✓ Keypair generated')
    console.log(`  DID: ${did}`)
    console.log(`  Handle: ${handle}`)
    console.log(`  Public Key: ${publicKey.slice(0, 16)}...`)
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
 * Build a did:web DID document (verificationMethod + atproto_pds service).
 */
function buildDidDoc(did, handle, publicKeyMultibase, pdsUrl) {
    return {
        '@context': [
            'https://www.w3.org/ns/did/v1',
            'https://w3id.org/security/multikey/multikey-v1.jsonld',
            'https://w3id.org/security/suites/secp256k1-2019/v1'
        ],
        id: did,
        alsoKnownAs: [`at://${handle}`],
        verificationMethod: [{
            id: `${did}#atproto`,
            type: 'Multikey',
            controller: did,
            publicKeyMultibase
        }],
        service: [{
            id: '#atproto_pds',
            type: 'AtprotoPersonalDataServer',
            serviceEndpoint: pdsUrl || `https://${handle}`
        }]
    }
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
    console.log(`  # Update OWNER_PUBLIC_KEY in wrangler.toml [vars]:`)
    console.log(`  OWNER_PUBLIC_KEY = "${config.publicKeyMultibase}"`)
    console.log('  # Then redeploy: npm run deploy')
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
    let privateKey
    if (options.accountId) {
        const accounts = loadAccountsLocal()
        const acct = accounts[options.accountId]
        if (!acct) {
            console.error(`Account "${options.accountId}" not found. Run: node cli/seal.js account add <handle>`)
            process.exit(1)
        }
        did = acct.did
        privateKey = acct.privateKey
        statePath = `./.repo-state-${options.accountId}.json`
        uploadsDir = path.join(UPLOADS_DIR, options.accountId)
    } else {
        if (!config) {
            console.error('Not initialized. Run: node cli/sign.js init')
            process.exit(1)
        }
        did = config.did
        privateKey = config.privateKey
    }

    const repo = new RepoManager(did, privateKey, statePath)
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
        blocksB64: carB64
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
        console.error('Not initialized. Run: node cli/sign.js init')
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

    const repo = new RepoManager(config.did, config.privateKey, STATE_PATH)
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
        blocksB64: carB64
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
        console.error('Not initialized. Run: node cli/sign.js init')
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

    const repo = new RepoManager(config.did, config.privateKey, STATE_PATH)
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
        blocksB64: carB64
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
        console.error('Not initialized. Run: node cli/sign.js init')
        process.exit(1)
    }

    const repo = new RepoManager(config.did, config.privateKey, STATE_PATH)
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
        blocksB64: carB64
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
        const { verifyCommitSig, recordCid } = await import('./atproto.js')

        // Chain integrity
        const chainResult = await journal.validate()
        let sigErrors = 0

        // Commit signature + record CID verification (new format).
        // Each account's commits verify against ITS OWN public key.
        const accounts = loadAccountsLocal()
        const keyForDid = (did) => {
            if (did === config.did) return config.publicKey
            const acct = Object.values(accounts).find(a => a.did === did)
            return acct ? acct.publicKey : null
        }
        for (const event of events) {
            if (event.commitCid) {
                const pubKey = keyForDid(event.did)
                const sigOk = pubKey ? await verifyCommitSig(event.commit, pubKey) : false
                if (!sigOk) {
                    sigErrors++
                    console.error(`  ✗ Commit signature invalid at offset ${event.offset}`)
                }
                if (event.recordCid && event.record) {
                    const expected = await recordCid(event.record)
                    if (event.recordCid !== expected) {
                        sigErrors++
                        console.error(`  ✗ Record CID mismatch at offset ${event.offset}`)
                    }
                }
            }
        }

        if (sigErrors > 0) {
            throw new Error(`${sigErrors} signature/CID verification failure(s)`)
        }

        console.log('✓ Journal is valid')
        console.log(`  Events: ${chainResult.eventCount}`)
        console.log(`  Commits verified: ${events.filter(e => e.commitCid).length}`)
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
        init()
        break
    case 'rotate-key':
        rotateKey()
        break
    case 'account':
        if (process.argv[3] === 'add') accountAdd(process.argv[4])
        else console.error('Usage: node cli/seal.js account add <handle>')
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
  node cli/seal.js init [did] [handle]   Initialize with keypair
  node cli/seal.js rotate-key            Generate a new keypair
  node cli/seal.js account add <handle>  注册发布账号（输出 did.json + TXT 粘贴内容）
  node cli/seal.js post "text" [--image path.jpg] [--alt "描述"] [--account <id>]  发帖（最多 4 图；--account 用发布账号）
  node cli/seal.js like <at-uri> <cid>   Like a post (requires subject CID)
  node cli/seal.js repost <at-uri> <cid> Repost (requires subject CID)
  node cli/seal.js follow did:...        Follow someone
  node cli/seal.js validate              Validate journal integrity
  node cli/seal.js list                  List all records
`)
}
