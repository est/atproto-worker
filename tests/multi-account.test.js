import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import { JournalWriter } from '../cli/journal.js'
import { Journal } from '../src/journal.js'
import { handleXrpc } from '../src/xrpc.js'
import { commitCid } from '../cli/atproto.js'

const MAIN_DID = 'did:web:test.local'
const ACCT_DID = 'did:web:pub1.example.com'
const JOURNAL = './test-multi-account.ndjson'

async function buildMultiAccountJournal() {
    if (fs.existsSync(JOURNAL)) fs.unlinkSync(JOURNAL)

    const writerA = new JournalWriter(JOURNAL, MAIN_DID)
    const writerB = new JournalWriter(JOURNAL, ACCT_DID)

    const mkCommit = (did, rev, prev) => ({ did, version: 3, data: 'bafyreimst', rev, prev })

    // interleave two accounts: A1, B1, A2, B2
    const cA1 = mkCommit(MAIN_DID, '3aa1', null)
    const cidA1 = await commitCid(cA1)
    await writerA.append({ op: 'create', collection: 'app.bsky.feed.post', rkey: 'rA1', record: { text: 'A1' }, did: MAIN_DID, rev: '3aa1', recordCid: 'r1', commit: cA1, commitCid: cidA1, prevMstRoot: null, blocksB64: 'eA==' })

    const cB1 = mkCommit(ACCT_DID, '3bb1', null)
    const cidB1 = await commitCid(cB1)
    await writerB.append({ op: 'create', collection: 'app.bsky.feed.post', rkey: 'rB1', record: { text: 'B1' }, did: ACCT_DID, rev: '3bb1', recordCid: 'r2', commit: cB1, commitCid: cidB1, prevMstRoot: null, blocksB64: 'eA==' })

    const cA2 = mkCommit(MAIN_DID, '3aa2', cidA1)
    const cidA2 = await commitCid(cA2)
    await writerA.append({ op: 'create', collection: 'app.bsky.feed.post', rkey: 'rA2', record: { text: 'A2' }, did: MAIN_DID, rev: '3aa2', recordCid: 'r3', commit: cA2, commitCid: cidA2, prevMstRoot: null, blocksB64: 'eA==' })

    const cB2 = mkCommit(ACCT_DID, '3bb2', cidB1)
    const cidB2 = await commitCid(cB2)
    await writerB.append({ op: 'create', collection: 'app.bsky.feed.post', rkey: 'rB2', record: { text: 'B2' }, did: ACCT_DID, rev: '3bb2', recordCid: 'r4', commit: cB2, commitCid: cidB2, prevMstRoot: null, blocksB64: 'eA==' })

    const content = fs.readFileSync(JOURNAL, 'utf-8')
    if (fs.existsSync(JOURNAL)) fs.unlinkSync(JOURNAL)
    return { content, cidA1, cidA2, cidB1, cidB2 }
}

function fakeAssets(accounts = []) {
    const files = {}
    return {
        files,
        fetch: async (url) => {
            const key = new URL(url).pathname
            if (files[key]) return new Response(files[key], { status: 200 })
            return new Response('not found', { status: 404 })
        }
    }
}

test('multi-account - unified journal validates per-did chains', async () => {
    const { content } = await buildMultiAccountJournal()
    const journal = new Journal({ JOURNAL_CONTENT: content })
    await journal.load()
    assert.strictEqual(journal.events.length, 4)
    // hosted dids derive from the journal itself (no registry)
    assert.deepStrictEqual([...journal.distinctDids()].sort(), [MAIN_DID, ACCT_DID].sort())
})

test('multi-account - broken chain in one account is rejected', async () => {
    const { content } = await buildMultiAccountJournal()
    // tamper B2's event-level prev (the chain link; commit stays valid)
    const lines = content.trim().split('\n').map(JSON.parse)
    lines[3].prev = 'bafyreiwrong'
    const tampered = lines.map(JSON.stringify).join('\n')
    const journal = new Journal({ JOURNAL_CONTENT: tampered })
    await assert.rejects(() => journal.load(), /Journal chain broken/)
})

test('multi-account - xrpc routes records and repo status by did', async () => {
    const { content } = await buildMultiAccountJournal()
    const journal = new Journal({ JOURNAL_CONTENT: content })
    await journal.load()
    const env = {}
    const hosted = journal.distinctDids()

    // record of the publishing account
    const rec = await handleXrpc(
        new Request(`http://localhost/xrpc/com.atproto.repo.getRecord?repo=${ACCT_DID}&collection=app.bsky.feed.post&rkey=rB2`),
        { journal, did: MAIN_DID, handle: 'test.local', env, hosted }
    )
    assert.strictEqual(rec.status, 200)
    const recData = await rec.json()
    assert.strictEqual(recData.uri, `at://${ACCT_DID}/app.bsky.feed.post/rB2`)
    assert.strictEqual(recData.value.text, 'B2')

    // repo status for the publishing account
    const status = await handleXrpc(
        new Request(`http://localhost/xrpc/com.atproto.sync.getRepoStatus?did=${ACCT_DID}`),
        { journal, did: MAIN_DID, handle: 'test.local', env, hosted }
    )
    const statusData = await status.json()
    assert.strictEqual(statusData.active, true)
    assert.strictEqual(statusData.did, ACCT_DID)

    // unhosted did rejected
    const foreign = await handleXrpc(
        new Request(`http://localhost/xrpc/com.atproto.sync.getRepoStatus?did=did:web:stranger.com`),
        { journal, did: MAIN_DID, handle: 'test.local', env, hosted }
    )
    assert.strictEqual(foreign.status, 400)
})

test('multi-account - getBlob routes by handle-derived namespace', async () => {
    const CID = 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq'
    const { content } = await buildMultiAccountJournal()
    const assets = fakeAssets()
    assets.files['/uploads/pub1.example.com/' + CID + '.png'] = Buffer.from([1, 2, 3])
    const journal = new Journal({ JOURNAL_CONTENT: content, ASSETS: assets })
    await journal.load()
    const env = { ASSETS: assets }

    const res = await handleXrpc(
        new Request(`http://localhost/xrpc/com.atproto.sync.getBlob?did=${ACCT_DID}&cid=${CID}`),
        { journal, did: MAIN_DID, handle: 'test.local', env, hosted: journal.distinctDids(), ownHost: 'test.local' }
    )
    assert.strictEqual(res.status, 200)
    assert.strictEqual(res.headers.get('Content-Type'), 'image/png')
})

test('identity - own-host did resolves from the static ASSETS did.json', async () => {
    const assets = fakeAssets()
    assets.files['/.well-known/did.json'] = JSON.stringify({
        id: MAIN_DID,
        verificationMethod: [{ id: `${MAIN_DID}#atproto`, publicKeyMultibase: 'zQ3shXjHeiBuRCKmM36cuYnm7YEMzhGnCmCyW92sRJ9pribSF' }]
    })
    const { resolveIdentity, handleFromDid, keyFromDidDoc } = await import('../src/identity.js')

    assert.strictEqual(handleFromDid(ACCT_DID), 'pub1.example.com')
    assert.strictEqual(handleFromDid('did:plc:abc'), null)

    const ident = await resolveIdentity({ ASSETS: assets }, MAIN_DID, 'test.local')
    assert.ok(ident)
    assert.strictEqual(ident.handle, 'test.local')
    assert.strictEqual(ident.publicKeyMultibase, 'zQ3shXjHeiBuRCKmM36cuYnm7YEMzhGnCmCyW92sRJ9pribSF')

    assert.strictEqual(keyFromDidDoc({ verificationMethod: [{ id: '#atproto', publicKeyMultibase: 'zKEY' }] }), 'zKEY')
})
