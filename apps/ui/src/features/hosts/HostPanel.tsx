import { useEffect, useRef, useState } from 'react'
import { Search, Server, Star, ChevronDown, ChevronRight, Layers, Activity, Plug, Plus, SquarePlus, Pencil, Copy, Clock, LayoutGrid } from 'lucide-react'
import { filterHosts, groupHosts, pickHosts, toggleFavorite, probeLabel, probeTone, groupNeedsConfirm, groupLayout, tr, type HostSummary, type ProbeResult } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { paletteSend } from '../../lib/paletteBus.js'
import { ConfirmDialog } from '../common/index.js'
import { ProdBadge } from '../../components/sshParts.js'
import { useHostPrefs, patchHostPrefs, recordRecentHost } from './hostPrefs.js'
import { useHostProbe } from './useHostProbe.js'
import { WorkspaceList } from './WorkspaceList.js'
import { BookMarked, Network } from 'lucide-react'
import { openKnowledge } from '../knowledge/index.js'
import { quoteToChat } from '../../lib/quoteToChat.js'
import { trx } from '../../lib/trx.js'
import { ScrollText } from 'lucide-react'
import { RulesDialog, type RulesTarget } from './RulesDialog.js'

export type HostPanelTab = 'hosts' | 'workspaces'
const ITEM = 'flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left hover:bg-[var(--color-bg-hover)]'
const TONE_CLS: Record<ReturnType<typeof probeTone>, string> = {
  good: 'text-[var(--color-success)]', fair: 'text-[var(--color-warn)]', slow: 'text-[var(--color-danger)]', down: 'text-[var(--color-danger)]', none: 'text-[var(--color-text-muted)]',
}

type Menu = { x: number; y: number } & ({ host: HostSummary } | { group: string; hosts: HostSummary[] })

// 主机面板：标题栏「主机」按钮 / Ctrl+Shift+H 打开的浮层，盖在会话面板左上，不占布局。
// 「主机」页：搜索、收藏、最近连接、分组树、延迟；双击连接，右键更多。「工作区」页：保存 / 打开 / 重命名 / 删除
export function HostPanel({ initialTab = 'hosts', saveWorkspace, onClose, onEditHosts, onNewHost }: {
  initialTab?: HostPanelTab
  saveWorkspace?: boolean        // 打开即进入「保存当前布局为工作区」
  onClose: () => void
  onEditHosts: () => void        // 编辑主机 → 设置里的 SSH 连接管理
  onNewHost: () => void          // 新建主机 → 设置 → 主机与连接，直接打开新建表单
}) {
  const [tab, setTab] = useState<HostPanelTab>(saveWorkspace ? 'workspaces' : initialTab)
  const [hosts, setHosts] = useState<HostSummary[]>([])
  const [q, setQ] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<Menu | null>(null)
  const [confirmGroup, setConfirmGroup] = useState<HostSummary[] | null>(null)
  const [modal, setModal] = useState(false)   // 子组件的确认框开着：点面板外不收起
  const [rules, setRules] = useState<RulesTarget | null>(null)   // 分组 / 主机规则编辑框
  const [note, setNote] = useState('')   // 复制主机等操作的反馈（以前失败是静默的）
  const prefs = useHostPrefs()
  const probeOn = prefs.hostProbe !== false
  const probe = useHostProbe(hosts, probeOn && tab === 'hosts')
  const ref = useRef<HTMLDivElement>(null)
  const loadHosts = () => client.hosts.list().then(setHosts).catch(() => {})
  useEffect(() => { void loadHosts() }, [])

  // 点面板外 / Esc 收起（标题栏的「主机」按钮自己切换，不算外部）
  const busy = !!confirmGroup || modal || !!rules
  useEffect(() => {
    if (busy) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element
      if (!ref.current?.contains(t) && !t.closest?.('[data-host-panel-toggle]')) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (menu) setMenu(null); else onClose() } }
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [busy, menu])

  // 连接：该主机已有打开的终端就切过去；新标签连接：总是新开
  const connect = async (h: HostSummary, newTab = false) => {
    setMenu(null); onClose()
    if (!newTab) {
      // 只复用还活着的终端：断开的标签不能算「已打开」，否则点了像没反应
      const open = (await client.terminal.list().catch(() => [])).find((t) => t.hostId === h.id && t.status !== 'disconnected')
      if (open) { paletteSend({ type: 'focusTerm', id: open.id }); void recordRecentHost(h.id); return }
    }
    paletteSend({ type: 'connectHost', hostId: h.id })
  }
  const openGroup = (list: HostSummary[], confirmed = false) => {
    setMenu(null)
    if (!confirmed && groupNeedsConfirm(list)) { setConfirmGroup(list); return }
    setConfirmGroup(null); onClose()
    paletteSend({ type: 'openWorkspace', ws: groupLayout(list.map((h) => h.id)) })
  }
  const duplicate = async (h: HostSummary) => {
    setMenu(null)
    try { const c = await client.hostPanel.duplicate(h.id); setNote(tr('已复制为「{name}」', { name: c.label })); setTimeout(() => setNote(''), 3000) }
    catch (e) { setNote(tr('复制失败：{err}', { err: e instanceof Error ? e.message : String(e) })); setTimeout(() => setNote(''), 5000) }
    void loadHosts()
  }
  const fav = (id: string) => void patchHostPrefs((p) => ({ favoriteHosts: toggleFavorite(p.favoriteHosts, id) }))
  const toggleGroup = (g: string) => setCollapsed((s) => { const n = new Set(s); if (!n.delete(g)) n.add(g); return n })

  const filtered = filterHosts(hosts, q)
  const favs = pickHosts(hosts, prefs.favoriteHosts)
  const recents = pickHosts(hosts, prefs.recentHosts)
  const row = (h: HostSummary, section: string) => (
    <HostRow key={`${section}:${h.id}`} h={h} fav={!!prefs.favoriteHosts?.includes(h.id)} probe={probe[h.id]}
      onFav={() => fav(h.id)} onConnect={() => connect(h)}
      onMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, host: h }) }} />
  )

  return (
    <div ref={ref} role="dialog" aria-label={tr('主机面板')} onMouseDown={() => { if (menu) setMenu(null) }}
      className="absolute left-2 top-1 z-40 flex max-h-[min(640px,calc(100%-8px))] w-[360px] flex-col overflow-hidden rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] text-[12px] text-[var(--color-text-primary)] shadow-2xl animate-fade-in">
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--color-border-subtle)] px-2 py-1.5">
        {([['hosts', tr('主机'), Server], ['workspaces', tr('工作区'), LayoutGrid]] as const).map(([k, label, Icon]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 ${tab === k ? 'bg-[var(--color-accent-bg)] font-medium text-[var(--color-accent)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'}`}>
            <Icon className="h-3.5 w-3.5" />{label}
          </button>
        ))}
        {tab === 'hosts' && (
          <>
            <button onClick={() => void patchHostPrefs(() => ({ hostProbe: !probeOn }))}
              title={probeOn ? tr('延迟探测：开（面板打开时每分钟 TCP 连一次 SSH 端口计时，不登录）。点击关闭') : tr('延迟探测：关。点击开启')}
              className={`ml-auto flex h-6 w-6 items-center justify-center rounded-md hover:bg-[var(--color-bg-hover)] ${probeOn ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'}`}><Activity className="h-3.5 w-3.5" /></button>
            <button onClick={() => { onClose(); onNewHost() }} title={tr('新建主机（打开设置 → 主机与连接 → 新建主机）')}
              className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)]"><Plus className="h-3.5 w-3.5" /></button>
          </>
        )}
      </div>

      {tab === 'workspaces'
        ? <WorkspaceList autoSave={saveWorkspace} onOpened={onClose} onModal={setModal} />
        : (
          <>
            <div className="shrink-0 px-2 pt-2">
              <div className="flex items-center gap-1.5 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2 py-1 focus-within:border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)]">
                <Search className="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" />
                <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('搜索标签/地址/用户/分组/备注，Enter 连接第一个')}
                  // Enter 连的是「界面上排第一的那台」（按分组顺序；有搜索词时才生效）：以前按存储顺序取，可能连到别的（甚至是生产）主机
                  onKeyDown={(e) => {
                    const first = q.trim() ? groupHosts(filtered)[0]?.hosts[0] : undefined
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing && first) void connect(first)
                    else if (e.key === 'ArrowDown') { e.preventDefault(); document.querySelector<HTMLElement>('[data-host-row]')?.focus() }
                  }}
                  className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-[var(--color-text-muted)]" />
              </div>
            </div>
            {note && <div className="shrink-0 px-3 text-[11px] text-[var(--color-accent)]">{note}</div>}
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
              {!hosts.length && <div className="px-2 py-4 text-center text-[11px] text-[var(--color-text-muted)]">{trx('还没有已保存的主机。{btn}', { btn: <button onClick={() => { onClose(); onNewHost() }} className="text-[var(--color-accent)] hover:underline">{tr('新建主机')}</button> })}</div>}
              {!q && favs.length > 0 && <Section icon={Star} title={tr('收藏')}>{favs.map((h) => row(h, 'fav'))}</Section>}
              {!q && recents.length > 0 && <Section icon={Clock} title={tr('最近连接')}>{recents.map((h) => row(h, 'recent'))}</Section>}
              {hosts.length > 0 && !filtered.length && <div className="px-2 py-1 text-[11px] text-[var(--color-text-muted)]">{tr('无匹配主机')}</div>}
              {groupHosts(filtered).map(({ group, hosts: gs }) => {
                const open = !!q || !collapsed.has(group)
                return (
                  <div key={`g:${group}`}>
                    <div onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, group: group || '未分组' /* i18n-ignore 菜单里按它判断是不是未分组；显示处 tr() */, hosts: gs }) }}
                      className="group flex items-center gap-1 px-1 py-0.5 text-[11px] text-[var(--color-text-secondary)]">
                      <button onClick={() => toggleGroup(group)} className="flex min-w-0 flex-1 items-center gap-1 text-left hover:text-[var(--color-accent)]">
                        {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                        <span className="truncate">{group || tr('未分组')}</span>
                        <span className="text-[var(--color-text-muted)]">({gs.length})</span>
                      </button>
                      {gs.length > 1 && (
                        <button onClick={() => openGroup(gs)} title={tr('整组打开：每台主机开一个终端（≤4 台自动分屏）')}
                          className="flex items-center gap-1 rounded px-1.5 text-[var(--color-text-muted)] opacity-0 hover:text-[var(--color-accent)] group-hover:opacity-100"><Layers className="h-3 w-3" />{tr('整组打开')}</button>
                      )}
                    </div>
                    {open && <div className="space-y-0.5">{gs.map((h) => row(h, 'tree'))}</div>}
                  </div>
                )
              })}
            </div>
            <div className="shrink-0 border-t border-[var(--color-border-subtle)] px-3 py-1 text-[10.5px] text-[var(--color-text-muted)]">{tr('双击连接 · 右键更多 · Ctrl+Shift+H 开关')}</div>
          </>
        )}

      {menu && (
        <div style={{ left: Math.min(menu.x, window.innerWidth - 190), top: Math.min(menu.y, window.innerHeight - 280) }} onMouseDown={(e) => e.stopPropagation()}
          className="fixed z-50 w-44 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-1.5 shadow-lg">
          {'host' in menu ? (
            <>
              <button onClick={() => connect(menu.host)} className={ITEM}><Plug className="h-3.5 w-3.5 text-[var(--color-accent)]" />{tr('action|连接')}</button>
              <button onClick={() => connect(menu.host, true)} className={ITEM}><SquarePlus className="h-3.5 w-3.5 text-[var(--color-accent)]" />{tr('新标签连接')}</button>
              <button onClick={() => { setMenu(null); fav(menu.host.id) }} className={ITEM}><Star className="h-3.5 w-3.5 text-[var(--color-accent)]" />{prefs.favoriteHosts?.includes(menu.host.id) ? tr('取消收藏') : tr('收藏')}</button>
              <div className="my-1 h-px bg-[var(--color-border-subtle)]" />
              <button onClick={() => { setMenu(null); onClose(); onEditHosts() }} className={ITEM}><Pencil className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />{tr('编辑')}</button>
              <button onClick={() => duplicate(menu.host)} className={ITEM}><Copy className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />{tr('复制主机')}</button>
              <button onClick={() => { setMenu(null); onClose(); openKnowledge({ scope: 'host', target: menu.host.id }) }} className={ITEM}><BookMarked className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />{tr('知识库')}</button>
              <button onClick={() => { setMenu(null); setRules({ kind: 'host', hostId: menu.host.id, label: menu.host.label }) }} className={ITEM}><ScrollText className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />{tr('规则…')}</button>
            </>
          ) : (
            <>
              <button onClick={() => openGroup(menu.hosts)} className={ITEM}><Layers className="h-3.5 w-3.5 text-[var(--color-accent)]" />{tr('整组打开（{n} 台）', { n: menu.hosts.length })}</button>
              {menu.group !== '未分组' /* i18n-ignore 同上 */ && <>
                <button onClick={() => { setMenu(null); onClose(); quoteToChat(tr('在 {group} 所有主机上检查：', { group: menu.group })) }} className={ITEM}><Network className="h-3.5 w-3.5 text-[var(--color-accent)]" />{tr('跨主机提问')}</button>
                <button onClick={() => { setMenu(null); onClose(); openKnowledge({ scope: 'group', target: menu.group }) }} className={ITEM}><BookMarked className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />{tr('分组知识库')}</button>
                <button onClick={() => { setMenu(null); setRules({ kind: 'group', group: menu.group }) }} className={ITEM}><ScrollText className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />{tr('分组规则…')}</button>
              </>}
            </>
          )}
        </div>
      )}
      {rules && <RulesDialog target={rules} onClose={() => setRules(null)} />}
      <ConfirmDialog open={!!confirmGroup} title={tr('整组打开')} confirmText={tr('全部连接')}
        message={tr('这一组有 {prod} 台生产主机（共 {n} 台），确定全部连接？', { prod: confirmGroup?.filter((h) => h.env === 'prod').length ?? 0, n: confirmGroup?.length ?? 0 })}
        onConfirm={() => confirmGroup && openGroup(confirmGroup, true)} onCancel={() => setConfirmGroup(null)} />
    </div>
  )
}

function Section({ icon: Icon, title, children }: { icon: typeof Star; title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1 px-1 py-0.5 text-[11px] text-[var(--color-text-secondary)]"><Icon className="h-3 w-3" />{title}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

function HostRow({ h, fav, probe, onFav, onConnect, onMenu }: {
  h: HostSummary; fav: boolean; probe?: ProbeResult
  onFav: () => void; onConnect: () => void; onMenu: (e: React.MouseEvent) => void
}) {
  return (
    <div tabIndex={0} data-host-row onDoubleClick={onConnect} onContextMenu={onMenu} title={`${h.label} — ${h.username}@${h.host}:${h.port}\n${tr('双击/Enter 连接，右键/Shift+F10 更多')}`}
      onKeyDown={(e) => {
        const rows = [...document.querySelectorAll<HTMLElement>('[data-host-row]')]
        const i = rows.indexOf(e.currentTarget)
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus() }
        else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); rows[e.key === 'Home' ? 0 : rows.length - 1]?.focus() }
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onConnect() }
        else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); onMenu({ clientX: r.left + 24, clientY: r.top + r.height / 2, preventDefault() {} } as React.MouseEvent) }
      }}
      className="group flex cursor-default select-none items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-[var(--color-bg-hover)] focus-visible:bg-[var(--color-bg-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]">
      <button onClick={onFav} title={fav ? tr('取消收藏') : tr('收藏')} onDoubleClick={(e) => e.stopPropagation()}
        className={`shrink-0 ${fav ? 'text-[var(--color-warn)]' : 'text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100'}`}>
        <Star className={`h-3 w-3 ${fav ? 'fill-current' : ''}`} />
      </button>
      <Server className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
      <span className="max-w-[45%] shrink-0 truncate">{h.label}</span>
      {h.env === 'prod' && <ProdBadge />}
      <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-muted)]">{h.username}@{h.host}</span>
      {probe && <span title={probe.state === 'jump' ? tr('经跳板机连接，不测延迟') : tr('TCP 连接 SSH 端口耗时')} className={`shrink-0 text-[10.5px] tabular-nums ${TONE_CLS[probeTone(probe)]}`}>{probeLabel(probe)}</span>}
    </div>
  )
}
