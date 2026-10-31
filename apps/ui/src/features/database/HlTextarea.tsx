import { useLayoutEffect, useMemo, useRef } from 'react'
import { highlightText, type SyntaxLang, type TokKind } from '@lingshell/shared'

const TOK_CLS: Record<TokKind, string> = {
  comment: 'text-[var(--color-text-muted)]',
  string: 'text-[var(--color-success)]',
  number: 'text-[var(--color-warn)]',
  key: 'text-[var(--color-accent)]',
  keyword: 'text-[var(--color-reasoning)]',
  section: 'text-[var(--color-warn)]',
  variable: 'text-[var(--color-user)]',
  tag: 'text-[var(--color-accent)]',
}
const LH = 18

/**
 * 带语法高亮的文本框（SQL / mongosh 脚本）：底层 pre 画彩色 token，上层 textarea 字透明只留光标和选区，
 * 输入法、撤销、选择都是原生的；两层内边距 / 字体 / 行高一致，滚动同步。右下角可拖高。
 */
export function HlTextarea({ value, onChange, lang, rows = 3, placeholder, onKeyDown, inputRef, ...rest }: {
  value: string; onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void; lang: SyntaxLang; rows?: number
  placeholder?: string; onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  inputRef?: React.Ref<HTMLTextAreaElement>
  'data-db-sql'?: true | string; 'data-db-script-src'?: true | string
}) {
  const area = useRef<HTMLTextAreaElement>(null)
  const pre = useRef<HTMLPreElement>(null)
  const tokens = useMemo(() => highlightText(value, lang), [value, lang])
  const sync = () => { const a = area.current, p = pre.current; if (a && p) { p.scrollTop = a.scrollTop; p.scrollLeft = a.scrollLeft } }
  useLayoutEffect(sync, [value])
  const setRef = (el: HTMLTextAreaElement | null) => {
    area.current = el
    if (typeof inputRef === 'function') inputRef(el)
    else if (inputRef) (inputRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el
  }
  return (
    <div className="relative rounded border border-[var(--color-border-default)] bg-[var(--color-bg-input,var(--color-bg-raised))] focus-within:border-[var(--color-accent)]">
      <pre ref={pre} aria-hidden data-db-hl className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre-wrap break-words px-2 py-2 font-mono text-[11.5px] text-[var(--color-text-primary)]" style={{ lineHeight: `${LH}px` }}>
        {tokens.map((line, i) => <div key={i}>{line.length ? line.map((t, j) => (t.kind ? <span key={j} className={TOK_CLS[t.kind]}>{t.text}</span> : t.text)) : '\n'}</div>)}
        <div className="h-4" />
      </pre>
      <textarea ref={setRef} {...rest} value={value} rows={rows} spellCheck={false} wrap="soft" placeholder={placeholder}
        onChange={onChange} onKeyDown={onKeyDown} onScroll={sync}
        className="relative block w-full resize-y bg-transparent px-2 py-2 font-mono text-[11.5px] text-transparent caret-[var(--color-text-primary)] outline-none selection:bg-[color:color-mix(in_srgb,var(--color-accent)_35%,transparent)]"
        style={{ lineHeight: `${LH}px` }} />
    </div>
  )
}
