import { useEffect, useRef, useState } from 'react'
import { FileInput, FolderOpen, Loader2, X } from 'lucide-react'
import { tk, tr, type SessionImportSource, type SshImportItem, type SshImportPreview, type SshImportResult } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { HelpTip } from '../ui.js'
import { Checkbox } from '../../../components/ui/Checkbox.js'
import { trx } from '../../../lib/trx.js'

const KEY_TEXT: Record<SshImportItem['keyStatus'], string> = { ok: tk('私钥'), encrypted: tk('私钥·需填口令'), missing: tk('私钥缺失'), none: tk('密码待填') }
type Source = 'ssh' | SessionImportSource
const SOURCES: { id: Source; label: string; pick?: string; hint?: string }[] = [
  { id: 'ssh', label: '~/.ssh/config' },
  { id: 'xshell', label: 'Xshell', pick: tk('选择会话文件夹…'), hint: tk('默认读 文档\\NetSarang Computer\\<版本>\\Xshell\\Sessions') },
  { id: 'putty', label: 'PuTTY', pick: tk('选择 .reg 文件…'), hint: tk('默认读注册表 HKCU\\Software\\SimonTatham\\PuTTY\\Sessions') },
  { id: 'mobaxterm', label: 'MobaXterm', pick: tk('选择 MobaXterm.ini…'), hint: tk('默认读 %APPDATA%\\MobaXterm\\MobaXterm.ini；便携版请选程序目录下的 MobaXterm.ini') },
  { id: 'securecrt', label: 'SecureCRT', pick: tk('选择 Sessions 文件夹…'), hint: tk('默认读 %APPDATA%\\VanDyke\\Config\\Sessions') },
]
// 主进程的 ProxyCommand 警告（packages/config sshConfigImport）：单独标红显示，不再重复列在普通警告里。中文原文和译文都认
const isProxyWarn = (w: string) => w.startsWith('将执行本地命令') || w.startsWith(tr('将执行本地命令（ProxyCommand）：{cmd}', { cmd: '' }))   // i18n-ignore 与主进程的警告前缀对应（主进程改用 tr 时用同一个键）

// 导入主机：来源 ~/.ssh/config / Xshell / PuTTY / MobaXterm / SecureCRT。预览（勾选，已存在的默认不勾）→ 导入 → 显示结果警告。
// 其它客户端的会话只导名称/地址/端口/用户名/分组，密码一律不导入
export function SshImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [source, setSource] = useState<Source>('ssh')
  const [preview, setPreview] = useState<SshImportPreview | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<SshImportResult | null>(null)
  const meta = SOURCES.find((s) => s.id === source)!

  const show = (p: SshImportPreview | undefined) => {
    if (!p) return   // 取消了选择框：保持原预览
    setPreview(p)
    setChecked(new Set(p.items.filter((i) => !i.existingId).map((i) => i.alias)))
  }
  const load = (s: Source, pick = false) => {
    setError('')
    if (!pick) setPreview(null)
    const p = s === 'ssh' ? client.hosts.sshConfigPreview() : client.hosts.sessionImportPreview(s, pick)
    p.then((r) => { if (cur.current === s) show(r) }).catch((e) => { if (cur.current === s) setError(String(e instanceof Error ? e.message : e)) })   // 切走了的来源结果丢掉
  }
  const cur = useRef<Source>(source)
  cur.current = source
  useEffect(() => { load(source) }, [source])

  const toggle = (a: string) => setChecked((s) => { const n = new Set(s); if (n.has(a)) n.delete(a); else n.add(a); return n })
  const doImport = async () => {
    setBusy(true); setError('')
    try { setResult(await (source === 'ssh' ? client.hosts.importSshConfig([...checked]) : client.hosts.importSessions([...checked]))) }
    catch (e) { setError(String(e instanceof Error ? e.message : e)) }
    // 不管成功 / 中途失败，都刷新主机列表：部分已写入的主机不能对不上界面
    finally { setBusy(false); onImported() }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="flex max-h-[80vh] w-[600px] flex-col rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex shrink-0 items-center justify-between">
          <span className="flex items-center gap-2 text-[14px] font-semibold text-[var(--color-text-primary)]"><FileInput className="h-4 w-4 text-[var(--color-accent)]" />{tr('导入主机')}
            <HelpTip>{tr('选来源，在预览里勾选后点「导入所选」；已存在的（地址 + 端口 + 用户名相同）默认不勾。其它客户端的会话只导名称、地址、端口、用户名、分组，密码一律不导入')}</HelpTip></span>
          <button onClick={onClose}><X className="h-4 w-4 text-[var(--color-text-muted)]" /></button>
        </div>
        {!result && (
          <div className="mb-2 flex shrink-0 flex-wrap gap-1">
            {SOURCES.map((s) => (
              <button key={s.id} onClick={() => setSource(s.id)}
                className={`rounded-md px-2.5 py-1 text-[12px] transition-colors ${source === s.id ? 'bg-[var(--color-bg-raised)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'}`}>{s.label}</button>
            ))}
          </div>
        )}
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-0.5 text-[12px]">
          {error && <div className="rounded-md bg-[color:color-mix(in_srgb,var(--color-danger)_10%,transparent)] px-2.5 py-1.5 text-[11px] text-[var(--color-danger)]">{error}</div>}
          {!preview && !error && <div className="flex items-center gap-1.5 text-[var(--color-text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" />{tr('读取中…')}</div>}
          {result ? (
            <>
              <div className="flex items-center gap-1.5 text-[var(--color-text-primary)]">{tr('已导入 {n} 台主机', { n: result.imported })}<HelpTip>{tr('带口令的私钥 / 待填密码的主机，请在主机列表里编辑补全')}</HelpTip></div>
              {result.warnings.map((w, i) => <div key={i} className="text-[11px] text-[var(--color-warn)]">· {tr(w)}</div>)}
            </>
          ) : preview && (
            <>
              <div className="flex items-center gap-2">
                <span className="min-w-0 truncate text-[11px] text-[var(--color-text-muted)]" title={preview.path}>{preview.found ? preview.path : tr('未找到：{path}', { path: preview.path })}</span>
                {meta.hint && <HelpTip>{tr(meta.hint)}{meta.pick ? tr('；不在默认位置时点「{btn}」手动选择', { btn: tr(meta.pick).replace('…', '') }) : ''}</HelpTip>}
                <span className="flex-1" />
                {meta.pick && (
                  <button onClick={() => load(source, true)} className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--color-border-default)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">
                    <FolderOpen className="h-3 w-3" />{tr(meta.pick)}
                  </button>
                )}
              </div>
              {preview.warnings.map((w, i) => <div key={i} className="text-[11px] text-[var(--color-warn)]">· {tr(w)}</div>)}
              {preview.items.some((i) => i.proxyCommand && checked.has(i.alias)) && <div className={`flex items-center gap-1.5 ${PC_BOX}`}>
                {tr('所选有 {n} 台带 ProxyCommand，请确认命令可信', { n: preview.items.filter((i) => i.proxyCommand && checked.has(i.alias)).length })}
                <HelpTip>{tr('每次连接这些主机都会在本机执行下面标红的命令（ProxyCommand）。请确认命令可信，不认识的不要勾选')}</HelpTip>
              </div>}
              {preview.found && preview.items.length === 0 && <div className="text-[var(--color-text-muted)]">{source === 'ssh' ? tr('配置中没有可导入的主机（通配 Host 不单独导入）') : tr('没有可导入的 SSH 会话')}</div>}
              {preview.items.map((it) => (
                <label key={it.alias} className="flex cursor-pointer gap-2 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-2.5 py-1.5">
                  <Checkbox className="mt-0.5" checked={checked.has(it.alias)} onCheckedChange={() => toggle(it.alias)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-[var(--color-text-primary)]">{it.alias}</span>
                      <span className="text-[11px] text-[var(--color-text-muted)]">{it.username ? `${it.username}@` : ''}{it.host}:{it.port}{it.jump ? tr(' · 经 {jump} 跳转', { jump: it.jump }) : ''}</span>
                      {it.group && <Tag>{it.group}</Tag>}
                      <Tag warn={it.keyStatus !== 'ok'}>{it.authType === 'agent' ? tr('agent 认证') : tr(KEY_TEXT[it.keyStatus])}</Tag>
                      {it.existingId && <Tag>{tr('已存在')}</Tag>}
                    </div>
                    {it.keyFile && <div className="truncate text-[10px] text-[var(--color-text-muted)]" title={it.keyFile}>{it.keyFile}</div>}
                    {it.proxyCommand && <div className={PC_BOX}>{trx('将执行本地命令（ProxyCommand）：{cmd}', { cmd: <code className="break-all font-mono">{it.proxyCommand}</code> })}</div>}
                    {it.warnings.filter((w) => !isProxyWarn(w)).map((w, i) => <div key={i} className="text-[10px] text-[var(--color-warn)]">· {tr(w)}</div>)}
                  </div>
                </label>
              ))}
            </>
          )}
        </div>
        <div className="mt-3 flex shrink-0 items-center justify-end gap-2">
          {result ? (
            <button onClick={onClose} className="rounded-md border border-transparent bg-[var(--color-accent)] px-4 py-1.5 text-[12px] font-medium text-[var(--color-bg-base)] hover:bg-[var(--color-accent-dim)]">{tr('完成')}</button>
          ) : (
            <>
              <button onClick={onClose} className="rounded-md border border-[var(--color-border-default)] px-3 py-1.5 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">{tr('取消')}</button>
              <button onClick={doImport} disabled={busy || checked.size === 0}
                className="flex items-center gap-1.5 rounded-md border border-transparent bg-[var(--color-accent)] px-4 py-1.5 text-[12px] font-medium text-[var(--color-bg-base)] hover:bg-[var(--color-accent-dim)] disabled:opacity-40">
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{tr('导入所选（{n}）', { n: checked.size })}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const PC_BOX = 'mt-0.5 rounded bg-[color:color-mix(in_srgb,var(--color-danger)_12%,transparent)] px-1.5 py-1 text-[11px] text-[var(--color-danger)]'

function Tag({ children, warn }: { children: React.ReactNode; warn?: boolean }) {
  return <span className={`shrink-0 rounded px-1 text-[10px] leading-4 ${warn ? 'bg-[color:color-mix(in_srgb,var(--color-warn)_15%,transparent)] text-[var(--color-warn)]' : 'bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]'}`}>{children}</span>
}
