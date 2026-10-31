import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { KeyRound } from 'lucide-react'
import { tr, type SshAuthPromptInfo } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { SecretOrText } from '../../../components/ui/PasswordInput.js'

type Ask = { requestId: string; info: SshAuthPromptInfo; deadline: number }

/** 主进程给的连接角色（'跳板机' | '目标主机'，中文原值）→ 显示文字 */
export function hopRole(role: string): string {
  if (role === '目标主机') return tr('hop|目标主机')   // i18n-ignore 比较主进程给的角色值
  return tr(role)
}

// SSH 二次验证弹窗（keyboard-interactive：OTP / Google Authenticator / 堡垒机提示），全局挂一次。
// 每个提示一个输入框（服务器标了不回显的用密码框）；取消 / 主进程超时 → 该连接失败。
// 后台连接（批量执行、比对、文件传输）同样会弹，标题写明是哪台主机；多台排队逐个填。
export function AuthPromptDialog() {
  const [asks, setAsks] = useState<Ask[]>([])
  useEffect(() => client.on((ev) => {
    if (ev.type === 'sshAuth:prompt') setAsks((a) => [...a, { requestId: ev.requestId, info: ev.info, deadline: Date.now() + ev.deadlineMs }])
    else if (ev.type === 'sshAuth:resolved') setAsks((a) => a.filter((x) => x.requestId !== ev.requestId))
  }), [])
  const ask = asks[0]
  if (!ask) return null
  const reply = (ans: string[] | null) => {
    setAsks((a) => a.slice(1))
    void client.sshAuth.answer(ask.requestId, ans)
  }
  return createPortal((
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 backdrop-blur-sm animate-fade-in">
      <AskForm key={ask.requestId} ask={ask} more={asks.length - 1} onReply={reply} />
    </div>
  ), document.body)
}

function AskForm({ ask, more, onReply }: { ask: Ask; more: number; onReply: (ans: string[] | null) => void }) {
  const { info } = ask
  const [answers, setAnswers] = useState(() => info.prompts.map(() => ''))
  const mins = Math.max(1, Math.round((ask.deadline - Date.now()) / 60_000))
  return (
    <form onSubmit={(e) => { e.preventDefault(); onReply(answers) }}
      className="w-[440px] rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-5 shadow-2xl">
      <div className="mb-1 flex items-center gap-2 text-[14px] font-semibold text-[var(--color-text-primary)]">
        <KeyRound className="h-5 w-5 shrink-0 text-[var(--color-accent)]" /><span className="truncate">{tr('SSH 二次验证：{label}', { label: info.label })}</span>
      </div>
      <div className="mb-3 font-mono text-[11.5px] text-[var(--color-text-muted)]">{hopRole(info.role)} · {info.hostPort}</div>
      {(info.name || info.instructions) && (
        <div className="mb-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] p-2.5 text-[12px] text-[var(--color-text-secondary)]">
          {[info.name, info.instructions].filter(Boolean).join('\n')}
        </div>
      )}
      <div className="space-y-2.5">
        {info.prompts.map((p, i) => (
          <div key={i}>
            <label className="mb-1 block whitespace-pre-wrap text-[12px] text-[var(--color-text-secondary)]">{p.prompt.trim() || tr('输入 {n}', { n: i + 1 })}</label>
            <SecretOrText secret={!p.echo} autoFocus={i === 0} autoComplete="off" value={answers[i]}
              onChange={(e) => setAnswers((a) => a.map((x, j) => (j === i ? e.target.value : x)))}
              className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2.5 py-1.5 font-mono text-[13px] text-[var(--color-text-primary)] outline-none focus:border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)]" />
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center justify-end gap-2">
        <span className="mr-auto text-[11px] text-[var(--color-text-muted)]">{more > 0 ? tr('还有 {n} 台待验证 · ', { n: more }) : ''}{tr('约 {n} 分钟内未填将取消', { n: mins })}</span>
        <button type="button" onClick={() => onReply(null)} className="rounded-md border border-[var(--color-border-default)] px-4 py-1.5 text-[12.5px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)]">{tr('取消')}</button>
        <button type="submit" className="rounded-md border border-transparent bg-[var(--color-accent)] px-4 py-1.5 text-[12.5px] font-medium text-[var(--color-bg-base)] hover:bg-[var(--color-accent-dim)]">{tr('确定')}</button>
      </div>
    </form>
  )
}
