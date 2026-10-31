import { describe, it, expect } from 'vitest'
import { buildSessionReport, conversationToMarkdown, redactSecrets, auditDecisionLabel, truncateDiff, REDACTED, type ReportItem } from './report.js'
import type { AuditEntry } from '../protocol/index.js'

const items: ReportItem[] = [
  { kind: 'user_message', status: 'completed', text: '看下 nginx 为什么挂了' },
  { kind: 'agent_reasoning', status: 'completed', text: '内心独白不该导出' },
  { kind: 'auth_request', status: 'completed', text: '', auth: { terminalId: 't1', needed: 'write', reason: 'first_access', command: 'systemctl restart nginx', result: 'allow' } },
  { kind: 'tool_call', status: 'completed', text: '', tool: { toolId: 'a', name: 'exec_in_terminal', input: { terminal_id: 't1', command: 'systemctl restart nginx' }, output: JSON.stringify({ output: 'Job failed', exit_code: 1 }) } },
  { kind: 'auth_request', status: 'completed', text: '', auth: { terminalId: 't1', needed: 'write', reason: 'dangerous_command', command: 'rm -rf /var/log/nginx', result: 'deny' } },
  { kind: 'plan_request', status: 'completed', text: '', plan: { title: '修配置', steps: [{ command: 'nginx -t' }], result: 'timeout' } },
  { kind: 'tool_call', status: 'completed', text: '', tool: { toolId: 'b', name: 'write_file', input: { terminal_id: 't1', path: '/etc/nginx/nginx.conf' }, output: JSON.stringify({ path: '/etc/nginx/nginx.conf', diff: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new', backup_path: '/bak/nginx.conf.1' }) } },
  { kind: 'agent_message', status: 'completed', text: '已修好' },
]
const audit: AuditEntry[] = [
  // 故意乱序：报告按时间升序
  { at: '2026-10-10T02:05:00.000Z', sessionId: 's', terminalId: 't1', terminalTitle: 'web1', hostKey: 'h1', decision: 'write_allowed', filePath: '/etc/nginx/nginx.conf', backupPath: '/bak/nginx.conf.1' },
  { at: '2026-10-10T02:00:00.000Z', sessionId: 's', terminalId: 't1', terminalTitle: 'web1', hostKey: 'h1', command: 'systemctl restart nginx', decision: 'exec_allowed', exitCode: 1 },
  { at: '2026-10-10T02:01:00.000Z', sessionId: 's', terminalId: 't1', terminalTitle: 'web1', hostKey: 'h1', command: 'rm -rf /var/log/nginx', decision: 'deny:user:先别删日志' },
  { at: '2026-10-10T02:02:00.000Z', sessionId: 's', terminalId: 't0', hostKey: 'local', command: 'echo a|b', decision: 'exec_allowed', exitCode: 0 },
  { at: '2026-10-10T02:06:00.000Z', sessionId: 's', terminalId: '', hostKey: 'local', command: '手动编辑 C:/x.txt', decision: 'user_edit', filePath: 'C:/x.txt', backupPath: 'C:/bak/x.txt' },
]
const hosts = [{ id: 'h1', label: 'web1', env: 'prod' as const }]

describe('完整报告', () => {
  const md = buildSessionReport({ title: 'nginx 故障', items, audit, hosts, now: new Date('2026-10-10T03:00:00Z') })

  it('五个章节按顺序', () => {
    const idx = ['## 1. 概要', '## 2. 对话与过程', '## 3. 执行记录', '## 4. 文件改动', '## 5. 授权记录'].map((h) => md.indexOf(h))
    expect(idx.every((i) => i > 0)).toBe(true)
    expect([...idx].sort((a, b) => a - b)).toEqual(idx)
    expect(md.startsWith('# 会话报告：nginx 故障')).toBe(true)
  })

  it('概要：主机（生产标注）、计数', () => {
    expect(md).toContain('涉及主机：web1（生产）、本地')
    expect(md).toContain('执行命令：2 条，失败 1 条')
    expect(md).toContain('文件改动：2 个文件')
    expect(md).toContain('授权：允许 1 次，拒绝 1 次，超时 1 次')
  })

  it('对话：不含思考过程，用户消息降一级', () => {
    expect(md).not.toContain('内心独白')
    expect(md).toContain('### 🧑 用户\n\n看下 nginx 为什么挂了')
    expect(md).toContain('[退出码 1]')
  })

  it('执行记录：升序、中文决定、失败标记、竖线转义', () => {
    const sec = md.slice(md.indexOf('## 3.'), md.indexOf('## 4.'))
    expect(sec.indexOf('systemctl restart nginx')).toBeLessThan(sec.indexOf('rm -rf'))
    expect(sec).toContain('| web1（生产） / web1 | systemctl restart nginx | 执行 | ❌ **1** |')
    expect(sec).toContain('你拒绝：先别删日志')
    expect(sec).toContain('echo a\\|b')
  })

  it('文件改动：diff 块 + 备份；手动编辑无 diff', () => {
    const sec = md.slice(md.indexOf('## 4.'), md.indexOf('## 5.'))
    expect(sec).toContain('### `/etc/nginx/nginx.conf`（AI 写入）\n\n```diff\n--- a')
    expect(sec).toContain('备份：`/bak/nginx.conf.1`')
    expect(sec).toContain('### `C:/x.txt`（手动编辑）\n\n（无 diff 记录）')
  })

  it('授权记录：允许/拒绝(带理由)/超时', () => {
    const sec = md.slice(md.indexOf('## 5.'))
    expect(sec).toContain('写入 web1 — `systemctl restart nginx`（首次访问） → **允许**')
    expect(sec).toContain('（危险命令） → **拒绝**，理由：先别删日志')
    expect(sec).toContain('执行计划「修配置」（1 步）→ **超时**')
  })

  it('空会话各节显示「无」', () => {
    const e = buildSessionReport({ title: 'x', items: [], audit: [], hosts: [] })
    expect(e).toContain('—（无执行记录）')
    expect(e.match(/\n无\n/g)?.length).toBe(4)
  })

  it('redact 开启时脱敏', () => {
    const its: ReportItem[] = [{ kind: 'user_message', status: 'completed', text: 'mysql -uroot -pS3cret! -e "show databases"' }]
    expect(buildSessionReport({ title: 'x', items: its, audit: [], hosts: [], redact: true })).toContain(`-p${REDACTED}`)
    expect(buildSessionReport({ title: 'x', items: its, audit: [], hosts: [] })).toContain('-pS3cret!')
  })
})

describe('仅对话', () => {
  it('与旧导出一致的结构', () => {
    const md = conversationToMarkdown('t', items)
    expect(md).toContain('## 🧑 用户')
    expect(md).toContain('### 🤖 AI\n\n已修好')
    expect(md).toContain('→ ⛔ 已拒绝')
    expect(md).not.toContain('## 3. 执行记录')
  })
  it('命令输出里带代码围栏：用更长的围栏包住，不提前闭合', () => {
    const its: ReportItem[] = [{ kind: 'tool_call', status: 'completed', text: '', tool: { toolId: 'a', name: 'exec_in_terminal', input: { command: 'cat x' }, output: JSON.stringify({ output: '```\ninside\n```', exit_code: 0 }) } }]
    expect(conversationToMarkdown('t', its)).toContain('````\n```\ninside\n```\n[退出码 0]\n````')
  })
})

describe('表格单元格', () => {
  it('反斜杠 + 竖线不会把表格拆开', () => {
    const a: AuditEntry = { at: '2026-10-10T02:00:00.000Z', sessionId: 's', terminalId: 't', hostKey: 'local', command: 'grep "a\\|b" f', decision: 'exec_allowed', exitCode: 0 }
    const md = buildSessionReport({ title: 'x', items: [], audit: [a], hosts: [] })
    expect(md).toContain('grep "a\\\\\\|b" f')
  })
})

describe('decision 中文标签', () => {
  it.each([
    ['exec_allowed', '执行'], ['exec_allowed:edited', '改后执行'], ['write_allowed', '改文件'], ['user_edit', '手动编辑'],
    ['restored', '已还原'], ['allow:first_access', '首次授权'], ['allow:xxx', '批准'], ['deny:user', '你拒绝'],
    ['deny:user:太危险', '你拒绝：太危险'], ['deny:blacklist', '拦截：blacklist'], ['weird', 'weird'],
    ['file_delete', '删除文件'], ['file_rename', '重命名'],
  ])('%s → %s', (d, l) => expect(auditDecisionLabel(d)).toBe(l))
})

describe('diff 截断', () => {
  it('不超长原样，超长截到 N 行并注明', () => {
    expect(truncateDiff('a\nb\n')).toBe('a\nb')
    const long = Array.from({ length: 250 }, (_, i) => `+${i}`).join('\n')
    const t = truncateDiff(long)
    expect(t.split('\n')).toHaveLength(201)
    expect(t.endsWith('…（后面省略 50 行）')).toBe(true)
  })
})

describe('脱敏', () => {
  it.each([
    ['password=hunter22', `password=${REDACTED}`],
    ['DB_PASSWORD: "abc123"', `DB_PASSWORD: "${REDACTED}"`],
    ['{"api_key": "xyz789"}', `{"api_key": "${REDACTED}"}`],
    ['export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI', `export AWS_SECRET_ACCESS_KEY=${REDACTED}`],
    ['curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc"', `curl -H "Authorization: Bearer ${REDACTED}"`],
    ['Authorization: Basic dXNlcjpwYXNz', `Authorization: Basic ${REDACTED}`],
    ['mysql -h db -uroot -pS3cret db1', `mysql -h db -uroot -p${REDACTED} db1`],
    ['sshpass -p hunter2 ssh a@b', `sshpass -p ${REDACTED} ssh a@b`],
    ['key sk-abcdefghijklmnop1234 ok', `key ${REDACTED} ok`],
    ['id AKIAIOSFODNN7EXAMPLE', `id ${REDACTED}`],
    ['git clone https://bob:pa55@git.example.com/r', `git clone https://bob:${REDACTED}@git.example.com/r`],
    ['-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\nBBBB\n-----END OPENSSH PRIVATE KEY-----', REDACTED],
  ])('%s', (src, out) => expect(redactSecrets(src)).toBe(out))

  it.each([
    'mkdir -p /tmp/x',
    'ssh -p 2222 root@host',
    'password 已修改，请重新登录',
    'inputTokens: 5000',
    'sk-short',
    'Basic authentication failed',
    'Authorization 失败',
    'https://git.example.com/r',
    '-----BEGIN PUBLIC KEY-----',
  ])('不误伤：%s', (src) => expect(redactSecrets(src)).toBe(src))

  it('幂等', () => {
    const once = redactSecrets('password=a token: Bearer abcdefghijk')
    expect(redactSecrets(once)).toBe(once)
  })
})
