import { describe, it, expect } from 'vitest'
import { decideByMode, grantScopeOf, denyReasonOf, EXEC_MODES, DEFAULT_EXEC_MODE, type ExecMode, type OpFacts } from './execMode.js'

const read: OpFacts = { kind: 'read' }
const writeIn: OpFacts = { kind: 'write', outsideWorkDir: false }
const writeOut: OpFacts = { kind: 'write', outsideWorkDir: true }
const execReadOnly: OpFacts = { kind: 'exec', readOnlyCommand: true }
const execWrite: OpFacts = { kind: 'exec', readOnlyCommand: false }

describe('三条不变式：任何模式都成立', () => {
  it('删除永远问（预演直接拒）', () => {
    for (const m of EXEC_MODES) {
      const f: OpFacts = { kind: 'write', outsideWorkDir: false, destructive: true, granted: true }
      expect(decideByMode(m, f), m).toBe(m === 'preview' ? 'deny' : 'ask')
    }
  })

  it('危险命令永远问（预演直接拒），且「已批准过」也不能放行', () => {
    for (const m of EXEC_MODES) {
      const f: OpFacts = { kind: 'exec', readOnlyCommand: false, risk: 'dangerous', granted: true }
      expect(decideByMode(m, f), m).toBe(m === 'preview' ? 'deny' : 'ask')
    }
  })

  it('读操作永远放行', () => {
    for (const m of EXEC_MODES) expect(decideByMode(m, read), m).toBe('allow')
  })
})

describe('预演：只读放行，其余全拒', () => {
  it('写文件 / 会改东西的命令都拒', () => {
    expect(decideByMode('preview', writeIn)).toBe('deny')
    expect(decideByMode('preview', writeOut)).toBe('deny')
    expect(decideByMode('preview', execWrite)).toBe('deny')
  })
  it('只读命令放行', () => {
    expect(decideByMode('preview', execReadOnly)).toBe('allow')
  })
  it('拒绝理由能区分原因', () => {
    expect(denyReasonOf('preview', execWrite)).toBe('preview_mode_readonly')
    expect(denyReasonOf('preview', { kind: 'write', destructive: true })).toBe('preview_mode_no_delete')
    expect(denyReasonOf('preview', { kind: 'exec', risk: 'dangerous' })).toBe('preview_mode_no_dangerous')
  })
})

describe('逐条确认（默认）：与升级前行为一致', () => {
  it('没批过要问，批过就放行', () => {
    expect(decideByMode('confirm', writeIn)).toBe('ask')
    expect(decideByMode('confirm', { ...writeIn, granted: true })).toBe('allow')
    expect(decideByMode('confirm', execReadOnly)).toBe('ask')
    expect(decideByMode('confirm', { ...execReadOnly, granted: true })).toBe('allow')
  })
  it('目录外写即使批过也问', () => {
    expect(decideByMode('confirm', { ...writeOut, granted: true })).toBe('ask')
  })
  it('会改东西的命令一律问', () => {
    expect(decideByMode('confirm', execWrite)).toBe('ask')
    expect(decideByMode('confirm', { ...execWrite, granted: true })).toBe('ask')
  })
})

describe('确认一次：批过就跨主机复用', () => {
  it('工作目录内写：批过就放行', () => {
    expect(decideByMode('auto', writeIn)).toBe('ask')
    expect(decideByMode('auto', { ...writeIn, granted: true })).toBe('allow')
  })
  it('目录外写仍然问', () => {
    expect(decideByMode('auto', { ...writeOut, granted: true })).toBe('ask')
  })
  it('只读命令批过就放行', () => {
    expect(decideByMode('auto', { ...execReadOnly, granted: true })).toBe('allow')
  })
})

describe('信任：目录内自动，目录外与会改东西的命令仍问', () => {
  it('工作目录内写直接放行（不用批过）', () => {
    expect(decideByMode('trust', writeIn)).toBe('allow')
  })
  it('目录外写要问', () => {
    expect(decideByMode('trust', writeOut)).toBe('ask')
  })
  it('只读命令直接放行', () => {
    expect(decideByMode('trust', execReadOnly)).toBe('allow')
  })
  it('会改东西的命令仍然问（命令串判不出路径）', () => {
    expect(decideByMode('trust', execWrite)).toBe('ask')
  })
})

describe('授权记忆粒度', () => {
  it('confirm 按主机、auto 按工具、trust/preview 不用记', () => {
    expect(grantScopeOf('confirm')).toBe('host')
    expect(grantScopeOf('auto')).toBe('tool')
    expect(grantScopeOf('trust')).toBe('none')
    expect(grantScopeOf('preview')).toBe('none')
  })
})

describe('默认模式', () => {
  it('默认是逐条确认（升级后行为不变）', () => {
    expect(DEFAULT_EXEC_MODE).toBe('confirm')
    const m: ExecMode = DEFAULT_EXEC_MODE
    expect(decideByMode(m, writeIn)).toBe('ask')
  })
})
