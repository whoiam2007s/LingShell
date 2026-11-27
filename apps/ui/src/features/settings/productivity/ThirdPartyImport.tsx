import { useEffect, useState } from 'react'
import { Download, FolderOpen, Loader2, X } from 'lucide-react'
import { tr, type ImportGroupView, type ImportItemView } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { Checkbox } from '../../../components/ui/Checkbox.js'
import { toast, ToastHost } from '../../../components/ui/toast.js'
import { BTN1, BTN2, errText } from '../ui.js'

const KIND_LABEL: Record<'agent' | 'skill' | 'mcp', string> = {
  agent: 'Agent', skill: 'Skill', mcp: 'MCP',
}

/** 已经装过的名字（同名的扫描结果置灰、不能导入） */
async function installedNames(kind: 'agent' | 'skill' | 'mcp'): Promise<Set<string>> {
  const list = kind === 'agent'
    ? await client.agents.list().then((l) => l.map((x) => x.name))
    : kind === 'skill'
      ? await client.skills.list().then((l) => l.map((x) => x.name))
      : await client.mcp.list().then((l) => l.map((x) => x.name))
  return new Set(list)
}

/**
 * 从第三方导入：扫各家客户端 / CLI 的用户目录，按平台分组列出候选，勾选后导入到本应用。
 * 扫描是逐平台做的 —— 每扫完一个平台就渲染一组（实时进度）；没有数据的平台不占位，收到底部一行提示里。
 */
export function ThirdPartyImport({ kind, onClose, onImported }: {
  kind: 'agent' | 'skill' | 'mcp'
  onClose: () => void
  onImported?: () => void
}) {
  const [groups, setGroups] = useState<ImportGroupView[]>([])
  /** 扫到了但一条数据都没有的平台（只在底部汇总，不占列表） */
  const [empty, setEmpty] = useState<string[]>([])
  const [scanning, setScanning] = useState<string | null>(null)
  const [installed, setInstalled] = useState<Set<string>>(new Set())
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    installedNames(kind).then(setInstalled, () => {})
  }, [kind])

  useEffect(() => {
    let alive = true
    void (async () => {
      const ps = await client.importer.platforms().catch(() => [])
      for (const p of ps) {
        if (!alive) return
        setScanning(p.label)
        const g = await client.importer.scan(kind, p.id).catch(() => null)
        if (!alive) return
        if (g?.items.length) setGroups((cur) => [...cur, g])
        else if (g) setEmpty((cur) => [...cur, g.label])
      }
      if (alive) setScanning(null)
    })()
    return () => { alive = false }
  }, [kind])

  const dup = (it: ImportItemView) => installed.has(it.name)
  const toggle = (ids: string[], on: boolean) => setSel((cur) => {
    const n = new Set(cur)
    for (const id of ids) { if (on) n.add(id); else n.delete(id) }
    return n
  })
  const idsOf = (g: ImportGroupView) => g.items.filter((i) => !dup(i)).map((i) => i.id)
  const allOn = (g: ImportGroupView) => {
    const ids = idsOf(g)
    return ids.length > 0 && ids.every((id) => sel.has(id))
  }

  const commit = () => {
    if (!sel.size || busy) return
    setBusy(true)
    client.importer.commit(kind, [...sel])
      .then((r) => {
        toast(r.failed.length ? tr('{n} 项导入失败', { n: r.failed.length }) : tr('已导入 {n} 项', { n: r.ok }), r.failed.length === 0)
        setSel(new Set())
        // 导入成功的现在已经「已安装」，重新拉一次用于置灰
        installedNames(kind).then(setInstalled, () => {})
        onImported?.()
      })
      .catch((e) => toast(errText(e), false))
      .finally(() => setBusy(false))
  }

  const row = (it: ImportItemView) => {
    const on = dup(it)
    return (
      <label key={it.id}
        className={`flex items-start gap-2 px-3 py-1.5 ${on ? 'pointer-events-none opacity-45' : 'cursor-pointer hover:bg-[var(--color-bg-hover)]'}`}>
        <span className="mt-0.5"><Checkbox checked={sel.has(it.id)} onCheckedChange={(v) => toggle([it.id], v)} /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[12px] text-[var(--color-text-primary)]">{it.name}</span>
          {(it.description || it.detail) && (
            <span className="block truncate text-[11px] text-[var(--color-text-muted)]">{it.description ?? it.detail}</span>
          )}
        </span>
        {on && <span className="shrink-0 text-[10.5px] text-[var(--color-text-muted)]">{tr('已存在')}</span>}
      </label>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={onClose}>
      <div className="flex max-h-[76vh] w-[560px] flex-col rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()} data-third-party-import>
        <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-4 py-2.5">
          <div className="text-[13px] font-medium text-[var(--color-text-primary)]">{tr('从第三方导入 {k}', { k: KIND_LABEL[kind] })}</div>
          <button onClick={onClose} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"><X className="h-4 w-4" /></button>
        </div>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3">
          {(scanning || (groups.length === 0 && empty.length === 0)) && (
            <div className="flex items-center gap-2 text-[12px] text-[var(--color-text-muted)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />{scanning ? tr('正在扫描 {p}…', { p: scanning }) : tr('正在准备…')}
            </div>
          )}
          {groups.map((g) => (
            <div key={g.platform} className="overflow-hidden rounded-lg border border-[var(--color-border-subtle)]">
              <div className="flex items-center gap-2 bg-[var(--color-bg-base)] px-3 py-2">
                <Checkbox checked={allOn(g)} onCheckedChange={(v) => toggle(idsOf(g), v)} />
                <button onClick={() => { void client.importer.openDir(g.platform).catch(() => {}) }}
                  title={tr('打开 {dir}', { dir: g.dir })}
                  className="flex items-center gap-1 whitespace-nowrap text-[12px] text-[var(--color-text-primary)] hover:text-[var(--color-accent)]">
                  <FolderOpen className="h-3.5 w-3.5 shrink-0" />{g.label}
                </button>
                <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">{tr('{n} 项', { n: g.items.length })}</span>
                <span className="ml-auto max-w-[220px] truncate text-[10.5px] text-[var(--color-text-muted)]" title={g.dir}>{g.dir}</span>
              </div>
              {g.items.map(row)}
            </div>
          ))}
          {empty.length > 0 && !scanning && (
            <div className="pt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
              {tr('没有数据：{list}', { list: empty.join(' ') })}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-[var(--color-border-subtle)] px-4 py-2.5">
          <span className="ml-auto text-[11px] text-[var(--color-text-muted)]">{tr('已选 {n} 项', { n: sel.size })}</span>
          <button className={BTN2} onClick={onClose}>{tr('关闭')}</button>
          <button className={BTN1} disabled={!sel.size || busy} onClick={commit}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}{tr('导入选中')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 列表页工具栏上的入口：一个按钮 + 弹窗，Agents / Skills / MCP 三处复用 */
export function ThirdPartyImportButton({ kind, onImported }: { kind: 'agent' | 'skill' | 'mcp'; onImported?: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className={BTN2} onClick={() => setOpen(true)}>
        <Download className="h-3.5 w-3.5 shrink-0" />{tr('从第三方导入')}
      </button>
      {open && <ThirdPartyImport kind={kind} onClose={() => setOpen(false)} onImported={onImported} />}
      <ToastHost />
    </>
  )
}
