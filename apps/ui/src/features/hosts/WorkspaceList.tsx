import { useEffect, useState } from 'react'
import { Save, Play, Pencil, Trash2, LayoutGrid } from 'lucide-react'
import { workspaceFromLayout, upsertWorkspace, renameWorkspace, removeWorkspace, workspaceSummary, tr, type Workspace } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { paletteSend } from '../../lib/paletteBus.js'
import { ConfirmDialog } from '../common/index.js'
import { useHostPrefs, patchHostPrefs } from './hostPrefs.js'

const INPUT = 'min-w-0 flex-1 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2 py-1 text-[12px] outline-none focus:border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)]'
const ICON_BTN = 'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'

/** 打开工作区：终端追加为新标签并按其分屏摆放（TerminalView 处理） */
export const openWorkspace = (w: Workspace) => paletteSend({ type: 'openWorkspace', ws: w })

// 工作区页：保存当前打开的终端 + 分屏为命名工作区；点名称打开，可重命名、删除
export function WorkspaceList({ autoSave, onOpened, onModal }: { autoSave?: boolean; onOpened: () => void; onModal: (open: boolean) => void }) {
  const { workspaces = [] } = useHostPrefs()
  const [name, setName] = useState<string | null>(autoSave ? '' : null)   // null = 没在填名称
  const [error, setError] = useState('')
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [del, setDel] = useState<Workspace | null>(null)
  useEffect(() => onModal(!!del), [del])

  const save = async () => {
    const n = name?.trim()
    if (!n) return
    const layout = await client.layout.get().catch(() => null)
    if (!layout?.terminals.length) { setError(tr('当前没有可保存的终端（临时 SSH 连接不会保存，先把它存为主机）')); return }
    const replaced = workspaces.some((w) => w.name === n)
    await patchHostPrefs((p) => ({ workspaces: upsertWorkspace(p.workspaces, workspaceFromLayout(layout, n, crypto.randomUUID())) }))
    setName(null); setError(replaced ? tr('已覆盖同名工作区「{name}」', { name: n }) : '')
  }
  const rename = () => {
    if (renaming?.name.trim()) void patchHostPrefs((p) => ({ workspaces: renameWorkspace(p.workspaces, renaming.id, renaming.name) }))
    setRenaming(null)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-[var(--color-border-subtle)] p-2">
        {name === null ? (
          <button onClick={() => { setName(''); setError('') }}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-[var(--color-border-default)] py-1.5 text-[var(--color-text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]">
            <Save className="h-3.5 w-3.5" />{tr('保存当前布局为工作区')}
          </button>
        ) : (
          <div className="flex items-center gap-1.5">
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('工作区名称，如「订单系统」')}
              onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === 'Enter') void save(); else if (e.key === 'Escape') { e.stopPropagation(); setName(null) } }}
              className={INPUT} />
            <button onClick={() => void save()} disabled={!name.trim()} className="shrink-0 rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-[var(--color-bg-base)] disabled:opacity-40">{tr('保存')}</button>
            <button onClick={() => setName(null)} className="shrink-0 rounded-md px-2 py-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]">{tr('取消')}</button>
          </div>
        )}
        {error && <div className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">{error}</div>}
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
        {!workspaces.length && <div className="px-2 py-4 text-center text-[11px] leading-relaxed text-[var(--color-text-muted)]">{tr('还没有工作区。先打开要用的终端、摆好分屏，再点上面的按钮保存；以后一键打开（各主机自动重连）。')}</div>}
        {workspaces.map((w) => renaming?.id === w.id ? (
          <div key={w.id} className="flex items-center gap-1.5 px-1 py-0.5">
            <input autoFocus value={renaming.name} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} onBlur={rename}
              onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === 'Enter') rename(); else if (e.key === 'Escape') { e.stopPropagation(); setRenaming(null) } }}
              className={INPUT} />
          </div>
        ) : (
          <div key={w.id} onDoubleClick={() => { onOpened(); openWorkspace(w) }} title={tr('双击打开')}
            className="group flex select-none items-center gap-2 rounded-md px-1.5 py-1 hover:bg-[var(--color-bg-hover)]">
            <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
            <span className="min-w-0 shrink truncate">{w.name}</span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-muted)]">{workspaceSummary(w)}</span>
            <button title={tr('打开（各终端追加为新标签，按工作区分屏）')} onClick={() => { onOpened(); openWorkspace(w) }} className={`${ICON_BTN} hover:text-[var(--color-accent)]`}><Play className="h-3.5 w-3.5" /></button>
            <button title={tr('重命名')} onClick={() => setRenaming({ id: w.id, name: w.name })} className={`${ICON_BTN} opacity-0 hover:text-[var(--color-accent)] group-hover:opacity-100`}><Pencil className="h-3 w-3" /></button>
            <button title={tr('删除')} onClick={() => setDel(w)} className={`${ICON_BTN} opacity-0 hover:text-[var(--color-danger)] group-hover:opacity-100`}><Trash2 className="h-3 w-3" /></button>
          </div>
        ))}
      </div>
      <ConfirmDialog open={!!del} title={tr('删除工作区')} message={tr('确定删除工作区「{name}」？不影响已打开的终端和已保存的主机。', { name: del?.name ?? '' })}
        onConfirm={() => { if (del) void patchHostPrefs((p) => ({ workspaces: removeWorkspace(p.workspaces, del.id) })); setDel(null) }}
        onCancel={() => setDel(null)} />
    </div>
  )
}
