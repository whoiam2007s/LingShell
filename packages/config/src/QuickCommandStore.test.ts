import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_QUICK_COMMANDS } from '@lingshell/shared'
import { QuickCommandStore } from './QuickCommandStore.js'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'qc-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('QuickCommandStore', () => {
  it('无文件给默认命令（df/free/uptime/ports），且返回的是副本', () => {
    const s = new QuickCommandStore(tmp())
    const d = s.get()
    expect(d.sets[0].commands.map((c) => c.command)).toEqual(['df -h', 'free -h', 'uptime', 'ss -lntp'])
    d.sets[0].commands.length = 0
    expect(DEFAULT_QUICK_COMMANDS.sets[0].commands).toHaveLength(4)
  })
  it('旧版默认文件：读时升级成分系统版本并落盘；改过的命令保持原样', () => {
    const dir = tmp(), file = join(dir, 'quick-commands.json')
    const old = (free: string) => ({ activeSetId: 'qs_default', barVisible: true, sets: [{ id: 'qs_default', name: '常用', commands: [
      { id: 'qc_df', label: '查看磁盘', command: 'df -h', appendEnter: true, target: 'active' },
      { id: 'qc_free', label: '内存', command: free, appendEnter: true, target: 'active' },
      { id: 'qc_uptime', label: '负载', command: 'uptime', appendEnter: true, target: 'active' },
    ] }] })
    writeFileSync(file, JSON.stringify(old('free -h')))
    expect(new QuickCommandStore(dir).get()).toEqual(DEFAULT_QUICK_COMMANDS)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(DEFAULT_QUICK_COMMANDS)   // 已落盘

    writeFileSync(file, JSON.stringify(old('free -m')))
    const r = new QuickCommandStore(dir).get()
    expect(r.sets[0].commands.map((c) => c.id)).toEqual(['qc_df', 'qc_free', 'qc_uptime'])   // 组被改过：不补端口
    expect(r.sets[0].commands[1]).toEqual(old('free -m').sets[0].commands[1])
    expect(r.sets[0].commands[2].variants?.windows).toContain('powershell.exe')            // 没改过的照样升级
  })
  it('增删改、切组、显示开关落盘', () => {
    const dir = tmp(), s = new QuickCommandStore(dir)
    const d = s.get()
    d.sets[0].commands.push({ id: 'x', label: '看日志', command: 'tail -n {{行数}} /var/log/syslog', appendEnter: true, target: 'broadcast' })
    d.sets[0].commands.splice(0, 1)
    d.sets.push({ id: 's2', name: '数据库', commands: [] })
    s.save({ ...d, activeSetId: 's2', barVisible: false })
    const r = new QuickCommandStore(dir).get()
    expect(r.sets[0].commands.map((c) => c.label)).toEqual(['内存', '负载', '监听端口', '看日志'])
    expect(r.activeSetId).toBe('s2')
    expect(r.barVisible).toBe(false)
    s.save({ ...r, sets: r.sets.filter((x) => x.id !== 's2') })
    expect(s.get().activeSetId).toBe(r.sets[0].id)   // 当前组被删 → 回退第一组
  })
  it('校验失败抛错不写盘；文件损坏回退默认', () => {
    const dir = tmp(), s = new QuickCommandStore(dir)
    expect(() => s.save({ sets: [{ id: 's', name: '', commands: [] }], activeSetId: 's', barVisible: true })).toThrow()
    expect(s.get()).toEqual(DEFAULT_QUICK_COMMANDS)
    writeFileSync(join(dir, 'quick-commands.json'), JSON.stringify({ sets: [{ name: '' }] }))
    expect(s.get()).toEqual(DEFAULT_QUICK_COMMANDS)
  })
})
