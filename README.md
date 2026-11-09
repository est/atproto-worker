# atproto-worker

An AT Protocol publisher / lightweight PDS on Cloudflare Workers. Historically a fully static signed journal; **after M1 (Nov 2026)** runtime writes go to a SQLite ledger in the Firehose Durable Object, and the static `journal.ndjson` is a seed/backup. The owner signs with a P-256 key in the CLI or browser; the Worker never holds a private key.

## M1: owner-signed P-256 + live ledger (Nov 2026)

- New accounts default to **P-256** (`init --curve p256`). Existing K-256 accounts rotate with `rotate-key --curve p256` + `rotate-head`; history does not need re-signing (atproto verifies the head commit only).
- **Browser console** at `/app/`: the P-256 key lives in the browser (passphrase-encrypted), reads via `getRepo`, writes via `appendEvent`; can also be hosted independently.
- **Live ledger**: Firehose DO SQLite (`events`/`heads`/`meta`), `POST /xrpc/com.atproto.worker.appendEvent` verifies the signature + head CAS + broadcasts; `GET /xrpc/com.atproto.worker.snapshot` exports NDJSON.
- **CLI**: `push`/`pull` to sync with the ledger; `rotate-head` re-signs the current head with the new key without changing content.
- Decision: `docs/ADR/040.arch.owner-signed-p256-repo.md`; design: `docs/phase6.md`.
- Rule: once the ledger is live, runtime writes go through append; the static journal is only a seed/backup. Official bsky.app clients still require the full PDS write path (M3).

## 🚀 一键部署（不需要懂 atproto 或 Cloudflare）

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/est/atproto-worker)

1. 点击上方按钮 → 授权 GitHub → 创建 Cloudflare 账号（如已有则登录）
2. 部署完成后打开你的 Worker 域名（`https://<你的域名>.workers.dev`）
3. **首页就是部署向导**：DID 和句柄已自动识别，唯一要手动做的是设置身份公钥（向导里有逐步指引，只需本地跑一条命令生成密钥对）
4. 按向导发布第一条帖子，点击「检查联邦收录」，几分钟后即可在 Bluesky 上看到

> 一键部署会自动配置：Durable Object（firehose）、静态资产（journal）、定时任务、身份自动推导。私钥始终留在你本地，Worker 永不接触。

## M3 (optional): official bsky.app client compatibility

M1 owner-signed accounts cannot log into official clients (standard write endpoints take records, not pre-signed commits). M3 adds a second **worker-signed** mode: the Worker holds the repo key and signs server-side. One mode per account:

- `owner-signed` (M1): key in the owner's browser/CLI; `appendEvent`; official clients unavailable.
- `worker-signed` (M3): key in the Worker (P-256, currently DO storage); standard `createRecord/applyWrites/uploadBlob`; official clients work; the owner revokes via did.json/rotation.

Setup:

```bash
npx wrangler secret put JWT_SECRET
npx wrangler secret put BOOTSTRAP_TOKEN
# local: cp .dev.vars.example .dev.vars

curl -X POST https://<worker>/xrpc/com.atproto.worker.bootstrapAccount \
  -H "Authorization: Bearer $BOOTSTRAP_TOKEN" -H 'Content-Type: application/json' \
  -d '{"did":"did:web:you.example","handle":"you.example","password":"...","pdsEndpoint":"https://<worker>"}'
# publish the returned didDoc at https://you.example/.well-known/did.json
# then createSession + createRecord/applyWrites/uploadBlob with the returned JWTs
```

Blobs use R2 when `env.BLOBS` is bound, otherwise a DO SQLite fallback (small files). The first M3 slice is single-account worker-signed; the existing main account stays M1 owner-signed. See `docs/phase7.md` and `docs/ADR/041`.

## Architecture

```
┌──────────────────┐      ┌──────────────────────┐
│  Local CLI       │─────▶│  Worker Static Asset │
│  (cli/seal.js)   │      │  (public/journal)    │
│  Signs & appends │      └──────────┬───────────┘
└──────────────────┘                 │ /refresh or cron
                                    ▼
                        ┌───────────────────────┐
                        │  Cloudflare Worker    │
                        │  - XRPC API           │
                        │  - WebSocket firehose │
                        │  - DID documents      │
                        │  - / checklist page   │
                        └───────────────────────┘
```

Posting flow (M1): the browser or CLI builds and signs a commit, then POSTs
it to `appendEvent`; the Firehose DO ledger stores it and broadcasts it over
the firehose. The static `journal.ndjson` is a seed/backup for a fresh
deploy. No private key ever reaches the Worker.

## Quick Start

### Prerequisites

- Node.js 19+
- Cloudflare account（或用上方一键部署按钮）

### 1. Install & Initialize

```bash
npm install
node cli/seal.js init did:web:yourdomain.com yourdomain.com
```

Generates a secp256k1 keypair. Saves to `config.json` (local only, gitignored).

### 2. Create content

```bash
node cli/seal.js post "Hello from atproto-worker!"
node cli/seal.js like at://did:plc:xxx/app.bsky.feed.post/yyy bafy...
node cli/seal.js follow did:plc:xxx
```

### 3. Run locally

```bash
npm run dev:local
```

Worker starts at `http://localhost:8787`.

### 4. Test

```bash
npm test
```

## Deployment

The Worker is fully self-contained: the journal ships as a static asset
(`public/journal.ndjson`), so no external static hosting is needed. After
deploy, visit `https://<your-worker>.<subdomain>.workers.dev/` for a live
checklist that walks you through each configuration step.

### 1. Initialize identity (once, local)

```bash
node cli/seal.js init did:web:your-worker.subdomain.workers.dev your-worker.subdomain.workers.dev
```

Generates a secp256k1 keypair, saves it to `config.json` (local only,
gitignored). The public key goes into `wrangler.toml`; the private key
never leaves your machine.

### 2. Configure wrangler.toml

```toml
[assets]
directory = "./public"

[vars]
OWNER_DID = "did:web:your-worker.subdomain.workers.dev"
OWNER_HANDLE = "your-worker.subdomain.workers.dev"
OWNER_PUBLIC_KEY = "zQ3sh..."        # from config.json after init
JOURNAL_URL = "https://your-worker.subdomain.workers.dev/journal.ndjson"
```

### 3. Publish your first post

```bash
node cli/seal.js post "Hello from atproto-worker!"
cp journal.ndjson public/journal.ndjson
```

### 4. Deploy

```bash
npm run deploy
```

### 5. Refresh

Reload the journal (fetches from the Worker's own static asset), broadcasts
new events to the firehose, and pokes the relay to re-crawl:

```bash
curl https://your-worker.subdomain.workers.dev/refresh
```

Or wait for the cron (every 15 minutes). The deployment checklist at `/`
shows the live status of every step.

> **No secrets needed.** The Worker only ever reads the public key. There
> is no `wrangler secret put PRIVATE_KEY` step — the private key lives
> exclusively in the local `config.json` (ADR-005: local signing only).

## Endpoints

| Path | Description |
|------|-------------|
| `/` | Deployment checklist page (live config status); JSON info with `Accept: application/json` |
| `/.well-known/atproto-did` | Returns owner DID |
| `/.well-known/did.json` | DID document (did:web only) |
| `/xrpc/com.atproto.repo.getRecord` | Get a record |
| `/xrpc/com.atproto.repo.listRecords` | List records in collection |
| `/xrpc/com.atproto.sync.subscribeRepos` | WebSocket firehose |
| `/xrpc/com.atproto.sync.getLatestCommit` | Latest commit CID & rev |
| `/xrpc/com.atproto.sync.listRepos` | List repos |
| `/xrpc/com.atproto.server.describeServer` | Server description |
| `/xrpc/com.atproto.identity.resolveHandle` | Resolve handle to DID |
| `/xrpc/com.atproto.worker.appendEvent` | **Owner-signed write** (P-256 verify + head CAS) |
| `/xrpc/com.atproto.worker.snapshot` | Export the live ledger as NDJSON (`?after=&limit=`) |
| `/xrpc/com.atproto.worker.bootstrapAccount` | M3 owner-only: create a worker-signed account + repo key (`BOOTSTRAP_TOKEN`) |
| `/xrpc/com.atproto.worker.accountDidDoc` | Return the did.json an account should publish |
| `/xrpc/com.atproto.server.createSession` / `getSession` / `refreshSession` / `deleteSession` | M3 sessions |
| `/xrpc/com.atproto.repo.createRecord` / `putRecord` / `deleteRecord` / `applyWrites` | M3 server-signed writes |
| `/xrpc/com.atproto.repo.uploadBlob` | M3 blob upload (5 MB; R2 or DO fallback) |
| `/xrpc/com.atproto.sync.listBlobs` | M3 list blob CIDs |
| `/xrpc/_health` | Health check |
| `/refresh` | Seed/refresh, broadcast, and `requestCrawl` |
| `/journal.ndjson` | Static seed/backup (imported into the ledger on a fresh deploy) |
| `/app/` | Static owner console (browser P-256 signing) |

## CLI Commands

```bash
node cli/seal.js init [did] [handle] [--curve p256|k256]   # Generate keypair (default p256)
node cli/seal.js rotate-key [--curve p256|k256]            # Rotate key + rewrite did.json
node cli/seal.js rotate-head                               # Re-sign current head (no content change)
node cli/seal.js post "text"                               # Create a post (local sign, append journal)
node cli/seal.js like <at-uri> <cid>                       # Like a post
node cli/seal.js repost <at-uri> <cid>                     # Repost
node cli/seal.js follow <did>                              # Follow someone
node cli/seal.js validate                                  # Validate journal (per-event signingKey/previousPublicKeys)
node cli/seal.js list                                      # List all records
node cli/seal.js push [--remote URL] [--account id]        # Push local signed events to the live ledger
node cli/seal.js pull [--remote URL] [--account id]        # Pull the ledger + rebuild .repo-state
```

Web UI build/test:

```bash
npm run build:app   # esbuild -> public/app/app.js
npm run test:ui     # Playwright + Edge smoke tests
```

## Identity Model

- **did:web**: `OWNER_DID=did:web:yourdomain.com` — DID document at `/.well-known/did.json`
- **did:plc**: `OWNER_DID=did:plc:xxx` — `did.json` returns 404 (document at plc.directory)

Both `/.well-known/atproto-did` and `/.well-known/did.json` return consistent identity.

## Security

- `config.json` contains your private key — never commit it
- The root `journal.ndjson` (local working copy) is gitignored; the signed
  events in `public/journal.ndjson` are safe to commit (signatures are
  verified by the Worker on load)
- Worker never holds or uses private keys (signing is CLI- or browser-only)
- Read path validates the CID/prev chain but **does not verify signatures** (ADR-030 trust boundary)
- `appendEvent` **must verify P-256 signature + low-S + head/CAR** (ADR-040)
- New accounts default to P-256 (WebCrypto-native); K-256 history remains readable
- Browser keys are PBKDF2 + AES-GCM encrypted in localStorage; see `docs/phase6.md` §6.8 for CSP/independent-hosting guidance

## Known Limitations

- **Not a full PDS**: official bsky.app clients still cannot log in/post; that requires M3 (Worker-held repo key + sessions/JWT + server-side signing)
- **Blobs**: browser image/avatar upload is not implemented (existing static blob publishing still works)
- **Full MST verification**: append checks root/CAR presence, not that the record leaf is reachable from `mstRoot`
- **Rate limiting / self-registration**: append is limited to already-hosted DIDs; no per-DID write rate limits yet
- **Rotation replay boundary**: a relay replaying old K-256 events from seq -1 may fail verification because the current did.json is P-256 (normal cursors are unaffected)
- The static journal is only a seed/backup; do not use local-append + deploy as a runtime write path once the ledger is live

## Project Status

M1 is functional: read path (XRPC, firehose, DID documents), write path (CLI/browser P-256 signing + DO ledger), static UI, and CLI push/pull. `npm test` and `npm run test:ui` pass; official `@atproto/repo.verifyRepoCar` accepts the P-256 commit/CAR. The main account is rotated to P-256 locally, pending `wrangler login` + deploy.

## License

MIT
