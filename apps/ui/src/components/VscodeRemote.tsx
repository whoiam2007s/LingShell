import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Code2, Loader2, X } from 'lucide-react'
import { tr } from '@lingshell/shared'
import { client } from '../client/index.js'
import { trx } from '../lib/trx.js'

// 用 VS Code Remote 打开（资源管理器目录右键 / 终端里 Ctrl+点击报错行）：第一次要往 ~/.ssh/config 写托管 Host 块时先确认，
// 之后直接打开。失败（没装 code / 没有 Remote - SSH 扩展）在同一个小窗里说明。只能按钮 / Esc 关
const EVT = 'lingshell:vscode-remote'
type Req = { terminalId: string; run: () => Promise<unknown> }
const errText = (e: unknown) => String((e as { message?: string })?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** 先看要不要写 ssh config（要就弹确认），再执行 run（实际打开） */
export function withVscodeRemote(terminalId: string, run: () => Promise<unknown>): void {
  window.dispatchEvent(new CustomEvent<Req>(EVT, { detail: { terminalId, run } }))
}
export const openDirInVscode = (terminalId: string, dir: string) => withVscodeRemote(terminalId, () => client.fileLinks.vscodeOpen(terminalId, dir, { dir: true }))

type Plan = Awaited<ReturnType<typeof client.fileLinks.vscodePlan>>
export function VscodeRemoteHost() {
  const [st, setSt] = useState<{ req: Req; plan?: Plan; busy?: boolean; error?: string } | null>(null)
  useEffect(() => {
    const go = async (req: Req) => {
      try {
        const plan = await client.fileLinks.vscodePlan(req.terminalId)
        if (plan.needWrite) { setSt({ req, plan }); return }
        await req.run()
      } catch (e) { setSt({ req, error: errText(e) }) }
    }
    const f = (e: Event) => void go((e as CustomEvent<Req>).detail)
    window.addEventListener(EVT, f)
    return () => window.removeEventListener(EVT, f)
  }, [])
  useEffect(() => {
    if (!st) return
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setSt(null) } }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [st])
  if (!st) return null
  const confirm = async () => {
    setSt({ ...st, busy: true })
    try { await st.req.run(); setSt(null) } catch (e) { setSt({ ...st, busy: false, error: errText(e) }) }
  }
  return createPortal((
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in" data-vscode-dialog>
      <div className="w-[520px] rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-4 shadow-2xl">
        <div className="mb-2 flex items-center gap-2 text-[13.5px] font-semibold text-[var(--color-text-primary)]">
          <Code2 className="h-4 w-4 text-[var(--color-accent)]" />{tr('用 VS Code Remote 打开')}
          <button onClick={() => setSt(null)} title={tr('关闭（Esc）')} className="ml-auto flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><X className="h-4 w-4" /></button>
        </div>
        {st.plan && <>
          <p className="text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
            {trx('VS Code 用系统 ssh 连接，要在 {path} 末尾写入下面这段托管配置（别名 {alias}）。只改带「灵壳 LingShell 托管」标记的这一段，你自己的条目不动。', {
              path: <code className="font-mono text-[var(--color-text-primary)]">{st.plan.configPath}</code>,
              alias: <code className="font-mono text-[var(--color-accent)]">{st.plan.alias}</code>,
            })}
          </p>
          <pre className="my-2 max-h-48 overflow-auto rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-2.5 py-2 font-mono text-[11px] leading-[1.5] text-[var(--color-text-secondary)]">{st.plan.block}</pre>
          {st.plan.note && <p className="text-[11.5px] text-[var(--color-warn)]">{st.plan.note}</p>}
        </>}
        {st.error && <p data-vscode-error className="mt-1 whitespace-pre-wrap break-all text-[12px] text-[var(--color-danger)]">{st.error}</p>}
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={() => setSt(null)} className="rounded-md border border-[var(--color-border-default)] px-4 py-1.5 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">{st.plan ? tr('取消') : tr('关闭')}</button>
          {st.plan && <button data-vscode-confirm disabled={st.busy} onClick={() => void confirm()}
            className="flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-[12px] font-medium text-[var(--color-bg-base)] hover:opacity-90 disabled:opacity-50">{st.busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{tr('写入并打开')}</button>}
        </div>
      </div>
    </div>
  ), document.body)
}
