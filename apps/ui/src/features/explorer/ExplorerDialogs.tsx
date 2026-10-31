// 资源管理器第二阶段的弹窗：粘贴冲突、属性（大小统计 / 校验和）、修改属主；以及跨抽屉共享的「剪贴板」（复制 / 剪切的项）
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Copy, Check, X, Files, Info, UserCog, ShieldAlert } from 'lucide-react'
import { dateLocale, formatSize, modeOctal, modeString, parentPath, tr, type ConflictPolicy, type DirEntry, type FsScope, type HashAlgo, type PasteMode } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { Checkbox } from '../../components/ui/Checkbox.js'
import { PasswordInput } from '../../components/ui/PasswordInput.js'
import { Combobox } from '../../components/ui/Combobox.js'

// ── 剪贴板：按主机（scopeKey）记；切到别的主机贴不了（跨主机请用上传 / 下载） ──
export type Clip = { scopeKey: string; mode: PasteMode; paths: string[] } | null
let clip: Clip = null
const subs = new Set<() => void>()
export const setClip = (c: Clip) => { clip = c; subs.forEach((f) => f()) }
export const useClip = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => clip)

const errMsg = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
const BTN = 'rounded-md border border-[var(--color-border-default)] px-4 py-1.5 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'
const PRIMARY = 'rounded-md border border-transparent bg-[var(--color-accent)] px-4 py-1.5 text-[12px] font-medium text-[var(--color-bg-base)] hover:bg-[var(--color-accent-dim)] disabled:opacity-40'
const DANGER = 'rounded-md border border-transparent bg-[var(--color-danger)] px-4 py-1.5 text-[12px] font-medium text-[var(--color-on-danger)] hover:opacity-90'

function Modal({ title, icon, width = 'w-[460px]', onClose, children, footer }: { title: string; icon: ReactNode; width?: string; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [onClose])
  return createPortal((
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 backdrop-blur-sm" onMouseDown={onClose}>
      <div className={`${width} max-w-[92vw] rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-5 shadow-2xl`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center gap-2 text-[14px] font-semibold text-[var(--color-text-primary)]">{icon}<span className="min-w-0 flex-1 truncate">{title}</span>
          <button title={tr('关闭（Esc）')} onClick={onClose} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"><X className="h-4 w-4" /></button>
        </div>
        <div className="mb-4 text-[12px] text-[var(--color-text-secondary)]">{children}</div>
        <div className="flex justify-end gap-2">{footer}</div>
      </div>
    </div>
  ), document.body)
}

/** 粘贴时有同名项：覆盖（文件夹合并）/ 跳过 / 保留两者 */
export function PasteConflictDialog({ names, total, mode, verb, noRename, prod, onPick, onCancel }: {
  names: string[]; total: number; mode?: PasteMode; verb?: string; noRename?: boolean; prod?: boolean; onPick: (p: ConflictPolicy) => void; onCancel: () => void
}) {
  return (
    <Modal title={tr('目标位置已有 {n} 个同名项', { n: names.length })} icon={<Files className="h-4 w-4 text-[var(--color-warn)]" />} onClose={onCancel}
      footer={<>
        <button onClick={onCancel} className={BTN}>{tr('取消')}</button>
        <button data-conflict="skip" onClick={() => onPick('skip')} className={BTN}>{tr('跳过这些')}</button>
        {!noRename && <button data-conflict="rename" onClick={() => onPick('rename')} className={BTN}>{tr('保留两者')}</button>}
        <button data-conflict="overwrite" onClick={() => onPick('overwrite')} className={prod ? DANGER : PRIMARY}>{tr('覆盖')}</button>
      </>}>
      {/* verb 由调用方传 tk 标记过的中文（如「上传」），这里再 tr */}
      <div className="mb-2">{tr('共{verb} {n} 项，其中这些和目标里的重名：', { verb: verb ? tr(verb) : mode === 'move' ? tr('fm|移动') : tr('fm|复制'), n: total })}</div>
      <div className="mb-2 max-h-40 overflow-auto rounded border border-[var(--color-border-subtle)] px-2 py-1 font-mono text-[11px]">
        {names.map((n) => <div key={n} className="truncate">{n}</div>)}
      </div>
      <div className="text-[11px] text-[var(--color-text-muted)]">{tr('覆盖：文件直接替换；文件夹是合并（里面同名的文件替换，其余保留）。')}{noRename ? tr('加密上传不支持「保留两者」，要保留请改用不加密上传。') : tr('保留两者：新的改名为「名称 (1)」。')}</div>
      {prod && <div className="mt-2 rounded-md border border-[var(--color-danger)] bg-[color:color-mix(in_srgb,var(--color-danger)_12%,transparent)] px-3 py-2 font-medium text-[var(--color-danger)]">{tr('这是生产主机，覆盖后无法恢复。')}</div>}
    </Modal>
  )
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return <div className="flex gap-3 py-0.5"><span className="w-20 shrink-0 text-[var(--color-text-muted)]">{k}</span><span className="min-w-0 flex-1 break-all text-[var(--color-text-primary)]">{children}</span></div>
}

/** 属性：单项显示详情；文件夹 / 多项统计大小（服务器上 find，本地遍历）；文件可算校验和 */
export function PropsDialog({ scope, entries, onClose }: { scope: FsScope; entries: DirEntry[]; onClose: () => void }) {
  const one = entries.length === 1 ? entries[0] : undefined
  const needStats = !one || one.isDir
  const [stats, setStats] = useState<{ dirs: number; files: number; bytes: number; partial?: boolean } | string>()
  const [sums, setSums] = useState<Partial<Record<HashAlgo, string>>>({})
  const [copied, setCopied] = useState('')
  useEffect(() => {
    if (!needStats) return
    client.fs.stats(scope, entries.map((e) => e.path)).then(setStats, (e) => setStats(errMsg(e)))
  }, [])
  const sum = (a: HashAlgo) => { setSums((s) => ({ ...s, [a]: tr('计算中…') })); client.fs.checksum(scope, one!.path, a).then((h) => setSums((s) => ({ ...s, [a]: h })), (e) => setSums((s) => ({ ...s, [a]: tr('失败：{err}', { err: errMsg(e) }) }))) }
  const copy = (t: string, what: string) => navigator.clipboard.writeText(t).then(() => { setCopied(what); setTimeout(() => setCopied(''), 1500) }, () => {})
  const statText = typeof stats === 'string' ? tr('统计失败：{err}', { err: stats }) : stats
    ? tr('{size}（{bytes} 字节）· {files} 个文件、{dirs} 个子文件夹', { size: formatSize(stats.bytes), bytes: stats.bytes.toLocaleString(dateLocale()), files: stats.files, dirs: Math.max(0, stats.dirs - entries.filter((e) => e.isDir).length) }) + (stats.partial ? tr('（项目太多或超时，只统计了一部分）') : '')
    : tr('统计中…')
  const kind = (e: DirEntry) => (e.isLink ? (e.linkBroken ? tr('符号链接（目标不存在）') : tr('符号链接 → {kind}', { kind: e.isDir ? tr('文件夹') : tr('文件') })) : e.isDir ? tr('文件夹') : tr('文件'))
  return (
    <Modal title={one ? tr('属性：{name}', { name: one.name }) : tr('属性：{n} 项', { n: entries.length })} icon={<Info className="h-4 w-4 text-[var(--color-accent)]" />} onClose={onClose}
      footer={<button onClick={onClose} className={PRIMARY}>{tr('关闭')}</button>}>
      <div data-props className="space-y-0.5 text-[12px]">
        {one ? <>
          <Row k={tr('名称')}>{one.name}</Row>
          <Row k={tr('位置')}><span className="flex items-start gap-1">{parentPath(one.path)}<button title={tr('复制完整路径')} onClick={() => copy(one.path, 'path')} className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-accent)]">{copied === 'path' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}</button></span></Row>
          <Row k={tr('类型')}>{kind(one)}</Row>
          {one.isLink && <Row k={tr('链接到')}>{one.linkTarget ?? tr('（读不到）')}</Row>}
          <Row k={tr('大小')}>{one.isDir ? <span data-stats>{statText}</span> : one.size !== undefined ? tr('{size}（{bytes} 字节）', { size: formatSize(one.size), bytes: one.size.toLocaleString(dateLocale()) }) : '—'}</Row>
          {one.mtime ? <Row k={tr('修改时间')}>{new Date(one.mtime * 1000).toLocaleString(dateLocale())}</Row> : null}
          {one.mode !== undefined && <Row k={tr('权限')}>{tr('{mode}（{octal}）', { mode: modeString(one.mode), octal: modeOctal(one.mode) })}</Row>}
          {one.owner && <Row k={tr('属主')}>{one.owner}{one.group ? ` : ${one.group}` : ''}</Row>}
          {!one.isDir && (
            <div className="mt-2 border-t border-[var(--color-border-subtle)] pt-2">
              {(['md5', 'sha256'] as HashAlgo[]).map((a) => (
                <div key={a} className="flex items-center gap-2 py-0.5">
                  <span className="w-20 shrink-0 text-[var(--color-text-muted)]">{a === 'md5' ? 'MD5' : 'SHA-256'}</span>
                  {sums[a]
                    ? <><span data-sum={a} className="min-w-0 flex-1 break-all font-mono text-[11px] text-[var(--color-text-primary)]">{sums[a]}</span>
                        {/^[0-9a-f]+$/.test(sums[a]!) && <button title={tr('复制')} onClick={() => copy(sums[a]!, a)} className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-accent)]">{copied === a ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}</button>}</>
                    : <button data-calc={a} onClick={() => sum(a)} className="text-[var(--color-accent)] hover:underline">{tr('计算')}</button>}
                </div>
              ))}
            </div>
          )}
        </> : <>
          <Row k={tr('已选')}>{tr('{dirs} 个文件夹、{files} 个文件', { dirs: entries.filter((e) => e.isDir).length, files: entries.filter((e) => !e.isDir).length })}</Row>
          <Row k={tr('位置')}>{new Set(entries.map((e) => parentPath(e.path))).size === 1 ? parentPath(entries[0].path) : tr('多个位置')}</Row>
          <Row k={tr('合计')}><span data-stats>{statText}</span></Row>
        </>}
      </div>
    </Modal>
  )
}

/** sudo 密码：在服务器上 sudo -S -v 验证，对了才记下（只在主进程内存里，按终端） */
export function SudoDialog({ terminalId, title, onDone, onCancel }: { terminalId: string; title?: string; onDone: () => void; onCancel: () => void }) {
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = () => {
    if (!pw || busy) return
    setBusy(true); setErr('')
    client.fs.sudoAuth(terminalId, pw).then(onDone, (e) => { setErr(errMsg(e).replace(/^\[需要sudo密码\]/, '')); setBusy(false) })   // i18n-ignore 错误前缀标识（SUDO_NEED_PW）
  }
  return (
    <Modal title={tr('输入 sudo 密码')} icon={<ShieldAlert className="h-4 w-4 text-[var(--color-danger)]" />} width="w-[400px]" onClose={onCancel}
      footer={<><button onClick={onCancel} className={BTN}>{tr('取消')}</button><button data-sudo-ok disabled={!pw || busy} onClick={submit} className={PRIMARY}>{busy ? tr('验证中') : tr('确定')}</button></>}>
      <div className="mb-2">{tr('{host}执行 sudo 需要当前登录用户的密码。', { host: title ?? tr('这台服务器') })}</div>
      <PasswordInput data-sudo-pw autoFocus value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); e.stopPropagation() }}
        className="w-full" />
      <div className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">{tr('密码经 sudo -S 从标准输入传给服务器（不出现在命令行），只记在本机内存里，关掉应用就没了。')}</div>
      {err && <div data-sudo-err className="mt-1.5 text-[11px] text-[var(--color-danger)]">{err}</div>}
    </Modal>
  )
}

/** 修改属主（远程）：候选取服务器上的用户 / 组；含文件夹时可递归 */
export function ChownDialog({ scope, entries, prod, onDone, onCancel }: { scope: FsScope; entries: DirEntry[]; prod?: boolean; onDone: () => void; onCancel: () => void }) {
  const [owner, setOwner] = useState(entries[0]?.owner ?? '')
  const [group, setGroup] = useState(entries[0]?.group ?? '')
  const [rec, setRec] = useState(false)
  const [lists, setLists] = useState<{ users: string[]; groups: string[] }>({ users: [], groups: [] })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { client.fs.owners(scope).then(setLists).catch(() => {}) }, [])
  const anyDir = entries.some((e) => e.isDir && !e.isLink)
  const submit = () => {
    setErr(''); setBusy(true)
    client.fs.chown(scope, entries.map((e) => e.path), owner.trim(), group.trim(), anyDir && rec).then(onDone, (e) => { setErr(errMsg(e)); setBusy(false) })
  }
  const head = entries.slice(0, 3).map((e) => e.name).join(tr('、'))
  const label = entries.length > 3 ? tr('{names} 等 {n} 项', { names: head, n: entries.length }) : head
  return (
    <Modal title={prod ? tr('修改生产主机上的文件属主') : tr('修改属主')} icon={<UserCog className="h-4 w-4 text-[var(--color-accent)]" />} onClose={onCancel}
      footer={<><button onClick={onCancel} className={BTN}>{tr('取消')}</button><button data-chown-ok disabled={busy || (!owner.trim() && !group.trim())} onClick={submit} className={prod ? DANGER : PRIMARY}>{busy ? tr('修改中') : tr('修改属主')}</button></>}>
      <div className="mb-3">{label}</div>
      <div className="mb-2 flex gap-3">
        <label className="flex-1">{tr('属主')}<Combobox value={owner} onChange={setOwner} options={lists.users} className="mt-1 font-mono text-[12px]" /></label>
        <label className="flex-1">{tr('属组')}<Combobox value={group} onChange={setGroup} options={lists.groups} className="mt-1 font-mono text-[12px]" /></label>
      </div>
      <div className="mb-2 text-[11px] text-[var(--color-text-muted)]">{tr('留空的那一项不改。需要服务器上对应权限（一般要 root）。')}</div>
      {anyDir && <label className="flex cursor-pointer items-center gap-2"><Checkbox checked={rec} onCheckedChange={setRec} />{tr('递归应用到文件夹里的全部内容（chown -R）')}</label>}
      {err && <div data-chown-err className="mt-2 whitespace-pre-wrap break-all text-[11px] text-[var(--color-danger)]">{err}</div>}
      {prod && <div className="mt-2 rounded-md border border-[var(--color-danger)] bg-[color:color-mix(in_srgb,var(--color-danger)_12%,transparent)] px-3 py-2 font-medium text-[var(--color-danger)]">{tr('这是生产主机，属主改错可能导致服务读不到文件，请再确认一遍。')}</div>}
    </Modal>
  )
}
