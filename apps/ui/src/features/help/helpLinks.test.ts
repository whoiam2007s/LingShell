import { describe, it, expect } from 'vitest'
import { linkify } from './helpLinks.js'
import { HELP_SECTIONS, blockText } from './helpContent.js'

// 设置页标题表（与 SettingsModal 的 TITLES 同形；测试里写死，避免引入整个弹窗组件）
const T = {
  model: '模型设置', ssh: '主机与连接', terminal: '终端', ai: 'AI 与安全', general: '通用',
  templates: '常用任务模板', runbooks: '运维手册', schedules: '定时巡检', mcp: 'MCP 服务',
  keys: 'SSH 密钥', network: '网络代理', recordings: '终端录像', about: '关于',
  maintenance: '备份与诊断', shortcuts: '快捷键', skills: 'Skills', secrets: '密钥保险箱', mobile: '手机访问',
  compliance: '合规基线',
} as const

describe('帮助正文链接', () => {
  it('「设置 → 页名」只链到页名，后面照常', () => {
    expect(linkify('「设置 → AI 与安全 → 应用锁」里打开', T)).toEqual([
      '「', { text: '设置 → AI 与安全', action: { kind: 'settings', tab: 'ai' } }, ' → 应用锁」里打开',
    ])
  })
  it('终端 / 终端录像 前缀相同时各自跳对', () => {
    expect(linkify('设置 → 终端 → 提醒', T)[0]).toEqual({ text: '设置 → 终端', action: { kind: 'settings', tab: 'terminal' } })
    expect(linkify('设置 → 终端录像', T)[0]).toEqual({ text: '设置 → 终端录像', action: { kind: 'settings', tab: 'recordings' } })
  })
  it('帮助里不再引用已拆掉的「系统设置」页', () => {
    for (const s of HELP_SECTIONS) for (const b of s.blocks) expect(blockText(b)).not.toMatch(/设置\s*→\s*系统设置/)
  })
  it('导出配置 / 诊断包已移到「备份与诊断」页', () => {
    expect(linkify('设置 → 备份与诊断 → 诊断包', T)[0]).toEqual({ text: '设置 → 备份与诊断', action: { kind: 'settings', tab: 'maintenance' } })
    for (const s of HELP_SECTIONS) for (const b of s.blocks) expect(blockText(b)).not.toMatch(/关于\s*→\s*(配置|诊断)/)
  })
  it('「用量统计」已移出设置，链到独立弹窗', () => {
    expect(linkify('点标题栏「用量统计」', T)[1]).toEqual({ text: '「用量统计」', action: { kind: 'usage' } })
    for (const s of HELP_SECTIONS) for (const b of s.blocks) expect(blockText(b)).not.toMatch(/设置\s*→\s*用量统计/)
  })
  it('词表里的「功能名」变链接，不认识的原样', () => {
    const r = linkify('点「容器视图（Docker）」或「打开设置」', T)
    expect(r[1]).toEqual({ text: '「容器视图（Docker）」', action: { kind: 'palette', cmd: { type: 'termDrawer', drawer: 'docker' } } })
    expect(r.slice(2).join('')).toBe('或「打开设置」')
  })
  it('「设置页标题」本身也能点', () => {
    expect(linkify('在「终端录像」页', T)[1]).toEqual({ text: '「终端录像」', action: { kind: 'settings', tab: 'recordings' } })
  })
  it('没有入口的文字原样返回（拼回去不丢字）', () => {
    for (const s of HELP_SECTIONS) for (const b of s.blocks) {
      const text = blockText(b)
      expect(linkify(text, T).map((p) => typeof p === 'string' ? p : p.text).join('')).toBe(text)
    }
  })
  it('帮助内容里确实有链接（每节至少一处入口可点的章节不少于一半）', () => {
    const linked = HELP_SECTIONS.filter((s) => s.blocks.some((b) => linkify(blockText(b), T).some((p) => typeof p !== 'string')))
    expect(linked.length).toBeGreaterThan(HELP_SECTIONS.length / 2)
  })
})
