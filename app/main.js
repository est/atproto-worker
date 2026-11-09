/**
 * atproto owner console - Phase 3 static UI.
 *
 * Everything the owner needs to read and write their repo lives in this page:
 * - the P-256 private key is generated/imported in the browser, encrypted with
 *   PBKDF2-SHA256 + AES-GCM, and stored only as ciphertext in localStorage
 * - reads use com.atproto.sync.getRepo / getLatestCommit
 * - writes build the MST + commit + CAR locally, sign with WebCrypto, and POST
 *   one owner-signed event to com.atproto.worker.appendEvent
 *
 * The Worker is a channel. It never sees the private key.
 */

import { Repo } from '../src/repo-core.js'
import {
  compressP256Point,
  generateP256Keypair,
  importP256PrivateKey,
  multikeyEncode,
  signP256,
} from '../src/keys.js'
import { base64ToBytes, bytesToBase64, generateTID } from '../src/shared.js'

const STORAGE_KEY = 'atproto-worker-key-v1'
const PBKDF2_ITERATIONS = 210000
const AES_KEY_BITS = 256
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const COLLECTION = 'app.bsky.feed.post'
const MAX_LOG_LINES = 200

/** @type {{
 *   record: object|null,
 *   privateKey: CryptoKey|null,
 *   repo: Repo|null,
 *   records: Array<object>,
 *   did: string,
 *   handle: string,
 *   workerUrl: string,
 *   publicKeyMultibase: string,
 *   busy: boolean,
 *   loading: boolean,
 * }} */
const state = {
  record: null,
  privateKey: null,
  repo: null,
  records: [],
  did: '',
  handle: '',
  workerUrl: '',
  publicKeyMultibase: '',
  busy: false,
  loading: false,
}

const $ = (id) => document.getElementById(id)

// ============ Startup ============

function init() {
  wireEvents()
  applySetupDefaults()

  if (!globalThis.crypto?.subtle) {
    setStatus('error', 'WebCrypto unavailable - use HTTPS or localhost')
    showNotice($('setup-error'), 'WebCrypto is not available. Serve this page over HTTPS (or localhost) in a modern browser.', 'error')
  }

  const stored = loadStoredRecord()
  if (stored) {
    state.record = stored
    applyRecordMeta(stored)
    showUnlock()
  } else {
    showSetup()
  }
}

function wireEvents() {
  $('create-key-btn').addEventListener('click', onCreateKey)
  $('unlock-btn').addEventListener('click', onUnlock)
  $('export-backup-btn').addEventListener('click', onExportBackup)
  $('export-backup-btn-2').addEventListener('click', onExportBackup)
  $('forget-key-btn').addEventListener('click', onForgetKey)
  $('lock-btn').addEventListener('click', onLock)
  $('refresh-btn').addEventListener('click', () => loadRepo())
  $('post-btn').addEventListener('click', onPost)
  $('copy-didjson-btn').addEventListener('click', onCopyDidJson)
  $('check-did-btn').addEventListener('click', onCheckPublishedKey)
  $('clear-log-btn').addEventListener('click', () => {
    $('log').replaceChildren()
  })

  for (const radio of document.querySelectorAll('input[name="key-mode"]')) {
    radio.addEventListener('change', syncKeyMode)
  }

  const compose = $('compose-text')
  compose.addEventListener('input', () => {
    $('compose-count').textContent = String(compose.value.length)
  })

  $('unlock-passphrase').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      onUnlock()
    }
  })
}

function applySetupDefaults() {
  const isHttp = location.protocol === 'http:' || location.protocol === 'https:'
  const host = isHttp ? location.host : ''
  $('setup-did').value = host ? `did:web:${host}` : ''
  $('setup-handle').value = host
  $('setup-worker').value = isHttp ? location.origin : ''
  syncKeyMode()
}

function syncKeyMode() {
  const mode = getKeyMode()
  $('import-field').classList.toggle('hidden', mode !== 'import')
}

function getKeyMode() {
  const checked = document.querySelector('input[name="key-mode"]:checked')
  return checked ? checked.value : 'generate'
}

// ============ View switching ============

function showSetup() {
  $('setup-view').classList.remove('hidden')
  $('unlock-view').classList.add('hidden')
  $('app-view').classList.add('hidden')
  setStatus('idle', 'Not connected')
}

function showUnlock() {
  $('setup-view').classList.add('hidden')
  $('unlock-view').classList.remove('hidden')
  $('app-view').classList.add('hidden')
  $('unlock-did').textContent = state.did
  $('unlock-handle').textContent = state.handle
  $('unlock-worker').textContent = state.workerUrl
  $('unlock-key').textContent = state.publicKeyMultibase
  setStatus('idle', 'Key locked')
}

function showApp() {
  $('setup-view').classList.add('hidden')
  $('unlock-view').classList.add('hidden')
  $('app-view').classList.remove('hidden')

  $('meta-did').textContent = state.did
  $('meta-handle').textContent = state.handle
  $('meta-worker').textContent = state.workerUrl
  $('meta-key').textContent = state.publicKeyMultibase
  renderDidJson()
  updateControls()
}

function applyRecordMeta(record) {
  state.did = record.did || ''
  state.handle = record.handle || ''
  try {
    state.workerUrl = normalizeUrl(record.workerUrl || '')
  } catch {
    // Keep the raw value so the UI can show what is stored; requests will
    // surface a clear URL error instead of breaking initialization.
    state.workerUrl = record.workerUrl || ''
  }
  state.publicKeyMultibase = record.publicKeyMultibase || ''
}

// ============ Storage / encryption ============

function loadStoredRecord() {
  let raw
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
  if (!raw) return null

  try {
    const record = JSON.parse(raw)
    if (record?.v !== 1) return null
    for (const field of ['did', 'handle', 'workerUrl', 'publicKeyMultibase', 'salt', 'iv', 'ciphertext']) {
      if (typeof record[field] !== 'string' || !record[field]) return null
    }
    return record
  } catch {
    return null
  }
}

function saveStoredRecord(record) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record))
  } catch (e) {
    throw new Error(`Could not save the encrypted key in localStorage: ${e.message}`)
  }
}

async function deriveAesKey(passphrase, salt, iterations) {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: AES_KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function encryptRecord(jwk, meta, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const aesKey = await deriveAesKey(passphrase, salt, PBKDF2_ITERATIONS)
  const plaintext = encoder.encode(JSON.stringify(jwk))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plaintext)
  plaintext.fill(0)

  return {
    v: 1,
    iterations: PBKDF2_ITERATIONS,
    did: meta.did,
    handle: meta.handle,
    workerUrl: meta.workerUrl,
    publicKeyMultibase: meta.publicKeyMultibase,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  }
}

async function decryptRecord(record, passphrase) {
  const salt = base64ToBytes(record.salt)
  const iv = base64ToBytes(record.iv)
  const ciphertext = base64ToBytes(record.ciphertext)
  const iterations = Number.isInteger(record.iterations) ? record.iterations : PBKDF2_ITERATIONS
  const aesKey = await deriveAesKey(passphrase, salt, iterations)
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext)
  try {
    return JSON.parse(decoder.decode(plaintext))
  } finally {
    new Uint8Array(plaintext).fill(0)
  }
}

// ============ Key setup / unlock ============

async function onCreateKey() {
  const button = $('create-key-btn')
  showNotice($('setup-error'), '', 'error')
  button.disabled = true
  setStatus('busy', 'Preparing key…')

  try {
    const fields = readSetupFields()
    const mode = getKeyMode()

    let material
    if (mode === 'import') {
      material = await importKeyMaterial(fields.importText, fields.expected)
    } else {
      material = await generateKeyMaterial(fields.expected)
    }

    const record = await encryptRecord(
      material.jwk,
      {
        did: fields.did,
        handle: fields.handle,
        workerUrl: fields.workerUrl,
        publicKeyMultibase: material.publicKeyMultibase,
      },
      fields.passphrase,
    )

    saveStoredRecord(record)

    state.record = record
    state.privateKey = material.privateKey
    applyRecordMeta(record)

    // Drop private material from the DOM now that it is encrypted.
    $('setup-import').value = ''
    $('setup-passphrase').value = ''
    $('setup-passphrase2').value = ''

    showApp()
    log(`Encrypted key created for ${state.did}`, 'ok')
    log(`Public key: ${state.publicKeyMultibase}`, '')
    log('Publish the DID document shown on the right before writing to the Worker.', 'warn')
    setStatus('busy', 'Key ready - loading repo…')
    await loadRepo()
  } catch (e) {
    showNotice($('setup-error'), e.message || String(e), 'error')
    setStatus('error', 'Key setup failed')
  } finally {
    button.disabled = false
  }
}

function readSetupFields() {
  const did = $('setup-did').value.trim()
  const handle = $('setup-handle').value.trim()
  const workerInput = $('setup-worker').value.trim()
  const passphrase = $('setup-passphrase').value
  const passphrase2 = $('setup-passphrase2').value
  const importText = $('setup-import').value.trim()
  const expected = $('setup-expected').value.trim()

  if (!/^did:[a-z0-9]+:.+/i.test(did)) throw new Error('Enter a valid DID (for example did:web:example.com).')
  if (!handle) throw new Error('Enter the handle for this account.')
  if (!workerInput) throw new Error('Enter the Worker URL.')
  const workerUrl = normalizeUrl(workerInput)
  if (!passphrase || passphrase.length < 8) throw new Error('Use a passphrase of at least 8 characters.')
  if (passphrase !== passphrase2) throw new Error('The passphrase confirmation does not match.')
  if (getKeyMode() === 'import' && !importText) throw new Error('Paste the PKCS#8 base64 private key, or switch to Generate.')

  return { did, handle, workerUrl, passphrase, importText, expected }
}

async function generateKeyMaterial(expectedMultikey) {
  const keypair = await generateP256Keypair({ extractable: true })
  if (!keypair.privateKeyJwk) throw new Error('Could not export the generated private key for encryption.')
  if (expectedMultikey && expectedMultikey !== keypair.publicKeyMultibase) {
    throw new Error(
      `The generated key (${keypair.publicKeyMultibase}) does not match the current DID document key (${expectedMultikey}). ` +
      'Refusing to rotate accidentally. Clear that field or publish the new DID document first.',
    )
  }
  return {
    privateKey: keypair.privateKey,
    jwk: keypair.privateKeyJwk,
    publicKeyMultibase: keypair.publicKeyMultibase,
  }
}

async function importKeyMaterial(pkcs8Base64, expectedMultikey) {
  if (!pkcs8Base64) throw new Error('Paste the PKCS#8 base64 private key.')
  const trimmed = pkcs8Base64.trim()
  // PKCS#8 pasted from a terminal may be wrapped; JWK JSON must keep its
  // internal whitespace intact.
  const input = trimmed.startsWith('{') ? trimmed : trimmed.replace(/\s+/g, '')
  const privateKey = await importP256PrivateKey(input)
  const jwk = await crypto.subtle.exportKey('jwk', privateKey)
  const publicKeyMultibase = multikeyFromJwk(jwk)

  if (expectedMultikey && expectedMultikey !== publicKeyMultibase) {
    throw new Error(
      `The imported key (${publicKeyMultibase}) does not match the current DID document key (${expectedMultikey}).`,
    )
  }

  return { privateKey, jwk, publicKeyMultibase }
}

function multikeyFromJwk(jwk) {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) {
    throw new Error('The imported key is not a P-256 private JWK.')
  }
  const x = base64UrlToBytes(jwk.x)
  const y = base64UrlToBytes(jwk.y)
  if (x.length !== 32 || y.length !== 32) throw new Error('Unexpected P-256 coordinate length.')

  const uncompressed = new Uint8Array(65)
  uncompressed[0] = 4
  uncompressed.set(x, 1)
  uncompressed.set(y, 33)
  return multikeyEncode('p256', compressP256Point(uncompressed))
}

async function onUnlock() {
  const button = $('unlock-btn')
  const input = $('unlock-passphrase')
  const passphrase = input.value
  showNotice($('unlock-error'), '', 'error')

  if (!state.record) {
    showSetup()
    return
  }
  if (!passphrase) {
    showNotice($('unlock-error'), 'Enter the passphrase.', 'error')
    return
  }

  button.disabled = true
  setStatus('busy', 'Unlocking…')
  try {
    const jwk = await decryptRecord(state.record, passphrase)
    state.privateKey = await importP256PrivateKey(jwk)
    input.value = ''
    applyRecordMeta(state.record)
    showApp()
    log(`Unlocked key for ${state.did}`, 'ok')
    setStatus('busy', 'Unlocked - loading repo…')
    await loadRepo()
  } catch (e) {
    input.value = ''
    showNotice($('unlock-error'), 'Could not unlock. Check the passphrase (or the encrypted backup is corrupt).', 'error')
    setStatus('error', 'Locked')
    log(`Unlock failed: ${e.name || 'Error'}`, 'error')
  } finally {
    button.disabled = false
  }
}

function onLock() {
  state.privateKey = null
  state.repo = null
  state.records = []
  showNotice($('compose-status'), '', '')
  showUnlock()
  log('Locked. The CryptoKey was dropped from memory.', '')
}

function onForgetKey() {
  if (!state.record) return
  const ok = window.confirm(
    'Forget this key?\n\nThis removes the encrypted key record from this browser. ' +
    'Without an exported backup and the passphrase, the key cannot be recovered.',
  )
  if (!ok) return

  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch (e) {
    showNotice($('unlock-error'), `Could not remove the key record: ${e.message}`, 'error')
    return
  }

  state.record = null
  state.privateKey = null
  state.repo = null
  state.records = []
  state.did = ''
  state.handle = ''
  state.workerUrl = ''
  state.publicKeyMultibase = ''
  applySetupDefaults()
  showSetup()
  log('Encrypted key record removed from this browser.', 'warn')
}

function onExportBackup() {
  if (!state.record) return
  const safeDid = (state.record.did || 'key').replace(/[^a-z0-9._-]+/gi, '_')
  downloadJson(`atproto-worker-key-${safeDid}.json`, state.record)
  log('Downloaded encrypted key backup (still requires the passphrase).', 'ok')
}

function downloadJson(filename, value) {
  const blob = new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ============ DID document ============

function buildDidDocument() {
  let worker = state.workerUrl
  try {
    worker = normalizeUrl(state.workerUrl)
  } catch {
    /* show the stored value verbatim */
  }
  return {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/multikey/multikey-v1.jsonld',
    ],
    id: state.did,
    alsoKnownAs: [`at://${state.handle}`],
    verificationMethod: [
      {
        id: `${state.did}#atproto`,
        type: 'Multikey',
        controller: state.did,
        publicKeyMultibase: state.publicKeyMultibase,
      },
    ],
    service: [
      {
        id: '#atproto_pds',
        type: 'AtprotoPersonalDataServer',
        serviceEndpoint: worker,
      },
    ],
  }
}

function renderDidJson() {
  if (!state.did || !state.publicKeyMultibase) return
  $('didjson').textContent = JSON.stringify(buildDidDocument(), null, 2)
  $('didjson-status').textContent = ''
}

async function onCopyDidJson() {
  const text = $('didjson').textContent
  if (!text) return
  const ok = await copyText(text)
  $('didjson-status').textContent = ok ? 'Copied DID document JSON.' : 'Copy failed; select the JSON manually.'
}

async function onCheckPublishedKey() {
  const target = publishedDidUrl()
  if (!target) {
    $('didjson-status').textContent = 'Only did:web documents can be checked from the browser.'
    return
  }

  $('didjson-status').textContent = `Checking ${target} …`
  try {
    const response = await fetch(`${target}${target.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const doc = await response.json()
    const published = findAtprotoKey(doc)
    if (!published) throw new Error('no verificationMethod with publicKeyMultibase was found')
    if (published === state.publicKeyMultibase) {
      $('didjson-status').textContent = 'Published #atproto key matches this browser key.'
      log('Published DID document key matches.', 'ok')
    } else {
      $('didjson-status').textContent =
        `Mismatch: published ${shorten(published)} but this page holds ${shorten(state.publicKeyMultibase)}.`
      log('Published DID document key does not match.', 'warn')
    }
  } catch (e) {
    $('didjson-status').textContent = `Could not verify the published key: ${e.message}`
  }
}

function publishedDidUrl() {
  if (!state.did.startsWith('did:web:')) return null
  const rest = state.did.slice('did:web:'.length)
  const parts = rest.split(':')
  const didHost = decodeURIComponent(parts[0] || '')

  // In local dev the DID host and Worker host are the same but the scheme is
  // http; prefer the configured Worker origin so the check actually works.
  if (state.workerUrl) {
    try {
      const worker = new URL(state.workerUrl)
      if (worker.host === didHost) {
        return `${normalizeUrl(state.workerUrl)}/.well-known/did.json`
      }
    } catch {
      /* ignore */
    }
  }

  if (parts.length === 1) return `https://${didHost}/.well-known/did.json`
  const path = parts.slice(1).map((part) => decodeURIComponent(part)).join('/')
  return `https://${didHost}/${path}/did.json`
}

function findAtprotoKey(doc) {
  const methods = Array.isArray(doc?.verificationMethod) ? doc.verificationMethod : []
  const preferred = methods.find((method) => typeof method?.id === 'string' && method.id.endsWith('#atproto'))
  const method = preferred || methods.find((item) => typeof item?.publicKeyMultibase === 'string')
  return typeof method?.publicKeyMultibase === 'string' ? method.publicKeyMultibase : null
}

// ============ Repo read ============

async function loadRepo() {
  if (!state.did || !state.workerUrl) return
  if (state.loading) return

  state.loading = true
  state.repo = null
  updateControls()
  showNotice($('head-error'), '', 'error')
  setStatus('busy', 'Contacting Worker…')

  const base = normalizeUrl(state.workerUrl)
  const didParam = encodeURIComponent(state.did)
  const bust = `t=${Date.now()}`

  try {
    await pingWorker(base)

    const repoResponse = await fetch(
      `${base}/xrpc/com.atproto.sync.getRepo?did=${didParam}&${bust}`,
      { cache: 'no-store' },
    )

    // A brand-new hosted account may not have a repo yet.
    if (repoResponse.status === 404) {
      state.repo = await Repo.create({ did: state.did, signingKey: state.publicKeyMultibase })
      state.records = []
      renderRecords([])
      setHeadDisplay('—', '—', 'No repo yet - the first post will create it')
      setStatus('ok', 'Connected. No repo yet.')
      log('Worker reports no repo for this DID yet.', 'warn')
      return
    }

    if (!repoResponse.ok) {
      throw new Error(`getRepo failed: ${await describeHttpError(repoResponse)}`)
    }

    const carBytes = new Uint8Array(await repoResponse.arrayBuffer())
    const latest = await fetchLatestCommit(base, didParam, bust)

    let repo
    try {
      repo = await Repo.fromCar(carBytes, {
        did: state.did,
        signingKey: state.publicKeyMultibase,
      })
    } catch (e) {
      throw new Error(`Could not parse the CAR returned by getRepo: ${e.message}`)
    }

    const head = repo.getHead()

    if (latest?.cid && head.commitCid !== latest.cid) {
      // The CAR root and getLatestCommit disagree. Keep the records visible but
      // do NOT allow a write from this snapshot.
      const records = await repo.getRecords().catch(() => [])
      state.repo = null
      state.records = records
      renderRecords(records)
      setHeadDisplay(
        head.commitCid,
        head.rev,
        `MISMATCH - getLatestCommit reports ${latest.cid}`,
      )
      showNotice(
        $('head-error'),
        `Stale/conflict: getRepo is rooted at ${head.commitCid}, but getLatestCommit reports ${latest.cid} ` +
        `(rev ${latest.rev || '?'}). The snapshot is stale, so writing is disabled. Refresh the repo and retry.`,
        'error',
      )
      setStatus('error', 'Repo head mismatch - refresh before writing')
      log('Head mismatch detected between getRepo and getLatestCommit.', 'error')
      return
    }

    state.repo = repo
    state.records = await repo.getRecords()
    renderRecords(state.records)
    setHeadDisplay(
      head.commitCid,
      head.rev,
      latest?.cid ? 'matches getLatestCommit' : 'getRepo root only',
    )
    setStatus('ok', `Connected - head verified (${shorten(head.commitCid)})`)
    log(`Loaded repo head ${head.commitCid} (rev ${head.rev}) with ${state.records.length} record(s).`, 'ok')
  } catch (e) {
    state.repo = null
    state.records = []
    renderRecords([])
    setHeadDisplay('—', '—', 'unavailable')
    showNotice($('head-error'), e.message || String(e), 'error')
    setStatus('error', e.message || 'Repo load failed')
    log(`Repo load failed: ${e.message || e}`, 'error')
  } finally {
    state.loading = false
    updateControls()
  }
}

async function pingWorker(base) {
  const response = await fetch(`${base}/xrpc/_health?t=${Date.now()}`, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`Worker health check failed (${await describeHttpError(response)})`)
  }
}

async function fetchLatestCommit(base, didParam, bust) {
  const response = await fetch(
    `${base}/xrpc/com.atproto.sync.getLatestCommit?did=${didParam}&${bust}`,
    { cache: 'no-store' },
  )
  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`getLatestCommit failed: ${await describeHttpError(response)}`)
  }
  return response.json()
}

function setHeadDisplay(cid, rev, verification) {
  $('head-cid').textContent = cid || '—'
  $('head-rev').textContent = rev || '—'
  $('head-verified').textContent = verification || '—'
}

// ============ Records ============

function renderRecords(records) {
  const container = $('records')
  container.replaceChildren()
  $('records-count').textContent = String(records.length)

  if (!records.length) {
    const empty = document.createElement('p')
    empty.className = 'empty'
    empty.textContent = 'No records yet.'
    container.appendChild(empty)
    return
  }

  const sorted = [...records].sort((a, b) => {
    const ta = Date.parse(a.record?.createdAt || '') || 0
    const tb = Date.parse(b.record?.createdAt || '') || 0
    if (tb !== ta) return tb - ta
    return String(b.rkey).localeCompare(String(a.rkey))
  })

  for (const item of sorted) {
    const card = document.createElement('article')
    card.className = 'record'

    const head = document.createElement('div')
    head.className = 'record-head'

    const key = document.createElement('span')
    key.className = 'record-key'
    key.textContent = `${item.collection}/${item.rkey}`
    head.appendChild(key)

    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'danger record-delete'
    del.textContent = 'Delete'
    del.addEventListener('click', () => onDelete(item))
    head.appendChild(del)

    card.appendChild(head)

    const record = item.record || {}
    if (typeof record.text === 'string' && record.text) {
      const text = document.createElement('p')
      text.className = 'record-text'
      text.textContent = record.text
      card.appendChild(text)
    } else if (record.$type !== COLLECTION) {
      const raw = document.createElement('pre')
      raw.className = 'mono wrap'
      raw.textContent = JSON.stringify(record, null, 2)
      card.appendChild(raw)
    }

    const meta = document.createElement('div')
    meta.className = 'record-meta'
    if (record.createdAt) {
      const created = document.createElement('span')
      created.textContent = record.createdAt
      meta.appendChild(created)
    }
    const type = document.createElement('span')
    type.textContent = record.$type || item.collection
    meta.appendChild(type)
    const cid = document.createElement('span')
    cid.className = 'mono'
    cid.textContent = item.cid
    meta.appendChild(cid)
    card.appendChild(meta)

    const details = document.createElement('details')
    const summary = document.createElement('summary')
    summary.textContent = 'Raw record'
    details.appendChild(summary)
    const pre = document.createElement('pre')
    pre.className = 'mono'
    pre.textContent = JSON.stringify(record, null, 2)
    details.appendChild(pre)
    card.appendChild(details)

    container.appendChild(card)
  }

  updateControls()
}

// ============ Writes ============

async function onPost() {
  if (state.busy || !state.repo || !state.privateKey) return

  const textarea = $('compose-text')
  const text = textarea.value.trim()
  showNotice($('compose-status'), '', '')

  if (!text) {
    showNotice($('compose-status'), 'Write something first.', 'warn')
    return
  }

  const record = {
    $type: COLLECTION,
    text,
    createdAt: new Date().toISOString(),
  }
  const rkey = generateTID()

  await runWrite({ action: 'create', collection: COLLECTION, rkey, record }, () => {
    textarea.value = ''
    $('compose-count').textContent = '0'
  })
}

async function onDelete(item) {
  if (state.busy || !state.repo || !state.privateKey) return
  const ok = window.confirm(`Delete ${item.collection}/${item.rkey}?\n\nThis creates a signed delete commit.`)
  if (!ok) return

  await runWrite({ action: 'delete', collection: item.collection, rkey: item.rkey })
}

async function runWrite(write, onSuccess) {
  state.busy = true
  updateControls()
  setStatus('busy', `Signing ${write.action}…`)
  showNotice($('compose-status'), '', '')

  try {
    const result = await state.repo.applyWrite(write, (encoded) => signP256(state.privateKey, encoded))
    const car = state.repo.buildCar(result)

    const event = {
      did: state.did,
      op: write.action,
      collection: write.collection,
      rkey: write.rkey,
      rev: result.rev,
      recordCid: result.recordCid,
      commit: result.commit,
      commitCid: result.commitCid,
      mstRoot: result.mstRoot,
      blocksB64: bytesToBase64(car),
      signingKey: state.publicKeyMultibase,
    }
    if (write.action !== 'delete') event.record = write.record

    log(
      `Signed ${write.action} ${write.collection}/${write.rkey} ` +
      `(commit ${shorten(result.commitCid)}, rev ${result.rev}).`,
      '',
    )

    let response
    try {
      response = await appendEvent(event)
    } catch (e) {
      await handleWriteFailure(e)
      return
    }

    log(`Append accepted: ${JSON.stringify(response)}`, 'ok')
    if (typeof onSuccess === 'function') onSuccess()
    showNotice(
      $('compose-status'),
      `Accepted: ${response.uri} (cid ${shorten(response.cid)}, seq ${response.seq}, ` +
      `commit ${shorten(response.commit?.cid)}, rev ${response.commit?.rev}).`,
      'ok',
    )
    setStatus('ok', `Write accepted (seq ${response.seq})`)

    // Simplest correct behavior: reload the repo from the Worker and re-render.
    await loadRepo()
  } catch (e) {
    // A local build/sign failure also leaves the in-memory repo ahead of the
    // Worker. Drop it and reload rather than ever re-signing a stale head.
    state.repo = null
    showNotice($('compose-status'), `Write failed before it was sent: ${e.message || e}`, 'error')
    log(`Write failed: ${e.message || e}`, 'error')
    await loadRepo()
  } finally {
    state.busy = false
    updateControls()
  }
}

async function appendEvent(event) {
  const response = await fetch(`${normalizeUrl(state.workerUrl)}/xrpc/com.atproto.worker.appendEvent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event }),
    cache: 'no-store',
  })

  let data = null
  try {
    data = await response.json()
  } catch {
    /* non-JSON error body */
  }

  if (!response.ok) {
    const error = new Error(
      (data && (data.message || data.error)) || `HTTP ${response.status}`,
    )
    error.status = response.status
    error.code = data?.error
    error.details = data
    throw error
  }
  return data
}

async function handleWriteFailure(error) {
  state.repo = null

  if (error.status === 409) {
    const head = error.details?.head
    showNotice(
      $('compose-status'),
      '409 RepoConflict: the Worker head changed. The local commit was discarded and was NOT re-signed. ' +
      'The page will reload the new head - review the text and retry.' +
      (head?.commitCid ? `\nNew head: ${head.commitCid} (rev ${head.rev}).` : ''),
      'warn',
    )
    log(`409 RepoConflict: ${error.message}. Discarding local commit.`, 'warn')
    setStatus('busy', 'Conflict - refreshing head…')
  } else if (error.status) {
    showNotice(
      $('compose-status'),
      `Write rejected (HTTP ${error.status}${error.code ? ', ' + error.code : ''}): ${error.message}`,
      'error',
    )
    log(`Write rejected (${error.status} ${error.code || ''}): ${error.message}`, 'error')
    setStatus('error', `Write rejected: ${error.code || error.status}`)
  } else {
    showNotice($('compose-status'), `Network error while appending: ${error.message}`, 'error')
    log(`Append network error: ${error.message}`, 'error')
    setStatus('error', 'Network error')
  }

  await loadRepo()
}

// ============ UI helpers ============

function updateControls() {
  const disabled = state.busy || state.loading
  const canWrite = !disabled && !!state.repo && !!state.privateKey

  $('post-btn').disabled = !canWrite
  $('refresh-btn').disabled = disabled || !state.workerUrl
  $('lock-btn').disabled = state.busy
  for (const button of document.querySelectorAll('.record-delete')) {
    button.disabled = !canWrite
  }
}

function setStatus(kind, text) {
  const dot = $('status-dot')
  dot.className = `dot dot-${kind}`
  $('status-text').textContent = text
}

function showNotice(element, message, kind = 'error') {
  if (!element) return
  element.classList.remove('hidden', 'error', 'ok', 'warn')
  if (!message) {
    element.textContent = ''
    element.classList.add('hidden')
    return
  }
  element.textContent = message
  element.classList.add(kind)
}

function log(message, kind = '') {
  const container = $('log')
  const line = document.createElement('div')
  line.className = `log-line${kind ? ' ' + kind : ''}`

  const time = document.createElement('span')
  time.className = 'time'
  time.textContent = new Date().toISOString().slice(11, 19) + ' '
  line.appendChild(time)
  line.appendChild(document.createTextNode(message))
  container.appendChild(line)

  while (container.childElementCount > MAX_LOG_LINES) {
    container.firstElementChild.remove()
  }
  container.scrollTop = container.scrollHeight
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    /* fall back below */
  }

  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  area.remove()
  return ok
}

function describeHttpError(response) {
  return response
    .clone()
    .json()
    .then((body) => `${response.status} ${body.error || ''}${body.message ? ': ' + body.message : ''}`.trim())
    .catch(async () => {
      try {
        const text = await response.text()
        return `HTTP ${response.status}${text ? ': ' + text.slice(0, 200) : ''}`
      } catch {
        return `HTTP ${response.status}`
      }
    })
}

function normalizeUrl(value) {
  const trimmed = String(value || '').trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  const url = new URL(trimmed)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('URL must start with http:// or https://')
  }
  return url.origin + url.pathname.replace(/\/+$/, '')
}

function base64UrlToBytes(value) {
  const b64 = String(value).replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  return base64ToBytes(padded)
}

function shorten(value, size = 12) {
  const text = String(value || '')
  if (text.length <= size * 2 + 1) return text
  return `${text.slice(0, size)}…${text.slice(-size)}`
}

init()
