import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, CalendarClock, CheckCircle2, Download, HardDriveDownload, Loader2, Play, RefreshCw, Trash2, XCircle } from 'lucide-react'
import { dateLocale, tr, type BackupFile, type BackupPlan, type BackupSchedule, type BackupStatus, type DbConn } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { trx } from '../../lib/trx.js'
import { Input } from '../../components/ui/Input.js'
import { Checkbox } from '../../components/ui/Checkbox.js'
import { Switch } from '../../components/ui/Switch.js'
import { Select } from '../../components/ui/Select.js'
import { ConfirmDialog } from '../common/index.js'
import { BTN, DANGER_BOX, MUTED, PRIMARY, errText } from '../../components/ui/drawer.js'

const fmtBytes = (n?: number) => (n === undefined ? '—' : n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`)
const fmtDur = (ms: number) => { const s = Math.round(ms / 1000); return s < 60 ? tr('{n} 秒', { n: s }) : tr('{m} 分 {s} 秒', { m: Math.floor(s / 60), s: s % 60 }) }
const fmtTime = (at: number) => new Date(at).toLocaleString(dateLocale(), { hour12: false })
const TOOL = { mysql: 'mysqldump', postgres: 'pg_dump', redis: 'redis-cli --rdb', mongo: 'mongodump' } as const

// 数据库抽屉「备份」页签：预检（目录、剩余空间、估算大小、导出工具）→ 开始备份（在数据库所在机器上后台跑，可取消）→ 目录里的备份文件（下载 / 删除）。
// 只读数据库，写的是备份文件；开始 / 完成 / 删除都记执行记录。恢复不在这里做（覆盖数据，风险高）
export function BackupPanel({ conn, prod }: { conn: DbConn; prod: boolean }) {
  const redis = conn.kind === 'redis'
  const [database, setDatabase] = useState(conn.database ?? '')
  const [tables, setTables] = useState('')
  const [dir, setDir] = useState('')
  const [routines, setRoutines] = useState(true)
  const [plan, setPlan] = useState<BackupPlan>()
  const [checking, setChecking] = useState(false)
  const [err, setErr] = useState('')
  const [jobs, setJobs] = useState<BackupStatus[]>([])
  const [files, setFiles] = useState<BackupFile[]>()
  const [askProd, setAskProd] = useState(false)
  const [del, setDel] = useState<BackupFile | null>(null)
  const [note, setNote] = useState('')
  const opts = () => ({ dir: dir || undefined, ...(redis ? {} : { database: database.trim(), tables: tables.split(/[\s,，]+/).filter(Boolean) }), routines })
  // 文件列表实际列的是哪个目录（下载 / 删除都按它，不跟着「保存到」输入框里还没检查的值走）
  const [filesDir, setFilesDir] = useState('')
  const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/'

  const loadFiles = useCallback((d: string) => { if (d) { setFilesDir(d); client.db.backupList(conn.id, d).then(setFiles, (e) => setErr(errText(e))) } }, [conn.id])
  const check = useCallback(() => {
    setChecking(true); setErr('')
    client.db.backupPlan(conn.id, opts()).then((p) => { setPlan(p); if (!dir) setDir(p.dir); loadFiles(p.dir) }, (e) => { setPlan(undefined); setErr(errText(e)) }).finally(() => setChecking(false))
  }, [conn.id, database, tables, dir, routines])
  useEffect(() => { check() }, [conn.id])   // 打开 / 换连接时检查一次，改输入后点「重新检查」

  // 有任务在跑：每 1.5 秒取一次进度；跑完刷新文件列表
  const running = jobs.some((j) => j.state === 'running')
  const prevRunning = useRef(false)
  useEffect(() => {
    let alive = true
    const tick = () => client.db.backupStatus(conn.id).then((s) => { if (alive) setJobs(s) }).catch(() => {})
    tick()
    if (!running) return () => { alive = false }
    const t = setInterval(tick, 1500)
    return () => { alive = false; clearInterval(t) }
  }, [conn.id, running])
  // 跑完刷新备份实际写到的那个目录
  useEffect(() => { if (prevRunning.current && !running) loadFiles(jobs[0] ? dirOf(jobs[0].file) : filesDir); prevRunning.current = running }, [running])

  const start = () => {
    setErr('')
    client.db.backupStart(conn.id, opts()).then(() => client.db.backupStatus(conn.id).then(setJobs)).catch((e) => setErr(errText(e)))
  }
  const download = async (f: BackupFile) => {
    const t = (await client.terminal.list()).find((x) => x.type === 'ssh' && x.hostId === conn.hostKey && x.status !== 'disconnected')
    if (!t) { setErr(tr('下载要先打开这台主机的 SSH 终端')); return }
    const local = await client.system.pickDirectory()
    if (!local) return
    client.transfer.downloadMany({ terminalId: t.id }, [`${filesDir}/${f.name}`], local).then(() => setNote(tr('已加入传输队列：{name}', { name: f.name })), (e) => setErr(errText(e)))
  }
  const blocked = plan?.blocked

  return (
    <div className="space-y-2 px-3 py-2 text-[12px]" data-db-backup>
      <div className="grid grid-cols-[72px_1fr] items-center gap-x-2 gap-y-1.5">
        {!redis && <>
          <span className={MUTED}>{tr('库名')}</span>
          <Input data-bk-db size="sm" value={database} onChange={(e) => setDatabase(e.target.value)} placeholder={tr('要备份的库')} />
          <span className={MUTED}>{conn.kind === 'mongo' ? tr('集合（可选）') : tr('表（可选）')}</span>
          <Input data-bk-tables size="sm" value={tables} onChange={(e) => setTables(e.target.value)} placeholder={conn.kind === 'mongo' ? tr('留空 = 整个库；只能填一个集合') : tr('留空 = 整个库；多张表用逗号或空格分隔')} />
        </>}
        <span className={MUTED}>{tr('保存到')}</span>
        <Input data-bk-dir size="sm" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="~/lingshell-backups/…" title={tr('数据库所在机器上的目录（Docker 连接也存在宿主机上），不存在会自动创建')} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {conn.kind === 'mysql' && <label className="flex items-center gap-1 text-[11px] text-[var(--color-text-secondary)]" title={tr('--routines：导出存储过程和函数。账号没有权限时取消勾选')}><Checkbox checked={routines} onCheckedChange={setRoutines} />{tr('包含存储过程 / 函数')}</label>}
        {redis && <span className={`text-[11px] ${MUTED}`}>{tr('Redis 备份整个实例（所有库），用 redis-cli --rdb，需要 7.0 以上')}</span>}
        <span className="ml-auto" />
        <button data-bk-check onClick={check} disabled={checking} className={`${BTN} text-[var(--color-text-secondary)]`}><RefreshCw className={`h-3 w-3 ${checking ? 'animate-spin' : ''}`} />{tr('重新检查')}</button>
        <button data-bk-start onClick={() => (prod ? setAskProd(true) : start())} disabled={!plan || !!blocked || checking || running} className={PRIMARY}><Play className="h-3 w-3" />{tr('开始备份')}</button>
      </div>

      {plan && (
        <div data-bk-plan className={`rounded border border-[var(--color-border-subtle)] px-2 py-1.5 text-[11px] ${MUTED}`}>
          <div>{trx('目录：{dir}', { dir: <span className="font-mono text-[var(--color-text-primary)]">{plan.dir}</span> })}</div>
          <div>{tr('剩余空间 {free} · 数据约 {est}（未压缩）· 工具 {tool}', { free: fmtBytes(plan.freeBytes), est: fmtBytes(plan.estimateBytes), tool: plan.tool ? `✓ ${TOOL[conn.kind]}` : tr('✗ 没有 {tool}', { tool: TOOL[conn.kind] }) })}</div>
          {plan.warn && <div className="mt-0.5 flex items-start gap-1 text-[var(--color-warn)]"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />{tr(plan.warn)}</div>}
          {blocked && <div data-bk-blocked className="mt-0.5 flex items-start gap-1 whitespace-pre-wrap text-[var(--color-danger)]"><XCircle className="mt-0.5 h-3 w-3 shrink-0" />{tr(blocked)}</div>}
        </div>
      )}
      {err && <div data-bk-err className="whitespace-pre-wrap break-all text-[11px] text-[var(--color-danger)]">{err}</div>}
      {note && <div className="text-[11px] text-[var(--color-success)]">{note}</div>}

      {jobs.length > 0 && (
        <div className="space-y-1">
          {jobs.map((j) => <JobRow key={j.file} j={j} onCancel={() => client.db.backupCancel(conn.id, j.file).then(() => client.db.backupStatus(conn.id).then(setJobs)).catch((e) => setErr(errText(e)))} />)}
        </div>
      )}

      <ScheduleBox conn={conn} opts={opts} onRan={(file) => { loadFiles(file ? dirOf(file) : filesDir); client.db.backupStatus(conn.id).then(setJobs).catch(() => {}) }} />

      <div className="pt-1">
        <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-[var(--color-text-primary)]"><HardDriveDownload className="h-3.5 w-3.5" />{tr('已有备份')}<span data-bk-files-dir className={`font-normal ${MUTED}`}>{tr('（{dir}）', { dir: filesDir || '—' })}</span></div>
        {!files ? (filesDir || checking
          ? <div className={`flex items-center gap-1 ${MUTED}`}><Loader2 className="h-3 w-3 animate-spin" />{tr('读取中')}</div>
          // 预检失败（主机没连上等）时还不知道目录：别一直转圈
          : <div data-bk-files-wait className={MUTED}>{tr('上面的检查通过后，这里列出备份目录里已有的备份。')}</div>) : !files.length ? <div className={`flex items-center gap-1.5 ${MUTED}`}><HardDriveDownload className="h-3.5 w-3.5" />{tr('这个目录里还没有备份，点上面「开始备份」生成第一份。')}</div> : (
          <table data-bk-files className="w-full text-[11px]">
            <thead><tr className={`text-left text-[10.5px] ${MUTED}`}>
              <th className="pb-0.5 font-medium">{tr('文件')}</th><th className="pb-0.5 pr-2 text-right font-medium">{tr('大小')}</th><th className="pb-0.5 pr-2 font-medium">{tr('时间')}</th><th className="w-[52px]" />
            </tr></thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.name} data-bk-file={f.name} className="group border-t border-[var(--color-border-subtle)] hover:bg-[var(--color-bg-hover)]">
                  <td className="py-1 pr-2 font-mono text-[var(--color-text-primary)]">{f.name}</td>
                  <td className={`whitespace-nowrap pr-2 text-right ${MUTED}`}>{fmtBytes(f.size)}</td>
                  <td className={`whitespace-nowrap pr-2 ${MUTED}`}>{fmtTime(f.at)}</td>
                  <td className="whitespace-nowrap text-right">
                    {/* 悬停才显示，免得满屏图标 */}
                    <span className="invisible inline-flex group-hover:visible">
                      {conn.hostKey !== 'local' && <button data-bk-download onClick={() => void download(f)} title={tr('下载到本机（走传输队列）')} className="rounded p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"><Download className="h-3.5 w-3.5" /></button>}
                      <button data-bk-delete onClick={() => setDel(f)} title={tr('删除这个备份文件')} className="rounded p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"><Trash2 className="h-3.5 w-3.5" /></button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className={`mt-1 text-[10.5px] ${MUTED}`}>{tr('恢复会覆盖现有数据，这里不提供；需要时用 {cmd} 在终端里手动恢复。', { cmd: conn.kind === 'mysql' ? tr('gunzip -c 文件 | mysql 库名') : conn.kind === 'postgres' ? tr('pg_restore -d 库名 文件') : conn.kind === 'mongo' ? tr('mongorestore --gzip --archive=文件') : tr('gunzip -c 备份文件 > dump.rdb，停掉 Redis 后替换并重启') })}</div>
      </div>

      <ConfirmDialog open={askProd} title={tr('生产库：开始备份')} confirmText={tr('开始备份')}
        message={tr('「{name}」在生产主机上。备份只读数据库，但会占用磁盘 IO 和 CPU，数据量大时建议在低峰期做。', { name: conn.name })}
        onCancel={() => setAskProd(false)} onConfirm={() => { setAskProd(false); start() }}>
        <div className={`flex items-center gap-1.5 ${DANGER_BOX}`}><AlertTriangle className="h-3.5 w-3.5 shrink-0" />{conn.kind === 'mysql' ? tr('MySQL 用 --single-transaction 一致性快照，InnoDB 表不锁表；MyISAM 表会被锁到导出结束。') : conn.kind === 'postgres' ? tr('pg_dump 不阻塞读写，但长时间运行会推迟 VACUUM 回收。') : conn.kind === 'mongo' ? tr('mongodump 逐个集合读取，不是一致性快照（副本集可在从节点上做）；会占用缓存和磁盘 IO。') : tr('Redis 会 fork 子进程生成快照，内存紧张时有风险。')}</div>
      </ConfirmDialog>
      <ConfirmDialog open={!!del} title={tr('删除备份文件')} confirmText={tr('删除')}
        message={tr('删除「{name}」？删除后无法找回。', { name: del?.name ?? '' })}
        onCancel={() => setDel(null)} onConfirm={() => { const f = del!; setDel(null); client.db.backupDelete(conn.id, filesDir, f.name).then(() => loadFiles(filesDir), (e) => setErr(errText(e))) }} />
    </div>
  )
}

function JobRow({ j, onCancel }: { j: BackupStatus; onCancel: () => void }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { if (j.state !== 'running') return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [j.state])
  const took = (j.endedAt ?? now) - j.startedAt
  const name = j.file.slice(j.file.lastIndexOf('/') + 1)
  return (
    <div data-bk-job={j.state} className="rounded border border-[var(--color-border-subtle)] px-2 py-1.5 text-[11px]">
      <div className="flex items-center gap-1.5">
        {j.state === 'running' ? <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--color-accent)]" /> : j.state === 'ok' ? <CheckCircle2 className="h-3.5 w-3.5 text-[var(--color-success)]" /> : <XCircle className="h-3.5 w-3.5 text-[var(--color-danger)]" />}
        <span className="min-w-0 truncate font-mono text-[var(--color-text-primary)]" title={j.file}>{name}</span>
        <span className={`ml-auto whitespace-nowrap ${MUTED}`}>
          {j.state === 'running' ? `${tr('已写 {bytes} · {dur}', { bytes: fmtBytes(j.bytes), dur: fmtDur(took) })}${took > 2000 && j.bytes ? tr(' · {rate}/秒', { rate: fmtBytes(Math.round(j.bytes / (took / 1000))) }) : ''}` : j.state === 'ok' ? tr('完成 · {bytes} · 用时 {dur}', { bytes: fmtBytes(j.bytes), dur: fmtDur(took) }) : j.state === 'canceled' ? tr('已取消') : tr('失败')}
        </span>
        {j.state === 'running' && <button data-bk-cancel onClick={onCancel} className="rounded px-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-danger)]">{tr('取消')}</button>}
      </div>
      {j.error && <pre className="mt-1 whitespace-pre-wrap break-all text-[10.5px] text-[var(--color-danger)]">{j.error}</pre>}
    </div>
  )
}

// 下一次运行时间（同主进程 inspection.ts 的 nextRunAt：每天按本地时间，间隔按上次开跑时间）
function nextAt(s: BackupSchedule): number {
  const anchor = Date.parse(s.lastRunAt ?? s.createdAt)
  if (s.when.kind === 'interval') return anchor + s.when.hours * 3_600_000
  const [h, m] = s.when.time.split(':').map(Number)
  const d = new Date(anchor); d.setHours(h, m, 0, 0)
  if (d.getTime() <= anchor) d.setDate(d.getDate() + 1)
  return d.getTime()
}

// 定时备份：用上面填的库 / 表 / 目录，保存时记进计划；到点在主进程里跑（不需要开着终端），跑完只留最近 N 份，成败推送群机器人（失败另弹系统通知）
function ScheduleBox({ conn, opts, onRan }: { conn: DbConn; opts: () => object; onRan: (file?: string) => void }) {
  const [s, setS] = useState<BackupSchedule | null>()
  const [enabled, setEnabled] = useState(true)
  const [kind, setKind] = useState<'daily' | 'interval'>('daily')
  const [time, setTime] = useState('03:00')
  const [hours, setHours] = useState(6)
  const [keep, setKeep] = useState(7)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const fill = (x: BackupSchedule | null) => {
    setS(x)
    if (!x) return
    setEnabled(x.enabled); setKind(x.when.kind); setKeep(x.keep)
    if (x.when.kind === 'daily') setTime(x.when.time); else setHours(x.when.hours)
  }
  useEffect(() => { client.db.backupScheduleGet(conn.id).then(fill, (e) => setErr(errText(e))) }, [conn.id])
  const save = () => {
    setErr(''); setBusy('save')
    client.db.backupScheduleSave(conn.id, { enabled, when: kind === 'daily' ? { kind, time } : { kind, hours }, keep, opts: opts() }).then(fill, (e) => setErr(errText(e))).finally(() => setBusy(''))
  }
  const runNow = () => { setErr(''); setBusy('run'); client.db.backupScheduleRun(conn.id).then((x) => { fill(x); onRan(x.lastResult?.file) }, (e) => setErr(errText(e))).finally(() => setBusy('')) }
  const remove = () => { setBusy('del'); client.db.backupScheduleSave(conn.id, null).then(() => setS(null), (e) => setErr(errText(e))).finally(() => setBusy('')) }
  if (s === undefined) return null
  const r = s?.lastResult
  return (
    <div data-bk-schedule className="rounded border border-[var(--color-border-subtle)] px-2 py-1.5 text-[11px]">
      <div className="mb-1 flex items-center gap-1 font-semibold text-[var(--color-text-primary)]"><CalendarClock className="h-3.5 w-3.5" />{tr('定时备份')}
        {s && <span className={`ml-1 font-normal ${s.enabled ? 'text-[var(--color-success)]' : MUTED}`}>{s.enabled ? tr('已开启 · 下次 {at}', { at: fmtTime(nextAt(s)) }) : tr('已暂停')}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Switch data-bk-sched-on checked={enabled} onCheckedChange={setEnabled} />
        <Select size="sm" className="!h-6 w-[88px]" value={kind} onValueChange={(v) => setKind(v as 'daily' | 'interval')} options={[{ value: 'daily', label: tr('每天') }, { value: 'interval', label: tr('每隔') }]} />
        {kind === 'daily'
          ? <input data-bk-sched-time type="time" value={time} onChange={(e) => setTime(e.target.value)} className="h-6 rounded border border-[var(--color-border-default)] bg-transparent px-1 text-[11px] text-[var(--color-text-primary)]" />
          : <><Input size="sm" className="!h-6 w-[56px]" type="number" min={1} max={168} value={hours} onChange={(e) => setHours(Number(e.target.value))} /><span className={MUTED}>{tr('unit|小时')}</span></>}
        <span className={MUTED}>{tr('keep|保留')}</span>
        <Input data-bk-sched-keep size="sm" className="!h-6 w-[52px]" type="number" min={1} max={60} value={keep} onChange={(e) => setKeep(Number(e.target.value))} />
        <span className={MUTED}>{tr('unit|份')}</span>
        <span className="ml-auto" />
        <button data-bk-sched-save onClick={save} disabled={!!busy} className={`${BTN} text-[var(--color-accent)]`}>{s ? tr('保存计划') : tr('创建计划')}</button>
        {s && <button data-bk-sched-run onClick={runNow} disabled={!!busy} title={tr('按计划立即跑一次（含清理旧备份），跑完才返回')} className={`${BTN} text-[var(--color-text-secondary)]`}>{busy === 'run' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}{tr('现在跑一次')}</button>}
        {s && <button onClick={remove} disabled={!!busy} title={tr('删除这个定时计划（已有的备份文件不动）')} className={`${BTN} text-[var(--color-text-muted)]`}>{tr('删除计划')}</button>}
      </div>
      <div className={`mt-1 ${MUTED}`}>{tr('按上面的库 / 表 / 目录{plan}；应用开着时到点自动跑，不需要开着终端；只留同一个库最近的 N 份；成败都推送到群机器人，失败另弹系统通知。', {
        plan: s ? tr('（计划里存的是：{what} → {dir}）', {
          what: s.opts.tables?.length ? tr('{db} 的 {n} 张表', { db: s.opts.database ?? tr('整个实例'), n: s.opts.tables.length }) : s.opts.database ?? tr('整个实例'),
          dir: s.opts.dir,
        }) : '',
      })}</div>
      {r && <div data-bk-sched-last className={`mt-1 ${r.ok ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}`}>{tr('上次 {at}：{result}', {
        at: new Date(r.at).toLocaleString(dateLocale(), { hour12: false }),
        result: r.ok ? `${tr('成功 · {bytes}', { bytes: fmtBytes(r.bytes) })}${r.pruned ? tr(' · 清理旧备份 {n} 份', { n: r.pruned }) : ''}` : tr('失败 · {err}', { err: String(r.error) }),
      })}</div>}
      {err && <div className="mt-1 whitespace-pre-wrap text-[var(--color-danger)]">{err}</div>}
    </div>
  )
}
