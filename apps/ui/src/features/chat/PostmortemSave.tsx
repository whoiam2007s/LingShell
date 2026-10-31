import { useState } from 'react'
import { FileDown, ClipboardCheck } from 'lucide-react'
import { postmortemFileName, postmortemMarkdown, tr } from '@lingshell/shared'
import { client } from '../../client/index.js'

// 「生成复盘」那一轮的 AI 回复下方：保存为 Markdown 文件（复用导出会话的保存对话框），默认文件名 复盘-<会话标题>-<日期>.md
export function PostmortemSaveBar({ text, title }: { text: string; title: string }) {
  const [note, setNote] = useState('')
  const save = () => {
    client.system.saveTextFile(postmortemFileName(title), postmortemMarkdown(text))
      .then((p) => { if (p) setNote(tr('已保存到 {path}', { path: p })) })
      .catch((e: unknown) => setNote(tr('保存失败：{error}', { error: String((e as Error)?.message ?? e) })))
  }
  return (
    <div data-postmortem-save className="mx-3 mb-1 mt-1.5 flex min-w-0 items-center gap-2 rounded-md border border-[color:color-mix(in_srgb,var(--color-accent)_35%,transparent)] bg-[color:color-mix(in_srgb,var(--color-accent)_6%,transparent)] px-2 py-1 text-[11.5px] text-[var(--color-text-secondary)]">
      <ClipboardCheck className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
      <span className="shrink-0">{tr('故障复盘报告')}</span>
      <button onClick={save} title={tr('保存为 Markdown 文件')}
        className="flex shrink-0 items-center gap-1 rounded border border-[var(--color-border-default)] px-1.5 py-0.5 text-[11px] text-[var(--color-accent)] transition-colors hover:bg-[var(--color-bg-hover)]">
        <FileDown className="h-3 w-3" />{tr('保存为文件')}
      </button>
      {note && <span data-postmortem-note className="min-w-0 truncate text-[10.5px] text-[var(--color-text-muted)]" title={note}>{note}</span>}
    </div>
  )
}
