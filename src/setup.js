/**
 * Deployment checklist page (served at /)
 * Dynamically inspects configuration state and guides the deployer
 * through each step to get the relay running.
 */

import { isValidDID, isValidHandle } from './utils.js'

const PLACEHOLDERS = ['example.com', 'yourdomain.com', 'localhost']

function isPlaceholder(value) {
    return !value || PLACEHOLDERS.includes(value)
}

/**
 * Check each configuration item and collect the status.
 * Returns a list of { id, label, status: 'ok'|'warn'|'missing', value, hint, command }
 */
export function checkSetup(env, journal) {
    const host = env.OWNER_HANDLE || env.OWNER_DID?.replace('did:web:', '') || 'your.workers.dev'
    const checks = []

    // 2. OWNER_DID
    const did = env.OWNER_DID
    checks.push({
        id: 'did',
        label: 'OWNER_DID 已配置且合法',
        status: did && !isPlaceholder(did) && isValidDID(did) ? 'ok' : (did ? 'warn' : 'missing'),
        value: did || '未配置',
        hint: '你的 atproto 身份 DID。用 did:web 时指向你的 Worker 域名。',
        command: 'wrangler.toml [vars] 中设置 OWNER_DID = "did:web:你的域名"'
    })

    // 3. OWNER_HANDLE
    const handle = env.OWNER_HANDLE
    checks.push({
        id: 'handle',
        label: 'OWNER_HANDLE 已配置且合法',
        status: handle && !isPlaceholder(handle) && isValidHandle(handle) ? 'ok' : (handle ? 'warn' : 'missing'),
        value: handle || '未配置',
        hint: '你的用户句柄（handle）。通常与 did:web 域名一致。',
        command: 'wrangler.toml [vars] 中设置 OWNER_HANDLE = "你的域名"'
    })

    // 4. OWNER_PUBLIC_KEY
    const pubkey = env.OWNER_PUBLIC_KEY
    checks.push({
        id: 'pubkey',
        label: 'OWNER_PUBLIC_KEY 已配置',
        status: pubkey && pubkey.startsWith('z') && pubkey.length > 10 ? 'ok' : (pubkey ? 'warn' : 'missing'),
        value: pubkey ? `${pubkey.slice(0, 10)}…` : '未配置',
        hint: 'CLI 生成密钥对后 config.json 里的 publicKeyMultibase。这是公开信息，不涉密。',
        command: 'node cli/seal.js init did:web:你的域名 你的域名，然后把 config.json 的 publicKeyMultibase 填入'
    })

    // 5. JOURNAL_URL
    const journalUrl = env.JOURNAL_URL
    checks.push({
        id: 'journal_url',
        label: 'JOURNAL_URL 已配置',
        status: journalUrl && journalUrl.startsWith('http') ? 'ok' : 'missing',
        value: journalUrl || '未配置',
        hint: 'journal.ndjson 的公开 URL。本项目用 Static Assets 托管，指向 Worker 自己的 /journal.ndjson。',
        command: `JOURNAL_URL = "https://${host}/journal.ndjson"`
    })

    // 6. Journal loaded
    const journalState = journal && journal.loaded
        ? `已加载 ${journal.events.length} 条事件`
        : '未加载'
    checks.push({
        id: 'journal',
        label: 'Journal 已加载',
        status: journal && journal.loaded && journal.events.length > 0 ? 'ok' : (journal && journal.loaded ? 'warn' : 'missing'),
        value: journalState,
        hint: 'Worker 从静态资源 ASSETS 加载 journal.ndjson 并验证链完整性（无 KV、无数据库）。',
        command: `curl https://${host}/refresh   # 手动触发重新加载`
    })

    // 7. atproto-did endpoint
    checks.push({
        id: 'atproto_did',
        label: '/.well-known/atproto-did 返回正确 DID',
        status: did && !isPlaceholder(did) ? 'ok' : 'warn',
        value: did ? `返回 ${did}` : '需先配置 OWNER_DID',
        hint: 'handle 解析用。访问 https://' + host + '/.well-known/atproto-did 应返回你的 DID。',
        command: `curl https://${host}/.well-known/atproto-did`
    })

    // 8. did.json endpoint
    const isDidWeb = did && did.startsWith('did:web:')
    checks.push({
        id: 'did_json',
        label: '/.well-known/did.json 有效 (did:web)',
        status: isDidWeb ? 'ok' : 'warn',
        value: isDidWeb ? `服务 ${did}` : '非 did:web（did:plc 不托管 did.json）',
        hint: 'did:web 身份验证文档。只对 did:web 身份返回。',
        command: `curl https://${host}/.well-known/did.json`
    })

    // 9. Firehose Durable Object
    checks.push({
        id: 'firehose',
        label: 'Firehose (WebSocket) 就绪',
        status: env.FIREHOSE ? 'ok' : 'missing',
        value: env.FIREHOSE ? 'Durable Object 已绑定' : '未绑定',
        hint: 'WebSocket firehose 由 Durable Object 提供，用于实时推送新事件。',
        command: 'wrangler.toml 中配置 [[durable_objects.bindings]] name = "FIREHOSE"'
    })

    return checks
}

/**
 * Render the checklist page as a self-contained HTML document
 * (inline CSS, no external dependencies).
 */
export function renderChecklistPage(env, journal, host) {
    const checks = checkSetup(env, journal)

    const okCount = checks.filter(c => c.status === 'ok').length
    const total = checks.length
    const pct = Math.round(okCount / total * 100)

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
        const command = c.status === 'ok' ? '' : `
            <div class="cmd">
                <code>${escapeHtml(c.command)}</code>
                <button class="copy" data-cmd="${escapeHtml(c.command)}">复制</button>
            </div>`

        return `<div class="check ${c.status}">
            <div class="row">
                <span class="icon">${icon}</span>
                <span class="label">${escapeHtml(c.label)}</span>
                ${badge}
            </div>
            ${value}
            ${hint}
            ${command}
        </div>`
    }).join('\n')

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>atproto-worker 部署检查</title>
<style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
        font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
        background: #f5f6f8; color: #1a1a2e; line-height: 1.6;
        padding: 24px 16px; max-width: 760px; margin: 0 auto;
    }
    h1 { font-size: 1.5rem; margin-bottom: 4px; }
    .sub { color: #666; font-size: .9rem; margin-bottom: 20px; word-break: break-all; }
    .progress {
        background: #e5e7eb; border-radius: 999px; height: 14px;
        margin: 16px 0 24px; overflow: hidden;
    }
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
    .label { font-weight: 600; flex: 1; min-width: 200px; }
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
        padding: 4px 12px; font-size: .8rem; cursor: pointer;
    }
    .cmd button:hover { background: #2563eb; }
    .done-banner {
        background: #dcfce7; color: #15803d; border-radius: 10px;
        padding: 16px; text-align: center; font-size: 1.05rem; font-weight: 600;
        margin-bottom: 20px; display: ${pct === 100 ? 'block' : 'none'};
    }
    .not-done-banner {
        background: #fef3c7; color: #92400e; border-radius: 10px;
        padding: 16px; text-align: center; font-size: .95rem;
        margin-bottom: 20px; display: ${pct === 100 ? 'none' : 'block'};
    }
    footer { margin-top: 32px; font-size: .8rem; color: #999; text-align: center; }
    @media (prefers-color-scheme: dark) {
        body { background: #111827; color: #e5e7eb; }
        .sub { color: #9ca3af; }
        .progress { background: #374151; }
        .check { background: #1f2937; border-color: #374151; }
        .value { color: #d1d5db; }
        .hint { color: #9ca3af; }
        .cmd { background: #111827; }
        .cmd code { color: #e5e7eb; }
        .progress-text { color: #d1d5db; }
    }
</style>
</head>
<body>
    <h1>🛰️ atproto-worker 部署检查</h1>
    <div class="sub">${escapeHtml(host)} · 中转模式（只读发布，签名在本地 CLI 完成）</div>

    <div class="done-banner">🎉 全部配置完成！你的 PDS 中转已就绪。</div>
    <div class="not-done-banner">按下面步骤逐个完成配置，每完成一项刷新本页即可看到打勾。</div>

    <div class="progress-text">${okCount} / ${total} 项完成</div>
    <div class="progress"><div class="bar" style="width:${pct}%"></div></div>

    ${rows}

    <footer>atproto-worker · 事件溯源 · 本地签名 · 只读中转</footer>
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
