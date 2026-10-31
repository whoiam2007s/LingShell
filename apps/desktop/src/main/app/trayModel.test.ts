import { describe, it, expect } from 'vitest'
import { ballLook, ballMenu, ballView, cut, isOwnLoginItem, normalizeBgConfig, paintBadge, trayMenu, trayTooltip, trimLocked, type BgSnapshot, type MenuNode } from './trayModel.js'

const base = (p: Partial<BgSnapshot> = {}): BgSnapshot => ({
  locked: false, lockEnabled: true, sessions: [], approvals: [], watchdog: { paused: false, firing: 0 }, transfers: { active: 0 },
  hosts: [], ball: false, ballOpacity: 100, ...p,
})
const labels = (m: MenuNode[]) => m.map((n) => n.type === 'separator' ? '—' : n.label)
const find = (m: MenuNode[], prefix: string) => m.find((n) => n.label?.startsWith(prefix))
const layout = { expanded: false, side: 'right' as const, valign: 'top' as const, theme: 'dark', kind: 'dark' as const }

describe('trayTooltip', () => {
  it('会话数 + 待授权数', () => {
    const s = base({ sessions: [{ id: 'a', title: 'A', status: 'running' }, { id: 'b', title: 'B', status: 'waiting' }], approvals: [{ approvalId: '1', sessionId: 'b', sessionTitle: 'B', command: 'ls' }] })
    expect(trayTooltip(s)).toBe('灵壳 · 2 个会话进行中 · 1 个待授权')
  })
  it('锁定时只写已锁定', () => expect(trayTooltip(base({ locked: true, sessions: [{ id: 'a', title: 'secret', status: 'running' }] }))).toBe('灵壳（已锁定）'))
})

describe('trayMenu', () => {
  it('完整菜单的顺序与动作', () => {
    const m = trayMenu(base({ hosts: [{ id: 'h1', label: 'web & db' }], ball: true }))
    expect(labels(m)).toEqual(['显示主窗口', '—', '新建会话', '新建本地终端', '连接主机', '待授权（0）', '—', '仪表盘', '看门狗：暂停全部', '显示悬浮球', '锁定应用', '设置', '—', '退出'])
    expect(find(m, '连接主机')!.submenu![0]).toMatchObject({ label: 'web && db', action: { type: 'ui', action: { type: 'connectHost', hostId: 'h1' } } })
    expect(find(m, '待授权')!.enabled).toBe(false)
    expect(find(m, '显示悬浮球')).toMatchObject({ type: 'checkbox', checked: true, action: { type: 'toggleBall' } })
    expect(find(m, '新建会话')!.action).toEqual({ type: 'ui', action: { type: 'newSession' } })
  })
  it('没有主机 / 主机太多', () => {
    expect(find(trayMenu(base()), '连接主机')!.submenu).toEqual([{ label: '还没有已保存的主机', enabled: false }])
    const many = Array.from({ length: 35 }, (_, i) => ({ id: `h${i}`, label: `h${i}` }))
    const sub = find(trayMenu(base({ hosts: many })), '连接主机')!.submenu!
    expect(sub).toHaveLength(31)
    expect(sub[30]).toMatchObject({ label: '还有 5 台，请在主机面板中打开', enabled: false })
  })
  it('待授权：会话标题 · 命令前 40 字，点击切到该会话', () => {
    const cmd = 'systemctl restart nginx && journalctl -u nginx -n 200 --no-pager | tail'
    const m = trayMenu(base({ approvals: [{ approvalId: '1', sessionId: 's1', sessionTitle: '排查 nginx', command: cmd }] }))
    const it0 = find(m, '待授权（1）')!.submenu![0]
    expect(it0.label).toBe(`排查 nginx · ${cut(cmd, 40).replace(/&/g, '&&')}`)
    expect(it0.action).toEqual({ type: 'openSession', sessionId: 's1' })
  })
  it('看门狗暂停 / 恢复与告警数；未启用应用锁时锁定灰', () => {
    expect(find(trayMenu(base({ watchdog: { paused: false, firing: 2 } })), '看门狗')).toMatchObject({ label: '看门狗：暂停全部（2 个告警）', action: { type: 'watchdogPause', paused: true } })
    expect(find(trayMenu(base({ watchdog: { paused: true, firing: 0 } })), '看门狗')).toMatchObject({ action: { type: 'watchdogPause', paused: false } })
    expect(find(trayMenu(base({ lockEnabled: false })), '锁定应用')!.enabled).toBe(false)
  })
  it('锁定时只留 显示主窗口 / 退出', () => {
    expect(labels(trayMenu(base({ locked: true, hosts: [{ id: 'h', label: 'h' }] })))).toEqual(['显示主窗口', '—', '退出'])
  })
})

describe('ballMenu', () => {
  it('完整菜单 + 透明度单选', () => {
    const m = ballMenu(base({ ballOpacity: 60 }))
    expect(labels(m)).toEqual(['显示主窗口', '快速提问', '处理待授权（0）', '打开仪表盘', '看门狗：暂停全部', '锁定应用', '透明度', '—', '隐藏悬浮球', '退出'])
    const op = find(m, '透明度')!.submenu!
    expect(op.map((x) => x.label)).toEqual(['40%', '60%', '80%', '100%'])
    expect(op.filter((x) => x.checked).map((x) => x.label)).toEqual(['60%'])
    expect(find(m, '快速提问')!.action).toEqual({ type: 'ui', action: { type: 'focusChat' } })
  })
  it('锁定时只有 显示主窗口 / 隐藏悬浮球 / 退出', () => {
    expect(labels(ballMenu(base({ locked: true })))).toEqual(['显示主窗口', '隐藏悬浮球', '—', '退出'])
  })
})

describe('ballLook / ballView', () => {
  const ap = { approvalId: '1', sessionId: 's', sessionTitle: 'S', command: 'rm -rf /tmp/x', host: 'web' }
  it('优先级：锁定 > 待授权 > 报警 / 出错 > 运行中 > 空闲', () => {
    expect(ballLook(base())).toEqual({ look: 'idle', badge: 0 })
    expect(ballLook(base({ sessions: [{ id: 's', title: 'S', status: 'running' }] })).look).toBe('running')
    expect(ballLook(base({ sessions: [{ id: 's', title: 'S', status: 'running' }], error: 'S' })).look).toBe('alert')
    expect(ballLook(base({ watchdog: { paused: false, firing: 1 } })).look).toBe('alert')
    expect(ballLook(base({ approvals: [ap, { ...ap, approvalId: '2' }], watchdog: { paused: false, firing: 1 } }))).toEqual({ look: 'waiting', badge: 2 })
    expect(ballLook(base({ locked: true, approvals: [ap] }))).toEqual({ look: 'locked', badge: 0 })
  })
  it('锁定时状态卡数据全部裁掉', () => {
    const v = ballView(base({ locked: true, approvals: [ap], sessions: [{ id: 's', title: '机密', status: 'waiting' }], stats: { title: 'web', cpuPct: 3 }, error: 'x', transfers: { active: 2, percent: 30 } }), layout)
    expect(v).toMatchObject({ locked: true, look: 'locked', badge: 0, sessions: [], approvals: [], transfers: { active: 0 } })
    expect(v.stats).toBeUndefined(); expect(v.error).toBeUndefined()
    expect(JSON.stringify(v)).not.toContain('机密')
  })
  it('卡片最多 5 个会话、3 条待授权；总数单独给（标题 / 「还有 N 个」用）', () => {
    const s = base({ sessions: Array.from({ length: 8 }, (_, i) => ({ id: `${i}`, title: `s${i}`, status: 'running' as const })), approvals: Array.from({ length: 5 }, (_, i) => ({ ...ap, approvalId: `${i}` })) })
    const v = ballView(s, layout)
    expect(v.sessions).toHaveLength(5); expect(v.approvals).toHaveLength(3); expect(v.badge).toBe(5); expect(v.sessionCount).toBe(8)
    expect(v.approvals[0]).toEqual({ approvalId: '0', sessionId: 's', command: 'rm -rf /tmp/x', host: 'web' })
    expect(ballView(base(), layout).sessionCount).toBe(0)
  })
  it('trimLocked 未锁定原样返回', () => { const s = base({ hosts: [{ id: 'a', label: 'a' }] }); expect(trimLocked(s)).toBe(s) })
})

describe('normalizeBgConfig', () => {
  it('缺省值', () => expect(normalizeBgConfig(undefined)).toEqual({ closeToTray: true, trayHintShown: false, ball: false, ballOpacity: 100, ballAutoHide: true }))
  it('坏值回落、透明度夹到 40–100、位置取整', () => {
    expect(normalizeBgConfig({ closeToTray: false, ball: true, ballOpacity: 5, ballAutoHide: false, ballPos: { x: 10.6, y: 20, edge: 'top' } }))
      .toEqual({ closeToTray: false, trayHintShown: false, ball: true, ballOpacity: 40, ballAutoHide: false, ballPos: { x: 11, y: 20 } })
    expect(normalizeBgConfig({ ballOpacity: 'x', ballPos: { x: 'a', y: 1 } })).toEqual({ closeToTray: true, trayHintShown: false, ball: false, ballOpacity: 100, ballAutoHide: true })
    expect(normalizeBgConfig({ ballPos: { x: 1, y: 2, edge: 'right' } }).ballPos).toEqual({ x: 1, y: 2, edge: 'right' })
  })
})

describe('cut / isOwnLoginItem', () => {
  it('cut 压成一行、超长截断，且不把 emoji 截成半个', () => {
    expect(cut(' a\n b ', 10)).toBe('a b')
    expect(cut('abcdef', 3)).toBe('abc…')
    expect(cut('😀😀😀', 3)).toBe('😀…')
  })
  it('登录项只认自己的名字 / 安装目录，别人的同名目录不算', () => {
    expect(isOwnLoginItem({ name: 'LingShell' })).toBe(true)
    expect(isOwnLoginItem({ name: '灵壳 LingShell' })).toBe(true)
    expect(isOwnLoginItem({ name: 'LingShell', path: 'C:\\Program Files\\LingShell\\a.exe' })).toBe(true)
    expect(isOwnLoginItem({ name: 'x', path: 'C:\\Program Files\\LingShell\\LingShell.exe' })).toBe(true)
    expect(isOwnLoginItem({ name: 'my-lingshell-client', path: 'C:\\Users\\me\\my-lingshell-client\\a.exe' })).toBe(false)
    expect(isOwnLoginItem({ name: '其他', path: 'C:\\Tools\\LingShellHelper\\a.exe' })).toBe(false)
    expect(isOwnLoginItem({ name: '其他', path: 'C:\\Downloads\\LingShell.exe' })).toBe(false)
  })
})

describe('paintBadge', () => {
  it('右上角画红点，左下角不动', () => {
    const size = 32
    const buf = new Uint8Array(size * size * 4)
    paintBadge(buf, size)
    const px = (x: number, y: number) => [...buf.slice((y * size + x) * 4, (y * size + x) * 4 + 4)]
    expect(px(size - 8, 7)).toEqual([0x49, 0x51, 0xf8, 0xff])   // 红点中心（BGRA）
    expect(px(2, size - 2)).toEqual([0, 0, 0, 0])
  })
})
