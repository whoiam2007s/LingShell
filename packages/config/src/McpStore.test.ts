import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpStore } from './McpStore.js'
import type { Encryptor } from './SettingsStore.js'

const mockEnc: Encryptor = {
  available: () => true,
  encrypt: (p) => `enc:${Buffer.from(p).toString('base64')}`,
  decrypt: (c) => Buffer.from(c.slice(4), 'base64').toString('utf8'),
}

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lingshell-mcp-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('McpStore', () => {
  it('env/headers 加密落盘，list 只给键名，resolve 解出明文', () => {
    const s = new McpStore(dir, mockEnc)
    const sum = s.save({ name: '监控', enabled: true, transport: 'stdio', command: 'node', args: ['srv.js'], env: { TOKEN: 'secret-1' } })
    expect(sum.envKeys).toEqual(['TOKEN'])
    expect(JSON.stringify(sum)).not.toContain('secret-1')
    expect(readFileSync(join(dir, 'mcp-servers.json'), 'utf8')).not.toContain('secret-1')
    expect(s.resolve()[0].env).toEqual({ TOKEN: 'secret-1' })
  })

  it('值为 null 沿用旧值，缺的键删除，新值覆盖', () => {
    const s = new McpStore(dir, mockEnc)
    const { id } = s.save({ name: 'db', enabled: true, transport: 'http', url: 'http://x/mcp', headers: { Authorization: 'Bearer a', X: '1' } })
    s.save({ id, name: 'db', enabled: true, transport: 'http', url: 'http://x/mcp', headers: { Authorization: null, Y: '2' } })
    expect(s.resolve()[0].headers).toEqual({ Authorization: 'Bearer a', Y: '2' })
    expect(s.merge({ id, name: 'db', enabled: true, transport: 'http', url: 'u', headers: { Authorization: null } }).headers).toEqual({ Authorization: 'Bearer a' })
    // 只切启停（不带 headers）：整体沿用
    s.save({ id, name: 'db', enabled: false, transport: 'http', url: 'http://x/mcp' })
    expect(s.resolve()[0]).toMatchObject({ enabled: false, headers: { Authorization: 'Bearer a', Y: '2' } })
  })

  it('免确认列表持久化；缺命令/URL 拒绝保存', () => {
    const s = new McpStore(dir, mockEnc)
    const { id } = s.save({ name: 'a', enabled: true, transport: 'stdio', command: 'x' })
    s.setAutoApprove(id, ['query', 'query'])
    expect(s.list()[0].autoApprove).toEqual(['query'])
    expect(() => s.save({ name: 'b', enabled: true, transport: 'http' })).toThrow(/URL/)
    expect(() => s.save({ name: 'c', enabled: true, transport: 'stdio' })).toThrow(/命令/)
  })
})
