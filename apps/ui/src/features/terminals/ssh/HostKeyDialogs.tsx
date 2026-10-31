import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ShieldAlert, ShieldQuestion } from 'lucide-react'
import { tr, type HostKeyInfo } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { ConfirmDialog } from '../../common/index.js'
import { AuthPromptDialog, hopRole } from './AuthPromptDialog.js'
import { trx } from '../../../lib/trx.js'

// SSH 主机指纹弹窗（全局挂一次）：
//  - hostKey:unknown 首次连接 → 显示指纹，信任并连接 / 取消（主进程 2 分钟超时按取消，发 hostKey:resolved 关窗）
//  - hostKey:mismatch 指纹不符（连接已拒）→ 醒目告警；用户确认换钥后更新记录，再手动重连
// 同时挂上 SSH 二次验证弹窗（AuthPromptDialog）
export function HostKeyDialogs() {
  return <><HostKeyPrompts /><AuthPromptDialog /></>
}

function HostKeyPrompts() {
  const [asks, setAsks] = useState<{ requestId: string; info: HostKeyInfo }[]>([])
  const [mismatch, setMismatch] = useState<HostKeyInfo | null>(null)
  const [confirmReplace, setConfirmReplace] = useState(false)
  const [done, setDone] = useState('')

  useEffect(() => client.on((ev) => {
    if (ev.type === 'hostKey:unknown') setAsks((a) => [...a, { requestId: ev.requestId, info: ev.info }])
    else if (ev.type === 'hostKey:resolved') setAsks((a) => a.filter((x) => x.requestId !== ev.requestId))
    else if (ev.type === 'hostKey:mismatch') { setMismatch(ev.info); setDone('') }
  }), [])

  const ask = asks[0]
  const decide = (trust: boolean) => {
    if (!ask) return
    setAsks((a) => a.slice(1))
    void client.knownHosts.decide(ask.requestId, trust)
  }
  const replace = async () => {
    setConfirmReplace(false)
    if (!mismatch) return
    try { await client.knownHosts.acceptChanged(mismatch.hostPort); setDone(tr('指纹已更新，请重新连接。')) }
    catch (e) { setDone(String(e instanceof Error ? e.message : e)) }
  }

  const row = (k: string, v: string, cls = '') => (
    <div className="flex gap-2"><span className="w-20 shrink-0 text-[var(--color-text-muted)]">{k}</span><span className={`min-w-0 break-all ${cls}`}>{v}</span></div>
  )
  const shell = (children: ReactNode) => createPortal((
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 backdrop-blur-sm animate-fade-in">
      <div className="w-[460px] rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-5 shadow-2xl">{children}</div>
    </div>
  ), document.body)

  if (mismatch) {
    return (<>
      {shell(<>
        <div className="mb-2 flex items-center gap-2 text-[14px] font-semibold text-[var(--color-danger)]">
          <ShieldAlert className="h-5 w-5" />{tr('警告：SSH 主机指纹已改变，连接已拒绝')}
        </div>
        <p className="mb-3 text-[12.5px] leading-relaxed text-[var(--color-text-secondary)]">
          {tr('{role}「{label}」出示的主机密钥与上次记录的不一致。可能有人正在冒充这台服务器（中间人攻击）， 继续连接可能泄露密码，且 AI 会在冒充的机器上执行命令。也可能只是服务器重装系统或更换了密钥——请先向服务器管理员确认。',
            { role: hopRole(mismatch.role), label: mismatch.label })}
        </p>
        <div className="mb-4 space-y-1 rounded-md border border-[color:color-mix(in_srgb,var(--color-danger)_40%,transparent)] bg-[color:color-mix(in_srgb,var(--color-danger)_10%,transparent)] p-2.5 font-mono text-[11.5px] text-[var(--color-text-primary)]">
          {row(tr('主机'), mismatch.hostPort)}
          {row(tr('已记录'), mismatch.expected ?? '')}
          {row(tr('本次'), `${mismatch.keyType} ${mismatch.fingerprint}`, 'text-[var(--color-danger)]')}
        </div>
        {done && <div className="mb-3 text-[12px] text-[var(--color-text-secondary)]">{done}</div>}
        <div className="flex justify-end gap-2">
          {!done && <button onClick={() => setConfirmReplace(true)} className="rounded-md border border-[color:color-mix(in_srgb,var(--color-danger)_60%,transparent)] px-3 py-1.5 text-[12px] text-[var(--color-danger)] transition-colors hover:bg-[color:color-mix(in_srgb,var(--color-danger)_10%,transparent)]">{tr('我确认服务器已重装/换钥，更新指纹')}</button>}
          <button onClick={() => setMismatch(null)} className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-[12.5px] font-medium text-[var(--color-bg-base)] hover:bg-[var(--color-accent-dim)]">{tr('关闭')}</button>
        </div>
      </>)}
      <ConfirmDialog
        open={confirmReplace}
        title={tr('更新主机指纹')}
        message={tr('确定用新指纹替换 {host} 的记录？只有确认服务器确实重装或更换了密钥时才这样做，否则可能正在把密码交给攻击者。', { host: mismatch.hostPort })}
        confirmText={tr('更新指纹')}
        onConfirm={() => { void replace() }}
        onCancel={() => setConfirmReplace(false)}
      />
    </>)
  }

  if (!ask) return null
  const { info } = ask
  return shell(<>
    <div className="mb-2 flex items-center gap-2 text-[14px] font-semibold text-[var(--color-text-primary)]">
      <ShieldQuestion className="h-5 w-5 text-[var(--color-accent)]" />{tr('首次连接，请确认主机指纹')}
    </div>
    <p className="mb-3 text-[12.5px] leading-relaxed text-[var(--color-text-secondary)]">
      {trx('这是第一次连接{role}「{label}」，无法确认对方身份。如有条件，请与服务器上 {cmd} 的输出核对。信任后会记住此指纹，以后若变化将拒绝连接。',
        { cmd: <code className="font-mono">ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub</code> }, { role: hopRole(info.role), label: info.label })}
    </p>
    <div className="mb-4 space-y-1 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] p-2.5 font-mono text-[11.5px] text-[var(--color-text-primary)]">
      {row(tr('主机'), info.hostPort)}
      {row(tr('类型'), info.keyType)}
      {row(tr('指纹'), info.fingerprint)}
    </div>
    <div className="flex items-center justify-end gap-2">
      {asks.length > 1 && <span className="mr-auto text-[11px] text-[var(--color-text-muted)]">{tr('还有 {n} 个待确认', { n: asks.length - 1 })}</span>}
      <button onClick={() => decide(false)} className="rounded-md border border-[var(--color-border-default)] px-4 py-1.5 text-[12.5px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)]">{tr('取消')}</button>
      <button onClick={() => decide(true)} className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-[12.5px] font-medium text-[var(--color-bg-base)] hover:bg-[var(--color-accent-dim)]">{tr('信任并连接')}</button>
    </div>
  </>)
}
