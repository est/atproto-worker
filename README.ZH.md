# atproto-worker

无状态的 AT Protocol 发布器，运行在 Cloudflare Workers 上。Journal 是一个签名的 append-only 日志（`journal.ndjson`），Worker 通过标准 atproto 端点对外发布。无数据库，无持久状态。

## 架构

```
┌──────────────────┐      ┌──────────────────────┐
│  本地 CLI        │─────▶│  Worker 静态资源     │
│  (cli/seal.js)   │      │  (public/journal)    │
│  签名并追加      │      └──────────┬───────────┘
└──────────────────┘                 │ /refresh 或 cron
                                    ▼
                        ┌───────────────────────┐
                        │  Cloudflare Worker    │
                        │  - XRPC API           │
                        │  - WebSocket firehose │
                        │  - DID 文档           │
                        │  - / 部署检查页       │
                        └───────────────────────┘
```

发帖流程：`seal.js post` 本地签名并追加到 `journal.ndjson` → 复制到
`public/journal.ndjson` → 部署。Worker 通过 XRPC 提供读取、通过 firehose
广播。无数据库、无持久状态、无需外部静态托管。

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

Worker 完全自包含：journal 作为静态资源（`public/journal.ndjson`）随 Worker 一起部署，无需外部静态托管。部署后访问 `https://<你的-worker>.<子域名>.workers.dev/` 可看到实时部署检查页，逐步引导完成所有配置。

### 1. 初始化身份（本地，一次）

```bash
node cli/seal.js init did:web:你的-worker.子域名.workers.dev 你的-worker.子域名.workers.dev
```

生成 secp256k1 密钥对，保存到 `config.json`（仅本地，已 gitignore）。公钥填入 `wrangler.toml`；私钥永不离开你的机器。

### 2. 配置 wrangler.toml

```toml
[assets]
directory = "./public"

[vars]
OWNER_DID = "did:web:你的-worker.子域名.workers.dev"
OWNER_HANDLE = "你的-worker.子域名.workers.dev"
OWNER_PUBLIC_KEY = "zQ3sh..."        # init 后从 config.json 获取
JOURNAL_URL = "https://你的-worker.子域名.workers.dev/journal.ndjson"
```

### 3. 创建 KV 命名空间

```bash
npx wrangler kv namespace create JOURNAL_KV
```

将返回的 ID 填入 `wrangler.toml` 的 `[[kv_namespaces]]`。

### 4. 发布第一条帖子

```bash
node cli/seal.js post "Hello from atproto-worker!"
cp journal.ndjson public/journal.ndjson
```

### 5. 部署

```bash
npm run deploy
```

### 6. 刷新

从 Worker 自己的静态资源重新加载 journal：

```bash
curl https://你的-worker.子域名.workers.dev/refresh
```

或等待 cron 自动触发（每 5 分钟）。`/` 页面的部署检查实时显示每一步的状态。

> **无需任何 secret。** Worker 只读取公钥。没有 `wrangler secret put
> PRIVATE_KEY` 这一步——私钥只存在于本地 `config.json`（ADR-005：仅本地签名）。

## 端点

| 路径 | 说明 |
|------|------|
| `/` | 部署检查页（实时配置状态）；`Accept: application/json` 返回服务器信息 |
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
| `/refresh` | 从 Worker 自身静态资源重新加载 journal |
| `/journal.ndjson` | journal 静态资源本身 |

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
- 根目录的 `journal.ndjson`（本地工作副本）已 gitignore；`public/journal.ndjson`
  中的签名事件可安全提交（Worker 加载时会验证签名）
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
