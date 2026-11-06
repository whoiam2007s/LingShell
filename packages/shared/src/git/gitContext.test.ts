import { describe, it, expect } from 'vitest'
import { gitContextText } from './gitContext.js'
import { GIT_PROMPT_DIFF_MAX } from './gitStatus.js'
import type { GitFile } from './gitStatus.js'

const f = (path: string, x: string, y: string, extra: Partial<GitFile> = {}): GitFile =>
  ({ path, x, y, conflict: false, untracked: false, ...extra } as GitFile)

describe('gitContextText：发到对话的仓库上下文', () => {
  it('列出仓库 / 分支 / 分组文件 / 最近提交', () => {
    const t = gitContextText({
      root: '/repo/a', branch: 'main', ahead: 2, behind: 1,
      files: [f('a.ts', 'M', '.'), f('b.ts', '.', 'M'), f('c.ts', '?', '?', { untracked: true })],
      commits: [{ hash: 'abcdef1234', subject: 'fix: 修正登录' }],
    })
    expect(t).toContain('仓库：/repo/a')
    expect(t).toContain('分支：main')
    expect(t).toContain('领先 2，落后 1')
    expect(t).toContain('已暂存（1）')
    expect(t).toContain('未暂存（1）')   // 只有 b.ts；c.ts 是未跟踪，单独一组不重复计
    expect(t).toContain('未跟踪（1）')
    expect(t).toContain('- abcdef1 fix: 修正登录')
  })

  it('分离头指针与进行中操作会写清楚', () => {
    const t = gitContextText({ root: '/r', branch: '', detached: true, progress: 'merge', files: [] })
    expect(t).toContain('（分离头指针）')
    expect(t).toContain('进行中的操作：merge')
  })

  it('diff 超过上限会截断并注明省略量', () => {
    const diff = 'x'.repeat(GIT_PROMPT_DIFF_MAX + 500)
    const t = gitContextText({ root: '/r', branch: 'main', files: [f('a', 'M', '.')], diff })
    expect(t).toContain('```diff')
    expect(t).toContain('省略 500 字')
    expect(t.length).toBeLessThan(diff.length + 2000)
  })

  it('有改动但没有文本 diff 时给出解释，而不是空着', () => {
    const t = gitContextText({ root: '/r', branch: 'main', files: [f('a.bin', 'M', '.')] })
    expect(t).toContain('没有可显示的文本 diff')
  })

  it('每组最多列 30 个，超出写「还有 N 个」', () => {
    const files = Array.from({ length: 35 }, (_, i) => f(`f${i}.ts`, 'M', '.'))
    const t = gitContextText({ root: '/r', branch: 'main', files })
    expect(t).toContain('… 还有 5 个')
  })
})
