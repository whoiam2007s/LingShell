// ── 连通性探测矩阵：从多台源主机（含本机）向多个目标测 DNS / TCP / HTTP ──────────────
// 远端：一段只读脚本（getent / nslookup / host、bash /dev/tcp 或 nc、curl 或 wget），各目标并行，输出按目标分块；
// 本机：主进程用 Node 的 dns / net / fetch（desktop/main/ops/connProbe.ts）。这里是目标解析、脚本拼装、输出解析、矩阵汇总。
import { shq } from '../files/explorer.js'
import { tk, tr } from '../i18n/i18n.js'

export type ProbeCheck = 'dns' | 'tcp' | 'http'
export const PROBE_CHECKS: ProbeCheck[] = ['dns', 'tcp', 'http']
export const PROBE_CHECK_LABEL: Record<ProbeCheck, string> = { dns: 'DNS', tcp: 'TCP', http: 'HTTP' }
export interface ProbeTarget { raw: string; host: string; port?: number; url?: string }
export const PROBE_MAX_TARGETS = 20
export const PROBE_MAX_SOURCES = 20
export const PROBE_TCP_TIMEOUT_SEC = 3
export const PROBE_DNS_TIMEOUT_SEC = 5
export const PROBE_HTTP_TIMEOUT_SEC = 8
export const PROBE_RUN_TIMEOUT_MS = 30_000

/** 一项检查的结果。ok / warn（HTTP 通了但状态码 4xx/5xx）/ fail / na（源主机上没有可用命令）/ skip（不适用，如 IP 不用解析） */
export type ProbeStatus = 'ok' | 'warn' | 'fail' | 'na' | 'skip'
export interface ProbeItem { check: ProbeCheck; status: ProbeStatus; ms?: number; detail?: string; tool?: string; raw?: string }
export interface ProbeCell { items: ProbeItem[] }   // 一个源 × 一个目标
export interface ProbeSourceResult { cells: ProbeCell[]; error?: string; raw?: string }

const isIp = (h: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')
const HOST_RE = /^[A-Za-z0-9._-]{1,253}$/

/** 解析目标（每行或逗号 / 空格分隔）：URL、host:port、[v6]:port、裸域名 / IP。返回合法的和出错的 */
export function parseProbeTargets(text: string): { targets: ProbeTarget[]; errors: string[] } {
  const targets: ProbeTarget[] = [], errors: string[] = []
  const seen = new Set<string>()
  for (const raw of text.split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean)) {
    if (seen.has(raw)) continue
    seen.add(raw)
    let t: ProbeTarget | undefined
    if (/^https?:\/\//i.test(raw)) {
      try {
        const u = new URL(raw)
        // URL 里的账号密码（https://user:pass@host）不进远端 curl 命令行（同机其他用户 ps 能看到）、也不进结果和 AI：去掉
        if (u.username || u.password) { u.username = ''; u.password = '' }
        const host = u.hostname.replace(/^\[|\]$/g, '')
        const clean = u.toString()
        t = { raw: clean, host, port: u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80, url: clean }
      } catch { /* 下面报错 */ }
    } else if ((raw.match(/:/g) ?? []).length >= 2 && !raw.startsWith('[')) {
      // 不带方括号的 IPv6（::1 / fe80::1）：整个当地址，不拆端口（要端口请写 [v6]:port）
      if (/^[0-9a-fA-F:.]+$/.test(raw)) t = { raw, host: raw }
    } else {
      const m = /^\[([0-9a-fA-F:.]+)\](?::(\d{1,5}))?$/.exec(raw) ?? /^([^:]+)(?::(\d{1,5}))?$/.exec(raw)
      if (m) t = { raw, host: m[1], ...(m[2] ? { port: Number(m[2]) } : {}) }
    }
    if (!t || !(HOST_RE.test(t.host) || isIp(t.host)) || (t.port !== undefined && (t.port < 1 || t.port > 65535))) { errors.push(raw); continue }
    targets.push(t)
  }
  if (targets.length > PROBE_MAX_TARGETS) { errors.push(tr('最多 {n} 个目标', { n: PROBE_MAX_TARGETS })); targets.length = PROBE_MAX_TARGETS }
  return { targets, errors }
}

/** 这个目标要做哪些检查（用户勾选的 ∩ 目标适用的）。不适用的标 skip */
export function plannedChecks(t: ProbeTarget, checks: ProbeCheck[]): { check: ProbeCheck; skip?: string }[] {
  return checks.map((c) => {
    if (c === 'dns' && isIp(t.host)) return { check: c, skip: tr('是 IP，无需解析') }
    if (c === 'tcp' && !t.port) return { check: c, skip: tr('没写端口') }
    if (c === 'http' && !t.url) return { check: c, skip: tr('不是 URL') }
    return { check: c }
  })
}

/** 校验渲染层传来的目标（当不可信）：重新按 raw 解析一遍 */
export function sanitizeProbeTargets(v: unknown): ProbeTarget[] {
  const raws = Array.isArray(v) ? v.map((x) => (x as { raw?: unknown })?.raw).filter((x): x is string => typeof x === 'string') : []
  const { targets } = parseProbeTargets(raws.join('\n'))
  if (!targets.length) throw new Error(tr('请填写目标'))
  return targets
}
export const sanitizeProbeChecks = (v: unknown): ProbeCheck[] => {
  const cs = Array.isArray(v) ? PROBE_CHECKS.filter((c) => v.includes(c)) : []
  if (!cs.length) throw new Error(tr('请至少勾选一项检查'))
  return cs
}

const B = '@@PB'   // 块开始：@@PB <目标序号> <检查> <工具> <退出码> <毫秒>
const E = '@@PE'

/**
 * 远端探测脚本（只读）。各目标在子 shell 里并行，每项检查一结束就把整块写到 stdout：
 * 一次 printf 写一整块（≤ 2000 字节输出 + 头尾，小于管道原子写的 4KB），多个子 shell 同时写也不会交错；
 * 某个目标卡住（DNS 不通、TCP 超时）时，早就测完的格子照样有结果。
 * 每项检查输出一块：@@PB i check tool rc ms + 原始输出（截 2000 字节）+ @@PE。工具为 none 表示源主机上没有可用命令。
 * 外层优先用 bash（/dev/tcp 要 bash），没有 bash 时用 sh（只能用 nc 测 TCP）。
 */
export function probeScript(targets: ProbeTarget[], checks: ProbeCheck[]): string {
  const T = PROBE_TCP_TIMEOUT_SEC, H = PROBE_HTTP_TIMEOUT_SEC
  const lines: string[] = [
    'ms() { d=$(date +%s%N 2>/dev/null); case "$d" in *N|"") echo 0 ;; *) echo $((d/1000000)) ;; esac; }',
    'have() { command -v "$1" >/dev/null 2>&1; }',
    // 有 timeout 就套一层：getent / nslookup 在 DNS 不通时可能卡很久
    `to() { if have timeout; then timeout ${PROBE_DNS_TIMEOUT_SEC} "$@"; else "$@"; fi; }`,
    // blk 序号 检查 工具 命令…：跑命令、记退出码和耗时，一次 printf 写一整块
    `blk() { i=$1; c=$2; tool=$3; shift 3; s=$(ms); o=$("$@" 2>&1 </dev/null); rc=$?; e=$(ms); [ "$s" -gt 0 ] && t=$((e-s)) || t=-1; printf '${B} %s %s %s %s %s\\n%s\\n${E}\\n' "$i" "$c" "$tool" "$rc" "$t" "$(printf '%s' "$o" | head -c 2000)"; }`,
    `none() { printf '${B} %s %s none 127 -1\\n${E}\\n' "$1" "$2"; }`,
    `dns() { if have getent; then blk $1 dns getent to getent ahosts "$2"; elif have nslookup; then blk $1 dns nslookup to nslookup "$2"; elif have host; then blk $1 dns host to host "$2"; else none $1 dns; fi; }`,
    `tcp() { if [ -n "$BASH_VERSION" ] && have timeout; then blk $1 tcp bash timeout ${T} bash -c 'exec 3<>"/dev/tcp/$0/$1"' "$2" "$3"; elif have nc; then blk $1 tcp nc nc -z -v -w ${T} "$2" "$3"; else none $1 tcp; fi; }`,
    `http() { if have curl; then blk $1 http curl curl -sS -o /dev/null -m ${H} -w '%{http_code} %{time_total}' "$2"; elif have wget; then blk $1 http wget wget -S -O /dev/null -T ${H} --tries=1 "$2"; else none $1 http; fi; }`,
  ]
  targets.forEach((t, i) => {
    const parts = plannedChecks(t, checks).filter((x) => !x.skip).map(({ check }) =>
      check === 'dns' ? `dns ${i} ${shq(t.host)}` : check === 'tcp' ? `tcp ${i} ${shq(t.host)} ${t.port}` : `http ${i} ${shq(t.url!)}`)
    if (parts.length) lines.push(`( ${parts.join('; ')} ) &`)
  })
  lines.push('wait')
  const script = lines.join('\n')
  return `if command -v bash >/dev/null 2>&1; then bash -c ${shq(script)}; else sh -c ${shq(script)}; fi`
}

// ── 解析 ──────────────────────────────────────────────
/** 失败原因（中文短语），按工具与输出判断 */
export function tcpReason(rc: number, out: string): string {
  if (rc === 124 || /timed? ?out/i.test(out)) return tr('超时')
  if (/refused/i.test(out)) return tr('拒绝连接')
  if (/no route|unreachable/i.test(out)) return tr('网络不可达')
  if (/reset by peer/i.test(out)) return tr('连接被重置')
  if (/not known|unknown host|resolve|name.*not|getaddrinfo|could not resolve/i.test(out)) return tr('解析失败')
  return tr('连接失败')
}
const CURL_REASON: Record<number, string> = { 6: tk('解析失败'), 7: tk('无法连接'), 28: tk('超时'), 35: tk('TLS 握手失败'), 51: tk('证书不匹配'), 52: tk('空响应'), 56: tk('接收失败'), 58: tk('证书错误'), 60: tk('证书不受信任'), 77: tk('证书错误'), 83: tk('证书错误'), 90: tk('证书错误'), 91: tk('证书错误') }

/** 解析 HTTP 状态码给出 ok / warn */
const httpStatus = (code: number): ProbeStatus => (code >= 200 && code < 400 ? 'ok' : code > 0 ? 'warn' : 'fail')

/** 一块（一项检查）的原始输出 → 结果 */
export function parseProbeBlock(check: ProbeCheck, tool: string, rc: number, ms: number, raw: string): ProbeItem {
  const base = { check, tool, raw, ...(ms >= 0 ? { ms } : {}) }
  const out = raw.trim()
  if (tool === 'none') {
    const need = check === 'dns' ? 'getent / nslookup / host' : check === 'tcp' ? tr('bash + timeout 或 nc') : tr('curl 或 wget')
    return { check, status: 'na', detail: tr('源主机上没有 {need}', { need }) }
  }
  if (check === 'dns') {
    let ips: string[] = []
    if (tool === 'getent') ips = out.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean)
    else if (tool === 'nslookup') {
      // 跳过开头 DNS 服务器自己的地址（Server / Address 那段）
      const ans = out.split(/\n\s*\n/).slice(1).join('\n')
      ips = [...ans.matchAll(/Address(?:es)?:\s*([0-9a-fA-F:.]+)/g)].map((m) => m[1])
    } else if (tool === 'host') ips = [...out.matchAll(/has (?:IPv6 )?address ([0-9a-fA-F:.]+)/g)].map((m) => m[1])
    ips = [...new Set(ips)]
    if (rc === 0 && ips.length) return { ...base, status: 'ok', detail: ips.slice(0, 4).join(', ') + (ips.length > 4 ? tr(' 等 {n} 个', { n: ips.length }) : '') }
    // 124 = 被 timeout 杀掉：DNS 服务器不响应，和「域名不存在」是两回事
    return { ...base, status: 'fail', detail: rc === 124 || /timed? ?out|no servers/i.test(out) ? tr('DNS 超时') : tr('解析失败') }
  }
  if (check === 'tcp') return rc === 0 ? { ...base, status: 'ok', detail: tr('端口可连') } : { ...base, status: 'fail', detail: tcpReason(rc, out) }
  // http
  if (tool === 'curl') {
    // -w 的「状态码 耗时」在最前；23（写 /dev/null 出错，个别 Windows 版 curl）时状态码已拿到，照样算
    const m = /^(\d{3}) ([\d.]+)/.exec(out)
    if ((rc === 0 || rc === 23) && m && m[1] !== '000') {
      const code = Number(m[1])
      return { ...base, ms: Math.round(Number(m[2]) * 1000), status: httpStatus(code), detail: `HTTP ${code}` }
    }
    return { ...base, status: 'fail', detail: (CURL_REASON[rc] && tr(CURL_REASON[rc])) ?? (out.split('\n').find((l) => l.startsWith('curl:'))?.replace(/^curl: \(\d+\)\s*/, '') || tr('curl 退出码 {n}', { n: rc })) }
  }
  // wget：-S 的响应头里取最后一个状态码；4xx/5xx 时 wget 退出码 8
  const codes = [...out.matchAll(/HTTP\/[\d.]+ (\d{3})/g)].map((m) => Number(m[1]))
  const code = codes.at(-1)
  if (code) return { ...base, status: httpStatus(code), detail: `HTTP ${code}` }
  return { ...base, status: 'fail', detail: rc === 5 ? tr('证书错误') : /unable to resolve|failed: Name/i.test(out) ? tr('解析失败') : tcpReason(rc, out) }
}

/** 整段输出 → 每个目标一格。没出现的检查（如脚本被中断）标 fail「没有结果」 */
export function parseProbeOutput(output: string, targets: ProbeTarget[], checks: ProbeCheck[]): ProbeCell[] {
  const got = new Map<string, ProbeItem>()
  const re = new RegExp(`^${B} (\\d+) (dns|tcp|http) (\\S+) (\\d+) (-?\\d+)\\n([\\s\\S]*?)\\n?${E}$`, 'gm')
  for (const m of output.replace(/\r\n/g, '\n').matchAll(re)) {
    got.set(`${m[1]}:${m[2]}`, parseProbeBlock(m[2] as ProbeCheck, m[3], Number(m[4]), Number(m[5]), m[6]))
  }
  return targets.map((t, i) => ({
    items: plannedChecks(t, checks).map(({ check, skip }) => skip ? { check, status: 'skip' as const, detail: skip } : got.get(`${i}:${check}`) ?? { check, status: 'fail' as const, detail: tr('没有结果（超时或被中断）') }),
  }))
}

// ── 本机（Node）错误 → 原因 ──────────────────────────────
export function nodeErrReason(code: string | undefined, message = ''): string {
  const c = code ?? ''
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN' || c === 'EAI_NONAME') return tr('解析失败')
  if (c === 'ECONNREFUSED') return tr('拒绝连接')
  if (c === 'ETIMEDOUT' || c === 'TIMEOUT' || c === 'UND_ERR_CONNECT_TIMEOUT' || /timeout|aborted/i.test(message)) return tr('超时')
  if (c === 'EHOSTUNREACH' || c === 'ENETUNREACH') return tr('网络不可达')
  if (c === 'ECONNRESET') return tr('连接被重置')
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|SSL/i.test(c + ' ' + message)) return tr('证书错误')
  return message || c || tr('失败')
}

// ── 汇总 ──────────────────────────────────────────────
const RANK: Record<ProbeStatus, number> = { skip: 0, ok: 1, na: 2, warn: 3, fail: 4 }
/** 一格的总体：最差的那项；全是 skip → skip */
export function cellStatus(c: ProbeCell): ProbeStatus {
  return c.items.reduce<ProbeStatus>((w, x) => (RANK[x.status] > RANK[w] ? x.status : w), 'skip')
}
/** 格子里显示的短文字：通 → ✓ + 最后一项的耗时；不通 → ✗ + 第一项失败的原因 */
export function cellText(c: ProbeCell): string {
  const s = cellStatus(c)
  if (s === 'skip') return '—'
  const bad = c.items.find((x) => x.status === s)
  if (s === 'fail') return `✗ ${bad?.detail ?? tr('失败')}`
  if (s === 'warn') return `! ${bad?.detail ?? ''}`
  if (s === 'na') return `? ${tr('{check} 无法测', { check: PROBE_CHECK_LABEL[bad!.check] })}`
  const ms = [...c.items].reverse().find((x) => x.status === 'ok' && x.ms !== undefined)?.ms
  return `✓${ms !== undefined ? ` ${ms}ms` : ''}`
}
export const probeStatusText: Record<ProbeStatus, string> = { ok: tk('通'), warn: tk('有响应但状态异常'), fail: tk('不通'), na: tk('无法测'), skip: tk('不适用') }

/** 矩阵 → Markdown（复制 / 让 AI 分析） */
export function probeMarkdown(sources: string[], targets: ProbeTarget[], rows: (ProbeSourceResult | undefined)[]): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|')
  const out = [`| ${tr('源 \\ 目标')} | ${targets.map((t) => esc(t.raw)).join(' | ')} |`, `| --- |${targets.map(() => ' --- |').join('')}`]
  sources.forEach((s, i) => {
    const r = rows[i]
    // 与界面一致：有部分结果就照样显示格子，只有一格都没有时才整行写「连接失败」
    const whole = !!r?.error && !r.cells.length
    out.push(`| ${esc(s)} | ${targets.map((_, j) => (whole ? tr('连接失败：{v}', { v: esc(r!.error!) }) : r?.cells[j] ? esc(cellText(r.cells[j])) : tr('未测'))).join(' | ')} |`)
  })
  const partial = sources.flatMap((s, i) => (rows[i]?.error && rows[i]!.cells.length ? [`- ${s}${tr('：')}${rows[i]!.error}${tr('（以上为部分结果）')}`] : []))
  const fails: string[] = []
  sources.forEach((s, i) => rows[i]?.cells.forEach((c, j) => c.items.forEach((x) => {
    if (x.status === 'fail' || x.status === 'warn' || x.status === 'na') fails.push(`- ${s} → ${targets[j].raw}${tr('：')}${PROBE_CHECK_LABEL[x.check]} ${tr(probeStatusText[x.status])}${x.detail ? tr('（{v}）', { v: x.detail }) : ''}`)
  })))
  return out.join('\n') + (fails.length ? `\n\n**${tr('异常明细')}**\n${fails.join('\n')}` : '') + (partial.length ? `\n\n**${tr('未完成的源')}**\n${partial.join('\n')}` : '') + '\n'
}
