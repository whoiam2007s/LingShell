import { describe, it, expect } from 'vitest'
import { LOG_TAIL_CHARS, dockerQuote, tailLogs } from './dockerQuote.js'

const base = { where: '「prod-web-01」上', name: 'nginx', image: 'nginx:1.25', status: 'Exited (1) 3 minutes ago' }

describe('容器 → 对话的引用文本', () => {
  it('带上容器、镜像、状态与主机', () => {
    const q = dockerQuote(base)
    expect(q).toContain('nginx')
    expect(q).toContain('nginx:1.25')
    expect(q).toContain('Exited (1)')
    expect(q).toContain('prod-web-01')
    expect(q).toContain('最可能的原因')
  })

  it('没有镜像 / 状态时（日志页）不提这两行，但保留容器名', () => {
    const q = dockerQuote({ where: '本机', name: 'api', logs: 'boom' })
    expect(q).not.toContain('镜像：')
    expect(q).not.toContain('状态：')
    expect(q).toContain('容器：api')
    expect(q).toContain('boom')
  })

  it('资源与端口有才写', () => {
    expect(dockerQuote(base)).not.toContain('端口：')
    const q = dockerQuote({ ...base, ports: '0.0.0.0:80->80/tcp', stat: { cpu: '0.10%', mem: '12MiB / 1GiB' } })
    expect(q).toContain('0.0.0.0:80->80/tcp')
    expect(q).toContain('CPU 0.10%')
  })

  it('日志只带尾部并注明省略（尾部才是出错的地方）', () => {
    const long = 'x'.repeat(LOG_TAIL_CHARS + 500) + 'TAIL-MARK'
    const q = dockerQuote({ ...base, logs: long })
    expect(q).toContain('TAIL-MARK')
    expect(q).toContain('前面省略')
    expect(q.length).toBeLessThan(LOG_TAIL_CHARS + 1200)
  })

  it('tailLogs：短的整段返回，长的按 limit 截尾', () => {
    expect(tailLogs('  abc  ')).toBe('abc')
    const t = tailLogs('a'.repeat(10) + 'ZZ', 5)
    expect(t.endsWith('ZZ')).toBe(true)
    expect(t).toContain('前面省略')
  })
})
