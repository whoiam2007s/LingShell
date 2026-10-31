import { describe, it, expect } from 'vitest'
import { nameError, joinPath, parentPath, baseName, isProtectedDir, conflictName, rangeSelect, topLevelPaths, deleteConfirmText, TREE_CAP,
  shq, shScript, packCommand, unpackCommand, searchCommand, modeString, modeOctal, parseOctal, longnameOwner, formatSize, attrsTooltip,
  archiveKind, archiveName, missingTool, NO_TOOL, parseSearchOutput, explorerAuditLabel, nameFilter, filterHighlight, filterTree,
  sortEntries, isHiddenName, breadcrumbs, fsErrorText, typeAheadTarget, moveCursor } from './explorer.js'

describe('快速过滤', () => {
  it('子串 / 通配，不区分大小写；空白不过滤', () => {
    expect(nameFilter('  ')).toBeUndefined()
    const sub = nameFilter('LOG')!
    expect(['app.log', 'Logs', 'blog.md', 'a.txt'].filter(sub)).toEqual(['app.log', 'Logs', 'blog.md'])
    const glob = nameFilter('*.LOG')!
    expect(['app.log', 'app.log.1', 'x.log'].filter(glob)).toEqual(['app.log', 'x.log'])
    expect(['a1.txt', 'a12.txt', 'b1.txt'].filter(nameFilter('a?.txt')!)).toEqual(['a1.txt'])
    expect(['a+b(1).txt', 'ab1.txt'].filter(nameFilter('a+b(*')!)).toEqual(['a+b(1).txt'])   // 正则元字符按字面
  })
  it('高亮区间', () => {
    expect(filterHighlight('App.Log', 'log')).toEqual([4, 7])
    expect(filterHighlight('app.log', '*.log')).toEqual([0, 7])
    expect(filterHighlight('a.txt', 'log')).toBeUndefined()
    expect(filterHighlight('a.txt', '')).toBeUndefined()
  })
  it('树过滤：只看已展开的；含命中项的父目录保留；折叠目录不往里看', () => {
    const d = (path: string, isDir = false) => ({ path, name: path.split('/').pop()!, isDir })
    const children = {
      '/r': [d('/r/etc', true), d('/r/var', true), d('/r/nginx.conf'), d('/r/a.txt')],
      '/r/etc': [d('/r/etc/nginx', true), d('/r/etc/hosts')],
      '/r/etc/nginx': [d('/r/etc/nginx/site.conf')],
      '/r/var': [d('/r/var/app.conf')],   // 已加载但折叠
    }
    const { show, hits } = filterTree(children, '/r', new Set(['/r/etc', '/r/etc/nginx']), nameFilter('*.conf')!)
    expect([...hits].sort()).toEqual(['/r/etc/nginx/site.conf', '/r/nginx.conf'])
    expect([...show].sort()).toEqual(['/r/etc', '/r/etc/nginx', '/r/etc/nginx/site.conf', '/r/nginx.conf'])
    // 目录名本身命中：显示它，但里面不命中的照样隐藏
    const r2 = filterTree(children, '/r', new Set(['/r/etc', '/r/etc/nginx']), nameFilter('nginx')!)
    expect([...r2.show].sort()).toEqual(['/r/etc', '/r/etc/nginx', '/r/nginx.conf'])
  })
})

describe('名称校验', () => {
  it('通用：空、. / ..、含斜杠', () => {
    for (const win of [false, true]) {
      expect(nameError('', win)).toMatch(/为空/)
      expect(nameError('.', win)).toMatch(/\.\./)
      expect(nameError('..', win)).toBeTruthy()
      expect(nameError('a/b', win)).toMatch(/\//)
      expect(nameError('a\\b', win)).toBeTruthy()
      expect(nameError('a.conf', win)).toBeUndefined()
      expect(nameError('中文 名.txt', win)).toBeUndefined()
    }
  })
  it('远程/posix 允许 Windows 非法字符', () => {
    for (const n of ['a:b', 'a?', 'x*y', 'con', 'trail.', 'a|b']) expect(nameError(n, false)).toBeUndefined()
  })
  it('本地 Windows：<>:"|?*、保留名、结尾空格或点', () => {
    for (const n of ['a<b', 'a>b', 'a:b', 'a"b', 'a|b', 'a?', 'x*y']) expect(nameError(n, true)).toMatch(/不能包含/)
    expect(nameError('CON', true)).toMatch(/保留名/)
    expect(nameError('lpt1.txt', true)).toMatch(/保留名/)
    expect(nameError('console', true)).toBeUndefined()
    expect(nameError('a.', true)).toMatch(/结尾/)
    expect(nameError('a ', true)).toMatch(/结尾/)
  })
})

describe('路径', () => {
  it('joinPath 按目录分隔符拼', () => {
    expect(joinPath('/', 'a')).toBe('/a')
    expect(joinPath('/etc', 'a')).toBe('/etc/a')
    expect(joinPath('C:\\x', 'a')).toBe('C:\\x\\a')
    expect(joinPath('C:\\', 'a')).toBe('C:\\a')
    expect(joinPath('C:', 'a')).toBe('C:\\a')
  })
  it('parentPath / baseName', () => {
    expect(parentPath('/a')).toBe('/')
    expect(parentPath('/a/b')).toBe('/a')
    expect(parentPath('C:\\a')).toBe('C:\\')
    expect(parentPath('C:\\a\\b')).toBe('C:\\a')
    expect(baseName('/a/b.txt')).toBe('b.txt')
    expect(baseName('C:\\a\\dir\\')).toBe('dir')
  })
  it('根与根下一级目录受保护', () => {
    for (const p of ['/', '/etc', '/etc/', 'C:\\', 'C:\\Windows', 'D:', '/C:', '/C:/', '/C:/Windows', '/D:/test-projects/']) expect(isProtectedDir(p)).toBe(true)
    for (const p of ['/etc/nginx', '/home/u/x', 'C:\\Users\\me', '/C:/Users/me', '/D:/a/b']) expect(isProtectedDir(p)).toBe(false)
  })
})

describe('同名改名', () => {
  it('a.txt → a (1).txt → a (2).txt', () => {
    const taken = new Set(['a.txt', 'a (1).txt'])
    expect(conflictName('a.txt', (n) => taken.has(n))).toBe('a (2).txt')
    expect(conflictName('b.txt', (n) => taken.has(n))).toBe('b.txt')
  })
  it('无扩展名 / 点开头 / 多重扩展名', () => {
    expect(conflictName('dir', (n) => n === 'dir')).toBe('dir (1)')
    expect(conflictName('.bashrc', (n) => n === '.bashrc')).toBe('.bashrc (1)')
    expect(conflictName('a.tar.gz', (n) => n === 'a.tar.gz')).toBe('a.tar (1).gz')
  })
})

describe('多选', () => {
  const order = ['/a', '/a/x', '/b', '/c']
  it('Shift 范围选（正反向），anchor 不可见只选目标', () => {
    expect(rangeSelect(order, '/a/x', '/c')).toEqual(['/a/x', '/b', '/c'])
    expect(rangeSelect(order, '/c', '/a')).toEqual(order)
    expect(rangeSelect(order, '/gone', '/b')).toEqual(['/b'])
    expect(rangeSelect(order, undefined, '/b')).toEqual(['/b'])
  })
  it('去掉祖先已选中的项，前缀相同的兄弟不误伤', () => {
    expect(topLevelPaths(['/a', '/a/x', '/ab', '/b'])).toEqual(['/a', '/ab', '/b'])
    expect(topLevelPaths(['C:\\a', 'C:\\a\\x'])).toEqual(['C:\\a'])
    expect(topLevelPaths(['/', '/etc'])).toEqual(['/'])
  })
})

describe('删除确认文案', () => {
  it('本地进回收站；远程不可恢复；远程超上限拒绝', () => {
    expect(deleteConfirmText({ files: 3, dirs: 1, over: false }, true)).toBe('将把 3 个文件、1 个文件夹 移到回收站（可从回收站恢复）。')
    expect(deleteConfirmText({ files: 3, dirs: 1, over: false }, false)).toBe('将删除 3 个文件、1 个文件夹，不可恢复。')
    expect(deleteConfirmText({ files: 0, dirs: 0, over: true }, false)).toContain(`超过 ${TREE_CAP} 项`)
    expect(deleteConfirmText({ files: 0, dirs: 0, over: true }, true)).toContain('回收站')
  })
})

describe('shell 转义', () => {
  it('单引号包裹，内部单引号写成 \'\\\'\'；拒绝空字符', () => {
    expect(shq('a b')).toBe(`'a b'`)
    expect(shq(`it's`)).toBe(`'it'\\''s'`)
    expect(shq('$(rm -rf /)`x`')).toBe(`'$(rm -rf /)\`x\`'`)
    expect(() => shq('a\0b')).toThrow(/空字符/)
    expect(shScript(`echo 'x'`)).toBe(`sh -c 'echo '\\''x'\\'''`)
  })
  it('打包/解压/搜索命令里的路径全部转义，名称前加 ./', () => {
    const c = packCommand('/srv/a b', ['-rf', `x'y`], '/srv/a b/o.tar.gz')
    expect(c.startsWith('sh -c ')).toBe(true)
    expect(c).toContain('./-rf')
    expect(unpackCommand('/x/a.zip', 'zip', '/x')).toContain('unzip -n')
    expect(unpackCommand('/x/a.tgz', 'tar.gz', '/x')).toContain('tar -xzkf')
    expect(unpackCommand('/x/a.tar', 'tar', '/x')).toContain('tar -xkf')
    expect(searchCommand('/r', 'ab')).toContain(`-iname '\\''*ab*'\\''`)
    expect(searchCommand('/r', '*.log', 3, 10)).toMatch(/-maxdepth 3 .*-iname '\\''\*\.log'\\''.*head -n 11/)
  })
})

describe('权限 / 属性', () => {
  it('modeString / modeOctal / parseOctal', () => {
    expect(modeString(0o755)).toBe('rwxr-xr-x')
    expect(modeString(0o640)).toBe('rw-r-----')
    expect(modeString(0o4755)).toBe('rwsr-xr-x')
    expect(modeString(0o1777)).toBe('rwxrwxrwt')
    expect(modeString(0o2644)).toBe('rw-r-Sr--')
    expect(modeOctal(0o100644 & 0o7777)).toBe('644')
    expect(modeOctal(0o4755)).toBe('4755')
    expect(modeOctal(0o7)).toBe('007')
    expect(parseOctal('755')).toBe(0o755)
    expect(parseOctal(' 0644 ')).toBe(0o644)
    expect(parseOctal('789')).toBeUndefined()
    expect(parseOctal('75')).toBeUndefined()
  })
  it('longname 取属主属组；格式不对返回 undefined', () => {
    expect(longnameOwner('-rw-r--r--    1 root     www-data     1234 Jan  1 00:00 a.txt')).toEqual({ owner: 'root', group: 'www-data' })
    expect(longnameOwner('drwxr-xr-x+ 2 u g 4096 Oct 1 12:00 d')).toEqual({ owner: 'u', group: 'g' })
    expect(longnameOwner('a.txt')).toBeUndefined()
  })
  it('formatSize / attrsTooltip', () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(1536)).toBe('1.5 KB')
    expect(formatSize(300 * 1024 * 1024)).toBe('300 MB')
    const t = attrsTooltip({ name: 'a', isDir: false, mode: 0o644, owner: 'root', group: 'root', size: 2048, mtime: 1 })
    expect(t).toContain('rw-r--r--（644）')
    expect(t).toContain('root:root')
    expect(t).toContain('2.0 KB')
  })
})

describe('压缩包 / 搜索结果', () => {
  it('archiveKind / archiveName（冲突加 (1) 在 .tar.gz 前）', () => {
    expect(archiveKind('A.TAR.GZ')).toBe('tar.gz')
    expect(archiveKind('a.tgz')).toBe('tar.gz')
    expect(archiveKind('a.tar')).toBe('tar')
    expect(archiveKind('a.zip')).toBe('zip')
    expect(archiveKind('a.gz')).toBeUndefined()
    const taken = new Set(['app.tar.gz', 'app (1).tar.gz'])
    expect(archiveName('app', (n) => taken.has(n))).toBe('app (2).tar.gz')
    expect(archiveName('x', () => false)).toBe('x.tar.gz')
  })
  it('missingTool', () => {
    expect(missingTool(`${NO_TOOL}unzip\n`)).toBe('unzip')
    expect(missingTool('tar: error')).toBeUndefined()
  })
  it('parseSearchOutput：d 前缀是目录，截断标记', () => {
    const r = parseSearchOutput('d /a/logs\n/a/logs/x.log\nfind: perm denied\n/a/b c.log\n', 2)
    expect(r.hits).toEqual([{ name: 'logs', path: '/a/logs', isDir: true }, { name: 'x.log', path: '/a/logs/x.log', isDir: false }])
    expect(r.truncated).toBe(true)
    expect(parseSearchOutput('').hits).toEqual([])
  })
  it('执行记录标签', () => {
    expect(explorerAuditLabel('file_chmod')).toBe('修改权限')
    expect(explorerAuditLabel('file_archive')).toBe('压缩')
    expect(explorerAuditLabel('file_edit_external')).toBe('外部编辑回传')
    expect(explorerAuditLabel('nope')).toBeUndefined()
  })
})

describe('浏览：排序 / 面包屑 / 出错说明 / 按键跳转', () => {
  const ents = [
    { name: 'file10.txt', isDir: false, size: 5, mtime: 300 }, { name: 'file2.txt', isDir: false, size: 50, mtime: 100 },
    { name: 'b', isDir: true, mtime: 900 }, { name: 'A', isDir: true, mtime: 50 }, { name: '.env', isDir: false, size: 1, mtime: 200 },
  ]
  it('排序：目录在前；名称自然排序；大小 / 时间可升降', () => {
    expect(sortEntries(ents, { key: 'name', desc: false }).map((e) => e.name)).toEqual(['A', 'b', '.env', 'file2.txt', 'file10.txt'])
    expect(sortEntries(ents, { key: 'name', desc: true }).map((e) => e.name)).toEqual(['b', 'A', 'file10.txt', 'file2.txt', '.env'])
    expect(sortEntries(ents, { key: 'size', desc: true }).map((e) => e.name)).toEqual(['A', 'b', 'file2.txt', 'file10.txt', '.env'])
    expect(sortEntries(ents, { key: 'mtime', desc: false }).map((e) => e.name)).toEqual(['A', 'b', 'file2.txt', '.env', 'file10.txt'])
    expect(isHiddenName('.env')).toBe(true); expect(isHiddenName('env')).toBe(false)
  })
  it('面包屑：POSIX / Windows', () => {
    expect(breadcrumbs('/var/log/nginx')).toEqual([{ label: '/', path: '/' }, { label: 'var', path: '/var' }, { label: 'log', path: '/var/log' }, { label: 'nginx', path: '/var/log/nginx' }])
    expect(breadcrumbs('/')).toEqual([{ label: '/', path: '/' }])
    expect(breadcrumbs('D:\\work\\demo')).toEqual([{ label: 'D:\\', path: 'D:\\' }, { label: 'work', path: 'D:\\work' }, { label: 'demo', path: 'D:\\work\\demo' }])
    expect(breadcrumbs('C:\\')).toEqual([{ label: 'C:\\', path: 'C:\\' }])
  })
  it('出错说明', () => {
    expect(fsErrorText("Error invoking remote method 'fs:listDir': Error: Permission denied")).toContain('没有权限')
    expect(fsErrorText('ENOENT: no such file or directory')).toContain('不存在')
    expect(fsErrorText('weird')).toBe('weird')
  })
  it('按键跳转与方向键', () => {
    const order = [{ path: '/a', name: 'apple' }, { path: '/b', name: 'banana' }, { path: '/c', name: 'avocado' }, { path: '/d', name: 'apricot' }]
    expect(typeAheadTarget(order, undefined, 'a')).toBe('/a')
    expect(typeAheadTarget(order, '/a', 'a')).toBe('/c')            // 同一个字母：轮到下一个 a 开头的
    expect(typeAheadTarget(order, '/d', 'a')).toBe('/a')            // 到尾了回到开头
    expect(typeAheadTarget(order, '/a', 'aaa')).toBe('/c')          // 连按 a：仍按首字母轮转
    expect(typeAheadTarget(order, '/a', 'apr')).toBe('/d')          // 多字母：前缀匹配
    expect(typeAheadTarget(order, '/a', 'zz')).toBeUndefined()
    expect(moveCursor(['/a', '/b'], undefined, 1)).toBe('/a')
    expect(moveCursor(['/a', '/b'], '/b', 1)).toBe('/b')
    expect(moveCursor(['/a', '/b'], '/b', -1)).toBe('/a')
    expect(moveCursor([], '/a', 1)).toBeUndefined()
  })
})

describe('shortTime', () => {
  it('今年显示月日时分，往年显示年月日，没有时间为空', async () => {
    const { shortTime } = await import('./explorer.js')
    const now = new Date(2026, 9, 20, 12, 0).getTime()
    expect(shortTime(new Date(2026, 0, 5, 9, 7).getTime() / 1000, now)).toBe('01-05 09:07')
    expect(shortTime(new Date(2024, 11, 31, 23, 59).getTime() / 1000, now)).toBe('2024-12-31')
    expect(shortTime(undefined, now)).toBe('')
  })
})

describe('nameCompare', () => {
  it('英文数字在前、中文按拼音在后，数字按自然顺序', async () => {
    const { sortEntries } = await import('./explorer.js')
    const l = ['中文.txt', 'apple', '报告.md', 'file10', 'file2', '.env', 'Banana'].map((name) => ({ name, isDir: false }))
    expect(sortEntries(l, { key: 'name', desc: false }).map((e) => e.name)).toEqual(['.env', 'apple', 'Banana', 'file2', 'file10', '报告.md', '中文.txt'])
  })
})

describe('阶段二：粘贴 / 属性 / 校验和 / 属主 / 内容搜索', async () => {
  const m = await import('./explorer.js')
  it('isInside：自己、子孙算，同前缀的兄弟不算', () => {
    expect(m.isInside('/a/b', '/a/b')).toBe(true)
    expect(m.isInside('/a/b/c', '/a/b/')).toBe(true)
    expect(m.isInside('/a/bc', '/a/b')).toBe(false)
    expect(m.isInside('D:\\x\\y', 'D:\\x')).toBe(true)
    expect(m.isInside('/x', '/')).toBe(true)
  })
  it('粘贴命令：普通复制 / 移动 / 合并；路径里的引号转义', () => {
    // 外层是 sh -c '<脚本>'：脚本里的单引号会再转义一层，这里比对还原后的脚本（真跑见 desktop 的 explorerOps.real.test）
    const inner = (c: string) => c.replace(/^sh -c '/, '').replace(/'$/, '').replace(/'\\''/g, "'")
    expect(inner(m.remotePasteCommand('/a/x', '/b/x', 'copy', false))).toBe(`cp -a -- '/a/x' '/b/x'`)
    expect(inner(m.remotePasteCommand('/a/d', '/b/d', 'move', false))).toBe(`mv -f -- '/a/d' '/b/d'`)
    expect(inner(m.remotePasteCommand('/a/d', '/b/d', 'move', true))).toBe(`cp -a '/a/d/.' '/b/d/' && rm -rf -- '/a/d'`)
  })
  it('统计输出 / 校验和 / 属主列表解析', () => {
    expect(m.parseSizeOutput('3 10 123456\n')).toEqual({ dirs: 3, files: 10, bytes: 123456 })
    expect(m.parseSizeOutput('garbage')).toBeUndefined()
    expect(m.parseChecksum('\\d41d8cd98f00b204e9800998ecf8427e  /a\\nb\n')).toBe('d41d8cd98f00b204e9800998ecf8427e')
    expect(m.parseChecksum('E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855 *x')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(m.parseOwners('root\nwww-data\nbad name\n---\nroot\nadm\n')).toEqual({ users: ['root', 'www-data'], groups: ['adm', 'root'] })
  })
  it('chown：至少一个、名称校验、递归', () => {
    expect(m.chownCommand(['/srv/a'], 'www', 'www', true)).toBe(`chown -R -- 'www:www' '/srv/a'`)
    expect(m.chownCommand(['/a', '/b'], 'root', '', false)).toBe(`chown -- 'root' '/a' '/b'`)
    expect(() => m.chownCommand(['/a'], '', '', false)).toThrow('至少')
    expect(() => m.chownCommand(['/a'], 'a;rm -rf /', '', false)).toThrow('不合法')
  })
  it('cdCommand：远程 / Git Bash / cmd / PowerShell / WSL', () => {
    expect(m.cdCommand("/srv/it's")).toBe(`cd '/srv/it'\\''s'`)
    expect(m.cdCommand('D:\\a b', 'bash')).toBe(`cd 'D:\\a b'`)
    expect(m.cdCommand('D:\\a b', 'cmd')).toBe('cd /d "D:\\a b"')
    expect(m.cdCommand("D:\\it's", 'powershell')).toBe(`Set-Location -LiteralPath 'D:\\it''s'`)
    expect(m.cdCommand('D:\\x\\y z', 'wsl:Ubuntu')).toBe(`cd '/mnt/d/x/y z'`)
    expect(m.cdCommand('D:\\', 'wsl:Ubuntu')).toBe(`cd '/mnt/d/'`)
    expect(m.cdCommand('/C:/Users/me/a b')).toBe('cd /d "C:\\Users\\me\\a b"')
    expect(m.cdCommand('/D:')).toBe('cd /d "D:"')
  })
  it('内容搜索输出解析：文件名带冒号也能分开', () => {
    const out = '/srv/a:b.conf\x0012:  listen 80;\n/srv/c.txt\x003:Listen here\n'
    expect(m.parseContentSearch(out).hits).toEqual([
      { path: '/srv/a:b.conf', name: 'a:b.conf', line: 12, text: 'listen 80;' },
      { path: '/srv/c.txt', name: 'c.txt', line: 3, text: 'Listen here' },
    ])
  })
  it('内容搜索命令：关键字按字面量转义（-i 与 -F 同用在本机 GNU grep 3.0 会 abort）', () => {
    expect(m.ereLiteral('a.b|c')).toBe('a\\.b\\|c')
    const inner = (c: string) => c.replace(/^sh -c '/, '').replace(/'$/, '').replace(/'\\''/g, "'")
    expect(inner(m.contentSearchCommand('/srv/x', 'a.b|c'))).toContain(`-E --exclude-dir=.git --exclude-dir=node_modules -- 'a\\.b\\|c' '/srv/x'`)
  })
})
