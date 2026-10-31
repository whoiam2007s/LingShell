// 数据库备份（纯逻辑）：在数据库所在的机器上后台跑 mysqldump / pg_dump / redis-cli --rdb / mongodump --archive --gzip，先写 .part，成功后改成正式文件名。
// 后台跑（nohup）：应用关掉、SSH 断线都不影响；进度 = 定期读 .part 的大小；取消 = 结束管道末端的写文件进程（上游写时收到 SIGPIPE 退出），
// 不依赖 setsid（macOS / 部分精简系统没有）。密码同快查：stdin 第一行读进环境变量，不进命令行。
// 跑的时候旁边有几个小文件：.rc（导出程序退出码）、.pid、.done（ok / fail / canceled）、.err（导出程序的报错）；应用读到最终状态后全部清掉（backupCleanupCommand）
import { shq } from '../files/explorer.js'
import { PW_ENV, type DbConn, type DbKind } from './dbQuick.js'
import { tr } from '../i18n/i18n.js'

export const BACKUP_DECISION = 'db_backup'
export const BACKUP_EXT: Record<DbKind, string> = { mysql: '.sql.gz', postgres: '.dump', redis: '.rdb.gz', mongo: '.archive.gz' }
export const BACKUP_TOOL: Record<DbKind, string> = { mysql: 'mysqldump', postgres: 'pg_dump', redis: 'redis-cli', mongo: 'mongodump' }
const NAME_RE = /^[A-Za-z0-9_.-]{1,64}-\d{8}-\d{6}(\.sql\.gz|\.dump|\.rdb\.gz|\.archive\.gz)$/
export const isBackupName = (n: unknown): n is string => typeof n === 'string' && NAME_RE.test(n)
// 目录：绝对路径或 ~ 开头，只允许常见字符（拼进 shell 前再 shq）
export const isBackupDir = (d: unknown): d is string => typeof d === 'string' && /^(~|\/)[\w./@+-]{0,300}$/.test(d) && !/(^|\/)\.\.(\/|$)/.test(d)
const IDENT = /^[A-Za-z0-9_$.-]{1,64}$/

export interface BackupOpts { dir: string; database?: string; tables?: string[]; routines?: boolean }
export interface BackupPlan { dir: string; freeBytes?: number; estimateBytes?: number; tool: boolean; blocked?: string; warn?: string }
export interface BackupFile { name: string; size: number; at: number }
export interface BackupStatus { state: 'running' | 'ok' | 'fail' | 'canceled'; bytes: number; file: string; error?: string; startedAt: number; endedAt?: number }

/** 备份文件名：<库名或连接名>-YYYYMMDD-HHMMSS<扩展名>（本地时间） */
export function backupFileName(c: DbConn, base: string | undefined, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const slug = (base || c.name).replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[._-]+/, '').slice(0, 40) || c.kind
  return `${slug}-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}${BACKUP_EXT[c.kind]}`
}

/** 校验选项（库名 / 表名只放安全字符；Redis 整库备份不需要库名） */
export function checkBackupOpts(c: DbConn, o: Partial<BackupOpts>): BackupOpts | string {
  if (!isBackupDir(o.dir)) return tr('备份目录要以 / 或 ~ 开头，只能含字母数字和 . _ - / @ +')
  const database = (o.database ?? c.database ?? '').trim()
  if (c.kind !== 'redis' && !IDENT.test(database)) return tr('请填写要备份的库名')
  const tables = (o.tables ?? []).map((t) => t.trim()).filter(Boolean)
  if (tables.some((t) => !IDENT.test(t))) return tr('表名只能含字母数字和 _ $ . -')
  if (tables.length > 200) return tr('一次最多指定 200 张表')
  if (c.kind === 'mongo' && tables.length > 1) return tr('MongoDB 一次只能指定一个集合（mongodump --collection），留空 = 整个库')
  return { dir: o.dir, ...(c.kind !== 'redis' ? { database } : {}), tables, routines: o.routines !== false }
}

// 导出程序的参数（连接参数同快查）
function dumpArgv(c: DbConn, o: BackupOpts): string[] {
  const a: string[] = []
  if (c.kind === 'mysql') {
    // --single-transaction：InnoDB 一致性快照不锁表；--no-tablespaces：免 PROCESS 权限；--quick：逐行取不占内存
    a.push('mysqldump', '--single-transaction', '--quick', '--no-tablespaces', '--triggers', ...(o.routines ? ['--routines'] : []))
    if (c.host) a.push('-h', shq(c.host))
    if (c.port) a.push('-P', String(c.port))
    if (c.user) a.push('-u', shq(c.user))
    if (o.tables?.length) a.push(shq(o.database!), ...o.tables.map(shq))
    else a.push('--databases', shq(o.database!))
  } else if (c.kind === 'postgres') {
    // -Fc：自定义格式（自带压缩，pg_restore 可挑表恢复）
    a.push('pg_dump', '-Fc', '-w')
    if (c.host) a.push('-h', shq(c.host))
    if (c.port) a.push('-p', String(c.port))
    if (c.user) a.push('-U', shq(c.user))
    for (const t of o.tables ?? []) a.push('-t', shq(t))
    a.push('-d', shq(o.database!))
  } else if (c.kind === 'mongo') {
    const m = ['mongodump', '--archive', '--gzip', '--host', shq(c.host || '127.0.0.1'), '--port', String(c.port || 27017)]
    if (c.user) m.push('--username', shq(c.user), '--authenticationDatabase', 'admin')
    m.push('${MONGO_PWD:+--config="$__cf"}', '--db', shq(o.database!))
    if (o.tables?.[0]) m.push('--collection', shq(o.tables[0]))
    const inner = [
      'umask 077; __cf=$(mktemp) || exit 1; trap \'rm -f "$__cf"\' EXIT',
      // YAML 单引号字符串：值里的 ' 写成 ''
      'if [ -n "$MONGO_PWD" ]; then printf "password: \'%s\'\\n" "$(printf %s "$MONGO_PWD" | sed "s/\'/\'\'/g")" > "$__cf"; fi',
      m.join(' '),
    ].join('\n')
    const sh = ['sh', '-c', shq(inner)]
    return c.via === 'docker' && c.container ? ['docker', 'exec', '-i', '${MONGO_PWD+-e MONGO_PWD}', shq(c.container), ...sh] : sh
  } else {
    // redis-cli 7.0 起 --rdb - 输出到 stdout
    a.push('redis-cli', '--no-auth-warning')
    if (c.host) a.push('-h', shq(c.host))
    if (c.port) a.push('-p', String(c.port))
    if (c.user) a.push('--user', shq(c.user))
    a.push('--rdb', '-')
  }
  if (c.via !== 'docker' || !c.container) return a
  const env = PW_ENV[c.kind]
  return ['docker', 'exec', '-i', `\${${env}+-e ${env}}`, shq(c.container), ...a]
}

const readPw = (c: DbConn) => [
  'IFS= read -r __p || true',
  `if [ -n "$__p" ]; then ${PW_ENV[c.kind]}=$__p; export ${PW_ENV[c.kind]}; fi; unset __p`,
]
// 目录里的 ~ 交给远端 shell 展开：~ 开头时拆成 "$HOME" + 余下部分
const dirExpr = (dir: string) => (dir === '~' ? '"$HOME"' : dir.startsWith('~/') ? `"$HOME"/${shq(dir.slice(2))}` : shq(dir))

/**
 * 启动备份（stdin 第一行 = 密码）：建目录 → 同名文件已存在则拒绝 → 后台跑「导出 | 写文件」→ 输出 started <完整路径>。
 * 管道：{ 导出; echo 退出码 > rc; } | gzip -c（PG 的 -Fc 已压缩，用 cat）> .part；成功 mv 成正式文件，失败写 .done = fail
 */
export function backupStartCommand(c: DbConn, o: BackupOpts, name: string): string {
  if (!isBackupName(name)) throw new Error(tr('非法的备份文件名'))
  const writer = c.kind === 'postgres' || c.kind === 'mongo' ? 'cat' : 'gzip -c'   // pg_dump -Fc、mongodump --gzip 已经压缩过
  const job = [
    `{ ${dumpArgv(c, o).join(' ')}; echo $? > "$1.rc"; } 2>"$1.err" | ${writer} > "$1.part"`,
    'w=$?; r=$(cat "$1.rc" 2>/dev/null)',
    'if [ "$r" = 0 ] && [ "$w" = 0 ] && [ -s "$1.part" ]; then mv "$1.part" "$1" && echo ok > "$1.done"; else echo "fail ${r:-?} $w" > "$1.done"; rm -f "$1.part"; fi',
    'rm -f "$1.rc" "$1.pid"',
  ].join('\n')
  const script = [
    ...readPw(c),
    `d=${dirExpr(o.dir)}; mkdir -p "$d" || exit 3`,
    `f="$d"/${shq(name)}`,
    '[ -e "$f" ] && { echo "exists $f"; exit 4; }',
    'rm -f "$f.done" "$f.err"',
    `nohup sh -c ${shq(job)} _ "$f" </dev/null >/dev/null 2>&1 &`,
    'echo $! > "$f.pid"',
    'echo "started $f"',
  ].join('\n')
  return `sh -c ${shq(script)}`
}

/** 查进度：输出「size <字节>」「done <ok|fail …>」「err <末尾报错>」几行 */
export function backupStatusCommand(path: string): string {
  const f = shq(path)
  return `sh -c ${shq(`f=${f}; s=$(wc -c < "$f.part" 2>/dev/null || wc -c < "$f" 2>/dev/null || echo 0); echo "size $s"; [ -e "$f.done" ] && echo "done $(cat "$f.done")"; [ -s "$f.err" ] && { printf 'err '; tail -c 1500 "$f.err" | tr '\\n' ' '; echo; }; true`)}`
}

export function parseBackupStatus(out: string): { bytes: number; done?: string; err?: string } {
  const line = (k: string) => out.split('\n').find((l) => l.startsWith(`${k} `))?.slice(k.length + 1).trim()
  return { bytes: Number(line('size')) || 0, done: line('done'), err: line('err') }
}

/** 读完最终状态后清掉旁边的状态文件（.done / .err），不在备份目录里堆小文件 */
export const backupCleanupCommand = (path: string): string => `sh -c ${shq(`f=${shq(path)}; rm -f "$f.done" "$f.err" "$f.rc" "$f.pid" "$f.part"`)}`

/** 取消：结束后台 sh 的子进程（写文件那一端结束后，导出程序写入时收到 SIGPIPE 退出），删掉 .part */
export function backupCancelCommand(path: string): string {
  const f = shq(path)
  return `sh -c ${shq(`f=${f}; p=$(cat "$f.pid" 2>/dev/null); if [ -n "$p" ]; then pkill -TERM -P "$p" 2>/dev/null; kill -TERM "$p" 2>/dev/null; fi; sleep 1; rm -f "$f.part" "$f.rc" "$f.pid"; echo canceled > "$f.done"; true`)}`
}

/** 列目录里的备份（只认本功能生成的文件名），每行「大小<TAB>修改时间秒<TAB>文件名」 */
export function backupListCommand(dir: string): string {
  return `sh -c ${shq(`d=${dirExpr(dir)}; [ -d "$d" ] || exit 0; cd "$d" && for f in *.sql.gz *.dump *.rdb.gz *.archive.gz; do [ -f "$f" ] || continue; printf '%s\\t%s\\t%s\\n' "$(wc -c < "$f")" "$(date -r "$f" +%s 2>/dev/null || stat -c %Y "$f")" "$f"; done; true`)}`
}
export function parseBackupList(out: string): BackupFile[] {
  return out.split('\n').map((l) => l.trim().split('\t')).filter((p) => p.length === 3 && isBackupName(p[2]))
    .map(([s, t, name]) => ({ name, size: Number(s) || 0, at: (Number(t) || 0) * 1000 })).sort((a, b) => b.at - a.at)
}
export function backupDeleteCommand(dir: string, name: string): string {
  if (!isBackupName(name)) throw new Error(tr('非法的备份文件名'))
  return `sh -c ${shq(`d=${dirExpr(dir)}; rm -f -- "$d"/${shq(name)} "$d"/${shq(name)}.done "$d"/${shq(name)}.err`)}`
}

/** 预检：目录（展开 ~ 后的绝对路径）、所在分区剩余空间、导出工具在不在（容器里的在容器里查） */
export function backupProbeCommand(c: DbConn, dir: string): string {
  const tool = BACKUP_TOOL[c.kind]
  const has = c.via === 'docker' && c.container ? `docker exec ${shq(c.container)} sh -c ${shq(`command -v ${tool}`)}` : `command -v ${tool}`
  return `sh -c ${shq(`d=${dirExpr(dir)}; echo "dir $d"; p="$d"; while [ ! -d "$p" ]; do p=$(dirname "$p"); done; echo "free $(df -Pk "$p" | awk 'NR==2 {print $4}')"; if ${has} >/dev/null 2>&1; then echo "tool 1"; else echo "tool 0"; fi`)}`
}
export function parseBackupProbe(out: string): { dir: string; freeBytes?: number; tool: boolean } {
  const line = (k: string) => out.split('\n').find((l) => l.startsWith(`${k} `))?.slice(k.length + 1).trim()
  const kb = Number(line('free'))
  return { dir: line('dir') ?? '', ...(Number.isFinite(kb) && line('free') ? { freeBytes: kb * 1024 } : {}), tool: line('tool') === '1' }
}

/** 估算大小（未压缩）：MySQL 表数据 + 索引；PG 库 / 表的总大小；Redis 数据集内存 */
export function backupEstimateSql(c: DbConn, o: BackupOpts): string | undefined {
  const lit = (s: string) => `'${s.replace(/'/g, "''")}'`
  const tl = o.tables?.length ? o.tables.map(lit).join(', ') : ''
  if (c.kind === 'mysql') return `SELECT COALESCE(SUM(data_length + index_length), 0) AS bytes FROM information_schema.TABLES WHERE table_schema = ${lit(o.database!)}${tl ? ` AND table_name IN (${tl})` : ''}`
  if (c.kind === 'postgres') return tl ? `SELECT COALESCE(SUM(pg_total_relation_size(c.oid)), 0) AS bytes FROM pg_class c WHERE c.relname IN (${tl})` : 'SELECT pg_database_size(current_database()) AS bytes'
  return undefined
}

/** 空间判断：剩余 < 估算（按未压缩算，偏保守）→ 拦下；< 2 倍 → 提示 */
export function backupSpaceCheck(freeBytes: number | undefined, estimateBytes: number | undefined): { blocked?: string; warn?: string } {
  if (freeBytes === undefined || estimateBytes === undefined) return {}
  const fmt = (n: number) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)}GB` : `${Math.max(1, Math.round(n / (1 << 20)))}MB`)
  if (freeBytes < estimateBytes) return { blocked: tr('磁盘空间不够：剩余 {free}，数据约 {size}（未压缩）。换一个目录或先清理磁盘', { free: fmt(freeBytes), size: fmt(estimateBytes) }) }
  if (freeBytes < estimateBytes * 2) return { warn: tr('磁盘剩余 {free}，数据约 {size}（未压缩，压缩后通常小很多），空间偏紧', { free: fmt(freeBytes), size: fmt(estimateBytes) }) }
  return {}
}

/** 导出程序报错 → 中文提示 + 原文 */
export function backupErrorText(c: DbConn, err: string, done?: string): string {
  const e = err.trim()
  let hint = ''
  if (/command not found|not found in \$PATH|executable file not found|未找到命令/i.test(e)) hint = tr('{where}没有 {tool}', { where: c.via === 'docker' ? tr('容器 {name} 里', { name: String(c.container) }) : tr('这台机器上'), tool: BACKUP_TOOL[c.kind] })
  else if (/SHOW_ROUTINE|routine/i.test(e) && c.kind === 'mysql') hint = tr('账号没有导出存储过程的权限：取消勾选「包含存储过程 / 函数」再试，或换有权限的账号')
  else if (/error parsing command line options|unknown option.*config/i.test(e) && c.kind === 'mongo') hint = tr('mongodump 版本太旧（100.3 以上才支持 --config 传密码），请升级 MongoDB Database Tools')
  else if (/Access denied|password authentication failed|WRONGPASS|NOAUTH|Authentication failed/i.test(e)) hint = tr('用户名或密码不对，或账号没有导出权限')
  else if (/Unrecognized option|unrecognized option|--rdb/i.test(e) && c.kind === 'redis') hint = tr('redis-cli 7.0 以上才支持 --rdb -，旧版本请在服务器上用 BGSAVE 后复制 dump.rdb')
  else if (/No space left/i.test(e)) hint = tr('磁盘写满了')
  const body = e || (done ? tr('导出失败（{v}）', { v: done }) : tr('导出失败'))
  return hint ? `${hint}\n${body}` : body
}

// ── 定时备份 ─────────────────────────────────────────────
// 每个连接一个计划：按「每天 HH:MM」或「每 N 小时」跑，用计划里存的库 / 表 / 目录；跑完只保留最近 keep 份（同一库的定时 + 手动备份一起算）
export interface BackupSchedule {
  connId: string
  enabled: boolean
  when: import('../ops/index.js').ScheduleWhen
  keep: number
  opts: BackupOpts
  createdAt: string
  lastRunAt?: string
  lastResult?: { at: string; ok: boolean; file?: string; bytes?: number; error?: string; pruned?: number }
}
export const BACKUP_KEEP_MAX = 60

/** 渲染层传来的计划 → 校验后的计划（opts 另由 checkBackupOpts 校验） */
export function sanitizeBackupSchedule(v: unknown, c: DbConn, prev?: BackupSchedule): BackupSchedule | string {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const w = (o.when ?? {}) as Record<string, unknown>
  let when: BackupSchedule['when']
  if (w.kind === 'daily' && typeof w.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(w.time)) when = { kind: 'daily', time: w.time }
  else if (w.kind === 'interval' && Number.isInteger(w.hours) && (w.hours as number) >= 1 && (w.hours as number) <= 168) when = { kind: 'interval', hours: w.hours as number }
  else return tr('时间要么是每天 HH:MM，要么是每 1–168 小时')
  const keep = Number(o.keep)
  if (!Number.isInteger(keep) || keep < 1 || keep > BACKUP_KEEP_MAX) return tr('保留份数要在 1–{max} 之间', { max: BACKUP_KEEP_MAX })
  const opts = checkBackupOpts(c, (o.opts ?? {}) as Partial<BackupOpts>)
  if (typeof opts === 'string') return opts
  return { connId: c.id, enabled: o.enabled === true, when, keep, opts, createdAt: prev?.createdAt ?? new Date().toISOString(), ...(prev?.lastRunAt ? { lastRunAt: prev.lastRunAt } : {}), ...(prev?.lastResult ? { lastResult: prev.lastResult } : {}) }
}

/** 超出保留份数要删的文件：只看同一前缀（库名）+ 同类扩展名的，按时间新→旧保留 keep 份 */
export function backupsToPrune(files: BackupFile[], c: DbConn, base: string | undefined, keep: number): string[] {
  const prefix = backupFileName(c, base, new Date(0)).replace(/-\d{8}-\d{6}.*$/, '-')
  const mine = files.filter((f) => f.name.startsWith(prefix) && f.name.endsWith(BACKUP_EXT[c.kind]) && /^\d{8}-\d{6}$/.test(f.name.slice(prefix.length, prefix.length + 15)))
  return [...mine].sort((a, b) => b.name.localeCompare(a.name)).slice(Math.max(1, keep)).map((f) => f.name)
}
