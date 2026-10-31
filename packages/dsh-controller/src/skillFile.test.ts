import { describe, it, expect } from 'vitest'
import { parseSkillMd, buildSkillMd, isSkillName } from './skillFile.js'

describe('parseSkillMd', () => {
  it('解析 name / description / 正文；CRLF 与 BOM 也认', () => {
    const p = parseSkillMd('﻿---\r\nname: nginx-check\r\ndescription: 检查 nginx 配置与状态\r\n---\r\n\r\n# 步骤\r\n1. nginx -t\r\n')
    expect(p).toMatchObject({ ok: true, meta: { name: 'nginx-check', description: '检查 nginx 配置与状态' }, body: '# 步骤\n1. nginx -t' })
  })
  it('引号串、块标量、续行、行尾注释', () => {
    const p = parseSkillMd([
      '---', 'name: "disk-usage"', 'description: >', '  查磁盘占用，', '  找出最大的目录', "whenToUse: '磁盘满了的时候'  ", 'license: MIT # 注释', 'metadata:', '  author: me', '---', 'body',
    ].join('\n'))
    expect(p.ok && p.meta).toEqual({ name: 'disk-usage', description: '查磁盘占用， 找出最大的目录', whenToUse: '磁盘满了的时候' })
    expect(p.ok && p.extra).toEqual(['license: MIT # 注释', 'metadata:', '  author: me'])
  })
  it('invocation 开关：布尔的各种写法；写错整条作废；驼峰写法拒绝', () => {
    const head = (x: string) => `---\nname: a\ndescription: d\n${x}\n---\nb`
    expect(parseSkillMd(head('disable-model-invocation: yes'))).toMatchObject({ ok: true, meta: { disableModelInvocation: true } })
    expect(parseSkillMd(head('user-invocable: OFF'))).toMatchObject({ ok: true, meta: { userInvocable: false } })
    expect(parseSkillMd(head('user-invocable: maybe'))).toMatchObject({ ok: false })
    expect(parseSkillMd(head('userInvocable: false'))).toMatchObject({ ok: false })
  })
  it('坏文件给出原因：没有 frontmatter / 没结束 / 缺字段 / 名字不合法', () => {
    expect(parseSkillMd('# 只有正文')).toMatchObject({ ok: false, error: expect.stringContaining('frontmatter') })
    expect(parseSkillMd('---\nname: a\n')).toMatchObject({ ok: false, error: expect.stringContaining('结束') })
    expect(parseSkillMd('---\ndescription: d\n---\n')).toMatchObject({ ok: false, error: expect.stringContaining('name') })
    expect(parseSkillMd('---\nname: a\n---\n')).toMatchObject({ ok: false, error: expect.stringContaining('description') })
    expect(parseSkillMd('---\nname: Bad_Name\ndescription: d\n---\n')).toMatchObject({ ok: false, error: expect.stringContaining('不合法') })
  })
  it('buildSkillMd 往返一致，并保留其它键', () => {
    const md = buildSkillMd({ name: 'x-y', description: '含 "引号" 与: 冒号' }, '正文\n第二行', ['license: MIT'])
    const p = parseSkillMd(md)
    expect(p).toMatchObject({ ok: true, meta: { name: 'x-y', description: '含 "引号" 与: 冒号' }, body: '正文\n第二行', extra: ['license: MIT'] })
  })
  it('isSkillName', () => {
    expect(isSkillName('a-b-1')).toBe(true)
    for (const bad of ['A', 'a--b', '-a', 'a_b', 'a'.repeat(65), '']) expect(isSkillName(bad)).toBe(false)
  })
})
