import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PortForwardStore } from './PortForwardStore.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pf-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('PortForwardStore', () => {
  it('增删改查：同主机同本地端口覆盖并保留 autoStart', () => {
    const s = new PortForwardStore(dir)
    expect(s.list()).toEqual([])
    const a = s.save({ hostId: 'h1', localPort: 13306, remoteHost: 'db', remotePort: 3306 })
    expect(a).toMatchObject({ hostId: 'h1', autoStart: false })
    expect(existsSync(join(dir, 'port-forwards.json'))).toBe(true)
    // 运行中的转发直接传进来：只存规则字段
    const b = s.save({ hostId: 'h1', kind: 'dynamic', localPort: 1080, id: 'fwd_x', status: { state: 'running' } } as never)
    expect(b.input).toEqual({ hostId: 'h1', kind: 'dynamic', localPort: 1080 })
    s.setAutoStart(a.id, true)
    const a2 = s.save({ hostId: 'h1', localPort: 13306, remoteHost: 'db2', remotePort: 3307 })
    expect(a2.id).toBe(a.id)
    expect(a2.autoStart).toBe(true)
    expect(new PortForwardStore(dir).list()).toHaveLength(2)
    s.delete(b.id)
    expect(s.list().map((x) => x.id)).toEqual([a.id])
    s.deleteByHost('h1')
    expect(s.list()).toEqual([])
  })

  it('远程转发：按服务器端口区分，与同号本地端口的 -L 互不覆盖；只存规则字段', () => {
    const s = new PortForwardStore(dir)
    const l = s.save({ hostId: 'h1', localPort: 3000, remoteHost: 'x', remotePort: 80 })
    const r = s.save({ hostId: 'h1', kind: 'remote', remotePort: 8080, localHost: '127.0.0.1', localPort: 3000, id: 'fwd_y', status: { state: 'running' } } as never)
    expect(r.id).not.toBe(l.id)
    expect(r.input).toEqual({ hostId: 'h1', kind: 'remote', remotePort: 8080, localHost: '127.0.0.1', localPort: 3000 })
    const r2 = s.save({ hostId: 'h1', kind: 'remote', remotePort: 8080, remoteBind: '0.0.0.0', localHost: 'pc', localPort: 3001 })
    expect(r2.id).toBe(r.id)
    expect(r2.input).toMatchObject({ remoteBind: '0.0.0.0', localHost: 'pc' })
    expect(s.list()).toHaveLength(2)
  })

  it('启动自动开启：只取 autoStart=true 且主机仍存在的', () => {
    const s = new PortForwardStore(dir)
    const on = s.save({ hostId: 'h1', localPort: 1, remoteHost: 'x', remotePort: 1 })
    s.save({ hostId: 'h1', localPort: 2, remoteHost: 'x', remotePort: 1 })   // autoStart 默认关
    const gone = s.save({ hostId: 'deleted', kind: 'dynamic', localPort: 3 })
    s.setAutoStart(on.id, true); s.setAutoStart(gone.id, true)
    expect(s.autoStartList(['h1', 'h2']).map((x) => x.id)).toEqual([on.id])
  })
})
