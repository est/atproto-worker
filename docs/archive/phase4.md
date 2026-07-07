---
title: 第四阶段改动（已归档）
desc: 简化新人上手流程，实现一键部署和 Web 管理界面
---

## 背景

当前项目对新人不友好：
- 需要理解 atproto、DID、CID、journal 等概念
- 需要安装 Node.js、使用命令行
- 需要手动配置 wrangler.toml、设置 secrets
- 需要单独托管 journal.ndjson
- 没有可视化界面

目标：**不懂技术的人也能 5 分钟内搭建自己的 PDS**

## 设计思路

### 方案 A：Cloudflare Deploy Button + Web UI

```
┌─────────────────────────────────────────────────────────┐
│  用户点击 "Deploy to Cloudflare" 按钮                    │
└─────────────────────────┬───────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│  Cloudflare 自动：                                       │
│  1. 创建 Worker                                          │
│  2. 创建 R2 Bucket (存储 journal)                        │
│  3. 创建 KV Namespace (缓存)                             │
│  4. 创建 Durable Object (firehose)                       │
│  5. 生成密钥对并存入 Secrets                              │
└─────────────────────────┬───────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│  用户访问 Worker URL，进入 Web 管理界面                   │
│  - 首次访问：设置 DID 和 Handle                          │
│  - 发帖、点赞、转发                                      │
│  - 查看 journal、验证链完整性                             │
│  - 查看 firehose 连接状态                                │
└─────────────────────────────────────────────────────────┘
```

### 方案 B：GitHub Template + Actions

```
┌─────────────────────────────────────────────────────────┐
│  用户点击 "Use this template" 创建仓库                    │
└─────────────────────────┬───────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│  GitHub Actions 自动：                                   │
│  1. 生成密钥对                                           │
│  2. 存储到 GitHub Secrets                                │
│  3. 部署到 Cloudflare                                    │
│  4. 配置 R2/KV/DO                                        │
└─────────────────────────┬───────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│  用户通过 GitHub Issues 或 PR 管理内容                    │
│  - Issue = 发帖                                          │
│  - PR = 批量更新                                         │
│  - GitHub Actions 自动签名并更新 journal                 │
└─────────────────────────────────────────────────────────┘
```

## Issues

### issue 4-01 Web 管理界面

【核心】实现基于 Web 的管理界面，替代命令行操作。

**功能需求**：
- 首次访问引导：设置 DID、Handle、生成密钥
- 发帖界面：输入文本，点击发布
- 记录列表：查看已发布的 posts、likes、follows
- Journal 状态：查看事件数量、链完整性
- Firehose 状态：查看连接数、最近广播

**技术方案**：
- 使用 Cloudflare Pages 或 Worker 内置静态文件服务
- 前端：纯 HTML/CSS/JS（无框架，保持简单）
- API：复用现有 XRPC 端点 + 新增管理端点

**新增端点**：
- `POST /api/post` - 创建帖子
- `POST /api/like` - 点赞
- `POST /api/follow` - 关注
- `GET /api/journal` - 获取 journal 状态
- `POST /api/journal/validate` - 验证 journal 完整性

- [ ] 设计 Web UI 布局和交互流程
- [ ] 实现静态文件服务（嵌入 Worker 或使用 Pages）
- [ ] 实现首次访问引导流程
- [ ] 实现发帖/点赞/关注界面
- [ ] 实现 journal 状态展示
- [ ] 实现 firehose 状态展示

### issue 4-02 内置 R2 存储

【高】将 journal 存储从外部静态托管改为内置 R2，消除单独托管需求。

**当前问题**：
- 用户需要单独配置 S3/GitHub Pages 等托管
- 需要手动触发 /refresh
- 增加了复杂度

**解决方案**：
- 使用 Cloudflare R2 存储 journal.ndjson
- Web UI 直接写入 R2
- Worker 从 R2 读取，无需 /refresh

**配置变更**：
```toml
[[r2_buckets]]
binding = "JOURNAL_BUCKET"
bucket_name = "atproto-journal"
```

- [ ] 添加 R2 bucket 绑定
- [ ] 修改 Journal 类支持 R2 读写
- [ ] 修改 Web UI 直接写入 R2
- [ ] 移除 JOURNAL_URL 配置
- [ ] 移除 /refresh 端点（或改为内部使用）

### issue 4-03 Cloudflare Deploy Button

【高】实现一键部署到 Cloudflare 的流程。

**实现方式**：
- 使用 Cloudflare 的 "Deploy to Cloudflare" 按钮
- 或使用 `wrangler deploy --interactive` 引导

**自动化内容**：
- 创建 Worker
- 创建 R2 Bucket
- 创建 KV Namespace
- 创建 Durable Object
- 生成密钥对并存入 Secrets
- 设置初始配置

**参考**：
- https://developers.cloudflare.com/deploy-to-cloudflare/
- https://github.com/cloudflare/workers-sdk

- [ ] 创建 wrangler.toml 模板（使用变量占位符）
- [ ] 创建部署脚本（wrangler deploy --interactive）
- [ ] 测试一键部署流程
- [ ] 编写部署文档

### issue 4-04 GitHub Template 仓库

【中】将项目转为 GitHub Template，支持 "Use this template" 一键创建。

**模板内容**：
- 完整的代码
- GitHub Actions 工作流
- Issue 模板（用于发帖）
- PR 模板（用于批量更新）
- README 和文档

**GitHub Actions 工作流**：
- `deploy.yml` - 部署到 Cloudflare
- `post.yml` - 通过 Issue 发帖
- `validate.yml` - 验证 journal 完整性

- [ ] 创建 .github/workflows/deploy.yml
- [ ] 创建 .github/ISSUE_TEMPLATE/post.md
- [ ] 创建 .github/workflows/post.yml
- [ ] 测试 GitHub Actions 流程
- [ ] 更新 README 说明模板使用方式

### issue 4-05 简化 DID 和域名配置

【中高】简化 DID 和域名配置，支持 did:web 自动配置。

**当前问题**：
- 用户需要理解 DID、did:web、did:plc 等概念
- 需要手动配置域名和 DNS
- 配置错误会导致身份不一致

**解决方案**：
- 提供默认的 did:web 子域名（如 `username.atproto-worker.workers.dev`）
- 自动配置 DNS 和证书
- 支持自定义域名（可选）

**流程**：
1. 用户输入用户名（如 `alice`）
2. 系统自动创建 `alice.atproto-worker.workers.dev`
3. 自动生成 DID：`did:web:alice.atproto-worker.workers.dev`
4. 自动配置 DID 文档

- [ ] 实现子域名自动分配
- [ ] 实现 DID 文档自动生成
- [ ] 实现 DNS 自动配置（使用 Cloudflare API）
- [ ] 支持自定义域名（可选）

### issue 4-06 移动端适配

【中】Web UI 适配移动端，支持手机操作。

**需求**：
- 响应式布局
- 触摸友好的交互
- PWA 支持（可安装到主屏幕）

- [ ] 使用响应式 CSS 框架（如 Pico CSS、Simple.css）
- [ ] 实现 PWA manifest
- [ ] 实现 Service Worker（离线支持）
- [ ] 测试移动端体验

### issue 4-07 文档和教程

【中】编写面向新手的文档和教程。

**内容**：
- 什么是 atproto/PDS（用简单语言解释）
- 5 分钟快速开始指南
- 视频教程
- 常见问题解答

**形式**：
- README 中的快速开始
- docs/ 目录下的详细文档
- 可选：视频教程链接

- [ ] 编写 "什么是 PDS" 解释
- [ ] 编写 5 分钟快速开始指南
- [ ] 编写常见问题解答
- [ ] 更新 README

## 预期效果

**当前流程**（8 步）：
1. 安装 Node.js
2. 克隆仓库
3. npm install
4. 配置 wrangler.toml
5. 生成密钥
6. 设置 secrets
7. 部署
8. 配置静态托管

**简化后流程**（3 步）：
1. 点击 "Deploy to Cloudflare"
2. 输入用户名
3. 开始发帖

**更简化**（GitHub 模板）：
1. 点击 "Use this template"
2. 配置 Cloudflare secrets
3. 推送代码自动部署
