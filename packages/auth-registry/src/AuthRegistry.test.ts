import { describe, it, expect, beforeEach } from 'vitest'
import { AuthRegistry } from './AuthRegistry.js'
import type { AuthState, AuthStore } from './AuthRegistry.js'
import type { ExecMode } from '@lingshell/shared'

function memStore(init?: Partial<AuthState>): AuthStore {
  let state: AuthState = { records: [], execMode: {}, trust: {}, ...init }
  return { load: () => state, save: (s) => { state = s } }
}

describe('AuthRegistry.decide', () => {
  let reg: AuthRegistry
  beforeEach(() => { reg = new AuthRegistry({ store: memStore() }) })

  it('逐条确认档（默认）：即便已授权 write，每条 write 仍逐命令确认；read 不问', () => {
    // 默认 execMode = confirm，底层信任档派生为 confirm
    expect(reg.getExecMode('s1')).toBe('confirm')
    expect(reg.getTrust('s1')).toBe('confirm')
    expect(reg.decide('s1', 't1', 'write', 'echo hi')).toMatchObject({ kind: 'prompt' })
    reg.grant('s1', 't1', 'write')
    expect(reg.decide('s1', 't1', 'write', 'echo hi')).toMatchObject({ kind: 'prompt', reason: 'elevation' })
    // 第二条、第三条一样要问
    expect(reg.decide('s1', 't1', 'write', 'echo hi 2')).toMatchObject({ kind: 'prompt' })
    expect(reg.decide('s1', 't1', 'read').kind).toBe('allow')
  })
  it('内部只读档（定时巡检）：write 直接拒绝，read 破冰 first_access', () => {
    reg.markReadonly('s1')
    expect(reg.getTrust('s1')).toBe('readonly')
    expect(reg.decide('s1', 't1', 'write').kind).toBe('deny')
    expect(reg.decide('s1', 't1', 'read')).toMatchObject({ kind: 'prompt', reason: 'first_access' })
    // 只读标记不会被四档放宽：切成信任档也照样拒
    reg.setExecMode('s1', 'trust')
    expect(reg.decide('s1', 't1', 'write').kind).toBe('deny')
    // 清掉标记后回到按模式判定
    reg.clearReadonly('s1')
    expect(reg.getTrust('s1')).toBe('autonomous')
  })
  it('确认一次档：首次 write → first_access', () => {
    reg.setExecMode('s1', 'auto')
    const d = reg.decide('s1', 't1', 'write', 'ls')
    expect(d).toMatchObject({ kind: 'prompt', reason: 'first_access' })
  })
  it('确认一次档：已有 write、安全命令 → allow', () => {
    reg.setExecMode('s1', 'auto')
    reg.grant('s1', 't1', 'write')
    expect(reg.decide('s1', 't1', 'write', 'ls -la')).toEqual({ kind: 'allow' })
  })
  it('确认一次档：已有 write、危险命令 → 仍 prompt dangerous_command（安全闸）', () => {
    reg.setExecMode('s1', 'auto')
    reg.grant('s1', 't1', 'write')
    const d = reg.decide('s1', 't1', 'write', 'rm -rf /tmp/x')
    expect(d).toMatchObject({ kind: 'prompt', reason: 'dangerous_command', risk: 'dangerous' })
  })
  it('生产主机：确认一次档已有 write 仍逐条确认；危险命令无视开关；read 不问；只读档仍拒绝', () => {
    reg.setExecMode('s1', 'auto')
    reg.grant('s1', 't1', 'write')
    expect(reg.decide('s1', 't1', 'write', 'ls', true, true)).toMatchObject({ kind: 'prompt', reason: 'elevation' })
    expect(reg.decide('s1', 't1', 'write', 'rm -rf /tmp/x', false, true)).toMatchObject({ kind: 'prompt', reason: 'dangerous_command' })
    expect(reg.decide('s1', 't1', 'read', undefined, true, true)).toEqual({ kind: 'allow' })
    // 非生产对照：同样条件直接放行
    expect(reg.decide('s1', 't1', 'write', 'rm -rf /tmp/x', false, false)).toEqual({ kind: 'allow' })
    reg.markReadonly('s1')
    expect(reg.decide('s1', 't1', 'write', 'ls', true, true).kind).toBe('deny')
  })
  it('逐条确认档：有 read 但需 write → elevation', () => {
    reg.setExecMode('s1', 'confirm')
    reg.grant('s1', 't1', 'read')
    const d = reg.decide('s1', 't1', 'write', 'echo hi')
    expect(d).toMatchObject({ kind: 'prompt', reason: 'elevation' })
  })
  it('确认一次档与逐条确认档的差异：已授权 write 的安全命令', () => {
    reg.setExecMode('s1', 'auto')
    reg.grant('s1', 't1', 'write')
    expect(reg.decide('s1', 't1', 'write', 'echo hi')).toEqual({ kind: 'allow' })
    reg.setExecMode('s1', 'confirm')
    expect(reg.decide('s1', 't1', 'write', 'echo hi').kind).toBe('prompt')
  })
  it('write 隐含 read：grant write 后 read 直接 allow', () => {
    reg.grant('s1', 't1', 'write')
    expect(reg.decide('s1', 't1', 'read').kind).toBe('allow')
  })
})

describe('AuthRegistry 四档执行模式', () => {
  it('默认 confirm；set/get 成对', () => {
    const reg = new AuthRegistry({ store: memStore() })
    expect(reg.getExecMode('s9')).toBe('confirm')
    reg.setExecMode('s9', 'trust')
    expect(reg.getExecMode('s9')).toBe('trust')
    expect(reg.getTrust('s9')).toBe('autonomous')
  })
  it('四档 → 底层信任档：preview/confirm 派生成 confirm，auto/trust 派生成 autonomous', () => {
    const reg = new AuthRegistry({ store: memStore() })
    const cases: [ExecMode, string][] = [
      ['preview', 'confirm'], ['confirm', 'confirm'], ['auto', 'autonomous'], ['trust', 'autonomous'],
    ]
    for (const [mode, trust] of cases) {
      reg.setExecMode('s1', mode)
      expect(reg.getTrust('s1')).toBe(trust)
    }
  })
  it('持久化：换一个实例读同一个 store，模式还在', () => {
    const store = memStore()
    const a = new AuthRegistry({ store })
    a.setExecMode('s1', 'auto')
    const b = new AuthRegistry({ store })
    expect(b.getExecMode('s1')).toBe('auto')
  })
  it('迁移旧数据：没有 execMode 时按旧 trust 换算（autonomous→auto、confirm→confirm、readonly→preview）', () => {
    const reg = new AuthRegistry({
      store: memStore({ trust: { s1: 'autonomous', s2: 'confirm', s3: 'readonly' } }),
    })
    expect(reg.getExecMode('s1')).toBe('auto')
    expect(reg.getExecMode('s2')).toBe('confirm')
    expect(reg.getExecMode('s3')).toBe('preview')
    // 两者都在时以 execMode 为准
    const reg2 = new AuthRegistry({ store: memStore({ execMode: { s1: 'trust' }, trust: { s1: 'readonly' } }) })
    expect(reg2.getExecMode('s1')).toBe('trust')
  })
})

describe('AuthRegistry 记录', () => {
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
  it('revokeSession 清掉该会话全部授权和执行模式，不动别的会话', () => {
    reg.grant('s1', 't1', 'write'); reg.grant('s1', 't2', 'read'); reg.grant('s2', 't1', 'write')
    reg.setExecMode('s1', 'trust')
    reg.markReadonly('s1')
    reg.revokeSession('s1')
    expect(reg.listForSession('s1')).toEqual([])
    expect(reg.getExecMode('s1')).toBe('confirm')
    expect(reg.getTrust('s1')).toBe('confirm')
    expect(reg.getLevel('s2', 't1')).toBe('write')
  })
})

describe('危险命令确认开关', () => {
  it('confirmDangerous=false 时，已授权 write 的危险命令直接放行；=true 仍逐次确认', () => {
    const reg = new AuthRegistry({ store: memStore() })
    reg.setExecMode('s1', 'auto')
    reg.grant('s1', 'local', 'write')
    const cmd = 'rm -rf /opt/app'
    expect(reg.decide('s1', 'local', 'write', cmd).kind).toBe('prompt')            // 默认：闸门开着
    expect(reg.decide('s1', 'local', 'write', cmd, true).kind).toBe('prompt')
    expect(reg.decide('s1', 'local', 'write', cmd, false).kind).toBe('allow')     // 关掉：只认 write 授权
  })

  it('关掉确认闸也不给未授权的放行', () => {
    const reg = new AuthRegistry({ store: memStore() })
    expect(reg.decide('s1', 'local', 'write', 'rm -rf /', false).kind).toBe('prompt')   // 无授权仍要问
    reg.markReadonly('s1')
    expect(reg.decide('s1', 'local', 'write', 'rm -rf /', false).kind).toBe('deny')     // 只读档仍拒
  })
})
