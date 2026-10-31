import { describe, expect, it } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TerminalInfo } from '@lingshell/shared'
import { dockerAction, dockerList, dockerLogs, dockerStats, registerDocker, type ExecRead } from './docker.js'

// 假 execRead：按命令里的关键字返回预置输出（模拟远端 sh 的 stdout+stderr 合并 + 退出码标记）
const fake = (rules: [RegExp, string][]): ExecRead & { calls: string[] } => {
  const calls: string[] = []
  const f = async (cmd: string) => { calls.push(cmd); return rules.find(([re]) => re.test(cmd))?.[1] ?? '@@rc:1' }
  return Object.assign(f, { calls })
}
const PS = '{"ID":"a1b2c3d4e5f6","Image":"nginx","Names":"web","State":"running","Status":"Up 3 days","Ports":"","CreatedAt":"2026-10-01"}\n@@rc:0\n'
const DENIED = 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock\n@@rc:1\n'

describe('dockerList', () => {
  it('正常列出', async () => {
    const r = await dockerList(fake([[/docker ps/, PS]]), 'docker')
    expect(r).toMatchObject({ mode: 'docker', containers: [{ id: 'a1b2c3d4e5f6', name: 'web', state: 'running' }] })
  })
  it('未安装', async () => {
    expect((await dockerList(fake([[/docker ps/, 'sh: 1: docker: not found\n@@rc:127']]), 'docker')).problem).toBe('missing')
  })
  it('无权限 → 探测免密 sudo（可用 / 不可用）', async () => {
    const ok = fake([[/sudo -n true/, '@@rc:0'], [/docker ps/, DENIED]])
    expect(await dockerList(ok, 'docker')).toMatchObject({ problem: 'permission', sudoOk: true })
    expect(ok.calls.some((c) => c.includes('sudo -n true'))).toBe(true)
    const no = fake([[/sudo -n true/, 'sudo: a password is required\n@@rc:1'], [/docker ps/, DENIED]])
    expect(await dockerList(no, 'docker')).toMatchObject({ problem: 'permission', sudoOk: false })
  })
  it('sudo 模式：命令带 sudo -n；要密码 → sudo_denied，不再探测', async () => {
    const f = fake([[/sudo -n docker ps/, 'sudo: a password is required\n@@rc:1']])
    expect(await dockerList(f, 'sudo')).toMatchObject({ mode: 'sudo', problem: 'sudo_denied' })
    expect(f.calls).toHaveLength(1)
  })
})

describe('stats / logs / action', () => {
  it('stats 解析为对象', async () => {
    const s = await dockerStats(fake([[/docker stats/, '{"ID":"a1b2c3d4e5f6","Name":"web","CPUPerc":"2.00%","MemUsage":"1MiB / 1GiB","MemPerc":"0.1%"}\n@@rc:0']]), 'docker')
    expect(s.web).toEqual({ cpu: '2.00%', mem: '1MiB / 1GiB', memPct: '0.1%' })
  })
  it('logs 失败抛归类后的说明', async () => {
    await expect(dockerLogs(fake([[/docker logs/, 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n@@rc:1']]), 'docker', 'web')).rejects.toThrow('Docker 服务未运行')
    expect(await dockerLogs(fake([[/docker logs --tail 200 web/, 'line1\nline2\n@@rc:0']]), 'docker', 'web')).toBe('line1\nline2')
  })
  it('非法标识：不发任何命令', async () => {
    const f = fake([])
    await expect(dockerLogs(f, 'docker', 'web;reboot')).rejects.toThrow()
    await expect(dockerAction(f, 'docker', 'stop', '$(id)')).rejects.toThrow()
    expect(f.calls).toEqual([])
  })
  it('action 不抛：返回退出码 / 错误', async () => {
    expect(await dockerAction(fake([[/docker restart web/, 'web\n@@rc:0']]), 'docker', 'restart', 'web')).toEqual({ rc: 0 })
    expect(await dockerAction(fake([[/docker stop/, 'Error response from daemon: No such container: web\n@@rc:1']]), 'docker', 'stop', 'web')).toEqual({ rc: 1, error: 'Error response from daemon: No such container: web' })
  })
})

describe('registerDocker', () => {
  const setup = (out: string | (ExecRead & { calls: string[] })) => {
    const hs = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
    const audits: unknown[] = [], opened: string[] = []
    const f = typeof out === 'string' ? fake([[/docker/, out]]) : out
    registerDocker({
      handle: (ch, fn) => { hs.set(ch, fn) },
      terminal: (id) => ({ ssh1: { id: 'ssh1', type: 'ssh', os: 'linux' }, win: { id: 'win', type: 'ssh', os: 'windows' }, loc: { id: 'loc', type: 'local' } } as unknown as Record<string, TerminalInfo>)[id],
      exec: () => f,
      audit: (tid, e) => audits.push({ tid, ...e }),
      openTerminal: async (tid, line) => { opened.push(`${tid}|${line}`) },
    })
    const call = (ch: string, ...a: unknown[]) => Promise.resolve().then(() => hs.get(ch)!({}, ...a))   // ipcMain.handle 同样把同步抛错转成 reject
    return { call, audits, opened, calls: f.calls }
  }
  it('启停记执行记录（成功 / 失败都记，带退出码）', async () => {
    const ok = setup('@@rc:0')
    await ok.call('docker:action', 'ssh1', 'sudo', 'stop', 'a1b2c3d4e5f6', 'web')
    expect(ok.audits).toEqual([{ tid: 'ssh1', command: 'sudo -n docker stop a1b2c3d4e5f6 (web)', decision: 'docker_stop', exitCode: 0 }])
    const bad = setup('Error: boom\n@@rc:1')
    await expect(bad.call('docker:action', 'ssh1', 'docker', 'restart', 'web', 'web')).rejects.toThrow('Error: boom')
    expect(bad.audits).toEqual([{ tid: 'ssh1', command: 'docker restart web', decision: 'docker_restart', exitCode: 1 }])
  })
  it('拒绝：非 SSH Linux/macOS 终端、非法操作 / 标识，不发命令不记录', async () => {
    const s = setup('@@rc:0')
    await expect(s.call('docker:list', 'loc', 'docker')).rejects.toThrow('只支持')
    await expect(s.call('docker:list', 'win', 'docker')).rejects.toThrow('只支持')
    await expect(s.call('docker:action', 'ssh1', 'docker', 'rm', 'web', 'web')).rejects.toThrow('非法的容器操作')
    await expect(s.call('docker:action', 'ssh1', 'docker', 'stop', 'web && reboot', 'x')).rejects.toThrow('非法的容器标识')
    await expect(s.call('docker:openTerminal', 'ssh1', 'docker', 'exec', '$(id)')).rejects.toThrow('非法的容器标识')
    expect(s.calls).toEqual([]); expect(s.audits).toEqual([]); expect(s.opened).toEqual([])
  })
  it('Compose 启动：忽略渲染层传来的配置文件路径，只用服务端 compose ls 的结果', async () => {
    const f = fake([
      [/compose ls/, '[{"Name":"app","Status":"running(2)","ConfigFiles":"/srv/app/docker-compose.yml, /srv/app/compose.override.yml"}]\n@@rc:0'],
      [/compose -p app/, '@@rc:0'],
    ])
    const s = setup(f)
    await s.call('docker:composeAction', 'ssh1', 'docker', 'up', { name: 'app', configFiles: ['/tmp/evil.yml'] })
    const cmd = f.calls.find((c) => c.includes('compose -p app'))!
    expect(cmd).toContain('/srv/app/docker-compose.yml')
    expect(cmd).toContain('/srv/app/compose.override.yml')
    expect(cmd).not.toContain('/tmp/evil.yml')
    // 服务端没有这个项目：拒绝，不执行 compose 操作
    const bad = setup(fake([[/compose ls/, '[]\n@@rc:0']]))
    await expect(bad.call('docker:composeAction', 'ssh1', 'docker', 'up', { name: 'ghost', configFiles: [] })).rejects.toThrow('没有这个 Compose 项目')
    expect(bad.calls.some((c) => c.includes('compose -p ghost'))).toBe(false)
  })
  it('新终端命令：follow / exec，未知 mode 当 docker', async () => {
    const s = setup('')
    await s.call('docker:openTerminal', 'ssh1', 'evil', 'follow', 'web')
    await s.call('docker:openTerminal', 'ssh1', 'sudo', 'exec', 'web')
    expect(s.opened).toEqual(['ssh1|docker logs -f --tail 100 web', `ssh1|sudo -n docker exec -it web sh -c 'command -v bash >/dev/null && exec bash || exec sh'`])
  })
})

// 真 sh 跑包装后的命令，PATH 前面放一个假 docker 脚本：验证引号 / 2>&1 / 退出码标记在 shell 里确实成立。没有 sh 则跳过
const hasSh = (() => { try { execFileSync('sh', ['-c', 'true']); return true } catch { return false } })()
describe.skipIf(!hasSh)('真 sh + 假 docker', () => {
  const withFakeDocker = async (script: string, fn: (exec: ExecRead) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-docker-'))
    writeFileSync(join(dir, 'docker'), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
    const env = { ...process.env, PATH: `${dir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` }
    // 外层再包一层 sh 把 PATH 换成 POSIX 形式（Git Bash 下 Windows 路径不认）
    const exec: ExecRead = (cmd, ms) => new Promise((res, rej) => execFile('sh', ['-c', `PATH="$(cd "$FAKE_DIR" && pwd):$PATH"; ${cmd}`], { env: { ...env, FAKE_DIR: dir }, timeout: ms }, (e, out) => e ? rej(e) : res(out)))
    try { await fn(exec) } finally { rmSync(dir, { recursive: true, force: true }) }
  }
  it('ps 的 {{json .}} 原样传给 docker，stdout 解析成功', async () => {
    await withFakeDocker(`[ "$4" = '{{json .}}' ] || { echo "bad args: $*" >&2; exit 2; }\necho '{"ID":"abc123","Names":"web","State":"running","Status":"Up"}'`, async (exec) => {
      expect((await dockerList(exec, 'docker')).containers?.map((c) => c.name)).toEqual(['web'])
    })
  }, 20000)
  it('stderr 并进输出 → 权限问题被识别', async () => {
    await withFakeDocker(`echo 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock' >&2; exit 1`, async (exec) => {
      expect((await dockerList(exec, 'docker')).problem).toBe('permission')
    })
  }, 20000)
})
