// 防火墙规则可读化：探测 firewalld / ufw / nftables / iptables（有哪个读哪个），解析成「方向 / 动作 / 协议 / 端口 / 来源 / 说明」表格。
// 只读，不改规则。读规则多半要 root：root 直接跑，否则 sudo -n（免密 sudo 才行，要密码的标「需要 root」）。走独立 exec channel
import { shq } from '../files/explorer.js'
import { splitHostPort } from './ports.js'
import { tk, tr } from '../i18n/i18n.js'

export const FIREWALL_TIMEOUT_MS = 20_000
export type FwTool = 'firewalld' | 'ufw' | 'nft' | 'iptables'
export type FwDir = 'in' | 'out' | 'fwd' | 'other'
export type FwAction = 'allow' | 'deny' | 'reject' | 'other'
export interface FwRule {
  dir: FwDir
  action: FwAction
  proto?: string        // tcp / udp / icmp …（空 = 全部）
  port?: string         // 22 / 80,443 / 60000-61000（空 = 全部端口）
  source?: string       // 空 = 任何地址
  iface?: string
  chain?: string        // nft / iptables 的链；firewalld 的 zone
  text: string          // 人话：「允许任何地址访问 22/tcp（ssh）」
  raw: string
}
export interface FwSection {
  tool: FwTool
  active: boolean       // firewalld running / ufw active / 有规则
  denied?: boolean      // 没权限读（要 root）
  policy: string[]      // 默认策略（人话）
  rules: FwRule[]
  raw: string           // 原始输出（给「问 AI」和原文查看）
}
export interface FwList { sections: FwSection[]; listen: string; primary?: FwTool }

export const FW_TOOL_LABEL: Record<FwTool, string> = { firewalld: 'firewalld', ufw: 'ufw', nft: 'nftables', iptables: 'iptables' }
export const FW_DIR_LABEL: Record<FwDir, string> = { in: tk('入站'), out: tk('出站'), fwd: tk('转发'), other: tk('其他') }
export const FW_ACTION_LABEL: Record<FwAction, string> = { allow: tk('允许'), deny: tk('拒绝'), reject: tk('拒绝（回 RST/ICMP）'), other: tk('其他') }

export const firewallListCommand = () => `sh -c ${shq([
  'export LC_ALL=C',
  'r() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi; }',
  'if command -v firewall-cmd >/dev/null 2>&1; then echo "@@tool:firewalld"; st=$(r firewall-cmd --state 2>&1); echo "@@state:$st"',
  '  if [ "$st" = running ]; then for z in $( (r firewall-cmd --get-active-zones; r firewall-cmd --get-default-zone) 2>/dev/null | grep -v "^[[:space:]]" | sort -u); do echo "@@zone:$z"; r firewall-cmd --list-all --zone="$z" 2>&1; done; fi; fi',
  'if command -v ufw >/dev/null 2>&1; then echo "@@tool:ufw"; r ufw status verbose 2>&1; fi',
  'if command -v nft >/dev/null 2>&1; then echo "@@tool:nft"; r nft list ruleset 2>&1; fi',
  'if command -v iptables >/dev/null 2>&1; then echo "@@tool:iptables"; r iptables -S 2>&1; echo "@@part:L"; r iptables -L -n -v 2>&1; fi',
  'echo "@@ss"; ss -ltnupH 2>/dev/null || ss -ltnup 2>/dev/null || netstat -ltnup 2>/dev/null',
].join('\n'))}`

const DENIED = /a password is required|a terminal is required|permission denied|operation not permitted|must be root|you need to be root|not permitted|access denied/i
// firewalld / ufw 的常见服务名 → 端口
const SERVICES: Record<string, string> = {
  ssh: '22/tcp', http: '80/tcp', https: '443/tcp', mysql: '3306/tcp', postgresql: '5432/tcp', redis: '6379/tcp', 'dhcpv6-client': '546/udp', dhcp: '67/udp',
  cockpit: '9090/tcp', dns: '53/tcp,udp', ftp: '21/tcp', smtp: '25/tcp', ntp: '123/udp', mongodb: '27017/tcp', openssh: '22/tcp', 'nginx full': '80,443/tcp', 'nginx http': '80/tcp', 'nginx https': '443/tcp',
  'apache full': '80,443/tcp', samba: '139,445/tcp', nfs: '2049/tcp', 'mdns': '5353/udp', kubernetes: '6443/tcp',
}
const any = (s?: string) => !s || /^(anywhere|any|0\.0\.0\.0\/0|::\/0|\*)$/i.test(s.replace(/\s*\(v6\)$/i, ''))
const portText = (proto?: string, port?: string) => (port ? `${port}${proto ? `/${proto}` : ''}` : proto && proto !== 'all' ? tr('所有 {proto} 端口', { proto }) : tr('所有端口'))

/** 规则说明（人话） */
export function ruleText(r: Omit<FwRule, 'text' | 'raw'>, extra = ''): string {
  const who = any(r.source) ? tr('任何地址') : ` ${r.source} `
  const p = portText(r.proto, r.port), what = !r.port ? p : ` ${p}`   // 「所有端口」前面不加空格（中文「访问所有端口」/「访问 22/tcp」）
  const act = r.action === 'allow' ? tr('允许') : r.action === 'other' ? tr('fw|处理') : tr('拒绝')
  const via = r.iface ? tr('（网卡 {iface}）', { iface: r.iface }) : ''
  const s = r.dir === 'out' ? tr('{act}本机访问{dest}{what}', { act, dest: any(r.source) ? '' : tr(' {src} 的', { src: r.source! }), what })
    : r.dir === 'fwd' ? tr('{act}转发{who}→{what}', { act, who, what }) : tr('{act}{who}访问{what}', { act, who, what })
  return `${s}${via}${extra}`.replace(/\s+/g, ' ').trim()
}
const mk = (r: Omit<FwRule, 'text' | 'raw'>, raw: string, extra = ''): FwRule => ({ ...r, text: ruleText(r, extra), raw })

// ── firewalld：firewall-cmd --list-all --zone=x ──
export function parseFirewalld(zone: string, text: string): { rules: FwRule[]; policy: string[] } {
  const rules: FwRule[] = [], policy: string[] = []
  const kv = new Map<string, string>()
  const rich: string[] = []
  let inRich = false
  for (const l of text.replace(/\r/g, '').split('\n')) {
    const m = /^\s+([a-z-]+(?: rules)?):\s*(.*)$/.exec(l)
    if (m) { inRich = m[1] === 'rich rules'; kv.set(m[1], m[2].trim()); if (inRich && m[2].trim()) rich.push(m[2].trim()); continue }
    if (inRich && l.trim()) rich.push(l.trim())
  }
  const sources = kv.get('sources') || ''
  const src = sources || undefined
  for (const s of (kv.get('services') || '').split(/\s+/).filter(Boolean)) {
    const p = SERVICES[s]
    const [port, proto] = p ? p.split('/') : [undefined, undefined]
    rules.push(mk({ dir: 'in', action: 'allow', proto, port, source: src, chain: zone }, `service ${s}`, tr('（服务 {name}）', { name: s })))
  }
  for (const p of (kv.get('ports') || '').split(/\s+/).filter(Boolean)) {
    const [port, proto] = p.split('/')
    rules.push(mk({ dir: 'in', action: 'allow', proto, port, source: src, chain: zone }, `port ${p}`))
  }
  for (const fp of (kv.get('forward-ports') || '').split(/\s+/).filter(Boolean)) {
    const g = (k: string) => new RegExp(`${k}=([^:]*)`).exec(fp)?.[1] || ''
    rules.push({ dir: 'fwd', action: 'allow', proto: g('proto'), port: g('port'), chain: zone, raw: fp, text: tr('端口转发：{from} → {to}', { from: `${g('port')}/${g('proto')}`, to: `${g('toaddr') || tr('frag|本机')}:${g('toport') || g('port')}` }) })
  }
  for (const r of rich) {
    const g = (re: RegExp) => re.exec(r)?.[1]
    const svc = g(/service name="([^"]+)"/)
    const p = svc ? SERVICES[svc]?.split('/') : undefined
    const action: FwAction = /\baccept\b/.test(r) ? 'allow' : /\breject\b/.test(r) ? 'reject' : /\bdrop\b/.test(r) ? 'deny' : 'other'
    rules.push(mk({
      dir: 'in', action, chain: zone,
      source: g(/source (?:NOT )?address="([^"]+)"/) ?? g(/source ipset="([^"]+)"/),
      port: g(/port port="([^"]+)"/) ?? p?.[0], proto: g(/protocol="([^"]+)"/) ?? p?.[1],
    }, r, svc ? tr('（服务 {name}）', { name: svc }) : /source NOT/.test(r) ? tr('（来源取反）') : ''))
  }
  const target = kv.get('target') || 'default'
  const zoneText = tr('区域 {zone}', { zone }) + (kv.get('interfaces') ? tr('（网卡 {iface}）', { iface: kv.get('interfaces')! }) : '') + (sources ? tr('（来源 {src}）', { src: sources }) : '')
  const verdict = /^(ACCEPT)$/i.test(target) ? tr('全部允许') : /^DROP$/i.test(target) ? tr('直接丢弃') : tr('fwv|拒绝')
  policy.push(tr('{zone}：未列出的入站{verdict}（target {target}）', { zone: zoneText, verdict, target }))
  if (kv.get('masquerade') === 'yes') policy.push(tr('区域 {zone}：开启了地址伪装（masquerade）', { zone }))
  return { rules, policy }
}

// ── ufw status verbose ──
export function parseUfw(text: string): { active: boolean; rules: FwRule[]; policy: string[] } {
  const lines = text.replace(/\r/g, '').split('\n')
  const active = lines.some((l) => /^Status:\s*active/i.test(l))
  const policy: string[] = []
  const def = lines.find((l) => l.startsWith('Default:'))
  if (def) {
    const T: Record<string, string> = { deny: tr('拒绝'), allow: tr('允许'), reject: tr('拒绝'), disabled: tr('fw|关闭') }
    for (const m of def.matchAll(/(\w+) \((incoming|outgoing|routed)\)/g)) policy.push(tr('默认{dir}：{v}', { dir: m[2] === 'incoming' ? tr('入站') : m[2] === 'outgoing' ? tr('出站') : tr('转发'), v: T[m[1]] ?? m[1] }))
  }
  const rules: FwRule[] = []
  const sep = lines.findIndex((l) => /^--\s+-+\s+--/.test(l.trim()))
  for (const l of sep >= 0 ? lines.slice(sep + 1) : []) {
    if (!l.trim()) continue
    const c = l.trim().split(/\s{2,}/)
    if (c.length < 3) continue
    const [to, act, from] = c
    const am = /^(ALLOW|DENY|REJECT|LIMIT)(?:\s+(IN|OUT|FWD))?/i.exec(act)
    if (!am) continue
    const v6 = /\(v6\)/.test(to)
    // 「22/tcp on eth0」「Anywhere on eth0」：最后的 on 是网卡，不是应用名 / 地址
    const dest0 = to.replace(/\s*\(v6\)/, '').trim()
    const onm = /^(.*?)\s+on\s+(\S+)$/.exec(dest0)
    const dest = (onm ? onm[1] : dest0).trim(), iface = onm?.[2]
    const pm = /^(?:(\S+) )?(\d[\d,:]*)(?:\/(tcp|udp))?$/.exec(dest)
    const svc = !pm && !any(dest) && !/^\d/.test(dest) ? dest : undefined
    const sp = svc ? SERVICES[svc.toLowerCase()]?.split('/') : undefined
    const dir: FwDir = am[2]?.toUpperCase() === 'OUT' ? 'out' : am[2]?.toUpperCase() === 'FWD' ? 'fwd' : 'in'
    const a = am[1].toUpperCase()
    const r: Omit<FwRule, 'text' | 'raw'> = {
      dir, action: a === 'ALLOW' || a === 'LIMIT' ? 'allow' : a === 'REJECT' ? 'reject' : 'deny',
      port: pm ? pm[2].replace(/:/g, '-') : sp?.[0], proto: pm?.[3] ?? sp?.[1], source: any(from) ? undefined : from.replace(/\s*\(v6\)/, ''), iface,
    }
    if (dir === 'out' && !any(dest) && !pm && !svc) r.source = dest   // OUT 规则「To」是目标地址
    rules.push(mk(r, l.trim(), `${svc ? tr('（应用 {name}）', { name: svc }) : ''}${a === 'LIMIT' ? tr('（限速：30 秒内 6 次以上拒绝）') : ''}${v6 ? tr('（IPv6）') : ''}`))
  }
  return { active, rules, policy }
}

// ── nft list ruleset ──
export function parseNft(text: string): { rules: FwRule[]; policy: string[] } {
  const rules: FwRule[] = [], policy: string[] = []
  let table = '', chain = '', hook = '', depth = 0
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const l = raw.trim()
    if (!l || l.startsWith('#')) continue
    const t = /^table (\S+) (\S+) \{/.exec(l)
    if (t) { table = `${t[1]} ${t[2]}`; depth = 1; continue }
    const c = /^chain (\S+) \{(.*)$/.exec(l)
    if (c) {
      chain = c[1]; hook = ''; depth = 2
      if (c[2].includes('}')) { chainHead(c[2]); depth = 1 }
      continue
    }
    if (/^(set|map|flowtable|ct helper|counter|quota|limit) /.test(l) && l.endsWith('{')) { depth = 9; continue }
    if (l === '}') { depth = depth === 9 ? 1 : Math.max(0, depth - 1); continue }
    if (depth !== 2) continue
    if (/^type \S+ hook/.test(l)) { chainHead(l); continue }
    rules.push(nftRule(l))
  }
  return { rules, policy }

  function chainHead(s: string) {
    const h = /hook (\w+)/.exec(s)?.[1]
    hook = h ?? ''
    const p = /policy (\w+)/.exec(s)?.[1]
    if (h && p && /^(input|output|forward)$/.test(h)) policy.push(tr('{table} 的 {chain}（{dir}）默认：{v}', { table, chain, dir: h === 'input' ? tr('入站') : h === 'output' ? tr('出站') : tr('转发'), v: p === 'accept' ? tr('允许') : tr('丢弃') }))
  }
  function nftRule(l: string): FwRule {
    const dir: FwDir = hook === 'input' ? 'in' : hook === 'output' ? 'out' : hook === 'forward' ? 'fwd' : 'other'
    const verdict = / (accept|drop|reject)\b[^"]*$/.exec(` ${l}`)?.[1] ?? /\b(jump|goto) (\S+)/.exec(l)?.[0]
    const action: FwAction = verdict === 'accept' ? 'allow' : verdict === 'drop' ? 'deny' : verdict === 'reject' ? 'reject' : 'other'
    const pm = /\b(tcp|udp|th|sctp) dport (\{[^}]*\}|\S+)/.exec(l)
    const proto = pm ? (pm[1] === 'th' ? undefined : pm[1]) : /meta l4proto (\{[^}]*\}|\S+)/.exec(l)?.[1]?.replace(/[{}\s]/g, '') ?? /\b(icmp|icmpv6) type/.exec(l)?.[1]
    const port = pm?.[2].replace(/[{}\s]/g, '')
    const source = /\bip6? saddr (!= )?(\{[^}]*\}|\S+)/.exec(l)
    const iface = /\biif(?:name)? "?([^"\s]+)"?/.exec(l)?.[1]
    const r: Omit<FwRule, 'text' | 'raw'> = { dir, action, proto, port, source: source ? `${source[1] ? tr('非 ') : ''}${source[2].replace(/[{}\s]/g, '')}` : undefined, iface, chain: `${table} ${chain}` }
    if (/ct state [\w,]*established/.test(l) && action === 'allow') return { ...r, raw: l, text: tr('允许已建立连接的回包（established / related）') }
    if (/ct state [\w,]*invalid/.test(l)) return { ...r, raw: l, text: action === 'allow' ? tr('允许无效状态的包（invalid）') : tr('丢弃无效状态的包（invalid）') }
    if (iface === 'lo' && action === 'allow') return { ...r, raw: l, text: tr('允许本机回环（lo）') }
    if (action === 'other') return { ...r, raw: l, text: verdict ? tr('转到链 {chain}', { chain: verdict.split(' ')[1] }) + (port ? tr('（{ports}）', { ports: portText(proto, port) }) : '') : tr('其他：{v}', { v: l }) }
    return mk(r, l)
  }
}

// ── iptables -S ──
export function parseIptables(text: string): { rules: FwRule[]; policy: string[] } {
  const rules: FwRule[] = [], policy: string[] = []
  const DIR: Record<string, FwDir> = { INPUT: 'in', OUTPUT: 'out', FORWARD: 'fwd' }
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const l = raw.trim()
    const p = /^-P (\S+) (\S+)/.exec(l)
    if (p) { if (DIR[p[1]]) policy.push(tr('{dir}默认（{chain}）：{v}', { dir: tr(FW_DIR_LABEL[DIR[p[1]]]), chain: p[1], v: p[2] === 'ACCEPT' ? tr('允许') : tr('丢弃') })); continue }
    if (!l.startsWith('-A ')) continue
    const t = l.split(/\s+/)
    const opt = (...ks: string[]) => { for (const k of ks) { const i = t.indexOf(k); if (i >= 0) return { v: t[i + 1], neg: t[i - 1] === '!' } } return undefined }
    const chain = t[1]
    const j = opt('-j', '-g')?.v ?? ''
    const action: FwAction = j === 'ACCEPT' ? 'allow' : j === 'DROP' ? 'deny' : j === 'REJECT' ? 'reject' : 'other'
    const s = opt('-s', '--source'), ifc = opt('-i', '-o')
    const r: Omit<FwRule, 'text' | 'raw'> = {
      dir: DIR[chain] ?? 'other', action, chain,
      proto: opt('-p', '--protocol')?.v, port: (opt('--dport', '--destination-port') ?? opt('--dports'))?.v?.replace(/:/g, '-'),
      source: s ? `${s.neg ? tr('非 ') : ''}${s.v.replace(/\/32$/, '')}` : undefined, iface: ifc?.v,
    }
    const state = opt('--ctstate', '--state')?.v
    if (state && /ESTABLISHED/.test(state) && action === 'allow') rules.push({ ...r, raw: l, text: tr('允许已建立连接的回包（ESTABLISHED / RELATED）') })
    else if (r.iface === 'lo' && action === 'allow' && !r.port) rules.push({ ...r, raw: l, text: tr('允许本机回环（lo）') })
    else if (action === 'other') rules.push({ ...r, raw: l, text: j ? tr('转到链 {chain}', { chain: j }) + (r.port ? tr('（{ports}）', { ports: portText(r.proto, r.port) }) : '') : tr('其他：{v}', { v: l }) })
    else rules.push(mk(r, l))
  }
  return { rules, policy }
}

/** 解析 firewallListCommand 的输出：每个探测到的工具一节；primary = 实际在管的那个（firewalld 运行中 > ufw 启用 > nft 有规则 > iptables 有规则） */
export function parseFirewall(out: string): FwList {
  const lines = out.replace(/\r/g, '').split('\n')
  const sections: FwSection[] = []
  let listen: string[] = [], cur: { tool: FwTool; body: string[] } | undefined
  const blocks: { tool: FwTool; body: string[] }[] = []
  let inSs = false
  for (const l of lines) {
    const m = /^@@tool:(\w+)$/.exec(l)
    if (m) { cur = { tool: m[1] as FwTool, body: [] }; blocks.push(cur); inSs = false; continue }
    if (l === '@@ss') { inSs = true; cur = undefined; continue }
    if (inSs) listen.push(l)
    else cur?.body.push(l)
  }
  for (const b of blocks) {
    const raw = b.body.join('\n').trim()
    const denied = DENIED.test(raw) && !/^(-P|table|Status:|@@zone)/m.test(raw)
    if (b.tool === 'firewalld') {
      const state = /^@@state:(.*)$/m.exec(raw)?.[1]?.trim() ?? ''
      const sec: FwSection = { tool: 'firewalld', active: state === 'running', denied: DENIED.test(state), policy: [], rules: [], raw: raw.replace(/^@@state:.*\n?/m, '') }
      const parts = raw.split(/^@@zone:/m).slice(1)
      for (const p of parts) {
        const [zone, ...rest] = p.split('\n')
        if (DENIED.test(rest.join('\n')) && !/^\s+target:/m.test(rest.join('\n'))) { sec.denied = true; continue }
        const r = parseFirewalld(zone.trim(), rest.join('\n'))
        sec.rules.push(...r.rules); sec.policy.push(...r.policy)
      }
      if (!sec.active && !sec.denied) sec.policy.push(tr('firewalld 没在运行（{state}）', { state: state || tr('frag|未知') }))
      sec.raw = sec.raw.replace(/^@@zone:/gm, '# zone ')
      sections.push(sec)
    } else if (b.tool === 'ufw') {
      const r = parseUfw(raw)
      sections.push({ tool: 'ufw', active: r.active, denied, policy: r.active ? r.policy : [tr('ufw 未启用（Status: inactive）')], rules: r.rules, raw })
    } else if (b.tool === 'nft') {
      const r = parseNft(raw)
      sections.push({ tool: 'nft', active: !denied && r.rules.length > 0, denied, ...r, raw })
    } else if (b.tool === 'iptables') {
      const [s, lPart = ''] = raw.split(/^@@part:L$/m)
      const r = parseIptables(s)
      // 默认策略是丢弃（不看文案：文案随界面语言变）
      const hasRules = r.rules.length > 0 || /^-P (INPUT|OUTPUT|FORWARD) (?!ACCEPT\b)\S+/m.test(s)
      sections.push({ tool: 'iptables', active: !denied && hasRules, denied, ...r, raw: `# iptables -S\n${s.trim()}\n\n# iptables -L -n -v\n${lPart.trim()}` })
    }
  }
  const order: FwTool[] = ['firewalld', 'ufw', 'nft', 'iptables']
  const primary = order.map((t) => sections.find((s) => s.tool === t && s.active)).find(Boolean)?.tool
  sections.sort((a, b) => (a.tool === primary ? -1 : b.tool === primary ? 1 : order.indexOf(a.tool) - order.indexOf(b.tool)))
  listen = listen.filter((l) => l.trim())
  return { sections, listen: listen.join('\n'), primary }
}

const inPorts = (spec: string, port: number) => spec.split(',').some((p) => {
  const [a, b] = p.split(/[-:]/).map(Number)
  return b ? port >= a && port <= b : port === a
})
/** 这条规则管不管这个端口（端口为空 = 全部端口都管） */
export const ruleMatchesPort = (r: FwRule, port: number) => !r.port || inPorts(r.port, port)

/** 监听列表（ss -ltnup 原文）里在这个端口上听的行 */
export function listenLines(listen: string, port: number): string[] {
  return listen.split('\n').filter((l) => l.trim().split(/\s+/).some((tok, i) => i < 6 && splitHostPort(tok)?.port === port))
}

/** 问题里的端口号（「为什么 8080 外部访问不了」→ 8080） */
export function questionPort(q: string): number | undefined {
  const m = /(?:^|[^\d.])(\d{1,5})(?![\d.])/.exec(q)
  const n = m ? Number(m[1]) : NaN
  return n >= 1 && n <= 65535 ? n : undefined
}

/** 「问 AI」引用文本：问题 + 防火墙规则原文 + 该端口的监听情况 */
export function firewallQuote(o: { host: string; question: string; list: FwList; port?: number }): string {
  const f = '```'
  const sec = o.list.sections
  const rules = sec.map((s) => `${tr('【{name}】', { name: FW_TOOL_LABEL[s.tool] + (s.active ? '' : tr('（未启用）')) + (s.denied ? tr('（没权限读取）') : '') })}\n${s.raw.slice(0, 6000)}`).join('\n\n') || tr('（没有找到 firewalld / ufw / nftables / iptables）')
  const ls = o.port ? listenLines(o.list.listen, o.port) : []
  const listenTxt = o.port ? (ls.length ? ls.join('\n') : tr('（没有程序在端口 {port} 上监听）', { port: o.port })) : o.list.listen.slice(0, 3000)
  const listenHead = o.port ? tr('端口 {port} 的监听情况（ss -ltnup）', { port: o.port }) : tr('监听端口（ss -ltnup）')
  return `${o.question.trim()}\n\n${tr('终端「{host}」所在主机的防火墙规则：', { host: o.host })}\n${f}\n${rules}\n${f}\n${listenHead}${tr('：')}\n${f}\n${listenTxt}\n${f}\n`
}
