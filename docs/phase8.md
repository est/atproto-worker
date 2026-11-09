# Phase 8 / M1.5：远程签名桥（remote signer bridge）

> 讨论稿（plan mode，未动代码）。目标：**让官方 bsky.app 在 M1 的 key custody 下工作** —— 私钥仍在 owner 浏览器，Worker 永不持有；但 Worker 能接收 bsky.app 的标准 XRPC 写请求，并把"构造/签名 commit"这一步桥接回浏览器。
>
> 一句话：这不是 iframe/SW 的魔法，而是 **Worker 同时握着两条连接**：
> - 对 bsky.app / AppView：标准 PDS XRPC + session；
> - 对 owner 浏览器：一条持久的 signer WebSocket。
>
> 中间那一步"签名"被远程化。Worker 是 **remote signer bridge**，不是 signer。

---

## 0. 结论先行

1. **技术上可行**。协议不要求 PDS 自己持 repo key；它只要求 `createRecord` 等端点返回一个由 DID 文档 `#atproto` key 签名的 commit。签名发生在浏览器还是 Worker，relay/appview 不关心。
2. **iframe 不是桥**。bsky.app 不会主动嵌入我们的 iframe；即使 bookmarklet/扩展注入，iframe 也不能让 Worker 收到 bsky.app 的 XRPC 请求——那些请求本来就直接打到 Worker。iframe 最多是 UI/keepalive 的花招，而且第三方存储分区会让 iframe 里的 IndexedDB key 不可靠。
3. **service worker 也不是桥**。SW 只能控制自己 origin 的页面，不能拦截 bsky.app → Worker 的跨域请求；而且 SW 会被浏览器随时终止，长连接/低延迟签名不可靠。
4. **正确的原语**：owner 浏览器开一个 **signer tab**（或浏览器扩展），通过 **WebSocket** 连到 Worker 的 Durable Object；Worker 收到 bsky.app 的写请求后，向 signer 发签名请求、等待、验签、写账本、返回标准响应。
5. **代价**：signer 必须在线且解锁；写操作多一个 RTT；**Worker 变成 signing oracle**（不能偷 key，但可以在线请求签名）。这是 M1.5 与 M3 的核心区别：M1.5 的 Worker 不能离线伪造，但在线时仍能借浏览器的手签名；要靠 signer 的策略/确认/限流来约束。
6. **定位**：M1.5 是 M3 的"custody-first"替代，不是替代 M1。M1（直接 `/app/` 写）、M1.5（官方客户端 + 浏览器 signer）、M3（官方客户端 + Worker key）三者按账号 mode 选择。

---

## 1. 请求流：bsky.app 是怎么被"骗"进 M1 的

```
bsky.app / AppView
   │  1. createSession(handle,password)  -> JWT（Worker 签发，无需 key）
   │  2. createRecord / applyWrites / uploadBlob (Bearer JWT)
   ▼
Cloudflare Worker (PDS + bridge)
   │  3. 校验 session/记录；uploadBlob 直接存（不需要签名）
   │  4. 写操作 -> DO /sign {did, writes, expectedHead}
   ▼
Durable Object (Signer broker)
   │  5. WebSocket -> owner signer tab {id, writes, head}
   │  6. signer: 拉 repo -> 应用 writes -> MST/commit -> P-256 签名 -> event
   │  7. signer -> DO {id, event}
   │  8. DO 验签/验 CID/CAR/head -> ledger /append (CAS)
   ▼
Worker -> AppView -> bsky.app 显示成功
```

关键点：

- **login/read 不需要 signer**。`createSession` 只做密码/JWT；`getRecord/getRepo/describeRepo` 走 M1 读路径。只有 **写 commit** 需要浏览器在线。
- **uploadBlob 不需要 signer**。blob 是内容寻址的字节，不属于 commit；Worker 存完返回 blob ref，随后 `createRecord`/`putRecord` 才需要签名。
- **AppView 的超时足够**。bsky AppView 的 proxy headers/body timeout 默认 30s（`thirdparty/atproto/packages/bsky/src/config.ts:632-637`）；signer 在线时一次签名往返是亚秒级。
- **一次写一个 commit**。`applyWrites` 批量写由 signer 的 `Repo.applyWrites` 合成一个 commit；与 M3 的服务端逻辑相同，只是签名端换了。

---

## 2. 为什么 iframe / service worker 不是正确的桥

### 2.1 iframe

能做的：

- 一个 `https://worker/signer` 页面可以被任意站点用 `<iframe>` 嵌入（只要 Worker 不发 `X-Frame-Options`/`frame-ancestors` 禁止）。
- 如果用户用 bookmarklet 或扩展在 bsky.app 里注入一个 iframe，signer UI 可以"浮"在 bsky.app 上。

不能做的：

- **bsky.app 不会主动嵌入它**。没有 iframe 元素，就没有 iframe。
- **iframe 不参与 XRPC**。bsky.app/AppView 的写请求是直接 HTTP 到 Worker 的；iframe 无法拦截，也不需要拦截。
- **第三方存储分区**。Safari/Firefox 会把第三方 iframe 的存储分区；iframe 里可能读不到顶层 signer tab 的 IndexedDB key。把 key 放进 iframe 的 origin 又会让"独立托管/审计"变复杂。
- **CSP**。bsky.app 的 CSP 可能禁止任意 frame-src；bookmarklet 注入的 iframe 也会受页面 CSP 影响。

结论：iframe 最多是 **UI/keepalive 的辅助**（例如 bookmarklet 注入一个"signer connected"小浮窗），不是传输层。真正需要的是 signer tab 自己维持到 DO 的 WebSocket。

### 2.2 service worker

能做的：

- 在 Worker origin 注册 SW，后台访问 IndexedDB/CryptoKey（如果浏览器允许）。
- Chromium 里 SW 可以短暂持有 WebSocket/fetch。

不能做的：

- **不能拦截跨域请求**。SW 的 fetch 拦截只在自己的 scope（Worker origin）内；bsky.app → Worker 的请求不经过它。
- **生命周期不可靠**。SW 空闲会被终止；长连接、低延迟签名不是它的设计目标。Background Sync/Periodic Sync 有权限/频率限制；Push 能唤醒但延迟高。
- **密钥/解锁体验差**。SW 里做 passphrase 解锁/确认弹窗很别扭；CryptoKey 的可用性也受浏览器实现影响。

结论：SW 可以作为"后台保活"的实验，但不能作为签名桥的核心。**顶层 signer tab 或浏览器扩展**才是可靠形态。

### 2.3 浏览器扩展（M1.5b）

如果愿意多一个安装步骤，扩展是最稳的：

- content script 注入 bsky.app，可显示 signer 状态/确认 UI；
- background/offscreen document 维持到 Worker 的 WebSocket（MV3 仍有生命周期限制，但比 tab 可控）；
- key 存在扩展的 storage/IndexedDB，origin 固定、可审计；
- 可以拦截/记录 bsky.app 的 XRPC 写请求做审计（可选）。

代价：分发/商店审核/权限；不是"纯静态页面"了。可作为 M1.5 的增强形态。

---

## 3. 协议与密钥模型

### 3.1 账号 mode

新增 `mode='remote-signer'`：

| mode | repo key | 官方客户端 | 需要浏览器在线 | Worker 可离线伪造 |
|---|---|---|---|---|
| `owner-signed`（M1） | owner 浏览器/CLI | ❌ | 写：是（直接 `/app/`） | ❌ |
| **`remote-signer`（M1.5）** | **owner 浏览器** | ✅ | **写：是（signer tab）** | **❌** |
| `worker-signed`（M3） | Worker | ✅ | 否 | ✅ |

- DID 文档的 `#atproto` key 仍是 **owner 的 P-256 key**；Worker 只存 **publicKeyMultibase**，不存私钥。
- `repo_keys` 表对 remote-signer 只存 public key + signer token hash；`private_key_pkcs8` 为空。
- 切换 mode 仍然要换 DID key + 新 head；不是运行时开关。

### 3.2 Session

复用 M3 的 `src/auth.js`：

- `createSession/getSession/refreshSession/deleteSession`、PBKDF2、HS256 JWT、`JWT_SECRET`。
- 唯一区别：写端点不调用 Worker 的 `signP256`，而是调用 DO `/sign`。

### 3.3 Signer token

- 浏览器生成一个随机 32-byte token（不是 repo key），在 enrollment 时通过 HTTPS 发给 Worker；Worker 存 `sha256(token)`。
- signer WebSocket 连接后第一条消息 `{type:'hello', token, did}`；DO 校验哈希。
- token 可轮换/撤销；撤销 = 断开 signer + 账号写能力失效（读/登录仍在）。
- token 不放 URL/日志；用首消息或子协议传输。

### 3.4 DID 文档

- Enrollment 时浏览器已经生成/持有 key；Worker 用 public key 生成 didDoc（`Multikey zDna...` + `atproto_pds`），返回给 owner 发布。
- Worker 不生成私钥，所以 enrollment 必须带 `publicKeyMultibase`（或由浏览器先 init）。
- 主账号如果要从 M1 切到 M1.5，key 不变，只需新增 signer enrollment + mode 标记；DID 文档不需要换 key（因为还是同一把 owner key）。这是一个优势：**M1 → M1.5 不需要换 DID key**。

---

## 4. signer bridge 设计

### 4.1 Durable Object

建议新增 `Signer` DO（`new_sqlite_classes`），或复用 `Firehose` 加 `/signer` 路由：

- `GET /signer/ws`（Upgrade）→ 接受 signer WebSocket；按 did 只保留一个活跃 signer（或 leader/epoch）。
- `POST /sign`（内部，Worker 调用）→ body `{did, writes, method, expectedHead, expectedRev, requestId}`。
  - 若无 signer：`503 SignerUnavailable`（快速失败，不要等 30s）。
  - 若有：`ws.send({type:'sign', id, did, writes, method, expectedHead, expectedRev})`；把 pending promise 存到内存/`signer_requests` 表；await 响应（超时 8-10s）。
  - signer 回 `{type:'signed', id, event}` 或 `{type:'error', id, error, message}`。
  - DO 用 `validateAppendEvent` 验签/验 CID/CAR/head（resolvedKey = 账号 publicKeyMultibase），然后 `/append`（CAS）。
  - 返回 event 给 Worker。
- **串行化**：同一 did 的 `/sign` 请求排队（DO 单线程 + 显式队列）；避免两个 bsky.app 写同时让 signer 签出分叉。
- **超时/取消**：signer 不响应 → 504 `SignerTimeout`；signer 晚到的响应按 id 丢弃。
- **幂等**：requestId + commitCid 去重；重试同一请求不重复 append。
- **Hibernation**：signer socket 空闲可 hibernation；pending 请求存 SQLite，wake 后继续。第一版可以先不 hibernation（单 owner socket 成本可接受）。

### 4.2 Signer tab

复用现有 `/app/` 的 key/repo 逻辑，新增一个 `signer` 模式：

- 解锁 key（PBKDF2+AES-GCM）→ 连接 WebSocket（token + did）→ 显示 connected。
- 收到 `sign`：
  1. 拿当前 repo：本地缓存 + `getRepo`/`getHead` 增量，或 DO 直接带 `expectedHead`/blocks；校验 `repo.getHead()` 与 `expectedHead` 一致。
  2. `Repo.applyWrite/applyWrites`（复用 `src/repo-core.js`）；
  3. `signP256`；`buildCar`；构造 event；
  4. 回 `{type:'signed', id, event}`。
- **策略引擎**（关键）：
  - 默认允许：`app.bsky.feed.post` create、`app.bsky.feed.like` create、`app.bsky.feed.repost` create、`app.bsky.graph.follow` create、`app.bsky.actor.profile` update。
  - 默认拒绝/需确认：delete、未知 collection、超大 record、`app.bsky.graph.block` 等敏感操作。
  - 速率：例如 120 次签名/分钟；突发告警。
  - 活动日志：每条签名显示 collection/action/rkey/摘要；用户可审计/撤销 token。
  - 可选 "confirm each write" 模式（安全但 UX 差）；默认 auto-approve + 可见日志。
- **锁定/离线**：signer 未解锁 → 回 `error:'SignerLocked'`；DO 返回 503，bsky.app 显示失败。读/登录不受影响。

### 4.3 Worker 写端点

复用 M3 的 `src/writes.js`，把 signing backend 抽象成：

- `worker-key`（M3）：`Repo.applyWrite(signP256(workerKey))`。
- `remote-signer`（M1.5）：`POST DO /sign`，拿回 event；不加载 repo、不签名。
- 响应构造相同：`{uri, cid, commit:{cid,rev}, validationStatus}`。
- `uploadBlob` 不变（Worker 存 blob，不需要 signer）。
- `applyWrites`：把 normalized writes 整体发给 signer，signer 一次 commit。

### 4.4 Enrollment

新增 `com.atproto.worker.bootstrapSignerAccount`（owner-only，`BOOTSTRAP_TOKEN`）：

- body `{did, handle, password, publicKeyMultibase, signerTokenHash, pdsEndpoint?}`。
- 校验 `did:web:<handle>`；publicKeyMultibase 是 P-256 `zDna...`。
- 创建 account（mode=`remote-signer`）、repo_keys（public key, no private key）、password hash。
- 返回 didDoc（含 owner public key）。
- 浏览器发布 didDoc → 打开 signer → 连接。

> 注意：signer token hash 由浏览器生成 token 后计算；Worker 只存 hash。也可以让 Worker 生成 token 并返回一次（更简单），但 token 会经过网络/响应；用 HTTPS + 一次性显示可接受。首版建议浏览器生成。

---

## 5. 安全模型：signing oracle 的边界

这是 M1.5 最重要的一节。

### 5.1 好消息

- Worker **永远拿不到私钥**；即使 Worker/DO/数据库完全失守，也无法离线伪造 commit。
- signer 离线/关闭时，Worker 无法签名；攻击者只能读/登录，不能写。
- 每次签名都要经过浏览器；signer 可以看到所有请求并记录。

### 5.2 坏消息

- **Worker 在线时可以借 signer 的手签名**。被攻破的 Worker 可以：
  - 伪造一个 bsky.app 写请求，让 signer 签一条攻击者想要的内容；
  - 在用户不知情时点赞/关注/发帖（如果策略 auto-approve）；
  - 反复请求签名（DoS/刷量）。
- 这比 M3 好（M3 可离线伪造、无需浏览器），但比 M1 差（M1 的 Worker 完全不能触发签名）。
- **signer 无法知道"用户意图"**：它只能看到 Worker 发来的 writes。Worker 是唯一的信息源，所以策略/确认是唯一防线。

### 5.3 缓解

1. **策略引擎**：collection/action 白名单、delete/敏感操作需确认、大小/速率限制。
2. **可见审计**：signer 显示每条签名；用户可以随时看"最近签名"，发现异常后 revoke token / 换 key。
3. **可选逐条确认**：高风险操作（delete、profile、block）必须点确认；低风险（post/like/follow）auto-approve。
4. **时间窗口**：解锁后 auto-approve 15 分钟，之后需要重新确认；降低长时间被滥用的窗口。
5. **多因子**：passkey/WebAuthn 用于解锁/高风险确认（不能直接签 atproto commit，但可以 gate）。
6. **限流**：signer 侧 + DO 侧双限流；异常突发直接断开。
7. **token 轮换**：发现异常 → revoke signer token → 重新 enrollment；Worker 无法再请求签名。
8. **独立托管 signer 页面**：不要让 Worker 托管签名页（Worker 被攻破可替换 JS）；用独立静态站 + CSP + 固定版本。signer token 和 key 只在该 origin。

**结论**：M1.5 的安全承诺应写成"**Worker 不能窃取密钥，也不能离线伪造；但在线时可作为受限 signing oracle**"，而不是"Worker 完全不能签名"。

---

## 6. 可用性 / 延迟 / 移动端

| 场景 | 行为 |
|---|---|
| signer tab 在线且解锁 | 写操作正常，RTT 约 100-500ms（含 repo 拉取/签名） |
| signer tab 在线但锁屏 | 返回 `SignerLocked`；bsky.app 显示失败；读/登录正常 |
| signer tab 关闭/休眠 | 返回 `SignerUnavailable`（快速 503）；读/登录正常 |
| 移动端后台 | 浏览器可能挂起 tab/断 WebSocket；写操作不可靠；建议桌面/扩展 |
| 多设备 | 每 DID 只允许一个活跃 signer（epoch/leader）；旧连接被替换 |
| 并发写 | DO 按 did 串行；signer 顺序签；晚到响应丢弃 |
| AppView 超时 | proxy 30s；signer 10s 超时；快速失败优先 |
| signer 卡顿 | 504 `SignerTimeout`；bsky.app 可重试；DO 不 append |

**UX 建议**：

- signer tab 固定/置顶；显示 badge（connected/unlocked/pending/last signed）。
- 提供 "copy signer URL" / "open signer" 按钮。
- 移动端明确提示"官方客户端写操作需要桌面 signer 在线"。
- 可选浏览器扩展（M1.5b）解决后台保活。

---

## 7. 与 M1 / M3 的对比

| | M1 owner-signed | **M1.5 remote signer** | M3 worker-signed |
|---|---|---|---|
| repo key | owner 浏览器/CLI | **owner 浏览器** | Worker |
| 官方 bsky.app | ❌ | **✅（signer 在线）** | ✅ |
| 自有 `/app/` 写 | ✅ | ✅ | 可选（走 session） |
| Worker 离线伪造 | ❌ | **❌** | ✅ |
| Worker 在线 signing oracle | ❌ | **✅（受策略限制）** | ✅（直接签） |
| 需要浏览器常开 | 写时需要（直接 `/app/`） | **写时需要（signer tab）** | 否 |
| 额外延迟 | 无 | **+1 RTT（签名桥）** | 无 |
| 复杂度 | 低 | **中高（DO bridge + signer + 策略）** | 高（M3 已实现） |
| 移动端 | 可用（直接页面） | **不可靠** | 可用 |
| 适合 | 个人、自有 UI、最强 custody | **拒绝 key 上云、但仍想用官方 app** | 想要官方 app + 无人值守 |

**建议**：

- 已经把 M3 做出来了，**最短路径仍是 M3**（key 在 Worker，官方客户端可用，无需常开浏览器）。
- 但如果 owner 坚持"key 永不离开浏览器"，M1.5 是唯一能同时满足"官方客户端 + 不自持 key"的形态；值得实现为可选 mode。
- M1.5 可以复用 M3 的 90%：sessions/JWT/password、标准写端点、blobs、ledger/read/firehose。新增的主要是 **Signer DO + signer tab + 策略**。
- M1.5 也是 M1 的自然升级：主账号的 DID key 不变，只需加 signer enrollment + mode 标记，**不需要换 DID key**（这是相比 M3 迁移的巨大优势）。

---

## 8. 实施计划（建议）

### P0：验证 AppView/超时/DO 长请求（1-2 天）

- 用本地 Worker + 一个假 bsky.app 客户端（curl）模拟 `createRecord`，在 Worker 里故意等 5-10s，确认 AppView/客户端超时行为（参考 30s proxy timeout）。
- 验证 DO 能否在持有 HTTP 请求的同时，通过 WebSocket 给 signer 发消息并 await 响应；测 1/5/10s。
- 验证 WebSocket Hibernation 下 pending 请求的可行性；第一版可以不用。

### P1：Signer DO + 协议（3-5 天）

- `Signer` DO（或 Firehose `/signer`）：`/signer/ws`、`/sign`、queue、timeout、幂等、per-DID 串行、验签/append。
- signer token enrollment/验证/撤销。
- 单测：无 signer 503、超时 504、晚到响应丢弃、验签失败拒绝、并发串行。

### P2：signer tab（3-5 天）

- 复用 `/app/` 的 key/repo 逻辑，新增 signer 模式：WebSocket 连接、签名请求处理、repo 拉取/缓存、`applyWrite/applyWrites`、CAR/event 返回。
- 策略引擎：白名单/黑名单、delete/敏感操作确认、速率、日志、时间窗口。
- 断线重连、unlock 状态、badge。

### P3：Worker 写端点接入（2-3 天）

- `src/writes.js` 增加 `remote-signer` backend：不加载 repo、不签名，调用 DO `/sign`；响应构造复用。
- `bootstrapSignerAccount`；mode 检查；`uploadBlob` 不变。
- `applyWrites` 转发。
- 单测：create/put/delete/applyWrites 走 signer；signer 离线 503；签名错误 401/502。

### P4：本地 E2E（2-3 天）

- Playwright 启动一个 headless signer tab（真实 WebCrypto P-256），连到本地 Worker/DO。
- 模拟 bsky.app：bootstrap → createSession → createRecord → signer 签 → getRecord/head → refresh/delete。
- 测 signer 离线、锁定、超时、并发、409/重试。
- 这是 M1.5 的核心验收；真实 bsky.app E2E 需要部署 + did:web。

### P5：硬化（2-3 天）

- 策略/确认 UI、限流、审计日志、token 轮换、独立托管/CSP。
- 扩展形态（可选）。

**总计约 2-3 周**，与 M3 首版相当；但新增代码集中在 Signer DO + signer tab，M3 的 sessions/writes/blobs 可直接复用。

---

## 9. 风险与开放问题

| 风险 | 影响 | 缓解 |
|---|---|---|
| Worker 是 signing oracle | 在线时可被借手签名 | 策略/确认/限流/审计/token 撤销；明确安全承诺 |
| signer 必须在线 | 移动端/关闭 tab 时写失败 | 桌面 tab/扩展；快速 503；读/登录不受影响 |
| 签名延迟 | bsky.app 写慢/超时 | 亚秒级 RTT；10s 超时；快速失败 |
| DO 长请求 | 占用/超时/驱逐 | 30s proxy 上限内；pending 存 SQLite；可降级 |
| WebSocket 断线 | 写失败 | 重连/心跳；DO 检测 close；快速失败 |
| 多设备 fork | 分叉 | 每 DID 单 active signer + epoch；DO 串行 + CAS |
| 第三方存储分区 | iframe key 不可用 | 用顶层 tab/扩展，不用 iframe 存 key |
| 页面被替换 | signing oracle 扩大 | signer 独立托管 + CSP + SRI/固定版本 |
| bsky.app 的 CSP/iframe | 注入 UI 失败 | 不依赖 iframe；bookmarklet/扩展可选 |

**开放问题**：

1. 目标用户是否接受"写操作需要桌面 signer 在线"？如果不接受，M3 更合适。
2. signer 页面托管在哪：Worker 的 `/app/`（方便但信任 Worker）还是独立静态站（推荐）？
3. 默认 auto-approve 的范围/时间窗口？delete/profile 是否强制确认？
4. 是否做浏览器扩展（M1.5b）来解决后台保活？
5. Signer DO 是复用 Firehose 还是新 DO？第一版建议复用（少一个绑定/迁移）。
6. 是否把 M1 主账号直接升级到 M1.5（key 不变，只加 signer enrollment）？这比 M3 迁移便宜得多。
7. 如果 M1.5 和 M3 都保留，UI 如何表达"这个账号的写操作是否需要 signer 在线"？

---

## 10. 参考

- AppView proxy timeout：`thirdparty/atproto/packages/bsky/src/config.ts:632-637`（30s）
- 标准写端点/会话：`thirdparty/atproto/packages/pds/src/api/com/atproto/{server,repo}/`
- 本项目 M1：`docs/ADR/040`、`docs/phase6.md`
- 本项目 M3：`docs/ADR/041`、`docs/phase7.md`、`src/auth.js`、`src/writes.js`、`src/blobs.js`
- 本项目 signer 可复用的浏览器 repo 逻辑：`src/repo-core.js`、`app/main.js`、`src/keys.js`
- Durable Objects WebSocket/Hibernation：现有 `src/firehose.js` 的订阅/backfill 实现

---

## 11. 一句话总结

**iframe/SW 不是桥，WebSocket signer 才是。** Worker 同时面对 bsky.app 和 owner 浏览器：它拿到标准 XRPC 写请求，转给浏览器签 commit，验签后写账本，再把标准响应还给 bsky.app。私钥不离开浏览器；代价是 signer 必须在线，且 Worker 在线时是一个受策略约束的 signing oracle。这是 M1 和 M3 之间一个真实、优雅、但需要谨慎设计的中间态。
