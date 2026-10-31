import { useEffect, useRef, useState } from 'react'
import { Lock } from 'lucide-react'
import { tr, type LockStatus } from '@lingshell/shared'
import { trx } from '../../lib/trx.js'
import { client } from '../../client/index.js'
import { TitleBar } from '../shell/index.js'
import { PasswordInput } from '../../components/ui/PasswordInput.js'

// 应用锁外壳：真正的拦截在主进程（锁定时敏感 IPC 一律拒），这里只负责不让人看到内容。
// 启动时已锁 → 解锁前根本不挂载应用（启动恢复的 IPC 会被拒）；中途锁定 → 应用保持挂载（终端缓冲、进行中的对话都在），
// 但整体 visibility:hidden + inert：内容不渲染、不可聚焦，不是半透明遮罩。
export function LockGate({ children }: { children: React.ReactNode }) {
  const [locked, setLocked] = useState<boolean | null>(null)
  const [everOpen, setEverOpen] = useState(false)
  useEffect(() => {
    const off = client.on((ev) => { if (ev.type === 'app:lock') setLocked(ev.locked) })
    client.lock.status().then((s) => setLocked((cur) => cur ?? s.locked)).catch(() => setLocked(false))   // 非 Electron 环境无锁
    return off
  }, [])
  useEffect(() => { if (locked === false) setEverOpen(true) }, [locked])

  return (
    <>
      {everOpen && <div inert={!!locked} style={locked ? { visibility: 'hidden' } : undefined}>{children}</div>}
      {locked && <LockScreen />}
    </>
  )
}

function LockScreen() {
  const [st, setSt] = useState<LockStatus | null>(null)
  const [pw, setPw] = useState('')
  const [until, setUntil] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [busy, setBusy] = useState(false)
  const [help, setHelp] = useState(false)
  const [err, setErr] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    client.lock.status().then((s) => { setSt(s); if (s.retryAfterMs) setUntil(Date.now() + s.retryAfterMs) }).catch(() => {})
    input.current?.focus()
  }, [])
  useEffect(() => {
    if (until <= now) return
    const t = setTimeout(() => setNow(Date.now()), 250)
    return () => clearTimeout(t)
  }, [until, now])
  const wait = Math.max(0, Math.ceil((until - now) / 1000))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy || wait > 0 || !pw) return
    setBusy(true); setErr('')
    try {
      const r = await client.lock.unlock(pw)
      if (r.ok) return   // app:lock 事件会把锁屏撤掉
      setPw('')
      setSt((s) => s && { ...s, failures: r.failures })
      setUntil(Date.now() + r.retryAfterMs); setNow(Date.now())
    } catch (e) {
      // 锁文件损坏时主进程会抛错（不能静默放行），必须让用户看到原因
      setErr(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': Error:\s*/, ''))
    } finally { setBusy(false); setTimeout(() => input.current?.focus()) }
  }

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-[var(--color-bg-base)] text-[var(--color-text-primary)]">
      <TitleBar />
      <div className="flex flex-1 items-center justify-center">
        <form onSubmit={submit} className="w-[340px] space-y-3 rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-6 shadow-2xl">
          <div className="flex flex-col items-center gap-2 pb-1">
            <Lock className="h-8 w-8 text-[var(--color-accent)]" />
            <div className="text-[15px] font-semibold">{tr('灵壳已锁定')}</div>
            <div className="text-[11px] text-[var(--color-text-muted)]">{tr('已打开的连接和 AI 任务仍在后台运行')}</div>
          </div>
          <PasswordInput ref={input} value={pw} onChange={(e) => setPw(e.target.value)} placeholder={tr('主密码')} autoFocus
            className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2.5 py-1.5 text-[13px] outline-none focus:border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)]" />
          {st?.damaged && (
            <div className="rounded-md bg-[color:color-mix(in_srgb,var(--color-danger)_10%,transparent)] p-2 text-[11px] leading-relaxed text-[var(--color-danger)]">
              {trx('锁文件损坏或无法解析，密码无法验证。请退出应用后删除 {file} 再重新打开（会关闭应用锁）。', { file: <code className="break-all">{st.lockFile}</code> })}
            </div>
          )}
          {!!st?.failures && (
            <div className="text-[11px] text-[var(--color-danger)]">
              {tr('密码错误，已连续错 {n} 次', { n: st.failures })}{wait > 0 ? tr('，{s} 秒后可再试', { s: wait }) : ''}
            </div>
          )}
          {err && <div className="text-[11px] text-[var(--color-danger)]">{err}</div>}
          <button type="submit" disabled={busy || wait > 0 || !pw}
            className="w-full rounded-md bg-[var(--color-accent)] py-1.5 text-[12px] font-medium text-[var(--color-bg-base)] hover:bg-[var(--color-accent-dim)] disabled:opacity-50">
            {busy ? tr('验证中…') : wait > 0 ? tr('请等待 {s} 秒', { s: wait }) : tr('解锁')}
          </button>
          <button type="button" onClick={() => setHelp(!help)} className="text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]">{tr('忘记密码？')}</button>
          {help && (
            <div className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] p-2.5 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
              {trx('主密码无法找回。唯一办法：退出应用，删除文件 {file}，再重新打开（即关闭了应用锁）。', { file: <code className="break-all text-[var(--color-text-secondary)]">{st?.lockFile ?? 'lock.json'}</code> })}
              {' '}{tr('这不会泄露已保存的密码和密钥——它们由操作系统密钥链加密，与应用锁无关。应用锁只是防止他人在你离开时使用本应用的访问屏障，不是加密。')}
            </div>
          )}
        </form>
      </div>
    </div>
  )
}
