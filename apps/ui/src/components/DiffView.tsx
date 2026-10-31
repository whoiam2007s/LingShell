import { tr } from '@lingshell/shared'
import { cn } from '../lib/cn.js'

// 文件改动展示：把 unified diff 渲染成「行号 + 底色」的对比视图，不熟悉 diff 的人也看得懂。
// 原始格式里删除行是 "-原文"，原文以 > / - 开头时会叠成 "->"、"--" 这种难认的样子，所以前缀不再直接显示。

type Row =
  | { kind: 'ctx' | 'add' | 'del'; oldNo?: number; newNo?: number; text: string }
  | { kind: 'hunk'; text: string }
  | { kind: 'note'; text: string }

export function parseUnifiedDiff(diff: string): { rows: Row[]; added: number; removed: number } {
  const rows: Row[] = []
  let oldNo = 0, newNo = 0, added = 0, removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (h) {
      oldNo = Number(h[1]); newNo = Number(h[2])
      rows.push({ kind: 'hunk', text: tr('第 {n} 行附近', { n: newNo || oldNo }) })
    } else if (line.startsWith('+')) { rows.push({ kind: 'add', newNo: newNo++, text: line.slice(1) }); added++ }
    else if (line.startsWith('-')) { rows.push({ kind: 'del', oldNo: oldNo++, text: line.slice(1) }); removed++ }
    else if (line.startsWith(' ')) rows.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) })
    else if (line.startsWith('\\')) rows.push({ kind: 'note', text: tr('（文件末尾换行有变化）') })
    else if (line.trim()) rows.push({ kind: 'note', text: line })   // 截断提示 / 「内容无变化」等
  }
  return { rows, added, removed }
}

export function DiffView({ diff, maxHeight = 'max-h-72', legend }: { diff: string; maxHeight?: string; legend?: string }) {
  const { rows, added, removed } = parseUnifiedDiff(diff)
  return (
    <div className="mt-1 overflow-hidden rounded border border-[var(--color-border-subtle)]">
      <div className="flex items-center gap-3 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-raised)] px-2 py-1 text-[11px]">
        <span className="text-[var(--color-success)]">{tr('新增 {n} 行', { n: added })}</span>
        <span className="text-[var(--color-danger)]">{tr('删除 {n} 行', { n: removed })}</span>
        <span className="ml-auto text-[var(--color-text-muted)]">{legend ?? tr('绿色＝改后新增，红色＝原文删除')}</span>
      </div>
      <div className={cn(maxHeight, 'overflow-auto bg-[var(--color-bg-base)] font-mono text-[11px] leading-relaxed')}>
        {rows.map((r, i) => {
          if (r.kind === 'hunk') return <div key={i} className="bg-[var(--color-bg-raised)] px-2 py-0.5 text-[10px] text-[var(--color-text-muted)]">{r.text}</div>
          if (r.kind === 'note') return <div key={i} className="px-2 py-0.5 text-[10px] italic text-[var(--color-text-muted)]">{r.text}</div>
          return (
            <div key={i} className={cn('flex',
              r.kind === 'add' && 'bg-[color:color-mix(in_srgb,var(--color-success)_15%,transparent)]', r.kind === 'del' && 'bg-[color:color-mix(in_srgb,var(--color-danger)_15%,transparent)]')}>
              <span className="w-9 shrink-0 select-none pr-1 text-right text-[color:color-mix(in_srgb,var(--color-text-muted)_70%,transparent)]">{r.oldNo ?? ''}</span>
              <span className="w-9 shrink-0 select-none pr-1 text-right text-[color:color-mix(in_srgb,var(--color-text-muted)_70%,transparent)]">{r.newNo ?? ''}</span>
              <span className={cn('w-4 shrink-0 select-none text-center',
                r.kind === 'add' ? 'text-[var(--color-success)]' : r.kind === 'del' ? 'text-[var(--color-danger)]' : 'text-transparent')}>
                {r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ''}
              </span>
              <span className={cn('min-w-0 flex-1 whitespace-pre-wrap break-all pr-2',
                r.kind === 'add' ? 'text-[var(--color-text-primary)]' : r.kind === 'del' ? 'text-[var(--color-text-secondary)] line-through decoration-[color:color-mix(in_srgb,var(--color-danger)_50%,transparent)]' : 'text-[var(--color-text-muted)]')}>
                {r.text || ' '}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
