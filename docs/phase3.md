---
title: 第三阶段改动
desc: 基于项目现状的完整评估与后续协作清单
---

## 当前项目状态

这个项目的核心方向已经成型：本地生成和签名 journal，Worker 保持只读，通过 XRPC 和 firehose 对外发布。这条线是清晰的，`CID`、`CBOR`、journal chain、Cloudflare Worker 和 Durable Object 的最小拼装也已经落地，当前 `npm test` 在本机环境下可以通过。

但如果以“可以公开部署、可以让别人接手、可以对外宣称是一个可用的 atproto/bsky publisher”为标准，这个仓库现在仍然更接近原型。当前主要阻断点不是“还缺几个 endpoint”，而是安全边界、身份模型、数据可信性、文档可接手性这几条基础约束还没有收紧。后续协作按“一个段落一个 issue”的方式推进，每个段落内部维护 TODO，解决时直接勾掉，并在段尾补充代码反馈。

## 协作规则

每个 issue 都按下面的节奏推进：

- 写issue只描述问题和story，讲好为什么。不要提前填写todo微操指挥。因为真正实施可能会有变化。
- 实施代码改动的人，从项目初衷出发，再排查本段问题是否仍然成立，然后新增或者修订todo
- 在当前代码上施工，完成后把对应 TODO 勾掉，末尾记录完成时间精确到分钟
- 如果实现过程中发现问题描述需要修正，直接【追加】到本段正文，追加记录以时间开头，精确到分钟
- issue 完成后，如有值得反馈的，新增 代码反馈 挨个列出。给下一阶段接手的提个醒

## Issues

### issue 3-01 密钥泄露与本地机密管理

【严重】仓库当前直接提交了私钥材料，安全边界已经失守。[config.json](../src/config.json:4) 包含明文 `privateKey`，而 CLI 在 [cli/seal.js](../src/cli/seal.js:96) 又明确声明该文件必须保密。与此同时，[.gitignore](../src/.gitignore:1) 没有忽略 `config.json` 和 `journal.ndjson`。如果这把 key 对应真实 DID，则应视为已经泄露；即便只是测试 key，当前仓库形态也会诱导后续协作者重复犯错。这个问题不解决，后续任何部署讨论都不成立。

- [ ] 讨论修改方案，兼顾开发遍历和部署安全。

代码反馈：

- 暂无。

### issue 3-02 Worker 未校验远端 journal 可信性

【高】Worker 侧把远端 journal 当作可信输入使用，但当前并没有做完整性校验。[src/journal.js](../src/src/journal.js:31) 中的 `load()` 和 `refresh()` 只负责读取、解析、建立索引和写入 KV；真正的链校验只存在于本地 CLI 的 [cli/journal.js](../src/cli/journal.js:95)。这意味着一旦静态托管源、CDN、对象存储、发布流程或缓存被污染，Worker 会把伪造事件直接作为真实 repo 向外暴露。项目既然把“静态文件 + 不可信托管”当作核心卖点，这个缺口必须补上。

- [ ] 统一定义 Worker 与 CLI 共用的 journal 校验逻辑，避免两套实现长期漂移。
- [ ] 在 Worker 加载和刷新 journal 时校验 `prev` 链和 CID 一致性。
- [ ] 明确是否需要校验签名；如果暂不做，必须在文档中写清楚信任边界。
- [ ] 约定校验失败时的行为：拒绝加载、保留旧缓存、返回错误、记录日志。
- [ ] 增加覆盖篡改 journal、断链 journal、CID 不一致 journal 的测试。

代码反馈：

- 暂无。

### issue 3-03 DID 身份模型和文档输出不一致

【高】当前身份模型有自相矛盾的风险。根入口和 `/.well-known/atproto-did` 使用的是 `OWNER_DID` [src/index.js](../src/src/index.js:40)，但 `/.well-known/did.json` 会无条件生成 `did:web:${host}` [src/did.js](../src/src/did.js:20)。只要 `OWNER_DID` 不是当前 host 的 `did:web`，这两个出口就会返回不同身份。这个问题会直接影响 handle 解析、DID 文档可信性和后续跨实现兼容性。

- [ ] 明确项目当前只支持哪一种身份模式：仅 `did:web`，还是允许外部配置任意 DID。
- [ ] 如果只支持 `did:web`，收紧配置和文档，避免 `OWNER_DID` 自由填写造成假象。
- [ ] 如果允许自定义 DID，重新设计 `did.json` 和相关 well-known 行为，避免输出伪造的 `did:web` 文档。
- [ ] 为 identity 相关 endpoint 增加一致性测试，覆盖 `atproto-did`、`did.json`、`resolveHandle` 三者联动。
- [ ] 把身份模型写进 README，明确部署者需要满足的域名和 DID 前提。

代码反馈：

- 暂无。

### issue 3-04 CLI 记录生成存在错误数据和未完成能力

【中高】本地写入链路虽然已经可用，但还存在明显的错误实现和未兑现能力。[cli/seal.js](../src/cli/seal.js:190) 中 `like` 的 `subjectCid` 目前是硬编码占位值，会生成不可信记录；同一个文件头部注释写了 `repost`，但命令分发中没有对应实现 [cli/seal.js](../src/cli/seal.js:5)。如果这个 CLI 是唯一写入口，就不能容忍“看起来能用，实际写错数据”的状态。

- [ ] 修正 `like` 的 subject CID 处理，至少保证不会写入硬编码假值。
- [ ] 明确 `like`/`follow`/未来 `repost` 所需输入格式，必要时增加参数校验。
- [ ] 决定是否补齐 `repost`，或从帮助文本和注释中移除未实现承诺。
- [ ] 增加针对 CLI 产出记录结构的测试，而不是只验证 journal 追加行为。
- [ ] 评估是否需要把 TID 生成逻辑抽到共享模块，避免 CLI 和 Worker 侧重复定义。

代码反馈：

- 暂无。

### issue 3-05 interactions 目前只有抓取日志，没有形成可用能力

【中高】README 和架构文档都把“接收 interactions”当作项目目标，但当前实现只做到“定时去公共 API 拉一遍然后打印日志”。[src/interactions.js](../src/src/interactions.js:11) 里没有持久化，没有读取接口，也没有和用户可见行为形成闭环；[wrangler.toml](../src/wrangler.toml:9) 也没有为 interactions 单独准备存储绑定。就现状看，这部分更像探路代码，而不是功能。

- [ ] 明确 interactions 的目标范围：只做观测、做缓存、还是要作为对外可读数据能力。
- [ ] 如果要保留这条线，补上持久化方案和对应的读取接口。
- [ ] 如果暂时不做，收敛 README 和文档表述，避免继续把它描述成已实现能力。
- [ ] 为 cron 行为和失败重试策略补文档，避免把外部 API 调用当作理所当然的稳定依赖。
- [ ] 检查 `syncFollowers` 等未接入逻辑是否应继续保留。

代码反馈：

- 暂无。

### issue 3-06 测试体系通过，但可移植性和覆盖面不足

【中】当前测试在本机环境可以通过，但体系本身还有明显脆弱点。`interop` 测试依赖硬编码绝对路径 `/Users/me/edev/atproto-interop-tests` [tests/interop.test.js](../src/tests/interop.test.js:7)，这不适合作为协作仓库的默认测试前提。另一方面，WebSocket firehose 的测试脚本存在，但没有纳入 `npm test` [tests/test-ws.js](../src/tests/test-ws.js:1) [package.json](../src/package.json:13)。这会导致“核心协议都测过了”的印象强于实际覆盖。

- [ ] 去掉测试中的本机绝对路径依赖，改成可配置路径或仓库内 fixture。
- [ ] 明确 interop 测试在默认开发流程中是否必跑；如果不是，拆成独立命令。
- [ ] 把 firehose 测试纳入自动化，或明确标记为手工验证脚本。
- [ ] 补充 Worker 端 endpoint 测试，而不是只测纯函数和本地 journal。
- [ ] 在文档中区分“单元测试通过”和“端到端协议兼容已验证”。

代码反馈：

- 暂无。

### issue 3-07 refresh 与广播逻辑默认依赖严格 append-only 发布

【中】当前 `/refresh` 通过“刷新前事件数”和“刷新后数组切片”来计算新增事件 [src/index.js](../src/src/index.js:47)。这个实现隐含了一个很强的前提：上游 journal 永远只追加、不重排、不重写、不补历史。项目理念本身确实主张 append-only，但代码没有显式保护这个前提，文档也没有把违反前提时的后果写清楚。只要发布流程稍有偏离，firehose 增量广播就可能漏事件或错事件。

- [ ] 把“journal 必须严格 append-only”写成显式约束，而不是隐含约定。
- [ ] 评估广播新增事件时是否应该基于 offset/CID 差异而不是数组长度。
- [ ] 明确 journal 回滚、重写或补历史时 Worker 的处理策略。
- [ ] 为 refresh 场景补测试，覆盖纯追加和非追加两类输入。
- [ ] 在部署文档中写清楚发布流程不能做的事情。

代码反馈：

- 暂无。

### issue 3-08 firehose 输出是最小实现，但协议兼容性边界不清楚

【中】当前 firehose 是一个“最小可推送 commit 消息”的实现，但文档措辞容易让人误以为已经完整兼容。比如 `#commit` 事件中 `blocks` 永远为空 [src/firehose.js](../src/src/firehose.js:118)，这对于需要真实 CAR blocks 的消费者并不充分。这个选择未必错误，但必须清楚标注为能力边界，而不是让使用者自行踩坑。

- [ ] 明确当前 firehose 的目标兼容级别，是演示版、最小订阅版，还是要追求更完整的 relay/PDS 兼容。
- [ ] 把 `blocks` 为空的语义和限制写进文档。
- [ ] 增加至少一个真实客户端或兼容基准的验证记录，确认当前输出到底能被哪些消费者接受。
- [ ] 如果后续要补 CAR blocks，先写设计说明，避免直接在现有格式上继续堆补丁。

代码反馈：

- 暂无。

### issue 3-09 README 与现状严重脱节，仓库不可自解释

【中】README 目前几乎不能指导任何协作者落地运行，且内容和代码状态明显脱节。[README.md](../src/README.md:42) 仍然写着 “the actual code”，没有安装、配置、运行、部署、密钥管理、journal 发布、测试说明。另一个文档 [docs/Walkthrough.v2.md](../src/docs/Walkthrough.v2.md:34) 虽然更接近实现，但里面也有偏乐观的“已验证”表述。项目现在缺的不是更多零散说明，而是一份真实反映现状的主入口文档。

- [ ] 重写 README，使其成为新的协作和接手入口。
- [ ] 把“概念目标”“当前已实现能力”“未实现能力”“已知限制”明确分开。
- [ ] 补最小启动流程：本地初始化、生成 journal、启动 Worker、本地验证。
- [ ] 补部署流程：静态托管、Worker 配置、刷新机制、身份配置。
- [ ] 统一 README 与 `Walkthrough`、`PLAN`、本文件之间的角色分工，避免内容重复漂移。

代码反馈：

- 暂无。

## 补充记录

这里用于记录跨 issue 的新发现、回退说明或协作约定变更。如果某次代码修改让原始问题判断发生变化，优先更新对应 issue 段落，再在这里补一条摘要说明。

- 暂无。
