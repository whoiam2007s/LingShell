import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { History, Loader2, MessageSquareQuote, Play, ScanSearch, Trash2 } from 'lucide-react'
import { DB_PAGE_SIZE, dateLocale, explainPrompt, guessTableName, redactSecrets, tr, type DbConn, type DbExplainResult, type DbQueryResult } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { sendToChat } from '../../lib/sendToChat.js'
import { HlTextarea } from './HlTextarea.js'
import { Select } from '../../components/ui/Select.js'
import { BTN, MUTED, PRIMARY, errText } from '../../components/ui/drawer.js'
import { ResultGrid } from './ResultGrid.js'

const HKEY = (id: string) => `lingshell:db:history:${id}`
const loadHist = (id: string): { sql: string; at: number }[] => { try { const v = JSON.parse(localStorage.getItem(HKEY(id)) ?? '[]'); return Array.isArray(v) ? v.filter((x) => x && typeof x.sql === 'string') : [] } catch { return [] } }
const fmtMs = (ms: number) => (ms < 1000 ? `${ms} ms` : tr('{n} 秒', { n: (ms / 1000).toFixed(2) }))

// 数据库抽屉「查询」页签：只读即席查询（单条 SELECT / SHOW / DESCRIBE / EXPLAIN，两道只读闸）+ EXPLAIN 执行计划（可让 AI 解读）。
// 结果在 ResultGrid 里排序 / 筛选 / 复制 / 导出。改数据请用「脚本」页签
// autoRun：别的页签带 SQL 过来时（结构页「查前 100 行」/ 慢查询「EXPLAIN 这条」）n 变化就自动执行一次
export function QueryPanel({ conn, db, version, sql, setSql, autoRun, onClose }: {
  conn: DbConn; db: string; version: string; sql: string; setSql: (s: string) => void; autoRun: { n: number; mode: 'query' | 'explain' }; onClose: () => void
}) {
  const [busy, setBusy] = useState<'' | 'query' | 'explain'>('')
  const [err, setErr] = useState('')
  const [res, setRes] = useState<DbQueryResult>()
  const [plan, setPlan] = useState<DbExplainResult>()
  // 分页：查询语句自己没写 LIMIT 时默认每页 100 行，只在数据库里取这一页（不把整张表拉回来）
  const [page, setPage] = useState({ offset: 0, limit: DB_PAGE_SIZE })
  // 执行历史（按连接存本机，最多 50 条；和上一次相同的只留一条）
  const [hist, setHist] = useState(() => loadHist(conn.id))
  const remember = (text: string) => setHist((h) => {
    const next = [{ sql: text, at: Date.now() }, ...h.filter((x) => x.sql !== text)].slice(0, 50)
    localStorage.setItem(HKEY(conn.id), JSON.stringify(next))
    return next
  })
  const [ho, setHo] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (!ho) return
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); setHo(null) } }
    const down = () => setHo(null)
    window.addEventListener('keydown', key, true); window.addEventListener('mousedown', down); window.addEventListener('scroll', down, true)
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('mousedown', down); window.removeEventListener('scroll', down, true) }
  }, [ho])
  const runSql = useRef('')   // 产生当前结果的语句：翻页用它，不用编辑区里改了还没执行的
  const fetchPage = (offset: number, limit: number) => {
    setBusy('query'); setErr('')
    client.db.query(conn.id, runSql.current, db || undefined, { offset, limit })
      .then((r) => { setRes(r); setPage({ offset, limit }) }, (e) => setErr(errText(e))).finally(() => setBusy(''))
  }
  const run = () => {
    if (!sql.trim() || busy) return
    runSql.current = sql
    remember(sql)
    setPlan(undefined)
    fetchPage(0, page.limit)
  }
  const explain = () => {
    if (!sql.trim() || busy) return
    setBusy('explain'); setErr(''); setRes(undefined)
    client.db.explain(conn.id, sql, db || undefined).then(setPlan, (e) => { setPlan(undefined); setErr(errText(e)) }).finally(() => setBusy(''))
  }
  const ran = useRef(0)   // 从 0 起：第一次打开就是被带过来的，也要执行
  useEffect(() => {
    if (autoRun.n === ran.current) return
    ran.current = autoRun.n
    if (autoRun.mode === 'explain') explain(); else run()
  }, [autoRun.n])
  const askAi = async () => {
    if (!plan) return
    const s = await client.settings.get().catch(() => undefined)
    const text = explainPrompt({ kind: conn.kind, conn: conn.name, version, sql: plan.sql, plan: plan.text })
    sendToChat(s?.system?.aiRedact === false ? text : redactSecrets(text))
    onClose()
  }
  return (
    // 上面的 SQL / 按钮固定，只有下面的结果滚动
    <div className="flex h-full min-h-0 flex-col pt-2" data-db-query>
      <div className="shrink-0 space-y-2 px-3 pb-2">
        <HlTextarea data-db-sql rows={3} value={sql} onChange={(e) => setSql(e.target.value)} lang={conn.kind === 'mongo' ? 'code' : 'sql'}
          placeholder={conn.kind === 'mongo'
            ? tr('只读查询，例如：db.orders.find({ status: "paid" }).sort({ _id: -1 }).limit(20)\n支持 find / findOne / aggregate / countDocuments / distinct / getIndexes / stats、show collections / show dbs；Ctrl+Enter 执行')
            : tr('只读查询：一次一条 SELECT / SHOW / DESCRIBE / EXPLAIN，写语句会被拒绝（改数据请用「脚本」页签）。\nCtrl+Enter 执行')}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run() } }} />
        <div className="flex flex-wrap items-center gap-1.5">
          <button data-db-run-query disabled={!sql.trim() || !!busy} onClick={run} className={PRIMARY}>{busy === 'query' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}{tr('执行')}</button>
          <button data-db-explain disabled={!sql.trim() || !!busy} onClick={explain} title={tr('只看执行计划，不真的执行（只放查询语句）')} className={`${BTN} text-[var(--color-text-secondary)]`}>{busy === 'explain' ? <Loader2 className="h-3 w-3 animate-spin" /> : <ScanSearch className="h-3 w-3" />}EXPLAIN</button>
          <button data-db-history onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHo(ho ? null : { x: r.left, y: r.bottom + 4 }) }}
            title={tr('最近执行过的语句（按连接存在本机，最多 50 条）')} className={`${BTN} text-[var(--color-text-secondary)]`}><History className="h-3 w-3" />{tr('历史')}</button>
          {plan && <button data-db-ask onClick={() => void askAi()} title={tr('把 SQL 和执行计划发到对话，让 AI 解读（按设置脱敏）')} className={`${BTN} text-[var(--color-accent)]`}><MessageSquareQuote className="h-3 w-3" />{tr('让 AI 解读')}</button>}
          <span className={`text-[10.5px] ${MUTED}`}>{tr('Ctrl+Enter 执行')}{db ? tr(' · 库 {v}', { v: db }) : ''}</span>
          {/* 分页和执行按钮同一行，靠右 */}
          {res?.paged && (
            <div data-db-pager className="ml-auto flex items-center gap-1.5 text-[10.5px] text-[var(--color-text-secondary)]">
              <button data-db-prev disabled={!!busy || page.offset === 0} onClick={() => fetchPage(Math.max(0, page.offset - page.limit), page.limit)} className={`${BTN} text-[var(--color-text-secondary)]`}>{tr('上一页')}</button>
              <span data-db-page>{tr('第 {n} 页', { n: Math.floor(page.offset / page.limit) + 1 })}</span>
              <button data-db-next disabled={!!busy || !res.paged.hasMore} onClick={() => fetchPage(page.offset + page.limit, page.limit)} className={`${BTN} text-[var(--color-text-secondary)]`}>{tr('下一页')}</button>
              {!res.paged.hasMore && <span className={MUTED}>{tr('· 最后一页')}</span>}
              <span className={MUTED}>{tr('每页')}</span>
              <Select size="sm" className="!h-6 w-[92px]" contentClassName="min-w-[110px]" value={String(page.limit)} onValueChange={(v) => { if (runSql.current && !busy) fetchPage(0, Number(v)) }}
                options={[100, 200, 500, 1000].map((n) => ({ value: String(n), label: tr('{n} 行', { n }) }))} />
            </div>
          )}
        </div>
        {res && !res.paged && <div data-db-nopage className={`text-[10.5px] ${MUTED}`}>{tr('这条没分页：语句里自己写了 LIMIT / OFFSET，或这类语句不分页，按原样返回。')}</div>}
        {err && <div data-db-err className="whitespace-pre-wrap break-all text-[11px] text-[var(--color-danger)]">{err}</div>}
      </div>
      {res && <div className="min-h-0 flex-1"><ResultGrid fill key={`${res.sql}-${page.offset}`} table={res.table} kind={conn.kind} name={guessTableName(res.sql)}
        extra={<span className={`text-[10.5px] ${MUTED}`}>{tr('· 用时 {ms}', { ms: fmtMs(res.ms) })}{res.paged ? tr(' · 本页 {n} 行', { n: res.table.rows.length }) : ''}</span>} empty={page.offset > 0 ? tr('这一页没有数据（已经到末尾）') : tr('查询成功，没有返回任何行')} /></div>}
      {ho && createPortal(
        <div data-db-historymenu onMouseDown={(e) => e.stopPropagation()} style={{ left: Math.min(ho.x, window.innerWidth - 420), top: Math.min(ho.y, window.innerHeight - 340) }}
          className="fixed z-[95] w-[400px] rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-1 shadow-lg">
          <div className={`flex items-center gap-2 px-2 py-1 text-[10.5px] ${MUTED}`}>{tr('最近执行')}
            <span className="ml-auto" />
            {hist.length > 0 && <button data-db-history-clear onClick={() => { localStorage.removeItem(HKEY(conn.id)); setHist([]) }} className="flex items-center gap-0.5 rounded px-1 hover:text-[var(--color-danger)]"><Trash2 className="h-3 w-3" />{tr('清空')}</button>}
          </div>
          <div className="max-h-[280px] overflow-auto">
            {hist.length ? hist.map((h, i) => (
              <button key={i} data-db-history-item onClick={() => { setSql(h.sql); setHo(null) }} title={h.sql}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]">
                <span className="min-w-0 flex-1 truncate font-mono">{h.sql.replace(/\s+/g, ' ')}</span>
                <span className={`shrink-0 text-[10px] ${MUTED}`}>{new Date(h.at).toLocaleString(dateLocale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
              </button>
            )) : <div className={`px-2 py-2 text-[11px] ${MUTED}`}>{tr('还没有执行过语句')}</div>}
          </div>
        </div>, document.body)}
      {plan && <div className="min-h-0 flex-1 overflow-auto pb-2">{conn.kind !== 'mysql'
        ? <pre data-db-plan className="mx-3 whitespace-pre-wrap break-all rounded bg-[var(--color-bg-raised)] p-2 font-mono text-[11px] leading-[1.5] text-[var(--color-text-primary)]">{plan.text}</pre>
        : <div data-db-plan><ResultGrid table={plan.table} kind={conn.kind} toolbar={false} /></div>}</div>}
    </div>
  )
}
