import { useEffect, useMemo, useState } from 'react'
import { Copy, Eye, Loader2, Play, Table2 } from 'lucide-react'
import { DB_PAGE_SIZE, tk, tr, type DbConn, type DbQueryResult, type DbSchemaDetail, type DbTable, type DbTableRef } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { Input } from '../../components/ui/Input.js'
import { Select } from '../../components/ui/Select.js'
import { BTN, MUTED, errText } from '../../components/ui/drawer.js'
import { Empty, ResultGrid } from './ResultGrid.js'

type Sub = 'data' | 'columns' | 'indexes' | 'ddl'
const SUBS: [Sub, string][] = [['data', tk('数据')], ['columns', tk('字段')], ['indexes', tk('索引')], ['ddl', tk('建表语句')]]

// 数据库抽屉「结构」页签：左边当前库的表 / 视图（可筛选），右边选中表的字段、索引、建表语句（MySQL SHOW CREATE；PG 由字段 + 约束 + 索引拼出）。
// 「查前 100 行」把 SELECT 填进「查询」页签并执行
export function SchemaPanel({ conn, db, onQuery }: { conn: DbConn; db: string; onQuery: (sql: string) => void }) {
  const pg = conn.kind === 'postgres'
  const [list, setList] = useState<DbTable>()
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [pick, setPick] = useState<DbTableRef | null>(null)
  const [detail, setDetail] = useState<DbSchemaDetail>()
  const [dErr, setDErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [sub, setSub] = useState<Sub>('columns')
  const [copied, setCopied] = useState(false)
  const mongo = conn.kind === 'mongo'
  const subs: [Sub, string][] = mongo ? [['data', tk('数据')], ['columns', tk('字段（抽样）')], ['indexes', tk('索引')], ['ddl', tk('集合定义')]] : SUBS
  // 数据页：分页浏览表里的行（和「查询」页签同一套分页，只在库里取当前页）
  const [dres, setDres] = useState<DbQueryResult>()
  const [dpage, setDpage] = useState({ offset: 0, limit: DB_PAGE_SIZE })
  const [dloading, setDloading] = useState(false)
  const [dataErr, setDataErr] = useState('')
  const dataSql = (t: DbTableRef) => (mongo ? `db.getCollection(${JSON.stringify(t.name)}).find({})` : `SELECT * FROM ${pg ? `"${t.schema ?? 'public'}"."${t.name}"` : `\`${t.name}\``}`)
  const loadData = (t: DbTableRef, offset: number, limit: number) => {
    setDloading(true); setDataErr('')
    client.db.query(conn.id, dataSql(t), db || undefined, { offset, limit })
      .then((r) => { setDres(r); setDpage({ offset, limit }) }, (e) => { setDres(undefined); setDataErr(errText(e)) }).finally(() => setDloading(false))
  }
  const dkey = pick ? `${pick.schema ?? ''}.${pick.name}` : ''
  useEffect(() => {
    if (sub !== 'data' || !pick) return
    setDres(undefined)
    loadData(pick, 0, dpage.limit)
  }, [sub, dkey])
  const needDb = conn.kind === 'mysql' && !db

  useEffect(() => {
    setList(undefined); setErr(''); setPick(null); setDetail(undefined)
    if (needDb) return
    let alive = true
    client.db.schemaTables(conn.id, db).then((t) => { if (alive) setList(t) }, (e) => { if (alive) setErr(errText(e)) })
    return () => { alive = false }
  }, [conn.id, db])
  useEffect(() => {
    if (!pick) return
    let alive = true
    setDetail(undefined); setDErr(''); setLoading(true)
    client.db.schemaTable(conn.id, db, pick).then((d) => { if (alive) setDetail(d) }, (e) => { if (alive) setDErr(errText(e)) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [pick])

  const at = (n: string) => list?.columns.indexOf(n) ?? -1
  const items = useMemo(() => {
    if (!list) return []
    const s = q.trim().toLowerCase()
    return list.rows.map((r) => ({ ref: { ...(pg ? { schema: r[at('schema')] } : {}), name: r[at('name')] ?? '' } as DbTableRef, type: r[at('type')] ?? '', mb: r[at('mb')] ?? '', rows: r[at('rows_est')] ?? '', comment: r[at('comment')] ?? '' }))
      .filter((x) => !s || `${x.ref.schema ?? ''}.${x.ref.name} ${x.comment}`.toLowerCase().includes(s))
  }, [list, q])
  const label = (t: DbTableRef) => (pg && t.schema && t.schema !== 'public' ? `${t.schema}.${t.name}` : t.name)
  const qname = (t: DbTableRef) => (pg ? `"${t.schema ?? 'public'}"."${t.name}"` : `\`${t.name}\``)
  const same = (a: DbTableRef | null, b: DbTableRef) => !!a && a.name === b.name && a.schema === b.schema

  if (needDb) return <Empty text={tr('先在上方「库」里选一个库，再看它的表结构')} icon={<Table2 className="h-3.5 w-3.5 shrink-0" />} />
  return (
    <div className="flex h-full min-h-0" data-db-schema>
      <div className="flex w-[210px] shrink-0 flex-col border-r border-[var(--color-border-subtle)]">
        <div className="shrink-0 px-2 py-1.5"><Input data-db-schema-filter size="sm" className="!h-6" value={q} onChange={(e) => setQ(e.target.value)} placeholder={list ? tr('筛选 {n} 张表', { n: list.rows.length }) : tr('筛选表')} /></div>
        <div className="min-h-0 flex-1 overflow-auto pb-2">
          {err ? <div className="whitespace-pre-wrap break-all px-2 text-[11px] text-[var(--color-danger)]">{err}</div>
            : !list ? <div className={`flex items-center gap-1 px-2 text-[11px] ${MUTED}`}><Loader2 className="h-3 w-3 animate-spin" />{tr('读取表列表')}</div>
            : !items.length ? <Empty text={q.trim() ? tr('没有匹配的表') : tr('这个库里没有表')} />
            : items.map((x) => (
              <button key={`${x.ref.schema ?? ''}.${x.ref.name}`} data-db-table={label(x.ref)} onClick={() => setPick(x.ref)}
                title={[label(x.ref), x.type, x.rows && tr('约 {n} 行', { n: x.rows }), x.mb && `${x.mb} MB`, x.comment].filter(Boolean).join(' · ')}
                className={`flex w-full items-center gap-1 px-2 py-[3px] text-left text-[11.5px] ${same(pick, x.ref) ? 'bg-[var(--color-accent-bg)] text-[var(--color-accent)]' : 'text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]'}`}>
                {/view/i.test(x.type) ? <Eye className="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" /> : <Table2 className="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" />}
                <span className="min-w-0 flex-1 truncate font-mono">{label(x.ref)}</span>
                {x.mb && Number(x.mb) >= 1 && <span className={`shrink-0 text-[10px] ${MUTED}`}>{Number(x.mb) >= 1024 ? `${(Number(x.mb) / 1024).toFixed(1)}G` : `${Math.round(Number(x.mb))}M`}</span>}
              </button>
            ))}
        </div>
      </div>
      <div className="min-w-0 flex-1 overflow-auto">
        {!pick ? <Empty text={tr('在左边点一张表，看它的字段、索引和建表语句')} icon={<Table2 className="h-3.5 w-3.5 shrink-0" />} /> : (
          <div className="py-1.5">
            <div className="flex flex-wrap items-center gap-1 px-3 pb-1.5">
              <span className="mr-1 truncate font-mono text-[12px] font-semibold text-[var(--color-text-primary)]">{label(pick)}</span>
              {subs.map(([k, l]) => <button key={k} data-db-schema-sub={k} onClick={() => setSub(k)} className={`rounded px-2 py-0.5 text-[11px] ${sub === k ? 'bg-[var(--color-accent-bg)] text-[var(--color-accent)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'}`}>{tr(l)}</button>)}
              <span className="ml-auto" />
              <button data-db-schema-select onClick={() => onQuery(mongo ? `db.getCollection(${JSON.stringify(pick.name)}).find({}).limit(100)` : `SELECT * FROM ${qname(pick)} LIMIT 100`)} title={tr('在「查询」页签里查这张表的前 100 行')} className={`${BTN} text-[var(--color-accent)]`}><Play className="h-3 w-3" />{tr('查前 100 行')}</button>
            </div>
            {sub === 'data' ? (
              dataErr ? <div data-db-data-err className="whitespace-pre-wrap break-all px-3 text-[11px] text-[var(--color-danger)]">{dataErr}</div>
                : !dres ? <div className={`flex items-center gap-1 px-3 text-[11px] ${MUTED}`}><Loader2 className="h-3 w-3 animate-spin" />{tr('读取数据')}</div>
                : (
                  <div>
                    <div data-db-data-pager className="flex flex-wrap items-center gap-1.5 px-3 pb-1 text-[10.5px] text-[var(--color-text-secondary)]">
                      <button data-db-data-prev disabled={dloading || dpage.offset === 0} onClick={() => pick && loadData(pick, Math.max(0, dpage.offset - dpage.limit), dpage.limit)} className={`${BTN} text-[var(--color-text-secondary)]`}>{tr('上一页')}</button>
                      <span data-db-data-page>{tr('第 {n} 页', { n: Math.floor(dpage.offset / dpage.limit) + 1 })}</span>
                      <button data-db-data-next disabled={dloading || !dres.paged?.hasMore} onClick={() => pick && loadData(pick, dpage.offset + dpage.limit, dpage.limit)} className={`${BTN} text-[var(--color-text-secondary)]`}>{tr('下一页')}</button>
                      {dres.paged && !dres.paged.hasMore && <span className={MUTED}>{tr('· 最后一页')}</span>}
                      <span className="ml-auto" />
                      <span className={MUTED}>{tr('每页')}</span>
                      <Select size="sm" className="!h-6 w-[92px]" contentClassName="min-w-[110px]" value={String(dpage.limit)} onValueChange={(v) => { if (pick && !dloading) loadData(pick, 0, Number(v)) }}
                        options={[100, 200, 500, 1000].map((n) => ({ value: String(n), label: tr('{n} 行', { n }) }))} />
                    </div>
                    <ResultGrid key={`${dkey}-${dpage.offset}`} table={dres.table} kind={conn.kind} name={mongo ? pick.name : undefined} empty={tr('这张表没有数据')} />
                  </div>
                )
            ) : dErr ? <div className="whitespace-pre-wrap break-all px-3 text-[11px] text-[var(--color-danger)]">{dErr}</div>
              : loading || !detail ? <div className={`flex items-center gap-1 px-3 text-[11px] ${MUTED}`}><Loader2 className="h-3 w-3 animate-spin" />{tr('读取表结构')}</div>
              : sub === 'columns' ? <ResultGrid key="c" table={detail.columns} kind={conn.kind} toolbar={false} empty={tr('没有字段')} />
              : sub === 'indexes' ? <ResultGrid key="i" table={detail.indexes} kind={conn.kind} toolbar={false} empty={tr('这张表没有索引')} />
              : (
                <div className="space-y-1 px-3">
                  <button data-db-ddl-copy onClick={() => navigator.clipboard.writeText(detail.ddl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }, () => {})} className={`${BTN} text-[var(--color-text-secondary)]`}><Copy className="h-3 w-3" />{copied ? tr('已复制') : tr('复制')}</button>
                  <pre data-db-ddl className="whitespace-pre-wrap break-all rounded bg-[var(--color-bg-raised)] p-2 font-mono text-[11px] leading-[1.5] text-[var(--color-text-primary)]">{detail.ddl || tr('（没有取到建表语句）')}</pre>
                  {mongo && <div className={`text-[10.5px] ${MUTED}`}>{tr('MongoDB 没有固定表结构：「字段」是随机抽 200 条文档推断的；这里列的是建集合和索引的语句，用于查看。')}</div>}
                  {pg && <div className={`text-[10.5px] ${MUTED}`}>{tr('PostgreSQL 没有 SHOW CREATE，这是按字段、约束和索引拼出来的，用于查看；精确导出请用 pg_dump -s。')}</div>}
                </div>
              )}
          </div>
        )}
      </div>
    </div>
  )
}
