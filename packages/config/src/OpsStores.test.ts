import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TemplateStore, BUILTIN_TEMPLATES } from './TemplateStore.js'
import { ScheduleStore } from './ScheduleStore.js'

let dir: string
afterEach(() => { if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true }) })

describe('TemplateStore', () => {
  it('首次返回内置模板；删除内置后不再出现', () => {
    dir = mkdtempSync(join(tmpdir(), 'tpl-'))
    const s = new TemplateStore(dir)
    expect(s.list().map((t) => t.id)).toEqual(BUILTIN_TEMPLATES.map((t) => t.id))
    s.delete(BUILTIN_TEMPLATES[0].id)
    expect(new TemplateStore(dir).list().some((t) => t.id === BUILTIN_TEMPLATES[0].id)).toBe(false)
  })
  it('新增/编辑', () => {
    dir = mkdtempSync(join(tmpdir(), 'tpl-'))
    const s = new TemplateStore(dir)
    const t = s.save({ name: ' a ', prompt: 'p' })
    expect(t.name).toBe('a')
    s.save({ id: t.id, name: 'b', prompt: 'q' })
    expect(s.list().find((x) => x.id === t.id)).toEqual({ id: t.id, name: 'b', prompt: 'q' })
    expect(() => s.save({ name: '', prompt: 'x' })).toThrow()
  })
})

describe('ScheduleStore', () => {
  const input = { name: 'n', prompt: 'p', targets: ['local'], when: { kind: 'interval' as const, hours: 6 }, enabled: true }
  it('保存保留 createdAt/lastRunAt，校验时间', () => {
    dir = mkdtempSync(join(tmpdir(), 'sch-'))
    const s = new ScheduleStore(dir)
    const a = s.save(input)
    s.markRun(a.id, '2026-01-01T00:00:00.000Z')
    const b = s.save({ ...input, id: a.id, name: 'm' })
    expect(b.createdAt).toBe(a.createdAt)
    expect(b.lastRunAt).toBe('2026-01-01T00:00:00.000Z')
    expect(() => s.save({ ...input, when: { kind: 'daily', time: '25:00' } })).toThrow()
    expect(() => s.save({ ...input, targets: [] })).toThrow()
  })
  it('运行记录新在前、按 id 覆盖、有上限', () => {
    dir = mkdtempSync(join(tmpdir(), 'sch-'))
    const s = new ScheduleStore(dir, 2)
    const run = (id: string) => ({ id, scheduleId: 's', scheduleName: 'n', at: '', status: 'running' as const, summary: '' })
    s.putRun(run('1')); s.putRun(run('2')); s.putRun({ ...run('2'), status: 'normal' }); s.putRun(run('3'))
    expect(s.listRuns().map((r) => r.id)).toEqual(['3', '2'])
    expect(s.listRuns()[1].status).toBe('normal')
  })
})
