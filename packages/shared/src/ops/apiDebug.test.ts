import { describe, it, expect } from 'vitest'
import {
  checkApiUrl, curlConfig, newApiRequest, parseCurl, parseCurlOutput, prettyBody, remoteCurlCommand, resolveApiRequest, sanitizeApiStore,
  shellWords, substituteVars, toCurl, type ApiRequest,
} from './apiDebug.js'

const vars = [{ key: 'base', value: 'http://127.0.0.1:8080' }, { key: 'v', value: 'v1' }, { key: 'url', value: '{{base}}/{{v}}' }, { key: 'off', value: 'x', off: true }]

describe('变量替换', () => {
  it('{{变量}} 换成值，可嵌套；{{secret:x}} 原样；没定义的列出来', () => {
    expect(substituteVars('{{url}}/users?t={{ secret }}', vars)).toEqual({ text: 'http://127.0.0.1:8080/v1/users?t={{ secret }}', missing: ['secret'] })
    expect(substituteVars('Bearer {{secret:token}}', vars)).toEqual({ text: 'Bearer {{secret:token}}', missing: [] })
    expect(substituteVars('{{off}}', vars).missing).toEqual(['off'])   // 勾掉的变量不用
  })
  it('循环引用不死循环', () => {
    expect(substituteVars('{{a}}', [{ key: 'a', value: '{{b}}' }, { key: 'b', value: '{{a}}' }]).text).toMatch(/\{\{[ab]\}\}/)
  })
  it('resolveApiRequest：表单 urlencode、自动补 Content-Type、GET 不带体、勾掉的头不发', () => {
    const r: ApiRequest = { ...newApiRequest('1'), method: 'POST', url: '{{base}}/login', bodyType: 'form', body: 'user=a b\npass={{secret:pw}}\n',
      headers: [{ key: 'X-V', value: '{{v}}' }, { key: 'X-Off', value: '1', off: true }] }
    const { resolved, missing } = resolveApiRequest(r, vars)
    expect(missing).toEqual([])
    // 表单保留未编码的键值对：主进程要先展开 {{secret:pw}} 再编码，否则占位符会被发成 %7B%7Bsecret...
    expect(resolved).toEqual({ method: 'POST', url: 'http://127.0.0.1:8080/login', headers: [['X-V', 'v1'], ['Content-Type', 'application/x-www-form-urlencoded']],
      body: 'user=a%20b&pass=%7B%7Bsecret%3Apw%7D%7D', form: [['user', 'a b'], ['pass', '{{secret:pw}}']] })
    const j = resolveApiRequest({ ...r, bodyType: 'json', body: '{"a":"{{v}}"}', headers: [{ key: 'content-type', value: 'application/vnd+json' }] }, vars).resolved
    expect(j.headers).toEqual([['content-type', 'application/vnd+json']])
    expect(j.body).toBe('{"a":"v1"}')
    expect(resolveApiRequest({ ...r, method: 'GET' }, vars).resolved.body).toBeUndefined()
    // multipart：保留 key=值 / key=@路径，不编码、不自动加 Content-Type（boundary 由 fetch / curl 生成）
    const mp = resolveApiRequest({ ...r, bodyType: 'multipart', body: 'name=a b\nfile=@/tmp/a.txt\n', headers: [] }, vars).resolved
    expect(mp.multipart).toEqual([['name', 'a b'], ['file', '@/tmp/a.txt']])
    expect(mp.body).toBeUndefined()
    expect(mp.headers).toEqual([])
  })
  it('请求头 / URL 里的 CRLF 与 NUL 直接拒绝（远端 curl 会把 \\n 还原成真实换行）', () => {
    const r = { ...newApiRequest('1'), url: 'https://a.com/x', headers: [{ key: 'X', value: 'a\r\nX-Admin: 1' }] }
    expect(() => resolveApiRequest(r, vars)).toThrow('请求头')
    expect(() => resolveApiRequest({ ...r, headers: [], url: 'https://a.com/a\nb' }, vars)).toThrow('URL')
  })
  it('只允许 http / https', () => {
    expect(checkApiUrl('https://a.com/x')).toBeUndefined()
    expect(checkApiUrl('file:///etc/passwd')).toContain('只支持')
    expect(checkApiUrl('not a url')).toContain('不合法')
    expect(checkApiUrl('')).toContain('URL')
  })
})

describe('curl 导入 / 导出', () => {
  it('分词：引号、转义、续行、$\'..\'', () => {
    expect(shellWords(`curl -H 'A: b c' "x\\"y" $'l1\\nl2' \\\n  end`)).toEqual(['curl', '-H', 'A: b c', 'x"y', 'l1\nl2', 'end'])
  })
  it('导出再导入还是同一个请求', () => {
    const r: ApiRequest = { ...newApiRequest('1'), name: 'x', method: 'PUT', url: '{{base}}/items/1', bodyType: 'json', body: `{"name":"it's"}`,
      headers: [{ key: 'Authorization', value: 'Bearer {{secret:token}}' }, { key: 'Content-Type', value: 'application/json' }] }
    const back = parseCurl(toCurl(r), '2')
    expect('error' in back).toBe(false)
    if ('error' in back) return
    expect([back.method, back.url, back.bodyType, back.body]).toEqual(['PUT', '{{base}}/items/1', 'json', `{"name":"it's"}`])
    expect(back.headers).toEqual([{ key: 'Authorization', value: 'Bearer {{secret:token}}' }, { key: 'Content-Type', value: 'application/json' }])
  })
  it('常见写法：-d 推断 POST、--json、-u、-G、--data-urlencode、-XPOST 连写', () => {
    const a = parseCurl(`curl https://a.com/api -d '{"x":1}'`, '1')
    expect('error' in a ? a : [a.method, a.bodyType]).toEqual(['POST', 'json'])
    const b = parseCurl(`curl --json '{"y":2}' https://a.com`, '1')
    expect('error' in b ? b : [b.method, b.bodyType, b.headers[0]]).toEqual(['POST', 'json', { key: 'Content-Type', value: 'application/json' }])
    const c = parseCurl(`curl -u admin:pw https://a.com`, '1')
    expect('error' in c ? c : c.headers[0]).toEqual({ key: 'Authorization', value: 'Basic YWRtaW46cHc=' })
    const d = parseCurl(`curl -G https://a.com/s -d q=1 -d n=2`, '1')
    expect('error' in d ? d : [d.method, d.url]).toEqual(['GET', 'https://a.com/s?q=1&n=2'])
    const e = parseCurl(`curl -XPOST https://a.com --data-urlencode 'name=a b'`, '1')
    expect('error' in e ? e : [e.method, e.bodyType, e.body]).toEqual(['POST', 'form', 'name=a b'])
    // --data-urlencode 的值里有 &：按第一个 = 拆，不能当字段分隔符
    const f = parseCurl(`curl https://a.com --data-urlencode 'q=a&b'`, '1')
    expect('error' in f ? f : [f.bodyType, f.body]).toEqual(['form', 'q=a&b'])
    // -G --data-urlencode 要编码后拼进查询串
    const g = parseCurl(`curl -G https://a.com/s --data-urlencode 'q=a&b'`, '1')
    expect('error' in g ? g : g.url).toBe('https://a.com/s?q=a%26b')
    // -F 文件表单：保留 key=@路径，bodyType 为 multipart
    const mp = parseCurl(`curl -F 'name=v' -F 'file=@/tmp/a.txt' https://a.com/up`, '1')
    expect('error' in mp ? mp : [mp.method, mp.bodyType, mp.body]).toEqual(['POST', 'multipart', 'name=v\nfile=@/tmp/a.txt'])
    // 带参数的选项（--cacert 等）不能把参数当成 URL
    const h = parseCurl(`curl --cacert ca.pem https://a.com/x`, '1')
    expect('error' in h ? h : h.url).toBe('https://a.com/x')
    expect(parseCurl('wget x', '1')).toEqual({ error: expect.stringContaining('curl') })
    expect(parseCurl('curl -H x', '1')).toEqual({ error: '没找到 URL' })
  })
  it('复制为 curl：HEAD 用 -I、关闭 glob、@ 开头的 body 不读文件', () => {
    const head = toCurl({ ...newApiRequest('1'), method: 'HEAD', url: 'https://a.com/x?ids[0]=1' })
    expect(head).toContain('-I')
    expect(head).not.toContain('-X HEAD')
    expect(head).toContain('  -g ')
    const at = toCurl({ ...newApiRequest('1'), method: 'POST', url: 'https://a.com', bodyType: 'text', body: '@/etc/passwd' })
    expect(at).toContain('--data-raw')
    expect(at).not.toContain('--data-binary')
    const form = toCurl({ ...newApiRequest('1'), method: 'POST', url: 'https://a.com', bodyType: 'form', body: '@file=1' })
    expect(form).toContain('--data-raw')
    expect(form).not.toContain('--data-urlencode')
    const mp = toCurl({ ...newApiRequest('1'), method: 'POST', url: 'https://a.com', bodyType: 'multipart', body: 'name=v\nfile=@/tmp/a.txt' })
    expect(mp).toContain("-F name=v")
    expect(mp).toContain("-F file=@/tmp/a.txt")
    expect(mp).not.toContain('Content-Type: multipart')
  })
})

describe('远程发送（curl -K -）', () => {
  it('配置文件：URL / 头 / 体都在 stdin 里，双引号转义', () => {
    const c = curlConfig({ method: 'POST', url: 'http://h/a?b="c"', headers: [['X-A', 'v\\1']], body: 'line1\nline2\t"q"' })
    expect(c).toBe('url = "http://h/a?b=\\"c\\""\nrequest = "POST"\nheader = "X-A: v\\\\1"\ndata-raw = "line1\\nline2\\t\\"q\\""\n')
    expect(curlConfig({ method: 'GET', url: 'http://h', headers: [] })).toBe('url = "http://h"\n')
    expect(curlConfig({ method: 'HEAD', url: 'http://h', headers: [] })).toBe('url = "http://h"\nhead\n')
    // data-raw：body 以 @ 开头也不会被 curl 当成文件读取
    expect(curlConfig({ method: 'POST', url: 'http://h', headers: [], body: '@/etc/passwd' })).toContain('data-raw = "@/etc/passwd"')
    // multipart：用 form，@路径是远端文件；不写 data-raw
    const mp = curlConfig({ method: 'POST', url: 'http://h', headers: [], multipart: [['name', 'v'], ['file', '@/tmp/a.txt']] })
    expect(mp).toContain('form = "name=v"')
    expect(mp).toContain('form = "file=@/tmp/a.txt"')
    expect(mp).not.toContain('data-raw')
    expect(remoteCurlCommand()).toContain('-q -g')
    expect(remoteCurlCommand()).toContain('-K -')
    expect(remoteCurlCommand()).not.toContain('http')
  })
  it('解析 -i 输出：跳过 100 Continue，取状态 / 头 / 体 / 耗时', () => {
    const r = parseCurlOutput('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 201 Created\r\nContent-Type: application/json\r\nX-A: 1\r\n\r\n{"ok":true}\n@@api-time:0.012345')
    expect(r).toEqual({ status: 201, statusText: 'Created', headers: [['Content-Type', 'application/json'], ['X-A', '1']], body: '{"ok":true}', ms: 12 })
    const h2 = parseCurlOutput('HTTP/2 204\r\nserver: x\r\n\r\n\n@@api-time:0.1')
    expect(h2).toMatchObject({ status: 204, statusText: '', body: '', ms: 100 })
    expect(parseCurlOutput('curl: (7) Failed to connect to 10.0.0.1 port 80\n\n@@api-time:0.000')).toEqual({ error: 'curl: (7) Failed to connect to 10.0.0.1 port 80' })
    expect(parseCurlOutput('\n@@api-time:0.001curl: (7) Failed to connect\n')).toEqual({ error: 'curl: (7) Failed to connect' })   // 报错晚于 -w 到达
    // 已经有状态行、但 -w 之后又来了错误：解析结果带上 after，调用方必须当未完成
    const mid = parseCurlOutput('HTTP/1.1 200 OK\r\n\r\npartial\n@@api-time:0.5curl: (18) transfer closed with outstanding read data remaining')
    expect(mid).toMatchObject({ status: 200, body: 'partial', after: 'curl: (18) transfer closed with outstanding read data remaining' })
    expect(parseCurlOutput('@@api-nocurl\n')).toEqual({ error: expect.stringContaining('没有 curl') })
  })
  it('JSON 格式化', () => {
    expect(prettyBody('{"a":[1]}', 'application/json')).toEqual({ text: '{\n  "a": [\n    1\n  ]\n}', json: true })
    expect(prettyBody('<html>', 'text/html')).toEqual({ text: '<html>', json: false })
  })
  it('HTML / XML 换行缩进：标签一行、属性里的 > 不截断、void 标签不加层、script 内容原样', () => {
    const html = '<!DOCTYPE html><html><head><meta content="a>b"><title>T</title></head><body><div class="x"><span>hi</span></div><script>if (a < b) x()</script></body></html>'
    expect(prettyBody(html, 'text/html').text).toBe([
      '<!DOCTYPE html>',
      '<html>',
      '  <head>',
      '    <meta content="a>b">',
      '    <title>',
      '      T',
      '    </title>',
      '  </head>',
      '  <body>',
      '    <div class="x">',
      '      <span>',
      '        hi',
      '      </span>',
      '    </div>',
      '    <script>',
      '      if (a < b) x()',
      '    </script>',
      '  </body>',
      '</html>',
    ].join('\n'))
    expect(prettyBody('<?xml version="1.0"?><a><b/></a>', 'application/xml').text).toBe('<?xml version="1.0"?>\n<a>\n  <b/>\n</a>')
    expect(prettyBody('plain text', 'text/plain')).toEqual({ text: 'plain text', json: false })
  })
})

describe('sanitizeApiStore', () => {
  it('丢掉非法项、截长度、activeEnv 必须存在', () => {
    const s = sanitizeApiStore({ requests: [{ id: 'a', method: 'BAD', url: 1, headers: [{ key: 'k', value: 'v' }, 3] }, { name: 'no id' }],
      envs: [{ id: 'e', name: 'dev', vars: [{ key: 'base', value: 'x' }] }], activeEnv: 'nope', history: [{ request: { id: 'h' }, status: 200 }] })
    expect(s.requests).toEqual([{ id: 'a', name: '未命名', method: 'GET', url: '', headers: [{ key: 'k', value: 'v' }], bodyType: 'none', body: '' }])
    expect(s.envs[0].vars).toEqual([{ key: 'base', value: 'x' }])
    expect(s.activeEnv).toBeUndefined()
    expect(s.history[0].status).toBe(200)
  })
})
