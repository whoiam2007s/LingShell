import { describe, it, expect, vi } from 'vitest'
import { TerminalManager, toWinPath } from './TerminalManager.js'
import { SshTerminal } from './SshTerminal.js'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'

describe('toWinPath (MSYS→Windows 路径归一)', () => {
  it('/c/Users/x → C:\\Users\\x', () => { expect(toWinPath('/c/Users/cjzong')).toBe('C:\\Users\\cjzong') })
  it('大写盘符', () => { expect(toWinPath('/d/proj/a b')).toBe('D:\\proj\\a b') })
  it('盘根 /c → C:\\', () => { expect(toWinPath('/c')).toBe('C:\\') })
  it('已是 Windows 路径原样返回', () => { expect(toWinPath('C:\\Users\\x')).toBe('C:\\Users\\x') })
  it('普通 Linux 路径原样返回（非单字母挂载点）', () => { expect(toWinPath('/root/app')).toBe('/root/app') })
})

describe('TerminalManager local terminal', () => {
  it('creates a terminal and receives echoed output', async () => {
    const mgr = new TerminalManager()
    const info = mgr.createLocal()
    expect(info.id).toMatch(/^term_/)
    expect(info.type).toBe('local')

    const got = await new Promise<string>((resolve) => {
      let buf = ''
      mgr.onData(info.id, (chunk) => {
        buf += chunk
        if (buf.includes('PONGTOKEN')) resolve(buf)
      })
      setTimeout(() => mgr.write(info.id, 'echo PONGTOKEN\r'), 800)
    })
    expect(got).toContain('PONGTOKEN')
    mgr.close(info.id)
  }, 15000)

  // OSC 633;P;Cwd 只在 Windows 本地 Git Bash 下由 promptNewline 注入（见 TerminalManager.ts
  // 的 knownCwd 分支）；其他平台走的是另一条探测路径，这个用例不适用。
  it.skipIf(process.platform !== 'win32')('knownCwd：取提示符报的目录（OSC 633;P;Cwd），cd 后跟着变，不往终端里打 pwd', async () => {
    const mgr = new TerminalManager()
    const start = process.cwd()   // 仓库目录（Git Bash 下是 /d/... 形式，能换回 Windows 路径；/tmp 这类挂载点不行）
    const info = mgr.createLocal({ cwd: start })
    const sent: string[] = []
    const until = (f: () => boolean) => new Promise<void>((r) => { const t = setInterval(() => { if (f()) { clearInterval(t); r() } }, 100) })
    await until(() => mgr.knownCwd(info.id) !== undefined)
    expect(mgr.knownCwd(info.id)!.toLowerCase()).toBe(start.toLowerCase())
    const orig = mgr.write.bind(mgr)
    mgr.write = (id, d, o) => { sent.push(d); orig(id, d, o) }
    mgr.write(info.id, 'cd ..\r')
    await until(() => mgr.knownCwd(info.id)?.toLowerCase() !== start.toLowerCase())
    expect(mgr.knownCwd(info.id)!.toLowerCase()).toBe(dirname(start).toLowerCase())
    expect(mgr.cachedCwd(info.id)!.toLowerCase()).toBe(dirname(start).toLowerCase())   // 给 AI 终端清单的缓存值
    expect(sent).toEqual(['cd ..\r'])
    expect(mgr.knownCwd('nope')).toBeUndefined()
    expect(mgr.cachedCwd('nope')).toBeUndefined()
    mgr.close(info.id)
  }, 20000)

  it('rejects write when terminal not found', () => {
    const mgr = new TerminalManager()
    expect(() => mgr.write('nope', 'x')).toThrow('terminal_not_found')
  })

  it('execCapture runs a command and returns output + exitCode', async () => {
    const mgr = new TerminalManager()
    const info = mgr.createLocal()
    await new Promise((r) => setTimeout(r, 1000))   // 等 shell 起来
    const r = await mgr.execCapture(info.id, 'echo CAPTOKEN')
    expect(r.output).toContain('CAPTOKEN')
    expect(r.exitCode).toBe(0)
    mgr.close(info.id)
  }, 20000)

  it('emits locked true/false around execCapture', async () => {
    const events: boolean[] = []
    const mgr = new TerminalManager({ emit: (_id, locked) => events.push(locked) })
    const info = mgr.createLocal()
    await new Promise((r) => setTimeout(r, 1000))
    await mgr.execCapture(info.id, 'echo X')
    expect(events).toEqual([true, false])
    mgr.close(info.id)
  }, 20000)

  it('rejects manual write while locked (during execCapture)', async () => {
    const mgr = new TerminalManager()
    const info = mgr.createLocal()
    await new Promise((r) => setTimeout(r, 1000))
    const p = mgr.execCapture(info.id, 'sleep 1; echo DONE')
    expect(() => mgr.write(info.id, 'x')).toThrow('terminal_locked')
    await p
    mgr.close(info.id)
  }, 20000)

  it('readSnapshot returns recent output', async () => {
    const mgr = new TerminalManager()
    const info = mgr.createLocal()
    await new Promise((r) => setTimeout(r, 1000))
    await mgr.execCapture(info.id, 'echo SNAPLINE')
    await new Promise((r) => setTimeout(r, 300))
    expect(mgr.readSnapshot(info.id, 100)).toContain('SNAPLINE')
    mgr.close(info.id)
  }, 20000)

  it('execCapture rejects aborted when signal fires (local pty)', async () => {
    const mgr = new TerminalManager()
    const info = mgr.createLocal()
    const ctrl = new AbortController()
    const p = mgr.execCapture(info.id, 'sleep 30', ctrl.signal)
    ctrl.abort()
    await expect(p).rejects.toThrow('aborted')
    // 中断后 locked 必须复位，否则终端永久不可用
    expect(mgr.list().find((t) => t.id === info.id)?.locked).toBe(false)
    mgr.close(info.id)
  })

  it('commandEmit：用户在本地终端敲命令回车 → 上抛 (command, id, source=user)', async () => {
    const got: { command: string; id: string; source: string }[] = []
    const mgr = new TerminalManager({ commandEmit: (command, id, source) => got.push({ command, id, source }) })
    const info = mgr.createLocal()
    await new Promise((r) => setTimeout(r, 1000))   // 等 shell 起来
    mgr.write(info.id, 'echo hi\r')
    await new Promise((r) => setTimeout(r, 300))
    expect(got).toContainEqual({ command: 'echo hi', id: info.id, source: 'user' })
    mgr.close(info.id)
  }, 20000)
})

describe('TerminalManager SSH', () => {
  it('createSsh 成功 → 注册 ssh 终端，title=user@host', async () => {
    const fakeTerm = {
      id: 'term_x', write: () => {}, onData: () => () => {}, onExit: () => () => {},
      onCommand: () => () => {},
      execCapture: async () => ({ output: '', exitCode: 0 }), readSnapshot: () => '',
      resize: () => {}, kill: () => {},
    }
    const spy = vi.spyOn(SshTerminal, 'connect').mockResolvedValue(fakeTerm as any)
    const mgr = new TerminalManager()
    const info = await mgr.createSsh({ host: '1.2.3.4', port: 22, username: 'root' })
    expect(info.type).toBe('ssh')
    expect(info.title).toBe('root@1.2.3.4:22')   // 无 label 时 title=detail=user@host:port
    expect(info.detail).toBe('root@1.2.3.4:22')
    expect(info.status).toBe('running')
    spy.mockRestore()
  })

  it('createSsh 连接失败 → 抛错，不注册终端', async () => {
    const spy = vi.spyOn(SshTerminal, 'connect').mockRejectedValue(new Error('ssh_auth_failed'))
    const mgr = new TerminalManager()
    await expect(mgr.createSsh({ host: '1.2.3.4', port: 22, username: 'root' })).rejects.toThrow('ssh_auth_failed')
    expect(mgr.list()).toHaveLength(0)
    spy.mockRestore()
  })

  it('断线 onExit → status=disconnected + statusEmit', async () => {
    let exitCb: ((e: { reason?: string }) => void) | undefined
    const fakeTerm = {
      id: 'term_x', write: () => {}, onData: () => () => {},
      onExit: (cb: any) => { exitCb = cb; return () => {} },
      onCommand: () => () => {},
      execCapture: async () => ({ output: '', exitCode: 0 }), readSnapshot: () => '',
      resize: () => {}, kill: () => {},
    }
    vi.spyOn(SshTerminal, 'connect').mockResolvedValue(fakeTerm as any)
    const statuses: any[] = []
    const mgr = new TerminalManager({ statusEmit: (id, s, r) => statuses.push({ id, s, r }) })
    const info = await mgr.createSsh({ host: '1.2.3.4', port: 22, username: 'root' })
    exitCb!({ reason: 'connection closed' })
    expect(statuses).toEqual([{ id: info.id, s: 'disconnected', r: 'connection closed' }])
    expect(() => mgr.write(info.id, 'x')).toThrow('terminal_disconnected')
  })

  it('reconnect throws for local terminals (语义不适用)', async () => {
    const mgr = new TerminalManager()
    const info = mgr.createLocal()
    await expect(mgr.reconnect(info.id)).rejects.toThrow('reconnect_not_supported')
    mgr.close(info.id)
  })

  // Windows 本地 Git Bash 不打 pwd（用提示符报的目录，见 TerminalManager.pwd）：不上锁、AI 可立即执行
  it.runIf(process.platform === 'win32')('Windows Git Bash：pwd 不往终端里打命令、不上锁', async () => {
    const mgr = new TerminalManager()
    const info = mgr.createLocal()
    const p = mgr.pwd(info.id)
    expect(mgr.list()[0].locked).toBe(false)
    await p
    mgr.close(info.id)
  }, 15000)
  it.skipIf(process.platform === 'win32')('pwd 探测期间 locked=true，结束后释放', async () => {
    const mgr = new TerminalManager()
    const info = mgr.createLocal()
    const p = mgr.pwd(info.id)
    expect(mgr.list()[0].locked).toBe(true)
    await expect(mgr.execCapture(info.id, 'echo x')).rejects.toThrow('terminal_busy')
    await p
    expect(mgr.list()[0].locked).toBe(false)
    mgr.close(info.id)
  }, 15000)

  // 可过 instanceof SshTerminal 的假终端
  const fakeSsh = (over: Record<string, unknown> = {}) => Object.assign(Object.create(SshTerminal.prototype), {
    write: () => {}, onData: () => () => {}, onExit: () => () => {}, onCommand: () => () => {},
    execCapture: async () => ({ output: '', exitCode: 0 }), readSnapshot: () => '', resize: () => {}, kill: () => {},
    resetExitGuard: () => {}, ...over,
  })

  it('duplicate：SSH 用同一份建连参数（跳板/编码/标题），标题加序号', async () => {
    const spy = vi.spyOn(SshTerminal, 'connect').mockImplementation(async () => fakeSsh())
    const mgr = new TerminalManager()
    const opts = { host: '10.0.0.2', port: 22, username: 'app', encoding: 'gbk' as const, jump: { host: 'jump', port: 2222, username: 'j' }, title: '老库' }
    const a = await mgr.createSsh(opts)
    const b = await mgr.duplicate(a.id)
    expect(spy.mock.calls[1][1]).toEqual(opts)
    expect(b.id).not.toBe(a.id)
    expect([a.title, b.title]).toEqual(['老库', '老库 2'])
    expect(b.encoding).toBe('gbk')
    spy.mockRestore()
  })

  it('duplicate：本地终端在当前 cwd 新开', async () => {
    const mgr = new TerminalManager()
    const a = mgr.createLocal()
    vi.spyOn(mgr, 'pwd').mockResolvedValue(tmpdir())
    const create = vi.spyOn(mgr, 'createLocal')
    const b = await mgr.duplicate(a.id)
    expect(create).toHaveBeenCalledWith({ cwd: tmpdir() })
    expect(b.type).toBe('local')
    mgr.close(a.id); mgr.close(b.id)
  })

  it('reconnect：并发调用只重连一次；已在线不动；成功后发 running', async () => {
    let exitCb: ((e: { reason?: string }) => void) | undefined
    const reconnect = vi.fn(async () => { await new Promise((r) => setTimeout(r, 10)) })
    const spy = vi.spyOn(SshTerminal, 'connect').mockResolvedValue(fakeSsh({ reconnect, onExit: (cb: any) => { exitCb = cb; return () => {} } }))
    const statuses: string[] = []
    const mgr = new TerminalManager({ statusEmit: (_id, s) => statuses.push(s) })
    const info = await mgr.createSsh({ host: 'h', port: 22, username: 'u' })
    await mgr.reconnect(info.id)
    expect(reconnect).not.toHaveBeenCalled()   // 在线时不重连
    exitCb!({ reason: 'connection closed' })
    await Promise.all([mgr.reconnect(info.id), mgr.reconnect(info.id)])
    expect(reconnect).toHaveBeenCalledTimes(1)
    expect(statuses).toEqual(['disconnected', 'running'])
    spy.mockRestore()
  })

  it('系统探测：连上时随提示符设置静默 uname -s；重连后重测并随 running 带出；探测失败 → unknown', async () => {
    let exitCb: ((e: { reason?: string }) => void) | undefined
    let uname = 'Linux'
    const calls: { cmd: string; silent?: boolean }[] = []
    const execCapture = vi.fn(async (cmd: string, _t?: number, _s?: AbortSignal, o?: { silent?: boolean }) => { calls.push({ cmd, silent: o?.silent }); return { output: uname, exitCode: 0 } })
    const spy = vi.spyOn(SshTerminal, 'connect').mockResolvedValue(fakeSsh({ execCapture, reconnect: async () => {}, onExit: (cb: any) => { exitCb = cb; return () => {} } }))
    const statuses: unknown[] = []
    const mgr = new TerminalManager({ statusEmit: (_id, s, _r, os) => statuses.push([s, os]) })
    const info = await mgr.createSsh({ host: 'h', port: 22, username: 'u' })
    expect(info.os).toBe('linux')
    expect(calls).toEqual([{ cmd: expect.stringMatching(/; uname -s$/), silent: true }])   // 一次往返，静默
    exitCb!({}); uname = 'Darwin'
    await mgr.reconnect(info.id)
    expect(statuses).toEqual([['disconnected', undefined], ['running', 'macos']])
    expect(mgr.list()[0].os).toBe('macos')
    execCapture.mockRejectedValueOnce(new Error('timeout'))
    expect((await mgr.createSsh({ host: 'h', port: 22, username: 'u' })).os).toBe('unknown')
    spy.mockRestore()
  })

  it('本地终端系统取 process.platform', () => {
    const mgr = new TerminalManager()
    const info = mgr.createLocal()
    expect(info.os).toBe(process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux')
    mgr.close(info.id)
  })

  it('reconnect throws terminal_not_found for unknown id', async () => {
    const mgr = new TerminalManager()
    await expect(mgr.reconnect('nope')).rejects.toThrow('terminal_not_found')
  })
})

describe('本地终端选 shell', () => {
  it('不认识的 shell 拒绝（防参数注入）', () => {
    const mgr = new TerminalManager()
    expect(() => mgr.createLocal({ shell: 'wsl:--exec' })).toThrow('invalid_shell')
    expect(() => mgr.createLocal({ shell: 'zsh' })).toThrow('invalid_shell')
  })

  it.runIf(process.platform === 'win32')('PowerShell：能交互；标仅手动，AI 执行与 pwd 探测都不往里发命令', async () => {
    const mgr = new TerminalManager()
    const info = mgr.createLocal({ shell: 'powershell' })
    expect(info).toMatchObject({ title: 'PowerShell 1', shell: 'powershell', manualOnly: true, os: 'windows' })
    expect(await mgr.ready(info.id)).toMatchObject({ manualOnly: true })
    let buf = ''
    mgr.onData(info.id, (c) => { buf += c })
    await new Promise((r) => setTimeout(r, 1500))
    mgr.write(info.id, 'Write-Output ("PS" + "TOKEN")\r')
    for (let i = 0; i < 50 && !buf.includes('PSTOKEN'); i++) await new Promise((r) => setTimeout(r, 200))
    expect(buf).toContain('PSTOKEN')
    await expect(mgr.execCapture(info.id, 'echo x')).rejects.toThrow('shell_not_supported')
    const before = mgr.readSnapshot(info.id, 50)
    expect(await mgr.pwd(info.id)).toBeTruthy()   // 缓存的初始目录
    await new Promise((r) => setTimeout(r, 300))
    expect(mgr.readSnapshot(info.id, 50)).toBe(before)   // 没往终端里打 pwd
    // 第二个 PowerShell 编号独立于 Git Bash 的「本地 N」
    const b = mgr.createLocal({ shell: 'powershell' })
    expect(b.title).toBe('PowerShell 2')
    mgr.close(info.id); mgr.close(b.id)
  }, 30000)

  // WSL 探测逻辑用假终端（本机未必装了发行版）
  const fakeWsl = (uname: string) => {
    const h: { data?: (d: string) => void } = {}
    const calls: string[] = []
    const term = {
      onData: (cb: (d: string) => void) => { h.data = cb; return () => { h.data = undefined } },
      onExit: () => () => {},
      execCapture: async (cmd: string) => { calls.push(cmd); return { output: uname, exitCode: 0 } },
    }
    const mgr = new TerminalManager()
    const info = { id: 't1', title: 'Ubuntu 1', type: 'local', status: 'running', locked: false, shell: 'wsl:Ubuntu', manualOnly: true }
    ;(mgr as any).entries.set('t1', { term, info })
    return { mgr, h, calls, info, probe: (firstMs = 2000) => (mgr as any).probeWsl('t1', term, firstMs, 30) as Promise<void> }
  }
  it('WSL：等首屏安静后静默探测；探测期间上锁；uname 出 Linux → 允许 AI', async () => {
    const w = fakeWsl('Linux')
    const p = w.probe()
    expect(w.info.locked).toBe(true)
    w.h.data!('Welcome to Ubuntu\r\n')
    await new Promise((r) => setTimeout(r, 10))
    expect(w.calls).toEqual([])   // 还没安静下来
    w.h.data!('u@pc:~$ ')
    await p
    expect(w.calls).toEqual([expect.stringMatching(/; uname -s$/)])
    expect(w.info).toMatchObject({ locked: false })
    expect('manualOnly' in w.info).toBe(false)
    expect(w.h.data).toBeUndefined()   // 订阅已退
  })
  it('WSL：哨兵跑不通（fish 等，uname 拿不到）→ 保持仅手动；一直没输出也按上限时间探测', async () => {
    const w = fakeWsl('')
    await w.probe(50)
    expect(w.calls.length).toBe(1)
    expect(w.info.manualOnly).toBe(true)
  })
})
