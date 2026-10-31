import { describe, it, expect } from 'vitest'
import * as root from '@lingshell/shared'
import * as protocol from '@lingshell/shared/protocol'
import * as i18n from '@lingshell/shared/i18n'
import * as terminal from '@lingshell/shared/terminal'
import * as ai from '@lingshell/shared/ai'
import * as files from '@lingshell/shared/files'
import * as ops from '@lingshell/shared/ops'
import * as db from '@lingshell/shared/db'
import * as git from '@lingshell/shared/git'
import * as ui from '@lingshell/shared/ui'

// shared 的子路径导出（package.json exports）：根入口 = 各领域入口的并集，且是同一份对象
describe('@lingshell/shared 子路径', () => {
  const domains = { protocol, i18n, terminal, ai, files, ops, db, git, ui }
  it('各领域导出的都能从根入口拿到同一个值', () => {
    for (const [d, m] of Object.entries(domains)) {
      expect(Object.keys(m).length, d).toBeGreaterThan(0)
      for (const [k, v] of Object.entries(m)) expect((root as Record<string, unknown>)[k], `${d}.${k}`).toBe(v)
    }
  })
  it('根入口没有不属于任何领域的导出', () => {
    const all = new Set(Object.values(domains).flatMap((m) => Object.keys(m)))
    expect(Object.keys(root).filter((k) => !all.has(k))).toEqual([])
  })
})
