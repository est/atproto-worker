# atproto-worker

AT Protocol 发布器 / 轻量 PDS，运行在 Cloudflare Workers 上。历史上是完全静态的 append-only journal；**2026-11 M1 之后**，运行时写入走 Firehose DO 的 SQLite 活账本，静态 `journal.ndjson` 降级为 seed/备份。owner 用 CLI 或浏览器里的 P-256 私钥签名，Worker 永不持有私钥。

## M1：owner 自签 P-256 + 活账本（2026-11）

- **新账号默认 P-256**（`init --curve p256`）；现有 K-256 账号用 `rotate-key --curve p256` + `rotate-head` 轮换，历史不需要重签（协议只验 head commit）。
- **浏览器 owner console**：`/app/`，P-256 私钥只在浏览器（口令加密存储），读 `getRepo`、写 `appendEvent`；也可独立静态托管。
- **Worker 活账本**：Firehose DO SQLite（`events`/`heads`/`meta`），`POST /xrpc/com.atproto.worker.appendEvent` 验签 + head CAS + 广播；`GET /xrpc/com.atproto.worker.snapshot` 导出 NDJSON。
- **CLI**：`push`/`pull` 同步本地与活账本；`rotate-head` 用新钥重签当前 head（不改内容）。
- 决策：`docs/ADR/040.arch.owner-signed-p256-repo.md`；完整设计：`docs/phase6.md`。
- 规则：**ledger 上线后，运行时写入走 append；静态 journal 只做 seed/备份**。官方 bsky.app 仍需要完整 PDS 写路径（M3）。

## M3（可选）：官方 bsky.app 客户端兼容

M1 的 owner-signed 账号不能登录官方客户端（标准写端点收记录，不收预签名 commit）。M3 增加第二种 **worker-signed** 模式：Worker 持 repo key、服务端签名，官方客户端可用。每账号一个 mode，互斥：

- `owner-signed`（M1）：私钥在 owner 浏览器/CLI；`appendEvent`；官方客户端不可用。
- `worker-signed`（M3）：私钥在 Worker（P-256，当前存 DO）；标准 `createRecord/applyWrites/uploadBlob`；官方客户端可用；owner 通过 did.json/轮换撤销。

### 1. 配置 secret（生产）

```bash
npx wrangler secret put JWT_SECRET
npx wrangler secret put BOOTSTRAP_TOKEN
```

本地开发：`cp .dev.vars.example .dev.vars`。

### 2. Bootstrap 一个 worker-signed 账号

```bash
curl -X POST https://<你的-worker>/xrpc/com.atproto.worker.bootstrapAccount \
  -H "Authorization: Bearer $BOOTSTRAP_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"did":"did:web:you.example","handle":"you.example","password":"a-strong-password","pdsEndpoint":"https://<你的-worker>"}'
```

返回 `{ did, handle, publicKeyMultibase, didDoc }`；把 `didDoc` 发布到 `https://you.example/.well-known/did.json`。`bootstrapAccount` 幂等，默认不重置密码。

### 3. 登录 / 写

```bash
curl -X POST https://<你的-worker>/xrpc/com.atproto.server.createSession \
  -H 'Content-Type: application/json' \
  -d '{"identifier":"you.example","password":"a-strong-password"}'
# -> accessJwt / refreshJwt

curl -X POST https://<你的-worker>/xrpc/com.atproto.repo.createRecord \
  -H "Authorization: Bearer $ACCESS_JWT" -H 'Content-Type: application/json' \
  -d '{"repo":"did:web:you.example","collection":"app.bsky.feed.post","record":{"$type":"app.bsky.feed.post","text":"hello","createdAt":"..."}}'
```

### 4. Blobs（头像/图片）

`com.atproto.repo.uploadBlob`（5 MB 上限）→ 返回 blob ref；`getBlob`/`listBlobs` 可读。生产建议启用 R2：

```toml
[[r2_buckets]]
binding = "BLOBS"
bucket_name = "atproto-blobs"
```

没有 R2 时用 DO SQLite 小文件 fallback（2 MB 行上限）。

> M3 第一刀只做单账号 worker-signed；现有主账号仍是 M1 owner-signed。要切换主账号，需要显式 mode 迁移 + did.json 换钥（phase7 §5）。完整设计与后续计划见 `docs/phase7.md` / `docs/ADR/041`。

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

发帖流程（M1）：浏览器或 CLI 本地构造并签名 commit → POST `appendEvent` →
Firehose DO 活账本存储并广播。静态 `journal.ndjson` 是新部署的 seed/备份。
私钥永不进入 Worker。

## 快速开始

### 前置条件

- Node.js 19+
- Cloudflare 账号

### 1. 安装并初始化

```bash
npm install
node cli/seal.js init did:web:yourdomain.com yourdomain.com
```

生成 P-256 密钥对（`--curve k256` 可显式选旧曲线），保存到 `config.json`（仅本地使用，已 gitignore）。

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
| `/xrpc/com.atproto.worker.appendEvent` | **owner 签名写入**（P-256 验签 + head CAS） |
| `/xrpc/com.atproto.worker.snapshot` | 导出活账本 NDJSON（`?after=&limit=`） |
| `/xrpc/com.atproto.worker.bootstrapAccount` | M3 owner-only：创建 worker-signed 账号 + repo key（`BOOTSTRAP_TOKEN`） |
| `/xrpc/com.atproto.worker.accountDidDoc` | 返回某账号应发布的 did.json |
| `/xrpc/com.atproto.server.createSession` / `getSession` / `refreshSession` / `deleteSession` | M3 会话 |
| `/xrpc/com.atproto.repo.createRecord` / `putRecord` / `deleteRecord` / `applyWrites` | M3 服务端签名写端点 |
| `/xrpc/com.atproto.repo.uploadBlob` | M3 blob 上传（5 MB；R2 或 DO fallback） |
| `/xrpc/com.atproto.sync.listBlobs` | M3 列出 blob CID |
| `/xrpc/_health` | 健康检查 |
| `/refresh` | seed/刷新并广播 + `requestCrawl` |
| `/journal.ndjson` | 静态 seed/备份（fresh deploy 时导入活账本） |
| `/app/` | 静态 owner console（浏览器 P-256 签名） |

## CLI 命令

```bash
node cli/seal.js init [did] [handle] [--curve p256|k256]   # 生成密钥对（默认 p256）
node cli/seal.js rotate-key [--curve p256|k256]            # 轮换密钥 + 重写 did.json
node cli/seal.js rotate-head                               # 用新钥重签当前 head（不改内容）
node cli/seal.js post "text"                               # 发帖（本地签名、追加 journal）
node cli/seal.js like <at-uri> <cid>                       # 点赞
node cli/seal.js repost <at-uri> <cid>                     # 转发
node cli/seal.js follow <did>                              # 关注
node cli/seal.js validate                                  # 验证 journal（按事件 signingKey/previousPublicKeys）
node cli/seal.js list                                      # 列出所有记录
node cli/seal.js push [--remote URL] [--account id]        # 把本地已签事件推到活账本
node cli/seal.js pull [--remote URL] [--account id]        # 拉活账本 + 重建 .repo-state
```

Web UI 构建与测试：

```bash
npm run build:app   # esbuild -> public/app/app.js
npm run test:ui     # Playwright + Edge 冒烟测试
```

## 身份模型

- **did:web**：`OWNER_DID=did:web:yourdomain.com` — DID 文档在 `/.well-known/did.json`
- **did:plc**：`OWNER_DID=did:plc:xxx` — `did.json` 返回 404（文档在 plc.directory）

`/.well-known/atproto-did` 和 `/.well-known/did.json` 返回一致的身份信息。

## 安全

- `config.json` 包含私钥 — 绝不提交到 git
- 根目录的 `journal.ndjson`（本地工作副本）已 gitignore；`public/journal.ndjson`
  中的签名事件可安全提交（Worker 加载时会验证签名）
- Worker 不持有也不使用私钥（签名在 CLI 或浏览器完成）
- 读路径验证链完整性（CID 和 prev 链），**不验签**（ADR-030 信任边界）
- `appendEvent` 写路径**必须验 P-256 签名 + low-S + head/CAR**（ADR-040）
- 新账号默认 P-256（WebCrypto 原生）；K-256 旧事件只读兼容
- 浏览器 key 用 PBKDF2 + AES-GCM 口令加密存 localStorage；页面的 CSP/独立托管建议见 `docs/phase6.md` §6.8

## 已知限制

- **不是完整 PDS**：官方 bsky.app 仍不能登录发帖；需要 M3（Worker 持 repo key + sessions/JWT + 服务端签名）
- **Blobs**：浏览器上传图片/头像尚未实现（现有静态 blob 发布仍可用）
- **完整 MST 路径验证**：append 只校验 root/CAR 存在性，未证明 record leaf 可达
- **限流/自注册**：append 目前只允许已 hosted 的 DID，无 per-DID 写限流
- **轮换重放边界**：relay 若从 -1 重放旧 K-256 事件，可能因当前 did.json 已是 P-256 而验签失败（正常 cursor 不会）
- 静态 journal 只做 seed/备份；ledger 上线后不要再用"本地 append + deploy"作为运行时写路径

## 项目状态

M1 可用：读路径（XRPC、firehose、DID 文档）、写路径（CLI/浏览器 P-256 签名 + DO 活账本）、静态 UI、CLI push/pull 均已实现。`npm test` 与 `npm run test:ui` 通过；官方 `@atproto/repo.verifyRepoCar` 对 P-256 commit/CAR 验证通过。主账号已轮换到 P-256，待 `wrangler login` 后部署。

## 许可证

MIT
