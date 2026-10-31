import { describe, it, expect } from 'vitest'
import { configKind, buildExplainPrompt, parseExplain, numberedText, itemsAtLine, EXPLAIN_MAX_LINES } from './configExplain.js'
import { previewKind, previewMime, previewMaxBytes, parseDelimited, PREVIEW_MAX_BYTES, PREVIEW_TABLE_MAX_BYTES, PREVIEW_TEXT_MAX_BYTES } from '../files/index.js'

describe('configKind', () => {
  it.each([
    ['/etc/nginx/nginx.conf', 'nginx'], ['/etc/nginx/conf.d/site.conf', 'nginx'], ['/etc/nginx/sites-enabled/default', 'nginx'],
    ['/etc/ssh/sshd_config', 'sshd'], ['/etc/ssh/sshd_config.d/50-cloud.conf', 'sshd'],
    ['/etc/my.cnf', 'mysql'], ['/etc/mysql/mysql.conf.d/mysqld.cnf', 'mysql'], ['/etc/my.cnf.d/server.cnf', 'mysql'],
    ['/etc/redis/redis.conf', 'redis'], ['/etc/redis-6379.conf', 'redis'],
    ['/srv/app/docker-compose.yml', 'compose'], ['/srv/app/compose.yaml', 'compose'], ['/srv/app/docker-compose.prod.yml', 'compose'],
    ['/etc/systemd/system/app.service', 'systemd'], ['/lib/systemd/system/backup.timer', 'systemd'], ['/etc/systemd/system/nginx.service.d/override.conf', 'systemd'],
    ['/etc/fstab', 'fstab'], ['/etc/sysctl.conf', 'sysctl'], ['/etc/sysctl.d/99-net.conf', 'sysctl'],
    ['C:\\work\\nginx.conf', 'nginx'],
  ])('%s → %s', (p, k) => expect(configKind(p)).toBe(k))
  it('不认识的', () => { for (const p of ['/etc/hosts', '/var/log/syslog', '/a/b.yml', '/etc/ssh/ssh_config']) expect(configKind(p)).toBeUndefined() })
})

describe('提示词与解析', () => {
  it('带行号；超长截断', () => {
    const p = buildExplainPrompt({ kind: 'sshd', path: '/etc/ssh/sshd_config', text: 'Port 22\nPermitRootLogin yes\n' })
    expect(p.user).toBe('文件：/etc/ssh/sshd_config\n1| Port 22\n2| PermitRootLogin yes')
    expect(p.system).toContain('OpenSSH')
    expect(p.lines).toBe(2)
    const big = numberedText(Array.from({ length: EXPLAIN_MAX_LINES + 10 }, (_, i) => `k${i} v`).join('\n'))
    expect(big).toMatchObject({ lines: EXPLAIN_MAX_LINES, truncated: true })
  })
  it('解析：夹行号、排序、有风险至少 warn、丢空说明', () => {
    const r = parseExplain('<think>…</think>```json\n[{"start":2,"end":2,"title":"PermitRootLogin","explain":"允许 root 登录","risk":"建议改为 prohibit-password","level":"danger"},{"start":0,"end":99,"title":"Port","explain":"端口 22","risk":"弱","level":"ok"},{"start":1,"explain":""}]\n```', 2)
    expect(r).toEqual([
      { start: 1, end: 2, title: 'Port', explain: '端口 22', risk: '弱', level: 'warn' },
      { start: 2, end: 2, title: 'PermitRootLogin', explain: '允许 root 登录', risk: '建议改为 prohibit-password', level: 'danger' },
    ])
    expect(itemsAtLine(r as never, 2)).toHaveLength(2)
    expect(parseExplain('不是 JSON', 3)).toHaveProperty('error')
    expect(parseExplain('[]', 3)).toHaveProperty('error')
  })
})

describe('filePreview', () => {
  it('previewKind / mime', () => {
    expect(['a.PNG', 'b.jpeg', 'c.svg', 'd.md', 'e.csv', 'f.tsv', 'g.pdf', 'h.txt', 'noext'].map(previewKind)).toEqual(['image', 'image', 'image', 'markdown', 'csv', 'tsv', 'pdf', undefined, undefined])
    expect(previewMime('x.svg')).toBe('image/svg+xml')
  })
  it('应用内预览上限按类型：Markdown 2MB、CSV/TSV 5MB、图片/PDF 20MB', () => {
    expect(previewMaxBytes('markdown')).toBe(PREVIEW_TEXT_MAX_BYTES)
    expect(previewMaxBytes('csv')).toBe(PREVIEW_TABLE_MAX_BYTES)
    expect(previewMaxBytes('tsv')).toBe(PREVIEW_TABLE_MAX_BYTES)
    expect(previewMaxBytes('image')).toBe(PREVIEW_MAX_BYTES)
    expect(previewMaxBytes('pdf')).toBe(PREVIEW_MAX_BYTES)
    expect(PREVIEW_TEXT_MAX_BYTES).toBeLessThan(PREVIEW_TABLE_MAX_BYTES)
    expect(PREVIEW_TABLE_MAX_BYTES).toBeLessThan(PREVIEW_MAX_BYTES)
  })
  it('CSV：引号 / 转义 / 引号内换行 / BOM / CRLF / 末尾空行', () => {
    expect(parseDelimited('\uFEFFname,age,note\r\n"Li, Lei",30,"say ""hi"""\r\nWang,25,"a\nb"\r\n\r\n', ',')).toEqual({
      rows: [['name', 'age', 'note'], ['Li, Lei', '30', 'say "hi"'], ['Wang', '25', 'a\nb']], truncated: false,
    })
    expect(parseDelimited('a\tb\n1\t2', '\t').rows).toEqual([['a', 'b'], ['1', '2']])
    expect(parseDelimited('a\n1\n2\n3\n4', ',', 3)).toEqual({ rows: [['a'], ['1'], ['2']], truncated: true })
  })
})
