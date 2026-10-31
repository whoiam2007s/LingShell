import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TerminalInfo } from '@lingshell/shared'
import { diskCommonCommand, parseDiskCommon } from '@lingshell/shared'
import { diskTarget, registerDiskUsage } from './diskUsageIpc.js'
import { findBash } from '../core/index.js'
import { localRunner } from './batchExec.js'

// 真实跑 du / find（本机 bash；Windows 用 Git Bash，与本地终端的分析同一条路）：临时目录里造几层目录和大文件
const bash = findBash()
const root = mkdtempSync(join(tmpdir(), 'ga-disk-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
mkdirSync(join(root, 'logs', 'old'), { recursive: true })
mkdirSync(join(root, 'data'))
mkdirSync(join(root, "it's here"))
writeFileSync(join(root, 'logs', 'old', 'big.log'), Buffer.alloc(3 * 1024 * 1024, 1))
writeFileSync(join(root, 'data', 'mid.bin'), Buffer.alloc(1024 * 1024, 2))
writeFileSync(join(root, "it's here", 'x.txt'), 'x')
writeFileSync(join(root, 'top.txt'), Buffer.alloc(200 * 1024, 3))

const handlers = new Map<string, (...a: unknown[]) => unknown>()
const term = (id: string): TerminalInfo | undefined => (id === 'loc' ? { id, type: 'local', title: '本地', status: 'running' } as TerminalInfo
  : id === 'win' ? { id, type: 'ssh', os: 'windows', title: 'w', status: 'running' } as TerminalInfo : undefined)
registerDiskUsage({
  handle: (ch, fn) => handlers.set(ch, fn), terminal: term,
  sshExec: () => { throw new Error('不该走 SSH') },
  localExec: () => (process.platform === 'win32' && !bash ? undefined : localRunner(bash ?? undefined).exec),
})
const call = (ch: string, ...a: unknown[]) => handlers.get(ch)!(null, ...a)

describe.skipIf(process.platform === 'win32' && !bash)('磁盘空间分析（真实 du / find）', () => {
  it('一层：按大小排、目录 / 文件分开、带分区信息，下钻到子目录', async () => {
    const r = await call('disk:level', 'local', root) as Awaited<ReturnType<typeof import('@lingshell/shared').parseDiskLevel>>
    expect(r.truncated).toBe(false)
    expect(r.entries.map((e) => e.name)).toEqual(['logs', 'data', 'top.txt', "it's here"])
    expect(r.entries[0]).toMatchObject({ dir: true, path: `${root}/logs` })
    expect(r.entries.find((e) => e.name === 'top.txt')?.dir).toBe(false)
    expect(r.totalKb).toBeGreaterThanOrEqual(4200)
    expect(r.fs?.sizeKb).toBeGreaterThan(0)
    const sub = await call('disk:level', { terminalId: 'loc' }, `${root}/logs`) as typeof r   // 本地终端也走本机
    expect(sub.entries.map((e) => e.name)).toEqual(['old'])
  }, 60_000)
  it('大文件：超过阈值的按大小倒序', async () => {
    const run = localRunner(bash ?? undefined)
    const { diskBigCommand, parseDiskBig } = await import('@lingshell/shared')
    const r = parseDiskBig((await run.exec(diskBigCommand(root, 1), { timeoutMs: 60_000 })).output, root, 1)
    expect(r.truncated).toBe(false)
    expect(r.files.map((f) => f.path.slice(root.length + 1))).toEqual(['logs/old/big.log'])   // 正好 1MB 的不算「超过 1MB」
    expect(r.files[0].bytes).toBe(3 * 1024 * 1024)
  }, 60_000)
  it('常见占用：总预算生效，命令能正常结束并可解析', async () => {
    const run = localRunner(bash ?? undefined)
    const t0 = Date.now()
    const out = (await run.exec(diskCommonCommand(2, 3), { timeoutMs: 20_000 })).output
    expect(Date.now() - t0).toBeLessThan(15_000)
    expect(out).toContain('@@journal')
    expect(() => parseDiskCommon(out)).not.toThrow()
  }, 30_000)
  it('目录不存在 / 非法参数 / Windows SSH / 非 Linux 的常见占用', async () => {
    await expect(call('disk:level', 'local', join(root, 'nope'))).rejects.toThrow('目录不存在')
    await expect(call('disk:level', 'local', 'a\nb')).rejects.toThrow('非法的目录')
    expect(() => diskTarget({ terminal: term, sshExec: () => { throw new Error() }, localExec: () => undefined }, { terminalId: 'win' })).toThrow('不支持 Windows')
    if (process.platform !== 'linux') await expect(call('disk:common', 'local')).rejects.toThrow('只支持 Linux')
  })
})
