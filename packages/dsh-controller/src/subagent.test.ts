import { describe, expect, it } from 'vitest'
import {
  SUBAGENT_DEFAULT_TIMEOUT_SEC, SUBAGENT_MAX_TIMEOUT_SEC, SUBAGENT_SUMMARY_MAX, SUBAGENT_TASK_MAX, SUBAGENT_TITLE_MAX,
  checkSubagentTask, clampTimeoutSec, composeSubagentTask, isWriteTool, parseSubagentSummary, parseToolList, subagentTitleOf, subagentToolDeny,
} from './subagent.js'

describe('subagentTitleOf', () => {
  it('优先用模型给的 title', () => {
    expect(subagentTitleOf('查一下这台机器上 nginx 的版本和是否在跑', '查生产 nginx 版本')).toBe('查生产 nginx 版本')
  })

  it('没给 title 就取 task 第一句（句号 / 问号 / 换行都算断句）', () => {
    expect(subagentTitleOf('查 nginx 版本。顺便看下磁盘')).toBe('查 nginx 版本')
    expect(subagentTitleOf('查 nginx 版本\n再跑 ps')).toBe('查 nginx 版本')
    expect(subagentTitleOf('日志在哪？')).toBe('日志在哪')
  })

  it('超过 40 字截断加省略号（下拉里只有一行）', () => {
    const t = subagentTitleOf('x'.repeat(80))
    expect(t.length).toBe(SUBAGENT_TITLE_MAX)
    expect(t.endsWith('…')).toBe(true)
  })

  it('空白输入不炸', () => {
    expect(subagentTitleOf('   ')).toBe('')
  })
})

describe('subagentToolDeny', () => {
  it('不许递归、不许跟用户交互', () => {
    expect(subagentToolDeny('spawn_subagent', 'write')).toMatch(/不能再派子代理/)
    expect(subagentToolDeny('ask_user', 'write')).toMatch(/不能跟用户交互/)
  })

  it('不许删除', () => {
    expect(subagentToolDeny('delete_file', 'write')).toBeTruthy()
    expect(subagentToolDeny('remove_card', 'write')).toBeTruthy()
  })

  it('只读子代理不能写文件类工具；exec 类按命令内容判（问题 11）', () => {
    expect(subagentToolDeny('write_file', 'read')).toMatch(/只授了只读权限/)
    expect(subagentToolDeny('upload_file', 'read')).toMatch(/只授了只读权限/)
    // 只读命令放行——以前这里按工具名一刀切，连 `nginx -v` 都被拒
    const ro = (c: string) => /^(nginx -v|ps|cat |ls|grep |df |systemctl status)/.test(c)
    expect(subagentToolDeny('exec_in_terminal', 'read', undefined, { command: 'nginx -v' }, ro)).toBeUndefined()
    expect(subagentToolDeny('exec_in_terminal', 'read', undefined, { command: 'nginx -v && ps aux' }, ro)).toBeUndefined()
    // 写命令拒绝，并指出是哪一段
    expect(subagentToolDeny('exec_in_terminal', 'read', undefined, { command: 'systemctl restart nginx' }, ro)).toMatch(/是写命令/)
    expect(subagentToolDeny('exec_in_terminal', 'read', undefined, { command: 'nginx -v && rm -rf /tmp/x' }, ro)).toMatch(/是写命令/)
    expect(subagentToolDeny('start_background', 'read', undefined, { command: 'touch /tmp/x' }, ro)).toMatch(/是写命令/)
    // 写权限的子代理照常
    expect(subagentToolDeny('exec_in_terminal', 'write', undefined, { command: 'systemctl restart nginx' }, ro)).toBeUndefined()
    // 参数没带命令：交给工具体报参数错，不在这里拦
    expect(subagentToolDeny('exec_in_terminal', 'read', undefined, {}, ro)).toBeUndefined()
    // 只读工具谁都放行
    expect(subagentToolDeny('read_file', 'read')).toBeUndefined()
    expect(subagentToolDeny('list_terminals', 'read')).toBeUndefined()
  })

  it('isWriteTool 认得写工具', () => {
    for (const n of ['write_file', 'upload_file', 'save_skill', 'exec_in_terminal']) expect(isWriteTool(n)).toBe(true)
    for (const n of ['read_file', 'list_config', 'run_on_hosts']) expect(isWriteTool(n)).toBe(false)
  })

  it('tools 白名单：不在名单里的拒，名单外的硬禁用照样拒', () => {
    expect(subagentToolDeny('read_file', 'read', ['read_file', 'list_terminals'])).toBeUndefined()
    expect(subagentToolDeny('exec_in_terminal', 'write', ['read_file'])).toMatch(/只允许用这些工具/)
    // 即使在白名单里，交互 / 递归 / 删除也不放开
    expect(subagentToolDeny('ask_user', 'write', ['ask_user'])).toMatch(/不能跟用户交互/)
    expect(subagentToolDeny('spawn_subagent', 'write', ['spawn_subagent'])).toMatch(/不能再派子代理/)
    expect(subagentToolDeny('delete_file', 'write', ['delete_file'])).toMatch(/不能删除/)
    // 空名单 = 不限制
    expect(subagentToolDeny('read_file', 'read', [])).toBeUndefined()
  })
})

describe('parseToolList', () => {
  it('数组 / 逗号 / 空格 / 中文逗号都认，去重去空', () => {
    expect(parseToolList(['read_file', 'list_terminals'])).toEqual(['read_file', 'list_terminals'])
    expect(parseToolList('read_file,list_terminals')).toEqual(['read_file', 'list_terminals'])
    expect(parseToolList('read_file，list_terminals  read_file')).toEqual(['read_file', 'list_terminals'])
    expect(parseToolList('  ')).toBeUndefined()
    expect(parseToolList(undefined)).toBeUndefined()
  })
})

describe('parseSubagentSummary', () => {
  it('普通总结 → done，原样保留', () => {
    const r = parseSubagentSummary('做了什么：跑了 nginx -t\n关键发现：配置正常')
    expect(r.status).toBe('done')
    expect(r.summary).toContain('nginx -t')
    expect(r.blocked).toBeUndefined()
  })

  it('BLOCKED 格式 → blocked，抽出问题与上下文', () => {
    const r = parseSubagentSummary('BLOCKED\n问题：缺日志的那台要不要跳过？\n上下文：web2 上 /var/log/nginx 不存在')
    expect(r.status).toBe('blocked')
    expect(r.blocked?.question).toBe('缺日志的那台要不要跳过？')
    expect(r.blocked?.context).toContain('/var/log/nginx')
  })

  it('BLOCKED 在中间也算（模型爱先写一段再标记）', () => {
    const r = parseSubagentSummary('先查了三台机器。\n\nBLOCKED\n问题：要覆盖吗？\n上下文：目标文件已存在')
    expect(r.status).toBe('blocked')
    expect(r.blocked?.question).toBe('要覆盖吗？')
  })

  it('blocked 但没写问题 / 上下文 → 给占位说明，不编造', () => {
    const r = parseSubagentSummary('BLOCKED')
    expect(r.status).toBe('blocked')
    expect(r.blocked?.question).toBeTruthy()
    expect(r.blocked?.context).toBeTruthy()
  })

  it('超长截断并注明', () => {
    const r = parseSubagentSummary('x'.repeat(SUBAGENT_SUMMARY_MAX + 500))
    expect(r.summary.length).toBeLessThan(SUBAGENT_SUMMARY_MAX + 200)
    expect(r.summary).toContain('已截断')
  })

  it('空总结给占位', () => {
    expect(parseSubagentSummary('   ').summary).toContain('没有给出总结')
  })
})

describe('checkSubagentTask / clampTimeoutSec / composeSubagentTask', () => {
  it('task 必填且不超长', () => {
    expect(checkSubagentTask('  ').ok).toBe(false)
    expect(checkSubagentTask('查一下 nginx 版本').ok).toBe(true)
    expect(checkSubagentTask('x'.repeat(SUBAGENT_TASK_MAX + 1)).ok).toBe(false)
  })

  it('超时夹在 30s–30min，缺省 10 分钟', () => {
    expect(clampTimeoutSec(undefined)).toBe(SUBAGENT_DEFAULT_TIMEOUT_SEC)
    expect(clampTimeoutSec(0)).toBe(SUBAGENT_DEFAULT_TIMEOUT_SEC)
    expect(clampTimeoutSec(5)).toBe(30)
    expect(clampTimeoutSec(99999)).toBe(SUBAGENT_MAX_TIMEOUT_SEC)
    expect(clampTimeoutSec(120)).toBe(120)
  })

  it('有背景时拼在任务后面', () => {
    expect(composeSubagentTask('查版本', undefined)).toBe('查版本')
    expect(composeSubagentTask('查版本', '这台是生产')).toContain('背景：这台是生产')
  })
})
