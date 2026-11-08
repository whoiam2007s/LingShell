import { describe, it, expect } from 'vitest'
import { LOG_TAIL_CHARS, dockerChip, tailLogs } from './dockerQuote.js'

const base = { where: '「prod-web-01」上', name: 'nginx', id: 'a1b2c3d4e5f6', image: 'nginx:1.25', status: 'Exited (1) 3 minutes ago' }

describe('容器 → 上下文 chip', () => {
  it('chip 名是容器名；全文带主机、镜像、状态与容器 id', () => {
    const c = dockerChip(base)
    expect(c.name).toBe('nginx')
    expect(c.text).toContain('nginx:1.25')
    expect(c.text).toContain('Exited (1)')
    expect(c.text).toContain('prod-web-01')
    expect(c.text).toContain('a1b2c3d4e5f6')       // id 要带上（排障靠它）
    expect(c.text).toContain('不是命令输出')         // 不再夹带提问（问题由输入框给）
  })

  it('没有镜像 / 状态时（日志页）不提这两行，但保留容器名', () => {
    const c = dockerChip({ where: '本机', name: 'api', logs: 'boom' })
    expect(c.text).not.toContain('镜像：')
    expect(c.text).not.toContain('状态：')
    expect(c.text).toContain('容器：api')
    expect(c.text).toContain('boom')
  })

  it('资源与端口有才写', () => {
    expect(dockerChip(base).text).not.toContain('端口：')
    const c = dockerChip({ ...base, ports: '0.0.0.0:80->80/tcp', stat: { cpu: '0.10%', mem: '12MiB / 1GiB' } })
    expect(c.text).toContain('0.0.0.0:80->80/tcp')
    expect(c.text).toContain('CPU 0.10%')
  })

  it('日志只带尾部并注明省略（尾部才是出错的地方）', () => {
    const long = 'x'.repeat(LOG_TAIL_CHARS + 500) + 'TAIL-MARK'
    const c = dockerChip({ ...base, logs: long })
    expect(c.text).toContain('TAIL-MARK')
    expect(c.text).toContain('前面省略')
    expect(c.text.length).toBeLessThan(LOG_TAIL_CHARS + 1200)
  })

  it('tailLogs：短的整段返回，长的按 limit 截尾', () => {
    expect(tailLogs('  abc  ')).toBe('abc')
    const t = tailLogs('a'.repeat(10) + 'ZZ', 5)
    expect(t.endsWith('ZZ')).toBe(true)
    expect(t).toContain('前面省略')
  })
})
