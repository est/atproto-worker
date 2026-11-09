# 重大发现：P-256 + WebCrypto = owner 自签 repo，Worker 退化为纯通道

> 讨论稿（plan mode，未动代码）。承接 `docs/phase5.md`，但结论和优先级需要重写。
> 核心：WebCrypto 原生支持 P-256 ECDSA；atproto 原生支持 P-256 repo 签名密钥。
> 于是"浏览器构造并签名 commit、Worker 只存/只转发"在协议上成立，且不需要私钥上 Worker。

---

## 0. 结论先行

1. **技术上成立**：P-256 是 atproto 的一等公民，不是补丁。签名格式、multikey、DID 文档、relay/appview 验签路径都支持。浏览器 WebCrypto 可以直接完成 commit 签名。
2. **它解决的是"自有 Web 客户端"**，不是"官方 bsky.app 登录发帖"。协议的标准写端点（`createRecord`/`applyWrites`）接收的是**记录**，不是预签名 commit；官方客户端不会把 repo 私钥交出来。要让 bsky.app 能用，Worker 仍然必须持有 repo key 并服务端签名（phase5 的方案 A / 本文件的 M2/M3）。
3. **它不消除"可变账本"**。浏览器能签名 ≠ Worker 能立即读到新数据。静态 `journal.ndjson` 仍然不可写；一旦允许网络写入，就需要一个可追加的活账本（DO SQLite 是最自然的落点）。变化的是：**账本里的数据由 owner 签名，Worker 不再需要私钥**。
4. **它让 ADR-005 完整保留**：私钥在 owner 的浏览器/硬件里，Worker 永不签名、永不持有私有材料。ADR-014（CLI 唯一写路径）被放宽为"owner 签名是唯一写路径，CLI 和浏览器都是签名端"。ADR-030（Worker 不验签）只对**读**继续成立；**写入口必须验签**，而 P-256 让这件事在 Worker 上免费（`crypto.subtle.verify`）。
5. **推荐路线**：先做 M1（owner 自签 + Worker 活账本/纯通道），把 M2/M3（官方客户端兼容）作为可选第二阶段。M1 已足够支撑"一个静态页面读写自己的 repo"，并且是 M2/M3 的地基。

一句话：**这个发现把 phase5 的 A 拆成了 A1（自有客户端，私钥不上 Worker，可行且优雅）和 A2（官方客户端，私钥必须上 Worker，另算）。**

### 状态更新（2026-11-09）

- **决策已拍板**：先做 **M1**，之后再做 M3；现有主账号**现在轮换到 P-256**。
- **Spike 已通过**（`.tmp/p256-spike/REPORT.md`）：
  - Node 22 + Edge 157 的 WebCrypto P-256 签出的 64 字节 low-S 签名，被官方 `@atproto/crypto@0.5.7` 接受；
  - 用现有 `src/shared.js` + `cli/mst.js` 构造的 commit/CAR，被官方 `@atproto/repo@0.11.4` 的 `verifyRepoCar()` 接受（DID、签名、MST、record leaf 全过）；
  - high-S 被官方拒绝；DER 被拒绝；压缩公钥用 BigInt 解压到 65 字节的路径验证通过。
- **实现地基已加入**：`src/keys.js`（P-256/multikey/low-S/解压）、`src/commit.js`（共享 commit v3）、`src/shared.js`（`sha256`/`readCarFile`/`decodeVarint`/`nextTID`/`bytesToCid`）。
- 下一步按 §8 的 Phase 0/1/2 并行推进；Phase 3 的 UI 随后。

### 实施状态（2026-11-09 晚）

**已完成**

- Phase 0：CLI 双曲线（k256 兼容 + p256 默认）、`init --curve p256`、`rotate-key`、`rotate-head`、per-event `signingKey`/`previousPublicKeys` 校验；DID 文档参数化（P-256 用 `Multikey` + `zDna...`，移除硬编码 K-256 fallback）。
- Phase 1：`src/repo-core.js`（浏览器/Worker 安全的 MST + commit + CAR；`fromCar`/`applyWrite`/`buildCar`/`buildFullCar`）；`cli/sha.js` 改为 WebCrypto；官方 `@atproto/repo.verifyRepoCar` 对 create/update/delete 增量与全量 CAR 全部通过。
- Phase 2：Firehose DO SQLite 账本（`events`/`heads`/`meta`）、`/append` `/head` `/snapshot` `/seed` `/stats`、`com.atproto.worker.appendEvent`、`com.atproto.worker.snapshot`、ledger-first 读模型、seed/fallback、firehose SQL backfill、多账号广播修复。
- Phase 3：`app/` + `public/app/` 静态 owner console（P-256 生成/导入、PBKDF2+AES-GCM 口令存储、读 repo、post/delete、409 重试、CSP）；`npm run build:app` / `npm run test:ui`。
- CLI `push`/`pull`：ledger 上线后的本地同步/备份路径；`pull` 会重建 `.repo-state.json`。
- 主账号已本地轮换到 P-256：`rotate-key` + `rotate-head`，6/6 事件 `validate` 通过；官方 `verifyRepoCar` 对新 head + 全量 CAR 返回 true。

**真实运行时验证**

- 在 Wrangler/workerd 里验证 P-256：官方 low-S fixture 通过、high-S 拒绝、自己签自己验通过（`zDna` / 64 字节 / 128 hex）。
- 发现并修复一个只在真实 Cloudflare SQL API 出现的 bug：`.one()` 在空结果集上会抛错（Node SQLite shim 返回 null 掩盖了它）。现在统一用 DO 的 `one()` helper（`toArray()[0] ?? null`），测试 shim 也改成空集抛错以防回归。

**测试**

- `npm test` 全绿（新增 p256/repo-core/car/append/ledger）。
- `npm run test:ui` 全绿（Playwright + Edge；生成/解锁/导入、create/delete、mock Worker 真实验签、409 重试）。

**待办**

- **部署**：当前 `wrangler` 未登录。`npx wrangler login` 后 `npm run deploy`，把新 `public/.well-known/did.json`、6 条 journal、`public/app/` 和新 Worker 代码一起发出去；部署后访问 `/refresh` 或等 cron 让 ledger seed + relay 重新 crawl。
- 已知限制：relay 若从 -1 重放旧 K-256 事件，可能因当前 did.json 已是 P-256 而验签失败（正常 cursor 不会）；完整 MST 路径验证、per-DID 限流、自注册准入、blobs、M3 官方客户端仍在 follow-up。

---

## 1. 技术事实核对（带本地证据）

### 1.1 atproto 双曲线支持

- `thirdparty/atproto/packages/crypto/src/plugins.ts:1-5` 同时注册 `p256Plugin` 和 `secp256k1Plugin`。
- `thirdparty/atproto/packages/crypto/README.md:8-13` 明确写："implements the two currently supported cryptographic systems: P-256 ... K-256 ..."。
- `thirdparty/atproto/packages/did/src/atproto.ts:199-203` 接受三种 verification method：`EcdsaSecp256r1VerificationKey2019`、`EcdsaSecp256k1VerificationKey2019`、`Multikey`。
- 签名算法由**密钥类型推断**，commit 里没有 `alg` 字段：`thirdparty/atproto/packages/crypto/src/verify.ts:14-22`、`thirdparty/atproto/packages/identity/src/did/atproto-data.ts:26-40`。

### 1.2 编码与签名格式（两种曲线完全一致）

| 项 | P-256 | K-256 |
|---|---|---|
| multicodec | `0x1200`，varint 字节 `[0x80, 0x24]` | `0xE7`，varint 字节 `[0xE7, 0x01]` |
| 公钥 | 33 字节压缩点 + 前缀 → base58btc `z...` | 同左 |
| `did:key` 示例 | `did:key:zDna...` | `did:key:zQ3...` |
| 签名 | 64 字节紧凑 `r‖s`，**必须 low-S**，禁止 DER | 同左 |
| 签名前像 | 无 sig 的 commit 规范 CBOR 的 SHA-256 | 同左 |
| commit 里的 `sig` | CBOR byte string（不是 base64url） | 同左 |

证据：

- `thirdparty/atproto/packages/crypto/src/const.ts:1-7`
- `thirdparty/atproto/packages/crypto/src/p256/keypair.ts:57-62`（SHA-256 → sign → `toCompactRawBytes()`）
- `thirdparty/atproto/packages/crypto/src/p256/operations.ts:28-33`（verify 强制 `format:'compact'`、`lowS:true`）
- `thirdparty/atproto/interop-test-files/crypto/signature-fixtures.json`：P-256/K-256 的 valid、high-S、DER 六组 fixtures
- `thirdparty/indigo/atproto/atcrypto/keys.go:122-127`（`0x80 0x24` → P-256）

**对本项目的含义**：journal 的 `sig` 仍是 128 个 hex 字符（64 字节）；`src/shared.js:166-179` 的 `commitToCbor`/`commitCid` **一行都不用改**。P-256 只换签名器，不换 commit 编码。

### 1.3 WebCrypto P-256 实测

用 Node 的 `crypto.webcrypto`（与 Workers 同标准）实测：

- `crypto.subtle.generateKey({name:'ECDSA', namedCurve:'P-256'}, ...)`
- `crypto.subtle.sign({name:'ECDSA', hash:'SHA-256'}, privateKey, bytes)` → **64 字节 raw r‖s**
- `crypto.subtle.verify(...)` 可直接验 64 字节签名
- 采样 200 次：约 99 次 high-S → **WebCrypto 不保证 low-S，必须自己归一化**
- `importKey('raw', 65 字节未压缩点, ...)` 可用；压缩点在某些实现可用，但**不应依赖**，Worker 侧应自己解压（P-256 的 `p ≡ 3 mod 4`，用 BigInt 求模平方根即可）

> 注意：P-256 在 WebCrypto 里是 **ECDSA 签名/验签**（以及 ECDH 密钥协商），不是"加密解密"。atproto 只需要签名，所以正好够用。

### 1.4 关键协议事实：只验头部 commit，不追历史签名

这是"轮换密钥很便宜"的依据：

- `thirdparty/atproto/packages/repo/src/sync/consumer.ts:103-123` 的 `verifyRepoRoot` 只 `ReadableRepo.load(storage, head)`，然后验**这一个 head commit 的签名**；不遍历 `prev`。
- 参考实现 v3 commit 的 `prev` 恒为 `null`：`thirdparty/atproto/packages/repo/src/repo.ts:163-173`。
- relay 对实时事件也只验事件里的 commit：`thirdparty/indigo/cmd/relay/relay/verify.go:102-112`；rev 单调性在 `:147-149`。
- appview 同样按 DID 文档里的当前 `#atproto` 公钥验 head：`thirdparty/atproto/packages/bsky/src/data-plane/server/indexing/index.ts:171-181`。

**含义**：从 K-256 轮换到 P-256 时，**不需要重签全部历史**。只要：
1. 发布新的 `did.json`（`#atproto` 换成 P-256 multikey）；
2. 用新 P-256 密钥签一个新 head commit（`data` 可以保持原 MST root，`prev` 指向旧 head）；
3. 之后的新事件都用新密钥。
历史 commit 仍留在 CAR 里，但协议验签只看新 head。relay 的 identity 缓存有 TTL，发布 did.json 后稍等再发第一条新事件即可。

### 1.5 重要限制：没有"提交预签名 commit"的标准写端点

- `com.atproto.repo.createRecord` / `applyWrites` 的输入是 `record`/`writes`，**没有 `sig`**：`thirdparty/atproto/lexicons/com/atproto/repo/createRecord.json`、`applyWrites.json`。
- `com.atproto.repo.importRepo` 接收整包 CAR，但它是**导入/迁移**语义，且 PDS 实现默认不验签（`thirdparty/atproto/packages/pds/src/api/com/atproto/repo/importRepo.ts:57-66`，`signingKey` 传 `undefined`）。
- 所以：浏览器可以**生产**签名 commit，但标准 PDS 不会把它当成一次普通写来接收。M1 必须自定义一个 append 端点（这是本项目自己的 PDS，不违反协议；relay/appview 只看最终 repo 和 firehose）。

### 1.6 只读 repo host 足以被 relay/appview 接受

项目现状已经证明：`describeServer` + `subscribeRepos` + `getRepo`/`getLatestCommit`/`getRepoStatus` + 匹配的 DID 文档，就足以联邦。P-256 不改变这一点。新写入只需要让这些读端点看到新事件，不需要实现完整 PDS 写 API。

---

## 2. 这个发现改变了什么、没改变什么

### 改变了

| 原结论 | 新结论 |
|---|---|
| Web UI 写必须私钥上 Worker（ADR-013/035） | **不必**。浏览器 WebCrypto P-256 直接签 commit，私钥不出浏览器 |
| 写路径只能 CLI（ADR-014） | 放宽：**owner 签名**是唯一写路径；CLI 和浏览器都是签名端 |
| Worker 永不验签（ADR-030） | 读仍不验；**写入口必须验**，P-256 验签原生、便宜 |
| 轮换密钥要重签整个 journal（ADR-018） | 协议只验 head，**轮换只需新 head + 新 did.json**；历史签名可保留 |
| phase5 的 A 是"最大、最重" | 拆成 A1（自有客户端，M1，中等）和 A2（官方客户端，M2/M3，仍很大） |

### 没改变

- **仍然需要活账本**：静态 `public/journal.ndjson` 不能运行时追加。DO SQLite 仍是自然落点。
- **官方 bsky.app 仍不能用**：除非 Worker 持 repo key 服务端签名（M2/M3）。
- **blobs 仍然要存储**：浏览器上传头像/图片仍需要 R2/DO/ASSETS 写入路径；M1 先做文字。
- **Worker 仍可审查/丢弃/重放**：纯通道不是"不可审查"。它不能伪造签名，但能选择性转发。owner 需要本地备份/可验证日志来发现。
- **页面本身仍是信任边界**：谁托管签名页面，谁就能在页面里放恶意 JS。最强形态是把页面独立托管（见 §6.8）。

---

## 3. 四种架构

### M0：外部可写静态 journal（GitHub API / CF Pages）+ Worker 只读

浏览器用 GitHub OAuth/token 把新 `journal.ndjson` 提交到仓库，GitHub Pages（或 `JOURNAL_URL`）提供文件；Worker 只读+转发。

- 优点：Worker 零新存储、零新写路径；最贴近"纯静态"。
- 缺点：依赖第三方写权限和 token；写入延迟/冲突；firehose 需要 Worker 轮询；`JOURNAL_URL` 当前在 `load()` 里甚至没被使用（`src/journal.js:34-60` 只读 ASSETS/JOURNAL_CONTENT），要先修。
- 结论：可作为备选，不作为主推荐。

### M1：owner 自签 + Worker 活账本/纯通道（推荐）

浏览器（或 CLI）构造 MST + commit，P-256 签名；POST 到 Worker；Worker 验签、按 per-DID head 追加到 DO SQLite；读端点从账本读；firehose 从账本广播；relay 通过 `requestCrawl` 重新收录。

- 私钥：owner 浏览器/CLI，Worker 永不持有。
- Worker 能伪造吗：**不能**（没有 key）。
- 官方 bsky.app：**不能**。
- 自有静态 Web UI：**能**，且发帖即时生效（无需 deploy）。
- 复杂度：中（活账本 + append + 浏览器签名库 + UI）。
- ADR 影响：保留 005；放宽 014；写路径加验签（030 的补充）；033 schema 版本化落地。

### M2：完整 PDS（Worker 持 repo key）

实现 createSession/JWT/password + createRecord/putRecord/deleteRecord/applyWrites/uploadBlob，Worker 服务端构造 MST/commit 并签名。

- 私钥：Worker（secret/DO）。
- Worker 能伪造吗：**能**。
- 官方 bsky.app：**能**。
- 自有 Web UI：能（但不必浏览器签名）。
- 复杂度：高（phase5 的 A / ADR-035）。
- ADR 影响：推翻 005。

### M3：混合（Worker 持 repo key，owner 控 rotation key）

在 M2 基础上，owner 通过 did.json（did:web）或 PLC rotation key（did:plc）保留"随时把 Worker 踢掉"的能力。

- 私钥：Worker 持 repo key；owner 持 rotation/identity 控制权。
- Worker 能伪造吗：**轮换前能**；owner 可撤销。
- 官方 bsky.app：**能**。
- 复杂度：高 + 轮换/身份控制面。
- 适用：既想要官方客户端，又不想完全信任 Worker。
- 注意：did:web 没有协议级 rotation key，等价于"owner 控制 did.json 的托管"；要真正抗 Worker 作恶，did.json 应独立于 Worker 托管。did:plc 才有正式的 rotation key，但引入 PLC 依赖，和 ADR-009/038 的 did:web 路线冲突。

### 对比表

| | M0 外部静态 | **M1 owner 自签** | M2 完整 PDS | M3 混合 |
|---|---|---|---|---|
| 私钥位置 | owner | **owner 浏览器/CLI** | Worker | Worker + owner rotation |
| Worker 可伪造 | 否 | **否** | 是 | 轮换前是 |
| 官方 bsky.app | 否 | **否** | 是 | 是 |
| 自有 Web UI 即时写 | 是（有延迟） | **是** | 是 | 是 |
| 活账本 | 否（外部文件） | **是（DO SQLite）** | 是 | 是 |
| Worker 新代码量 | 低 | **中** | 高 | 高 |
| ADR-005 | 保留 | **保留** | 推翻 | 部分保留 |
| 撤销 Worker | n/a | **改 did.json** | PLC/did.json | **rotation key** |

**推荐：M1 先做；M2/M3 只在"必须用官方客户端"时启动。**

---

## 4. M1 目标架构

```
┌─────────────────────────────┐
│  静态页面（可独立托管）      │
│  - P-256 key (IndexedDB)    │
│  - 读: getRepo/getRecord    │
│  - 写: MST+commit+sign      │
└──────────────┬──────────────┘
               │ POST /xrpc/com.atproto.worker.appendEvent
               │ (签名事件 + CAR blocks)
               ▼
┌─────────────────────────────┐
│  Cloudflare Worker          │
│  - 解析/验签 (P-256)        │
│  - 校验 CID/prev/rev        │
│  - 读模型 (Journal)         │
└──────────────┬──────────────┘
               │ /append (CAS on head)
               ▼
┌─────────────────────────────┐
│  Firehose DO (SQLite)       │
│  events(seq, did, ...)      │
│  heads(did, commitCid, rev) │
│  - append 串行化            │
│  - 广播 firehose 帧         │
│  - backfill / snapshot      │
└──────────────┬──────────────┘
               │ subscribeRepos
               ▼
        relay / appview
```

### 4.1 写入数据流（浏览器）

1. `GET /xrpc/com.atproto.sync.getRepo?did=...` → 完整 CAR → 解析成 `Map<cid, bytes>`。
2. `GET /xrpc/com.atproto.sync.getLatestCommit?did=...` → `{cid, rev}`（或从 CAR root 得到）。
3. 在本地 MST 上 apply write（create/update/delete）→ 新 MST root + 新 blocks。
4. `rev = nextTID(head.rev)`；`commit = {did, version:3, data:newMstRoot, rev, prev:head.cid}`。
5. `sig = P-256_sign(commitToCbor(unsigned))`，归一化 low-S，64 字节 → hex。
6. `commitCid = commitCid(commit)`；`recordCid = computeCID(record)`；CAR = commit + new MST nodes + record。
7. `POST appendEvent`：
   ```json
   {
     "did": "did:web:...",
     "op": "create",
     "collection": "app.bsky.feed.post",
     "rkey": "3m...",
     "record": { "$type": "app.bsky.feed.post", "text": "...", "createdAt": "..." },
     "recordCid": "bafyrei...",
     "rev": "3m...",
     "commit": { "did": "...", "version": 3, "data": "bafyrei...", "rev": "3m...", "prev": "bafyrei...", "sig": "<128 hex>" },
     "commitCid": "bafyrei...",
     "mstRoot": "bafyrei...",
     "blocksB64": "<CAR base64>"
   }
   ```
8. Worker 返回 `{uri, cid, commit:{cid,rev}, seq}`。浏览器更新本地 head。

**注意**：`offset`、`time`、`prevRev`、`prevMstRoot` 由 Worker/DO 赋值，客户端不传、不信任。`prev` 必须等于当前 head，客户端必须传对（Worker 用 CAS 再校验一次）。

### 4.2 Worker 写入口校验（append 时）

按顺序：

1. **准入**：`did` 已 hosted（journal/ledger 里存在），或满足自注册规则（did.json 的 `atproto_pds` 指向本 Worker，且 key 匹配）。个人 PDS 建议默认只允许已有账号，避免被当免费存储。
2. **字段**：`op ∈ {create,update,delete}`；`collection`/`rkey` 合法；非 delete 必须有 `record`。
3. **CID**：`recordCid === computeCID(record)`；`commitCid === commitCid(commit)`；`mstRoot === commit.data`；`commit.did === did`；`commit.rev === rev`；`commit.version === 3`。
4. **链**：`commit.prev === head.commitCid`；`event.prev === head.commitCid`；`rev > head.rev`；`commitCid` 未出现过（去重/幂等）。
5. **验签**：解析 DID 文档当前 `#atproto` 的 `publicKeyMultibase`：
   - P-256（`0x1200`）：解压 → `crypto.subtle.importKey` → `crypto.subtle.verify`，并**显式拒绝 high-S**。
   - K-256（`0xE7`）：M1 建议**拒绝网络写**（Worker 不引 `@noble/secp256k1`），返回 `UnsupportedKeyType`，让账号先轮换到 P-256。CLI 仍可签 K-256 旧事件。
6. **CAR**：解析 `blocksB64`；root 必须等于 `commitCid`；必须包含 commit block、record block（非 delete）、`mstRoot` block。完整 MST 路径验证可以后置（owner 自己的 key，作恶只害自己；但至少保证读端点不会立刻坏）。
7. **大小/频率**：body、blocks、每 DID 事件数、写入频率上限。

**验签的信任边界**：只验 head，不重验历史。历史由 seed/CLI 产生，或由之前的 append 验过。这是对 ADR-030 的精确补充：**读不验，写验**。

### 4.3 活账本（DO SQLite）

复用现有 `Firehose` DO（已是 `new_sqlite_classes`，`wrangler.toml:31-33`），或拆一个 `Ledger` DO。推荐先复用，减少绑定：

```sql
CREATE TABLE IF NOT EXISTS events (
  seq        INTEGER PRIMARY KEY,   -- 全局单调，作为 firehose seq / listRecords cursor
  did        TEXT NOT NULL,
  collection TEXT NOT NULL,
  rkey       TEXT NOT NULL,
  op         TEXT NOT NULL,
  rev        TEXT NOT NULL,
  commit_cid TEXT NOT NULL UNIQUE,
  record_cid TEXT,
  time       TEXT NOT NULL,
  json       TEXT NOT NULL           -- 完整 journal 行（保持行自包含，ADR-033）
);
CREATE INDEX IF NOT EXISTS idx_events_did_seq  ON events(did, seq);
CREATE INDEX IF NOT EXISTS idx_events_did_coll ON events(did, collection, rkey);

CREATE TABLE IF NOT EXISTS heads (
  did        TEXT PRIMARY KEY,
  commit_cid TEXT NOT NULL,
  rev        TEXT NOT NULL,
  seq        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
```

DO 路由：

| 路由 | 作用 |
|---|---|
| `POST /append` | 原子检查 head/rev，分配 `seq`，写 events + heads，广播 firehose 帧 |
| `GET /head?did=` | 返回 `{commitCid, rev, seq}` |
| `GET /snapshot` | 返回全部事件（NDJSON 或 JSON 数组），供 `Journal.load()` |
| `GET /events?after=&limit=` | 增量 tail（可选，先不做也行） |
| `POST /seed` | 一次性导入 `public/journal.ndjson`（幂等，按 commitCid 去重） |
| `GET /cursor` / `POST /broadcast` | 保留现有语义 |

**seed 策略**：DO 为空时，从 `ASSETS` 读 `public/journal.ndjson`，按现有 `offset` 作为 `seq` 导入（`nextSeq = max(offset)+1`）。这样 firehose cursor / listRecords cursor 不需要迁移。之后静态文件只作为 seed/备份，**不再覆盖活账本**。

**offset 语义变化**：`offset` 从"文件字节偏移"变成"全局逻辑序号"。字段名保留（firehose/客户端只要求单调），但这是 schema 语义变更，按 ADR-033 的预案，**现在就是引入 `schemaVersion` 的时机**。建议在 journal 首行或每行加 `v: 2`，或 DO 的 `meta` 里记 `schema_version=2`；`Journal.validate()` 按版本分流。

### 4.4 读模型

`src/journal.js` 的 `load()` 顺序改为：

1. `LEDGER` DO `/snapshot`（主源）；
2. DO 不可用/为空时回退 `ASSETS`（seed）；
3. 最后 `JOURNAL_CONTENT`（本地 dev）。

`refresh()` 改为从 DO 取增量或重新快照。`/refresh` 保留兼容，但不再是"发帖后必须手动调用"的步骤；append 成功后由 append 处理器直接广播 + `notifyRelay`。

**性能**：每次请求都拉全量 snapshot 会重演 ADR-027 的 CPU 成本。两个低成本缓解：
- Worker 模块级缓存：记住 `{seq, events}`，每次先问 DO `/head`（或 `/snapshot?since=`），seq 没变就复用；
- `Workers Cache` 对确定性读端点继续生效；新数据端点可用短 TTL（1-5s）或按 head seq 做 cache key。
- 事件量大了再考虑 DO SQL 直读分页（不拉全量）。

### 4.5 Firehose / relay

- append 成功后，DO 直接 `formatEvent(event)` 推给所有订阅者，并推进 cursor（复用 `src/firehose.js:298-352`）。
- `backfill` 改为从 DO SQL 读，而不是 `new Journal(env).load()`（`src/firehose.js:204-241` 当前只读 ASSETS，必须改）。
- **修掉 `ownerDid` 过滤**：`src/index.js:224-228` 不传 `ownerDid`，而 `src/firehose.js:264-267` 在 `env.OWNER_DID` 存在时会过滤掉其它账号。多账号必须广播全部 hosted DID。
- append 后 `ctx.waitUntil(notifyRelay(env, handle))`，和现在 `/refresh` 一样。

### 4.6 身份与密钥轮换

- 新账号：浏览器生成 P-256 → 页面输出 `did.json`（`type: "Multikey"`, `publicKeyMultibase: zDna...`）→ owner 发布到自己的域名 → 首条 commit。
- 现有 k256 账号（本项目当前只有 5 条事件）：发布新的 P-256 `did.json` → 用 P-256 签一个新 head（`data` 可保持原 MST root，`prev` 指向旧 head）→ 之后都用 P-256。历史不用重签。
- `src/did.js:28-55` 的硬编码 k256 上下文/fallback key 必须参数化；`cli/seal.js:159-180` 同理。
- 轮换事件的表示：当前 journal 行必须有 `op/collection/rkey/record`。两种做法：
  1. **搭车**：第一次 P-256 写就是一个真实写入（比如更新 profile / 发第一帖），顺带完成轮换；
  2. **显式 rotate 事件**：schema v2 增加 `op:'rotate'`，firehose `ops:[]`。需要确认 relay 对空 ops 的 `#commit` 接受度；建议先用方案 1，避免协议边界。
- 主账号的 `did.json` 在 `ASSETS` 里，轮换要重新部署；如果希望"不 deploy 也能轮换"，把 `did.json` 放外部静态托管（ADR-032 的方向），或加一个 owner 鉴权的可变 did 文件（额外写面，先不做）。

### 4.7 冲突、重放、离线

- 两个标签页/设备同时写：DO 串行化 + head CAS。后到者拿 `409 RepoConflict` 和当前 head，客户端 fetch 新 head/CAR，rebase 后重新签名。
- 重放：`commitCid` 唯一约束；同一条重复 POST 返回已存在的结果（幂等），不重复 append/广播。
- 超时重试：**重发同一个已签名事件**，不要重新签名（P-256 随机 nonce，重签会产生不同 CID，导致去重失效）。
- 离线队列：可以缓存"意图"，但不能缓存"已签名 commit"太久——head 变了就得 rebase 重签。

### 4.8 备份与"Worker 可丢弃"

纯通道的关键是 owner 能随时把账本拿走：

- 页面/CLI 提供 `export`：拉 `/snapshot` + `getRepo` CAR，落本地 `journal.ndjson` / CAR。
- CLI `seal.js pull`：从 Worker 拉快照，本地 `validate` 全部签名（P-256/K-256 分流）。
- 换 Worker / 迁移：把快照 seed 到新 Worker，DID 文档的 `atproto_pds` 改指向新地址即可。
- 这也让 Worker 的审查/丢数据可以被发现：owner 本地有完整签名日志。

---

## 5. 浏览器签名库的复用与缺口

好消息：签名前像、CID、CBOR、MST、CAR 的代码大部分已经是浏览器可用的。

| 模块 | 现状 | 需要做什么 |
|---|---|---|
| `src/shared.js` | 纯 WebCrypto/`atob`/`btoa`，无 Node import | 直接复用；补 `sha256()` 导出、`bytesToCid()`、`readCarFile()`/`decodeVarint()` |
| `cli/mst.js` | 只 import `../src/shared.js` 和 `./sha.js` | 把 `sha.js` 换成 `src/shared.js` 的 `sha256`，即可在浏览器用 |
| `cli/repo.js` | 核心 applyWrite/buildCar 可复用，但用 `fs`/`.repo-state.json` | 抽一个 `src/repo-core.js`（无 fs，blockstore 用 `Map`/IndexedDB） |
| `cli/atproto.js` | 签名/commit/CAR 逻辑可复用，但用 `Buffer` | 抽 `src/commit.js`，签名器注入（browser P-256 / CLI P-256/K-256） |
| `cli/crypto.js` | k256 + Node `webcrypto` | 新增 `p256` 分支；`multikey` 前缀按曲线选择 |
| 浏览器 bundle | 无构建步骤 | 加 `esbuild`（或直接把共享模块复制到 `public/app/lib/`），产物进 `public/app/` |

浏览器端还需要：

- CAR reader（标准 CAR v1：header + varint CID + block）。
- P-256 签名器：`sign` → 64 字节 → low-S 归一化 → hex。
- 公钥压缩/解压（生成 multikey、验签时解压）。
- 多曲线验签：至少 P-256；K-256 可留给 CLI（浏览器可用 `@noble/secp256k1`，但非必需）。
- 密钥存储：见 §6.7。

---

## 6. 坑与设计细节

### 6.1 low-S 必须自己做

WebCrypto 不保证 low-S（实测约一半 high-S）。签名后检查 `s > n/2`，替换为 `n - s`。P-256 的 `n` 是固定常量。Worker 验签时也要显式拒绝 high-S（`crypto.subtle.verify` 本身不拒绝）。

### 6.2 P-256 公钥解压

DID 文档里是 33 字节压缩点。Worker 的 `crypto.subtle.importKey('raw', ...)` 在标准里要 65 字节未压缩点（Node 能接受压缩点，但别依赖）。实现：

```
p = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff
a = -3
b = ...
y² = x³ + ax + b mod p
y = pow(y², (p+1)/4, p)   // p ≡ 3 mod 4
选 y 的奇偶与压缩前缀一致
```

BigInt 在 Worker 可用，成本只在 append 时一次。

### 6.3 rev/TID 单调与时钟

- relay 要求 `rev > prevRepo.rev`（indigo `verify.go:147-149`），还拒绝超前 5 分钟的 rev。
- 浏览器生成 `rev` 要用 `max(now, head.rev+1)` 或参考 `TID.nextStr(head.rev)`；不能只 `generateTID()` 然后碰运气。
- 客户端时钟偏差大时，Worker 可先拒绝并返回当前 head，让客户端用 head 推导 rev。

### 6.4 `prev` 与 head CAS

客户端必须用 `getLatestCommit` 拿到的 head 作为 `prev`；Worker 在 DO 里再次比较 `commit.prev === heads[did].commit_cid` 和 `rev > heads[did].rev`。这是防分叉的唯一可靠位置（DO 单线程）。

### 6.5 静态 journal 与活账本不能双写

一旦 ledger 上线，**静态 `journal.ndjson` 只作为 seed/备份，不再是写入目标**。如果 CLI 继续本地 append 再 deploy，会出现两套 `offset` 语义和分叉。规则：

- 所有运行时写入走 `appendEvent`（浏览器或 `seal.js --remote`）；
- `seal.js` 本地 append 仅在"还没有 ledger"的纯静态模式下使用；
- `seal.js pull` 把 ledger 快照拉回本地做备份/校验。

### 6.6 schema 版本化现在就做

ADR-033 已经点名"数据源拆分/写路径启动时"是引入 `_schemaVersion` 的时机。M1 正好是那个时机：

- 每行加 `v: 2`（或 DO `meta.schema_version`）；
- `offset` 语义从字节偏移改为逻辑 seq，写进文档；
- `Journal.validate()` 按 `v` 分流；旧的 v1 行继续可读；
- 预留 `op:'rotate'` 等新事件类型。

### 6.7 浏览器密钥存储

两种：

1. **non-extractable CryptoKey + IndexedDB**：XSS 只能当签名 oracle，不能直接导出私钥；但换浏览器/清站点数据会丢 key，且部分 Safari 版本对 structured clone CryptoKey 有兼容问题。
2. **extractable JWK + 口令加密（PBKDF2/AES-GCM）+ IndexedDB/localStorage**：可备份/恢复/跨设备，但解密后私钥在 JS 内存里，XSS 可偷。

建议：默认 1（日常使用），提供一次性 `export encrypted backup`（2）作为恢复手段。密钥丢失的后果：did:web 可以换新 key 重新开始（历史 head 签名会失效，但协议只验新 head；旧历史仍在，只是无法再证明是同一把 key 签的——实际上 did.json 换了之后，旧 head 也不再是 head，影响可控）。

### 6.8 页面托管 = 信任边界

如果 Worker 同时托管签名页面，那么 Worker 被攻破时可以替换页面 JS，借浏览器的手签任意 commit（即使 key non-extractable）。所以"Worker 纯通道"的最强形态是：

- 签名页面独立托管（GitHub Pages / 自己的静态站 / 本地文件），代码可审计/固定版本；
- Worker 只提供 XRPC API（CORS 已 `*`，`src/index.js:35-39`）；
- 便捷起见也可以让 Worker 托管 `public/app/`，但要在文档里写清楚这层信任差异。

页面安全基线：严格 CSP（禁止第三方脚本）、SRI（如果外链）、只用同源模块、不发遥测、私钥永不离开 origin。

### 6.9 blobs

M1 先做纯文字。图片/头像需要：

- `com.atproto.repo.uploadBlob` + 可变 blob 存储（R2 或 DO）；
- `getBlob` 先查可变存储再查 `ASSETS`（`src/xrpc.js:484-515`）；
- blob ref 的 CID 用 raw codec（`computeBlobCid` 已有）。
- 成本/选型见 phase5 D；不要在 M1 一上来就做。

### 6.10 官方客户端仍是另一条产品线

M1 完成后，bsky.app 仍然登不进来，因为：

- 没有 `createSession`/JWT/密码；
- `createRecord` 传的是记录，Worker 没有 key 可签。

这不是 M1 的缺陷，是协议边界。要官方客户端，直接做 M2/M3，并明确接受"Worker 持 repo key"（以及 rotation 方案）。

---

## 7. 迁移路径（现有账号）

当前 `public/journal.ndjson` 只有 5 条事件，主账号是 K-256（`zQ3...`）。迁移很轻：

1. **CLI/浏览器生成 P-256 keypair**，输出新的 `did.json`（`Multikey` + `zDna...`）。
2. owner 发布新 `did.json`（本项目就是替换 `public/.well-known/did.json` 并 deploy；或放外部静态托管）。
3. 等 relay/appview 的 identity 缓存过期（保守几分钟）。
4. 用 P-256 签一个新 head：
   - `data` = 当前 MST root（可以不变）；
   - `prev` = 当前 head commitCid；
   - `rev` = `TID.nextStr(head.rev)`；
   - 搭车一个真实写入（例如更新 profile），避免空 ops 的协议边界。
5. append 到 ledger；relay 重新 crawl；验证 bsky.app 仍能显示、新帖可索引。
6. 之后浏览器/CLI 都用 P-256。

**回滚**：保留旧 K-256 key 和旧 did.json；如果 P-256 路径出问题，改回旧 did.json + 旧 head 继续（前提是 ledger 里没有分叉）。建议迁移前先 `seal.js pull` 备份。

---

## 8. 分阶段实施计划

### Phase 0：P-256 基础（CLI + DID + 验签）— 1-2 天

- `cli/crypto.js`：曲线抽象（p256 via Node WebCrypto；k256 via noble），统一 64 字节 low-S，multikey 前缀按曲线。
- `cli/seal.js init --curve p256`；`rotate-key --curve p256`（先只改配置/输出 did.json）。
- `src/did.js` / `cli/seal.js` 的 DID 文档参数化，去掉硬编码 k256 fallback。
- `cli/seal.js validate` / `check-federation.js` 按 multikey 前缀分流验签。
- 测试：官方 `signature-fixtures.json` 六组（P-256/K-256 × valid/high-S/DER）+ `w3c_didkey_P256.json`。
- **验收**：P-256 签的 commit 能被官方 fixtures/参考实现验证；现有 K-256 journal 仍能 `validate`。

### Phase 1：浏览器签名核心（无 UI）— 2-4 天

- 抽 `src/repo-core.js`（无 fs 的 applyWrite/buildCar/loadFromCar）。
- 补 `src/shared.js`：`sha256`、`bytesToCid`、`readCarFile`/`decodeVarint`。
- P-256 签名器 + low-S + 公钥压缩/解压 + multikey 编码/解析。
- 浏览器/Node 双端测试：加载现有 CAR → 加一条 post → 签 commit → 本地 `verifyRepo`（用官方 `@atproto/repo` 或 interop fixtures）。
- **验收**：产物 CAR 能被 `@atproto/repo.verifyRepo`（head 验签 + MST diff）接受；与 CLI 的 K-256 产物结构一致（除签名）。

### Phase 2：活账本 + append 端点 — 3-5 天

- Firehose DO 加 SQLite `events`/`heads`/`meta`，`/append` `/head` `/snapshot` `/seed`。
- `src/journal.js` load/refresh 改读 DO，ASSETS 作 seed/fallback；加模块级缓存。
- `src/xrpc.js` 加 `com.atproto.worker.appendEvent`；实现 §4.2 校验。
- append 后广播 + `notifyRelay`；修 `ownerDid` 过滤和 backfill 数据源。
- schema v2 标记 + 迁移/双读路径。
- 测试：happy、重放、分叉 409、坏签名、坏 CID、rev 回退、大小限制、多账号、firehose 帧、seed 幂等。
- **验收**：现有静态账号 seed 进 ledger 后，读端点行为不变；浏览器/CLI 追加一条 post，`getRecord`/`getRepo`/firehose 立即可见；relay 重新 crawl 后 bsky.app 可见。

### Phase 3：静态 Web UI — 3-5 天

- 页面：生成/导入 P-256 key、显示并复制 did.json、加密备份、解锁。
- 读：getRepo/getRecord/listRecords；时间线/自己的帖子。
- 写：post/like/repost/follow/delete/profile（先文字）。
- 冲突处理：409 → 拉新 head → rebase → 重签。
- 托管：`public/app/`（便捷）或独立静态站（推荐的安全形态）；CSP。
- Playwright 端到端：生成 key → 发布 did.json（本地测试域）→ 发帖 → Worker 读回 → 本地 `verifyRepo` → 模拟 relay crawl。
- **验收**：不跑 CLI、不 deploy，纯静态页面完成一次发帖，数据落 DO，读端点立即可见。

### Phase 4（可选）：M2/M3 官方客户端

- sessions/JWT/password、createRecord/putRecord/deleteRecord/applyWrites、uploadBlob、服务端 repo 核心与签名、key custody/rotation。
- 这是 ADR-035 的完整工程，和 M1 共享 ledger/read/firehose。

**M1 总计约 2-3 周**（含测试/文档）；Phase 0+1 的 spike 约 3-5 天，就能回答"浏览器签出来的 CAR 官方认不认"这个最大的技术风险。

---

## 9. 风险与开放问题

| 风险 | 影响 | 缓解 |
|---|---|---|
| WebCrypto 在 Workers 上的 P-256 行为与 Node 有差异 | 验签失败 | Phase 2 在 `wrangler dev`/真实 Worker 上跑集成测试；low-S/压缩点自己控制 |
| 浏览器 MST/CAR 实现与官方有细微差异 | relay/appview 拒绝 | Phase 1 用官方 `@atproto/repo.verifyRepo` 做对拍；复用现有通过 fixtures 的 MST |
| relay identity 缓存导致轮换后短暂拒收 | 新帖延迟 | 先发 did.json，等 TTL；失败重试 |
| 两设备并发写 | 409/分叉 | DO CAS + 客户端 rebase；文档写清楚 |
| 页面被 XSS/恶意托管 | 签名 oracle/盗 key | non-extractable key、CSP、独立托管、代码审计 |
| Worker 被攻破可审查/丢事件 | 可用性/完整性 | owner 本地 pull/备份；relay/appview 只信签名 |
| 静态 journal 与 ledger 双写 | 分叉/offset 混乱 | 明令 ledger 上线后只走 append；静态文件只做 seed/备份 |
| 空 ops 的 rotate 事件 relay 不接受 | 轮换卡住 | 先搭车真实写入；schema v2 再评估显式 rotate |
| blobs 未做 | 图片帖不可用 | M1 文字优先；D 单独评估 |

**开放问题（需要 owner 拍板）**：

1. 主账号现在就轮换到 P-256，还是保留 K-256、只给新账号 P-256？（推荐：现在轮换，只有 5 条事件，成本极低。）
2. 签名页面托管在哪：Worker 的 `public/app/`（方便）还是独立静态站（更安全）？两者都支持，但默认值要定。
3. 网络写是否只接受 P-256（简单、零依赖）？K-256 旧账号必须先轮换。（推荐：是。）
4. 是否现在就把静态 journal 降级为 seed/备份，所有写走 ledger？（推荐：是，否则双写必乱。）
5. 是否要 M2/M3（官方 bsky.app）？如果要，是否接受 Worker 持 repo key + owner rotation？这决定要不要现在设计 sessions/JWT。

---

## 10. 与已有 ADR 的关系

| ADR | 影响 |
|---|---|
| 002 事件溯源 | 不变；ledger 仍是 append-only 事件流 |
| 004 journal CID 链 | 不变；commit 编码/签名格式不变 |
| 005 私钥仅本地 | **保留并强化**：私钥在浏览器/CLI，Worker 仍不持有 |
| 009 did:web | 不变；P-256 multikey 只是 key 类型变化 |
| 010/027 链校验 | 保留；append 时增加验签/字段校验 |
| 014 CLI 唯一写 | **放宽**为"owner 签名唯一写路径"；浏览器成为第二签名端 |
| 018 k256 选择 | 部分过时：P-256 成为新默认/新写路径；K-256 保留只读兼容 |
| 020 commit v3 编码 | 不变；P-256 只换签名器 |
| 024/032 静态资产/外部托管 | 静态 journal 降级为 seed/备份；外部 did.json 可作为轮换控制面 |
| 030 不验签 | **补充**：读不验，写入口必须验；P-256 让验签零依赖 |
| 033 schema 冗余/版本 | **现在落地** schema v2 + `offset` 语义变更 |
| 035 完整 PDS | 拆成 A1（M1，本文件）和 A2（M2/M3，仍是完整 PDS） |
| 038 多账号 | 不变；ledger 按 did 分组 heads，append 按 did 验签 |
| 039 自发现/缓存 | 不变；公钥仍走 well-known；append 时缓存 DID 文档 |

**建议**：M1 方向确认后，把本文件的 §4 升格为 `ADR-040`（owner-signed repo / Worker ledger），并同步修订 ADR-005/014/018/030/033/035 的状态说明。

---

## 11. 最小验证 spike（建议下一步就做）

在动 Worker 账本之前，先用 1-2 天验证最大的技术风险：**浏览器签出来的 commit/CAR，官方实现认不认**。

范围：

1. 一个纯 Node/浏览器脚本：生成 P-256 key → 用现有 `src/shared.js` + `cli/mst.js` 构造一个空 repo 的第一条 post → 签 commit → 产出 CAR。
2. 用官方 `@atproto/repo` 的 `verifyRepo`（或 indigo 的等价测试）验证：
   - head 签名通过（P-256 low-S）；
   - MST root/leaves 正确；
   - `getRepo` CAR 能 round-trip。
3. 用 `signature-fixtures.json` 的 P-256 valid/high-S/DER 三组验证签名器/验签器。
4. 不碰 Worker、不改主代码；产物放 `.tmp/p256-spike/`。

**如果 spike 通过**，Phase 2/3 就是工程量问题，不是可行性问题。
**如果 spike 不通过**（比如 Workers/浏览器签名格式、MST 细节、relay 对 P-256 的实际接受度），再回来调整方案——但失败点会很具体，不会浪费账本/UI 的工作。
