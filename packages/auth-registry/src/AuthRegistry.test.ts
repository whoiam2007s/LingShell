import { describe, it, expect, beforeEach } from 'vitest'
import { AuthRegistry } from './AuthRegistry.js'
import type { AuthStore } from './AuthRegistry.js'

function memStore(): AuthStore {
  let state = { records: [] as any[], trust: {} as Record<string, any> }
  return { load: () => state, save: (s) => { state = s } }
}

describe('AuthRegistry.decide', () => {
  let reg: AuthRegistry
  beforeEach(() => { reg = new AuthRegistry({ store: memStore() }) })

  it('readonly 档：write 直接拒绝', () => {
    reg.setTrust('s1', 'readonly')
    expect(reg.decide('s1', 't1', 'write').kind).toBe('deny')
  })
  it('readonly 档：read 且无记录 → 破冰 first_access', () => {
    reg.setTrust('s1', 'readonly')
    const d = reg.decide('s1', 't1', 'read')
    expect(d).toMatchObject({ kind: 'prompt', reason: 'first_access' })
  })
  it('全自主档（默认）：首次 write → first_access', () => {
    const d = reg.decide('s1', 't1', 'write', 'ls')
    expect(d).toMatchObject({ kind: 'prompt', reason: 'first_access' })
  })
  it('全自主档：已有 write、安全命令 → allow', () => {
    reg.grant('s1', 't1', 'write')
    expect(reg.decide('s1', 't1', 'write', 'ls -la')).toEqual({ kind: 'allow' })
  })
  it('全自主档：已有 write、危险命令 → 仍 prompt dangerous_command（安全闸）', () => {
    reg.grant('s1', 't1', 'write')
    const d = reg.decide('s1', 't1', 'write', 'rm -rf /tmp/x')
    expect(d).toMatchObject({ kind: 'prompt', reason: 'dangerous_command', risk: 'dangerous' })
  })
  it('生产主机：全自主档已有 write 仍逐条确认；危险命令无视开关；read 不问；readonly 仍拒绝', () => {
    reg.grant('s1', 't1', 'write')
    expect(reg.decide('s1', 't1', 'write', 'ls', true, true)).toMatchObject({ kind: 'prompt', reason: 'elevation' })
    expect(reg.decide('s1', 't1', 'write', 'rm -rf /tmp/x', false, true)).toMatchObject({ kind: 'prompt', reason: 'dangerous_command' })
    expect(reg.decide('s1', 't1', 'read', undefined, true, true)).toEqual({ kind: 'allow' })
    // 非生产对照：同样条件直接放行
    expect(reg.decide('s1', 't1', 'write', 'rm -rf /tmp/x', false, false)).toEqual({ kind: 'allow' })
    reg.setTrust('s1', 'readonly')
    expect(reg.decide('s1', 't1', 'write', 'ls', true, true).kind).toBe('deny')
  })
  it('确认档：有 read 但需 write → elevation', () => {
    reg.setTrust('s1', 'confirm')
    reg.grant('s1', 't1', 'read')
    const d = reg.decide('s1', 't1', 'write', 'echo hi')
    expect(d).toMatchObject({ kind: 'prompt', reason: 'elevation' })
  })
  it('确认档：即便已授权 write，每条 write 仍逐命令确认（read 不问）', () => {
    reg.setTrust('s1', 'confirm')
    reg.grant('s1', 't1', 'write')
    // 普通 write 已授权，但确认档下仍要弹卡
    expect(reg.decide('s1', 't1', 'write', 'echo hi').kind).toBe('prompt')
    // read 安全，已授权直接放行
    expect(reg.decide('s1', 't1', 'read').kind).toBe('allow')
  })
  it('全自主档：已授权 write 安全命令直接放行（对比确认档）', () => {
    reg.setTrust('s1', 'autonomous')
    reg.grant('s1', 't1', 'write')
    expect(reg.decide('s1', 't1', 'write', 'echo hi')).toEqual({ kind: 'allow' })
  })
  it('write 隐含 read：grant write 后 read 直接 allow', () => {
    reg.grant('s1', 't1', 'write')
    expect(reg.decide('s1', 't1', 'read').kind).toBe('allow')
  })
})

describe('AuthRegistry 记录/信任档', () => {
  let reg: AuthRegistry
  beforeEach(() => { reg = new AuthRegistry({ store: memStore() }) })

  it('grant/getLevel/listForSession', () => {
    reg.grant('s1', 't1', 'read')
    reg.grant('s1', 't2', 'write')
    expect(reg.getLevel('s1', 't1')).toBe('read')
    expect(reg.listForSession('s1')).toEqual(
      expect.arrayContaining([
        { terminalId: 't1', level: 'read' },
        { terminalId: 't2', level: 'write' },
      ]),
    )
  })
  it('revoke 后回 none', () => {
    reg.grant('s1', 't1', 'write')
    reg.revoke('s1', 't1')
    expect(reg.getLevel('s1', 't1')).toBe('none')
  })
  it('revokeSession 清掉该会话全部授权和信任档，不动别的会话', () => {
    reg.grant('s1', 't1', 'write'); reg.grant('s1', 't2', 'read'); reg.grant('s2', 't1', 'write')
    reg.setTrust('s1', 'readonly')
    reg.revokeSession('s1')
    expect(reg.listForSession('s1')).toEqual([])
    expect(reg.getTrust('s1')).toBe('autonomous')
    expect(reg.getLevel('s2', 't1')).toBe('write')
  })
  it('trust 默认 autonomous，可设可取', () => {
    expect(reg.getTrust('s9')).toBe('autonomous')
    reg.setTrust('s9', 'confirm')
    expect(reg.getTrust('s9')).toBe('confirm')
  })
})

describe('危险命令确认开关', () => {
  it('confirmDangerous=false 时，已授权 write 的危险命令直接放行；=true 仍逐次确认', () => {
    const reg = new AuthRegistry({ store: memStore() })
    reg.grant('s1', 'local', 'write')
    const cmd = 'rm -rf /opt/app'
    expect(reg.decide('s1', 'local', 'write', cmd).kind).toBe('prompt')            // 默认：闸门开着
    expect(reg.decide('s1', 'local', 'write', cmd, true).kind).toBe('prompt')
    expect(reg.decide('s1', 'local', 'write', cmd, false).kind).toBe('allow')      // 关掉：只认 write 授权
  })

  it('关掉确认闸也不给未授权的放行', () => {
    const reg = new AuthRegistry({ store: memStore() })
    expect(reg.decide('s1', 'local', 'write', 'rm -rf /', false).kind).toBe('prompt')   // 无授权仍要问
    reg.setTrust('s1', 'readonly')
    expect(reg.decide('s1', 'local', 'write', 'rm -rf /', false).kind).toBe('deny')     // 只读档仍拒
  })
})
