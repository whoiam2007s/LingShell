import { describe, it, expect } from 'vitest'
import { normalizeConfig, compareChoices } from './fileCompare.js'
import type { HostSummary, TerminalInfo } from '../protocol/index.js'

describe('compareChoices', () => {
  const host = (id: string, env?: 'prod'): HostSummary => ({ id, label: id.toUpperCase(), host: `${id}.x`, port: 22, username: 'root', authType: 'password', env })
  const term = (id: string, p: Partial<TerminalInfo>): TerminalInfo => ({ id, title: id, type: 'ssh', status: 'running', locked: false, ...p })

  it('本机在首；已保存主机各一次（有在线终端标 live）；临时 SSH 终端单列；断线的不算', () => {
    const r = compareChoices([host('a', 'prod'), host('b')], [
      term('t1', { hostId: 'a' }), term('t2', { hostId: 'a' }),
      term('t3', { hostId: 'b', status: 'disconnected' }),
      term('t4', { detail: 'u@10.0.0.9:22' }), term('t5', { status: 'disconnected' }),
      term('t6', { type: 'local' }),
    ])
    expect(r.map((c) => [c.key, c.live])).toEqual([['local', true], ['host:a', true], ['host:b', false], ['term:t4', true]])
    expect(r[1]).toMatchObject({ env: 'prod', target: { kind: 'host', hostId: 'a' } })
    expect(r[3].target).toEqual({ kind: 'terminal', terminalId: 't4' })
  })
})

describe('normalizeConfig', () => {
  it('去首尾空白、压连续空白，丢空行和 # / ; 注释行', () => {
    const a = '# nginx\nworker_processes  4;\n\n  events {\n\t; 旧写法\n    worker_connections 1024;\n  }\n'
    expect(normalizeConfig(a)).toBe('worker_processes 4;\nevents {\nworker_connections 1024;\n}')
  })

  it('只差空白 / 注释 / CRLF 的两份内容归一后相同', () => {
    const a = 'Port 22\r\nPermitRootLogin no\r\n'
    const b = '# 改端口前记得开防火墙\nPort    22\n\n   PermitRootLogin no'
    expect(normalizeConfig(a)).toBe(normalizeConfig(b))
  })

  it('行尾注释和行中的 # 不算注释行', () => {
    expect(normalizeConfig('a=1 # x\nurl=http://h/#frag')).toBe('a=1 # x\nurl=http://h/#frag')
  })
})
