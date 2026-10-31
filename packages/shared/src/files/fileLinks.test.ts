import { describe, it, expect } from 'vitest'
import { editorKind, fillGotoArgs, findFileLinks, gotoArgsOf, isAbsLinkPath, msysToWinPath, resolveLinkPath, unsafeShellPath } from './fileLinks.js'

const one = (s: string) => { const r = findFileLinks(s); return r.map((l) => ({ path: l.path, line: l.line, col: l.col, text: s.slice(l.start, l.end) })) }

describe('findFileLinks：常见编译器 / 测试框架 / 堆栈格式', () => {
  const cases: [string, string, string, number, number?][] = [
    // [名称, 行文本, 路径, 行, 列]
    ['TypeScript tsc（冒号）', 'src/foo.ts:42:7 - error TS2322: Type', 'src/foo.ts', 42, 7],
    ['TypeScript tsc（括号）', 'src/a.ts(42,7): error TS2304: Cannot find name', 'src/a.ts', 42, 7],
    ['ESLint unix', '/home/u/app/src/index.js:3:5: Unexpected console statement', '/home/u/app/src/index.js', 3, 5],
    ['Node 堆栈（函数名）', '    at handler (/srv/app/routes/user.js:88:15)', '/srv/app/routes/user.js', 88, 15],
    ['Node 堆栈（匿名）', '    at /srv/app/server.mjs:12:3', '/srv/app/server.mjs', 12, 3],
    ['Node file:// URL', '    at file:///C:/proj/src/main.mjs:10:5', 'C:/proj/src/main.mjs', 10, 5],
    ['Jest', '      at Object.<anonymous> (src/__tests__/sum.test.ts:5:3)', 'src/__tests__/sum.test.ts', 5, 3],
    ['Python traceback', '  File "/opt/app/main.py", line 12, in <module>', '/opt/app/main.py', 12],
    ['Python 相对路径', 'File "app/views.py", line 7, in index', 'app/views.py', 7],
    ['pytest', 'tests/test_api.py:42: AssertionError', 'tests/test_api.py', 42],
    ['Java 堆栈', '\tat com.acme.svc.UserService.find(UserService.java:88)', 'UserService.java', 88],
    ['Kotlin', '\tat com.acme.MainKt.main(Main.kt:5)', 'Main.kt', 5],
    ['Go panic', '\t/home/u/go/src/app/main.go:31 +0x1d', '/home/u/go/src/app/main.go', 31],
    ['Go test', '    handler_test.go:27: expected 200, got 500', 'handler_test.go', 27],
    ['Rust', '  --> src/main.rs:10:5', 'src/main.rs', 10, 5],
    ['gcc', 'foo.c:12:5: error: expected ‘;’ before ‘}’ token', 'foo.c', 12, 5],
    ['C++ clang', 'lib/util.cpp:120:3: warning: unused variable', 'lib/util.cpp', 120, 3],
    ['C# / MSBuild', 'Program.cs(12,5): error CS1002: ; expected', 'Program.cs', 12, 5],
    ['Ruby', "app.rb:12:in `block in <main>'", 'app.rb', 12],
    ['PHP', 'PHP Fatal error: Uncaught Error in /var/www/html/index.php on line 15', '/var/www/html/index.php', 15],
    ['Perl', 'Died at script.pl line 12.', 'script.pl', 12],
    ['Windows 路径', 'C:\\work\\proj\\src\\App.vue:33:9 error', 'C:\\work\\proj\\src\\App.vue', 33, 9],
    ['Dockerfile', 'Dockerfile:12 error: invalid instruction', 'Dockerfile', 12],
    ['YAML 配置', 'error in ./config/app.yml:4:1 mapping values are not allowed', './config/app.yml', 4, 1],
    ['中文目录', '报错：/data/项目/服务.py:9 语法错误', '/data/项目/服务.py', 9],
    ['相对上级', '../shared/src/x.tsx:1:2 hi', '../shared/src/x.tsx', 1, 2],
  ]
  it.each(cases)('%s', (_n, s, path, line, col) => {
    const r = one(s)
    expect(r.length).toBeGreaterThanOrEqual(1)
    expect(r[0]).toMatchObject({ path, line, ...(col ? { col } : {}) })
  })
  it('至少 20 种格式', () => expect(cases.length).toBeGreaterThanOrEqual(20))

  it('不认 URL、域名:端口、IP:端口、时间', () => {
    expect(one('see http://example.com/app.js:10 for details')).toEqual([])
    expect(one('Connecting to example.com:443 ...')).toEqual([])
    expect(one('ssh 10.0.0.1:22 refused')).toEqual([])
    expect(one('at 12:30:45 done')).toEqual([])
    expect(one('version 1.2.3:4')).toEqual([])
  })
  it('没扩展名的配置文件（grep -Hn 输出）：带目录的路径才算', () => {
    expect(one('/etc/ssh/sshd_config:40:PermitRootLogin yes').map((x) => [x.path, x.line, x.text])).toEqual([['/etc/ssh/sshd_config', 40, '/etc/ssh/sshd_config:40']])
    expect(one('/etc/ssh/sshd_config:90:# the setting of "PermitRootLogin".').map((x) => x.line)).toEqual([90])
    expect(one('~/.bashrc:12: alias ll').map((x) => x.path)).toEqual(['~/.bashrc'])
    expect(one('./deploy/hosts:3:web1').map((x) => x.path)).toEqual(['./deploy/hosts'])
    expect(one('/etc/nginx/nginx.conf:12:5').map((x) => [x.path, x.line, x.col])).toEqual([['/etc/nginx/nginx.conf', 12, 5]])   // 有扩展名的仍走原规则
    expect(one('sshd_config:40')).toEqual([])          // 没目录的不认（太像 主机:端口）
    expect(one('redis:6379 up')).toEqual([])
  })
  it('一行多个链接、Python 整句为一个下划线范围', () => {
    const r = one('a.ts:1 and b/c.go:2:3')
    expect(r.map((x) => x.path)).toEqual(['a.ts', 'b/c.go'])
    expect(one('File "x.py", line 3')[0].text).toBe('File "x.py", line 3')
  })
})

describe('路径解析', () => {
  it('相对路径按 cwd 拼并归一', () => {
    expect(resolveLinkPath('src/a.ts', '/home/u/app')).toBe('/home/u/app/src/a.ts')
    expect(resolveLinkPath('./src/../lib/b.ts', '/home/u/app/')).toBe('/home/u/app/lib/b.ts')
    expect(resolveLinkPath('../x.py', '/a/b')).toBe('/a/x.py')
    expect(resolveLinkPath('/etc/x.conf', '/home')).toBe('/etc/x.conf')
    expect(resolveLinkPath('src\\a.ts', 'C:\\proj', true)).toBe('C:\\proj\\src\\a.ts')
    expect(resolveLinkPath('C:/x/y.ts', 'D:\\z', true)).toBe('C:\\x\\y.ts')
    expect(resolveLinkPath('a.ts', undefined)).toBe('a.ts')
    expect(resolveLinkPath('~/x.sh', '/tmp')).toBe('~/x.sh')
  })
  it('绝对路径判断 / msys 转换 / shell 危险字符', () => {
    expect(isAbsLinkPath('/x')).toBe(true)
    expect(isAbsLinkPath('C:\\x')).toBe(true)
    expect(isAbsLinkPath('x/y')).toBe(false)
    expect(msysToWinPath('/c/Users/x/a.ts')).toBe('C:\\Users\\x\\a.ts')
    expect(msysToWinPath('/etc/x')).toBe('/etc/x')
    expect(unsafeShellPath('a&b.ts')).toBe(true)
    expect(unsafeShellPath('/home/u/a b.ts')).toBe(false)
  })
})

describe('编辑器跳行参数', () => {
  it('按命令名认编辑器', () => {
    expect(editorKind('code')).toBe('vscode')
    expect(editorKind('"C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd"')).toBe('vscode')
    expect(editorKind('cursor')).toBe('vscode')
    expect(editorKind('C:\\JetBrains\\bin\\idea64.exe')).toBe('jetbrains')
    expect(editorKind('C:\\Program Files\\Notepad++\\notepad++.exe')).toBe('npp')
    expect(editorKind('subl')).toBe('sublime')
    expect(editorKind('notepad')).toBeUndefined()
  })
  it('模板：自填优先、空编辑器按 VS Code、认不出的不跳行', () => {
    expect(gotoArgsOf('', undefined)).toBe('-g "{file}:{line}:{col}"')
    expect(gotoArgsOf('notepad', '')).toBeUndefined()
    expect(gotoArgsOf('notepad', '/g {line} {file}')).toBe('/g {line} {file}')
    expect(fillGotoArgs('-g "{file}:{line}:{col}"', 'C:\\a b\\x.ts', 42, 7)).toEqual(['-g', 'C:\\a b\\x.ts:42:7'])
    expect(fillGotoArgs('--line {line} "{file}"', '/x.py', 3)).toEqual(['--line', '3', '/x.py'])
    expect(fillGotoArgs('-n{line} -c{col} "{file}"', 'a', 2)).toEqual(['-n2', '-c1', 'a'])
  })
})
