import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandHistoryStore } from './CommandHistoryStore.js'
import type { CommandHistoryEntry } from '@lingshell/shared'

let dir: string
afterEach(() => { if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true }) })

const mk = (over: Partial<CommandHistoryEntry> = {}): Omit<CommandHistoryEntry, 'hostKey' | 'at'> & { hostKey?: string; at?: string } => ({
  command: 'ls', terminalId: 't1', terminalTitle: '本地 1', source: 'user', ...over,
})

describe('CommandHistoryStore', () => {
  it('add 后 list(hostKey) 返回该主机的条目（新在前）', () => {
    dir = mkdtempSync(join(tmpdir(), 'cmdhist-'))
    const s = new CommandHistoryStore(dir, 200)
    s.add('local', mk({ command: 'ls' }))
    s.add('local', mk({ command: 'pwd' }))
    const list = s.list('local')
    expect(list.map((e) => e.command)).toEqual(['pwd', 'ls'])
    expect(list[0].hostKey).toBe('local')
    expect(typeof list[0].at).toBe('string')
  })
  it('按 hostKey 分组，互不串', () => {
    dir = mkdtempSync(join(tmpdir(), 'cmdhist-'))
    const s = new CommandHistoryStore(dir, 200)
    s.add('local', mk({ command: 'a' }))
    s.add('host1', mk({ command: 'b' }))
    expect(s.list('local').map((e) => e.command)).toEqual(['a'])
    expect(s.list('host1').map((e) => e.command)).toEqual(['b'])
  })
  it('超过 limit 丢最旧', () => {
    dir = mkdtempSync(join(tmpdir(), 'cmdhist-'))
    const s = new CommandHistoryStore(dir, 3)
    for (const c of ['1', '2', '3', '4']) s.add('local', mk({ command: c }))
    expect(s.list('local').map((e) => e.command)).toEqual(['4', '3', '2'])   // 丢了 '1'
  })
  it('delete 按 index 删（index 对应 list 的顺序，新在前）', () => {
    dir = mkdtempSync(join(tmpdir(), 'cmdhist-'))
    const s = new CommandHistoryStore(dir, 200)
    for (const c of ['a', 'b', 'c']) s.add('local', mk({ command: c }))
    s.delete('local', 0)   // 删 list[0] = 'c'（最新）
    expect(s.list('local').map((e) => e.command)).toEqual(['b', 'a'])
  })
  it('deleteCommand 删该主机这条命令的全部记录（忽略首尾空白），别的主机不动，落盘', () => {
    dir = mkdtempSync(join(tmpdir(), 'cmdhist-'))
    const s = new CommandHistoryStore(dir, 200)
    for (const c of ['ls', 'pwd', ' ls ', 'ls -la']) s.add('local', mk({ command: c }))
    s.add('h1', mk({ command: 'ls' }))
    expect(s.deleteCommand('local', 'ls')).toBe(2)
    expect(s.list('local').map((e) => e.command)).toEqual(['ls -la', 'pwd'])
    expect(s.list('h1').map((e) => e.command)).toEqual(['ls'])
    expect(new CommandHistoryStore(dir, 200).list('local').map((e) => e.command)).toEqual(['ls -la', 'pwd'])
    expect(s.deleteCommand('local', 'nope')).toBe(0)
    expect(s.deleteCommand('nohost', 'ls')).toBe(0)
  })
  it('clear 清空该主机', () => {
    dir = mkdtempSync(join(tmpdir(), 'cmdhist-'))
    const s = new CommandHistoryStore(dir, 200)
    s.add('local', mk({ command: 'a' }))
    s.add('h1', mk({ command: 'b' }))
    s.clear('local')
    expect(s.list('local')).toEqual([])
    expect(s.list('h1').map((e) => e.command)).toEqual(['b'])
  })
  it('持久化到 command-history.json（明文，含命令）', () => {
    dir = mkdtempSync(join(tmpdir(), 'cmdhist-'))
    const s = new CommandHistoryStore(dir, 200)
    s.add('local', mk({ command: 'echo hello' }))
    const raw = readFileSync(join(dir, 'command-history.json'), 'utf8')
    expect(raw).toContain('echo hello')
  })
  it('内存常驻：只在首次载入读盘，新实例能读回已写内容', () => {
    dir = mkdtempSync(join(tmpdir(), 'cmdhist-'))
    const s = new CommandHistoryStore(dir, 200)
    s.add('local', mk({ command: 'a' }))
    // 外部改动文件不影响已载入实例（证明 list 不再每次读盘）
    writeFileSync(join(dir, 'command-history.json'), '{}', 'utf8')
    expect(s.list('local').map((e) => e.command)).toEqual(['a'])
    s.add('local', mk({ command: 'b' }))
    expect(new CommandHistoryStore(dir, 200).list('local').map((e) => e.command)).toEqual(['b', 'a'])
  })
})
