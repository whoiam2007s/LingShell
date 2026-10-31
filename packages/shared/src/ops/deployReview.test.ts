import { describe, it, expect } from 'vitest'
import {
  ruleRisks, mergeRisks, parsePlanReply, parseDeployProbe, applyProbeJudge, chunkProbeRows, probeRisks, suggestConclusion,
  reviewMarkdown, reviewToRunbook, docDiff, emptyReview, reviewSummary, type DeployProbeRow, type ReviewRisk,
} from './deployReview.js'

const ids = (rs: ReviewRisk[]) => rs.map((r) => r.id)

describe('ruleRisks', () => {
  it('完整的文档：没有规则风险', () => {
    const doc = '# 部署 app-1.2.0\n先备份数据库 mysqldump\n```\nsystemctl stop app\nmysql < migrate.sql\n```\n验证：curl http://127.0.0.1/health\n回滚：恢复旧版本\nsha256: ' + 'a'.repeat(64)
    expect(ruleRisks({ docText: doc, artifacts: [{ name: 'app-1.2.0.jar', size: 1, sha256: 'a'.repeat(64) }] })).toEqual([])
  })
  it('明文密码 / 没回滚 / 改库没备份 / 没验证', () => {
    const doc = '配置 password=Abc12345xyz\n```\nmysql -e "ALTER TABLE t ADD c int"\nrm -rf /opt/app/lib\n```'
    const rs = ruleRisks({ docText: doc, artifacts: [] })
    expect(ids(rs)).toEqual(['rule-secret', 'rule-danger', 'rule-rollback', 'rule-db-backup', 'rule-verify'])
    expect(rs[0].evidence).not.toContain('Abc12345xyz')
    expect(rs[1].evidence).toContain('rm -rf /opt/app/lib')
    const ev = ruleRisks({ docText: '```\nmysql -uroot -pS3cretPass1 -e "ALTER TABLE t ADD c int"\n```', artifacts: [] }).map((r) => r.evidence ?? '').join('\n')
    expect(ev).toContain('ALTER TABLE')
    expect(ev).not.toContain('S3cretPass1')
  })
  it('占位符不算明文密码；hibernate.SQL 配置键不算改库', () => {
    const doc = 'spring.datasource.password=${db_pwd}\nspring.data.mongodb.uri=mongodb://${u}:${p}@${h}/${d}\nredis.password={{redis_pwd}}\nmysql.password=<密码>\nlogging.level.org.hibernate.SQL=INFO\n回滚：还原 验证：curl'
    expect(ids(ruleRisks({ docText: doc, artifacts: [] }))).toEqual([])
    expect(ids(ruleRisks({ docText: doc + '\nadmin.password=Abc12345xyz', artifacts: [] }))).toEqual(['rule-secret'])
    expect(ids(ruleRisks({ docText: '执行 init.sql，回滚：还原，验证：curl', artifacts: [] }))).toEqual(['rule-db-backup'])
  })
  it('产物：校验值对不上、版本不一致、没提到', () => {
    const doc = '部署 app-1.2.0.jar 和 web.tar.gz，回滚 旧版本，验证 health\nsha256 ' + 'b'.repeat(64)
    const rs = ruleRisks({ docText: doc, artifacts: [
      { name: 'app-1.3.0.jar', size: 1, sha256: 'c'.repeat(64) },
      { name: 'web.tar.gz', size: 1, sha256: 'b'.repeat(64) },
      { name: 'tool-2.0.zip', size: 1, sha256: 'b'.repeat(64) },
    ] })
    const t = rs.map((r) => r.title).join('\n')
    expect(t).toContain('「app-1.3.0.jar」的 sha256')
    expect(t).toContain('「app-1.3.0.jar」的版本和文档不一致')
    expect(rs.find((r) => r.title.includes('版本'))!.detail).toContain('1.2.0')
    expect(t).toContain('没提到产物「tool-2.0.zip」')
    expect(t).not.toContain('web.tar.gz')
  })
  it('有停机步骤但没说明', () => {
    const plan = { summary: 's', prerequisites: [], steps: [{ title: '停服务', command: 'systemctl stop app', downtime: true }], configChanges: [], dbChanges: [], verify: ['curl'], rollback: ['x'] }
    expect(ids(ruleRisks({ docText: 'x', artifacts: [], plan }))).toEqual(['rule-downtime'])
  })
})

describe('parsePlanReply', () => {
  it('解析清单与 AI 风险，丢掉空项', () => {
    const raw = '<think>…</think>```json\n' + JSON.stringify({
      summary: '部署 app', prerequisites: [{ item: 'JDK', requirement: '17', check: 'java -version 2>&1' }, { item: '' }],
      steps: [{ title: '停服务', command: 'systemctl stop app', downtime: true }, {}], configChanges: ['a'], dbChanges: [], verify: ['curl'], rollback: [],
      risks: [{ level: 'high', category: '顺序', title: '没停服务就迁库', detail: 'd' }, { title: '' }],
    }) + '\n```'
    const r = parsePlanReply(raw)
    if ('error' in r) throw new Error(r.error)
    expect(r.plan.prerequisites).toEqual([{ item: 'JDK', requirement: '17', check: 'java -version 2>&1' }])
    expect(r.plan.steps).toEqual([{ title: '停服务', command: 'systemctl stop app', downtime: true }])
    expect(r.risks).toHaveLength(1)
    expect(r.risks[0]).toMatchObject({ level: 'high', source: 'ai', decision: 'open' })
    expect(r.risks[0].id).toBe(((parsePlanReply(raw) as { risks: ReviewRisk[] }).risks[0]).id)   // id 稳定
  })
  it('不是 JSON → 报错', () => {
    expect(parsePlanReply('好的')).toEqual({ error: '模型没有按格式返回，请重试' })
  })
})

describe('预检脚本', () => {
  it('解析各条输出与退出码', () => {
    const out = '@@LS-PROBE 0@@\nopenjdk 17\n\n@@LS-PROBE-RC 0@@\n@@LS-PROBE 1@@\n\n@@LS-PROBE-RC 3@@\n'
    expect(parseDeployProbe(out, 3)).toEqual([{ output: 'openjdk 17', code: 0 }, { output: '', code: 3 }, { output: '' }])
  })
})

describe('预检判定与风险', () => {
  const row = (o: Partial<DeployProbeRow>): DeployProbeRow => ({ hostId: 'h1', hostLabel: 'web1', item: 'JDK', requirement: '17', command: 'java -version', output: 'openjdk 11', code: 0, status: 'warn', note: '', ...o })
  it('主机多时分批：行数 / 字符数超限就拆开，起始下标连续', () => {
    const rows = Array.from({ length: 50 }, (_, i) => row({ hostId: `h${i}` }))
    const cs = chunkProbeRows(rows)
    expect(cs.map((c) => c.rows.length)).toEqual([24, 24, 2])
    expect(cs.map((c) => c.start)).toEqual([0, 24, 48])
    const big = Array.from({ length: 5 }, (_, i) => row({ hostId: `h${i}`, output: 'x'.repeat(1500) }))
    const cs2 = chunkProbeRows(big, 24, 3000)
    expect(cs2.length).toBeGreaterThan(1)
    expect(cs2.flatMap((c) => c.rows)).toHaveLength(5)
    expect(chunkProbeRows([])).toEqual([])
  })
  it('按模型判定改状态，执行失败的不改', () => {
    const rows = [row({}), row({ status: 'error', note: '连接失败' })]
    const r = applyProbeJudge(rows, '[{"i":0,"status":"fail","note":"实际 11"},{"i":1,"status":"pass"}]')
    expect(r[0]).toMatchObject({ status: 'fail', note: '实际 11' })
    expect(r[1].status).toBe('error')
    const risks = probeRisks([...r, row({ hostLabel: 'web2', status: 'fail', note: '实际 8' })])
    expect(risks.map((x) => [x.level, x.title])).toEqual([['high', '2 台主机不满足：JDK'], ['medium', '1 台主机没能检查：JDK']])
  })
})

describe('合并、结论、报告、手册', () => {
  const risk = (o: Partial<ReviewRisk>): ReviewRisk => ({ id: 'a', level: 'medium', category: 'c', title: 't', detail: 'd', source: 'rule', decision: 'open', ...o })
  it('重新分析保留评审意见，按等级排序', () => {
    const m = mergeRisks([risk({ id: 'a', decision: 'ignore', note: '已知' })], [risk({ id: 'a' }), risk({ id: 'b', level: 'high' })])
    expect(m.map((x) => [x.id, x.decision, x.note])).toEqual([['b', 'open', undefined], ['a', 'ignore', '已知']])
  })
  it('建议结论', () => {
    expect(suggestConclusion({ risks: [] })).toBe('pass')
    expect(suggestConclusion({ risks: [risk({ level: 'low' })] })).toBe('conditional')
    expect(suggestConclusion({ risks: [risk({ level: 'high' })] })).toBe('fail')
    expect(suggestConclusion({ risks: [risk({ level: 'high', decision: 'accept' })] })).toBe('pass')
    expect(suggestConclusion({ risks: [risk({ level: 'low', decision: 'rework' })] })).toBe('fail')
  })
  it('报告与转手册', () => {
    const r = { ...emptyReview('r1'), title: '订单服务 v2', docName: 'deploy.md', conclusion: 'conditional' as const, reviewer: '张三', hostIds: ['h1'],
      risks: [risk({ title: '有 | 竖线', evidence: 'x```y' })],
      plan: { summary: '升级订单服务', prerequisites: [{ item: 'JDK', requirement: '17', check: 'java -version' }], steps: [{ title: '停服务', command: 'systemctl stop order', downtime: true }, { title: '通知业务' }], configChanges: [], dbChanges: [], verify: ['curl health'], rollback: ['还原 jar'] } }
    const md = reviewMarkdown(r, { h1: 'web1' })
    expect(md).toContain('# 部署评审报告：订单服务 v2')
    expect(md).toContain('**有条件通过**')
    expect(md).toContain('| 目标主机 | web1 |')
    expect(md).toContain('有 \\| 竖线')
    expect(md).not.toContain('x```y')
    const rb = reviewToRunbook(r)
    expect(rb.name).toBe('部署：订单服务 v2')
    expect(rb.steps.map((s) => [s.title, s.kind])).toEqual([['检查：JDK（要求 17）', 'check'], ['停服务（中断服务）', 'change'], ['通知业务', 'change'], ['验证：curl health', 'check']])
    expect(reviewSummary(r)).toMatchObject({ title: '订单服务 v2', openHigh: 0, risks: 1 })
  })
  it('文档对比', () => {
    expect(docDiff('a\nb\nc', 'a\nB\nc\nd')).toMatchObject({ added: 2, removed: 1 })
  })
  it('报告外发前：预检输出和依据再按样式脱敏；文档截断有提示', () => {
    const r = { ...emptyReview('r3'), planTruncated: true,
      risks: [risk({ evidence: 'DB_PASSWORD=Abc12345xyz' })],
      probes: [{ hostId: 'h1', hostLabel: 'web1', item: '配置', requirement: '—', command: 'cat app.yml', output: 'password=Abc12345xyz\nok', code: 0, status: 'warn' as const, note: 'password=Abc12345xyz' }],
      plan: { summary: 's', prerequisites: [], steps: [], configChanges: [], dbChanges: [], verify: [], rollback: [] } }
    const md = reviewMarkdown(r)
    expect(md).not.toContain('Abc12345xyz')
    expect(md).toContain('[已脱敏]')
    expect(md).toContain('只解读了前 6 万字')
  })
})
