import { it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExplainResult, PreviewData } from '@lingshell/shared'
import { registerConfigExplain } from './configExplainIpc.js'
import { registerFilePreview } from '../files/index.js'
import { localAccess } from '../files/index.js'

it('配置解释：按内容缓存，改了才重新请求；force 忽略缓存；发出去的是脱敏后的', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lingshell-ce-'))
  const hs = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
  const sent: string[] = []
  registerConfigExplain({
    handle: (ch, fn) => { hs.set(ch, fn) }, dir,
    complete: async (_s, u) => { sent.push(u); return '[{"start":2,"end":2,"title":"PermitRootLogin","explain":"允许 root 登录","risk":"建议改为 prohibit-password","level":"danger"}]' },
    redact: (t) => t.replace(/secret123/g, '[已脱敏]'),
  })
  const run = (p: string, t: string, f?: boolean) => hs.get('configExplain:run')!({}, p, t, f) as Promise<ExplainResult>
  try {
    const a = await run('/etc/ssh/sshd_config', 'Port 22\nPermitRootLogin yes\n# pw secret123\n')
    expect(a).toMatchObject({ kind: 'sshd', truncated: false, items: [{ start: 2, level: 'danger' }] })
    expect(a.cached).toBeUndefined()
    expect(sent[0]).toContain('2| PermitRootLogin yes')
    expect(sent[0]).not.toContain('secret123')
    expect((await run('/etc/ssh/sshd_config', 'Port 22\nPermitRootLogin yes\n# pw secret123\n')).cached).toBe(true)
    expect(sent).toHaveLength(1)
    // 形状不对的缓存（被改坏）不能直接交给界面
    const cacheFile = join(dir, readdirSync(dir).find((f) => f.endsWith('.json'))!)
    writeFileSync(cacheFile, '{"kind":"sshd","at":"x","truncated":false,"items":null}')
    const again = await run('/etc/ssh/sshd_config', 'Port 22\nPermitRootLogin yes\n# pw secret123\n')
    expect(again.items).toHaveLength(1)
    expect(again.cached).toBeUndefined()
    expect(sent).toHaveLength(2)
    if (process.platform !== 'win32') expect(statSync(cacheFile).mode & 0o777).toBe(0o600)
    await run('/etc/ssh/sshd_config', 'Port 2222\nPermitRootLogin yes\n')
    await run('/etc/ssh/sshd_config', 'Port 2222\nPermitRootLogin yes\n', true)
    expect(sent).toHaveLength(4)
    await expect(run('/etc/hosts', 'x')).rejects.toThrow('不认识')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('文件预览：图片给 base64、CSV 给文本；不支持的类型 / 超限 / 不存在报错', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lingshell-pv-'))
  const hs = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
  const opened: string[] = []
  let reads = 0
  const base = localAccess(dir)
  const access = { ...base, read: (p: string, max?: number) => { reads++; return base.read(p, max) } }
  registerFilePreview({ handle: (ch, fn) => { hs.set(ch, fn) }, access: async () => access, tempDir: join(dir, 'tmp'), openPath: async (p) => { opened.push(p); return '' }, externalMaxBytes: 1024 * 1024 })
  const read = (p: string) => hs.get('preview:read')!({}, 'local', p) as Promise<PreviewData>
  try {
    writeFileSync(join(dir, 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    writeFileSync(join(dir, 'b.csv'), 'a,b\n1,2\n')
    writeFileSync(join(dir, 'big.md'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61))
    writeFileSync(join(dir, 'big.csv'), Buffer.alloc(5 * 1024 * 1024 + 1, 0x61))
    writeFileSync(join(dir, 'big.png'), Buffer.alloc(20 * 1024 * 1024 + 1, 0x61))
    writeFileSync(join(dir, 'huge.pdf'), Buffer.alloc(1024 * 1024 + 1, 0x25))
    writeFileSync(join(dir, 'c.pdf'), '%PDF-1.4')
    expect(await read(join(dir, 'a.png'))).toEqual({ kind: 'image', name: 'a.png', size: 4, base64: 'iVBORw==' })
    expect(await read(join(dir, 'b.csv'))).toEqual({ kind: 'csv', name: 'b.csv', size: 8, text: 'a,b\n1,2\n' })
    await expect(read(join(dir, 'x.txt'))).rejects.toThrow('不支持预览')
    await expect(read(join(dir, 'nope.md'))).rejects.toThrow('不存在')
    await expect(read(join(dir, 'big.md'))).rejects.toThrow('超过 2MB')
    await expect(read(join(dir, 'big.csv'))).rejects.toThrow('超过 5MB')
    await expect(read(join(dir, 'big.png'))).rejects.toThrow('超过 20MB')
    // 本地「用系统程序打开」不经过应用读文件：小文件直接交给系统；31MB 的本地文件也不受远程 1MB 外部上限影响、不读进内存
    reads = 0
    await hs.get('preview:openExternal')!({}, 'local', join(dir, 'a.png'))
    expect(opened).toEqual([join(dir, 'a.png')])
    expect(reads).toBe(0)
    const bigLocal = join(dir, 'big-local.bin')
    writeFileSync(bigLocal, '')
    truncateSync(bigLocal, 31 * 1024 * 1024)
    await hs.get('preview:openExternal')!({}, 'local', bigLocal)
    expect(opened.at(-1)).toBe(bigLocal)
    expect(reads).toBe(0)
    // 远程：先下到临时目录（0600）再交给系统；超过外部打开上限直接拒绝
    await hs.get('preview:openExternal')!({}, { terminalId: 't1' }, join(dir, 'c.pdf'))
    const tmp = readdirSync(join(dir, 'tmp'))
    expect(tmp).toHaveLength(1)
    expect(readFileSync(join(dir, 'tmp', tmp[0]), 'utf8')).toBe('%PDF-1.4')
    if (process.platform !== 'win32') expect(statSync(join(dir, 'tmp', tmp[0])).mode & 0o777).toBe(0o600)
    expect(opened[2]).toBe(join(dir, 'tmp', tmp[0]))
    await expect(hs.get('preview:openExternal')!({}, { terminalId: 't1' }, join(dir, 'huge.pdf'))).rejects.toThrow('超过 1MB')
    expect(existsSync(opened[2])).toBe(true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
