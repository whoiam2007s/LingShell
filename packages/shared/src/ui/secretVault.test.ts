import { describe, it, expect } from 'vitest'
import {
  secretRefs, hasSecretRef, secretAllowed, checkSecretRefs, expandSecrets, maskSecrets, maskToolText, SecretStreamMasker, buildSecretsPrompt,
  type SecretSummary,
} from './secretVault.js'

const S = (o: Partial<SecretSummary> & { name: string }): SecretSummary => ({
  id: o.name, description: '', scope: 'all', targets: [], hasValue: true, createdAt: '', updatedAt: '', ...o,
})
const V = 'S3cr3t-xyz-123'
const list = [{ name: 'demo', value: V }]

describe('占位符解析', () => {
  it('取出引用名（去重、按顺序），非法名不认', () => {
    expect(secretRefs('a {{secret:b-1}} {{secret:a_2}} {{secret:b-1}} {{secret:Bad}} {{ secret:x }}')).toEqual(['b-1', 'a_2'])
    expect(hasSecretRef({ command: 'x', args: ['{{secret:k}}'] })).toBe(true)
    expect(hasSecretRef({ command: '{{secret:}}' })).toBe(false)
  })
})

describe('可用范围', () => {
  it('全部 / 本地 / 主机 / 分组', () => {
    expect(secretAllowed(S({ name: 'a' }), 'h1')).toBe(true)
    expect(secretAllowed(S({ name: 'a', scope: 'local' }), 'local')).toBe(true)
    expect(secretAllowed(S({ name: 'a', scope: 'local' }), 'h1')).toBe(false)
    expect(secretAllowed(S({ name: 'a', scope: 'hosts', targets: ['h1'] }), 'h1')).toBe(true)
    expect(secretAllowed(S({ name: 'a', scope: 'hosts', targets: ['h1'] }), 'h2')).toBe(false)
    expect(secretAllowed(S({ name: 'a', scope: 'group', targets: ['web'] }), 'h1', 'web')).toBe(true)
    expect(secretAllowed(S({ name: 'a', scope: 'group', targets: ['web'] }), 'h1', 'db')).toBe(false)
    expect(secretAllowed(S({ name: 'a', scope: 'group', targets: ['web'] }), 'local')).toBe(false)
  })
  it('校验给出原因：不存在 / 未设值 / 不在范围', () => {
    const l = [S({ name: 'demo', scope: 'local' }), S({ name: 'empty', hasValue: false })]
    expect(checkSecretRefs('echo hi', l, 'h1', undefined, 'web1')).toBeUndefined()
    expect(checkSecretRefs('echo {{secret:demo}}', l, 'local', undefined, '本地')).toBeUndefined()
    expect(checkSecretRefs('echo {{secret:demo}}', l, 'h1', undefined, 'web1')).toMatch(/^secret_scope: .*web1.*仅本地终端/)
    expect(checkSecretRefs('echo {{secret:nope}}', l, 'local', undefined, '本地')).toMatch(/^secret_not_found/)
    expect(checkSecretRefs('echo {{secret:empty}}', l, 'local', undefined, '本地')).toMatch(/^secret_empty/)
  })
})

describe('展开（按引号上下文转义）', () => {
  const tricky = `p'a"s$x\`y\\z`
  const ex = (cmd: string, v = tricky) => expandSecrets(cmd, () => v)
  it('三种上下文都替换', () => {
    expect(ex('echo {{secret:a}}', 'abc')).toBe(`echo 'abc'`)
    expect(ex(`echo '-p{{secret:a}}'`, `a'b`)).toBe(`echo '-pa'\\''b'`)
    expect(ex(`echo "x {{secret:a}}"`, 'a"$b')).toBe(`echo "x a\\"\\$b"`)
    expect(ex(`echo \\{{secret:a}}`, 'abc')).toBe(`echo \\{{secret:a}}`)   // 转义的不认
    expect(() => expandSecrets('echo {{secret:x}}', (n) => { throw new Error(`no ${n}`) })).toThrow('no x')
  })
  // bash 实测（值原样到达命令）见 dsh-controller/secretVault.test.ts
})

describe('输出回写', () => {
  it('多处、多行输出、\\r\\n、JSON 转义都换回占位符', () => {
    expect(maskSecrets(`a ${V}\nb ${V}\r\n`, list)).toBe('a {{secret:demo}}\nb {{secret:demo}}\r\n')
    const multi = [{ name: 'cert', value: 'line-one\nline-two' }]
    expect(maskSecrets('x line-one\r\nline-two y', multi)).toBe('x {{secret:cert}} y')
    expect(maskToolText(JSON.stringify({ output: `got ${V}\nok`, exit_code: 0 }), list)).toBe(JSON.stringify({ output: 'got {{secret:demo}}\nok', exit_code: 0 }))
  })
  it('终端折行把值拆成两行也能认出', () => {
    expect(maskSecrets(`$ echo S3cr3t-x\nyz-123\n`, list)).toBe('$ echo {{secret:demo}}\n')
  })
  it('截断边界：开头的后半截、结尾的前半截', () => {
    expect(maskSecrets('xyz-123 tail', list)).toBe('{{secret:demo}} tail')
    expect(maskSecrets('head S3cr3t-x', list)).toBe('head {{secret:demo}}')
    expect(maskSecrets('123 tail', list)).toBe('123 tail')    // 太短的残片不换
    // JSON：按字段判边界（被截掉开头的 output）
    expect(maskToolText(JSON.stringify({ output: 'cr3t-xyz-123\nmore', truncated: true }), list)).toContain('"{{secret:demo}}\\nmore"')
  })
  it('命令回显里被引号转义的形式', () => {
    const l = [{ name: 'q', value: `ab'cd-ef` }]
    expect(maskSecrets(`eval 'echo ab'\\''cd-ef'`, l)).toBe(`eval 'echo {{secret:q}}'`)
  })
  it('无密钥 / 太短的值原样', () => {
    expect(maskSecrets(`x ${V}`, [])).toBe(`x ${V}`)
    expect(maskSecrets('abc abc', [{ name: 's', value: 'abc' }])).toBe('abc abc')
  })
})

describe('流式回写（录像）', () => {
  it('值被拆在两个 chunk 里', () => {
    const m = new SecretStreamMasker(() => list)
    const out = m.push('echo S3cr3') + m.push('t-xyz-123\r\nnext') + m.push(' S3c') + m.flush()
    expect(out).toBe('echo {{secret:demo}}\r\nnext S3c')
    expect(out).not.toContain('S3cr3t')
  })
  it('flush 交出的残片足够长时也换掉', () => {
    const m = new SecretStreamMasker(() => list)
    expect(m.push('a S3cr3t-xy') + m.flush()).toBe('a {{secret:demo}}')
  })
})

describe('系统提示段', () => {
  it('只有名称 / 说明 / 范围，没有值；没有可用密钥时为空', () => {
    const p = buildSecretsPrompt([S({ name: 'demo', description: '演示', scope: 'local' }), S({ name: 'x', hasValue: false })])
    expect(p).toContain('{{secret:demo}}：演示（可用范围：仅本地终端）')
    expect(p).not.toContain('{{secret:x}}：')
    expect(buildSecretsPrompt([])).toBe('')
  })
})
