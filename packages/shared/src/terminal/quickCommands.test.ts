import { describe, it, expect } from 'vitest'
import { normalizeQuickCommands, quickTargets, planQuickSend, quickVars, resolveQuickCommand, migrateQuickCommands, DEFAULT_QUICK_COMMANDS, normalizeQuickScope, quickScopeCtx, quickScopeMatch, quickScopeLabel, type QuickCommandsData } from './quickCommands.js'
import { osFromUname, osFromPlatform, osLabel, type TerminalInfo } from '../protocol/index.js'

const term = (id: string, x: Partial<TerminalInfo> = {}): TerminalInfo => ({ id, title: id, type: 'ssh', status: 'running', locked: false, ...x })
const terms = [term('a'), term('b', { env: 'prod' }), term('c', { status: 'disconnected' }), term('d', { locked: true })]

describe('normalizeQuickCommands', () => {
  it('补默认值、去空白、补 id，activeSetId 无效回退第一组', () => {
    const n = normalizeQuickCommands({ activeSetId: 'nope', sets: [{ id: '', name: ' 组 ', commands: [{ label: ' 看 ', command: 'ls  \n' } as never] }] })
    expect(n.sets[0].name).toBe('组')
    expect(n.sets[0].id).toMatch(/^qs_/)
    expect(n.sets[0].commands[0]).toMatchObject({ label: '看', command: 'ls', appendEnter: true, target: 'active' })
    expect(n.activeSetId).toBe(n.sets[0].id)
    expect(n.barVisible).toBe(true)
  })
  it('空数据给一个空组；重复 id 换新', () => {
    expect(normalizeQuickCommands(null).sets).toHaveLength(1)
    const c = { id: 'x', label: 'l', command: 'c', appendEnter: false, target: 'broadcast' as const }
    const n = normalizeQuickCommands({ sets: [{ id: 's', name: 'n', commands: [c, c] }], activeSetId: 's', barVisible: false })
    expect(new Set(n.sets[0].commands.map((x) => x.id)).size).toBe(2)
    expect(n.sets[0].commands[0]).toMatchObject({ appendEnter: false, target: 'broadcast' })
    expect(n.barVisible).toBe(false)
  })
  it('名称或命令为空抛错', () => {
    expect(() => normalizeQuickCommands({ sets: [{ id: 's', name: ' ', commands: [] }] })).toThrow('名称')
    expect(() => normalizeQuickCommands({ sets: [{ id: 's', name: 'n', commands: [{ id: 'c', label: 'l', command: '  ', appendEnter: true, target: 'active' }] }] })).toThrow()
  })
  it('默认数据本身合法', () => { expect(normalizeQuickCommands(DEFAULT_QUICK_COMMANDS)).toEqual(DEFAULT_QUICK_COMMANDS) })
  it('各系统版本：去尾空白、丢空的；全空则不带 variants/strict；只有版本没有默认命令也行', () => {
    const n = normalizeQuickCommands({ sets: [{ id: 's', name: 'n', commands: [
      { id: 'a', label: 'a', command: 'x', appendEnter: true, target: 'active', variants: { linux: 'free -h  ', macos: '  ', windows: '' }, strict: true },
      { id: 'b', label: 'b', command: 'y', appendEnter: true, target: 'active', variants: { linux: ' ' }, strict: true },
      { id: 'c', label: 'c', command: '  ', appendEnter: true, target: 'active', variants: { windows: 'ver' } },
    ] }] })
    expect(n.sets[0].commands[0]).toMatchObject({ variants: { linux: 'free -h' }, strict: true })
    expect(n.sets[0].commands[1]).not.toHaveProperty('variants')
    expect(n.sets[0].commands[1]).not.toHaveProperty('strict')
    expect(n.sets[0].commands[2]).toMatchObject({ command: '', variants: { windows: 'ver' } })
  })
})

describe('resolveQuickCommand', () => {
  const cmd = { command: 'free -h', variants: { macos: 'top -l 1', windows: 'ps-mem' } }
  it('有该系统版本用版本，否则用默认', () => {
    expect(resolveQuickCommand(cmd, 'windows')).toEqual({ command: 'ps-mem' })
    expect(resolveQuickCommand(cmd, 'linux')).toEqual({ command: 'free -h' })
    expect(resolveQuickCommand({ command: 'df -h' }, 'macos')).toEqual({ command: 'df -h' })
  })
  it('strict：没设版本的已知系统不可用', () => {
    const s = { ...cmd, strict: true }
    expect(resolveQuickCommand(s, 'linux')).toEqual({ unsupported: true })
    expect(resolveQuickCommand(s, 'macos')).toEqual({ command: 'top -l 1' })
  })
  it('unknown / 未探测：用默认命令（strict 也是）；没有默认命令则不可用', () => {
    expect(resolveQuickCommand({ ...cmd, strict: true }, 'unknown')).toEqual({ command: 'free -h' })
    expect(resolveQuickCommand(cmd, undefined)).toEqual({ command: 'free -h' })
    expect(resolveQuickCommand({ command: '', variants: { windows: 'ver' } }, 'unknown')).toEqual({ unsupported: true })
    expect(resolveQuickCommand({ command: '', variants: { windows: 'ver' } }, 'linux')).toEqual({ unsupported: true })
  })
})

describe('migrateQuickCommands', () => {
  const OLD: QuickCommandsData = { activeSetId: 'qs_default', barVisible: true, sets: [{ id: 'qs_default', name: '常用', commands: [
    { id: 'qc_df', label: '查看磁盘', command: 'df -h', appendEnter: true, target: 'active' },
    { id: 'qc_free', label: '内存', command: 'free -h', appendEnter: true, target: 'active' },
    { id: 'qc_uptime', label: '负载', command: 'uptime', appendEnter: true, target: 'active' },
  ] }] }
  it('原样的旧默认：升级成分系统版本并补「监听端口」，等于新默认；再跑一次无变化', () => {
    const up = migrateQuickCommands(structuredClone(OLD))!
    expect(up).toEqual(DEFAULT_QUICK_COMMANDS)
    expect(migrateQuickCommands(up)).toBeNull()
  })
  it('用户改过的命令不动；默认组被改过就不补「监听端口」', () => {
    const d = structuredClone(OLD)
    d.sets[0].commands[1].command = 'free -m'
    d.sets[0].commands[2].variants = { windows: 'my-load' }
    expect(migrateQuickCommands(d)).toBeNull()
    const e = structuredClone(OLD)
    e.sets[0].commands.push({ id: 'x', label: '日志', command: 'tail x', appendEnter: true, target: 'active' })
    const up = migrateQuickCommands(e)!
    expect(up.sets[0].commands.map((c) => c.id)).toEqual(['qc_df', 'qc_free', 'qc_uptime', 'x'])
    expect(up.sets[0].commands[1].variants?.windows).toContain('powershell.exe')
  })
  it('升级后用户删了「监听端口」不会再补回来', () => {
    const up = migrateQuickCommands(structuredClone(OLD))!
    up.sets[0].commands = up.sets[0].commands.filter((c) => c.id !== 'qc_ports')
    expect(migrateQuickCommands(up)).toBeNull()
  })
  it('非默认组里同 id 的旧默认命令也升级，但不补端口', () => {
    const d: QuickCommandsData = { activeSetId: 's', barVisible: true, sets: [{ id: 's', name: '我的', commands: [structuredClone(OLD.sets[0].commands[1])] }] }
    const up = migrateQuickCommands(d)!
    expect(up.sets[0].commands).toHaveLength(1)
    expect(up.sets[0].commands[0].variants?.macos).toBe('top -l 1 | grep PhysMem')
  })
})

describe('quickTargets', () => {
  it('active：只发当前终端；断开 / AI 占用跳过', () => {
    expect(quickTargets({ target: 'active' }, 'a', terms, new Set(['a', 'b'])).map((t) => t.id)).toEqual(['a'])
    expect(quickTargets({ target: 'active' }, 'c', terms, null)).toEqual([])
  })
  it('broadcast：广播开着发组内（跳过断开 / 占用），关着退回当前终端', () => {
    expect(quickTargets({ target: 'broadcast' }, 'a', terms, new Set(['a', 'b', 'c', 'd'])).map((t) => t.id)).toEqual(['a', 'b'])
    expect(quickTargets({ target: 'broadcast' }, 'b', terms, null).map((t) => t.id)).toEqual(['b'])
  })
})

describe('planQuickSend', () => {
  it('填参数、按 appendEnter 加回车，报告缺的参数', () => {
    expect(planQuickSend({ command: 'tail -n {{行数}} {{文件}}', appendEnter: true }, { 行数: '50' }, [terms[0]])).toEqual({ sends: [{ term: terms[0], text: 'tail -n 50 {{文件}}\r' }], unsupported: [], missing: ['文件'], confirmProd: [] })
    expect(planQuickSend({ command: 'a\nb', appendEnter: false }, {}, [terms[0]]).sends[0].text).toBe('a\nb')
  })
  it('广播：每个终端按自己的系统解析；strict 不支持的跳过', () => {
    const lin = term('l', { os: 'linux' }), win = term('w', { os: 'windows' }), mac = term('m', { os: 'macos' }), unk = term('u', { os: 'unknown' })
    const p = planQuickSend({ command: 'free -h', appendEnter: true, variants: { windows: 'ps-mem' } }, {}, [lin, win, mac, unk])
    expect(p.sends.map((s) => [s.term.id, s.text])).toEqual([['l', 'free -h\r'], ['w', 'ps-mem\r'], ['m', 'free -h\r'], ['u', 'free -h\r']])
    const s = planQuickSend({ command: 'ss -lntp', appendEnter: true, variants: { linux: 'ss -lntp', macos: 'lsof -i' }, strict: true }, {}, [lin, win, mac])
    expect(s.sends.map((x) => x.term.id)).toEqual(['l', 'm'])
    expect(s.unsupported.map((x) => x.id)).toEqual(['w'])
  })
  it('参数收集只算实际要发的版本；危险确认看各生产终端解析后的命令', () => {
    const lin = term('l', { os: 'linux', env: 'prod' }), win = term('w', { os: 'windows', env: 'prod' })
    const cmd = { command: 'ls {{目录}}', appendEnter: true, variants: { windows: 'rm -rf {{目录}} {{备份}}', macos: 'ls {{mac专用}}' } }
    expect(quickVars(cmd, [lin, win])).toEqual(['目录', '备份'])   // 没有 macOS 终端 → 不要 mac专用
    expect(quickVars(cmd, [lin])).toEqual(['目录'])
    const p = planQuickSend(cmd, { 目录: '/tmp/x', 备份: 'b' }, [lin, win])
    expect(p.missing).toEqual([])
    expect(p.confirmProd).toEqual(['w'])   // 只有 Windows 那台收到的是 rm -rf
    expect(planQuickSend(cmd, { 目录: '/tmp/x' }, [lin]).confirmProd).toEqual([])
  })
  it('生产终端 + 危险命令才要确认', () => {
    expect(planQuickSend({ command: 'rm -rf {{目录}}', appendEnter: true }, { 目录: '/tmp/x' }, [terms[0], terms[1]]).confirmProd).toEqual(['b'])
    expect(planQuickSend({ command: 'rm -rf /tmp/x', appendEnter: true }, {}, [terms[0]]).confirmProd).toEqual([])
    expect(planQuickSend({ command: 'df -h', appendEnter: true }, {}, [terms[1]]).confirmProd).toEqual([])
  })
})

describe('终端系统识别', () => {
  it('uname -s 输出 → 系统', () => {
    expect(osFromUname('Linux')).toBe('linux')
    expect(osFromUname('\r\nDarwin\r\n')).toBe('macos')
    expect(osFromUname('MINGW64_NT-10.0-26100')).toBe('windows')
    expect(osFromUname('some motd\nLinux')).toBe('linux')   // 取最后一行
    expect(osFromUname('FreeBSD')).toBe('unknown')
    expect(osFromUname('')).toBe('unknown')
  })
  it('process.platform → 系统；显示名', () => {
    expect([osFromPlatform('win32'), osFromPlatform('darwin'), osFromPlatform('linux'), osFromPlatform('freebsd')]).toEqual(['windows', 'macos', 'linux', 'unknown'])
    expect([osLabel('windows'), osLabel('linux'), osLabel('unknown'), osLabel(undefined)]).toEqual(['Windows · Git Bash', 'Linux', '', ''])
  })
})

describe('快速命令显示范围（按主机 / 分组）', () => {
  const hosts = [{ id: 'h1', label: 'web-1', group: 'web' }, { id: 'h2', label: 'db-1', group: 'db' }]
  it('规整：只留认得的项、去重；空 = 不带字段（旧数据兼容）', () => {
    expect(normalizeQuickScope(['local', 'host:h1', 'host:h1', 'bad', 'group:', 'group:web', 3])).toEqual(['local', 'host:h1', 'group:web'])
    expect(normalizeQuickScope([])).toBeUndefined()
    expect(normalizeQuickScope(undefined)).toBeUndefined()
    const n = normalizeQuickCommands({ sets: [{ id: 's', name: 'n', scope: ['group:web'], commands: [{ id: 'c', label: 'l', command: 'ls', appendEnter: true, target: 'active', scope: ['nope'], description: ' 看看 ' }] }], activeSetId: 's', barVisible: true })
    expect(n.sets[0].scope).toEqual(['group:web'])
    expect(n.sets[0].commands[0].scope).toBeUndefined()
    expect(n.sets[0].commands[0].description).toBe('看看')
    expect('scope' in normalizeQuickCommands(DEFAULT_QUICK_COMMANDS).sets[0]).toBe(false)
  })
  it('匹配：本地终端算本机；SSH 按主机 id / 分组；临时连接只匹配全部；无终端不过滤', () => {
    const local = quickScopeCtx({ type: 'local' }, hosts), web = quickScopeCtx({ type: 'ssh', hostId: 'h1' }, hosts)
    const db = quickScopeCtx({ type: 'ssh', hostId: 'h2' }, hosts), adhoc = quickScopeCtx({ type: 'ssh' }, hosts)
    expect(web).toEqual({ local: false, hostId: 'h1', group: 'web' })
    expect([local, web, db, adhoc].map((c) => quickScopeMatch(undefined, c))).toEqual([true, true, true, true])
    expect([local, web, db, adhoc].map((c) => quickScopeMatch(['local'], c))).toEqual([true, false, false, false])
    expect([local, web, db, adhoc].map((c) => quickScopeMatch(['group:web'], c))).toEqual([false, true, false, false])
    expect([local, web, db, adhoc].map((c) => quickScopeMatch(['host:h2', 'local'], c))).toEqual([true, false, true, false])
    expect(quickScopeMatch(['host:h2'], undefined)).toBe(true)
    expect(quickScopeLabel(['local', 'host:h1', 'group:db'], hosts)).toBe('本机、web-1、分组 db')
    expect(quickScopeLabel(undefined, hosts)).toBe('全部主机')
  })
})
