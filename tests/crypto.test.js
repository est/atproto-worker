import test from 'node:test'
import assert from 'node:assert'
import {
    generateKeypair,
    generateKeypairP256,
    sign,
    verify,
    publicKeyToMultibase,
    normalizeKey,
    computeCID,
    cborEncode
} from '../cli/crypto.js'

test('crypto - keypair generation', async () => {
    const { privateKey, publicKey } = await generateKeypair()
    assert.strictEqual(typeof privateKey, 'string')
    assert.strictEqual(privateKey.length, 64)
    assert.strictEqual(typeof publicKey, 'string')
    assert.strictEqual(publicKey.length, 66) // compressed pubkey hex is 33 bytes = 66 chars
})

test('crypto - signing and verification', async () => {
    const { privateKey, publicKey } = await generateKeypair()
    const message = 'hello atproto'
    const signature = await sign(message, privateKey)

    const isValid = await verify(message, signature, publicKey)
    assert.strictEqual(isValid, true)

    const isInvalid = await verify('wrong message', signature, publicKey)
    assert.strictEqual(isInvalid, false)
})

test('crypto - cbor encoding and cid', async () => {
    const data = { foo: 'bar', baz: 123 }
    const cid = await computeCID(data)
    assert.ok(cid.startsWith('bafyre')) // dag-cbor cid prefix base32

    // Determinism
    const cid2 = await computeCID(data)
    assert.strictEqual(cid, cid2)

    // Chaining test
    const data2 = { ...data, prev: cid }
    const cid3 = await computeCID(data2)
    assert.notStrictEqual(cid, cid3)
})

test('crypto - cbor canonical encoding', async () => {
    const data1 = { a: 1, b: 2 }
    const data2 = { b: 2, a: 1 }

    const cbor1 = cborEncode(data1)
    const cbor2 = cborEncode(data2)

    // Objects should be sorted by key (canonical CBOR)
    assert.deepStrictEqual(cbor1, cbor2)
})

test('crypto - multikey prefixes and curve defaults', async () => {
    const k256 = await generateKeypair()
    // Backwards-compatible single-argument call stays k256.
    assert.ok(publicKeyToMultibase(k256.publicKey).startsWith('zQ3'))
    assert.strictEqual(
        publicKeyToMultibase(k256.publicKey),
        publicKeyToMultibase(k256.publicKey, 'k256')
    )
    assert.strictEqual(normalizeKey(k256).curve, 'k256')

    const p256 = await generateKeypairP256()
    assert.strictEqual(p256.curve, 'p256')
    assert.ok(p256.publicKeyMultibase.startsWith('zDna'))
    assert.strictEqual(publicKeyToMultibase(p256.publicKey, 'p256'), p256.publicKeyMultibase)
    assert.strictEqual(normalizeKey(p256).curve, 'p256')
})
