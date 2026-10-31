import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SecretStore } from '@lingshell/config'
import { registerSecrets, CLIPBOARD_CLEAR_SEC } from './secretsIpc.js'

const V = 'S3cr3t-xyz-123'
const enc = { available: () => true, encrypt: (p: string) => `E:${Buffer.from(p).toString('base64')}`, decrypt: (c: string) => Buffer.from(c.slice(2), 'base64').toString() }
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.useRealTimers() })

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'secipc-')); dirs.push(dir)
  const store = new SecretStore(dir, enc)
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
  let clip = ''
  const writes: { tid: string; wire: string; shown: string }[] = []
  const terms: Record<string, string> = { t_local: 'local', t_web: 'h1' }
  const svc = registerSecrets({
    handle: (ch, fn) => handlers.set(ch, fn),
    store,
    hostKeyOf: (tid) => terms[tid],
    hosts: () => [{ id: 'h1', label: 'web1', group: 'web' }],
    clipboard: { writeText: (s) => { clip = s }, readText: () => clip },
    write: (tid, wire, shown) => writes.push({ tid, wire, shown }),
  })
  const call = (ch: string, ...a: unknown[]) => handlers.get(ch)!({}, ...a)
  return { svc, call, writes, clip: () => clip, setClip: (s: string) => { clip = s } }
}

describe('密钥保险箱 IPC', () => {
  it('列表不含值；范围校验 / 展开 / 回写', () => {
    const { svc, call } = setup()
    const s = call('secrets:save', { name: 'demo', description: '演示', scope: 'local', value: V }) as { id: string }
    expect(JSON.stringify(call('secrets:list'))).not.toContain(V)
    expect(svc.check('t_local', 'echo {{secret:demo}}')).toBeUndefined()
    expect(svc.check('t_web', 'echo {{secret:demo}}')).toMatch(/不允许在「web1」上使用.*仅本地终端/)
    expect(svc.check('t_gone', 'echo {{secret:demo}}')).toBeUndefined()   // 终端不存在交给授权判定
    expect(svc.expand('t_local', 'echo {{secret:demo}}')).toBe(`echo '${V}'`)
    expect(() => svc.expand('t_web', 'echo {{secret:demo}}')).toThrow(/secret_scope/)
    expect(svc.mask(JSON.stringify({ output: V }))).toBe('{"output":"{{secret:demo}}"}')
    // 改成分组 web：本地不行、web1 可以；改了立即生效（缓存失效）
    call('secrets:save', { id: s.id, name: 'demo', scope: 'group', targets: ['web'], value: 'n3w-value-9' })
    expect(svc.check('t_local', '{{secret:demo}}')).toMatch(/secret_scope/)
    expect(svc.expand('t_web', 'x {{secret:demo}}')).toBe(`x 'n3w-value-9'`)
    expect(svc.prompt()).toContain('{{secret:demo}}（可用范围：分组：web）')
    expect(svc.prompt()).not.toContain('n3w-value-9')
  })

  it('撰写栏发送：含密钥的行展开并加前导空格，历史 / 显示用原文；有一行越范围就整段不发', () => {
    const { call, writes } = setup()
    call('secrets:save', { name: 'demo', scope: 'local', value: V })
    call('secrets:send', 't_local', 'ls\rmysql -p{{secret:demo}}\r')
    expect(writes).toEqual([{ tid: 't_local', wire: `ls\r mysql -p'${V}'\r`, shown: 'ls\rmysql -p{{secret:demo}}\r' }])
    expect(() => call('secrets:send', 't_web', 'ls\recho {{secret:demo}}\r')).toThrow(/secret_scope/)
    expect(writes).toHaveLength(1)
  })

  it('复制到剪贴板：30 秒后若仍是该值就清空，被用户换掉的不动', () => {
    vi.useFakeTimers()
    const { call, clip, setClip } = setup()
    const s = call('secrets:save', { name: 'demo', scope: 'all', value: V }) as { id: string }
    expect(call('secrets:copy', s.id)).toBe(CLIPBOARD_CLEAR_SEC)
    expect(clip()).toBe(V)
    vi.advanceTimersByTime(CLIPBOARD_CLEAR_SEC * 1000)
    expect(clip()).toBe('')
    call('secrets:copy', s.id); setClip('别的内容')
    vi.advanceTimersByTime(CLIPBOARD_CLEAR_SEC * 1000)
    expect(clip()).toBe('别的内容')
  })

  it('重复复制同一值会重置成完整 30 秒；退出前清掉还留在剪贴板里的密钥', () => {
    vi.useFakeTimers()
    const { svc, call, clip } = setup()
    const s = call('secrets:save', { name: 'demo', scope: 'all', value: V }) as { id: string }
    call('secrets:copy', s.id)
    vi.advanceTimersByTime(25_000)
    call('secrets:copy', s.id)          // 重新复制：前一个定时器应被取消
    vi.advanceTimersByTime(6_000)       // 距第一次 31 秒
    expect(clip()).toBe(V)
    svc.clearClipboardIfSecret()
    expect(clip()).toBe('')
    vi.advanceTimersByTime(CLIPBOARD_CLEAR_SEC * 1000)
    expect(clip()).toBe('')
  })
})
