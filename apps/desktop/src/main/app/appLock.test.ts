import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMain } from 'electron'
import { lockBackoffMs, shouldIdleLock } from '@lingshell/shared'
import { AppLock, hashPassword, verifyPassword, installLockGate, allowedWhileLocked } from './appLock.js'

describe('hash / verify', () => {
  it('对的过、错的不过；不同盐哈希不同；文件里没有明文', async () => {
    const a = await hashPassword('secret-123')
    const b = await hashPassword('secret-123')
    expect(a.hash).not.toBe(b.hash)
    expect(await verifyPassword('secret-123', a)).toBe(true)
    expect(await verifyPassword('secret-124', a)).toBe(false)
    expect(JSON.stringify(a)).not.toContain('secret-123')
  })
})

describe('退避与空闲（纯函数）', () => {
  it('1s、2s、4s… 封顶 5 分钟', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 10].map(lockBackoffMs)).toEqual([0, 1000, 2000, 4000, 8000, 16000, 32000, 300_000])
  })
  it('空闲够了才锁；0 分钟 / 未启用 / 已锁都不锁', () => {
    const base = { enabled: true, locked: false, idleMinutes: 10, idleSec: 600 }
    expect(shouldIdleLock(base)).toBe(true)
    expect(shouldIdleLock({ ...base, idleSec: 599 })).toBe(false)
    expect(shouldIdleLock({ ...base, idleMinutes: 0, idleSec: 99999 })).toBe(false)
    expect(shouldIdleLock({ ...base, enabled: false })).toBe(false)
    expect(shouldIdleLock({ ...base, locked: true })).toBe(false)
  })
})

describe('AppLock', () => {
  let dir: string, file: string, t: number
  const events: boolean[] = []
  const mk = () => new AppLock(file, (l) => events.push(l), () => t)
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lingshell-lock-')); file = join(dir, 'lock.json'); t = 1_000_000; events.length = 0 })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('未设密码：不锁、lock() 无效', () => {
    const l = mk()
    expect(l.status()).toMatchObject({ enabled: false, locked: false })
    expect(l.lock()).toBe(false)
  })

  it('设密码：至少 6 位，且拒绝纯数字 / 几乎重复；设了之后启动即锁，对的密码解锁', async () => {
    await expect(mk().setPassword('12345')).rejects.toThrow('至少 6 位')
    await expect(mk().setPassword('123456')).rejects.toThrow('不能是纯数字')
    await expect(mk().setPassword('aaaaaa')).rejects.toThrow('太简单')
    await mk().setPassword('abcdef')
    expect(readFileSync(file, 'utf8')).not.toContain('abcdef')
    const l = mk()
    expect(l.status()).toMatchObject({ enabled: true, locked: true })
    expect(await l.unlock('abcdef')).toEqual({ ok: true })
    expect(l.locked).toBe(false)
    expect(events).toEqual([false])
    expect(l.lock()).toBe(true)
    expect(events).toEqual([false, true])
  })

  it('输错：退避递增，退避期内对的密码也不验；失败计数落盘（重启不清零），成功后清零', async () => {
    await mk().setPassword('abcdef')
    let l = mk()
    expect(await l.unlock('x')).toEqual({ ok: false, failures: 1, retryAfterMs: 1000 })
    expect(await l.unlock('abcdef')).toMatchObject({ ok: false, failures: 1 })   // 1s 内被拒
    t += 1000
    expect(await l.unlock('y')).toEqual({ ok: false, failures: 2, retryAfterMs: 2000 })
    l = mk()   // 重启
    expect(l.status()).toMatchObject({ failures: 2, retryAfterMs: 2000 })
    t += 2000
    expect(await l.unlock('abcdef')).toEqual({ ok: true })
    expect(l.status().failures).toBe(0)
  })

  it('并发猜测被串行化：同一退避窗口里只验一次', async () => {
    await mk().setPassword('abcdef')
    const l = mk()
    const rs = await Promise.all(['a', 'b', 'c', 'abcdef'].map((p) => l.unlock(p)))
    expect(rs.filter((r) => r.ok)).toHaveLength(0)
    expect(l.status().failures).toBe(1)
  })

  it('改密 / 关闭都要当前密码', async () => {
    const l = mk()
    await l.setPassword('abcdef')
    await expect(l.setPassword('newpass1', 'wrong')).rejects.toThrow('当前密码错误')
    await expect(l.disable('abcdef')).rejects.toThrow('过于频繁')
    t += 1000
    await l.setPassword('newpass1', 'abcdef')
    await l.disable('newpass1')
    expect(existsSync(file)).toBe(false)
    expect(l.status().enabled).toBe(false)
  })

  it('忘记密码：删掉 lock.json 后解锁直接通过', async () => {
    await mk().setPassword('abcdef')
    const l = mk()
    rmSync(file)
    expect(await l.unlock('')).toEqual({ ok: true })
  })

  it('lock.json 损坏 / 结构不对：保持锁定、标记 damaged、不能当成没设密码（失败关闭）', async () => {
    for (const bad of ['{oops', '{}', '{"v":1,"salt":"x"}']) {
      writeFileSync(file, bad)
      const l = mk()
      expect(l.status(), bad).toMatchObject({ enabled: true, locked: true, damaged: true })
      await expect(l.unlock('anything')).rejects.toThrow(/lock_damaged/)
      expect(l.locked).toBe(true)
    }
    // 运行中文件被删（忘记密码的出路）仍然可用
    rmSync(file)
    expect(await mk().unlock('')).toEqual({ ok: true })
  })
})

describe('IPC 门禁', () => {
  function fakeIpc() {
    const hs = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
    const ipc = { handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => { hs.set(ch, fn) } }
    return { ipc: ipc as unknown as Pick<IpcMain, 'handle'>, call: (ch: string, ...a: unknown[]) => hs.get(ch)!({}, ...a) }
  }
  const SENSITIVE = ['terminal:createLocal', 'terminal:createSsh', 'terminal:write', 'hosts:list', 'fs:readText', 'config:export',
    'system:exportDiagnostics', 'agent:sendTurn', 'auth:decide', 'knownHosts:decide', 'settings:get', 'lock:setPassword', 'lock:disable', 'some:futureChannel']

  it('锁定时敏感通道抛 locked，放行解锁/状态/版本信息；解锁后全部放行', () => {
    let locked = true
    const { ipc, call } = fakeIpc()
    installLockGate(ipc, () => locked)
    for (const ch of [...SENSITIVE, 'lock:status', 'lock:unlock', 'lock:lock', 'system:getUpdateStatus', 'terminal:resize']) ipc.handle(ch, (_e, x) => `ok:${String(x)}`)
    for (const ch of SENSITIVE) expect(() => call(ch, 1), ch).toThrow(/^locked/)
    for (const ch of ['lock:status', 'lock:unlock', 'lock:lock', 'system:getUpdateStatus', 'terminal:resize']) expect(call(ch, 1)).toBe('ok:1')
    locked = false
    for (const ch of SENSITIVE) expect(call(ch, 2)).toBe('ok:2')
  })

  it('白名单只有少数几个', () => {
    expect(allowedWhileLocked('window:close')).toBe(true)
    expect(allowedWhileLocked('lock:disable')).toBe(false)
    expect(allowedWhileLocked('terminal:list')).toBe(false)
  })
})
