/**
 * M3 standard repo write path (worker-signed).
 *
 * Implements the standard atproto write endpoints:
 *   com.atproto.repo.createRecord
 *   com.atproto.repo.putRecord
 *   com.atproto.repo.deleteRecord
 *   com.atproto.repo.applyWrites
 *
 * The Worker:
 *   1. authenticates the session (src/auth.js),
 *   2. loads the current repo from M1 ledger events (CAR blocks),
 *   3. applies the write(s) to the MST,
 *   4. signs the commit with the Worker-held P-256 repo key,
 *   5. appends the signed event to the Firehose ledger DO (head/rev CAS),
 *   6. returns a standard XRPC JSON response.
 *
 * The handler is intentionally self-contained: src/xrpc.js only needs to
 * dispatch the four method names to `handleRepoWriteXrpc`.
 */

import {
  base64ToBytes,
  bytesToBase64,
  generateTID,
  readCarFile,
} from './shared.js'
import { signP256 } from './keys.js'
import { isValidNsid, isValidRecordKey } from './utils.js'
import { Repo } from './repo-core.js'

export const MAX_WRITE_BODY_BYTES = 2 * 1024 * 1024 // JSON request body
export const MAX_APPLY_WRITES = 200

const SUPPORTED_METHODS = new Set([
  'com.atproto.repo.createRecord',
  'com.atproto.repo.putRecord',
  'com.atproto.repo.deleteRecord',
  'com.atproto.repo.applyWrites',
])

/**
 * Error carrying the HTTP/XRPC status to return. The handler forwards
 * `status`/`error`/`message` (plus optional `details`) directly.
 */
export class RepoWriteError extends Error {
  constructor(status, error, message, details = null) {
    super(message)
    this.name = 'RepoWriteError'
    this.status = status
    this.error = error
    this.details = details
  }
}

function fail(status, error, message, details) {
  throw new RepoWriteError(status, error, message, details)
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)
}

function xrpcError(status, error, message, details = null) {
  const body = { error, message }
  if (details && typeof details === 'object') Object.assign(body, details)
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function xrpcSuccess(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ============ Ledger / repo loading ============

/**
 * Load the current repo state for one DID from the already-loaded journal.
 *
 * Every event's `blocksB64` is an incremental CAR; merging all of them
 * reconstructs the full blockstore (MST nodes + record blocks + commits).
 * The latest event carrying a `commitCid` is the head.
 *
 * @param {{events: Array<object>}} journal
 * @param {string} did
 * @param {string} signingKeyPkcs8 - base64 PKCS#8 P-256 private key
 * @returns {Promise<Repo>}
 */
export async function loadRepoForDid(journal, did, signingKeyPkcs8) {
  if (!did || typeof did !== 'string') throw new Error('loadRepoForDid requires a did')

  const events = Array.isArray(journal?.events)
    ? journal.events.filter(event => event && event.did === did)
    : []

  const blockstore = new Map()
  for (const event of events) {
    if (!event.blocksB64) continue
    try {
      const { blocks } = readCarFile(base64ToBytes(event.blocksB64))
      for (const [cid, bytes] of blocks) blockstore.set(cid, bytes)
    } catch {
      // Legacy/seed rows may carry non-CAR blocksB64. Skip them; the head
      // block must still be present or Repo.create below will surface it.
    }
  }

  let last = null
  for (const event of events) {
    if (event.commitCid) last = event
  }

  if (!last) {
    return Repo.create({ did, signingKey: signingKeyPkcs8 })
  }

  const mstRoot = last.mstRoot ?? last.commit?.data ?? null
  return Repo.create({
    did,
    signingKey: signingKeyPkcs8,
    blockstore,
    mstRoot,
    commitCid: last.commitCid ?? null,
    rev: last.rev ?? null,
  })
}

/**
 * Build the M1-shaped ledger event for a write result.
 *
 * @param {object} opts
 * @param {Repo} opts.repo
 * @param {string} opts.did
 * @param {'create'|'update'|'delete'} opts.action
 * @param {string} opts.collection
 * @param {string} opts.rkey
 * @param {object} [opts.record]
 * @param {object} opts.result - Repo.applyWrite/applyWrites result
 * @param {string} opts.signingKey - publicKeyMultibase
 * @returns {object}
 */
export function buildEvent({ repo, did, action, collection, rkey, record, result, signingKey }) {
  if (!repo || typeof repo.buildCar !== 'function') throw new Error('buildEvent requires a repo')
  if (!result?.commitCid) throw new Error('buildEvent requires a write result')

  const event = {
    did,
    op: action,
    collection,
    rkey,
    rev: result.rev,
    recordCid: result.recordCid ?? null,
    commit: result.commit,
    commitCid: result.commitCid,
    mstRoot: result.mstRoot,
    prevMstRoot: result.prevMstRoot ?? null,
    blocksB64: bytesToBase64(repo.buildCar(result)),
    signingKey,
  }
  if (action !== 'delete') event.record = record
  return event
}

/**
 * POST one already-built/signed event to the Firehose DO ledger.
 *
 * A 409 from the ledger means the head CAS failed (the journal was stale or
 * another write won the race). It is surfaced as a `RepoWriteError` with
 * status 409 so the caller can translate it to InvalidSwap when appropriate.
 *
 * @param {object} env
 * @param {object} event
 * @param {string|null} expectedHead
 * @param {string|null} expectedRev
 * @returns {Promise<object>} ledger response JSON
 */
export async function appendEventInternal(env, event, expectedHead, expectedRev) {
  if (!env?.FIREHOSE) {
    fail(503, 'LedgerUnavailable', 'Firehose ledger binding is not configured')
  }

  let stub
  try {
    const id = env.FIREHOSE.idFromName('main')
    stub = env.FIREHOSE.get(id)
  } catch {
    fail(503, 'LedgerUnavailable', 'Firehose ledger binding is unavailable')
  }

  let response
  try {
    response = await stub.fetch('http://ledger/append', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event,
        expectedHead: expectedHead ?? null,
        expectedRev: expectedRev ?? null,
      }),
    })
  } catch {
    fail(502, 'LedgerError', 'Failed to write to the ledger')
  }

  let data = {}
  try {
    data = await response.json()
  } catch {
    data = {}
  }

  if (response.status === 409) {
    throw new RepoWriteError(
      409,
      'RepoConflict',
      data.message || 'Repository head changed; fetch the new head and rebase',
      { head: data.head ?? null },
    )
  }
  if (!response.ok) {
    fail(502, 'LedgerError', data.message || `ledger append failed (${response.status})`)
  }
  return data
}

// ============ Request helpers ============

async function readJsonBody(request) {
  const declared = parseInt(request.headers.get('Content-Length') || '0', 10)
  if (Number.isFinite(declared) && declared > MAX_WRITE_BODY_BYTES) {
    fail(413, 'PayloadTooLarge', `request body exceeds ${MAX_WRITE_BODY_BYTES} bytes`)
  }

  let text
  try {
    text = await request.text()
  } catch {
    fail(400, 'InvalidRequest', 'could not read the request body')
  }
  if (text.length > MAX_WRITE_BODY_BYTES) {
    fail(413, 'PayloadTooLarge', `request body exceeds ${MAX_WRITE_BODY_BYTES} bytes`)
  }
  if (!text.trim()) {
    fail(400, 'InvalidRequest', 'request body is required')
  }

  let body
  try {
    body = JSON.parse(text)
  } catch {
    fail(400, 'InvalidRequest', 'request body is not valid JSON')
  }
  if (!isPlainObject(body)) {
    fail(400, 'InvalidRequest', 'request body must be a JSON object')
  }
  return body
}

let cachedAuthModule = null

async function resolveAuthModule(override) {
  if (override) return override
  if (!cachedAuthModule) cachedAuthModule = import('./auth.js')
  return cachedAuthModule
}

function isAuthError(error, authModule) {
  if (!error) return false
  if (authModule?.AuthError && error instanceof authModule.AuthError) return true
  return typeof error.status === 'number' && typeof error.error === 'string'
}

async function authenticate(request, env, authModule) {
  let session
  try {
    session = await authModule.requireAuth(request, env)
  } catch (error) {
    if (isAuthError(error, authModule)) {
      fail(
        error.status ?? 401,
        error.error ?? 'AuthenticationRequired',
        error.message ?? 'Authentication required',
      )
    }
    throw error
  }

  if (!session?.did) {
    fail(401, 'AuthenticationRequired', 'Authentication required')
  }

  let account = session.account ?? null
  if (!account && typeof authModule.getAccount === 'function') {
    try {
      account = await authModule.getAccount(env, { did: session.did, handle: session.handle })
    } catch {
      account = null
    }
  }
  if (!account) {
    fail(401, 'AccountNotFound', 'Authenticated account was not found')
  }

  return { session, account }
}

async function resolveRepoDid(repo, session, account, authModule, env) {
  if (typeof repo !== 'string' || !repo) {
    fail(400, 'InvalidRequest', 'repo is required')
  }
  if (repo === session.did) return session.did
  if (repo === account.handle || repo === session.handle) return session.did

  // A handle may resolve to an account record; it is only acceptable when it
  // resolves to the authenticated DID.
  if (!repo.startsWith('did:') && typeof authModule.getAccount === 'function') {
    let other = null
    try {
      other = await authModule.getAccount(env, { handle: repo })
    } catch {
      other = null
    }
    if (other?.did === session.did) return session.did
  }

  fail(403, 'Forbidden', 'repo does not match the authenticated account')
}

async function loadRepoKey(authModule, env, did) {
  if (typeof authModule.getRepoKey !== 'function') {
    fail(500, 'RepoKeyUnavailable', 'Worker-held repo key is not configured for this account')
  }
  let key
  try {
    key = await authModule.getRepoKey(env, did)
  } catch {
    fail(500, 'RepoKeyUnavailable', 'Worker-held repo key is not configured for this account')
  }
  if (!key || typeof key.privateKeyPkcs8 !== 'string' || !key.privateKeyPkcs8) {
    fail(500, 'RepoKeyUnavailable', 'Worker-held repo key is not configured for this account')
  }
  if (key.curve && !['p256', 'P-256', 'secp256r1'].includes(key.curve)) {
    fail(400, 'UnsupportedKeyType', 'Only P-256 worker-held repo keys are supported')
  }
  return key
}

function validateCollection(collection) {
  if (typeof collection !== 'string' || !isValidNsid(collection)) {
    fail(400, 'InvalidRequest', 'collection must be a valid NSID')
  }
}

function validateRkey(rkey) {
  if (typeof rkey !== 'string' || !isValidRecordKey(rkey)) {
    fail(400, 'InvalidRequest', 'rkey must be a valid record key')
  }
}

function normalizeRecord(record, collection) {
  if (!isPlainObject(record)) {
    fail(400, 'InvalidRequest', 'record is required and must be an object')
  }
  // Permissive: only enforce $type when the client supplied one.
  if (record.$type !== undefined && record.$type !== collection) {
    fail(400, 'InvalidRequest', `record.$type (${record.$type}) must equal collection (${collection})`)
  }
  return record
}

function checkSwapCommit(repo, swapCommit) {
  if (swapCommit === undefined || swapCommit === null) return
  const head = repo.getHead()
  if (swapCommit !== head.commitCid) {
    fail(400, 'InvalidSwap', 'swapCommit does not match the current repo commit')
  }
}

async function checkSwapRecord(repo, collection, rkey, swapRecord) {
  if (swapRecord === undefined) return
  const current = await repo.getRecordCid(collection, rkey)
  if ((swapRecord ?? null) !== (current ?? null)) {
    fail(400, 'InvalidSwap', 'swapRecord does not match the current record')
  }
}

function atUri(did, collection, rkey) {
  return `at://${did}/${collection}/${rkey}`
}

async function appendWrite(env, event, prevHead, hadSwapCommit) {
  try {
    return await appendEventInternal(
      env,
      event,
      prevHead.commitCid ?? null,
      prevHead.rev ?? null,
    )
  } catch (error) {
    if (
      error instanceof RepoWriteError &&
      error.status === 409 &&
      hadSwapCommit
    ) {
      throw new RepoWriteError(
        400,
        'InvalidSwap',
        'swapCommit does not match the current repo commit',
        error.details,
      )
    }
    throw error
  }
}

// ============ Method handlers ============

async function createRecord({ body, repo, did, key, signFn, env }) {
  validateCollection(body.collection)
  let rkey = body.rkey
  if (rkey === undefined || rkey === null) rkey = generateTID()
  validateRkey(rkey)
  const record = normalizeRecord(body.record, body.collection)

  checkSwapCommit(repo, body.swapCommit)

  const existing = await repo.getRecordCid(body.collection, rkey)
  if (existing) {
    fail(400, 'InvalidRequest', 'Record already exists')
  }

  const prevHead = repo.getHead()
  const result = await repo.applyWrite(
    { action: 'create', collection: body.collection, rkey, record },
    signFn,
  )
  const event = buildEvent({
    repo,
    did,
    action: 'create',
    collection: body.collection,
    rkey,
    record,
    result,
    signingKey: key.publicKeyMultibase,
  })
  await appendWrite(env, event, prevHead, body.swapCommit !== undefined && body.swapCommit !== null)

  return {
    uri: atUri(did, body.collection, rkey),
    cid: result.recordCid,
    commit: { cid: result.commitCid, rev: result.rev },
    validationStatus: 'valid',
  }
}

async function putRecord({ body, repo, did, key, signFn, env }) {
  validateCollection(body.collection)
  validateRkey(body.rkey)
  const record = normalizeRecord(body.record, body.collection)

  checkSwapCommit(repo, body.swapCommit)
  await checkSwapRecord(repo, body.collection, body.rkey, body.swapRecord)

  const existing = await repo.getRecordCid(body.collection, body.rkey)
  const action = existing ? 'update' : 'create'

  const prevHead = repo.getHead()
  const result = await repo.applyWrite(
    { action, collection: body.collection, rkey: body.rkey, record },
    signFn,
  )
  const event = buildEvent({
    repo,
    did,
    action,
    collection: body.collection,
    rkey: body.rkey,
    record,
    result,
    signingKey: key.publicKeyMultibase,
  })
  await appendWrite(env, event, prevHead, body.swapCommit !== undefined && body.swapCommit !== null)

  return {
    uri: atUri(did, body.collection, body.rkey),
    cid: result.recordCid,
    commit: { cid: result.commitCid, rev: result.rev },
    validationStatus: 'valid',
  }
}

async function deleteRecord({ body, repo, did, key, signFn, env }) {
  validateCollection(body.collection)
  validateRkey(body.rkey)

  checkSwapCommit(repo, body.swapCommit)
  await checkSwapRecord(repo, body.collection, body.rkey, body.swapRecord)

  const existing = await repo.getRecordCid(body.collection, body.rkey)
  if (!existing) {
    fail(404, 'RecordNotFound', 'Record not found')
  }

  const prevHead = repo.getHead()
  const result = await repo.applyWrite(
    { action: 'delete', collection: body.collection, rkey: body.rkey },
    signFn,
  )
  const event = buildEvent({
    repo,
    did,
    action: 'delete',
    collection: body.collection,
    rkey: body.rkey,
    result,
    signingKey: key.publicKeyMultibase,
  })
  await appendWrite(env, event, prevHead, body.swapCommit !== undefined && body.swapCommit !== null)

  return { commit: { cid: result.commitCid, rev: result.rev } }
}

function normalizeApplyWrite(write) {
  if (!isPlainObject(write)) {
    fail(400, 'InvalidRequest', 'each write must be an object')
  }

  let action = write.action
  if (!action && typeof write.$type === 'string') {
    const marker = write.$type.split('#').pop()
    if (marker === 'create' || marker === 'update' || marker === 'delete') action = marker
  }
  if (action !== 'create' && action !== 'update' && action !== 'delete') {
    fail(400, 'InvalidRequest', `unsupported write action: ${action}`)
  }

  validateCollection(write.collection)

  let rkey = write.rkey
  if ((rkey === undefined || rkey === null) && action === 'create') rkey = generateTID()
  validateRkey(rkey)

  if (action === 'delete') {
    return { action, collection: write.collection, rkey }
  }

  // Accept the lexicon's `value` as well as the `record` spelling.
  const record = write.record !== undefined ? write.record : write.value
  normalizeRecord(record, write.collection)
  return { action, collection: write.collection, rkey, record }
}

async function applyWrites({ body, repo, did, key, signFn, env }) {
  if (!Array.isArray(body.writes)) {
    fail(400, 'InvalidRequest', 'writes must be an array')
  }
  if (body.writes.length === 0) {
    fail(400, 'InvalidRequest', 'writes must contain at least one write')
  }
  if (body.writes.length > MAX_APPLY_WRITES) {
    fail(413, 'PayloadTooLarge', `applyWrites accepts at most ${MAX_APPLY_WRITES} writes`)
  }

  checkSwapCommit(repo, body.swapCommit)

  const normalized = body.writes.map(normalizeApplyWrite)

  const prevHead = repo.getHead()
  const result = await repo.applyWrites(normalized, signFn)

  // The ledger schema currently stores one event row per commit. The CAR in
  // blocksB64 still carries every write's record/MST block, so repo state is
  // complete; the event metadata describes the first op in request order.
  const first = normalized[0]
  const event = buildEvent({
    repo,
    did,
    action: first.action,
    collection: first.collection,
    rkey: first.rkey,
    record: first.record,
    result,
    signingKey: key.publicKeyMultibase,
  })
  const writesByKey = new Map(normalized.map(w => [`${w.collection}/${w.rkey}`, w]))
  event.writes = result.results.map(item => {
    const write = writesByKey.get(`${item.collection}/${item.rkey}`)
    return {
      op: item.action,
      collection: item.collection,
      rkey: item.rkey,
      ...(item.recordCid ? { recordCid: item.recordCid } : {}),
      ...(write?.record ? { record: write.record } : {}),
    }
  })

  await appendWrite(env, event, prevHead, body.swapCommit !== undefined && body.swapCommit !== null)

  const results = result.results.map(item => {
    const uri = atUri(did, item.collection, item.rkey)
    if (item.action === 'delete') {
      return { uri, validationStatus: 'valid' }
    }
    return { uri, cid: item.recordCid, validationStatus: 'valid' }
  })

  return {
    commit: { cid: result.commitCid, rev: result.rev },
    results,
  }
}

// ============ Entry point ============

/**
 * Handle one standard repo write XRPC. The caller (src/xrpc.js) dispatches
 * the four method names here after loading the journal.
 *
 * @param {Request} request
 * @param {string} method - e.g. 'com.atproto.repo.createRecord'
 * @param {object} env
 * @param {ExecutionContext} [ctx]
 * @param {{journal?: {events: Array<object>}, ownHost?: string,
 *   auth?: object}} [options] - `auth` is a test seam; production uses
 *   `src/auth.js`.
 * @returns {Promise<Response>}
 */
export async function handleRepoWriteXrpc(request, method, env, ctx, options = {}) {
  try {
    if (!method) {
      method = new URL(request.url).pathname.replace('/xrpc/', '')
    }
    if (!SUPPORTED_METHODS.has(method)) {
      return xrpcError(501, 'MethodNotImplemented', `Method ${method} is not implemented`)
    }
    if (request.method !== 'POST') {
      return xrpcError(405, 'MethodNotAllowed', `${method} requires POST`)
    }

    const body = await readJsonBody(request)
    const authModule = await resolveAuthModule(options.auth)
    const { session, account } = await authenticate(request, env, authModule)

    if (account.mode !== 'worker-signed') {
      fail(403, 'OwnerSignedMode', 'Use the owner-signed append endpoint or switch the account mode')
    }

    const did = await resolveRepoDid(body.repo, session, account, authModule, env)
    const key = await loadRepoKey(authModule, env, did)

    const repo = await loadRepoForDid(options.journal, did, key.privateKeyPkcs8)
    const signFn = encoded => signP256(key.privateKeyPkcs8, encoded)

    const args = { body, repo, did, key, signFn, env, ctx }

    let result
    switch (method) {
      case 'com.atproto.repo.createRecord':
        result = await createRecord(args)
        break
      case 'com.atproto.repo.putRecord':
        result = await putRecord(args)
        break
      case 'com.atproto.repo.deleteRecord':
        result = await deleteRecord(args)
        break
      case 'com.atproto.repo.applyWrites':
        result = await applyWrites(args)
        break
    }

    return xrpcSuccess(result)
  } catch (error) {
    if (error instanceof RepoWriteError) {
      return xrpcError(error.status, error.error, error.message, error.details)
    }
    // Never log key material; only the error message.
    console.error('[writes] unhandled error:', error?.message || error)
    return xrpcError(500, 'InternalError', 'Failed to process repo write')
  }
}
