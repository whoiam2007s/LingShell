import { describe, it, expect } from 'vitest'
import { UI_THEMES } from '@lingshell/shared'
import { TERMINAL_THEMES } from './termPrefs.js'

// 读源文件原文（vitest 里 css?raw 拿到的是空串；ui 包没有 node 类型，按名字动态取 fs）
const fs = (await import(/* @vite-ignore */ ['node', 'fs'].join(':'))) as { readFileSync: (p: URL, enc: 'utf8') => string }
const css = fs.readFileSync(new URL('../index.css', import.meta.url), 'utf8')
const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
// 某个选择器下的变量表（同一选择器可能分几块写，合并）
function varsOf(selector: string) {
  const out = new Map<string, string>()
  const esc = selector.replace(/[[\]"]/g, (c) => `\\${c}`)
  for (const m of css.matchAll(new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`, 'g')))
    for (const v of m[1].matchAll(/(--color-[\w-]+):\s*([^;]+);/g)) out.set(v[1], v[2].trim())
  return out
}
const root = varsOf(':root')

describe('界面主题配色（index.css）', () => {
  it(':root 有完整的颜色变量', () => {
    expect(root.size).toBeGreaterThanOrEqual(19)
    expect(root.get('--color-bg-base')).toBe('#0d1117')   // 暗黑 = 原深色，值不动
  })
  for (const t of UI_THEMES.filter((x) => x.id !== 'dark')) {
    it(`${t.label}（${t.id}）定义了 :root 的全部变量`, () => {
      const v = varsOf(`html[data-theme="${t.id}"]`)
      expect([...root.keys()].filter((k) => !v.has(k))).toEqual([])
    })
  }
  it('色卡颜色与 CSS 同值', () => {
    for (const t of UI_THEMES) {
      const v = t.id === 'dark' ? root : varsOf(`html[data-theme="${t.id}"]`)
      expect({ id: t.id, bg: v.get('--color-bg-base'), panel: v.get('--color-bg-panel'), accent: v.get('--color-accent'), text: v.get('--color-text-primary') })
        .toEqual({ id: t.id, ...t.swatch })
    }
  })
  it('浅色专属规则挂在 data-kind 上，不再写死 data-theme="light"', () => {
    expect(css).toContain('html[data-kind="light"] { color-scheme: light; }')
    expect(css.match(/data-theme="light"\]/g)).toHaveLength(1)   // 只剩配色块本身
  })
})

describe('首帧脚本（index.html）', () => {
  it('底色表与浅色表和 UI_THEMES 一致', () => {
    const B = Object.fromEntries([...html.match(/B=\{([^}]*)\}/)![1].matchAll(/(\w+):'(#[0-9a-f]{6})'/g)].map((m) => [m[1], m[2]]))
    expect(B).toEqual(Object.fromEntries(UI_THEMES.map((t) => [t.id, t.swatch.bg])))
    const L = [...html.match(/L=\{([^}]*)\}/)![1].matchAll(/(\w+):1/g)].map((m) => m[1]).sort()
    expect(L).toEqual(UI_THEMES.filter((t) => t.kind === 'light').map((t) => t.id).sort())
  })
})

describe('终端配色', () => {
  it('每套界面主题对应的终端配色都存在，且 16 色 + 前景 / 背景 / 光标 / 选区齐全', () => {
    const keys = ['background', 'foreground', 'cursor', 'selectionBackground', 'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
      'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite']
    for (const t of UI_THEMES) {
      const th = TERMINAL_THEMES[t.terminal]?.theme as Record<string, string> | undefined
      expect(th, t.terminal).toBeDefined()
      expect(keys.filter((k) => !/^#[0-9a-f]{6}$/i.test(th![k] ?? '')), t.terminal).toEqual([])
      expect(th!.background, t.terminal).toBe(t.swatch.bg)   // 终端底色与界面底色一致，看着是一块
    }
  })
})
