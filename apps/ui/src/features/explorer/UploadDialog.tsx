import { useEffect, useState } from 'react'
import { X, Server, Folder, ChevronRight, ChevronDown, Lock, Unlock, TerminalSquare } from 'lucide-react'
import { baseName, tk, tr, type HostSummary, type DirEntry, type ConflictPolicy } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { SavedHostList } from '../../components/sshParts.js'
import { Checkbox } from '../../components/ui/Checkbox.js'
import { PasteConflictDialog } from './ExplorerDialogs.js'

const errMsg = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
const TERM = '__term__'   // 目标 = 发起拖拽的那个终端（临时连接的主机也能传）

// 上传目标选择：选主机 → 浏览其远程目录树 → 选目标目录 → 上传 localPaths。
// 资源管理器拖拽上传、拖文件到 SSH 终端也走这里：预填 terminalId / initialHostId / initialTarget。
// 加密上传（打包 + openssl，需已保存主机）每个文件一个任务、同时排进队列；不加密 = 逐个文件直传（一个任务，可暂停 / 断点续传、保留修改时间）。
// 先查目标里的同名项，让用户选覆盖 / 跳过 / 保留两者；生产主机要勾选确认。
export function UploadDialog({ localPaths, terminalId, terminalTitle, terminalProd, initialHostId, initialTarget, onClose }: {
  localPaths: string[]
  terminalId?: string; terminalTitle?: string; terminalProd?: boolean
  initialHostId?: string; initialTarget?: string
  onClose: () => void
}) {
  const [hosts, setHosts] = useState<HostSummary[]>([])
  const [hostId, setHostId] = useState('')
  const [children, setChildren] = useState<Record<string, DirEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [target, setTarget] = useState('')
  const [encrypt, setEncrypt] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [conflict, setConflict] = useState<string[] | null>(null)
  const [prodOk, setProdOk] = useState(false)

  // 拖拽来源是终端：优先用它（不新开连接）；它对应的已保存主机也在列表里
  const viaTerm = hostId === TERM
  const savedId = viaTerm ? initialHostId : hostId
  const prod = viaTerm ? !!terminalProd : hosts.find((h) => h.id === hostId)?.env === 'prod'
  const winTarget = /^\/[A-Za-z]:(\/|$)/.test(target)   // Windows 自带 OpenSSH（没有 tar / openssl）：只能直传
  const canEncrypt = !!savedId && !winTarget
  const enc = encrypt && canEncrypt

  useEffect(() => {
    client.hosts.list().then((hs) => {
      setHosts(hs)
      if (terminalId) return pickHost(TERM, initialTarget)
      const h = hs.find((x) => x.id === initialHostId) ?? hs[0]
      if (h) pickHost(h.id, h.id === initialHostId ? initialTarget : undefined)
    }).catch(() => {})
    client.settings.get().then((s) => setEncrypt(s.system?.uploadEncrypt ?? true)).catch(() => {})
  }, [])
  useEffect(() => { setProdOk(false) }, [hostId])
  // Esc 关闭（冲突选择开着时先关它，由它自己处理）
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !conflict) { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [conflict, onClose])

  // 预填目录（拖拽上传 = 终端 / 资源管理器当前目录）：逐级展开到它，树里看得到选中项
  const pickHost = (id: string, dir = '/') => {
    const parts = dir.split('/').filter(Boolean)
    const anc = parts.slice(0, -1).map((_, i) => '/' + parts.slice(0, i + 1).join('/'))
    setHostId(id); setTarget(dir); setChildren({}); setExpanded(new Set(anc)); setErr('')
    for (const p of ['/', ...anc]) load(id, p)
  }
  // load：拉取远程目录。children[path]===undefined 表示未加载(loading)，[] 表示空目录
  const load = (hid: string, path: string) => {
    const job = hid === TERM ? client.fs.listDir({ terminalId: terminalId! }, path) : client.fs.listDirByHost(hid, path)
    job.then((ents) => setChildren((c) => ({ ...c, [path]: ents.filter((e) => e.isDir) }))).catch(() => setChildren((c) => ({ ...c, [path]: [] })))
  }
  const toggle = (path: string) => setExpanded((s) => {
    const n = new Set(s); if (n.has(path)) n.delete(path); else { n.add(path); if (!children[path]) load(hostId, path) } return n
  })

  const renderLevel = (path: string, depth: number) => (children[path] ?? []).filter((e) => e.isDir).map((e) => (
    <div key={e.path}>
      <div style={{ paddingLeft: depth * 12 + 4 }} data-up-dir={e.path}
        onClick={() => { setTarget(e.path); toggle(e.path) }}
        className={`flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-[12px] hover:bg-[var(--color-bg-hover)] ${target === e.path ? 'bg-[color:color-mix(in_srgb,var(--color-accent)_15%,transparent)] text-[var(--color-accent)]' : 'text-[var(--color-text-primary)]'}`}>
        {expanded.has(e.path) ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
        <span className="truncate">{e.name}</span>
      </div>
      {expanded.has(e.path) && (children[e.path] === undefined
        ? <div style={{ paddingLeft: (depth + 1) * 12 + 4 }} className="px-1 py-0.5 text-[11px] text-[var(--color-text-muted)]">{tr('加载中…')}</div>
        : renderLevel(e.path, depth + 1))}
    </div>
  ))

  const tgt = () => (viaTerm ? { terminalId: terminalId! } : { hostId })
  // 先查同名；没有就直接开始
  const submit = async () => {
    if (!hostId || !target) return
    setBusy(true); setErr('')
    try {
      const names = await client.transfer.uploadConflicts(tgt(), localPaths, target)
      if (names.length) { setConflict(names); setBusy(false); return }
      start('skip', [])
    } catch (e) { setErr(errMsg(e)); setBusy(false) }
  }
  // 全部立即排进队列（不再一个传完才排下一个），进度看传输面板
  const start = (policy: ConflictPolicy, conflicts: string[]) => {
    if (enc) {
      const ps = policy === 'skip' ? localPaths.filter((p) => !conflicts.includes(baseName(p))) : localPaths
      if (!ps.length) { setErr(tr('所选项目在服务器上都有同名文件，按「跳过」没有可上传的项')); setBusy(false); return }
      for (const p of ps) client.transfer.upload(savedId!, p, target, true).catch((e) => setErr(errMsg(e)))
    } else client.transfer.uploadDirect(tgt(), localPaths, target, policy).catch((e) => setErr(errMsg(e)))
    onClose()
  }

  const blocked = !hostId || !target || busy || (prod && !prodOk)
  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
      <div data-upload-dialog className="flex h-[460px] w-[660px] flex-col overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex h-11 shrink-0 items-center border-b border-[var(--color-border-subtle)] px-4">
          <span className="text-[13px] font-semibold text-[var(--color-text-primary)]">{tr('上传到服务器')}</span>
          <span className="ml-2 truncate text-[11px] text-[var(--color-text-muted)]" title={localPaths.join('\n')}>{localPaths.length > 1 ? tr('{names} 等 {n} 项', { names: localPaths[0], n: localPaths.length }) : localPaths[0]}</span>
          <button title={tr('关闭')} onClick={onClose} className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="w-[220px] shrink-0 overflow-y-auto border-r border-[var(--color-border-subtle)] p-2">
            {terminalId && (
              <>
                <div className="mb-1 flex items-center gap-1 px-1 text-[11px] text-[var(--color-text-muted)]"><TerminalSquare className="h-3 w-3" />{tr('当前终端')}</div>
                <button data-up-term onClick={() => pickHost(TERM, initialTarget)} title={tr('用这个终端已有的连接上传（不另开连接）')}
                  className={`mb-2 w-full truncate rounded px-2 py-1 text-left text-[12px] ${viaTerm ? 'bg-[color:color-mix(in_srgb,var(--color-accent)_15%,transparent)] text-[var(--color-accent)]' : 'text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]'}`}>{terminalTitle ?? tr('当前终端')}</button>
              </>
            )}
            <div className="mb-1 flex items-center gap-1 px-1 text-[11px] text-[var(--color-text-muted)]"><Server className="h-3 w-3" />{tr('已保存主机')}</div>
            <SavedHostList hosts={hosts} onConnect={pickHost} />
          </div>
          <div className="min-w-0 flex-1 overflow-y-auto p-2">
            {!hostId ? <div className="px-2 py-3 text-[11px] text-[var(--color-text-muted)]">{tr('← 选择目标主机')}</div> : (
              <>
                <div className="mb-1 truncate px-1 text-[11px] text-[var(--color-text-secondary)]">{tr('上传到：')}<span data-up-target className="text-[var(--color-accent)]">{target || '/'}</span></div>
                <div onClick={() => setTarget('/')} className={`cursor-pointer rounded px-1 py-0.5 text-[12px] ${target === '/' ? 'bg-[color:color-mix(in_srgb,var(--color-accent)_15%,transparent)] text-[var(--color-accent)]' : 'text-[var(--color-text-primary)]'}`}>{tr('/（根）')}</div>
                {children['/'] === undefined
                  ? <div className="px-2 py-3 text-[11px] text-[var(--color-text-muted)]">{tr('加载中…')}</div>
                  : renderLevel('/', 0)}
              </>
            )}
          </div>
        </div>
        {prod && (
          <label data-prod-ok className="flex shrink-0 cursor-pointer items-center gap-2 border-t border-[var(--color-danger)] bg-[color:color-mix(in_srgb,var(--color-danger)_10%,transparent)] px-4 py-2 text-[12px] font-medium text-[var(--color-danger)]">
            <Checkbox checked={prodOk} onCheckedChange={setProdOk} />{tr('这是生产主机：我确认要把这些文件传到 {dir}', { dir: target || '/' })}
          </label>
        )}
        {err && <div data-up-err className="shrink-0 border-t border-[var(--color-border-subtle)] px-4 py-1.5 text-[11px] text-[var(--color-danger)]">{err}</div>}
        <div className="flex h-12 shrink-0 items-center gap-3 border-t border-[var(--color-border-subtle)] px-4">
          <button data-up-encrypt disabled={!canEncrypt} onClick={() => setEncrypt((v) => !v)}
            title={canEncrypt ? (enc ? tr('加密上传：打包后用一次性口令加密，服务器上解密解压（需要服务器有 openssl、tar）。失败只能从头重传') : tr('不加密：逐个文件直传，可暂停 / 断点续传，保留修改时间')) : winTarget ? tr('Windows 服务器没有 tar / openssl，只能直传（不加密）') : tr('临时连接的主机只能直传（不加密）')}
            className={`flex items-center gap-1.5 text-[12px] disabled:cursor-not-allowed ${enc ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'}`}>
            {enc ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}{enc ? tr('加密上传') : tr('不加密（直传，可断点续传）')}
          </button>
          <button data-up-start disabled={blocked} onClick={submit}
            className="ml-auto rounded-md border border-transparent bg-[var(--color-accent)] px-4 py-1.5 text-[12px] font-medium text-[var(--color-bg-base)] transition-colors hover:bg-[var(--color-accent-dim)] disabled:opacity-40">
            {busy ? tr('检查中') : tr('开始上传')}
          </button>
        </div>
      </div>
      {conflict && <PasteConflictDialog names={conflict} total={localPaths.length} verb={tk('上传')} noRename={enc} prod={prod}
        onPick={(p) => { const c = conflict; setConflict(null); start(p, c) }} onCancel={() => setConflict(null)} />}
    </div>
  )
}
