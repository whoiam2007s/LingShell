import { History, Zap, Sparkles } from 'lucide-react'
import { COMPLETION_SNIPPETS, buildCompletionPool, resolveQuickCommand, templateVars, tk, tr, type CompletionItem, type CompletionMatch, type TermOs } from '@lingshell/shared'
import { client } from '../../../client/index.js'

// 命令自动补全浮层（系统设置「命令自动补全」开了才出现；触发 / 按键拦截在 TerminalPane.tsx，匹配排序在 shared/terminal/complete.ts）。
// 候选池按主机缓存（同主机的终端共用），15 秒过期或回车执行了新命令后下次用到时重拉；过滤在渲染层同步做。

const TTL = 15_000
const pools = new Map<string, { at: number; pool: CompletionItem[] }>()   // hostKey → 候选池
const hostOf = new Map<string, string>()                                  // terminalId → hostKey
const inflight = new Map<string, Promise<void>>()                         // terminalId → 进行中的拉取

async function load(terminalId: string, os: TermOs | undefined) {
  const [h, q] = await Promise.all([client.history.forTerminal(terminalId), client.quickCommands.get().catch(() => null)])
  const quick: { command: string; label: string }[] = []
  for (const s of q?.sets ?? []) for (const c of s.commands) {
    const r = resolveQuickCommand(c, os)
    if ('command' in r && !templateVars(r.command).length) quick.push({ command: r.command, label: c.label })   // 带参数占位的要填表，不进补全
  }
  hostOf.set(terminalId, h.hostKey)
  pools.set(h.hostKey, { at: Date.now(), pool: buildCompletionPool({ history: h.entries, quick, snippets: COMPLETION_SNIPPETS }) })
}

/** 取该终端主机的候选池（同步，可能是旧的）；没有或过期时后台重拉，拉完回调 onReady（调用方据此重新过滤） */
export function completionPool(terminalId: string, os: TermOs | undefined, onReady: () => void): CompletionItem[] | undefined {
  const hk = hostOf.get(terminalId)
  const e = hk ? pools.get(hk) : undefined
  if ((!e || Date.now() - e.at > TTL) && !inflight.has(terminalId)) {
    const p = load(terminalId, os).then(onReady, () => {}).finally(() => inflight.delete(terminalId))
    inflight.set(terminalId, p)
  }
  return e?.pool
}

/** 回车执行了命令：该主机候选池下次用到时重拉 */
export function staleCompletions(terminalId: string) {
  const e = pools.get(hostOf.get(terminalId) ?? '')
  if (e) e.at = 0
}

/** Shift+Delete：删该主机所有这条历史，并立即从缓存里拿掉 */
export async function deleteCompletion(terminalId: string, text: string) {
  const e = pools.get(hostOf.get(terminalId) ?? '')
  if (e) e.pool = e.pool.filter((i) => i.text !== text)
  await client.history.deleteCommand(terminalId, text)
  staleCompletions(terminalId)
}

const KIND = {
  history: { icon: History, label: tk('历史') },
  quick: { icon: Zap, label: tk('快速命令') },
  snippet: { icon: Sparkles, label: tk('常用') },
} as const

// x / y 相对终端区域；up = 光标下方放不下，浮层贴在光标行上方
export function CompletionPopup({ x, y, up, matches, sel, onPick, onSel }: {
  x: number; y: number; up: boolean; matches: CompletionMatch[]; sel: number
  onPick: (i: number) => void; onSel: (i: number) => void
}) {
  return (
    // 按下不抢焦点：键盘焦点留在 xterm，继续打字 / ↑↓ 照常
    <div style={{ left: x, top: y }} onMouseDown={(e) => { e.preventDefault(); e.stopPropagation() }}
      className={`absolute z-30 w-[380px] max-w-[calc(100%-8px)] overflow-hidden rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] py-0.5 text-[12px] shadow-lg ${up ? '-translate-y-full' : ''}`}>
      {matches.map((m, i) => {
        const k = KIND[m.item.kind], t = m.item.text
        return (
          <div key={t} onMouseEnter={() => onSel(i)} onClick={() => onPick(i)} title={m.item.label ? tr('{label}：{cmd}', { label: tr(m.item.label), cmd: t }) : t}
            className={`flex h-[22px] cursor-pointer items-center gap-1.5 px-2 ${i === sel ? 'bg-[color:color-mix(in_srgb,var(--color-accent)_18%,transparent)]' : ''}`}>
            <k.icon className="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" />
            <span className="min-w-0 flex-1 truncate whitespace-pre font-mono text-[var(--color-text-secondary)]">
              {t.slice(0, m.start)}<span className="font-semibold text-[var(--color-accent)]">{t.slice(m.start, m.end)}</span>{t.slice(m.end)}
            </span>
            <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{tr(m.item.label ?? k.label)}</span>
          </div>
        )
      })}
      <div className="border-t border-[var(--color-border-subtle)] px-2 pt-0.5 text-[10px] text-[var(--color-text-muted)]">
        {tr('Tab / → 接受 · ↑↓ 选择 · Esc 关闭 · Shift+Delete 删除历史')}
      </div>
    </div>
  )
}
