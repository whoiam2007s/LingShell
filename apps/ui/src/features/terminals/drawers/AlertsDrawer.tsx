// 告警汇总抽屉（右侧活动栏「告警」）：关键字告警命中的行，新的在上。点一条 → 切到该终端并滚到那一行；「问 AI」把该行前后 20 行放进对话输入框
import { useEffect, useState } from 'react'
import { X, Trash2, Sparkles } from 'lucide-react'
import { redactSecrets, tr } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { quoteToChat } from '../../../lib/quoteToChat.js'
import { HelpTip } from '../../../components/ui/form.js'
import { clearAlertHits, markAlertsRead, useAlertHits, type AlertHitEntry } from '../alertHits.js'

export function AlertsDrawer({ onClose }: { onClose: () => void }) {
  const { list } = useAlertHits()
  const [note, setNote] = useState<{ id: number; text: string } | null>(null)
  useEffect(() => { markAlertsRead(true); return () => markAlertsRead(false) }, [])
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(null), 3500); return () => clearTimeout(t) }, [note])
  const gone = (e: AlertHitEntry) => setNote({ id: e.id, text: tr('这一行已不在终端缓冲里（终端已关闭、清屏或滚出回滚行数）') })
  const ask = async (e: AlertHitEntry) => {
    const ctx = e.context(20)
    if (ctx === null) { gone(e); return }
    const s = await client.settings.get().catch(() => undefined)
    const fence = '```'
    const q = `终端「${e.terminalTitle}」的输出命中告警规则「${e.rule}」（${new Date(e.at).toLocaleTimeString()}）：\n${e.line}\n\n前后各 20 行：\n${fence}\n${ctx}\n${fence}\n帮我看看这是什么问题。`   // i18n-ignore 发给 AI 的话
    quoteToChat(s?.system?.aiRedact === false ? q : redactSecrets(q))
  }
  return (
    <div className="flex h-full flex-col" data-alerts-drawer>
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-3">
        <span className="text-[12px] font-semibold text-[var(--color-text-primary)]">{tr('告警')}</span>
        <HelpTip>{tr('设置 → 终端 → 提醒 → 关键字高亮里点亮铃铛的规则，命中的输出行都收在这里（通知每条规则 30 秒最多一次，这里每行都记），只在内存里保留最近 500 条。点一条切到那个终端并滚到那一行；「问 AI」把该行和前后各 20 行放进对话输入框。')}</HelpTip>
        <span className="text-[11px] text-[var(--color-text-muted)]">{tr('{n} 条', { n: list.length })}</span>
        <button title={tr('清空')} disabled={!list.length} onClick={clearAlertHits}
          className="ml-auto flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-danger)] disabled:opacity-40"><Trash2 className="h-3 w-3" />{tr('清空')}</button>
        <button onClick={onClose} title={tr('关闭（Esc）')} className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><X className="h-3.5 w-3.5" /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {!list.length && <div className="px-2 py-3 text-[11px] leading-relaxed text-[var(--color-text-muted)]">{tr('还没有告警。在「设置 → 终端 → 提醒 → 关键字高亮」里给规则点亮铃铛，命令输出命中时会记在这里。')}</div>}
        {[...list].reverse().map((e) => (
          <div key={e.id} data-alert-hit className="group rounded px-2 py-1.5 hover:bg-[var(--color-bg-hover)]">
            <button onClick={() => { if (!e.goto()) gone(e) }} title={tr('切到该终端并滚到这一行')} className="block w-full text-left">
              <div className="flex items-center gap-1.5 text-[10.5px] text-[var(--color-text-muted)]">
                <span className="tabular-nums">{new Date(e.at).toLocaleTimeString()}</span>
                <span className="max-w-[90px] truncate rounded bg-[var(--color-bg-raised)] px-1">{e.terminalTitle}</span>
                <span className="min-w-0 truncate font-mono text-[var(--color-warn)]" title={tr('规则：{rule}', { rule: e.rule })}>{e.rule}</span>
              </div>
              <div className="mt-0.5 line-clamp-2 break-all font-mono text-[11.5px] text-[var(--color-text-primary)]">{e.line}</div>
            </button>
            <div className="mt-0.5 flex items-center gap-2">
              <button onClick={() => void ask(e)} className="flex items-center gap-1 text-[11px] text-[var(--color-accent)] hover:underline"><Sparkles className="h-3 w-3" />{tr('问 AI')}</button>
              {note?.id === e.id && <span className="text-[10.5px] text-[var(--color-warn)]">{note.text}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
