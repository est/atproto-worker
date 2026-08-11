# atproto-worker

无状态的 AT Protocol 发布器，运行在 Cloudflare Workers 上。Journal 是一个签名的 append-only 日志（`journal.ndjson`），Worker 通过标准 atproto 端点对外发布。无数据库，无持久状态。

## 架构

```
┌──────────────────┐      ┌──────────────────────┐
│  本地 CLI        │      │  静态托管             │
│  (cli/seal.js)   │─────▶│  (journal.ndjson)    │
│  签名并追加       │      │  S3 / R2 / Pages     │
└──────────────────┘      └──────────┬───────────┘
                                     │ /refresh 或 cron
                                     ▼
                         ┌───────────────────────┐
                         │  Cloudflare Worker    │
                         │  - XRPC API           │
                         │  - WebSocket firehose │
                         │  - DID 文档           │
                         └───────────────────────┘
```

## 快速开始

### 前置条件

- Node.js 19+
- Cloudflare 账号

### 1. 安装并初始化

```bash
npm install
node cli/seal.js init did:web:yourdomain.com yourdomain.com
```

生成 secp256k1 密钥对，保存到 `config.json`（仅本地使用，已 gitignore）。

### 2. 创建内容

```bash
node cli/seal.js post "Hello from atproto-worker!"
node cli/seal.js like at://did:plc:xxx/app.bsky.feed.post/yyy bafy...
node cli/seal.js follow did:plc:xxx
```

### 3. 本地运行

```bash
npm run dev:local
```

Worker 启动在 `http://localhost:8787`。

### 4. 测试

```bash
npm test
```

## 部署

### 1. 创建 KV 命名空间

```bash
npx wrangler kv namespace create JOURNAL_KV
```

将返回的 ID 填入 `wrangler.toml`。

### 2. 发布 journal

将 `journal.ndjson` 上传到静态托管（S3、GitHub Pages、R2 等）。

### 3. 配置 Worker

编辑 `wrangler.toml`：

```toml
[vars]
OWNER_DID = "did:web:yourdomain.com"      # 或 did:plc:xxx
OWNER_HANDLE = "yourdomain.com"
OWNER_PUBLIC_KEY = "zQ3sh..."             # init 后从 config.json 获取
JOURNAL_URL = "https://your-host/journal.ndjson"
```

### 4. 设置密钥

```bash
wrangler secret put PRIVATE_KEY            # config.json 中的 hex 私钥
```

### 5. 部署

```bash
npm run deploy
```

### 6. 刷新

从静态托管重新加载 journal：

```bash
curl https://your-worker.workers.dev/refresh
```

或等待 cron 自动触发（每 5 分钟）。

## 端点

| 路径 | 说明 |
|------|------|
| `/` | 服务器信息（DID、handle、journal 统计） |
| `/.well-known/atproto-did` | 返回 owner DID |
| `/.well-known/did.json` | DID 文档（仅 did:web） |
| `/xrpc/com.atproto.repo.getRecord` | 获取单条记录 |
| `/xrpc/com.atproto.repo.listRecords` | 列出集合中的记录 |
| `/xrpc/com.atproto.sync.subscribeRepos` | WebSocket firehose |
| `/xrpc/com.atproto.sync.getLatestCommit` | 最新 commit CID 和 rev |
| `/xrpc/com.atproto.sync.listRepos` | 列出 repos |
| `/xrpc/com.atproto.server.describeServer` | 服务器描述 |
| `/xrpc/com.atproto.identity.resolveHandle` | Handle 解析为 DID |
| `/xrpc/_health` | 健康检查 |
| `/refresh` | 从静态托管重新加载 journal |

## CLI 命令

```bash
node cli/seal.js init [did] [handle]     # 生成密钥对
node cli/seal.js rotate-key              # 轮换密钥
node cli/seal.js post "text"             # 发帖
node cli/seal.js like <at-uri> <cid>     # 点赞
node cli/seal.js repost <at-uri> <cid>   # 转发
node cli/seal.js follow <did>            # 关注
node cli/seal.js validate                # 验证 journal 完整性
node cli/seal.js list                    # 列出所有记录
```

## 身份模型

- **did:web**：`OWNER_DID=did:web:yourdomain.com` — DID 文档在 `/.well-known/did.json`
- **did:plc**：`OWNER_DID=did:plc:xxx` — `did.json` 返回 404（文档在 plc.directory）

`/.well-known/atproto-did` 和 `/.well-known/did.json` 返回一致的身份信息。

## 安全

- `config.json` 包含私钥 — 绝不提交到 git
- `journal.ndjson` 包含签名事件 — 默认已 gitignore
- Worker 不持有也不使用私钥（签名仅在 CLI 完成）
- Journal 加载时验证链完整性（CID 和 prev 链）
- 私钥使用 secp256k1 (k256)，与 atproto 默认一致

## 已知限制

- **Firehose**：`#commit` 事件的 `blocks` 为空 — 需要完整 CAR 数据的消费者无法使用
- **Interactions**：Cron 抓取 likes/reposts 但仅记录日志，未持久化
- **写操作**：XRPC 写端点返回 501 — 使用 CLI 进行所有写操作
- **Journal 必须 append-only**：Refresh 假设事件只追加、不重排

## 项目状态

可用原型。核心读路径（XRPC、firehose、DID 文档）和写路径（CLI 签名、journal 追加）均已实现。测试通过，包括 atproto 互操作测试（CID/CBOR 编码、handle/DID 语法）。

## 许可证

MIT
