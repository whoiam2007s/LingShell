import { describe, expect, it } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TerminalInfo } from '@lingshell/shared'
import { processList, processSignal, registerProcesses, type ExecRead } from './processes.js'

const PS = 'PID PPID USER %CPU %MEM RSS ELAPSED STAT COMMAND\n  77 1 root 1.0 0.1 100 00:10 S nginx: master\n'
const fake = (out: string): ExecRead & { calls: string[] } => {
  const calls: string[] = []
  return Object.assign(async (cmd: string) => { calls.push(cmd); return out }, { calls })
}

describe('processList / processSignal', () => {
  it('解析 / 读不到时报错', async () => {
    expect((await processList(fake(PS))).rows[0]).toMatchObject({ pid: 77, command: 'nginx: master' })
    await expect(processList(fake(''))).rejects.toThrow('读不到进程列表')
  })
  it('信号结果：成功 / 无权限 / 已不存在', async () => {
    expect(await processSignal(fake('@@rc:0'), 77, 'TERM')).toEqual({ rc: 0 })
    expect(await processSignal(fake('sh: kill: (77) - Operation not permitted\n@@rc:1'), 77, 'KILL')).toEqual({ rc: 1, error: '没有权限（该进程属于其他用户，需要 root）' })
    expect((await processSignal(fake('kill: (77) - No such process\n@@rc:1'), 77, 'HUP')).error).toBe('进程已不存在')
  })
})

describe('registerProcesses', () => {
  const setup = (out: string) => {
    const hs = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
    const audits: unknown[] = []
    const f = fake(out)
    registerProcesses({
      handle: (ch, fn) => { hs.set(ch, fn) },
      terminal: (id) => ({ ssh1: { id: 'ssh1', type: 'ssh', os: 'linux' }, win: { id: 'win', type: 'ssh', os: 'windows' }, loc: { id: 'loc', type: 'local', os: 'linux' } } as unknown as Record<string, TerminalInfo>)[id],
      exec: () => f,
      audit: (tid, e) => audits.push({ tid, ...e }),
    })
    const call = (ch: string, ...a: unknown[]) => Promise.resolve().then(() => hs.get(ch)!({}, ...a))
    return { call, audits, calls: f.calls }
  }
  it('发信号记执行记录 process_kill（成功 / 失败都记，带 pid、命令行、退出码）', async () => {
    const ok = setup('@@rc:0')
    await ok.call('processes:signal', 'ssh1', 77, 'TERM', 'nginx: master')
    expect(ok.calls).toEqual([`sh -c 'export LC_ALL=C; kill -TERM 77 2>&1; echo "@@rc:$?"'`])
    expect(ok.audits).toEqual([{ tid: 'ssh1', command: 'kill -TERM 77  # nginx: master', decision: 'process_kill', exitCode: 0 }])
    const bad = setup('Operation not permitted\n@@rc:1')
    await expect(bad.call('processes:signal', 'ssh1', 77, 'KILL', 'x')).rejects.toThrow('没有权限')
    expect(bad.audits).toEqual([{ tid: 'ssh1', command: 'kill -KILL 77  # x', decision: 'process_kill', exitCode: 1 }])
  })
  it('拒绝：本地 / Windows 终端、非法 pid / 信号，不发命令不记录', async () => {
    const s = setup('@@rc:0')
    await expect(s.call('processes:list', 'loc')).rejects.toThrow('只支持')
    await expect(s.call('processes:list', 'win')).rejects.toThrow('只支持')
    await expect(s.call('processes:list', 'nope')).rejects.toThrow('terminal_not_found')
    await expect(s.call('processes:signal', 'ssh1', 1, 'KILL', 'init')).rejects.toThrow('非法的进程号')
    await expect(s.call('processes:signal', 'ssh1', '77; reboot', 'KILL', '')).rejects.toThrow('非法的进程号')
    await expect(s.call('processes:signal', 'ssh1', 77, 'STOP', '')).rejects.toThrow('非法的信号')
    expect(s.calls).toEqual([]); expect(s.audits).toEqual([])
  })
})

// 真 sh 跑 ps 降级链，PATH 前面放假 ps：模拟 GNU / macOS / busybox 各自只认自己的参数。没有 sh 则跳过
const hasSh = (() => { try { execFileSync('sh', ['-c', 'true']); return true } catch { return false } })()
describe.skipIf(!hasSh)('真 sh + 假 ps 降级链', () => {
  const withFakePs = async (script: string, fn: (exec: ExecRead) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-ps-'))
    writeFileSync(join(dir, 'ps'), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
    // 同 SSH execRead：不管退出码，只回 stdout
    const exec: ExecRead = (cmd, ms) => new Promise((res) => execFile('sh', ['-c', `PATH="$(cd "$FAKE_DIR" && pwd):$PATH"; ${cmd}`], { env: { ...process.env, FAKE_DIR: dir }, timeout: ms }, (_e, out) => res(out)))
    try { await fn(exec) } finally { rmSync(dir, { recursive: true, force: true }) }
  }
  it('GNU：第一档就成功，参数原样传到 ps', async () => {
    await withFakePs(`case "$*" in *--sort=-pcpu*) echo 'PID PPID USER %CPU %MEM RSS ELAPSED STAT COMMAND'; echo '5 1 root 9.9 0.1 10 00:01 R top -b';; *) exit 1;; esac`, async (exec) => {
      expect((await processList(exec)).rows).toMatchObject([{ pid: 5, cpu: 9.9, command: 'top -b' }])
    })
  }, 20000)
  it('macOS：GNU 参数报错后走 -axr', async () => {
    await withFakePs(`case "$*" in -axr*) echo 'PID PPID USER %CPU %MEM RSS ELAPSED STAT ARGS'; echo '9 1 me 1.0 0.1 10 01:00 S /bin/zsh -l';; *) echo "ps: illegal option" >&2; exit 1;; esac`, async (exec) => {
      expect((await processList(exec)).rows).toMatchObject([{ pid: 9, user: 'me', command: '/bin/zsh -l' }])
    })
  }, 20000)
  it('busybox：只认 -o 的降级列，超过 500 行截断', async () => {
    await withFakePs(`case "$*" in "-o pid,ppid,user,rss,etime,stat,args") echo 'PID PPID USER RSS ELAPSED STAT COMMAND'; i=2; while [ $i -le 700 ]; do echo "$i 1 root 1.2m 3h S sleep $i"; i=$((i+1)); done;; *) echo "ps: invalid option" >&2; exit 1;; esac`, async (exec) => {
      const r = await processList(exec)
      expect(r.hasCpu).toBe(false)
      expect(r.rows).toHaveLength(500)
      expect(r.truncated).toBe(true)
      expect(r.rows[0]).toMatchObject({ pid: 2, rss: 1229, elapsed: 10800, command: 'sleep 2' })
    })
  }, 20000)
  it('全部失败：报错', async () => {
    await withFakePs('exit 1', async (exec) => { await expect(processList(exec)).rejects.toThrow('读不到进程列表') })
  }, 20000)
})
