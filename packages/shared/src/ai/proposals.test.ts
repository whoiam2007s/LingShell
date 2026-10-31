import { describe, it, expect } from 'vitest'
import { normalizeQuickProposal, applyQuickProposal, runbookFromProposal, runbookFromAuditPrompt } from './proposals.js'
import { DEFAULT_QUICK_COMMANDS } from '../terminal/index.js'

describe('normalizeQuickProposal', () => {
  it('规整字段（兼容 name / label），去空白；缺组名 / 空命令 / 没有命令报错', () => {
    const p = normalizeQuickProposal({ set_name: ' nginx 检查 ', commands: [{ name: '状态', command: 'systemctl status nginx  ', description: ' 看状态 ' }, { label: '配置', command: 'nginx -t' }] })
    expect(p).toEqual({ setName: 'nginx 检查', commands: [{ label: '状态', command: 'systemctl status nginx', description: '看状态' }, { label: '配置', command: 'nginx -t' }] })
    expect(() => normalizeQuickProposal({ commands: [{ name: 'a', command: 'b' }] })).toThrow('set_name')
    expect(() => normalizeQuickProposal({ set_name: 'x', commands: [{ name: 'a', command: ' ' }] })).toThrow('第 1 条')
    expect(() => normalizeQuickProposal({ set_name: 'x', commands: [] })).toThrow('至少')
    expect(() => normalizeQuickProposal({ set_name: 'x', commands: Array.from({ length: 31 }, (_, i) => ({ name: `n${i}`, command: 'ls' })) })).toThrow('最多')
  })
})

describe('applyQuickProposal', () => {
  const p = { setName: 'nginx', commands: [{ label: '状态', command: 'systemctl status nginx', description: '看状态' }, { label: '磁盘', command: 'df -h' }] }
  it('新组：追加到末尾并切过去，带说明', () => {
    const r = applyQuickProposal(structuredClone(DEFAULT_QUICK_COMMANDS), p)
    expect(r.data.sets).toHaveLength(2)
    expect(r.data.activeSetId).toBe(r.setId)
    expect(r.data.sets[1]).toMatchObject({ name: 'nginx', commands: [{ label: '状态', description: '看状态', appendEnter: true, target: 'active' }, { label: '磁盘' }] })
    expect(r.added).toBe(2)
  })
  it('同名组已有：追加，相同命令不重复', () => {
    const r = applyQuickProposal(structuredClone(DEFAULT_QUICK_COMMANDS), { ...p, setName: '常用' })
    expect(r.data.sets).toHaveLength(1)
    expect(r.added).toBe(1)   // df -h 已有
    expect(r.data.sets[0].commands.map((c) => c.command)).toContain('systemctl status nginx')
  })
})

describe('runbookFromProposal', () => {
  it('标题 / 步骤 / 参数；步骤类型缺省按命令猜；用到没声明的参数自动补', () => {
    const r = runbookFromProposal({
      title: 'nginx 502 排查', description: '502 时用',
      steps: [{ title: '看状态', command: 'systemctl status {{svc}}' }, { title: '重启', command: 'systemctl restart {{svc}}', expect: 'active' }, { command: 'tail -n 50 {{log}}' }],
      params: [{ name: 'svc', label: '服务', default: 'nginx' }],
    })
    expect(r.name).toBe('nginx 502 排查')
    expect(r.steps.map((s) => s.kind)).toEqual(['check', 'change', 'check'])
    expect(r.steps[2].title).toBe('tail -n 50 {{log}}')
    expect(r.params).toEqual([{ name: 'svc', label: '服务', default: 'nginx' }, { name: 'log', label: 'log' }])
  })
  it('不合法照 normalizeRunbook 报错', () => {
    expect(() => runbookFromProposal({ title: '', steps: [{ title: 'a' }] })).toThrow('名称')
    expect(() => runbookFromProposal({ title: 'x', steps: [] })).toThrow('步骤')
  })
  it('执行记录整理提示：带编号命令，提到 propose_runbook，不含双花括号（避免模板插值）', () => {
    const t = runbookFromAuditPrompt(['df -h', 'du -sh /var/log'])
    expect(t).toContain('propose_runbook')
    expect(t).toContain('2. du -sh /var/log')
    expect(t).not.toContain('{{')
  })
})
