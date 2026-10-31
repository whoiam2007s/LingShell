import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, FileUp, Info, Loader2, MessageSquareQuote, Play, ScanSearch, XCircle } from 'lucide-react'
import { DB_KIND_LABEL, DB_SCRIPT_MAX, checkScript, guessTableName, parseScriptOutput, redactSecrets, scriptIsReadonly, scriptReviewPrompt, tk, tr, type DbConn, type DbScriptResult, type ScriptCheck, type ScriptFinding } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { sendToChat } from '../../lib/sendToChat.js'
import { Input } from '../../components/ui/Input.js'
import { Checkbox } from '../../components/ui/Checkbox.js'
import { ConfirmDialog } from '../common/index.js'
import { BTN, DANGER_BOX, MUTED, PRIMARY, errText } from '../../components/ui/drawer.js'
import { HlTextarea } from './HlTextarea.js'
import { ResultGrid } from './ResultGrid.js'

const DRAFT = (id: string) => `lingshell:db:script:${id}`
const DRAFT_MAX = 200 * 1024   // 草稿存 localStorage，太大的不存
const LH = 18   // 和 HlTextarea 的行高一致（goLine 定位用）
const LEVEL = {
  danger: { icon: XCircle, cls: 'text-[var(--color-danger)]', label: tk('高危') },
  warn: { icon: AlertTriangle, cls: 'text-[var(--color-warn)]', label: tk('注意') },
  info: { icon: Info, cls: 'text-[var(--color-text-muted)]', label: tk('提示') },
} as const
const fmtMs = (ms: number) => (ms < 1000 ? `${ms} ms` : tr('{n} 秒', { n: (ms / 1000).toFixed(1) }))

// 数据库抽屉「脚本」页签：编写或导入 .sql，用户点「智能检测」才检查（规则检查，可再交给 AI 审查），执行前确认（有高危项要勾选，生产主机要输入连接名）。
// 执行是写操作，走 db:script，记执行记录
// db：上方「库」里切到的库（空 = 连接里配的），脚本在这个库上执行
export function ScriptPanel({ conn, db, prod, version, onClose }: { conn: DbConn; db: string; prod: boolean; version: string; onClose: () => void }) {
  const [src, setSrc] = useState(() => localStorage.getItem(DRAFT(conn.id)) ?? '')
  const [tx, setTx] = useState(true)
  const [chk, setChk] = useState<{ r: ScriptCheck; src: string; tx: boolean }>()
  const [ask, setAsk] = useState<ScriptCheck | null>(null)
  const [ack, setAck] = useState(false)
  const [typed, setTyped] = useState('')
  const [running, setRunning] = useState(false)
  const [res, setRes] = useState<DbScriptResult>()
  const [err, setErr] = useState('')
  const ta = useRef<HTMLTextAreaElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const redis = conn.kind === 'redis', mongo = conn.kind === 'mongo'
  const useTx = tx && !redis && !mongo   // Redis / MongoDB 脚本没有整体事务

  useEffect(() => {
    const t = setTimeout(() => { if (src.length <= DRAFT_MAX) { if (src) localStorage.setItem(DRAFT(conn.id), src); else localStorage.removeItem(DRAFT(conn.id)) } }, 500)
    return () => clearTimeout(t)
  }, [src, conn.id])

  const stale = !!chk && (chk.src !== src || chk.tx !== useTx)
  const detect = () => { setChk({ r: checkScript(conn.kind, src, useTx), src, tx: useTx }); setErr('') }
  const goLine = (line: number) => {
    const el = ta.current
    if (!el) return
    const lines = src.split('\n')
    const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0)
    el.focus()
    el.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0))
    el.scrollTop = Math.max(0, (line - 3) * LH)
  }
  const importFile = (f?: File) => {
    if (!f) return
    if (f.size > DB_SCRIPT_MAX) { setErr(tr('文件太大（{size}MB，上限 {max}MB）。大的导出文件请在终端里用客户端导入', { size: (f.size / 1024 / 1024).toFixed(1), max: DB_SCRIPT_MAX / 1024 / 1024 })); return }
    f.text().then((t) => { setSrc(t); setChk(undefined); setRes(undefined); setErr('') }, (e) => setErr(errText(e)))
  }
  const askAi = async () => {
    if (!chk) return
    const s = await client.settings.get().catch(() => undefined)
    const text = scriptReviewPrompt({ kind: conn.kind, conn: conn.name, version, script: chk.src, check: chk.r })
    sendToChat(s?.system?.aiRedact === false ? text : redactSecrets(text))
    onClose()
  }
  // 每条都是只读语句（同「查询」页签的校验）：不是写操作，直接执行不弹确认
  const readonly = scriptIsReadonly(conn.kind, src)
  const openConfirm = () => { if (readonly) { void run(); return } setAsk(checkScript(conn.kind, src, useTx)); setAck(false); setTyped('') }
  const run = async () => {
    setAsk(null); setRunning(true); setRes(undefined); setErr('')
    try { setRes(await client.db.script(conn.id, src, useTx, prod, db || undefined)) } catch (e) { setErr(errText(e)) } finally { setRunning(false) }
  }

  const dangers = ask?.findings.filter((f) => f.level === 'danger') ?? []
  const askP = {
    name: conn.name, kind: DB_KIND_LABEL[conn.kind], n: ask?.stmts ?? 0,
    db: db || conn.database ? tr('，库 {db}', { db: String(db || conn.database) }) : '',
    tx: useTx ? tr('，整体事务') : '',
  }
  return (
    // 上面（按钮 / 编辑区 / 提示 / 执行结果状态）固定，下面的检测结果和执行输出单独滚动
    <div className="flex h-full min-h-0 flex-col" data-db-script>
      <div className="shrink-0 space-y-2 px-3 pt-2 pb-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <button data-db-import onClick={() => file.current?.click()} className={`${BTN} text-[var(--color-text-secondary)]`} title={tr('导入本地脚本文件到编辑区（上限 {max}MB）', { max: DB_SCRIPT_MAX / 1024 / 1024 })}><FileUp className="h-3 w-3" />{tr('导入文件')}</button>
        <input ref={file} type="file" accept=".sql,.txt,.redis,.js,text/plain" className="hidden" onChange={(e) => { importFile(e.target.files?.[0]); e.target.value = '' }} />
        <button data-db-detect disabled={!src.trim()} onClick={detect} className={`${BTN} text-[var(--color-accent)]`} title={tr('按规则检查：语法（引号 / 括号 / 注释）、缺 WHERE、删库删表、锁表、事务里不能执行的语句等')}><ScanSearch className="h-3 w-3" />{tr('智能检测')}</button>
        <button data-db-review disabled={!chk || stale} onClick={() => void askAi()} className={`${BTN} text-[var(--color-accent)]`} title={tr('把脚本和规则检查结果发到对话，让 AI 再审一遍（按设置脱敏；只审查不执行）')}><MessageSquareQuote className="h-3 w-3" />{tr('让 AI 审查')}</button>
        {!redis && !mongo && <label className="flex items-center gap-1 text-[11px] text-[var(--color-text-secondary)]" title={conn.kind === 'mysql' ? tr('整份脚本放在一个事务里，出错全部回滚（DDL 会隐式提交，无法回滚）') : tr('用 psql -1 整份脚本放在一个事务里，出错全部回滚')}>
          <Checkbox checked={tx} onCheckedChange={setTx} />{tr('整体事务（出错全部回滚）')}</label>}
        <span className="ml-auto" />
        <button data-db-run disabled={!src.trim() || running} onClick={openConfirm} className={PRIMARY}>{running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}{running ? tr('执行中') : tr('执行')}</button>
      </div>
      <HlTextarea inputRef={ta} data-db-script-src value={src} rows={3} lang={redis ? 'shell' : mongo ? 'code' : 'sql'}
        onChange={(e) => setSrc(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && src.trim() && !running) { e.preventDefault(); openConfirm() } }}
        placeholder={redis ? tr('每行一条 Redis 命令，例如：\nSET k v\nEXPIRE k 3600') : mongo ? tr('mongosh 脚本（JavaScript），例如：\nprintjson(db.orders.updateMany({ st: "new" }, { $set: { st: "paid" } }))\n要看结果用 printjson(...)；写完点「智能检测」，Ctrl+Enter 执行') : conn.kind === 'mysql'
          ? tr('写 {kind} 脚本，或点「导入文件」。分号分隔多条语句，存储过程可用 DELIMITER。\n写完点「智能检测」检查，Ctrl+Enter 执行。', { kind: DB_KIND_LABEL[conn.kind] })
          : tr('写 {kind} 脚本，或点「导入文件」。分号分隔多条语句。\n写完点「智能检测」检查，Ctrl+Enter 执行。', { kind: DB_KIND_LABEL[conn.kind] })} />
      {readonly && <div data-db-script-ro className={`text-[10.5px] ${MUTED}`}>{db || conn.database
        ? tr('只有查询语句，执行时不用确认（库 {db}）。要看成表格、排序、复制，用「查询」页签。', { db: String(db || conn.database) })
        : tr('只有查询语句，执行时不用确认。要看成表格、排序、复制，用「查询」页签。')}</div>}
      {err && <div data-db-script-err className="whitespace-pre-wrap break-all text-[11px] text-[var(--color-danger)]">{err}</div>}
      {res && (
        <div data-db-script-result={res.ok ? 'ok' : 'fail'}>
          <div className={`flex items-center gap-1 text-[11.5px] font-medium ${res.ok ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}`}>
            {res.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
            {res.ok ? tr('执行成功') : useTx ? tr('执行失败（整体事务已回滚，DDL 除外）') : tr('执行失败（出错前的语句已生效）')}
            <span className={`font-normal ${MUTED}`}>{tr('· {ms} · 已记入执行记录', { ms: fmtMs(res.ms) })}</span>
          </div>
        </div>
      )}
      </div>
      <div data-db-script-scroll className="min-h-0 flex-1 space-y-2 overflow-auto px-3 pb-2">
      {chk && <CheckView chk={chk.r} stale={stale} onLine={goLine} />}
      {res && (
        <div className="space-y-1">
          {res.error && <pre className="whitespace-pre-wrap break-all rounded bg-[color:color-mix(in_srgb,var(--color-danger)_10%,transparent)] p-2 font-mono text-[11px] text-[var(--color-danger)]">{res.error}</pre>}
          <ScriptOutput kind={conn.kind} output={res.output} tx={useTx} />
        </div>
      )}
      </div>
      <ConfirmDialog open={!!ask} title={prod ? tr('生产主机：执行脚本') : tr('执行脚本')} confirmText={tr('执行')}
        confirmDisabled={(dangers.length > 0 && !ack) || (prod && typed.trim() !== conn.name)}
        message={redis ? tr('这是写操作：将在「{name}」（{kind}{db}）上执行 {n} 条命令{tx}。操作会记入执行记录。', askP) : tr('这是写操作：将在「{name}」（{kind}{db}）上执行 {n} 条语句{tx}。操作会记入执行记录。', askP)}
        onCancel={() => setAsk(null)} onConfirm={() => void run()}>
        {ask && (
          <div className="space-y-2 text-[11.5px]">
            <div className="flex flex-wrap gap-1">{ask.counts.map(([k, n]) => <span key={k} className="rounded bg-[var(--color-bg-raised)] px-1.5 py-0.5 font-mono">{k} × {n}</span>)}</div>
            {dangers.length > 0 && (
              <div className={DANGER_BOX}>
                <div className="mb-1">{tr('发现 {n} 个高危项：', { n: dangers.length })}</div>
                {dangers.slice(0, 8).map((f, i) => <div key={i} className="font-normal">{tr('第 {line} 行：{msg}', { line: f.line, msg: tr(f.msg) })}</div>)}
                {dangers.length > 8 && <div className="font-normal">{tr('……还有 {n} 个', { n: dangers.length - 8 })}</div>}
                <label className="mt-1.5 flex items-center gap-1 font-normal"><Checkbox checked={ack} onCheckedChange={setAck} />{tr('我已看过这些高危项，确认执行')}</label>
              </div>
            )}
            {prod && (
              <div className="space-y-1">
                <div className="text-[var(--color-danger)]">{tr('生产主机：输入连接名「{name}」确认', { name: conn.name })}</div>
                <Input data-db-confirm-name size="sm" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={conn.name} />
              </div>
            )}
          </div>
        )}
      </ConfirmDialog>
    </div>
  )
}

// 执行输出：认出语句和表格的按语句分段展示（表格可排序 / 复制 / 导出），认不出（Redis、被截断的大输出）或点「原始输出」看原文
function ScriptOutput({ kind, output, tx }: { kind: DbConn['kind']; output: string; tx: boolean }) {
  const [raw, setRaw] = useState(false)
  let secs = parseScriptOutput(kind, output)
  // 整体事务时我们包上去的 START TRANSACTION / COMMIT 不展示
  if (tx && kind === 'mysql') secs = secs.filter((x, i) => !((i === 0 && x.stmt === 'START TRANSACTION') || (i === secs.length - 1 && x.stmt === 'COMMIT')))
  const parsed = secs.some((x) => x.tables.length) || secs.filter((x) => x.stmt).length > 1
  // 每段可折叠（点标题）；默认全展开。ScriptOutput 按每次执行结果重新挂载，折叠状态不会串到下一次
  const [folded, setFolded] = useState<Set<number>>(new Set())
  const toggle = (i: number) => setFolded((f) => { const n = new Set(f); if (n.has(i)) n.delete(i); else n.add(i); return n })
  const allFolded = secs.length > 0 && secs.every((_x, i) => folded.has(i))
  const pre = <pre data-db-script-out className="overflow-x-auto whitespace-pre rounded bg-[var(--color-bg-raised)] p-2 font-mono text-[10.5px] leading-[1.5] text-[var(--color-text-secondary)]">{output || tr('（没有输出）')}</pre>
  if (!parsed) return pre
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className={`text-[10.5px] ${MUTED}`}>{tr('{n} 段输出', { n: secs.length })}{secs.some((x) => x.tables.length) ? tr('，{n} 个结果表', { n: secs.reduce((n, x) => n + x.tables.length, 0) }) : ''}</span>
        <span className="ml-auto" />
        {!raw && <button data-db-script-fold-all onClick={() => setFolded(allFolded ? new Set() : new Set(secs.map((_x, i) => i)))} className={`${BTN} text-[var(--color-text-secondary)]`}>
          {allFolded ? <ChevronsUpDown className="h-3 w-3" /> : <ChevronsDownUp className="h-3 w-3" />}{allFolded ? tr('全部展开') : tr('全部折叠')}</button>}
        <button data-db-script-raw onClick={() => setRaw((r) => !r)} className={`${BTN} text-[var(--color-text-secondary)]`}>{raw ? tr('按语句分段看') : tr('原始输出')}</button>
      </div>
      {raw ? pre : secs.map((x, i) => {
        const shut = folded.has(i)
        const err = /ERROR|error/.test(x.text)
        // 折叠时标题右边给个摘要：几行结果 / 第一行提示
        const sum = x.tables.length ? x.tables.map((t) => tr('{n} 行', { n: t.rows.length })).join(tr('，')) : x.text.split('\n')[0]
        return (
          <div key={i} data-db-script-sec={i} className="overflow-hidden rounded border border-[var(--color-border-subtle)]">
            <button data-db-script-sec-head={i} title={x.stmt ?? tr('第 {n} 段输出', { n: i + 1 })} onClick={() => toggle(i)}
              className={`flex w-full items-center gap-1 bg-[var(--color-bg-raised)] px-2 py-1 text-left font-mono text-[11px] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] ${shut ? '' : 'border-b border-[var(--color-border-subtle)]'}`}>
              {shut ? <ChevronRight className="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" /> : <ChevronDown className="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" />}
              <span className={`shrink-0 ${MUTED}`}>#{i + 1}</span>
              <span className="min-w-0 flex-1 truncate">{x.stmt !== undefined ? x.stmt.replace(/\s+/g, ' ') : tr('第 {n} 段输出', { n: i + 1 })}</span>
              {shut && sum && <span className={`shrink-0 font-sans text-[10.5px] ${err ? 'text-[var(--color-danger)]' : MUTED}`}>{sum}</span>}
            </button>
            {!shut && <>
              {x.tables.map((t, k) => <div key={k} className="pt-1"><ResultGrid table={t} kind={kind} name={x.stmt ? guessTableName(x.stmt) : undefined} toolbar={t.rows.length > 5} empty={tr('没有返回任何行')} /></div>)}
              {x.text && <div className={`whitespace-pre-wrap break-all px-2 py-1 font-mono text-[10.5px] ${err ? 'text-[var(--color-danger)]' : MUTED}`}>{x.text}</div>}
            </>}
          </div>
        )
      })}
    </div>
  )
}

function CheckView({ chk, stale, onLine }: { chk: ScriptCheck; stale: boolean; onLine: (line: number) => void }) {
  const n = (l: ScriptFinding['level']) => chk.findings.filter((f) => f.level === l).length
  return (
    <div data-db-check className="rounded border border-[var(--color-border-subtle)]">
      <div className="flex flex-wrap items-center gap-x-2 border-b border-[var(--color-border-subtle)] px-2 py-1 text-[11px]">
        <span className="font-medium text-[var(--color-text-primary)]">{tr('检测结果：{n} 条', { n: chk.stmts })}</span>
        <span className="text-[var(--color-danger)]">{tr('高危 {n}', { n: n('danger') })}</span>
        <span className="text-[var(--color-warn)]">{tr('注意 {n}', { n: n('warn') })}</span>
        <span className={MUTED}>{tr('提示 {n}', { n: n('info') })}</span>
        {stale && <span className="text-[var(--color-warn)]">{tr('脚本已修改，请重新检测')}</span>}
      </div>
      {chk.findings.length ? chk.findings.map((f, i) => {
        const L = LEVEL[f.level]
        return (
          <button key={i} data-db-finding={f.level} onClick={() => onLine(f.line)} title={tr('点击定位到这一行')}
            className="flex w-full items-start gap-1.5 px-2 py-0.5 text-left text-[11px] hover:bg-[var(--color-bg-hover)]">
            <L.icon className={`mt-0.5 h-3 w-3 shrink-0 ${L.cls}`} />
            <span className={`shrink-0 font-mono ${MUTED}`}>{tr('第 {n} 行', { n: f.line })}</span>
            <span className="text-[var(--color-text-primary)]">{tr(f.msg)}</span>
          </button>
        )
      }) : <div className="flex items-center gap-1 px-2 py-1 text-[11px] text-[var(--color-success)]"><CheckCircle2 className="h-3 w-3" />{tr('规则检查没有发现问题（规则只覆盖常见风险，重要变更建议再让 AI 审查）')}</div>}
    </div>
  )
}
