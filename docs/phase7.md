# Phase 7 / M3：官方 bsky.app 客户端兼容（完整 PDS 写路径 + hybrid key custody）

> 规划稿（未动代码）。承接 `docs/phase6.md` 的 M1（owner 自签 + Worker 活账本/纯通道）。
> M1 解决"自有 Web 客户端"；M3 解决"官方 bsky.app / 任何标准客户端登录发帖"。
> 核心结论先说：**M3 必须让 Worker 持有 repo 签名私钥**；owner 的控制权从"每个 commit 签名"上移到"rotation/身份控制"。

---

## 0. 为什么 M1 不能直接兼容官方客户端

这是协议边界，不是实现偷懒：

- `com.atproto.repo.createRecord` / `putRecord` / `deleteRecord` / `applyWrites` 的输入是**记录**（record），不是预签名 commit。官方客户端不会、也不应该把 repo 私钥交出来。
- 标准 PDS 在收到记录后，由**服务端**构造 MST + commit v3、用 repo key 签名、更新账本、发 firehose。
- M1 的 `appendEvent` 是自定义端点，接收预签名事件；官方客户端不会调它。

所以：

| | M1（已落地） | M3（本文件） |
|---|---|---|
| 谁签 commit | owner 浏览器/CLI | **Worker（服务端 repo key）** |
| 官方 bsky.app | ❌ | ✅ |
| 自有 Web UI | ✅（本地签名） | ✅（可改为 session + 服务端签名） |
| Worker 能伪造 | ❌ | **✅（轮换前）** |
| owner 控制点 | 每个 commit 的私钥 | **rotation key / did.json 控制权** |
| 与 M1 的 repo key | owner 的 P-256 | **Worker 的 repo key（同一 `#atproto` 槽位）** |

**关键设计事实**：atproto 的 DID 文档只有一个 `#atproto` repo 签名 key。M1 和 M3 不能对同一个账号同时成立——要么 owner 持钥（官方客户端不可用），要么 Worker 持钥（官方客户端可用）。每账号必须选一个 `mode`。

---

## 1. 目标能力（验收口径）

以"普通 bsky 用户"的完整一天为准：

- 在 bsky.app / 任何标准客户端用 **handle + 密码**登录；
- 刷自己的时间线（读路径已有）；
- 发文字帖、回复、引用、删除；
- 点赞、转发、关注；
- 编辑资料（displayName/description/头像/横幅）；
- 上传图片（blob）并出现在帖子/资料页；
- 通知/互动由 appview 提供（PDS 只需正确写记录）；
- session 过期能 refresh，能 logout；
- 被 relay 收录、被 appview 索引，bsky.app 可见；
- owner 能**撤销 Worker**：轮换 repo key 后，Worker 再也签不出被网络接受的 commit。

非目标（可后续）：DMs（chat.bsky）、列表/信息流/启动包、多租户公开注册、完整 PLC 托管。

---

## 2. 目标架构

```
bsky.app / 标准客户端
        │  createSession (handle+password) -> accessJwt/refreshJwt
        │  createRecord / applyWrites / uploadBlob (Bearer JWT)
        ▼
┌─────────────────────────────────────────────┐
│ Cloudflare Worker (PDS)                     │
│  - session/password/JWT                     │
│  - 标准 XRPC 写端点                         │
│  - 服务端 repo core: MST/commit/CAR + 签名  │
│  - 鉴权 / 限流 / 校验                       │
└──────────────┬──────────────────────────────┘
               │ 复用 M1 的 ledger/append/read/firehose
               ▼
┌─────────────────────────────────────────────┐
│ Firehose DO SQLite                          │
│  events / heads / sessions / accounts       │
│  repo_keys / blobs meta                     │
└──────────────┬──────────────────────────────┘
               │ subscribeRepos / requestCrawl
               ▼
          relay / appview
```

写路径复用 M1 的账本与广播；新增的是"记录 → 服务端构造并签名 commit"这一段。

---

## 3. 认证与会话（最大新增面）

### 3.1 端点

| XRPC | 作用 |
|---|---|
| `com.atproto.server.createSession` | handle/email + password → `{accessJwt, refreshJwt, handle, did, didDoc?, active}` |
| `com.atproto.server.getSession` | Bearer accessJwt → 当前会话 |
| `com.atproto.server.refreshSession` | Bearer refreshJwt → 新 access/refresh |
| `com.atproto.server.deleteSession` | 注销当前 refresh token |

参考实现：`thirdparty/atproto/packages/pds/src/api/com/atproto/server/{createSession,getSession,refreshSession,deleteSession}.ts`。

### 3.2 密码

- 存储：`accounts(did, handle, password_hash, password_salt, kdf, iterations, created_at, disabled)`。
- KDF：Workers 无原生 Argon2；优先 **PBKDF2-SHA256**（WebCrypto，`deriveBits`），迭代数 ≥ 200k（按 CPU 预算调），或引入 WASM Argon2（体积/CPU 成本要评估）。密码比较用常量时间。
- 不存明文；日志/错误里不出现密码。

### 3.3 JWT

- access JWT：短 TTL（如 2h），claims 至少 `{iss: did, aud: did, sub: did, iat, exp, jti, scope}`；`scope` 用 `com.atproto.access`。
- refresh JWT：长 TTL（如 90d）+ 服务端可撤销（`sessions(jti, did, refresh_hash, expires_at, revoked_at)`）。
- 签名 key：Worker secret（如 `JWT_SECRET` / P-256/EdDSA key），轮换要能接受旧 key 验证一个过渡期。
- Worker 侧 JWT 验签中间件：`Authorization: Bearer <accessJwt>` → `did`；所有写端点校验 `did` 与会话一致。
- 注意：bsky.app 访问的是 AppView，AppView 会把 `com.atproto.*` 代理到 PDS；PDS 侧必须返回 AppView 期望的 JWT/错误形状。

### 3.4 安全

- 登录/refresh 限流（按 IP + handle），防爆破；失败不泄露"用户是否存在"。
- session 撤销：logout、改密、轮换 repo key 时撤销全部 refresh。
- CORS：标准客户端的 XRPC 已能工作；不要让 `*` + credentials 组合出错。
- CSRF：Bearer token 不在 cookie 里，风险较低；如果未来用 cookie，需要 CSRF。

---

## 4. 服务端 repo core 与写端点

### 4.1 复用 M1 的代码

M1 已经有浏览器/Worker 安全的：

- `src/repo-core.js`（MST + commit + CAR + `fromCar`/`applyWrite`/`buildCar`）
- `src/commit.js`（commit v3 编码/CID）
- `src/keys.js`（P-256 签名/验签、low-S、multikey）
- `src/append.js`（append 校验）
- `src/firehose.js`（ledger/head CAS/广播）
- `src/journal.js`（读模型）

M3 只需要在 Worker 侧：

1. 从 ledger 加载当前 head + blockstore（或复用 `Repo.fromCar`）；
2. 对 `createRecord/putRecord/deleteRecord/applyWrites` 应用写入；
3. 用 **Worker 持有的 repo key** 签名；
4. 走 M1 的 append/ledger/broadcast。

### 4.2 端点

| XRPC | 行为 |
|---|---|
| `com.atproto.repo.createRecord` | 校验 record/collection/rkey/`swapCommit` → applyWrite(create) → 返回 `{uri,cid,commit:{cid,rev},validationStatus}` |
| `com.atproto.repo.putRecord` | update/create + `swapRecord`/`swapCommit` 并发保护 |
| `com.atproto.repo.deleteRecord` | applyWrite(delete) + `swapRecord` |
| `com.atproto.repo.applyWrites` | 批量 create/update/delete，一次 commit；返回逐条结果 + commit |
| `com.atproto.repo.uploadBlob` | 存 blob，返回 `{blob: {$type:'blob', ref:{$link:cid}, mimeType, size}}` |
| `com.atproto.repo.importRepo` | 可选：整包 CAR 导入（迁移用） |
| `com.atproto.sync.getBlocks` | 可选：按 CID 返回块 |
| `com.atproto.sync.listBlobs` | 可选：列出 blob |

标准写端点与 M1 的 `appendEvent` **共用同一个 ledger**；区别只是 commit 由谁签。

### 4.3 并发与幂等

- `swapCommit`/`swapRecord` 映射到 M1 的 head CAS；不匹配返回 `InvalidSwap`。
- 一次 applyWrites 只产生一个 commit；失败不落半条链。
- 重试：同一请求幂等（客户端重试不应生成两个 commit）；用请求级 idempotency key 或 `swapCommit` 约束。

### 4.4 服务端 repo key

- 存储选项：
  1. **Worker secret**（`REPO_PRIVATE_KEY`，P-256 PKCS8 或 K-256）：最小实现，部署时注入；轮换要重新 deploy/secret。
  2. **DO storage 加密存储**：运行时可轮换、可按账号；但 Worker 被攻破时同样可解密（除非用外部 KMS）。
  3. 外部 KMS/HSM 签名服务：最强，但增加可用性依赖；Workers 无原生 KMS 签名，需自建。
- 推荐 M3 首版：**Worker secret + 单账号**；多账号再考虑 DO 加密存储。
- 算法：P-256（WebCrypto 原生、无依赖）或 K-256（与生态默认一致，但需要 noble）。M1 已经全用 P-256，建议 M3 继续 P-256，DID 文档用 `Multikey zDna...`。

---

## 5. Key custody 与撤销（M3 的核心权衡）

### 5.1 三种形态

| 形态 | repo key | owner 控制 | 官方客户端 | 复杂度 |
|---|---|---|---|---|
| **M3a：Worker key + did:web** | Worker secret | 改 did.json（换钥） | ✅ | 中 |
| **M3b：Worker key + did:plc rotation key** | Worker secret | PLC rotation op | ✅ | 高 |
| **M3c：外部 KMS/HSM** | 外部签名服务 | KMS 策略 | ✅ | 很高 |

推荐先做 **M3a**：项目本来就是 did:web（ADR-009/038），owner 控制域名/静态托管，把 `public/.well-known/did.json` 放在**独立于 Worker 的静态托管**（或至少能在 Worker 之外改），就能在 Worker 作恶时换掉 `#atproto` key，使 Worker 签出的新 commit 被 relay/appview 拒绝。

### 5.2 撤销语义

- **轮换前**：Worker 可以伪造该账号的任何 commit（包括删除/改写历史 head）。这是 M3 的固有权衡。
- **轮换后**：DID 文档的 `#atproto` 换成新 key；relay/appview 只接受新 key 的 head 签名；Worker 旧 key 失效。
- **历史**：协议只验 head（M1 已验证），所以轮换不需要重签历史；但 relay 若从 -1 重放旧事件可能验签失败（已知边界）。
- **协调**：发布新 did.json 与"用新 key 签一个新 head"要尽量同窗口完成，避免中间态。M3a 可以把 did.json 放外部托管，Worker 只负责 repo；owner 先改 did.json，再触发 Worker 用新 key re-sign head（或反过来，接受短暂窗口）。

### 5.3 M1 与 M3 的共存

- **每账号一个 mode**：`mode: 'owner-signed' | 'worker-signed'`。
- `owner-signed`（M1）：DID 文档 key = owner 浏览器/CLI 的 key；`appendEvent` 可用；官方客户端不可用。
- `worker-signed`（M3）：DID 文档 key = Worker 的 repo key；标准写端点可用；`appendEvent` 应拒绝 owner 用另一把 key 写（否则 head 签名与 DID 文档不匹配）。
- 切换 mode = 轮换 key + 新 head；建议只在明确需要官方客户端时做。

---

## 6. Blobs（图片/头像/横幅）

- `uploadBlob`：接收二进制 + Content-Type；校验大小/类型；计算 raw-codec CID（`computeBlobCid`）；存储。
- 存储选型：
  - **R2**：成本低、适合图片/视频；引入一个新绑定；和"零依赖"目标有张力（phase5 提过成本顾虑）。
  - **DO SQLite / KV**：小文件可以，但大文件/流量不合适；DO 有存储/请求限制。
  - **静态 ASSETS**：只读，适合预置；不能运行时上传。
- 推荐：**R2**（单 bucket，按 `did/cid` 命名），`getBlob` 先查 R2 再查 ASSETS；图片代理/CDN 用 R2 自定义域或 Worker 流式返回。
- 资料页：`app.bsky.actor.profile` 的 `avatar`/`banner` 是 blob ref；需要 `uploadBlob` + profile 记录。
- 图片处理（缩略图/EXIF 剥离/大小限制）可选；先做原图 + 大小上限。

---

## 7. 身份、账号与多账号

- 主账号：已有 did:web + handle；M3a 下把 `#atproto` 换成 Worker 的 repo key。
- 新账号：`createAccount` / `reserveSigningKey` 可选；个人 PDS 首版可以只支持"预置账号"，不做公开注册。
- 多账号：M1 的 ledger 已按 did 分组；M3 需要 `accounts` 表 + 每账号 repo key + 每账号 session。官方客户端登录时用 handle 定位账号。
- `did:plc`：如果未来要 M3b，需要 PLC 目录、rotation keys、operation 签名/提交；这是独立的大工程。M3a 先不引入。

---

## 8. 数据模型（schema v3）

在 M1 的 `events/heads/meta` 基础上新增：

```sql
accounts(
  did TEXT PRIMARY KEY,
  handle TEXT UNIQUE NOT NULL,
  mode TEXT NOT NULL,              -- 'owner-signed' | 'worker-signed'
  password_hash TEXT,              -- worker-signed 才需要
  password_salt TEXT,
  kdf TEXT, iterations INTEGER,
  repo_key_id TEXT,                -- 指向 repo_keys
  disabled INTEGER DEFAULT 0,
  created_at TEXT
)

repo_keys(
  id TEXT PRIMARY KEY,
  did TEXT NOT NULL,
  curve TEXT NOT NULL,             -- 'p256' | 'k256'
  public_key_multibase TEXT NOT NULL,
  private_key_ref TEXT,            -- secret name / encrypted blob
  created_at TEXT,
  retired_at TEXT
)

sessions(
  jti TEXT PRIMARY KEY,
  did TEXT NOT NULL,
  refresh_hash TEXT NOT NULL,
  access_expires_at TEXT,
  refresh_expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT
)

blobs(
  cid TEXT PRIMARY KEY,
  did TEXT NOT NULL,
  mime_type TEXT,
  size INTEGER,
  created_at TEXT
)
```

- `events` 行仍由 M1 的 append 逻辑写入；M3 只是在 Worker 内生成事件。
- `schema_version = 3`；迁移工具从 v2 升 v3（新增表，不改 events/heads）。

---

## 9. 分阶段实施与工作量

### P0：协议/参考实现核对（1 天）

- 对照 `thirdparty/atproto/packages/pds/src/api/com/atproto/{server,repo}/` 确认：
  - createSession 的请求/响应形状、错误码；
  - JWT claims/scope、refresh 语义；
  - createRecord/applyWrites 的 `swapCommit`/`swapRecord`；
  - uploadBlob 的 blob ref 编码；
  - appview 代理对 PDS 的具体要求。

### P1：sessions/JWT/password（3-5 天）

- accounts/sessions 表；PBKDF2；JWT 签发/验证/refresh/revoke；限流；测试。
- 验收：curl `createSession` → 拿 access/refresh；`getSession`；`refreshSession`；`deleteSession`。

### P2：服务端 repo core + 写端点（5-8 天）

- Worker 侧加载 head/blockstore，applyWrite，P-256 签名，走 M1 ledger。
- createRecord/putRecord/deleteRecord/applyWrites；swap 保护；错误形状。
- 验收：用 curl 或标准客户端 SDK 发一条 post，`getRecord`/`getRepo`/firehose 立即可见；relay 收录。

### P3：blobs（2-4 天，取决于 R2）

- uploadBlob/getBlob/listBlobs；R2 绑定；profile avatar/banner；大小/类型限制。
- 验收：上传图片 → 发带图帖 → bsky.app 显示。

### P4：官方客户端 E2E（2-3 天 + 调试）

- 用 did:web handle + 密码登录 bsky.app；发帖/点赞/转发/关注/删除/改资料；refresh/logout。
- relay/appview 收录；必要时调 AppView 代理行为/错误码。
- 这是最终验收，可能暴露协议细节（JWT audience、scope、didDoc 形状、blob 代理等）。

### P5：轮换/撤销/备份（2-3 天）

- Worker repo key 轮换；did.json 外部托管流程；owner 撤销 Worker 的演练；全量导出。
- 验收：轮换后旧 Worker key 签的 commit 被 relay 拒绝；新 head 被接受。

**M3 首版（单账号、P-256、R2、did:web）约 2-3 周**；多账号/PLC/KMS 另算。

---

## 10. 风险与开放问题

| 风险 | 影响 | 缓解 |
|---|---|---|
| Worker 持 repo key | Worker 被攻破可伪造 | 明确接受；did.json 外部托管 + 快速轮换；M3c 可选 |
| 密码/KDF CPU | Workers CPU/成本 | PBKDF2 迭代调优；登录限流；必要时 WASM Argon2 |
| JWT secret 管理 | 会话伪造 | secret 轮换 + 旧 key 过渡验证；短 TTL |
| R2 成本 | 图片流量 | 单 bucket + 大小上限 + 可选 CDN |
| 官方客户端兼容细节 | 登录/发帖失败 | P0 对照参考实现；真实 bsky.app E2E |
| did:web 轮换窗口 | 短暂拒收 | 先改 did.json 再 re-sign head；重试/监控 |
| M1/M3 mode 混用 | head 签名与 DID 文档不匹配 | 每账号显式 mode；appendEvent 在 worker-signed 模式下拒绝 owner key |
| 历史重放 | relay 从 -1 验旧 K-256 失败 | 已知边界；必要时全量 re-sign 或接受 |
| 滥用/公开注册 | 免费存储/签名 | 首版不开放注册；按 DID/IP 限流 |

**需要 owner 拍板**：

1. M3 只服务现有主账号，还是支持多账号/新账号注册？
2. repo key 放 **Worker secret**（简单）还是 DO 加密存储/KMS（更强轮换）？
3. 身份用 **did:web + 外部托管 did.json**（推荐，简单）还是上 **did:plc rotation key**（强撤销，工程大）？
4. R2 是否可接受？（图片/视频的存储/CDN）
5. M1 的 `appendEvent` 保留为 per-account 模式，还是 M3 账号完全禁用？

---

## 11. 与已有 ADR 的关系

| ADR | 影响 |
|---|---|
| 005 私钥仅本地 | **M3 会推翻**（Worker 持 repo key）；M1 账号仍保留 005 |
| 014 CLI 唯一写 | M3 增加标准 XRPC 写端点；M1 的 owner-signed 模式仍可保留 |
| 018 k256 | M3 建议继续 P-256（WebCrypto 原生） |
| 030 不验签 | 标准写端点在 Worker 内构造并签名；读仍不验签 |
| 033 schema | 升 v3：accounts/sessions/repo_keys/blobs |
| 035 完整 PDS | 本文件就是 035 的实施版（M3a 优先） |
| 040 owner-signed/M1 | M3 是同一账本上的第二种 mode；每账号二选一 |

---

## 12. 参考

- `thirdparty/atproto/packages/pds/src/api/com/atproto/server/`（createSession/getSession/refreshSession/deleteSession）
- `thirdparty/atproto/packages/pds/src/api/com/atproto/repo/`（createRecord/putRecord/deleteRecord/applyWrites/uploadBlob/importRepo）
- `thirdparty/atproto/packages/pds/src/actor-store/`（repo key、password、session 存储）
- `thirdparty/atproto/lexicons/com/atproto/server/{createSession,getSession,refreshSession,deleteSession}.json`
- `thirdparty/atproto/lexicons/com/atproto/repo/{createRecord,putRecord,deleteRecord,applyWrites,uploadBlob}.json`
- `docs/ADR/035`、`docs/ADR/040`、`docs/phase5.md`、`docs/phase6.md`
- 本项目的 M1 账本/读模型/firehose：`src/firehose.js`、`src/journal.js`、`src/repo-core.js`、`src/append.js`
