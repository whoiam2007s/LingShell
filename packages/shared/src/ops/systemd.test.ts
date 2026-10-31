import { describe, it, expect } from 'vitest'
import {
  filterSvcs, isSvcAction, isSvcName, parseSystemd, sortSvcs, splitSvcRc, svcActionError, svcAutostart, svcFailed, svcQuote,
  systemdActionCommand, systemdAuditLabel, systemdDecision, systemdListCommand, systemdStatusCommand, systemdSupported,
} from './systemd.js'

const OUT = `@@units
cron.service                 loaded    active   running Regular background program processing daemon
nginx.service                loaded    failed   failed  A high performance web server and a reverse proxy server
● php-fpm.service            loaded    failed   failed  PHP 8.1 FastCGI 进程管理器
ssh.service                  loaded    active   running OpenBSD Secure Shell server
nfs-server.service           not-found inactive dead    nfs-server.service
systemd-fsck@dev-disk-by\\x2duuid-1234.service loaded active exited File System Check on /dev/disk/by-uuid/1234
@@files
cron.service                           enabled         enabled
nginx.service                          enabled         enabled
php-fpm.service                        disabled        enabled
ssh.service                            enabled         enabled
getty@.service                         enabled         enabled
mysql.service                          disabled        enabled
systemd-journald.service               static          -
`

describe('systemd 服务解析', () => {
  it('两段合并：运行状态 + 开机自启；没加载的服务也列出；模板单元跳过', () => {
    const r = parseSystemd(OUT)
    expect(r.noSystemd).toBeUndefined()
    const by = Object.fromEntries(r.rows.map((x) => [x.name, x]))
    expect(by['nginx.service']).toEqual({ name: 'nginx.service', load: 'loaded', active: 'failed', sub: 'failed', description: 'A high performance web server and a reverse proxy server', enabled: 'enabled' })
    expect(by['php-fpm.service']).toMatchObject({ active: 'failed', description: 'PHP 8.1 FastCGI 进程管理器', enabled: 'disabled' })
    expect(by['mysql.service']).toEqual({ name: 'mysql.service', description: '', load: '', active: 'inactive', sub: 'dead', enabled: 'disabled' })
    expect(by['nfs-server.service'].load).toBe('not-found')
    expect(by['nfs-server.service'].enabled).toBeUndefined()
    expect(by['systemd-fsck@dev-disk-by\\x2duuid-1234.service'].sub).toBe('exited')
    expect(by['getty@.service']).toBeUndefined()
    expect(by['systemd-journald.service'].enabled).toBe('static')
  })
  it('没有 systemd：没命令 / 不是 systemd 启动', () => {
    expect(parseSystemd('@@nosystemd:missing\n').noSystemd).toMatch(/没有 systemctl/)
    expect(parseSystemd('@@units\nSystem has not been booted with systemd as init system (PID 1). Can\'t operate.\nFailed to connect to bus: Host is down\n@@files\n').noSystemd).toMatch(/不是用 systemd 启动/)
  })
  it('失败 / 开机自启判断', () => {
    const r = parseSystemd(OUT).rows
    const n = (s: string) => r.find((x) => x.name === s)!
    expect(svcFailed(n('nginx.service'))).toBe(true)
    expect(svcFailed(n('cron.service'))).toBe(false)
    expect(svcAutostart(n('cron.service'))).toBe(true)
    expect(svcAutostart(n('mysql.service'))).toBe(false)
    expect(svcAutostart(n('systemd-journald.service'))).toBeUndefined()
    expect(svcAutostart(n('nfs-server.service'))).toBeUndefined()
  })
  it('过滤（名字 / 描述，多词）、只看失败、失败置顶可关', () => {
    const r = parseSystemd(OUT).rows
    expect(filterSvcs(r, 'web server').map((x) => x.name)).toEqual(['nginx.service'])
    expect(filterSvcs(r, '进程').map((x) => x.name)).toEqual(['php-fpm.service'])
    expect(filterSvcs(r, '', true).map((x) => x.name).sort()).toEqual(['nginx.service', 'php-fpm.service'])
    const s = sortSvcs(r).map((x) => x.name)
    expect(s.slice(0, 2)).toEqual(['nginx.service', 'php-fpm.service'])
    expect(s[2]).toBe('cron.service')   // 然后是运行中的
    expect(sortSvcs(r, false).map((x) => x.name)[0]).toBe('cron.service')
  })
})

describe('systemd 命令', () => {
  it('支持范围：只给 Linux（或未知）的 SSH', () => {
    expect(systemdSupported('ssh', 'linux')).toBe(true)
    expect(systemdSupported('ssh', undefined)).toBe(true)
    expect(systemdSupported('ssh', 'macos')).toBe(false)
    expect(systemdSupported('local', 'linux')).toBe(false)
  })
  it('服务名 / 操作校验：拒绝 shell 元字符', () => {
    expect(isSvcName('nginx.service')).toBe(true)
    expect(isSvcName('systemd-fsck@dev-disk-by\\x2duuid-1.service')).toBe(true)
    expect(isSvcName('nginx')).toBe(false)
    expect(isSvcName('a;rm -rf /.service')).toBe(false)
    expect(isSvcName('$(id).service')).toBe(false)
    expect(isSvcName('-x.service')).toBe(false)
    expect(isSvcAction('restart')).toBe(true)
    expect(isSvcAction('mask')).toBe(false)
    expect(() => systemdActionCommand('restart', 'x;y.service')).toThrow()
    expect(() => systemdActionCommand('mask' as never, 'nginx.service')).toThrow()
  })
  it('命令：列表两段、status 带行数、操作非 root 走 sudo -n', () => {
    expect(systemdListCommand()).toContain('list-units --type=service --all --no-pager --plain --no-legend')
    expect(systemdListCommand()).toContain('list-unit-files --type=service --no-pager --plain --no-legend')
    expect(systemdStatusCommand('nginx.service')).toContain(`systemctl status '\\''nginx.service'\\'' --no-pager -l -n 30`)
    const a = systemdActionCommand('restart', 'nginx.service')
    expect(a).toContain(`sudo -n systemctl restart '\\''nginx.service'\\''`)
    expect(a).toContain('id -u')
    expect(a.startsWith('sh -c ')).toBe(true)
  })
  it('退出码 / 错误说明 / 执行记录标签', () => {
    expect(splitSvcRc('Job failed\n@@rc:1\n')).toEqual({ rc: 1, text: 'Job failed' })
    expect(splitSvcRc('ok')).toEqual({ text: 'ok' })
    expect(svcActionError('sudo: a password is required', 1)).toMatch(/^需要 root 权限.*\nsudo: a password is required$/s)
    expect(svcActionError('', 5)).toBe('退出码 5')
    expect(systemdDecision('restart')).toBe('systemd_restart')
    expect(systemdAuditLabel('systemd_restart')).toBe('服务·重启（手动）')
    expect(systemdAuditLabel('systemd_mask')).toBeUndefined()
    expect(systemdAuditLabel('docker_restart')).toBeUndefined()
  })
  it('问 AI 的引用：概况 + status 原文', () => {
    const r = parseSystemd(OUT).rows.find((x) => x.name === 'nginx.service')!
    const q = svcQuote('web-1', r, '× nginx.service - A high performance web server\n   Active: failed (Result: exit-code)')
    expect(q).toContain('终端「web-1」所在主机上的 systemd 服务 nginx.service')
    expect(q).toContain('运行状态 failed（failed）')
    expect(q).toContain('开机自启 enabled（是）')
    expect(q).toContain('Active: failed')
  })
})
