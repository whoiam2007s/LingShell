import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerAppInfo } from './appInfoIpc.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function setup(openErr = '') {
  const root = mkdtempSync(join(tmpdir(), 'lingshell-appinfo-'))
  dirs.push(root)
  const hs = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
  const opened: string[] = []
  registerAppInfo({ handle: (ch, fn) => { hs.set(ch, fn) }, version: '9.9.9', dataDir: root, logsDir: join(root, 'logs'),
    openPath: async (p) => { opened.push(p); return openErr } })
  return { root, opened, call: (ch: string, ...a: unknown[]) => hs.get(ch)!({}, ...a) }
}

describe('appInfoIpc', () => {
  it('appInfo 返回版本、运行环境与目录', () => {
    const { root, call } = setup()
    expect(call('system:appInfo')).toMatchObject({ version: '9.9.9', node: process.versions.node, platform: process.platform, arch: process.arch, dataDir: root, logsDir: join(root, 'logs') })
  })
  it('openDir 只认 data / logs，路径由主进程决定', async () => {
    const { root, opened, call } = setup()
    await call('system:openDir', 'data')
    await call('system:openDir', 'logs')
    expect(opened).toEqual([root, join(root, 'logs')])
    await expect(call('system:openDir', 'C:\\Windows')).rejects.toThrow('非法的目录')
  })
  it('打不开时抛出系统给的原因', async () => {
    await expect(setup('no app').call('system:openDir', 'data')).rejects.toThrow('no app')
  })
})
