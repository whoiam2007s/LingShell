// 双栏文件管理（类 WinSCP）：左边本机、右边这台服务器，各是一个完整的资源管理器。
// 在两栏之间拖动 = 上传 / 下载（目标是落点目录）；中间按钮 / 右键「上传到右栏 / 下载到左栏」= 送到另一栏的当前目录。
// 上传先查同名（覆盖 / 跳过 / 保留两者），生产主机再确认一次；下载同名自动改名，不覆盖本机文件。传完两栏自动刷新。
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, ArrowRight, ArrowLeft, Columns2 } from 'lucide-react'
import { tk, tr, type ConflictPolicy, type FsScope } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { ExplorerDrawer } from './ExplorerDrawer.js'
import { PasteConflictDialog } from './ExplorerDialogs.js'
import { ConfirmDialog } from '../common/index.js'

const LOCAL_KEY = 'lingshell.dualLocalDir'
const errMsg = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))

export function DualPane({ terminalId, title, hostKey, prod, remoteRoot, onClose }: { terminalId: string; title: string; hostKey?: string; prod?: boolean; remoteRoot: string; onClose: () => void }) {
  const remote: FsScope = { terminalId }
  const [active, setActive] = useState<'local' | 'remote'>('local')
  const [localRoot, setLocalRoot] = useState<string | undefined>(() => localStorage.getItem(LOCAL_KEY) ?? undefined)
  const state = useRef({ local: { sel: [] as string[], root: '' }, remote: { sel: [] as string[], root: '' } })
  const [, force] = useState(0)
  const [sig, setSig] = useState({ local: 0, remote: 0 })
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [ask, setAsk] = useState<{ paths: string[]; dir: string; names: string[] } | null>(null)
  const [prodAsk, setProdAsk] = useState<{ paths: string[]; dir: string; policy: ConflictPolicy } | null>(null)

  // 第一次打开：本机栏用主目录
  useEffect(() => { if (!localRoot) client.fs.places('local').then((p) => setLocalRoot(p.home ?? 'C:\\')).catch(() => setLocalRoot('C:\\')) }, [])
  // Esc 关窗口（栏里的菜单 / 弹窗会先拦下自己的 Esc）
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  // 有传输完成就刷新两栏（看得到刚传过去的东西）
  useEffect(() => client.on((ev) => {
    if (ev.type === 'transfer:progress' && ev.state === 'done') setSig((s) => ({ local: s.local + 1, remote: s.remote + 1 }))
  }), [])
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(''), 5000); return () => clearTimeout(t) }, [note])

  const onSel = (side: 'local' | 'remote') => (sel: string[], root: string) => {
    state.current[side] = { sel, root }
    if (side === 'local' && root) localStorage.setItem(LOCAL_KEY, root)
    force((n) => n + 1)
  }

  // 上传：先查同名 → 冲突就问 → 生产再确认
  const startUpload = (paths: string[], dir: string, policy: ConflictPolicy) => {
    client.transfer.uploadDirect(remote, paths, dir, policy).then(() => setNote(tr('已开始上传 {n} 项到 {dir}，进度见传输面板', { n: paths.length, dir })), (e) => setErr(errMsg(e)))
  }
  const upload = useCallback((paths: string[], dir: string) => {
    if (!paths.length) return
    setErr('')
    client.transfer.uploadConflicts(remote, paths, dir).then((names) => {
      if (names.length) setAsk({ paths, dir, names })
      else if (prod) setProdAsk({ paths, dir, policy: 'skip' })
      else startUpload(paths, dir, 'skip')
    }).catch((e) => setErr(errMsg(e)))
  }, [terminalId, prod])
  const download = useCallback((paths: string[], dir: string) => {
    if (!paths.length) return
    setErr('')
    client.transfer.downloadMany(remote, paths, dir).then(() => setNote(tr('已开始下载 {n} 项到 {dir}（同名自动改名），进度见传输面板', { n: paths.length, dir })), (e) => setErr(errMsg(e)))
  }, [terminalId])

  const L = state.current.local, R = state.current.remote
  const btn = 'flex h-8 w-8 items-center justify-center rounded-md border border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)] disabled:opacity-30 disabled:hover:bg-transparent'
  return createPortal((
    <div data-dual className="fixed inset-0 z-[55] flex items-center justify-center bg-black/55 backdrop-blur-sm">
      <div className="flex h-[92vh] w-[96vw] flex-col rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-4">
          <Columns2 className="h-4 w-4 text-[var(--color-accent)]" />
          <span className="text-[13px] font-semibold text-[var(--color-text-primary)]">{tr('双栏文件管理')}</span>
          <span className="text-[11px] text-[var(--color-text-muted)]">{tr('本机 ⇄ {host} · 两栏之间拖动即可上传 / 下载', { host: title + (prod ? tr('（生产）') : '') })}</span>
          {note && <span data-dual-note className="ml-3 truncate text-[11px] text-[var(--color-accent)]">{note}</span>}
          {err && <span data-dual-err className="ml-3 truncate text-[11px] text-[var(--color-danger)]" title={err}>{err}</span>}
          <button title={tr('关闭（Esc）')} onClick={onClose} className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex min-h-0 flex-1 gap-2 p-2">
          <div className="min-w-0 flex-1">
            {localRoot && (
              <ExplorerDrawer scope="local" rootPath={localRoot} hostKey="local" onClose={onClose}
                pane={{ title: tr('pane|本机'), active: active === 'local', onActivate: () => setActive('local'), refreshSignal: sig.local, onSelChange: onSel('local'),
                  onCrossDrop: (paths, dir) => download(paths, dir), sendLabel: tr('上传到右栏当前目录'), onSend: (paths) => upload(paths, R.root) }} />
            )}
          </div>
          <div className="flex shrink-0 flex-col items-center justify-center gap-2">
            <button data-dual-up title={`${tr('上传：左栏选中的 {n} 项 → 右栏当前目录', { n: L.sel.length })}\n${R.root}`} disabled={!L.sel.length || !R.root} onClick={() => upload(L.sel, R.root)} className={btn}><ArrowRight className="h-4 w-4" /></button>
            <button data-dual-down title={`${tr('下载：右栏选中的 {n} 项 → 左栏当前目录', { n: R.sel.length })}\n${L.root}`} disabled={!R.sel.length || !L.root} onClick={() => download(R.sel, L.root)} className={btn}><ArrowLeft className="h-4 w-4" /></button>
          </div>
          <div className="min-w-0 flex-1">
            <ExplorerDrawer scope={remote} rootPath={remoteRoot} hostKey={hostKey} prod={prod} onClose={onClose}
              pane={{ title, active: active === 'remote', onActivate: () => setActive('remote'), refreshSignal: sig.remote, onSelChange: onSel('remote'),
                onCrossDrop: (paths, dir) => upload(paths, dir), sendLabel: tr('下载到左栏当前目录'), onSend: (paths) => download(paths, L.root) }} />
          </div>
        </div>
      </div>
      {ask && <PasteConflictDialog names={ask.names} total={ask.paths.length} verb={tk('上传')} prod={prod} onCancel={() => setAsk(null)}
        onPick={(policy) => { const a = ask; setAsk(null); if (prod) setProdAsk({ paths: a.paths, dir: a.dir, policy }); else startUpload(a.paths, a.dir, policy) }} />}
      <ConfirmDialog open={!!prodAsk} title={tr('上传到生产主机')} confirmText={tr('确认上传')}
        message={tr('把 {n} 项上传到生产主机 {host} 的 {dir}，请再确认一遍目标目录。', { n: prodAsk?.paths.length ?? 0, host: title, dir: prodAsk?.dir ?? '' })}
        onCancel={() => setProdAsk(null)} onConfirm={() => { const p = prodAsk!; setProdAsk(null); startUpload(p.paths, p.dir, p.policy) }} />
    </div>
  ), document.body)
}
