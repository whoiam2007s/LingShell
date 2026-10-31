import { describe, it, expect } from 'vitest'
import { buildPostmortemPrompt, isPostmortemRequest, postmortemMarkdown, postmortemFileName, POSTMORTEM_TAG, POSTMORTEM_MAX_ROWS } from './postmortem.js'
import { fmtTime } from './report.js'
import type { AuditEntry } from '../protocol/index.js'

const at = (h: number, m: number, s: number) => new Date(2026, 9, 15, h, m, s).toISOString()
const A = (p: Partial<AuditEntry>): AuditEntry => ({ at: at(10, 0, 0), sessionId: 's1', terminalId: 't1', hostKey: 'h1', decision: 'exec_allowed', ...p })

describe('buildPostmortemPrompt', () => {
  const audit: AuditEntry[] = [
    A({ at: at(10, 5, 9), command: 'systemctl restart nginx', exitCode: 0, terminalTitle: 'web1' }),
    A({ at: at(10, 1, 2), command: 'tail -n 50 /var/log/nginx/error.log | grep upstream', exitCode: 1, terminalTitle: 'web1' }),
    A({ at: at(10, 3, 30), filePath: '/etc/nginx/conf.d/app.conf', decision: 'write_allowed' }),
    A({ at: at(10, 0, 30), decision: 'allow:first_access' }),   // 没命令也没文件：不进时间线
    A({ at: at(10, 6, 0), command: 'curl -H "Authorization: Bearer abcdefghijklmn" localhost', exitCode: 0, hostKey: 'local' }),
  ]
  const p = buildPostmortemPrompt({
    title: 'nginx 502',
    audit,
    turnChanges: [{ turnId: 'u1', files: [{ key: 'k', hostKey: 'h1', terminalId: 't1', path: '/etc/nginx/conf.d/app.conf', created: false, firstAt: at(10, 3, 30), lastAt: at(10, 3, 30), writes: 1 }] }],
    hostReports: [{ sessionId: 's1', dshId: 'd', turnId: 'u1', at: at(10, 5, 40), hosts: [{ hostKey: 'h1', hostLabel: 'web1', summary: ['失败服务 -nginx'] }, { hostKey: 'h2', summary: [] }] }],
    hosts: [{ id: 'h1', label: 'web1', env: 'prod' }],
    redact: (s) => s.replace(/Bearer \w+/g, 'Bearer [已脱敏]'),
  })
  it('以标注开头，带模板各章节', () => {
    expect(p.startsWith(POSTMORTEM_TAG)).toBe(true)
    expect(isPostmortemRequest(p)).toBe(true)
    for (const h of ['## 影响概述', '## 时间线', '| 时间 | 事件 | 命令 / 发现 |', '## 根因', '## 处理过程', '## 恢复验证', '## 后续改进项', '| 行动项 | 负责人 | 期限 |', '## 附录：关键命令与输出摘要']) expect(p).toContain(h)
    expect(p).toContain('不要编造')
  })
  it('执行记录按真实时间排序，含主机 / 命令 / 结果 / 退出码；无命令的记录不列', () => {
    expect(p).toContain(`执行时间范围：${fmtTime(at(10, 1, 2))} ~ ${fmtTime(at(10, 6, 0))}`)
    expect(p).toContain('共 4 条')
    const rows = p.split('\n').filter((l) => l.startsWith(`| ${fmtTime(at(10, 0, 0)).slice(0, 10)}`))
    expect(rows).toEqual([
      `| ${fmtTime(at(10, 1, 2))} | web1（生产） / web1 | tail -n 50 /var/log/nginx/error.log \\| grep upstream | 执行 | 1 |`,
      `| ${fmtTime(at(10, 3, 30))} | web1（生产） | /etc/nginx/conf.d/app.conf | 改文件 |  |`,
      `| ${fmtTime(at(10, 5, 9))} | web1（生产） / web1 | systemctl restart nginx | 执行 | 0 |`,
      `| ${fmtTime(at(10, 6, 0))} | 本地 | curl -H "Authorization: Bearer [已脱敏]" localhost | 执行 | 0 |`,
    ])
  })
  it('文件改动与主机变化带时间', () => {
    expect(p).toContain(`- ${fmtTime(at(10, 3, 30))} web1（生产） \`/etc/nginx/conf.d/app.conf\`（修改，写入 1 次）`)
    expect(p).toContain(`- ${fmtTime(at(10, 5, 40))} web1：失败服务 -nginx`)
    expect(p).not.toContain('h2')
  })
  it('空会话：都写（无）', () => {
    const e = buildPostmortemPrompt({ title: 't', audit: [], turnChanges: [], hostReports: [], hosts: [] })
    expect(e).toContain('（本会话没有执行记录）')
    expect(e).toContain('执行时间范围：—')
    expect(e.match(/（无）/g)).toHaveLength(2)
  })
  it('超过上限只列最近的', () => {
    const many = Array.from({ length: POSTMORTEM_MAX_ROWS + 5 }, (_, i) => A({ at: new Date(2026, 9, 15, 10, 0, i).toISOString(), command: `echo ${i}` }))
    const e = buildPostmortemPrompt({ title: 't', audit: many, turnChanges: [], hostReports: [], hosts: [] })
    expect(e).toContain(`只列最近 ${POSTMORTEM_MAX_ROWS} 条，更早的 5 条省略`)
    expect(e).not.toContain('| echo 4 |')
    expect(e).toContain('| echo 5 |')
  })
})

describe('postmortemMarkdown / postmortemFileName', () => {
  it('剥掉整份代码块外壳与标题前的客套话', () => {
    expect(postmortemMarkdown('```markdown\n# 故障复盘：x\n\n## 根因\ny\n```')).toBe('# 故障复盘：x\n\n## 根因\ny\n')
    expect(postmortemMarkdown('好的，以下是报告：\n\n# 故障复盘：x\n正文')).toBe('# 故障复盘：x\n正文\n')
    expect(postmortemMarkdown('# 故障复盘：x\n```bash\nls\n```')).toBe('# 故障复盘：x\n```bash\nls\n```\n')
    expect(postmortemMarkdown('没有标题的回复')).toBe('没有标题的回复\n')
  })
  it('文件名：复盘-标题-日期.md，去掉非法字符', () => {
    expect(postmortemFileName('nginx 502: a/b', new Date(2026, 9, 5))).toBe('复盘-nginx 502_ a_b-2026-10-05.md')
    expect(postmortemFileName('', new Date(2026, 0, 1))).toBe('复盘-会话-2026-01-01.md')
  })
  it('isPostmortemRequest', () => {
    expect(isPostmortemRequest(undefined)).toBe(false)
    expect(isPostmortemRequest('帮我生成复盘')).toBe(false)
  })
})
