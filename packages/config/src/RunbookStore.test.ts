import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RunbookStore } from './RunbookStore.js'

let dir: string
afterEach(() => { if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true }) })

describe('RunbookStore', () => {
  it('增删改查，重开后仍在', () => {
    dir = mkdtempSync(join(tmpdir(), 'rb-'))
    const s = new RunbookStore(dir)
    expect(s.list()).toEqual([])
    const rb = s.save({ name: ' 重启 nginx ', description: '', params: [], steps: [{ title: '看状态', command: 'systemctl status {{服务}}', kind: 'check' }] })
    expect(rb.id).toMatch(/^rb_/)
    expect(rb.name).toBe('重启 nginx')
    expect(rb.params).toEqual([{ name: '服务', label: '服务' }])   // 步骤里用到的参数自动补上
    expect(rb.updatedAt).toBeTruthy()
    s.save({ ...rb, name: '改名' })
    const again = new RunbookStore(dir).list()
    expect(again).toHaveLength(1)
    expect(again[0].name).toBe('改名')
    s.delete(rb.id)
    expect(s.list()).toEqual([])
  })
  it('校验：名称、步骤、步骤标题、类型', () => {
    dir = mkdtempSync(join(tmpdir(), 'rb-'))
    const s = new RunbookStore(dir)
    const step = { title: 't', kind: 'check' as const }
    expect(() => s.save({ name: '', description: '', params: [], steps: [step] })).toThrow('名称')
    expect(() => s.save({ name: 'a', description: '', params: [], steps: [] })).toThrow('步骤')
    expect(() => s.save({ name: 'a', description: '', params: [], steps: [{ title: ' ', kind: 'check' }] })).toThrow('标题')
    expect(() => s.save({ name: 'a', description: '', params: [], steps: [{ title: 't', kind: 'x' as never }] })).toThrow('类型')
    expect(s.list()).toEqual([])
  })
})
