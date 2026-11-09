/**
 * Phase 0 P-256 tests: official interop fixtures, CLI wrappers, commit
 * sign/verify, Multikey/did:key encoding, nextTID, and DID documents.
 */

import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import { base64ToBytes, bytesToHex, nextTID } from '../src/shared.js'
import { parseMultikey, multikeyToDidKey } from '../src/keys.js'
import {
  generateKeypair,
  generateKeypairP256,
  signP256,
  verifyP256,
  publicKeyToMultibase,
  publicKeyToMultibaseP256,
  normalizeKey
} from '../cli/crypto.js'
import {
  buildUnsignedCommit,
  signCommit,
  verifyCommitSig,
  verifyCommitSigWithMultikey
} from '../cli/atproto.js'
import { generateDidWebDocument } from '../src/did.js'
import { JournalWriter } from '../cli/journal.js'

const FIXTURE_DIR = 'thirdparty/atproto/interop-test-files/crypto'
const SIGNATURE_FIXTURES = `${FIXTURE_DIR}/signature-fixtures.json`
const W3C_P256 = `${FIXTURE_DIR}/w3c_didkey_P256.json`

test('p256 - official signature fixtures (valid / high-S / DER)', async () => {
  const fixtures = JSON.parse(fs.readFileSync(SIGNATURE_FIXTURES, 'utf8'))
  const p256 = fixtures.filter(f => f.algorithm === 'ES256')
  assert.strictEqual(p256.length, 3, 'expected 3 P-256 fixtures')

  for (const fixture of p256) {
    const message = base64ToBytes(fixture.messageBase64)
    const sigHex = bytesToHex(base64ToBytes(fixture.signatureBase64))
    // publicKeyDid is did:key:zDna... and verifyP256 accepts did:key.
    const ok = await verifyP256(message, sigHex, fixture.publicKeyDid)
    assert.strictEqual(ok, fixture.validSignature, fixture.comment)
  }
})

test('p256 - W3C did:key fixture round-trips', async () => {
  const fixtures = JSON.parse(fs.readFileSync(W3C_P256, 'utf8'))
  assert.ok(fixtures.length >= 1)

  for (const fixture of fixtures) {
    const mb = fixture.publicDidKey.slice('did:key:'.length)
    const parsed = parseMultikey(mb)
    assert.strictEqual(parsed.curve, 'p256')
    assert.strictEqual(parsed.compressed.length, 33)
    assert.strictEqual(multikeyToDidKey(mb), fixture.publicDidKey)
  }
})

test('p256 - generate / sign / verify round-trip', async () => {
  const kp = await generateKeypairP256()
  assert.strictEqual(kp.curve, 'p256')
  assert.strictEqual(kp.privateKey.length > 0, true)
  assert.strictEqual(kp.publicKey.length, 66) // compressed 33 bytes
  assert.ok(kp.publicKeyMultibase.startsWith('zDna'))

  const message = 'hello atproto'
  const sig = await signP256(message, kp.privateKey)
  assert.strictEqual(sig.length, 128) // 64 bytes, low-S

  assert.strictEqual(await verifyP256(message, sig, kp.publicKey), true)
  assert.strictEqual(await verifyP256(message, sig, kp.publicKeyMultibase), true)
  assert.strictEqual(await verifyP256('wrong message', sig, kp.publicKey), false)

  // src/keys argument order also works: (privateKey, message) / (publicKey, message, sig)
  const sig2 = await signP256(kp.privateKey, message)
  assert.strictEqual(await verifyP256(kp.publicKeyMultibase, message, sig2), true)

  // Multikey helpers agree with the generated key.
  assert.strictEqual(publicKeyToMultibaseP256(kp.publicKey), kp.publicKeyMultibase)
  assert.strictEqual(publicKeyToMultibase(kp.publicKey, 'p256'), kp.publicKeyMultibase)
  assert.strictEqual(parseMultikey(kp.publicKeyMultibase).curve, 'p256')
})

test('p256 - config normalization defaults legacy configs to k256', async () => {
  const p256 = await generateKeypairP256()
  const normalizedP256 = normalizeKey({
    curve: 'p256',
    privateKey: p256.privateKey,
    publicKeyMultibase: p256.publicKeyMultibase
  })
  assert.strictEqual(normalizedP256.curve, 'p256')
  assert.strictEqual(normalizedP256.publicKey, p256.publicKey)

  const legacyPublicKey = '02' + '11'.repeat(32)
  const legacy = normalizeKey({ privateKey: 'aa'.repeat(32), publicKey: legacyPublicKey })
  assert.strictEqual(legacy.curve, 'k256')
  assert.strictEqual(legacy.publicKey, legacyPublicKey)
  assert.ok(legacy.publicKeyMultibase.startsWith('zQ3'))
})

test('p256 - commit sign/verify and multikey dispatch', async () => {
  const unsigned = buildUnsignedCommit(
    'did:web:example.com',
    'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '3msss7ozp7k22',
    null
  )

  const p256 = await generateKeypairP256()
  const pCommit = await signCommit(unsigned, p256)
  assert.strictEqual(pCommit.sig.length, 128)
  assert.strictEqual(await verifyCommitSig(pCommit, p256), true)
  assert.strictEqual(await verifyCommitSig(pCommit, {
    curve: 'p256',
    publicKeyMultibase: p256.publicKeyMultibase
  }), true)
  assert.strictEqual(await verifyCommitSigWithMultikey(pCommit, p256.publicKeyMultibase), true)

  const tampered = { ...pCommit, rev: '3msss7ozp7k23' }
  assert.strictEqual(await verifyCommitSig(tampered, p256), false)

  // Legacy k256 hex string and k256 Multikey dispatch still work.
  const k256 = await generateKeypair()
  const kCommit = await signCommit(unsigned, k256.privateKey)
  assert.strictEqual(await verifyCommitSig(kCommit, k256.publicKey), true)
  assert.strictEqual(await verifyCommitSigWithMultikey(kCommit, publicKeyToMultibase(k256.publicKey)), true)
})

test('p256 - nextTID is monotonic and 13 chars', () => {
  const prev = '3msss7ozp7k22'
  const next = nextTID(prev)
  assert.strictEqual(next.length, 13)
  assert.ok(next > prev)

  const fromNull = nextTID(null)
  assert.strictEqual(fromNull.length, 13)
  assert.ok(fromNull > prev) // today is well past this fixture timestamp
})

test('p256 - journal v2 rows carry signingKey', async () => {
  const journalPath = './test-p256-journal.ndjson'
  if (fs.existsSync(journalPath)) fs.unlinkSync(journalPath)

  const did = 'did:web:journal.local'
  const kp = await generateKeypairP256()
  const writer = new JournalWriter(journalPath, did)
  const event = await writer.append({
    op: 'create',
    collection: 'app.bsky.feed.post',
    rkey: 'r1',
    record: { text: 'v2' },
    did,
    rev: nextTID(null),
    signingKey: kp.publicKeyMultibase
  })

  assert.strictEqual(event.v, 2)
  assert.strictEqual(event.signingKey, kp.publicKeyMultibase)

  const reread = writer.readAll()
  assert.strictEqual(reread.length, 1)
  assert.strictEqual(reread[0].v, 2)

  fs.unlinkSync(journalPath)
})

test('p256 - DID document uses zDna and omits secp256k1 context', async () => {
  const p256 = await generateKeypairP256()
  const did = 'did:web:example.com'
  const doc = generateDidWebDocument(
    'example.com',
    'alice.example.com',
    p256.publicKeyMultibase,
    did,
    'https://pds.example.com'
  )

  assert.strictEqual(doc.id, did)
  assert.strictEqual(doc.verificationMethod[0].publicKeyMultibase, p256.publicKeyMultibase)
  assert.ok(doc.verificationMethod[0].publicKeyMultibase.startsWith('zDna'))
  assert.ok(doc['@context'].includes('https://w3id.org/security/multikey/multikey-v1.jsonld'))
  assert.ok(!doc['@context'].some(c => c.includes('secp256k1')))
  assert.strictEqual(doc.service[0].serviceEndpoint, 'https://pds.example.com')

  // No hardcoded k256 fallback key.
  assert.ok(!JSON.stringify(doc).includes('zQ3shXjHeiBuRCKmM36cuYnm7YEMzhGnCmCyW92sRJ9pribSF'))

  // k256 docs keep the secp256k1 context.
  const k256 = await generateKeypair()
  const kdoc = generateDidWebDocument('example.com', 'alice.example.com', publicKeyToMultibase(k256.publicKey), did)
  assert.ok(kdoc['@context'].some(c => c.includes('secp256k1')))

  // Missing key must fail loudly rather than serving a wrong fallback.
  assert.throws(
    () => generateDidWebDocument('example.com', 'alice.example.com', null, did),
    /publicKeyMultibase is required/
  )
})
