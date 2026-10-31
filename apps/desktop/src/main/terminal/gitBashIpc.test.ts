import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { registerGitBash } from './gitBashIpc.js'

const SELF = fileURLToPath(import.meta.url)

function setup(o: { platform?: string; pick?: string; validate?: string }) {
  const hs = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
  let saved = ''
  registerGitBash({
    handle: (ch, fn) => hs.set(ch, fn), platform: o.platform ?? 'win32',
    getPath: () => saved, setPath: (p) => { saved = p },
    pickFile: async () => o.pick, validate: async () => o.validate,
  })
  return { call: (ch: string) => hs.get(ch)!(null), saved: () => saved }
}

describe('gitBash IPC', () => {
  it('非 Windows：不需要 Git Bash', async () => {
    expect(await setup({ platform: 'linux' }).call('gitBash:status')).toEqual({ required: false })
  })
  it('取消选择 → null，不改设置', async () => {
    const s = setup({})
    expect(await s.call('gitBash:pick')).toBeNull()
    expect(s.saved()).toBe('')
  })
  it('选的文件校验不过 → 抛出原因，不存', async () => {
    const s = setup({ pick: 'C:\\Windows\\System32\\bash.exe', validate: '这是 WSL 的 bash 启动器' })
    await expect(s.call('gitBash:pick')).rejects.toThrow(/invalid_bash: 这是 WSL/)
    expect(s.saved()).toBe('')
  })
  it('校验通过 → 存进设置；清除 → 回到自动探测', async () => {
    const s = setup({ pick: SELF })   // 存在的文件即可（校验已注入）
    const st = await s.call('gitBash:pick') as { required: boolean; custom?: string }
    expect(s.saved()).toBe(SELF)
    if (process.platform === 'win32') expect(st).toMatchObject({ required: true, custom: SELF, path: SELF, source: 'settings' })
    await s.call('gitBash:clear')
    expect(s.saved()).toBe('')
  })
})
