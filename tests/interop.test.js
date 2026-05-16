import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { computeCID, cborEncode } from '../cli/crypto.js'

const INTEROP_DIR = '/Users/me/edev/atproto-interop-tests'

test('interop - data-model (CID/CBOR)', async () => {
    const fixturesPath = path.join(INTEROP_DIR, 'data-model/data-model-fixtures.json')
    const fixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'))

    for (const fixture of fixtures) {
        // Current implementation might not support $bytes or complex unicode in a way that matches perfectly
        // but let's see. 
        // Note: our minimal CBOR encoder needs to handle $link and $bytes

        // We need a helper to transform interop JSON to our internal format 
        // where $link is { $link: "..." } and $bytes is Uint8Array
        const transform = (val) => {
            if (val && typeof val === 'object') {
                if (val.$bytes !== undefined) {
                    // base64 to Uint8Array
                    const bin = atob(val.$bytes)
                    const arr = new Uint8Array(bin.length)
                    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
                    return arr
                }
                if (Array.isArray(val)) return val.map(transform)
                const out = {}
                for (const k in val) out[k] = transform(val[k])
                return out
            }
            return val
        }

        const input = transform(fixture.json)
        const cid = await computeCID(input)

        if (cid !== fixture.cid) {
            console.log('\n--- CID MISMATCH ---')
            console.log('JSON:', JSON.stringify(fixture.json))
            console.log('Expected CID:', fixture.cid)
            console.log('Actual CID:  ', cid)
            const cbor = cborEncode(input)
            console.log('Actual CBOR (hex):', Array.from(cbor).map(b => b.toString(16).padStart(2, '0')).join(''))
            console.log('--------------------\n')
        }

        assert.strictEqual(cid, fixture.cid, `CID mismatch for fixture`)
    }
})

test('interop - syntax (Handles/DIDs)', async () => {
    const check = (file, validator, expected) => {
        const filePath = path.join(INTEROP_DIR, 'syntax', file)
        if (!fs.existsSync(filePath)) return
        const content = fs.readFileSync(filePath, 'utf8')
        const lines = content.split('\n').filter(l => l && !l.startsWith('#'))
        for (let line of lines) {
            // Remove trailing \r if present (Windows)
            if (line.endsWith('\r')) line = line.slice(0, -1)
            const res = validator(line)
            assert.strictEqual(res, expected, `Validator ${validator.name} failed for "${line}" (expected ${expected})`)
        }
    }

    // Import our validators
    const { validateDid } = await import('../src/did.js')
    // We need a handle validator. We have one in utils.js
    const { isValidHandle } = await import('../src/utils.js')

    check('handle_syntax_valid.txt', isValidHandle, true)
    check('handle_syntax_invalid.txt', isValidHandle, false)
    check('did_syntax_valid.txt', validateDid, true)
    check('did_syntax_invalid.txt', validateDid, false)

    // AT-URI tests
    const { parseAtUri } = await import('../src/utils.js')
    const validateAtUri = (uri) => parseAtUri(uri) !== null
    check('aturi_syntax_valid.txt', validateAtUri, true)
    check('aturi_syntax_invalid.txt', validateAtUri, false)
})
