import { describe, expect, it } from 'vitest'
import { PortForwardManager } from './PortForwardManager.js'

// 删主机时要停掉这台主机上正在跑的转发（否则 SSH 连接和监听一直留着，界面上又找不到入口）
describe('PortForwardManager.stopByHost', () => {
  const mk = (id: string, hostId: string) => ({
    info: { id, hostId, hostLabel: '', kind: 'local' as const, localPort: 1000, remoteHost: 'h', remotePort: 22, status: { state: 'running' as const } },
    sockets: new Set(), opts: () => ({} as never),
  })
  it('只停这台主机的转发，返回停掉的 id', () => {
    const m = new PortForwardManager()
    const fwds = (m as unknown as { fwds: Map<string, unknown> }).fwds
    fwds.set('a', mk('a', 'h1')); fwds.set('b', mk('b', 'h1')); fwds.set('c', mk('c', 'h2'))
    expect(m.stopByHost('h1').sort()).toEqual(['a', 'b'])
    expect(m.list().map((x) => x.id)).toEqual(['c'])
    expect(m.stopByHost('none')).toEqual([])
    expect(m.list().map((x) => x.id)).toEqual(['c'])
  })
})
