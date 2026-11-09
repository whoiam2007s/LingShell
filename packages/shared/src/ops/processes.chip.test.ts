import { describe, it, expect } from 'vitest'
import { procChip } from './processes.js'
import type { ProcRow } from './processes.js'

const row: ProcRow = {
  pid: 4321, ppid: 1, user: 'root', cpu: 12.34, mem: 3.5, rss: 20480,
  etime: '2-03:04:05', stat: 'S', command: '/usr/sbin/nginx -g daemon off;',
}

describe('进程 → 上下文 chip', () => {
  it('chip 名 = 命令名 #PID（同一程序多个进程也能区分）', () => {
    expect(procChip('prod-web-01', row).name).toBe('nginx #4321')
  })

  it('全文带 PID/父进程/用户/CPU/内存/RSS/运行时长/状态/命令行', () => {
    const { text } = procChip('prod-web-01', row)
    for (const s of ['PID 4321', '父进程 1', 'root', 'CPU 12.3%', '内存 3.5%', 'RSS 20 M', '已运行 2-03:04:05', '状态 S', '/usr/sbin/nginx']) {
      expect(text).toContain(s)
    }
    expect(text).toContain('不是命令输出')
  })

  it('没有 CPU 等字段时不硬塞（老内核/受限权限）', () => {
    const { text } = procChip('本机', { pid: 7, user: '', command: 'bash', etime: '', stat: '' })
    expect(text).not.toContain('CPU')
    expect(text).not.toContain('RSS')
    expect(procChip('本机', { pid: 7, user: '', command: 'bash', etime: '', stat: '' }).name).toBe('bash #7')
  })
})
