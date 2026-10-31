// 无人值守巡检的命令白名单：判断一条 shell 命令是否「只读」。
//
// 背景：exec_in_terminal 在授权模型里算 write（能跑任意命令），而巡检没人点授权卡。
// 给巡检会话 write 授权等于放任 AI 无人看管地改服务器，所以巡检会话里的 exec 只放行
// 能确认是只读的命令，其余一律自动拒绝（AI 会收到拒绝原因，换只读方式或在报告里说明）。
//
// 保守优先：宁可误拒。不认识的命令、命令替换、写重定向、sudo、能执行任意代码的
// 解释器（sh/bash/awk/sed/xargs/env/find -exec …）全拒。

// 命令 → 额外校验（返回 false 拒绝）；值为 true 表示无参数限制
const SAFE: Record<string, true | ((args: string[]) => boolean)> = {}
for (const c of ('df du free uptime uname whoami id cat head tail grep egrep fgrep zgrep zcat wc cut tr '
  + 'ls stat file pwd echo printf true test which basename dirname realpath readlink ps pgrep pidof netstat lsof '
  + 'vmstat iostat mpstat lsblk blkid nproc lscpu last w who getent printenv ping dig nslookup host tracepath '
  + 'traceroute cd md5sum sha256sum diff column tac nl jq').split(' ')) SAFE[c] = true

const has = (args: string[], ...bad: string[]) => args.some((a) => bad.some((b) => a === b || a.startsWith(b + '=')))
const sub = (ok: string[]) => (args: string[]) => {
  const first = args.find((a) => !a.startsWith('-'))
  return first !== undefined && ok.includes(first)
}
Object.assign(SAFE, {
  systemctl: sub(['status', 'is-active', 'is-enabled', 'is-failed', 'list-units', 'list-timers', 'list-unit-files', 'show', 'cat']),
  service: (a: string[]) => a.length === 2 && a[1] === 'status',
  journalctl: (a: string[]) => !a.some((x) => /^--(vacuum|rotate|flush|sync|relinquish|setup-keys)/.test(x)),
  docker: sub(['ps', 'images', 'inspect', 'logs', 'stats', 'top', 'version', 'info', 'port']),
  kubectl: sub(['get', 'describe', 'top', 'logs', 'version', 'cluster-info']),
  find: (a: string[]) => !has(a, '-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprintf', '-fls', '-fprint0'),
  top: (a: string[]) => a.some((x) => /^-\w*b/.test(x)),            // 只允许批处理模式（-b / -bn1）
  dmesg: (a: string[]) => !a.some((x) => /^-\w*[cCD]/.test(x) || x === '--clear' || x === '--read-clear'),
  sysctl: (a: string[]) => !a.some((x) => x.includes('=') || /^-\w*w/.test(x) || x === '--write' || x === '--load' || /^-\w*p/.test(x)),
  crontab: (a: string[]) => a.length === 1 && a[0] === '-l',
  // ip netns exec <ns> <任意命令> = 可执行任意程序；-batch 从文件执行 ip 命令
  ip: (a: string[]) => !a.some((x) => ['add', 'del', 'delete', 'set', 'change', 'replace', 'flush', 'append', 'netns', 'exec', '-batch', '--batch', '-force'].includes(x)),
  nginx: (a: string[]) => a.length > 0 && a.every((x) => x === '-t' || x === '-T' || x === '-v' || x === '-V'),
  openssl: (a: string[]) => sub(['x509', 's_client', 'version', 'verify'])(a) && !a.some((x) => /^-(out|keyout|sess_out|keylogfile)/.test(x)),
  date: (a: string[]) => !a.some((x) => /^-\w*s/.test(x) || x.startsWith('--set')),
  hostname: (a: string[]) => a.every((x) => /^-[fiIsdA]+$/.test(x)),   // 带非选项参数 = 改主机名
  ss: (a: string[]) => !a.some((x) => /^-\w*K/.test(x) || x === '--kill'),
  // -o / --output 写结果文件；--compress-program 会执行指定程序；-T 写临时文件
  sort: (a: string[]) => !a.some((x) => /^-\w*o/.test(x) || /^-\w*T/.test(x) || x.startsWith('--output') || x.startsWith('--compress-program') || x.startsWith('--temporary-directory')),
  uniq: (a: string[]) => a.filter((x) => !x.startsWith('-')).length <= 1,   // 第二个位置参数是输出文件
  // 写文件 / 写 cookie / trace 到文件 / 读配置文件一律拒
  curl: (a: string[]) => !a.some((x) => /^-\w*[oOTXdFKucCD]/.test(x) || /^--(output|remote-name|upload-file|request|data|form|config|user|cookie|trace|stderr|output-dir|dump-header)/.test(x)),
  timedatectl: (a: string[]) => a.length === 0 || a[0] === 'status' || a[0] === 'show',
  hostnamectl: (a: string[]) => a.length === 0 || a[0] === 'status',
  mount: (a: string[]) => a.length === 0,
  file: (a: string[]) => !has(a, '-C', '--compile'),   // -C -m 编译 magic 文件（写文件）
} satisfies Record<string, (args: string[]) => boolean>)

/** 把引号内的字符替换成占位符（保持下标），用于结构分析；同时返回各引号段是否含命令替换 */
function mask(cmd: string): { masked: string; unsafe: boolean } {
  let out = '', q: '' | "'" | '"' = '', unsafe = false
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (q === "'") { if (c === "'") { q = ''; out += c } else out += 'x'; continue }
    if (c === '\\') { unsafe = true; break }   // 反斜杠转义会让分析失真，直接拒
    if (q === '"') {
      if (c === '"') { q = ''; out += c } else if (c === '`' || (c === '$' && cmd[i + 1] === '(')) { unsafe = true; break } else out += 'x'
      continue
    }
    if (c === "'" || c === '"') q = c
    out += c
  }
  return { masked: out, unsafe: unsafe || q !== '' }
}

/** 把一段命令（已无管道/分隔符）切成词，去掉引号 */
function words(seg: string): string[] {
  const out: string[] = []
  for (const m of seg.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

export function isReadOnlyCommand(cmd: string): boolean {
  if (!cmd.trim()) return false
  const { masked, unsafe } = mask(cmd)
  if (unsafe) return false
  if (/<\(|<</.test(masked)) return false
  // 无害重定向（丢弃输出 / 合并 stderr / 从文件读）在原文和掩码上同位置抹成空格，保持下标对齐
  let cleaned = masked, src = cmd
  for (const m of masked.matchAll(/\d?>&\d|&>\s*\/dev\/null|\d?>>?\s*\/dev\/null|<\s*[^\s|;&<>]+/g)) {
    const blank = ' '.repeat(m[0].length), at = m.index
    cleaned = cleaned.slice(0, at) + blank + cleaned.slice(at + blank.length)
    src = src.slice(0, at) + blank + src.slice(at + blank.length)
  }
  if (/[`>]|\$\(|\$\{/.test(cleaned)) return false
  // 分隔：&& || ; | 换行；单个 & （后台）拒
  const parts: [number, number][] = []
  let start = 0
  for (let i = 0; i < cleaned.length; i++) {
    const two = cleaned.slice(i, i + 2)
    if (two === '&&' || two === '||') { parts.push([start, i]); start = i + 2; i++; continue }
    const c = cleaned[i]
    if (c === '&') return false
    if (c === ';' || c === '|' || c === '\n') { parts.push([start, i]); start = i + 1 }
  }
  parts.push([start, cleaned.length])
  for (const [a, b] of parts) {
    const seg = src.slice(a, b).trim()   // 用原文（保留引号内容）给参数校验
    if (!seg) continue
    const [name, ...args] = words(seg)
    if (/=/.test(name)) return false                   // VAR=x cmd：可改环境影响行为
    const rule = SAFE[name.replace(/^.*\//, '')]      // /usr/bin/df → df
    if (!rule) return false
    if (rule !== true && !rule(args)) return false
  }
  return true
}

/**
 * 生产主机上，命中只读白名单的命令按「读」来授权：生产主机的写操作每条都要确认，
 * 但 cat / ls / grep 这类查看命令也被算成写（exec 一律是 write），排查时要连点几十次。
 * 仍需该主机的读取授权（首次照样弹卡）；非生产主机不变。
 */
export function neededForExec(needed: 'read' | 'write', command: string | undefined, prod: boolean): 'read' | 'write' {
  return prod && needed === 'write' && command !== undefined && isReadOnlyCommand(command) ? 'read' : needed
}
