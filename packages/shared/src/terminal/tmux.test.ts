import { describe, it, expect } from 'vitest'
import {
  isTmuxSessionName, parseTmuxVersion, parseTmuxProbe, tmuxFallback, tmuxProbeCommand, tmuxCreateCommand, tmuxAttachCommand,
  tmuxKillCommand, tmuxPanesCommand, tmuxPwdCommand, parseTmuxJobs, parseTmuxSessions, TMUX_OK,
} from './tmux.js'

const N = 'lingshell-0123abcd'

describe('会话名校验（拼进远端命令行前必过）', () => {
  it('只认 lingshell- + 8 位小写 hex', () => {
    expect(isTmuxSessionName(N)).toBe(true)
    for (const bad of ['lingshell-0123abc', 'lingshell-0123abcde', 'lingshell-0123ABCD', 'x-0123abcd', "lingshell-0123abcd'; rm -rf ~", 'lingshell-0123abc;', undefined, 42]) {
      expect(isTmuxSessionName(bad)).toBe(false)
    }
  })
  it('非法名一律拒绝拼命令', () => {
    for (const f of [tmuxProbeCommand, tmuxAttachCommand, tmuxKillCommand, tmuxPanesCommand, tmuxPwdCommand, (n: string) => tmuxCreateCommand(n, 3.4, 'x')]) {
      expect(() => f('lingshell-$(reboot)')).toThrow('bad_tmux_session')
    }
  })
})

describe('探测解析', () => {
  it('版本串', () => {
    expect(parseTmuxVersion('tmux 3.3a')).toBe(3.3)
    expect(parseTmuxVersion('tmux 1.8')).toBe(1.8)
    expect(parseTmuxVersion('tmux next-3.5')).toBe(3.5)
    expect(parseTmuxVersion('tmux master')).toBe(99)
  })
  it('已装 + 会话已存在 + Linux', () => {
    expect(parseTmuxProbe('tmux 3.2a\n@@exists\nLinux\n')).toEqual({ installed: true, version: 3.2, exists: true, os: 'linux' })
  })
  it('已装、会话不在（CRLF 也行）', () => {
    expect(parseTmuxProbe('tmux 2.6\r\nDarwin\r\n')).toEqual({ installed: true, version: 2.6, exists: false, os: 'macos' })
  })
  it('没装 tmux → 退回普通会话并提示', () => {
    const p = parseTmuxProbe('@@notmux\nLinux\n')
    expect(p).toEqual({ installed: false, version: 0, exists: false, os: 'linux' })
    expect(tmuxFallback(p, false)).toBe('服务器未安装 tmux，已用普通会话')
  })
  it('版本过低 / GBK 主机 → 不用 tmux；正常 → undefined', () => {
    expect(tmuxFallback(parseTmuxProbe('tmux 1.6\nLinux'), false)).toMatch(/版本过低/)
    expect(tmuxFallback(parseTmuxProbe('tmux 3.3a\nLinux'), true)).toMatch(/非 UTF-8/)
    expect(tmuxFallback(parseTmuxProbe('tmux 3.3a\nLinux'), false)).toBeUndefined()
  })
})

describe('命令拼装', () => {
  it('探测：包 sh -c，一次拿到 版本 / 是否存在 / uname', () => {
    expect(tmuxProbeCommand(N)).toBe(`sh -c 'if command -v tmux >/dev/null 2>&1; then tmux -V 2>&1; tmux has-session -t ${N} 2>/dev/null && echo @@exists; else echo @@notmux; fi; uname -s'`)
  })
  it('接回：-u 按 UTF-8、-d 踢掉残留旧客户端', () => {
    expect(tmuxAttachCommand(N)).toBe(`tmux -u attach-session -d -t ${N}`)
  })
  it('建会话：按版本加选项（只改本会话，不带 -g）', () => {
    const old = tmuxCreateCommand(N, 1.9, 'S')
    expect(old).not.toMatch(/mouse|passthrough/)
    const v31 = tmuxCreateCommand(N, 3.1, 'S')
    expect(v31).toContain(`set-option -t ${N} mouse off`)
    expect(v31).not.toContain('allow-passthrough')
    const v34 = tmuxCreateCommand(N, 3.4, 'S')
    expect(v34).toBe(`tmux new-session -d -s ${N} \\; set-option -t ${N} status off \\; set-option -t ${N} mouse off \\; set-option -w -t ${N} allow-passthrough on`
      + ` \\; send-keys -t ${N} -l ' S; clear' \\; send-keys -t ${N} Enter && echo ${TMUX_OK}`)
    expect(v34).not.toMatch(/ -g /)
  })
  it('kill / list-panes / pwd', () => {
    expect(tmuxKillCommand(N)).toBe(`tmux kill-session -t ${N}`)
    expect(tmuxPanesCommand(N)).toBe(`tmux list-panes -s -t ${N} -F '#{pane_current_command}'`)
    expect(tmuxPwdCommand(N)).toBe(`tmux display-message -p -t ${N} '#{pane_current_path}'`)
  })
})

describe('关标签判断：前台是 shell = 空闲', () => {
  it('全是 shell → 空（直接结束会话）', () => {
    expect(parseTmuxJobs('bash\n-zsh\nsh\n')).toEqual([])
  })
  it('有非 shell 命令 → 列出（去重）', () => {
    expect(parseTmuxJobs('bash\nrsync\npython3\nrsync\n')).toEqual(['rsync', 'python3'])
  })
  it('查询失败（空输出）→ 当空闲', () => {
    expect(parseTmuxJobs('')).toEqual([])
  })
})

describe('保留会话列表', () => {
  it('只认 lingshell- 会话；时间秒 → 毫秒；命令里有 | 也不错位', () => {
    const out = `${N}|1700000000|0|rsync\nwork|1700000001|1|vim\nlingshell-ffffffff|1700000002|1|a|b\n\n`
    expect(parseTmuxSessions(out)).toEqual([
      { name: N, createdAt: 1700000000000, attached: false, command: 'rsync' },
      { name: 'lingshell-ffffffff', createdAt: 1700000002000, attached: true, command: 'a|b' },
    ])
  })
})
