# atproto-worker

A serverless AT Protocol publisher that maps static JSON in a git repo to atproto/bsky via WebSocket and XRPC.

## Why

[atproto](https://atproto.com) is a protocol for social network data portability. The official [self-hosting guide](https://atproto.com/guides/self-hosting) is heavyweight.

This project takes a different approach: treat your repo data like a static site. Your journal is a signed append-only log (`journal.ndjson`), published as a static file. A Cloudflare Worker serves it via standard atproto endpoints.

No database. No mutable state. Just static files and a stateless worker.

## Architecture

```
┌─────────────────┐      ┌──────────────────────┐
│  Local CLI       │      │  Static Host          │
│  (cli/seal.js)   │─────▶│  (journal.ndjson)     │
│  Signs & appends │      │  S3, GitHub Pages...  │
└─────────────────┘      └──────────┬───────────┘
                                    │ /refresh
                                    ▼
                         ┌──────────────────────┐
                         │  Cloudflare Worker    │
                         │  - XRPC API           │
                         │  - WebSocket firehose │
                         │  - DID documents      │
                         └──────────────────────┘
```

## Quick Start

### Prerequisites

- Node.js 19+
- Cloudflare account (for deployment)

### 1. Initialize

```bash
npm install
node cli/seal.js init did:web:example.com example.com
```

This generates a keypair and saves to `config.json` (local only, gitignored).

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

The worker starts at `http://localhost:8787`.

### 4. Test

```bash
npm test
```

## Deployment

### 1. Publish journal

Upload `journal.ndjson` to a static file host (S3, GitHub Pages, R2, etc.).

### 2. Configure worker

Edit `wrangler.toml`:

```toml
[vars]
OWNER_DID = "did:web:yourdomain.com"      # or did:plc:xxx
OWNER_HANDLE = "yourdomain.com"
OWNER_PUBLIC_KEY = ""                      # from init output
JOURNAL_URL = "https://your-host/journal.ndjson"
```

### 3. Set secrets

```bash
wrangler secret put PRIVATE_KEY            # from config.json
wrangler secret put OWNER_PUBLIC_KEY       # multibase from init
```

### 4. Deploy

```bash
npm run deploy
```

### 5. Refresh

Trigger the worker to reload journal from static host:

```bash
curl https://your-worker.workers.dev/refresh
```

## Endpoints

| Path | Description |
|------|-------------|
| `/` | Server info (DID, handle, journal stats) |
| `/.well-known/atproto-did` | Returns owner DID |
| `/.well-known/did.json` | DID document (did:web only) |
| `/xrpc/com.atproto.repo.getRecord` | Get a record |
| `/xrpc/com.atproto.repo.listRecords` | List records in collection |
| `/xrpc/com.atproto.identity.resolveHandle` | Resolve handle to DID |
| `/xrpc/com.atproto.sync.subscribeRepos` | WebSocket firehose |
| `/xrpc/com.atproto.sync.getLatestCommit` | Latest commit CID |
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

The worker supports two identity modes:

- **did:web**: `OWNER_DID=did:web:yourdomain.com` — DID document served at `/.well-known/did.json`
- **did:plc**: `OWNER_DID=did:plc:xxx` — `did.json` returns 404 (document served by plc.directory)

Both `/.well-known/atproto-did` and `/.well-known/did.json` return consistent identity.

## Security

- `config.json` contains your private key — never commit it
- `journal.ndjson` contains signed events — gitignored by default
- Worker reads keys from environment/secrets, not from files
- Journal chain is validated on load (CID integrity and prev links)

## Known Limitations

- **Firehose**: `#commit` events have empty `blocks` — consumers needing real CAR data won't work
- **Interactions**: Cron fetches likes/reposts but only logs them, no persistence yet
- **Write operations**: XRPC write endpoints return 501 — use CLI for all writes
- **Journal must be append-only**: Refresh assumes events are only appended, never reordered

## Project Status

This is a working prototype. Core read path (XRPC, firehose, DID documents) is functional. Write path (CLI signing, journal append) is functional. Tests pass.

Not yet suitable for production without:
- Persistent interaction storage
- Full CAR block support in firehose
- Comprehensive error handling
- Rate limiting

## License

MIT
