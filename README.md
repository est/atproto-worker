# atproto-worker

A stateless AT Protocol publisher on Cloudflare Workers. Your journal is a signed append-only log (`journal.ndjson`); the Worker serves it via standard atproto endpoints. No database, no mutable state.

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

Posting flow: `seal.js post` appends a signed event to `journal.ndjson`
locally → copy it to `public/journal.ndjson` → deploy. The Worker then
serves it via XRPC and broadcasts it over the firehose. No database, no
mutable state, no external static hosting.

## Quick Start

### Prerequisites

- Node.js 19+
- Cloudflare account

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

### 3. Create a KV namespace

```bash
npx wrangler kv namespace create JOURNAL_KV
```

Copy the returned ID into `wrangler.toml` under `[[kv_namespaces]]`.

### 4. Publish your first post

```bash
node cli/seal.js post "Hello from atproto-worker!"
cp journal.ndjson public/journal.ndjson
```

### 5. Deploy

```bash
npm run deploy
```

### 6. Refresh

Reload the journal (fetches from the Worker's own static asset):

```bash
curl https://your-worker.subdomain.workers.dev/refresh
```

Or wait for the cron (every 5 minutes). The deployment checklist at `/`
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
| `/xrpc/_health` | Health check |
| `/refresh` | Reload journal from the Worker's own static asset |
| `/journal.ndjson` | The journal static asset itself |

## CLI Commands

```bash
node cli/seal.js init [did] [handle]     # Generate keypair
node cli/seal.js rotate-key              # Generate new keypair
node cli/seal.js post "text"             # Create a post
node cli/seal.js like <at-uri> <cid>     # Like a post
node cli/seal.js repost <at-uri> <cid>   # Repost
node cli/seal.js follow <did>            # Follow someone
node cli/seal.js validate                # Validate journal integrity
node cli/seal.js list                    # List all records
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
- Worker never holds or uses private keys (signing is CLI-only)
- Journal chain is validated on load (CID integrity and prev links)
- Private key uses secp256k1 (k256), matching atproto default

## Known Limitations

- **Firehose**: `#commit` events have empty `blocks` — consumers needing full CAR data won't work
- **Interactions**: Cron fetches likes/reposts but only logs them, no persistence yet
- **Write operations**: XRPC write endpoints return 501 — use CLI for all writes
- **Journal must be append-only**: Refresh assumes events are only appended, never reordered

## Project Status

Working prototype. Core read path (XRPC, firehose, DID documents) and write path (CLI signing, journal append) are functional. Tests pass including atproto interop tests (CID/CBOR encoding, handle/DID syntax).

## License

MIT
