import { describe, it, expect } from 'vitest'
import { configDiffQuote, detectConfigFormat, diffConfigs, diffCounts, flattenConfig, isSensitiveEntry, isSensitiveKey, MASK, tryFlatten } from './configDiff.js'

const obj = (m: Map<string, string>) => Object.fromEntries(m)

describe('detectConfigFormat', () => {
  it('按文件名', () => {
    expect(detectConfigFormat('/app/.env', '')).toBe('env')
    expect(detectConfigFormat('/app/.env.production', '')).toBe('env')
    expect(detectConfigFormat('application.yml', '')).toBe('yaml')
    expect(detectConfigFormat('a.properties', '')).toBe('properties')
    expect(detectConfigFormat('my.cnf', '')).toBe('ini')
    expect(detectConfigFormat('Cargo.toml', '')).toBe('toml')
    expect(detectConfigFormat('tsconfig.json', '')).toBe('json')
  })
  it('认不出扩展名看内容', () => {
    expect(detectConfigFormat('/etc/x', '{"a":1}')).toBe('json')
    expect(detectConfigFormat('/etc/x', '[mysqld]\nport=3306')).toBe('ini')
    expect(detectConfigFormat('/etc/x', 'server:\n  port: 1')).toBe('yaml')
    expect(detectConfigFormat('/etc/x', 'A=1')).toBe('env')
  })
})

describe('拍平各格式', () => {
  it('.env：export、引号、行内注释、多行双引号', () => {
    expect(obj(flattenConfig('# c\nexport A=1\nB="x y" # note\nC=\'#raw\'\nD=v#notcomment\nE="l1\nl2"\n', 'env'))).toEqual({ A: '1', B: 'x y', C: '#raw', D: 'v#notcomment', E: 'l1\nl2' })
  })
  it('properties：= : 空白分隔、续行、转义、! 注释', () => {
    expect(obj(flattenConfig('! c\n# c\na.b=1\nc : 2\nd 3\nlong=one \\\n  two\nk\\:x=y\n', 'properties'))).toEqual({ 'a.b': '1', c: '2', d: '3', long: 'one two', 'k:x': 'y' })
  })
  it('ini：小节前缀、; 注释、引号', () => {
    expect(obj(flattenConfig('; top\n[mysqld]\nport = 3306 ; inline\nuser="mysql"\n[client]\nsocket=/tmp/s\n', 'ini'))).toEqual({ 'mysqld.port': '3306', 'mysqld.user': 'mysql', 'client.socket': '/tmp/s' })
  })
  it('json：嵌套、数组、空对象、jsonc 注释与结尾逗号', () => {
    expect(obj(flattenConfig('// c\n{"a":{"b":1,"c":[true,null,{"d":"x"}]},"e":{},"f":[],}', 'json'))).toEqual({ 'a.b': '1', 'a.c[0]': 'true', 'a.c[1]': 'null', 'a.c[2].d': 'x', e: '{}', f: '[]' })
  })
  it('toml：表、数组表、点号键、多行字符串、跨行数组、注释', () => {
    const t = '# c\ntitle = "x" # n\n[server]\nport = 8080\nhosts = [\n  "a",\n  "b",\n]\n[db.main]\n"user.name" = \'root\'\n[[workers]]\nname = "w1"\n[[workers]]\nname = "w2"\n[text]\nbody = """\nline1\nline2"""\n'
    expect(obj(flattenConfig(t, 'toml'))).toEqual({
      title: 'x', 'server.port': '8080', 'server.hosts': '["a","b"]', 'db.main.user.name': 'root',
      'workers[0].name': 'w1', 'workers[1].name': 'w2', 'text.body': 'line1\nline2',
    })
  })
  it('yaml：嵌套映射、列表（同缩进 / 缩进）、列表里的映射、块标量、注释、引号、流式', () => {
    const y = [
      '# comment', '---', 'server:', '  port: 8080   # inline', '  host: "0.0.0.0"', 'spring:', '  datasource:', '    url: jdbc:mysql://db:3306/app',
      '    password: secret', 'profiles:', '- dev', '- prod', 'servers:', '  - name: a', '    ip: 10.0.0.1', '  - name: b', '    ip: 10.0.0.2',
      'script: |', '  echo 1', '  echo 2', 'tags: [x, y]', 'empty:', 'last: \'q: x\'',
    ].join('\n')
    expect(obj(flattenConfig(y, 'yaml'))).toEqual({
      'server.port': '8080', 'server.host': '0.0.0.0', 'spring.datasource.url': 'jdbc:mysql://db:3306/app', 'spring.datasource.password': 'secret',
      'profiles[0]': 'dev', 'profiles[1]': 'prod', 'servers[0].name': 'a', 'servers[0].ip': '10.0.0.1', 'servers[1].name': 'b', 'servers[1].ip': '10.0.0.2',
      script: 'echo 1\necho 2', tags: '[x,y]', empty: '', last: 'q: x',
    })
  })
  it('解析失败不抛', () => {
    expect(tryFlatten('{bad', 'json')).toHaveProperty('error')
    expect(tryFlatten('a: 1', 'yaml')).toHaveProperty('map')
  })
})

describe('diffConfigs', () => {
  it('顺序 / 缩进 / 注释不同不算差异；只在一边、值不同分别标出', () => {
    const a = flattenConfig('server:\n  port: 8080\n  host: a\n# x\nlog: info\n', 'yaml')
    const b = flattenConfig('log: info\nserver:\n    host: b\n    port: 8080\nextra: 1\n', 'yaml')
    const rows = diffConfigs(a, b)
    expect(rows.map((r) => [r.key, r.status])).toEqual([['extra', 'onlyB'], ['log', 'same'], ['server.host', 'diff'], ['server.port', 'same']])
    expect(diffCounts(rows)).toEqual({ same: 2, diff: 1, onlyA: 0, onlyB: 1 })
  })
  it('不同格式之间也能比（.env 对 properties）', () => {
    const rows = diffConfigs(flattenConfig('DB_HOST=a\nDB_PORT=1', 'env'), flattenConfig('DB_PORT=1\nDB_HOST=b', 'properties'))
    expect(rows.filter((r) => r.status === 'diff').map((r) => r.key)).toEqual(['DB_HOST'])
  })
})

describe('敏感值', () => {
  it('键名判断', () => {
    for (const k of ['DB_PASSWORD', 'spring.datasource.password', 'jwt.secret', 'API_TOKEN', 'aws.access_key', 'API_KEY', 'stripe.apiKey', 'redis.auth', 'ssl.key', 'client_secret']) expect(isSensitiveKey(k), k).toBe(true)
    for (const k of ['server.port', 'keyboard.layout', 'monkey', 'log.level', 'cache.keys.count']) expect(isSensitiveKey(k), k).toBe(false)
  })
  it('值命中脱敏规则也算（如 Bearer / sk-）', () => {
    expect(isSensitiveEntry('header', 'Bearer abcdefghijklmnop')).toBe(true)
    expect(isSensitiveEntry('openai', 'sk-abcdefghijklmnopqrstuv')).toBe(true)
    expect(isSensitiveEntry('url', 'http://x')).toBe(false)
  })
  it('给 AI 的差异表遮挡敏感值，只列不同的键', () => {
    const rows = diffConfigs(new Map([['DB_PASSWORD', 'p1'], ['PORT', '1'], ['SAME', 'x']]), new Map([['DB_PASSWORD', 'p2'], ['PORT', '2'], ['SAME', 'x']]))
    const t = configDiffQuote(rows, '测试 .env', '生产 .env')
    expect(t).not.toContain('p1')
    expect(t).not.toContain('p2')
    expect(t).toContain(MASK)
    expect(t).toContain('| `PORT` | `1` | `2` | 值不同 |')
    expect(t).not.toContain('SAME')
  })
  it('值 / 键里的竖线、反引号、换行不会破坏表格', () => {
    const rows = diffConfigs(new Map([['a|b', 'x|y'], ['CMD', 'echo `date`'], ['MULTI', 'l1\nl2']]), new Map([['a|b', 'x|z'], ['CMD', 'echo `date +%s`'], ['MULTI', 'l1\nl3']]))
    const t = configDiffQuote(rows, 'A', 'B')
    expect(t).toContain('| `a\\|b` | `x\\|y` | `x\\|z` | 值不同 |')
    expect(t).toContain('| `MULTI` | `l1\\nl2` | `l1\\nl3` | 值不同 |')
    // 值里最长的反引号串是 1，用更长的围栏包住；结尾是反引号，两侧补空格
    expect(t).toContain('| `CMD` | `` echo `date` `` |')
  })
})
