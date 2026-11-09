import { describe, it, expect } from 'vitest'
import {
  CONTEXT_KINDS, CONTEXT_MAX_CHARS, clampContext, splitContextBlocks, withContextBlocks,
  type ContextAttachment, type ContextKind,
} from './attachments.js'

// 每个上下文类型都要能「拼进消息 → 从消息里解回来」：以前漏登记一种类型，
// 结果那块上下文整段显示在气泡里（发送内容剥不下来）。这个测试守住这条线。
const SAMPLE: Record<ContextKind, { name: string; text: string }> = {
  terminal: { name: '本地 1', text: 'root@web:~$ uptime\n 10:00 up 3 days' },
  host: { name: 'prod-web-01', text: '操作系统 Ubuntu 24.04 · 2 核 4G' },
  session: { name: '修 nginx 502', text: '用户：502 怎么查？\nAI：先看 error.log' },
  shell: { name: '谁在占用 443', text: '$ ss -lntp | grep 443\nLISTEN 0 511 *:443' },
  git: { name: 'LingShell', text: '分支 feat/0.1.8 · 3 个未提交改动' },
  container: { name: 'nginx:1.27', text: '容器 id 3f2a 运行中 · 端口 80:80' },
  history: { name: 'grep nginx', text: 'PID 4211 · 退出码 0 · 12ms' },
  ports: { name: '443', text: '监听 0.0.0.0:443 · 进程 nginx (PID 4211)' },
  k8s: { name: 'default', text: '3 个 Pod · 1 个 CrashLoopBackOff' },
  alert: { name: 'OOM', text: '[12:00:01] Out of memory: Killed process 4211' },
  check: { name: '主机体检', text: '发现 4 个问题：磁盘 92%、swap 未开…' },
  proc: { name: 'nginx #4211', text: 'PID 4211 · CPU 12.3% · 内存 3.5%' },
  svc: { name: 'nginx.service', text: '运行状态 active（running）· 开机自启 enabled' },
  sql: { name: '订单库 · SQL', text: 'SELECT * FROM orders WHERE status=? · 走全表扫描' },
  log: { name: 'auth.log · 3 行', text: 'Failed password for root from 1.2.3.4' },
  disk: { name: 'prod-web-01', text: '/ 92% · /var/log 8.2G' },
  fw: { name: 'prod-web-01', text: 'ufw 已启用 · 放行 22/80/443' },
  table: { name: '表格', text: '| id | name |\n| 1 | 张三 |' },
  probe: { name: '连通性探测', text: 'web01 → db01:3306 通 · web01 → api:443 超时' },
  audit: { name: '执行记录 · 3', text: '共 3 条：file_delete 1、process_kill 1、read_allowed 1' },
}

describe('上下文类型守门测试', () => {
  it('每种 CONTEXT_KINDS 都有样本与往返用例', () => {
    expect(Object.keys(SAMPLE).sort()).toEqual([...CONTEXT_KINDS].sort())
  })

  for (const kind of Object.values(CONTEXT_KINDS) as ContextKind[]) {
    it(`${kind}：拼进消息后能原样解回来，不留在气泡里`, () => {
      const sample = SAMPLE[kind]
      const att: ContextAttachment = { kind: 'context', ctx: kind, name: sample.name, text: sample.text }
      const msg = withContextBlocks('帮我看一下', [att])
      expect(msg).toContain(`<context type="${kind}"`)
      const back = splitContextBlocks(msg)
      expect(back.text).toBe('帮我看一下')
      expect(back.ctxs).toHaveLength(1)
      expect(back.ctxs[0]).toMatchObject({ ctx: kind, name: sample.name, text: sample.text })
    })
  }

  it('超上限：只发前 12000 字，并注明原文长度（模型知道被截断）', () => {
    const long = 'a'.repeat(CONTEXT_MAX_CHARS + 500)
    const out = clampContext(long)
    expect(out.startsWith('a'.repeat(CONTEXT_MAX_CHARS))).toBe(true)
    expect(out).toContain(`${CONTEXT_MAX_CHARS + 500} 字`)
    expect(clampContext('短内容')).toBe('短内容')
  })
})
