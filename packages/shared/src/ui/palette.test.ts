import { describe, it, expect } from 'vitest'
import { matchTier, paletteSections, parsePaletteQuery, pushRecent, PALETTE_RECENT_MAX, type PaletteItem } from './palette.js'

const items: PaletteItem[] = [
  { id: 'a:local', kind: 'action', title: '新建本地终端', common: true },
  { id: 'a:ssh', kind: 'action', title: '新建 SSH 连接', common: true },
  { id: 'a:split', kind: 'action', title: '切换分屏布局：左右分屏', keywords: 'split layout' },
  { id: 'host:1', kind: 'host', title: 'web-prod', subtitle: 'root@10.0.0.1:22' },
  { id: 'host:2', kind: 'host', title: 'db-test', subtitle: 'admin@10.0.0.2:22' },
  { id: 'session:1', kind: 'session', title: '排查 nginx 502', subtitle: 'D:\\work' },
  { id: 'session:2', kind: 'session', title: '部署到测试环境' },
  { id: 'quick:df', kind: 'quick', title: '查看磁盘', subtitle: 'df -h' },
  { id: 'settings:ssh', kind: 'settings', title: 'SSH 连接管理' },
]
const flat = (q: string, recent: string[] = []) => paletteSections(q, items, recent).flatMap((s) => s.items.map((i) => i.id))

describe('parsePaletteQuery', () => {
  it('识别 > @ # 前缀并去掉', () => {
    expect(parsePaletteQuery('>新建')).toEqual({ kind: 'action', text: '新建' })
    expect(parsePaletteQuery(' @ web ')).toEqual({ kind: 'host', text: 'web' })
    expect(parsePaletteQuery('#')).toEqual({ kind: 'session', text: '' })
    expect(parsePaletteQuery('nginx')).toEqual({ text: 'nginx' })
  })
  it('? / ？ / 「帮助 xxx」只搜帮助；单独「帮助」搜全部', () => {
    expect(parsePaletteQuery('?端口转发')).toEqual({ kind: 'help', text: '端口转发' })
    expect(parsePaletteQuery('？ 粘贴')).toEqual({ kind: 'help', text: '粘贴' })
    // 中文输入法全角标点
    expect(parsePaletteQuery('＞新建')).toEqual({ kind: 'action', text: '新建' })
    expect(parsePaletteQuery('＠web')).toEqual({ kind: 'host', text: 'web' })
    expect(parsePaletteQuery('＃会话')).toEqual({ kind: 'session', text: '会话' })
    expect(parsePaletteQuery('帮助  凭据 ')).toEqual({ kind: 'help', text: '凭据' })
    expect(parsePaletteQuery('帮助')).toEqual({ text: '帮助' })
    expect(parsePaletteQuery('帮助文档')).toEqual({ text: '帮助文档' })
  })
})

describe('matchTier', () => {
  it('前缀 > 词首 > 子串 > 子序列', () => {
    expect(matchTier('web-prod', 'web')).toBe(100)
    expect(matchTier('web-prod', 'prod')).toBe(70)
    expect(matchTier('排查 nginx 502', 'nginx')).toBe(70)
    expect(matchTier('重启nginx', 'ng')).toBe(70)          // 中英文交界算词首
    expect(matchTier('web-prod', 'rod')).toBe(40)
    expect(matchTier('web-prod', 'wpd')).toBe(10)
    expect(matchTier('web-prod', 'wpd', false)).toBe(0)
    expect(matchTier('web-prod', 'xyz')).toBe(0)
  })
  it('中文子串', () => {
    expect(matchTier('新建本地终端', '本地')).toBe(40)
    expect(matchTier('新建本地终端', '新建')).toBe(100)
    expect(matchTier('新建本地终端', '建终')).toBe(10)   // 子序列
  })
})

describe('paletteSections', () => {
  it('空查询：最近使用在前，再接常用；不重复', () => {
    const s = paletteSections('', items, ['host:2', 'a:local'])
    expect(s.map((x) => x.label)).toEqual(['最近使用', '常用'])
    expect(s[0].items.map((i) => i.id)).toEqual(['host:2', 'a:local'])
    expect(s[1].items.map((i) => i.id)).toEqual(['a:ssh'])
  })
  it('前缀只留该类；空文本时列出该类全部', () => {
    expect(flat('@')).toEqual(['host:1', 'host:2'])
    expect(flat('>分屏')).toEqual(['a:split'])
    expect(flat('#部署')).toEqual(['session:2'])
    expect(flat('@部署')).toEqual([])
  })
  it('按档排序：标题前缀优先于副标题 / 子串', () => {
    // 「SSH 连接管理」前缀 100 >「新建 SSH 连接」词首 70
    expect(flat('ssh')).toEqual(['settings:ssh', 'a:ssh'])
    expect(flat('prod')).toEqual(['host:1'])   // web-prod 里 prod 是词首
  })
  it('副标题、关键词也能搜到（折半计分）', () => {
    expect(flat('10.0.0.2')).toEqual(['host:2'])
    expect(flat('df')).toEqual(['quick:df'])
    expect(flat('layout')).toEqual(['a:split'])
  })
  it('多个词都要中', () => {
    expect(flat('nginx 502')).toEqual(['session:1'])
    expect(flat('nginx 404')).toEqual([])
  })
  it('最近使用加分：同档内靠前，但不越过更高档', () => {
    // 「新建」对两个动作都是前缀；最近用过 SSH 那个就排前面
    expect(flat('新建').slice(0, 2)).toEqual(['a:local', 'a:ssh'])
    expect(flat('新建', ['a:ssh']).slice(0, 2)).toEqual(['a:ssh', 'a:local'])
    // 「web」对 web-prod 是前缀（100）；db-test 不中 → 最近用过也不出现
    expect(flat('web', ['host:2'])).toEqual(['host:1'])
  })
  it('结果按类分组，组序跟随最高分', () => {
    const s = paletteSections('ssh', items, [])
    expect(s.map((x) => x.label)).toEqual(['设置', '动作'])
  })
  it('最多 limit 条', () => {
    const many: PaletteItem[] = Array.from({ length: 30 }, (_, i) => ({ id: `h${i}`, kind: 'host', title: `host-${i}` }))
    expect(paletteSections('host', many, [], 12).flatMap((s) => s.items)).toHaveLength(12)
  })
})

describe('pushRecent', () => {
  it('提到最前、去重、限长', () => {
    expect(pushRecent(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c'])
    const long = Array.from({ length: PALETTE_RECENT_MAX }, (_, i) => `x${i}`)
    const next = pushRecent(long, 'new')
    expect(next).toHaveLength(PALETTE_RECENT_MAX)
    expect(next[0]).toBe('new')
  })
})
