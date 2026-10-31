// 本机视图（纯解析）：本地终端也能开「进程」「监听端口」「容器」抽屉。
// Windows：netstat -ano（TCP LISTENING）+ tasklist /fo csv /nh（PID → 进程名 / 内存）；macOS：lsof -iTCP -sTCP:LISTEN；
// Linux 本机直接用 SSH 那套 ss / ps 命令（见 ports.ts / processes.ts）。解析成和 SSH 一样的 ListenPort / ProcRow，抽屉不用分两套。
import { splitHostPort } from '../ops/ports.js'
import type { ListenPort } from '../ops/index.js'
import type { ProcRow } from '../ops/index.js'

export interface WinTask { name: string; pid: number; session: string; memKB?: number }

/** 一行 CSV（tasklist 的格式：每个字段都带双引号，内部双引号写成 ""） */
export function csvFields(line: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < line.length) {
    if (line[i] === '"') {
      let v = ''
      i++
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { v += '"'; i += 2 } else if (line[i] === '"') { i++; break } else v += line[i++]
      }
      out.push(v)
      if (line[i] === ',') i++
    } else {
      const j = line.indexOf(',', i)
      out.push(line.slice(i, j < 0 ? line.length : j).trim())
      i = j < 0 ? line.length : j + 1
    }
  }
  return out
}

/** tasklist /fo csv /nh：「映像名称","PID","会话名","会话#","内存使用」（内存形如 12,345 K，各语言版本都是数字 + K） */
export function parseTasklist(text: string): WinTask[] {
  const out: WinTask[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('"')) continue
    const f = csvFields(line)
    const pid = Number(f[1])
    if (f.length < 2 || !Number.isInteger(pid)) continue
    const mem = f[4] ? Number(f[4].replace(/[^\d]/g, '')) : NaN
    out.push({ name: f[0], pid, session: f[2] ?? '', ...(Number.isFinite(mem) && f[4] && /\d/.test(f[4]) ? { memKB: mem } : {}) })
  }
  return out
}

/** tasklist → 进程抽屉的行（Windows 没有 CPU% / 父进程 / 命令行，命令列放映像名） */
export function tasksToProcRows(tasks: WinTask[]): ProcRow[] {
  return tasks.filter((t) => t.pid > 0).map((t) => ({ pid: t.pid, user: t.session, rss: t.memKB, etime: '', stat: '', command: t.name }))
}

/** netstat -ano：只要 TCP 的监听行。状态列是本地化的（德语 ABHÖREN 等），改用外部地址 :0 判断监听 */
export function parseNetstatAno(text: string, names: Map<number, string> = new Map()): ListenPort[] {
  const seen = new Set<string>()
  const rows: ListenPort[] = []
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim().split(/\s+/)
    // 监听行的外部地址是 0.0.0.0:0 / [::]:0；状态文字仅作兜底（英文系统）
    if (t.length < 5 || !/^TCP(v6)?$/i.test(t[0]) || !(/:0$/.test(t[2] ?? '') || t[3].toUpperCase() === 'LISTENING')) continue
    const hp = splitHostPort(t[1])
    const pid = Number(t[4])
    if (!hp || !Number.isInteger(pid) || seen.has(`${hp.addr}|${hp.port}`)) continue
    seen.add(`${hp.addr}|${hp.port}`)
    const name = names.get(pid)
    rows.push({ proto: hp.addr.includes(':') ? 'tcp6' : 'tcp', ...hp, pid, ...(name ? { process: name } : pid === 4 ? { process: 'System' } : {}) })
  }
  return rows.sort((a, b) => a.port - b.port || (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0))
}

/** lsof -nP -iTCP -sTCP:LISTEN：COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME，NAME 形如 *:3000 (LISTEN) / [::1]:5432 */
export function parseLsofListen(text: string): ListenPort[] {
  const seen = new Set<string>()
  const rows: ListenPort[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!/\(LISTEN\)\s*$/.test(line)) continue
    const t = line.trim().split(/\s+/)
    const pid = Number(t[1])
    const hp = splitHostPort(t[t.length - 2] ?? '')
    if (!hp || !Number.isInteger(pid) || seen.has(`${hp.addr}|${hp.port}`)) continue
    seen.add(`${hp.addr}|${hp.port}`)
    rows.push({ proto: t[4] === 'IPv6' ? 'tcp6' : 'tcp', ...hp, pid, process: t[0].replace(/\\x20/g, ' ') })
  }
  return rows.sort((a, b) => a.port - b.port || (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0))
}

/** Windows 结束进程：TERM = taskkill（请求窗口程序自己退出），KILL = taskkill /F（强制）；HUP 没有对应 */
export function taskkillArgs(pid: number, force: boolean): string[] {
  return force ? ['/F', '/PID', String(pid)] : ['/PID', String(pid)]
}
