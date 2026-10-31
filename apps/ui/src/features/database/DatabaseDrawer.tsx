import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Database, Pencil, Play, Plus, Trash2, XCircle } from 'lucide-react'
import {
  DB_KIND_LABEL, DB_LONG_SEC, DB_VIEWS, dbKillSql, tr,
  type DbConn, type DbDatabase, type DbTable, type DbView, type DbViewResult, type HostSummary, type SlowDigest,
} from '@lingshell/shared'
import { client } from '../../client/index.js'
import { Select } from '../../components/ui/Select.js'
import { Checkbox } from '../../components/ui/Checkbox.js'
import { ConfirmDialog } from '../common/index.js'
import { HelpTip } from '../../components/ui/form.js'
import { BTN, DANGER_BOX, DrawerHeader, IB, MUTED, PRIMARY, errText } from '../../components/ui/drawer.js'
import { DbConnForm } from './DbConnForm.js'
import { ScriptPanel } from './ScriptPanel.js'
import { BackupPanel } from './BackupPanel.js'
import { QueryPanel } from './QueryPanel.js'
import { SchemaPanel } from './SchemaPanel.js'
import { RedisKeysPanel } from './RedisKeysPanel.js'
import { Empty, ResultGrid, TD, TH } from './ResultGrid.js'

type Tab = DbView | 'query' | 'schema' | 'keys' | 'script' | 'backup'
const LAST = 'lingshell:db:last'
const PICK = (id: string) => `lingshell:db:pick:${id}`   // 每个连接上次切到的库
const DRAFT = (id: string) => `lingshell:db:script:${id}`
// 这几个页签切走后保留内容（查询结果、选中的表 / key），第一次打开才挂载
const KEEP: Tab[] = ['query', 'schema', 'keys']
const Cell = ({ v, cls = '', w = 'max-w-[260px]' }: { v: string; cls?: string; w?: string }) => <td title={v} className={`${TD} ${cls}`}><div className={`${w} truncate`}>{v}</div></td>
const WARN_ROW = 'bg-[color:color-mix(in_srgb,var(--color-warn)_12%,transparent)]'
const LOCK_ROW = 'bg-[color:color-mix(in_srgb,var(--color-danger)_10%,transparent)]'
const newConn = (hostKey: string): DbConn => ({ id: `db-${Date.now().toString(36)}`, name: '', hostKey, kind: 'mysql', via: 'client' })
const killWordOf = (k: DbConn['kind']) => (k === 'redis' ? tr('断开客户端') : k === 'mongo' ? tr('终止操作') : tr('终止会话'))
const viaText = (c: DbConn) => (c.via === 'docker' ? tr('容器 {name}', { name: String(c.container) }) : tr('本机客户端'))

// 会话表：哪列是会话 id / 耗时 / 是否空闲 / 是否在等锁（MySQL processlist、PG pg_stat_activity、Redis CLIENT LIST 的列名不同）
function sessionMeta(kind: DbConn['kind'], cols: string[]) {
  const at = (n: string) => cols.indexOf(n)
  if (kind === 'redis') return { id: at('id'), sec: -1, idle: () => false, lock: (r: string[]) => /b/.test(r[at('flags')] ?? '') }
  // MongoDB currentOp（只列 active 的）
  if (kind === 'mongo') return { id: at('opid'), sec: at('secs'), idle: () => false, lock: (r: string[]) => r[at('waitingForLock')] === 'true' }
  return kind === 'mysql'
    // 复制线程（Binlog Dump）/ 后台线程（Daemon）常年在线，按空闲算，不标长耗时
    ? { id: at('ID'), sec: at('TIME'), idle: (r: string[]) => /^(Sleep|Daemon|Binlog Dump( GTID)?)$/.test(r[at('COMMAND')] ?? ''), lock: (r: string[]) => /lock/i.test(r[at('STATE')] ?? '') }
    : { id: at('pid'), sec: at('query_sec'), idle: (r: string[]) => /^idle$/.test(r[at('state')] ?? ''), lock: (r: string[]) => r[at('wait_type')] === 'Lock' }
}

// 数据库快查（右侧活动栏「更多视图」→「数据库」/ 命令面板「数据库快查」）：在主机上调用 mysql / psql / redis-cli（或 docker exec 进容器）查看。
// 查询走独立通道不在终端刷屏；密码只能选密钥保险箱里的项。默认只读；会改数据的只有「终止会话 / 断开客户端 / 终止操作」「删除 key」和「脚本」页签的执行：确认（生产主机再确认一次）+ 执行记录
export function DatabaseDrawer({ hostKey, onClose }: { hostKey: string; onClose: () => void }) {
  const [conns, setConns] = useState<DbConn[]>()
  const [hosts, setHosts] = useState<HostSummary[]>([])
  const [sel, setSel] = useState('')
  const [editing, setEditing] = useState<DbConn | null>(null)
  const [tab, setTab] = useState<Tab>('query')
  const [visited, setVisited] = useState<Tab[]>([])
  const [res, setRes] = useState<DbViewResult>()
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [version, setVersion] = useState('')
  const [limit, setLimit] = useState(20)
  const [hideIdle, setHideIdle] = useState(true)
  const [flash, setFlash] = useState('')
  const [kill, setKill] = useState<{ id: number; about: string; step: 1 | 2 } | null>(null)
  const [delAsk, setDelAsk] = useState(false)
  const [sql, setSql] = useState('')
  const [autoRun, setAutoRun] = useState<{ n: number; mode: 'query' | 'explain' }>({ n: 0, mode: 'query' })
  const [openDigest, setOpenDigest] = useState<number | null>(null)
  const [dbs, setDbs] = useState<DbDatabase[]>([])
  const [db, setDb] = useState('')

  useEffect(() => {
    client.hosts.list().then(setHosts).catch(() => {})
    client.db.list().then((l) => {
      setConns(l)
      const last = localStorage.getItem(LAST)
      setSel((l.find((c) => c.id === last && c.hostKey === hostKey) ?? l.find((c) => c.hostKey === hostKey) ?? l.find((c) => c.id === last) ?? l[0])?.id ?? '')
    }).catch((e) => { setConns([]); setErr(errText(e)) })
  }, [hostKey])
  const conn = conns?.find((c) => c.id === sel)
  const hostOf = (hk: string) => (hk === 'local' ? undefined : hosts.find((h) => h.id === hk))
  const hostLabel = (hk: string) => (hk === 'local' ? tr('host|本机') : hostOf(hk)?.label ?? tr('（主机已删除）'))
  const prod = !!conn && hostOf(conn.hostKey)?.env === 'prod'
  const ver = version.replace(/^PostgreSQL\s+/, '').split(/\s+on\s+|,|\s\(/)[0]   // PG 的 version() 很长，只留版本号
  const note = (t: string) => { setFlash(t); setTimeout(() => setFlash((x) => (x === t ? '' : x)), 2500) }
  // 当前用的库：手动切过的 > 连接里配的（Redis 没配就是 0 号库）
  const curDb = db || conn?.database || (conn?.kind === 'redis' ? '0' : conn?.kind === 'mongo' ? 'test' : '')

  // 切连接 / 改了连接：回到该类型的第一个页签，查版本、库列表，恢复上次切到的库
  const connKey = conn ? JSON.stringify(conn) : ''
  useEffect(() => {
    if (!conn) return
    localStorage.setItem(LAST, conn.id)
    setTab(conn.kind === 'redis' ? DB_VIEWS.redis[0].id : 'query');   // MySQL / PG / MongoDB 默认打开「查询」
    setVisited([]); setAutoRun({ n: 0, mode: 'query' }); setVersion(''); setDbs([]); setDb(localStorage.getItem(PICK(conn.id)) ?? '')
    client.db.ping(conn).then(setVersion, () => setVersion(''))
    client.db.databases(conn.id).then(setDbs, () => setDbs([]))
  }, [connKey])
  // 也看 visited：换连接时 visited 清空但 tab 可能没变（一直是「查询」），只看 tab 就不会再挂载，页签是空的
  useEffect(() => { if (KEEP.includes(tab) && !visited.includes(tab)) setVisited((v) => [...v, tab]) }, [tab, visited])
  const pickDb = (v: string) => {
    if (!conn) return
    setDb(v)
    if (v && v !== conn.database) localStorage.setItem(PICK(conn.id), v); else localStorage.removeItem(PICK(conn.id))
  }

  const seq = useRef(0)
  const load = useCallback((force = false) => {
    // 只查当前连接类型有的视图（切连接的那一刻 tab 还是上个连接的，不发无效查询）
    if (!conn || !DB_VIEWS[conn.kind].some((v) => v.id === tab) || (tab === 'bigkeys' && !force)) return
    const my = ++seq.current
    setLoading(true); setErr('')
    client.db.view(conn.id, tab as DbView, { limit, db: db || undefined }).then((r) => { if (my === seq.current) setRes(r) }, (e) => { if (my === seq.current) { setRes(undefined); setErr(errText(e)) } })
      .finally(() => { if (my === seq.current) setLoading(false) })
  }, [conn, tab, limit, db])
  useEffect(() => { seq.current++; setLoading(false); setRes(undefined); setErr(''); setOpenDigest(null); load() }, [load])

  const doKill = async (confirmedProd: boolean) => {
    if (!conn || !kill) return
    const k = kill
    setKill(null)
    try { await client.db.kill(conn.id, k.id, k.about, confirmedProd); note(tr('已{action} {id}（已记入执行记录）', { action: killWordOf(conn.kind), id: k.id })); load() }
    catch (e) { setErr(tr('{action} {id} 失败：{err}', { action: killWordOf(conn.kind), id: k.id, err: errText(e) })) }
  }
  const explainThis = (d: SlowDigest) => { setSql(d.example); setTab('query'); setAutoRun((a) => ({ n: a.n + 1, mode: 'explain' })) }
  const queryThis = (s: string) => { setSql(s); setTab('query'); setAutoRun((a) => ({ n: a.n + 1, mode: 'query' })) }
  const isView = !!conn && DB_VIEWS[conn.kind].some((v) => v.id === tab)

  const header = (
    <DrawerHeader icon={<Database className="h-3.5 w-3.5" />} title={tr('数据库')} loading={loading}
      // 大 key 扫描有压力：刷新 = 回到提示页，再点「开始扫描」
      // 大 key 刷新 = 回到提示页；把正在跑的那次扫描作废（否则它跑完会把结果又塞回来）
      onRefresh={conn && !editing && isView ? () => (tab === 'bigkeys' ? (seq.current++, setLoading(false), setErr(''), setRes(undefined)) : load(true)) : undefined} onClose={onClose}
      extra={<HelpTip>{tr('在主机上调用已有的 mysql / psql / redis-cli / mongosh（或 docker exec 进容器）查看：会话、锁等待、慢查询归并、表大小、复制状态；「查询」页签执行只读 SQL（单条 SELECT / SHOW / DESCRIBE）和 EXPLAIN，结果可筛选、复制、导出；「结构」页签看表的字段、索引、建表语句；上方「库」可切换当前库。Redis 有概况 / 客户端 / Key 浏览 / 慢日志 / 大 key / 内存。MongoDB 的「查询」写 db.集合.find(...) 等只读语句，另有概况 / 当前操作 / 慢查询（profiler）/ 集合大小 / 复制 / 结构。查询走单独通道，不在终端里刷屏；密码只能选密钥保险箱里的项。会改动数据库的只有「终止会话 / 断开客户端」「删除 key」和「脚本」页签的执行，都要确认并记入执行记录。「备份」页签在数据库所在机器上后台导出，可定时、下载、删除。')}</HelpTip>} />
  )
  if (!conns) return <div className="flex h-full flex-col">{header}<div className={`px-3 py-3 text-[12px] ${MUTED}`}>{tr('读取中…')}</div></div>
  if (editing) {
    return (
      <div className="flex h-full flex-col" data-db-drawer>{header}
        <div className="min-h-0 flex-1 overflow-auto">
          <DbConnForm key={editing.id} init={editing} hosts={hosts} onCancel={() => setEditing(null)}
            onSaved={(l, id) => { setConns(l); setSel(id); setEditing(null); note(tr('连接已保存')) }} />
        </div>
      </div>
    )
  }
  if (!conns.length || !conn) {
    return (
      <div className="flex h-full flex-col" data-db-drawer>{header}
        <div data-db-empty-conns className="flex flex-col items-center gap-2 px-6 py-10 text-center">
          <Database className="h-8 w-8 text-[var(--color-text-muted)]" />
          <div className="text-[12.5px] font-medium text-[var(--color-text-primary)]">{tr('还没有数据库连接')}</div>
          <div className={`max-w-[360px] text-[11.5px] ${MUTED}`}>{tr('选一台主机、类型（MySQL / PostgreSQL / Redis）和连接方式（本机客户端或 Docker 容器），密码从密钥保险箱里选。之后就能看会话、慢查询、表结构，执行只读查询。')}</div>
          <button data-db-new onClick={() => setEditing(newConn(hostKey))} className={PRIMARY}><Plus className="h-3 w-3" />{tr('新建连接')}</button>
        </div>
      </div>
    )
  }

  const sqlKind = conn.kind !== 'redis'   // 有「查询」「结构」页签（MySQL / PG / MongoDB）
  const base = DB_VIEWS[conn.kind]
  const views: { id: Tab; label: string }[] = sqlKind
    ? [{ id: 'query', label: tr('查询') }, ...base.map((v) => ({ ...v, label: tr(v.label) })), { id: 'schema', label: tr('结构') }, { id: 'script', label: tr('脚本') }, { id: 'backup', label: tr('备份') }]
    : [...base.slice(0, 2).map((v) => ({ ...v, label: tr(v.label) })), { id: 'keys', label: 'Key' }, ...base.slice(2).map((v) => ({ ...v, label: tr(v.label) })), { id: 'script', label: tr('脚本') }, { id: 'backup', label: tr('备份') }]
  const connOpts = conns.map((c) => ({ value: c.id, label: `${c.name} · ${DB_KIND_LABEL[c.kind]} · ${hostLabel(c.hostKey)}` }))
  const dbOpts = [
    ...(!curDb ? [{ value: '', label: tr('未选库') }] : []),
    ...(curDb && !dbs.some((x) => x.name === curDb) ? [{ value: curDb, label: sqlKind ? curDb : `db${curDb}` }] : []),
    ...dbs.map((x) => ({ value: x.name, label: sqlKind ? x.name : `db${x.name}${x.keys ? tr(' · {n} 个 key', { n: x.keys }) : ''}` })),
  ]
  const killWord = killWordOf(conn.kind)
  return (
    <div className="flex h-full flex-col" data-db-drawer>
      {header}
      <div className="shrink-0 space-y-1 border-b border-[var(--color-border-subtle)] px-3 py-1.5">
        <div className="flex items-center gap-1">
          <Select size="sm" className="min-w-0 flex-1" value={conn.id} onValueChange={setSel} options={connOpts} />
          {dbs.length > 0 && <span data-db-pick className="w-[150px] shrink-0"><Select size="sm" className="w-full" title={tr('切换当前库：查询、结构、表大小、备份都用这个库')} value={curDb} onValueChange={pickDb} options={dbOpts} /></span>}
          <button title={tr('编辑连接')} onClick={() => setEditing(conn)} className={IB}><Pencil className="h-3.5 w-3.5" /></button>
          <button data-db-new title={tr('新建连接')} onClick={() => setEditing(newConn(hostKey))} className={IB}><Plus className="h-3.5 w-3.5" /></button>
          <button data-db-del title={tr('删除连接')} onClick={() => setDelAsk(true)} className={`${IB} hover:!text-[var(--color-danger)]`}><Trash2 className="h-3.5 w-3.5" /></button>
        </div>
        <div data-db-meta className={`flex flex-wrap items-center gap-x-2 text-[10.5px] ${MUTED}`}>
          <span>{DB_KIND_LABEL[conn.kind]}{ver ? ` ${ver}` : ''}</span>
          <span>{tr('主机：{host}', { host: hostLabel(conn.hostKey) })}{prod && <span className="ml-1 font-medium text-[var(--color-danger)]">{tr('生产')}</span>}</span>
          <span>{viaText(conn)}{conn.host ? ` → ${conn.host}${conn.port ? `:${conn.port}` : ''}` : ''}</span>
          {conn.user && <span>{tr('用户 {user}', { user: conn.user })}</span>}
          {conn.secret && <span title={tr('密码取自密钥保险箱「{name}」', { name: conn.secret })}>{tr('已配密码')}</span>}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--color-border-subtle)] px-3 py-1">
        {views.map((v) => (
          <button key={v.id} data-db-tab={v.id} onClick={() => setTab(v.id)}
            className={`rounded px-2 py-0.5 text-[11px] ${v.id === tab ? 'bg-[var(--color-accent-bg)] text-[var(--color-accent)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'}`}>{v.label}</button>
        ))}
        <span className="ml-auto" />
        {tab === 'sessions' && conn.kind !== 'mongo' && <label className="flex items-center gap-1 text-[11px] text-[var(--color-text-secondary)]"><Checkbox checked={hideIdle} onCheckedChange={setHideIdle} />{tr('隐藏空闲')}</label>}
        {tab === 'tables' && <Select size="sm" className="!h-6 w-[96px]" value={String(limit)} onValueChange={(v) => setLimit(Number(v))} options={[20, 50, 100, 200].map((n) => ({ value: String(n), label: tr('前 {n} 张', { n }) }))} />}
      </div>
      {err && isView && <div data-db-err className="shrink-0 whitespace-pre-wrap break-all border-b border-[var(--color-border-subtle)] px-3 py-1.5 text-[11px] text-[var(--color-danger)]">{err}</div>}
      {flash && <div className="shrink-0 border-b border-[var(--color-border-subtle)] px-3 py-1 text-[11px] text-[var(--color-success)]">{flash}</div>}
      <div className="min-h-0 flex-1 overflow-auto" data-db-body={tab}>
        {visited.includes('query') && sqlKind && <div className={tab === 'query' ? 'h-full' : 'hidden'}><QueryPanel key={conn.id} conn={conn} db={db} version={ver} sql={sql} setSql={setSql} autoRun={autoRun} onClose={onClose} /></div>}
        {visited.includes('schema') && sqlKind && <div className={tab === 'schema' ? 'h-full' : 'hidden'}><SchemaPanel key={conn.id} conn={conn} db={curDb} onQuery={queryThis} /></div>}
        {visited.includes('keys') && !sqlKind && <div className={tab === 'keys' ? 'h-full' : 'hidden'}><RedisKeysPanel key={conn.id} conn={conn} db={db} prod={prod} /></div>}
        {tab === 'backup' ? (
          <BackupPanel key={`${conn.id}:${curDb}`} conn={{ ...conn, database: curDb || undefined }} prod={prod} />
        ) : tab === 'script' ? (
          <ScriptPanel key={conn.id} conn={conn} db={db} prod={prod} version={ver} onClose={onClose} />
        ) : !isView ? null : tab === 'bigkeys' && !res && !loading ? (
          <div className="space-y-2 px-3 py-3 text-[12px] text-[var(--color-text-secondary)]">
            <div className="flex items-start gap-1.5 text-[var(--color-warn)]"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{tr('大 key 扫描（redis-cli --bigkeys）会 SCAN 整个库并对每个 key 取大小，key 多时耗时较长、对线上实例有额外压力（已加 -i 0.01 间隔）。建议在低峰期或从库上做。')}</div>
            <button data-db-bigkeys onClick={() => load(true)} className={PRIMARY}><Play className="h-3 w-3" />{tr('开始扫描')}</button>
          </div>
        ) : !res ? (
          <div className={`px-3 py-3 text-[12px] ${MUTED}`}>{loading ? tr('读取中…') : ''}</div>
        ) : (
          <ViewResult res={res} kind={conn.kind} tab={tab} hideIdle={hideIdle} openDigest={openDigest} setOpenDigest={setOpenDigest}
            onKill={(id, about) => setKill({ id, about, step: 1 })} onExplain={explainThis} />
        )}
      </div>
      <ConfirmDialog open={!!kill && kill.step === 1} title={prod ? tr('生产主机：{action} {id}', { action: killWord, id: kill?.id ?? '' }) : `${killWord} ${kill?.id ?? ''}`} confirmText={prod ? tr('下一步') : killWord}
        message={conn.kind === 'redis' ? tr('这是写操作：会断开「{name}」上的这个客户端连接（应用一般会自动重连）。操作会记入执行记录。', { name: conn.name }) : conn.kind === 'mongo' ? tr('这是写操作：会终止「{name}」上的这个操作（killOp），正在执行的读写会被中断。操作会记入执行记录。', { name: conn.name }) : tr('这是写操作：会断开「{name}」上的这个会话，它正在执行的语句会被中断（事务回滚）。操作会记入执行记录。', { name: conn.name })}
        onCancel={() => setKill(null)} onConfirm={() => { if (prod) setKill((k) => k && { ...k, step: 2 }); else void doKill(false) }}>
        {kill && (
          <div className="space-y-2">
            <div className="rounded bg-[var(--color-bg-raised)] p-2 font-mono text-[11.5px] text-[var(--color-text-primary)]">{dbKillSql(conn.kind, kill.id)}</div>
            {kill.about && <div className="break-all text-[11px] text-[var(--color-text-muted)]">{kill.about}</div>}
          </div>
        )}
      </ConfirmDialog>
      <ConfirmDialog open={!!kill && kill.step === 2} title={tr('生产主机二次确认')} confirmText={tr('确认{action} {id}', { action: killWord, id: kill?.id ?? '' })}
        message={tr('「{host}」是生产主机。再次确认要{action}（数据库「{name}」上的 {id}）？', { host: hostLabel(conn.hostKey), action: killWord, name: conn.name, id: kill?.id ?? '' })}
        onCancel={() => setKill(null)} onConfirm={() => void doKill(true)}>
        <div className={`flex items-center gap-1.5 ${DANGER_BOX}`}><AlertTriangle className="h-3.5 w-3.5 shrink-0" />{tr('生产环境：确认这个连接不是关键业务连接，必要时先和应用负责人沟通。')}</div>
      </ConfirmDialog>
      <ConfirmDialog open={delAsk} title={tr('删除连接')} message={tr('删除连接「{name}」？会一并删除它的定时备份计划和脚本草稿；不影响数据库、已有的备份文件和密钥保险箱。', { name: conn.name })}
        onCancel={() => setDelAsk(false)} onConfirm={() => {
          setDelAsk(false)
          const id = conn.id
          client.db.delete(id).then((l) => { localStorage.removeItem(DRAFT(id)); localStorage.removeItem(PICK(id)); setConns(l); setSel(l[0]?.id ?? '') }, (e) => setErr(errText(e)))
        }} />
    </div>
  )
}

function ViewResult({ res, kind, tab, hideIdle, openDigest, setOpenDigest, onKill, onExplain }: {
  res: DbViewResult; kind: DbConn['kind']; tab: Tab; hideIdle: boolean
  openDigest: number | null; setOpenDigest: (i: number | null) => void
  onKill: (id: number, about: string) => void; onExplain: (d: SlowDigest) => void
}) {
  const [raw, setRaw] = useState(false)
  return (
    <div className="pb-2">
      {res.note && <div data-db-note className="whitespace-pre-wrap break-all border-b border-[var(--color-border-subtle)] px-3 py-1.5 text-[11.5px] text-[var(--color-warn)]">{tr(res.note)}</div>}
      {res.source && <div className={`px-3 pt-1.5 text-[10.5px] ${MUTED}`}>{tr('来源：{src}', { src: res.source })}</div>}
      {res.kv?.map((s) => (
        <div key={s.title} className="px-3 pt-2">
          <div className="mb-1 text-[11px] font-semibold text-[var(--color-text-primary)]">{tr(s.title)}</div>
          <div className="grid grid-cols-[minmax(120px,auto)_1fr] gap-x-3 gap-y-0.5 text-[11px]">
            {s.items.map(([k, v], i) => <Fragment key={i}><span className="font-mono text-[var(--color-text-muted)]">{k}</span><span data-db-kv={k} className="break-all font-mono text-[var(--color-text-primary)]">{v}</span></Fragment>)}
          </div>
        </div>
      ))}
      {res.digests && (res.digests.length ? <DigestTable ds={res.digests} open={openDigest} setOpen={setOpenDigest} onExplain={kind === 'redis' ? undefined : onExplain} />
        : <Empty text={tr('没有慢查询记录')} />)}
      {res.tables?.map((t, i) => (
        <div key={`${tab}-${i}`} className="pt-1">
          {t.title && <div className={`px-3 py-1 text-[11px] ${MUTED}`}>{tr(t.title)}</div>}
          {tab === 'sessions' || tab === 'clients'
            ? <SessionGrid table={t.table} kind={kind} hideIdle={hideIdle && tab === 'sessions'} onKill={onKill} />
            : <ResultGrid table={t.table} kind={kind} toolbar={t.table.rows.length > 5} />}
        </div>
      ))}
      {/* 概况 / 大 key 的原始输出默认收起（大 key 的表格已经够看，原文只在需要时展开） */}
      {res.text !== undefined && (tab === 'info' || tab === 'bigkeys' ? (
        <div className="px-3 pt-2"><button data-db-raw onClick={() => setRaw((r) => !r)} className={`${BTN} text-[var(--color-text-secondary)]`}>{raw ? tr('收起原始输出') : tr('原始输出')}</button></div>
      ) : null)}
      {res.text !== undefined && (tab !== 'info' && tab !== 'bigkeys' || raw) && <pre data-db-text className="mx-3 mt-2 whitespace-pre-wrap break-all rounded bg-[var(--color-bg-raised)] p-2 font-mono text-[10.5px] leading-[1.5] text-[var(--color-text-secondary)]">{res.text || tr('（没有输出）')}</pre>}
    </div>
  )
}

// 会话 / 客户端表：「终止」放每行最前（列多时不用横向滚动也能看到）；长耗时标黄、等锁标红；筛选 / 排序 / 复制在 ResultGrid 里
function SessionGrid({ table, kind, hideIdle, onKill }: { table: DbTable; kind: DbConn['kind']; hideIdle: boolean; onKill: (id: number, about: string) => void }) {
  const m = sessionMeta(kind, table.columns)
  const shown = useMemo(() => (hideIdle ? { ...table, rows: table.rows.filter((r) => !m.idle(r)) } : table), [table, hideIdle])
  const long = shown.rows.filter((r) => !m.idle(r) && Number(r[m.sec]) >= DB_LONG_SEC).length, locked = shown.rows.filter(m.lock).length
  const word = kind === 'redis' ? tr('断开') : tr('终止')
  // 「共 N 个客户端 / 操作 / 会话」整句做键（英文名词单复数、语序不同）
  const total = kind === 'redis' ? tr('共 {n} 个客户端', { n: table.rows.length }) : kind === 'mongo' ? tr('共 {n} 个操作', { n: table.rows.length }) : tr('共 {n} 个会话', { n: table.rows.length })
  const killTip = kind === 'redis' ? tr('断开这个客户端（写操作，需要确认，会记入执行记录）') : kind === 'mongo' ? tr('终止这个操作（写操作，需要确认，会记入执行记录）') : tr('终止这个会话（写操作，需要确认，会记入执行记录）')
  return (
    <>
      <div data-db-sum className={`px-3 pb-1 text-[10.5px] ${MUTED}`}>
        {total}{hideIdle ? tr('，显示非空闲 {n} 个', { n: shown.rows.length }) : ''}
        {long > 0 && <span className="ml-2 text-[var(--color-warn)]">{tr('耗时 ≥ {sec} 秒：{n}', { sec: DB_LONG_SEC, n: long })}</span>}
        {locked > 0 && <span className="ml-2 text-[var(--color-danger)]">{kind === 'redis' ? tr('阻塞：{n}', { n: locked }) : tr('等锁：{n}', { n: locked })}</span>}
      </div>
      <ResultGrid table={shown} kind={kind} empty={hideIdle ? tr('没有非空闲的会话（取消勾选「隐藏空闲」看全部）') : tr('没有会话')}
        rowAttr={(r) => ({ 'data-db-session': r[m.id] ?? '' })}
        rowClass={(r) => (m.lock(r) ? LOCK_ROW : !m.idle(r) && Number(r[m.sec]) >= DB_LONG_SEC ? WARN_ROW : '')}
        align={(k) => (k === m.sec ? 'text-right' : '')}
        lead={(r) => {
          const id = Number(r[m.id])
          return Number.isInteger(id) && id > 0 && (
            <button data-db-kill={id} title={killTip} onClick={() => onKill(id, r.filter((_v, k) => k !== m.id).join(' ').replace(/\s+/g, ' ').slice(0, 200))}
              className="flex items-center gap-0.5 whitespace-nowrap rounded px-1 py-0.5 text-[10.5px] text-[var(--color-danger)] hover:bg-[color:color-mix(in_srgb,var(--color-danger)_12%,transparent)]"><XCircle className="h-3 w-3" />{word}</button>
          )
        }} />
    </>
  )
}

const sec = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(3))
function DigestTable({ ds, open, setOpen, onExplain }: { ds: SlowDigest[]; open: number | null; setOpen: (i: number | null) => void; onExplain?: (d: SlowDigest) => void }) {
  return (
    <table data-db-digest className="mt-1 w-full border-collapse text-[11px]">
      <thead><tr>{[tr('次数'), tr('总耗时 s'), tr('平均 s'), tr('最大 s'), tr('平均扫描行'), tr('SQL 指纹')].map((h) => <th key={h} className={`${TH} cursor-default`}>{h}</th>)}</tr></thead>
      <tbody>
        {ds.map((d, i) => (
          <Fragment key={i}>
            <tr data-db-digest-row={i} onClick={() => setOpen(open === i ? null : i)} className={`cursor-pointer hover:bg-[var(--color-bg-hover)] ${open === i ? 'bg-[var(--color-bg-hover)]' : ''}`}>
              <td className={`${TD} text-right`}>{d.count}</td>
              <td className={`${TD} text-right font-medium text-[var(--color-warn)]`}>{sec(d.totalTime)}</td>
              <td className={`${TD} text-right`}>{sec(d.avgTime)}</td>
              <td className={`${TD} text-right`}>{sec(d.maxTime)}</td>
              <td className={`${TD} text-right`}>{d.rowsExamined}</td>
              <Cell v={d.fingerprint} w="max-w-[340px]" cls="text-[var(--color-text-primary)]" />
            </tr>
            {open === i && (
              <tr><td colSpan={6} className="border-b border-[var(--color-border-subtle)] px-3 py-1.5">
                <div className={`mb-1 text-[10.5px] ${MUTED}`}>{tr('最慢一次（{sec} 秒）', { sec: sec(d.maxTime) })}{d.dbs.length ? tr(' · 库 {v}', { v: d.dbs.join(tr('list|、')) }) : ''}{d.users.length ? tr(' · 用户 {v}', { v: d.users.join(tr('list|、')) }) : ''}{d.first ? ` · ${d.first} ~ ${d.last}` : ''}</div>
                <pre className="whitespace-pre-wrap break-all rounded bg-[var(--color-bg-raised)] p-1.5 font-mono text-[10.5px] text-[var(--color-text-primary)]">{d.example}</pre>
                {onExplain && /^\s*(\(\s*)?(select|with)\b/i.test(d.example) && (d.example.endsWith('…')
                  ? <div data-db-digest-cut className={`mt-1 text-[10.5px] ${MUTED}`}>{tr('语句太长，慢日志里只留了前一部分，没法直接 EXPLAIN；请从应用代码或日志里取完整语句，贴到「查询」页签。')}</div>
                  : <button data-db-digest-explain onClick={() => onExplain(d)} className={`${BTN} mt-1 text-[var(--color-accent)]`}><Play className="h-3 w-3" />{tr('EXPLAIN 这条')}</button>
                )}
              </td></tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  )
}
