import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { previewBlocks, previewBlocksMcp, recentContext, installRulesSection } from './safety.js'
import { planToolDef, PlanBook } from './plan.js'

const ro = (c: string) => /^(ls|cat|df)\b/.test(c)

describe('预演模式拦截判定', () => {
  it('exec 类：只读放行、非只读拦；写文件 / 上传一律拦；读类与其它工具不拦', () => {
    expect(previewBlocks('exec_in_terminal', { command: 'ls -l' }, ro)).toBe(false)
    expect(previewBlocks('exec_in_terminal', { command: 'systemctl restart nginx' }, ro)).toBe(true)
    expect(previewBlocks('exec_on_terminals', { command: 'rm -rf /tmp/x' }, ro)).toBe(true)
    expect(previewBlocks('start_background', { command: 'df -h' }, ro)).toBe(false)
    expect(previewBlocks('exec_in_terminal', {}, ro)).toBe(true)
    expect(previewBlocks('exec_in_terminal', { command: 'ls' })).toBe(true)   // 没有只读判定 = 一律拦
    for (const t of ['write_file', 'upload_file']) expect(previewBlocks(t, { path: '/a' }, ro)).toBe(true)
    for (const t of ['read_file', 'read_terminal', 'download_file', 'check_background', 'run_on_hosts', 'propose_plan', 'list_terminals']) expect(previewBlocks(t, { command: 'x' }, ro)).toBe(false)
    expect(previewBlocksMcp(true)).toBe(false)
    expect(previewBlocksMcp(false)).toBe(true)
  })
  it('预演里 propose_plan 不弹审批：返回 preview 结果，不记入已批准计划', async () => {
    const book = new PlanBook()
    let asked = 0
    const def = planToolDef({ resolveHostKey: () => 'h1', requestPlan: async () => { asked++; return { decision: 'allow' } }, isPreview: () => true }, book)
    const out = JSON.parse(await def.execute({ title: '修 nginx', steps: [{ terminal_id: 't1', command: 'rm -rf /var/cache/nginx', purpose: '清缓存' }] }, { agent: { id: 's1' } }))
    expect(asked).toBe(0)
    expect(out).toMatchObject({ preview: true, approved: false, title: '修 nginx', steps: [{ terminal_id: 't1', hostKey: 'h1', dangerous: true }] })
    expect(book.remaining('s1')).toBe(0)
  })
})

describe('分层规则段', () => {
  it('按 agent 现求值、原样输出（不插值），没有规则段落消失', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const t: Record<string, string> = { a1: '## 分层规则\n禁止重启 mysqld {{x}}' }
    installRulesSection(ctx, (id) => t[id] ?? '')
    const render = async (id: string) => renderPrompt(await (ctx as any).systemPrompt.assemble({ agent: { id } }))
    expect(await render('a1')).toContain('禁止重启 mysqld {{x}}')
    expect(await render('a2')).not.toContain('分层规则')
  })
})

describe('复核用的会话上下文摘要', () => {
  it('取最近的用户消息 / AI 回复 / 执行的命令，按时间顺序，总长受限', () => {
    const ev = (type: string, data: unknown, seq: number) => ({ type, seq, time: seq, data })
    const events = [
      ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '很早的话'.repeat(200) }] }, 1),
      ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '数据库很慢，帮我看看' }] }, 2),
      ev('assistant/message', { message: { content: [{ type: 'text', text: '先看下负载' }] } }, 3),
      ev('tool/call', { name: 'exec_in_terminal', arguments: JSON.stringify({ command: 'uptime' }) }, 4),
      ev('user/message', { source: { kind: 'system' }, content: 'x' }, 5),
    ]
    const s = recentContext(events as any, 120)
    expect(s.split('\n')).toEqual(['用户：数据库很慢，帮我看看', 'AI：先看下负载', 'AI 执行（exec_in_terminal）：uptime'])
    expect(s).not.toContain('很早的话')
  })
})
