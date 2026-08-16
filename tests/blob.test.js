import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { computeBlobCid, computeCID, isValidCidString } from '../src/shared.js'
import { collectBlobRefs } from '../src/firehose.js'
import { handleXrpc } from '../src/xrpc.js'
import { buildImageEmbed } from '../cli/atproto.js'
import { Journal } from '../src/journal.js'

const DID = 'did:web:test.local'

// Minimal valid 1x1 PNG (8x8 bytes signature + IHDR + IDAT + IEND)
const TINY_PNG = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082',
    'hex'
)

test('blob - computeBlobCid uses raw codec and is deterministic', async () => {
    const cid = await computeBlobCid(TINY_PNG)
    // raw codec (0x55) → 'bafkrei...' prefix (NOT dag-cbor 'bafyrei...')
    assert.ok(cid.startsWith('bafkrei'), `expected raw-codec prefix, got ${cid}`)
    assert.strictEqual(cid, await computeBlobCid(TINY_PNG))
    // differs from the dag-cbor CID of the same bytes
    assert.notStrictEqual(cid, await computeCID(TINY_PNG))
    // a record CID must stay dag-cbor
    assert.ok((await computeCID({ text: 'x' })).startsWith('bafyrei'))
})

test('blob - isValidCidString accepts well-formed CIDs and rejects junk', async () => {
    // a real 36-byte CID is valid
    const cid = await computeBlobCid(new TextEncoder().encode('hello'))
    assert.strictEqual(isValidCidString(cid), true)
    // short / non-base32 / empty are rejected
    assert.strictEqual(isValidCidString('bafkrei'), false)
    assert.strictEqual(isValidCidString('BAFKREI' + 'a'.repeat(52)), false)
    assert.strictEqual(isValidCidString(''), false)
    assert.strictEqual(isValidCidString(null), false)
})

test('blob - known vector: computeBlobCid("hello") matches reference', async () => {
    const cid = await computeBlobCid(new TextEncoder().encode('hello'))
    assert.strictEqual(cid, 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq')
})

test('blob - collectBlobRefs walks records for blob refs', () => {
    const record = {
        $type: 'app.bsky.feed.post',
        text: 'hi',
        embed: {
            $type: 'app.bsky.embed.images',
            images: [
                { image: { $type: 'blob', ref: { $link: 'bafkreicid1' }, mimeType: 'image/png', size: 1 }, alt: 'a' },
                { image: { $type: 'blob', ref: { $link: 'bafkreicid2' } }, alt: 'b' },
            ],
        },
    }
    const refs = collectBlobRefs(record)
    assert.deepStrictEqual(refs, [{ $link: 'bafkreicid1' }, { $link: 'bafkreicid2' }])
    assert.deepStrictEqual(collectBlobRefs({ text: 'no blobs' }), [])
})

const PNG_CID = 'bafkreihyxfmz7naywvr6fcbp4plevctdesxigxik3bpjk6b7sxtycukkmy' // computeBlobCid(TINY_PNG)

test('blob - getBlob serves from ASSETS with correct mime and caches', async () => {
    const files = {
        [`/uploads/${PNG_CID}.png`]: TINY_PNG,
    }
    const fakeAssets = {
        fetch: async (url) => {
            const key = new URL(url).pathname
            if (files[key]) {
                return new Response(files[key], { status: 200 })
            }
            return new Response('not found', { status: 404 })
        },
    }
    const journal = new Journal({ JOURNAL_CONTENT: '', OWNER_DID: DID })
    await journal.load()

    const res = await handleXrpc(
        new Request(`http://localhost/xrpc/com.atproto.sync.getBlob?did=${DID}&cid=${PNG_CID}`),
        { journal, did: DID, handle: 'test.local', env: { ASSETS: fakeAssets } }
    )
    assert.strictEqual(res.status, 200)
    assert.strictEqual(res.headers.get('Content-Type'), 'image/png')
    assert.strictEqual(res.headers.get('Cache-Control'), 'public, max-age=86400')
    const body = new Uint8Array(await res.arrayBuffer())
    assert.strictEqual(Buffer.compare(Buffer.from(body), TINY_PNG), 0)

    // missing blob → BlobNotFound
    const missing = await handleXrpc(
        new Request(`http://localhost/xrpc/com.atproto.sync.getBlob?did=${DID}&cid=${PNG_CID}`),
        { journal, did: DID, handle: 'test.local', env: { ASSETS: { fetch: async () => new Response('nf', { status: 404 }) } } }
    )
    assert.strictEqual(missing.status, 404)

    // foreign did → BlobNotFound
    const foreign = await handleXrpc(
        new Request(`http://localhost/xrpc/com.atproto.sync.getBlob?did=did:web:other&cid=${PNG_CID}`),
        { journal, did: DID, handle: 'test.local', env: { ASSETS: fakeAssets } }
    )
    assert.strictEqual(foreign.status, 404)
})

test('blob - buildImageEmbed builds the record and blob refs from a real PNG', async () => {
    const tmp = path.join(process.cwd(), 'test-blob-tmp.png')
    fs.writeFileSync(tmp, TINY_PNG)
    try {
        const { embed, uploads } = await buildImageEmbed([{ path: tmp, alt: 'a tiny square' }])
        assert.strictEqual(embed.$type, 'app.bsky.embed.images')
        assert.strictEqual(embed.images.length, 1)
        const img = embed.images[0]
        assert.strictEqual(img.image.$type, 'blob')
        assert.strictEqual(img.image.mimeType, 'image/png')
        assert.strictEqual(img.image.size, TINY_PNG.length)
        assert.strictEqual(img.image.ref.$link, uploads[0].cid)
        assert.deepStrictEqual(img.aspectRatio, { width: 1, height: 1 })
        assert.strictEqual(uploads[0].ext, 'png')
        assert.deepStrictEqual(uploads[0].bytes, TINY_PNG)
    } finally {
        fs.unlinkSync(tmp)
    }
})
