/**
 * Deployment checklist page (served at /)
 * A step-by-step wizard for people who know nothing about atproto or
 * Cloudflare: after the one-click deploy button, this page tells you what
 * to do next, gives copy-paste commands, and live-checks federation.
 *
 * Identity is auto-derived from the deployed host (deploy-button friendly):
 *   did:web:<host> / handle = <host> — only OWNER_PUBLIC_KEY needs manual setup.
 */

import { isValidDID, isValidHandle } from './utils.js'

const PLACEHOLDERS = ['example.com', 'yourdomain.com', 'localhost']

function isPlaceholder(value) {
    return !value || PLACEHOLDERS.includes(value)
}

/**
 * Effective (possibly host-derived) identity values.
 */
export function effectiveIdentity(env, host) {
    const handle = env.OWNER_HANDLE || host
    const did = env.OWNER_DID || `did:web:${handle}`
    return { host, did, handle }
}

/**
 * Check each configuration item and collect the status.
 * Returns { checks, phases } where checks is a list of
 * { id, phase, label, status: 'ok'|'warn'|'missing', value, hint, command }
 */
export function checkSetup(env, journal, host) {
    const { did, handle } = effectiveIdentity(env, host)
    const checks = []

    // Phase 1 — 一键部署后自动就绪（无需操作）
    checks.push({
        id: 'firehose',
        phase: 1,
        label: 'Firehose (WebSocket) 就绪',
        status: env.FIREHOSE ? 'ok' : 'missing',
        value: env.FIREHOSE ? 'Durable Object 已绑定' : '未绑定',
        hint: '实时推送新事件给联邦网络（relay）的组件，随一键部署自动配置。',
        command: '若未绑定，请在 wrangler.toml 配置 [[durable_objects.bindings]] name = "FIREHOSE"'
    })

    const journalState = journal && journal.loaded
        ? `已加载 ${journal.events.length} 条事件`
        : '未加载'
    checks.push({
        id: 'journal',
        phase: 1,
        label: 'Journal 已加载（数据源就绪）',
        status: journal && journal.loaded ? 'ok' : (journal ? 'warn' : 'missing'),
        value: journalState,
        hint: 'Worker 从静态资源加载你的帖子账本并验证完整性（无 KV、无数据库）。',
        command: `curl https://${host}/refresh   # 手动触发重新加载`
    })

    checks.push({
        id: 'did',
        phase: 1,
        label: '身份 DID（自动识别）',
        status: isValidDID(did) && !isPlaceholder(handle) ? 'ok' : 'warn',
        value: did,
        hint: '你的 atproto 身份，已从部署域名自动推导为 did:web。无需配置。',
        command: ''
    })

    checks.push({
        id: 'handle',
        phase: 1,
        label: '用户句柄（自动识别）',
        status: isValidHandle(handle) && !isPlaceholder(handle) ? 'ok' : 'warn',
        value: handle,
        hint: '你的句柄，已从部署域名自动推导。无需配置。',
        command: ''
    })

    // Phase 2 — 唯一需要手动操作的一步：设置身份公钥
    const pubkey = env.OWNER_PUBLIC_KEY
    checks.push({
        id: 'pubkey',
        phase: 2,
        label: '身份公钥 OWNER_PUBLIC_KEY',
        status: pubkey && pubkey.startsWith('z') && pubkey.length > 10 ? 'ok' : (pubkey ? 'warn' : 'missing'),
        value: pubkey ? `${pubkey.slice(0, 12)}…` : '未设置',
        hint: '你的身份公钥（公开信息）。没有它，联邦网络无法验证你发的帖子。三步搞定：',
        command: '① 本地生成密钥对 → ② 复制 config.json 里的 publicKeyMultibase → ③ Dashboard 添加变量并部署（详见下方「下一步」卡片）'
    })

    // Phase 3 — 可选：外部托管 journal（默认用随 Worker 部署的静态资产，无需设置）
    const journalUrl = env.JOURNAL_URL
    checks.push({
        id: 'journal_url',
        phase: 3,
        label: 'JOURNAL_URL（可选，外部托管才需要）',
        status: journalUrl && journalUrl.startsWith('http') ? 'ok' : 'ok',
        value: journalUrl || '使用随 Worker 部署的静态资产（默认，无需配置）',
        hint: '只有把账本放到外部静态托管（如 GitHub Pages）时才需要设置；默认完全自包含。',
        command: journalUrl ? '' : `JOURNAL_URL = "https://${host}/journal.ndjson"`
    })

    return { checks, did, handle }
}

/**
 * Render the checklist page as a self-contained HTML wizard
 * (inline CSS, no external dependencies).
 */
export function renderChecklistPage(env, journal, host) {
    const { checks, did, handle } = checkSetup(env, journal, host)

    const okCount = checks.filter(c => c.status === 'ok').length
    const total = checks.length
    const pct = Math.round(okCount / total * 100)
    const firstMissing = checks.find(c => c.status !== 'ok')

    const rows = checks.map(c => {
        const icon = c.status === 'ok' ? '✅' : (c.status === 'warn' ? '⚠️' : '❌')
        const badge = c.status === 'ok'
            ? '<span class="badge ok">完成</span>'
            : (c.status === 'warn'
                ? '<span class="badge warn">注意</span>'
                : '<span class="badge miss">未完成</span>')

        const value = c.value
            ? `<div class="value">当前值：<code>${escapeHtml(c.value)}</code></div>`
            : ''
        const hint = c.hint
            ? `<div class="hint">${escapeHtml(c.hint)}</div>`
            : ''
        const command = c.status === 'ok' || !c.command ? '' : `
            <div class="cmd">
                <code>${escapeHtml(c.command)}</code>
                <button class="copy" data-cmd="${escapeHtml(c.command)}">复制</button>
            </div>`

        const phaseLabel = c.phase === 1 ? '一键部署（自动）' : (c.phase === 2 ? '身份配置（手动）' : '可选')
        return `<div class="check ${c.status}">
            <div class="row">
                <span class="icon">${icon}</span>
                <span class="label">${escapeHtml(c.label)}</span>
                <span class="phase">${phaseLabel}</span>
                ${badge}
            </div>
            ${value}
            ${hint}
            ${command}
        </div>`
    }).join('\n')

    // 下一步指引：根据第一个未完成项给出人话版操作步骤
    let nextStep = ''
    if (firstMissing && firstMissing.id === 'pubkey') {
        nextStep = `
        <div class="next">
            <h3>下一步：设置你的身份公钥（唯一需要手动的一步）</h3>
            <ol>
                <li><b>本地生成密钥对</b>（需要 Node.js，一次性）：复制下面的命令到终端执行
                    <div class="cmd"><code>git clone https://github.com/est/atproto-worker && cd atproto-worker && npm install && node cli/seal.js init did:web:${escapeHtml(host)} ${escapeHtml(host)}</code>
                    <button class="copy" data-cmd="git clone https://github.com/est/atproto-worker && cd atproto-worker && npm install && node cli/seal.js init did:web:${escapeHtml(host)} ${escapeHtml(host)}">复制</button></div>
                </li>
                <li><b>复制公钥</b>：打开生成的 <code>config.json</code>，复制 <code>publicKeyMultibase</code> 的值（以 <code>z</code> 开头）</li>
                <li><b>填到 Cloudflare</b>：Dashboard → 你的 Worker → <b>Settings → Variables and Secrets → 添加变量</b>：名称 <code>OWNER_PUBLIC_KEY</code>，值粘贴公钥 → <b>保存并部署</b></li>
                <li>回到本页刷新，此项即变绿 ✅</li>
            </ol>
        </div>`
    } else if (firstMissing && firstMissing.id === 'firehose') {
        nextStep = `<div class="next"><h3>下一步：重新部署</h3><p>一键部署应已自动配置 Firehose。若缺失，请点击本页顶部的 Deploy 按钮重新部署，或检查 wrangler.toml。</p></div>`
    } else if (!firstMissing) {
        nextStep = `
        <div class="next done">
            <h3>🎉 全部就绪！现在发布你的第一条帖子</h3>
            <ol>
                <li>本地执行（在刚才 clone 的目录里）：
                    <div class="cmd"><code>node cli/seal.js post "你好，atproto！"</code><button class="copy" data-cmd='node cli/seal.js post "你好，atproto！"'>复制</button></div>
                </li>
                <li>同步到部署资产：
                    <div class="cmd"><code>cp journal.ndjson public/journal.ndjson && git add public/journal.ndjson && git commit -m "post" && git push</code><button class="copy" data-cmd="cp journal.ndjson public/journal.ndjson && git add public/journal.ndjson && git commit -m "post" && git push">复制</button></div>
                </li>
                <li>让 Worker 广播给联邦（部署完成后执行）：
                    <div class="cmd"><code>curl https://${escapeHtml(host)}/refresh</code><button class="copy" data-cmd="curl https://${escapeHtml(host)}/refresh">复制</button></div>
                </li>
                <li>等待几分钟，点击下方「检查联邦收录」即可在 Bluesky 上看到你的帖子。</li>
            </ol>
        </div>`
    }

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>atproto-worker 部署向导</title>
<style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
        font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
        background: #f5f6f8; color: #1a1a2e; line-height: 1.6;
        padding: 24px 16px; max-width: 760px; margin: 0 auto;
    }
    h1 { font-size: 1.5rem; margin-bottom: 4px; }
    h3 { font-size: 1rem; margin-bottom: 10px; }
    .sub { color: #666; font-size: .9rem; margin-bottom: 20px; word-break: break-all; }
    .progress { background: #e5e7eb; border-radius: 999px; height: 14px; margin: 16px 0 8px; overflow: hidden; }
    .progress .bar { height: 100%; background: #22c55e; transition: width .3s; }
    .progress-text { font-size: .9rem; color: #444; margin-bottom: 4px; }
    .check {
        background: #fff; border: 1px solid #e5e7eb; border-radius: 10px;
        padding: 14px 16px; margin-bottom: 12px;
    }
    .check.ok { border-left: 4px solid #22c55e; }
    .check.warn { border-left: 4px solid #f59e0b; }
    .check.missing { border-left: 4px solid #ef4444; }
    .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .icon { font-size: 1rem; }
    .label { font-weight: 600; flex: 1; min-width: 180px; }
    .phase { font-size: .7rem; color: #888; border: 1px solid #d1d5db; border-radius: 999px; padding: 1px 8px; }
    .badge { font-size: .75rem; padding: 2px 10px; border-radius: 999px; }
    .badge.ok { background: #dcfce7; color: #15803d; }
    .badge.warn { background: #fef3c7; color: #b45309; }
    .badge.miss { background: #fee2e2; color: #b91c1c; }
    .value { margin-top: 6px; font-size: .85rem; color: #555; }
    .hint { margin-top: 4px; font-size: .85rem; color: #777; }
    .cmd {
        margin-top: 8px; display: flex; align-items: center; gap: 8px;
        background: #f1f5f9; border-radius: 6px; padding: 6px 10px;
    }
    .cmd code { font-size: .8rem; color: #0f172a; word-break: break-all; flex: 1; }
    .cmd button {
        border: none; background: #3b82f6; color: #fff; border-radius: 6px;
        padding: 4px 12px; font-size: .8rem; cursor: pointer; white-space: nowrap;
    }
    .cmd button:hover { background: #2563eb; }
    .next {
        background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px;
        padding: 16px; margin: 16px 0;
    }
    .next.done { background: #f0fdf4; border-color: #bbf7d0; }
    .next ol { margin: 8px 0 0 20px; }
    .next li { margin-bottom: 8px; font-size: .92rem; }
    .next .cmd { margin-top: 6px; }
    .fed {
        background: #fff; border: 1px solid #e5e7eb; border-radius: 10px;
        padding: 14px 16px; margin-top: 16px;
    }
    .fed .btn {
        border: none; background: #3b82f6; color: #fff; border-radius: 8px;
        padding: 8px 16px; font-size: .9rem; cursor: pointer; margin-right: 8px;
    }
    .fed .btn:hover { background: #2563eb; }
    .fed .result { margin-top: 10px; font-size: .85rem; }
    .fed .result div { padding: 4px 0; }
    .fed .result .ok { color: #15803d; }
    .fed .result .no { color: #b91c1c; }
    .fed .result .wait { color: #92400e; }
    footer { margin-top: 32px; font-size: .8rem; color: #999; text-align: center; }
    @media (prefers-color-scheme: dark) {
        body { background: #111827; color: #e5e7eb; }
        .sub { color: #9ca3af; }
        .progress { background: #374151; }
        .check, .fed { background: #1f2937; border-color: #374151; }
        .next { background: #172554; border-color: #1e40af; }
        .next.done { background: #052e16; border-color: #166534; }
        .value { color: #d1d5db; }
        .hint { color: #9ca3af; }
        .cmd { background: #111827; }
        .cmd code { color: #e5e7eb; }
        .progress-text { color: #d1d5db; }
        .phase { color: #9ca3af; border-color: #4b5563; }
        .fed .result .ok { color: #4ade80; }
        .fed .result .no { color: #f87171; }
        .fed .result .wait { color: #fbbf24; }
    }
</style>
</head>
<body>
    <h1>🛰️ atproto-worker 部署向导</h1>
    <div class="sub">${escapeHtml(host)} · 只读发布中转（签名在本地完成，Worker 不接触私钥）</div>

    <div class="progress-text">${okCount} / ${total} 项就绪</div>
    <div class="progress"><div class="bar" style="width:${pct}%"></div></div>

    ${nextStep}

    <h3 style="margin: 18px 0 10px;">配置状态</h3>
    ${rows}

    <div class="fed">
        <h3>🔍 检查联邦收录（发布后使用）</h3>
        <button class="btn" onclick="checkFed()">检查联邦收录</button>
        <div class="result" id="fed-result">点击按钮，检查你的身份在 Bluesky 联邦网络中的状态（需要已发布至少一条帖子）。</div>
    </div>

    <footer>atproto-worker · 事件溯源 · 本地签名 · 只读中转 · 一键部署</footer>
<script>
    document.querySelectorAll('.copy').forEach(btn => {
        btn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(btn.dataset.cmd)
                const old = btn.textContent
                btn.textContent = '已复制'
                setTimeout(() => btn.textContent = old, 1500)
            } catch (e) {}
        })
    })

    async function checkFed() {
        const host = location.host
        const did = 'did:web:' + host
        const box = document.getElementById('fed-result')
        box.innerHTML = '<div class="wait">检查中…（需要已发布帖子 + 等待联邦索引，通常 1-5 分钟）</div>'
        const rows = []
        const probe = async (label, url) => {
            try {
                const r = await fetch(url, { headers: { 'Accept': 'application/json' } })
                rows.push('<div class="' + (r.ok ? 'ok' : 'no') + '">' + label + '：HTTP ' + r.status + (r.ok ? ' ✅' : '（尚未收录，稍后再试）') + '</div>')
            } catch (e) {
                rows.push('<div class="wait">' + label + '：浏览器无法直接访问（CORS），可用 curl 验证</div>')
            }
        }
        await probe('身份解析 resolveHandle', 'https://api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=' + host)
        await probe('主页可见 getProfile', 'https://api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=' + did)
        await probe('relay 收录 getRepoStatus', 'https://bsky.network/xrpc/com.atproto.sync.getRepoStatus?did=' + did)
        rows.push('<div class="wait">curl 方式：curl "https://api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=' + did + '"</div>')
        box.innerHTML = rows.join('')
    }
</script>
</body>
</html>`

    return new Response(html, {
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            'Strict-Transport-Security': 'max-age=63072000'
        }
    })
}

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}
