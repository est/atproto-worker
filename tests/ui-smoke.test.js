/**
 * Browser smoke test for the static owner console (Phase 3).
 *
 * This test does not touch the real Worker or config.json. It serves the
 * built public/app/ directory from a local HTTP server and verifies:
 * - key generation + encrypted localStorage record + did.json snippet
 * - reload -> unlock view -> correct passphrase unlocks again
 * - wrong passphrase shows an error
 * - import of a Node-generated PKCS#8 P-256 key produces the same multikey
 * - an expected-key mismatch is rejected
 *
 * Playwright is optional. If it (or Edge/Chromium) is unavailable the test is
 * skipped instead of failing the suite.
 *
 * Run:
 *   node tests/ui-smoke.test.js
 *   NODE_PATH="$(npm root -g)" node tests/ui-smoke.test.js
 */

import test from 'node:test'
import assert from 'node:assert'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

import { generateP256Keypair } from '../src/keys.js'
import { validateAppendEvent } from '../src/append.js'
import { base64ToBytes, createCarFile, readCarFile } from '../src/shared.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const STORAGE_KEY = 'atproto-worker-key-v1'

async function loadPlaywright() {
  const normalize = (mod) => (mod?.chromium ? mod : (mod?.default ?? mod))

  try {
    return normalize(await import('playwright'))
  } catch {
    try {
      const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
      const entry = path.join(globalRoot, 'playwright', 'index.js')
      if (!fs.existsSync(entry)) return null
      return normalize(await import(pathToFileURL(entry).href))
    } catch {
      return null
    }
  }
}

function startServer() {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const requested = decodeURIComponent(url.pathname)
    const target = path.resolve(ROOT, '.' + requested)
    if (!target.startsWith(ROOT + path.sep)) {
      res.writeHead(403).end('forbidden')
      return
    }
    fs.readFile(target, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found')
        return
      }
      res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream' })
      res.end(data)
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, base: `http://127.0.0.1:${port}` })
    })
  })
}

async function launchBrowser(playwright) {
  for (const options of [
    { channel: 'msedge', headless: true },
    { headless: true },
  ]) {
    try {
      return await playwright.chromium.launch(options)
    } catch {
      /* try next */
    }
  }
  return null
}

async function waitForVisible(page, selector, timeout = 15000) {
  await page.waitForSelector(selector, { state: 'visible', timeout })
}

async function waitFor(predicate, timeout = 15000, interval = 50) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error('timed out waiting for condition')
}

function passphrase() {
  return 'phase3 smoke passphrase!'
}

/**
 * Minimal in-process Worker stand-in. It speaks the three XRPC endpoints the
 * page uses and validates append events with the real src/append.js code, so
 * the client-built MST/commit/CAR/signature is checked exactly like the Worker
 * does. No real network, DID, or config is involved.
 */
async function startMockWorker() {
  const mock = {
    key: null,
    head: null,
    rev: null,
    blocks: new Map(),
    events: [],
    seq: 0,
    forceConflict: false,
  }

  const sendJson = (res, status, value) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    res.end(JSON.stringify(value))
  }

  const readJson = (req) =>
    new Promise((resolve, reject) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 8 * 1024 * 1024) reject(new Error('body too large'))
      })
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {})
        } catch (e) {
          reject(e)
        }
      })
      req.on('error', reject)
    })

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      })
      res.end()
      return
    }

    try {
      if (req.method === 'POST' && url.pathname === '/_test/key') {
        const body = await readJson(req)
        mock.key = body.key
        sendJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'POST' && url.pathname === '/_test/force-conflict') {
        mock.forceConflict = true
        sendJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'GET' && url.pathname === '/xrpc/_health') {
        sendJson(res, 200, { version: 'mock' })
        return
      }

      if (req.method === 'GET' && url.pathname === '/xrpc/com.atproto.sync.getRepo') {
        if (!mock.head) {
          sendJson(res, 404, { error: 'RepoNotFound', message: 'No commits found' })
          return
        }
        const blocks = [...mock.blocks].map(([cid, data]) => ({ cid, data }))
        const car = createCarFile(mock.head, blocks)
        res.writeHead(200, {
          'Content-Type': 'application/vnd.ipld.car',
          'Access-Control-Allow-Origin': '*',
        })
        res.end(Buffer.from(car))
        return
      }

      if (req.method === 'GET' && url.pathname === '/xrpc/com.atproto.sync.getLatestCommit') {
        if (!mock.head) {
          sendJson(res, 404, { error: 'RepoNotFound', message: 'No commits found' })
          return
        }
        sendJson(res, 200, { cid: mock.head, rev: mock.rev })
        return
      }

      if (req.method === 'POST' && url.pathname === '/xrpc/com.atproto.worker.appendEvent') {
        const body = await readJson(req)
        const event = body?.event
        const head = mock.head ? { commitCid: mock.head, rev: mock.rev } : null

        if (mock.forceConflict) {
          mock.forceConflict = false
          sendJson(res, 409, {
            error: 'RepoConflict',
            message: 'simulated conflict for the UI smoke test',
            head,
          })
          return
        }

        try {
          await validateAppendEvent(event, { head, resolvedKey: mock.key })
        } catch (e) {
          sendJson(res, e.status || 400, {
            error: e.error || 'InvalidRequest',
            message: e.message,
            head,
          })
          return
        }

        const car = readCarFile(base64ToBytes(event.blocksB64))
        for (const [cid, data] of car.blocks) mock.blocks.set(cid, data)
        mock.head = event.commitCid
        mock.rev = event.rev
        mock.seq += 1
        mock.events.push(event)

        sendJson(res, 200, {
          uri: `at://${event.did}/${event.collection}/${event.rkey}`,
          cid: event.recordCid ?? null,
          commit: { cid: event.commitCid, rev: event.rev },
          seq: mock.seq,
        })
        return
      }

      sendJson(res, 404, { error: 'NotFound', message: `no route for ${req.method} ${url.pathname}` })
    } catch (e) {
      sendJson(res, 500, { error: 'InternalError', message: e.message })
    }
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  mock.base = `http://127.0.0.1:${port}`
  mock.server = server
  return mock
}

test('static owner console - generate, persist, unlock, import', async (t) => {
  const built = path.join(ROOT, 'public', 'app', 'app.js')
  if (!fs.existsSync(built)) {
    t.skip('public/app/app.js is missing; run sh app/build.sh first')
    return
  }

  const playwright = await loadPlaywright()
  if (!playwright) {
    t.skip('playwright is not installed')
    return
  }

  const { server, base } = await startServer()
  const browser = await launchBrowser(playwright)
  if (!browser) {
    server.close()
    t.skip('no Edge/Chromium available for playwright')
    return
  }

  try {
    // ---------- 1. generate ----------
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(`${base}/public/app/index.html`)

    await waitForVisible(page, '#setup-view')
    assert.match(await page.inputValue('#setup-did'), /^did:web:127\.0\.0\.1:\d+$/)
    const csp = await page.getAttribute('meta[http-equiv="Content-Security-Policy"]', 'content')
    assert.match(csp, /script-src 'self'/)
    assert.match(csp, /connect-src \*/)

    await page.fill('#setup-did', 'did:web:ui-smoke.test')
    await page.fill('#setup-handle', 'ui-smoke.test')
    await page.fill('#setup-worker', base)
    await page.fill('#setup-passphrase', passphrase())
    await page.fill('#setup-passphrase2', passphrase())
    await page.click('#create-key-btn')

    await waitForVisible(page, '#app-view')
    const didJson = await page.textContent('#didjson')
    assert.match(didJson, /"type": "Multikey"/)
    assert.match(didJson, /"publicKeyMultibase": "zDna/)
    assert.match(didJson, /"serviceEndpoint": "http:\/\/127\.0\.0\.1:\d+"/)

    const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), STORAGE_KEY)
    assert.strictEqual(stored.v, 1)
    assert.strictEqual(stored.did, 'did:web:ui-smoke.test')
    assert.strictEqual(stored.handle, 'ui-smoke.test')
    assert.match(stored.publicKeyMultibase, /^zDna/)
    assert.ok(stored.salt && stored.iv && stored.ciphertext)
    assert.ok(stored.iterations >= 150000)
    assert.strictEqual(stored.privateKey, undefined)
    assert.strictEqual(stored.jwk, undefined)
    // The ciphertext must not literally contain the private JWK JSON.
    assert.doesNotMatch(stored.ciphertext, /"kty"\s*:\s*"EC"/)

    // Reload: the encrypted record should lead to the unlock flow.
    await page.reload()
    await waitForVisible(page, '#unlock-view')
    assert.strictEqual(await page.textContent('#unlock-did'), 'did:web:ui-smoke.test')

    // Wrong passphrase.
    await page.fill('#unlock-passphrase', 'definitely wrong')
    await page.click('#unlock-btn')
    await waitForVisible(page, '#unlock-error')
    assert.match(await page.textContent('#unlock-error'), /Could not unlock/)

    // Correct passphrase.
    await page.fill('#unlock-passphrase', passphrase())
    await page.click('#unlock-btn')
    await waitForVisible(page, '#app-view')
    assert.strictEqual(await page.textContent('#meta-did'), 'did:web:ui-smoke.test')
    assert.match(await page.textContent('#meta-key'), /^zDna/)

    await context.close()

    // ---------- 2. import existing CLI-style key ----------
    const keypair = await generateP256Keypair({ extractable: true })
    assert.ok(keypair.privateKeyPkcs8)

    const importContext = await browser.newContext()
    const importPage = await importContext.newPage()
    await importPage.goto(`${base}/public/app/index.html`)
    await waitForVisible(importPage, '#setup-view')

    await importPage.fill('#setup-did', 'did:web:import-smoke.test')
    await importPage.fill('#setup-handle', 'import-smoke.test')
    await importPage.fill('#setup-worker', base)
    await importPage.check('#mode-import')
    await waitForVisible(importPage, '#import-field')
    await importPage.fill('#setup-import', keypair.privateKeyPkcs8)
    await importPage.fill('#setup-expected', keypair.publicKeyMultibase)
    await importPage.fill('#setup-passphrase', passphrase())
    await importPage.fill('#setup-passphrase2', passphrase())
    await importPage.click('#create-key-btn')

    await waitForVisible(importPage, '#app-view')
    assert.match(await importPage.textContent('#didjson'), new RegExp(keypair.publicKeyMultibase))
    const importedRecord = await importPage.evaluate((key) => JSON.parse(localStorage.getItem(key)), STORAGE_KEY)
    assert.strictEqual(importedRecord.publicKeyMultibase, keypair.publicKeyMultibase)
    await importContext.close()

    // ---------- 3. expected-key mismatch is rejected ----------
    const mismatchContext = await browser.newContext()
    const mismatchPage = await mismatchContext.newPage()
    await mismatchPage.goto(`${base}/public/app/index.html`)
    await waitForVisible(mismatchPage, '#setup-view')
    await mismatchPage.fill('#setup-did', 'did:web:mismatch-smoke.test')
    await mismatchPage.fill('#setup-handle', 'mismatch-smoke.test')
    await mismatchPage.fill('#setup-worker', base)
    await mismatchPage.check('#mode-import')
    await mismatchPage.fill('#setup-import', keypair.privateKeyPkcs8)
    await mismatchPage.fill('#setup-expected', 'zDnaeTiq1PdzvZXUaMdezchcMJQpBdH2VN4pgrrEhMCCbmwSb')
    await mismatchPage.fill('#setup-passphrase', passphrase())
    await mismatchPage.fill('#setup-passphrase2', passphrase())
    await mismatchPage.click('#create-key-btn')
    await waitForVisible(mismatchPage, '#setup-error')
    assert.match(await mismatchPage.textContent('#setup-error'), /does not match the current DID document key/)
    await mismatchContext.close()
  } finally {
    await browser.close()
    server.close()
  }
})

test('static owner console - signed create, delete, and 409 retry against a mock Worker', async (t) => {
  const built = path.join(ROOT, 'public', 'app', 'app.js')
  if (!fs.existsSync(built)) {
    t.skip('public/app/app.js is missing; run sh app/build.sh first')
    return
  }

  const playwright = await loadPlaywright()
  if (!playwright) {
    t.skip('playwright is not installed')
    return
  }

  const { server, base } = await startServer()
  const mock = await startMockWorker()
  const browser = await launchBrowser(playwright)
  if (!browser) {
    server.close()
    mock.server.close()
    t.skip('no Edge/Chromium available for playwright')
    return
  }

  try {
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(`${base}/public/app/index.html`)
    await waitForVisible(page, '#setup-view')

    await page.fill('#setup-did', 'did:web:mock.test')
    await page.fill('#setup-handle', 'mock.test')
    await page.fill('#setup-worker', mock.base)
    await page.fill('#setup-passphrase', passphrase())
    await page.fill('#setup-passphrase2', passphrase())
    await page.click('#create-key-btn')
    await waitForVisible(page, '#app-view')

    // Pretend the DID document already advertises this key.
    const publicKey = (await page.textContent('#meta-key')).trim()
    assert.match(publicKey, /^zDna/)
    await fetch(`${mock.base}/_test/key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: publicKey }),
    })

    // The mock starts with no repo, so the page should be writable on an
    // empty local repo and the first append must have prev === null.
    await waitFor(async () => (await page.textContent('#head-verified')).includes('No repo yet'))
    assert.strictEqual(await page.isEnabled('#post-btn'), true)

    await page.fill('#compose-text', 'hello from the static owner console')
    await page.click('#post-btn')
    await waitForVisible(page, '#compose-status.ok')
    assert.match(await page.textContent('#compose-status'), /Accepted: at:\/\/did:web:mock\.test\/app\.bsky\.feed\.post\//)

    assert.strictEqual(mock.events.length, 1)
    const createEvent = mock.events[0]
    assert.strictEqual(createEvent.op, 'create')
    assert.strictEqual(createEvent.commit.prev, null)
    assert.match(createEvent.commit.sig, /^[0-9a-f]{128}$/)
    assert.match(createEvent.commitCid, /^bafyrei/)
    assert.match(createEvent.blocksB64, /^[A-Za-z0-9+/]+=*$/)
    assert.strictEqual(createEvent.record.text, 'hello from the static owner console')

    await waitFor(async () => (await page.textContent('#head-cid')) === mock.head)
    await waitFor(async () => (await page.textContent('#records-count')) === '1')
    assert.match(await page.textContent('#records'), /hello from the static owner console/)

    // ---------- delete ----------
    page.once('dialog', (dialog) => dialog.accept())
    await page.click('.record-delete')
    await waitForVisible(page, '#compose-status.ok')
    await waitFor(async () => (await page.textContent('#records-count')) === '0')

    assert.strictEqual(mock.events.length, 2)
    const deleteEvent = mock.events[1]
    assert.strictEqual(deleteEvent.op, 'delete')
    assert.strictEqual(deleteEvent.record, undefined)
    assert.strictEqual(deleteEvent.commit.prev, createEvent.commitCid)
    assert.strictEqual(deleteEvent.recordCid, null)

    // ---------- 409 conflict: local commit must be discarded, not re-signed ----------
    const headBeforeConflict = mock.head

    // Simulate the head moving under us. The mock returns 409 on the next
    // append without storing the event.
    await fetch(`${mock.base}/_test/force-conflict`, { method: 'POST' })
    await page.fill('#compose-text', 'this write should conflict once')
    await page.click('#post-btn')
    await waitForVisible(page, '#compose-status.warn')
    assert.match(await page.textContent('#compose-status'), /409 RepoConflict/)
    assert.match(await page.textContent('#compose-status'), /NOT re-signed/)
    assert.strictEqual(mock.events.length, 2, 'the conflicted event must not be stored')
    assert.strictEqual(mock.head, headBeforeConflict)

    // The page reloads the unchanged head and should allow a deliberate retry.
    await waitFor(async () => page.isEnabled('#post-btn'))
    await page.fill('#compose-text', 'retry after conflict')
    await page.click('#post-btn')
    await waitFor(async () => mock.events.length === 3)
    assert.strictEqual(mock.events[2].op, 'create')
    assert.strictEqual(mock.events[2].commit.prev, headBeforeConflict)
    assert.strictEqual(mock.events[2].record.text, 'retry after conflict')

    await context.close()
  } finally {
    await browser.close()
    mock.server.close()
    server.close()
  }
})
