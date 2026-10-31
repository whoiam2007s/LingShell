import { it, expect } from 'vitest'
import ssh2 from 'ssh2'
import type { AddressInfo } from 'node:net'
import { setHostKeyPolicy, SshTerminal } from '@lingshell/terminal-core'
import { systemdActionCommand, systemdListCommand, systemdStatusCommand, type SvcList, type TerminalInfo } from '@lingshell/shared'
import { registerSystemd } from './systemdIpc.js'

// 本机回环的假 sshd：按收到的 exec 命令回固定输出（systemctl 列表 / status / 操作结果）。不连任何真实主机
const { Server, utils } = ssh2 as unknown as { Server: typeof import('ssh2').Server; utils: typeof import('ssh2').utils }

function fakeSshd(reply: (cmd: string) => string) {
  const execs: string[] = []
  const s = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (c) => {
    c.on('authentication', (ctx) => ctx.accept())
    c.on('error', () => {})
    c.on('session', (accept) => {
      const session = accept()
      session.on('pty', (ok) => ok?.())
      session.on('shell', (ok) => { ok() })
      session.on('exec', (ok, _rej, info) => {
        execs.push(info.command)
        const ch = ok()
        ch.write(reply(info.command))
        ch.exit(0); ch.end()
      })
    })
  })
  return new Promise<{ port: number; execs: string[]; close(): void }>((r) => s.listen(0, '127.0.0.1', () => r({ port: (s.address() as AddressInfo).port, execs, close: () => s.close() })))
}

it('列服务、看 status、重启记执行记录；sudo 要密码时报错带原文且也记一笔', async () => {
  const db = new Map<string, { keyType: string; fingerprint: string }>()
  setHostKeyPolicy({ lookup: (hp) => db.get(hp), remember: (hp, keyType, fingerprint) => { db.set(hp, { keyType, fingerprint }) }, prompt: async () => true })
  let sudoOk = true
  const srv = await fakeSshd((cmd) => {
    if (cmd === systemdListCommand()) return '@@units\nnginx.service loaded failed failed Nginx web\nssh.service loaded active running SSH\n@@files\nnginx.service enabled enabled\nssh.service enabled enabled\nredis.service disabled enabled\n'
    if (cmd === systemdStatusCommand('nginx.service')) return '× nginx.service - Nginx web\n     Active: failed (Result: exit-code)\n@@rc:3\n'
    if (cmd === systemdActionCommand('restart', 'nginx.service')) return sudoOk ? '@@rc:0\n' : 'sudo: a password is required\n@@rc:1\n'
    return '@@rc:127\n'
  })
  const t = await SshTerminal.connect('s1', { host: '127.0.0.1', port: srv.port, username: 'u', password: 'p' })
  const audits: { command: string; decision: string; exitCode?: number }[] = []
  try {
    const hs = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
    registerSystemd({
      handle: (ch, fn) => { hs.set(ch, fn) },
      terminal: (id) => (id === 's1' ? ({ id, type: 'ssh', os: 'linux', title: 'u@127.0.0.1' } as TerminalInfo) : id === 'mac' ? ({ id, type: 'ssh', os: 'macos', title: 'mac' } as TerminalInfo) : undefined),
      exec: () => (cmd, ms) => t.execRead(cmd, ms),
      audit: (_id, e) => { audits.push(e) },
    })
    const call = <T>(ch: string, ...a: unknown[]) => hs.get(ch)!({}, ...a) as Promise<T>
    const list = await call<SvcList>('systemd:list', 's1')
    expect(list.rows.map((r) => [r.name, r.active, r.enabled])).toEqual([['nginx.service', 'failed', 'enabled'], ['ssh.service', 'active', 'enabled'], ['redis.service', 'inactive', 'disabled']])
    expect(await call<string>('systemd:status', 's1', 'nginx.service')).toContain('Active: failed')

    expect(await call<string>('systemd:action', 's1', 'nginx.service', 'restart')).toBe('')
    expect(audits).toEqual([{ command: 'systemctl restart nginx.service', decision: 'systemd_restart', exitCode: 0 }])
    sudoOk = false
    await expect(call('systemd:action', 's1', 'nginx.service', 'restart')).rejects.toThrow(/需要 root 权限[\s\S]*sudo: a password is required/)
    expect(audits[1]).toEqual({ command: 'systemctl restart nginx.service', decision: 'systemd_restart', exitCode: 1 })

    // 参数校验 / 不支持的终端
    await expect(call('systemd:action', 's1', 'x;reboot.service', 'restart')).rejects.toThrow('非法的服务名')
    await expect(call('systemd:action', 's1', 'nginx.service', 'mask')).rejects.toThrow('非法的服务操作')
    await expect(call('systemd:list', 'mac')).rejects.toThrow('只支持 Linux')
    await expect(call('systemd:list', 'nope')).rejects.toThrow('terminal_not_found')
    expect(srv.execs.some((c) => c.includes('reboot'))).toBe(false)
  } finally { t.kill(); srv.close() }
}, 30000)
