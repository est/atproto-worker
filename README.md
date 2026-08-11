# atproto-worker

A stateless AT Protocol publisher on Cloudflare Workers. Your journal is a signed append-only log (`journal.ndjson`); the Worker serves it via standard atproto endpoints. No database, no mutable state.

## Architecture

```
┌──────────────────┐      ┌──────────────────────┐
│  Local CLI       │      │  Static Host         │
│  (cli/seal.js)   │─────▶│  (journal.ndjson)    │
│  Signs & appends │      │  S3 / R2 / Pages     │
└──────────────────┘      └──────────┬───────────┘
                                     │ /refresh or cron
                                     ▼
                         ┌───────────────────────┐
                         │  Cloudflare Worker    │
                         │  - XRPC API           │
                         │  - WebSocket firehose │
                         │  - DID documents      │
                         └───────────────────────┘
```

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

### 1. Create KV namespace

```bash
npx wrangler kv namespace create JOURNAL_KV
```

Copy the returned ID into `wrangler.toml`.

### 2. Publish journal

Upload `journal.ndjson` to a static host (S3, GitHub Pages, R2, etc.).

### 3. Configure worker

Edit `wrangler.toml`:

```toml
[vars]
OWNER_DID = "did:web:yourdomain.com"      # or did:plc:xxx
OWNER_HANDLE = "yourdomain.com"
OWNER_PUBLIC_KEY = "zQ3sh..."             # from config.json after init
JOURNAL_URL = "https://your-host/journal.ndjson"
```

### 4. Set secrets

```bash
wrangler secret put PRIVATE_KEY            # hex private key from config.json
```

### 5. Deploy

```bash
npm run deploy
```

### 6. Refresh

Reload journal from static host:

```bash
curl https://your-worker.workers.dev/refresh
```

Or wait for the cron (every 5 minutes).

## Endpoints

| Path | Description |
|------|-------------|
| `/` | Server info (DID, handle, journal stats) |
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
| `/refresh` | Reload journal from static host |

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
- `journal.ndjson` contains signed events — gitignored by default
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
