import { describe, it, expect } from 'vitest'
import { mkdtempSync, appendFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditStore } from './AuditStore.js'

const rec = (sessionId: string, command: string) => ({ at: new Date().toISOString(), sessionId, terminalId: 't1', hostKey: 'local', command, decision: 'exec_allowed' })

describe('AuditStore', () => {
  it('按会话列出，新在前；重开后仍在', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-'))
    const s = new AuditStore(dir)
    s.add(rec('a', 'ls')); s.add(rec('b', 'pwd')); s.add(rec('a', 'whoami'))
    expect(s.listForSession('a').map((r) => r.command)).toEqual(['whoami', 'ls'])
    expect(new AuditStore(dir).listForSession('b').map((r) => r.command)).toEqual(['pwd'])
  })

  it('崩溃留下的半行被跳过，不影响其他记录', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-'))
    new AuditStore(dir).add(rec('a', 'ls'))
    appendFileSync(join(dir, 'audit.jsonl'), '{"at":"x","sessio')
    expect(new AuditStore(dir).listForSession('a').map((r) => r.command)).toEqual(['ls'])
  })

  it('超过上限时载入裁掉最旧的并重写文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-'))
    const s = new AuditStore(dir, 3)
    for (const c of ['1', '2', '3', '4', '5']) s.add(rec('a', c))
    expect(new AuditStore(dir, 3).listForSession('a').map((r) => r.command)).toEqual(['5', '4', '3'])
    expect(readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim().split('\n')).toHaveLength(3)
  })
})
