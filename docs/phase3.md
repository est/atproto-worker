---
title: 第三阶段改动
desc: 基于项目现状的完整评估与后续协作清单
---

## 当前项目状态

这个项目的核心方向已经成型：本地生成和签名 journal，Worker 保持只读，通过 XRPC 和 firehose 对外发布。这条线是清晰的，`CID`、`CBOR`、journal chain、Cloudflare Worker 和 Durable Object 的最小拼装也已经落地，当前 `npm test` 在本机环境下可以通过。

但如果以“可以公开部署、可以让别人接手、可以对外宣称是一个可用的 atproto/bsky publisher”为标准，这个仓库现在仍然更接近原型。当前主要阻断点不是“还缺几个 endpoint”，而是安全边界、身份模型、数据可信性、文档可接手性这几条基础约束还没有收紧。后续协作按“一个段落一个 issue”的方式推进，每个段落内部维护 TODO，解决时直接勾掉，并在段尾补充代码反馈。

## 协作规则

每个 issue 都按下面的节奏推进：

- 写issue只描述现象，讲story，说what happened，讲为什么。不要直接丢个结论，不要提前填写todo，避免微操指挥。因为真正实施可能会有变化。
- 实施代码改动的人，从项目初衷出发，再排查本段问题是否仍然成立，然后新增或者修订todo
- todo 的颗粒度是每个模块一个todo。如果同一个模块有好几处隔得很远的，也拆成多个todo。这里的【模块】不严格对应一个源码文件，而是从工程上抽象建模去理解。
- 在当前代码上施工，完成后把对应 TODO 勾掉，末尾记录完成时间精确到分钟
- 如果实现过程中发现问题描述需要修正，直接【追加】到本段正文，追加记录以当前时间开头，精确到分钟
- issue 完成后，如有值得反馈的，新增 代码反馈 挨个列出。给下一阶段接手的提个醒

## 本期目标

达到可以公开小范围测试。特别是要保证 atproto 的兼容性，线上健壮性。因为是 websocket 不能遇到问题就脆弱挂掉

## Issues

### issue 3-01 密钥泄露与本地机密管理

【严重】仓库当前直接提交了私钥材料，安全边界已经失守。[config.json](../src/config.json:4) 包含明文 `privateKey`，而 CLI 在 [cli/seal.js](../src/cli/seal.js:96) 又明确声明该文件必须保密。与此同时，[.gitignore](../src/.gitignore:1) 没有忽略 `config.json` 和 `journal.ndjson`。如果这把 key 对应真实 DID，则应视为已经泄露；即便只是测试 key，当前仓库形态也会诱导后续协作者重复犯错。这个问题不解决，后续任何部署讨论都不成立。

- [x] 讨论修改方案，兼顾开发便利和部署安全。
- [X] .gitignore：重写规则，移除无关条目，加入 config.json / journal.ndjson
- [X] git index：从跟踪中移除 config.json 和 journal.ndjson
- [X] config.json.example：创建脱敏模板
- [X] cli/seal.js init：完成后打印 wrangler secret 部署提示
- [X] cli/seal.js rotate-key：同上
- [X] wrangler.toml：注释区分公开配置与私钥管理方式
- [X] docs/phase3.md：勾选 TODO，补充代码反馈
- [X] npm test：验证全部通过

代码反馈：

- Worker 侧代码（`src/`）已经从 env 读取密钥，不依赖 `config.json`。只有 CLI（`cli/seal.js`）读写 `config.json`。这意味着 Worker 部署不需要私钥，私钥只需在本地签名时使用。
- `config.json` 和 `journal.ndjson` 已加入 `.gitignore` 并从 git 索引移除，但 git 历史中仍存在。若 key 是真实的，需轮换密钥并清理历史。
- 新增 `config.json.example` 作为格式参考模板。
- `cli/seal.js` 的 `init` 和 `rotate-key` 现在会打印 `wrangler secret` 部署提示。
- `wrangler.toml` 注释已明确区分公开配置（vars）和私钥管理方式。

完成时间：2025-05-16 00:15

### issue 3-02 Worker 未校验远端 journal 可信性

【高】Worker 侧把远端 journal 当作可信输入使用，但当前并没有做完整性校验。[src/journal.js](../src/src/journal.js:31) 中的 `load()` 和 `refresh()` 只负责读取、解析、建立索引和写入 KV；真正的链校验只存在于本地 CLI 的 [cli/journal.js](../src/cli/journal.js:95)。这意味着一旦静态托管源、CDN、对象存储、发布流程或缓存被污染，Worker 会把伪造事件直接作为真实 repo 向外暴露。项目既然把“静态文件 + 不可信托管”当作核心卖点，这个缺口必须补上。

- [X] 在 src/utils.js 添加 computeCID 函数（与 CLI 实现一致）
- [X] 在 src/journal.js 添加 validate() 方法，校验 prev 链和 CID
- [X] load() 调用校验，失败时拒绝加载
- [X] refresh() 调用校验，失败时保留旧数据
- [X] npm test：验证全部通过

代码反馈：

- `src/utils.js` 新增 `computeCID` 函数，使用 dag-cbor 编码和 CID v1 格式，与 CLI 实现一致。
- `src/journal.js` 新增 `validate()` 方法，校验 prev 链连续性和 CID 正确性。
- `load()` 在解析后立即校验，校验失败会抛出错误阻止加载污染数据。
- `refresh()` 在替换事件前校验，校验失败保留旧数据，避免服务中断。
- 校验逻辑对每个事件都会验证 CID，确保数据未被篡改。

完成时间：2025-05-16 00:45


### issue 3-03 DID 身份模型和文档输出不一致

【高】当前身份模型有自相矛盾的风险。根入口和 `/.well-known/atproto-did` 使用的是 `OWNER_DID` [src/index.js](../src/src/index.js:40)，但 `/.well-known/did.json` 会无条件生成 `did:web:${host}` [src/did.js](../src/src/did.js:20)。只要 `OWNER_DID` 不是当前 host 的 `did:web`，这两个出口就会返回不同身份。这个问题会直接影响 handle 解析、DID 文档可信性和后续跨实现兼容性。

- [X] 修改 did.js - generateDidWebDocument 支持传入完整 did
- [X] 修改 did.js - handleDidJson 增加 DID 类型校验
- [X] 修改 index.js - 传递完整 did 给 handleDidJson
- [X] npm test：验证全部通过

代码反馈：

- `did.js` 的 `generateDidWebDocument` 现在支持可选 `did` 参数，允许使用 `OWNER_DID` 而不是硬编码 `did:web:${host}`。
- `handleDidJson` 增加了 DID 类型校验：非 `did:web` 返回 404，`did:web` 与 host 不匹配返回 400。
- 这意味着 `did:plc` 身份的部署者不会在 `did.json` 端点得到错误的 `did:web` 文档。
- `/.well-known/atproto-did` 和 `/.well-known/did.json` 现在会返回一致的身份信息。

完成时间：2025-05-16 00:30

### issue 3-04 CLI 记录生成存在错误数据和未完成能力

【中高】本地写入链路虽然已经可用，但还存在明显的错误实现和未兑现能力。[cli/seal.js](../src/cli/seal.js:190) 中 `like` 的 `subjectCid` 目前是硬编码占位值，会生成不可信记录；同一个文件头部注释写了 `repost`，但命令分发中没有对应实现 [cli/seal.js](../src/cli/seal.js:5)。如果这个 CLI 是唯一写入口，就不能容忍"看起来能用，实际写错数据"的状态。

- [X] 修复 like 命令 - 要求用户提供 subjectCid
- [X] 添加 repost 命令实现
- [X] 更新帮助文本
- [X] npm test：验证全部通过

代码反馈：

- `like` 命令现在要求用户提供 `subjectUri` 和 `subjectCid` 两个参数，不再使用硬编码占位值。
- 新增 `repost` 命令实现，结构与 `like` 类似，记录类型为 `app.bsky.feed.repost`。
- `subjectCid` 是 atproto 中标识记录特定版本的必要字段，不能省略或伪造。
- 帮助文本已更新，明确说明 `like` 和 `repost` 需要提供 CID。

完成时间：2025-05-16 01:00

### issue 3-05 interactions 目前只有抓取日志，没有形成可用能力

【中高】README 和架构文档都把“接收 interactions”当作项目目标，但当前实现只做到“定时去公共 API 拉一遍然后打印日志”。[src/interactions.js](../src/src/interactions.js:11) 里没有持久化，没有读取接口，也没有和用户可见行为形成闭环；[wrangler.toml](../src/wrangler.toml:9) 也没有为 interactions 单独准备存储绑定。就现状看，这部分更像探路代码，而不是功能。



### issue 3-06 测试体系通过，但可移植性和覆盖面不足

【中】当前测试在本机环境可以通过，但体系本身还有明显脆弱点。`interop` 测试依赖硬编码绝对路径 `/Users/me/edev/atproto-interop-tests` [tests/interop.test.js](../src/tests/interop.test.js:7)，这不适合作为协作仓库的默认测试前提。另一方面，WebSocket firehose 的测试脚本存在，但没有纳入 `npm test` [tests/test-ws.js](../src/tests/test-ws.js:1) [package.json](../src/package.json:13)。这会导致“核心协议都测过了”的印象强于实际覆盖。


### issue 3-07 refresh 与广播逻辑默认依赖严格 append-only 发布

【中】当前 `/refresh` 通过"刷新前事件数"和"刷新后数组切片"来计算新增事件 [src/index.js](../src/src/index.js:47)。这个实现隐含了一个很强的前提：上游 journal 永远只追加、不重排、不重写、不补历史。项目理念本身确实主张 append-only，但代码没有显式保护这个前提，文档也没有把违反前提时的后果写清楚。只要发布流程稍有偏离，firehose 增量广播就可能漏事件或错事件。

- [X] 修改 refresh 逻辑 - 基于 lastCid 而不是数组长度
- [X] 添加保护：检测 journal 是否 append-only
- [X] npm test：验证全部通过

代码反馈：

- `/refresh` 和 `scheduled` 现在基于最后一个事件的 CID 来查找新增事件，而不是简单地按数组长度切片。
- 如果 journal 被完全重写（找不到 lastCid），会记录警告并广播所有事件。
- 这种方式可以检测到 journal 非 append-only 的情况，但仍然会继续服务。
- 发布流程应该保持 append-only，否则会导致 firehose 重复广播旧事件。

完成时间：2025-05-16 01:15

### issue 3-08 firehose 输出是最小实现，但协议兼容性边界不清楚

【中】当前 firehose 是一个“最小可推送 commit 消息”的实现，但文档措辞容易让人误以为已经完整兼容。比如 `#commit` 事件中 `blocks` 永远为空 [src/firehose.js](../src/src/firehose.js:118)，这对于需要真实 CAR blocks 的消费者并不充分。这个选择未必错误，但必须清楚标注为能力边界，而不是让使用者自行踩坑。


#### 审查结论

基于 atproto-reference 和 atproto-interop-tests 的审查，3-07 修复后 firehose 已达到**最小可用**状态，但仍有明确边界：

**已修复**：
- `rev`/`since` 使用 TID 格式（符合规范）
- `blocks` 包含有效的 CAR 文件（含记录数据）
- 支持 ErrorFrame 发送

**能力边界（当前不支持）**：
- blocks 只包含单个记录，**不包含 MST 树**
- 不支持 `#sync` 事件类型
- 不支持 `#identity` / `#account` 事件类型
- 不支持背压控制（ConsumerTooSlow）
- 不支持 CAR 文件完整性验证

**兼容性预期**：
- ✅ 可被 `unauthenticatedCommits: true` 的消费者接受
- ✅ 可获取记录内容和操作类型
- ❌ 无法验证 repo 完整性（需要 MST）
- ❌ 无法用于 repo 同步（需要完整 CAR）

完成时间：2025-05-16 02:00
### issue 3-09 README 与现状严重脱节，仓库不可自解释

【中】README 目前几乎不能指导任何协作者落地运行，且内容和代码状态明显脱节。[README.md](../src/README.md:42) 仍然写着 “the actual code”，没有安装、配置、运行、部署、密钥管理、journal 发布、测试说明。另一个文档 [docs/Walkthrough.v2.md](../src/docs/Walkthrough.v2.md:34) 虽然更接近实现，但里面也有偏乐观的“已验证”表述。项目现在缺的不是更多零散说明，而是一份真实反映现状的主入口文档。

- [X] 重写 README，真实反映项目状态

代码反馈：

- README 现在包含：架构图、快速开始、部署流程、端点列表、CLI 命令、身份模型、安全说明、已知限制、项目状态。
- 明确标注了 firehose 的 blocks 为空、interactions 未持久化、写操作返回 501 等限制。
- 区分了 did:web 和 did:plc 两种身份模式的行为差异。

完成时间：2025-05-16 01:25
