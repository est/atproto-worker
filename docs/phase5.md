# 从 bsky 用户视角：这个项目还缺什么

> 讨论稿（plan mode，未动代码）。目标：列出"普通 bsky 用户能用、这个项目不能"的能力，按用户影响排序，并标注每个缺口的架构代价，供选择方向。
>
> **后续（2026-11-09）**：WebCrypto P-256 + atproto 双曲线支持带来一条新路线，本文的 A/C 结论需要重读。见 `docs/phase6.md`（owner 自签 repo，Worker 退化为纯通道/活账本）。

## 现状：一个 bsky 用户现在能做什么

| 能力 | 现状 |
|---|---|
| 别人看到我的主页 | ✅ bsky.app 可见（appview 收录，postsCount 4） |
| handle / did 解析 | ✅ resolveHandle 200，relay active |
| 发帖（文字） | ⚠️ 只能本地 CLI：`seal.js post` → commit → deploy → refresh |
| 点赞/转发/关注 | ⚠️ 同 CLI（需要目标 URI+CID，操作不便） |
| 用官方 App / 任何客户端登录 | ❌ **完全没有**（无 createSession/密码/会话） |
| 客户端发帖 | ❌ 写端点全 501（ADR-014 设计如此） |
| 图片/视频帖子 | ❌ 无 blob 支持 |
| 资料页（头像/横幅/简介） | ❌ CLI 无 profile 命令 |
| 回复/引用/删除 | ❌ CLI 无 thread/quote/delete |
| 链接卡片/话题标签/提及 | ❌ CLI 不生成 facets/embed |
| 通知（谁赞了我/转了我） | ❌ interactions 只打日志（ADR-015），用户看不到 |
| 自己的时间线 | ❌ 无客户端、无 Web UI（ADR-013 是 draft） |
| DMs | ❌ 无 chat.bsky 支持 |
| 列表/信息流/启动包 | ❌ 记录型能力，CLI 未覆盖 |

## 缺口分类与架构代价

### A. 客户端接入（最大缺口，改变架构本质）
普通用户的一天：打开 App → 登录 → 刷时间线 → 发帖。本 PDS 卡在第一步。
- 需要：`com.atproto.server.createSession / getSession / refreshSession`（密码存哪？→ DO storage / SQLite，Firehose DO 已是 `new_sqlite_classes`）、JWT 校验中间件
- 写端点：`createRecord/putRecord/deleteRecord/uploadBlob` 需从 501 变为可用
- **核心张力**：静态资产 journal 不可变 → 客户端写 = 需要"活账本"。候选：DO SQLite 作为可追加账本（CLI/refresh 同步进去），静态资产退化为 seed/快照。这会重写"单一事实来源"的定义（ADR-002/ADR-014 需要新决策）
- 代价最大，收益也最大：项目从"能联邦的静态发布器"变成"真正可用的 PDS"

### B. 内容补全（小步、保持现有架构）
在 CLI 侧补齐 bsky 用户眼里的"正常账号"该有的东西：
- `profile` 命令（app.bsky.actor.profile：displayName/description/avatar/横幅——头像仍是 blob，受 D 限制）
- `reply`/`quote`（record 加 replyRef/embed.record 字段，纯记录，容易）
- `delete`（journal append delete 墓碑，协议支持）
- facets（链接/提及/话题标签解析）与 `embed.external`（链接卡片）
- 所有都是"记录"= journal 行，不碰 Worker 架构
- 代价：CLI 复杂度 + 每个命令一轮部署才生效

### C. Web UI（复活 ADR-013）
让发帖/查看不依赖命令行。但 Web UI 发帖撞上 ADR-005（私钥仅在本地）：Web UI 只能签名（私钥上 Worker，违背安全模型）或生成未签名记录交给 CLI —— 即时性全无。**结论：Web UI 的"写"价值被 A 覆盖，若做 A 则无需单独做 C；若不做 A，C 只能做只读面板（journal 状态、firehose 状态、记录列表）**

### D. Blobs（图片/视频）
bsky 内容大头是图片。需要：uploadBlob + blob 存储 + 图片代理/CDN。存储选型 R2（成本 vs "零依赖"目标的冲突，之前因成本否决过 R2）。**做 A 的写路径时一起评估；单独做价值有限（文字为主的话）**

### E. 展示层（通知/互动）
通知是 appview 能力，需要 auth（依赖 A）。互动数据展示：interactions 从 log-only 变成可查询（若做 A，可作为 `/api/interactions`；否则仍是日志）

## 建议优先级（需用户拍板）

1. **A 客户端接入** —— 让 PDS 名副其实（工作量最大，含 DO SQLite 活账本 + 密码/会话 + JWT + 写端点 + 架构 ADR）
2. **B 内容补全** —— 快速让账号"像正常人"（纯 CLI，保持静态架构，1-2 天量级）
3. **D blobs** —— 与 A 的写路径合并评估
4. **C/E** —— 依附于 A

## 待用户确认的方向问题

- 方向：A / B / 先 B 后 A / 只要 A / 只要 B？
- 若做 A：私钥上不上 Worker？（不上 = 客户端写仍需签名服务；上 = 违背 ADR-005）
- 成本约束：R2 blob 存储可接受吗？
