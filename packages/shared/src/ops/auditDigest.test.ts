import { describe, it, expect } from 'vitest'
import { auditDigest, isRisky, isToday } from './auditDigest.js'
import type { AuditEntry } from '../protocol/types.js'

const mk = (over: Partial<AuditEntry>): AuditEntry => ({
  at: new Date('2026-11-09T10:00:00').toISOString(),
  sessionId: 's1', terminalId: 't1', hostKey: 'local', decision: 'read_allowed', ...over,
})

describe('执行记录复盘汇总', () => {
  it('危险判定：拦截 / 删文件 / 杀进程 / 非零退出码都算，普通读取不算', () => {
    expect(isRisky(mk({ decision: 'deny:preview_mode' }))).toBe(true)
    expect(isRisky(mk({ decision: 'file_delete' }))).toBe(true)
    expect(isRisky(mk({ decision: 'process_kill' }))).toBe(true)
    expect(isRisky(mk({ decision: 'exec_allowed', exitCode: 1 }))).toBe(true)
    expect(isRisky(mk({ decision: 'read_allowed', exitCode: 0 }))).toBe(false)
  })

  it('今天：同一自然日算今天，昨天不算', () => {
    const now = new Date('2026-11-09T23:00:00').getTime()
    expect(isToday(mk({ at: new Date('2026-11-09T00:30:00').toISOString() }), now)).toBe(true)
    expect(isToday(mk({ at: new Date('2026-11-08T23:30:00').toISOString() }), now)).toBe(false)
  })

  it('汇总：条数、按主机/按类型计数、危险项带命令与规则', () => {
    const rows = [
      mk({ decision: 'read_allowed', command: 'ls -la' }),
      mk({ decision: 'read_allowed', command: 'cat /etc/hosts' }),
      mk({ decision: 'exec_allowed', command: 'rm -rf /tmp/x', exitCode: 0, hostKey: 'h2', rule: '允许 rm' }),
      mk({ decision: 'file_delete', filePath: '/etc/nginx/nginx.conf', hostKey: 'h2' }),
    ]
    const t = auditDigest({ rows, hostLabel: (k) => (k === 'h2' ? 'prod-web-01' : '本地'), scopeNote: '今天' })
    expect(t).toContain('共 4 条')
    expect(t).toContain('本地 × 2')
    expect(t).toContain('prod-web-01 × 2')
    expect(t).toContain('read_allowed × 2')
    expect(t).toContain('需要复盘的有 2 条')
    expect(t).toContain('规则：允许 rm')
    expect(t).toContain('/etc/nginx/nginx.conf')
    expect(t).not.toContain('cat /etc/hosts')   // 只列危险项明细，普通读取不进明细
  })

  it('空列表给一句人话，不炸', () => {
    expect(auditDigest({ rows: [], scopeNote: '今天' })).toContain('没有任何记录')
  })
})
