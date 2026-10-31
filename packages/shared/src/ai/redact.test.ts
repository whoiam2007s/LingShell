import { describe, it, expect } from 'vitest'
import { REDACTED, redactSecrets, redactKnown, redactText, redactToolText, hasPlaceholder, redactLines, redactAi, keepSecretRefs } from './redact.js'
import * as report from './report.js'

const R = REDACTED

describe('report.ts 仍导出脱敏 API', () => {
  it('同一实现', () => {
    expect(report.redactSecrets).toBe(redactSecrets)
    expect(report.REDACTED).toBe(R)
  })
})

describe('已知值精确替换', () => {
  it('替换全部出现，正则特殊字符原样匹配', () => {
    const pw = 'p@ss.w*rd(1)$[x]'
    expect(redactKnown(`a ${pw} b ${pw}`, [pw])).toBe(`a ${R} b ${R}`)
    expect(redactKnown('p@ssXw*rd(1)$[x]', [pw])).toBe('p@ssXw*rd(1)$[x]')   // . 不当通配
  })

  it('短于 6 位、空值、非字符串忽略', () => {
    expect(redactKnown('admin root 12345', ['admin', 'root', '12345', '', undefined as never])).toBe('admin root 12345')
  })

  it('重叠：长的先换，短的是长的子串也不拆碎', () => {
    expect(redactKnown('X abcdefgh Y abcdef', ['abcdef', 'abcdefgh'])).toBe(`X ${R} Y ${R}`)
  })

  it('多行私钥：原样与 JSON 转义形式都换；首尾空白不同也能命中', () => {
    const key = 'line-one-AAAA\nline-two-BBBB\n'
    expect(redactKnown(`k=${JSON.stringify(key)}`, [key])).toBe(`k="${R}"`)
    expect(redactKnown('before line-one-AAAA\nline-two-BBBB after', [key])).toBe(`before ${R} after`)
  })

  it('幂等', () => {
    const once = redactKnown('tok secretvalue1 x', ['secretvalue1'])
    expect(redactKnown(once, ['secretvalue1'])).toBe(once)
  })
})

describe('新增样式', () => {
  it.each([
    ['DB_PASSWORD=hunter22', `DB_PASSWORD=${R}`],
    ['export GITHUB_TOKEN="ghx abc"', `export GITHUB_TOKEN="${R}"`],
    ["MYSQL_PWD='s3 cr3t'", `MYSQL_PWD='${R}'`],
    ['REDIS_PASS=abc\nHOME=/root', `REDIS_PASS=${R}\nHOME=/root`],
    ['docker run -e STRIPE_KEY=rk_live_1 img', `docker run -e STRIPE_KEY=${R} img`],
    ['APP_SECRET=x1\r\nPORT=80', `APP_SECRET=${R}\r\nPORT=80`],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U end', `jwt ${R} end`],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----', R],
    ['-----BEGIN PGP PRIVATE KEY BLOCK-----\nxx\n-----END PGP PRIVATE KEY BLOCK-----', R],
    ['head:\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA（输出被截断）', `head:\n${R}`],
    ['Set-Cookie: sid=abc123; Path=/; HttpOnly', `Set-Cookie: sid=${R}; Path=/; HttpOnly`],
    ['Cookie: sid=abc123; theme=dark', `Cookie: ${R}`],
  ])('%s', (src, out) => expect(redactSecrets(src)).toBe(out))

  it.each([
    'HOME=/root',
    'PWD=/var/www',
    'OLDPWD=/tmp',
    'KEYBOARD=us',
    'PATH=/usr/bin:/bin',
    'NODE_ENV=production',
    'a==b',
    'if [ "$X" = "y" ]; then',
    'eyJ only-one-part',
  ])('不误伤：%s', (src) => expect(redactSecrets(src)).toBe(src))

  it('幂等（含 env 行与 JWT）', () => {
    const once = redactSecrets('DB_PASS="a b"\npassword=x eyJabcdefghij.eyJabcdefghij.sig')
    expect(redactSecrets(once)).toBe(once)
  })
})

describe('工具结果文本', () => {
  it('JSON：逐个字符串值脱敏，多行输出里的 env 行不吞后面的字段', () => {
    const out = JSON.stringify({ output: 'DB_PASS=abc\nok', exit_code: 0, truncated: false })
    expect(JSON.parse(redactToolText(out))).toEqual({ output: `DB_PASS=${R}\nok`, exit_code: 0, truncated: false })
  })

  it('JSON：键名敏感的字符串值整个换（分页 token 与数字不动）', () => {
    const t = JSON.stringify({ password: 'plain', next_page_token: 'cur1', inputTokens: 5, nested: [{ api_key: 'k' }] })
    expect(JSON.parse(redactToolText(t))).toEqual({ password: R, next_page_token: 'cur1', inputTokens: 5, nested: [{ api_key: R }] })
  })

  it('无改动原样返回（保留格式）；缩进 JSON 保持缩进', () => {
    const t = '{ "a":1 }'
    expect(redactToolText(t)).toBe(t)
    const pretty = JSON.stringify({ x: 'mysecretvalue' }, null, 2)
    expect(redactToolText(pretty, ['mysecretvalue'])).toBe(JSON.stringify({ x: R }, null, 2))
  })

  it('非 JSON 走文本；两层叠加；幂等', () => {
    const s = redactText('ssh pw=Hunter2Hunter2 token: abc', ['Hunter2Hunter2'])
    expect(s).toBe(`ssh pw=${R} token: ${R}`)
    expect(redactToolText(s, ['Hunter2Hunter2'])).toBe(s)
    expect(redactToolText('{broken json password=1')).toBe(`{broken json password=${R}`)
  })
})

describe('逐行脱敏（保持行号）', () => {
  it('私钥块整块按行遮掉：首行占位、其余行置空，行数不变', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'
    const out = redactLines(`before\n${key}\nafter`)
    expect(out.split('\n')).toHaveLength(5)
    expect(out).toBe(`before\n${R}\n\n\nafter`)
    expect(out).not.toContain('MIIEow')
  })
  it('普通行仍按已知值 / 样式脱敏；没有私钥块时与逐行 redactText 等价', () => {
    const out = redactLines('password=hunter22\nGB_PASSWORD=abc\nnormal line', ['hunter22'])
    expect(out).toBe(`password=${R}\nGB_PASSWORD=${R}\nnormal line`)
  })
})

describe('发给模型的统一入口', () => {
  const mask = (s: string) => s.split('vaultpw').join('{{secret:demo}}')
  it('保险箱回写不受脱敏开关影响；已知机密与样式照常替换；占位符不被误伤', () => {
    expect(redactAi('vaultpw password=abc {{secret:other}}', ['abc'], mask)).toBe(`{{secret:demo}} password=${R} {{secret:other}}`)
    expect(redactAi('vaultpw password=abc', undefined, mask)).toBe('{{secret:demo}} password=abc')
  })
  it('逐行模式保持行号；工具模式按 JSON 字段处理', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----'
    expect(redactAi(`vaultpw\n${key}`, ['vaultpw'], mask, { lines: true }).split('\n')).toHaveLength(4)
    expect(redactAi(JSON.stringify({ output: 'vaultpw', password: 'x' }), [], mask, { tool: true })).toBe(JSON.stringify({ output: '{{secret:demo}}', password: R }))
  })
  it('keepSecretRefs 只保护合法占位符', () => {
    expect(keepSecretRefs('{{secret:demo}} a', (s) => s.replace('a', 'b'))).toBe('{{secret:demo}} b')
    expect(keepSecretRefs('{{secret:Demo}}', (s) => s.replace('Demo', 'x'))).toBe('{{secret:x}}')
  })
})

describe('占位符检测', () => {
  it('深层查找', () => {
    expect(hasPlaceholder({ a: [{ b: `x${R}` }] })).toBe(true)
    expect(hasPlaceholder({ a: ['[已脱'], n: 1 })).toBe(false)
  })
})
