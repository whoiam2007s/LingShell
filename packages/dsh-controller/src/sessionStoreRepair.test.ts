import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { quarantineFlatSessionArtifacts } from './sessionStoreRepair.js'

describe('会话存档根目录自愈（dsh 扁平布局拒绝）', () => {
  let dir: string
  let root: string
  let quarantine: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lingshell-root-heal-'))
    root = join(dir, 'dsh-sessions')
    quarantine = join(dir, 'repaired', 'session-artifacts', '2026-11-26T00-00-00-000Z')
    mkdirSync(root, { recursive: true })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  /** 在 <root>/<rel> 放一个文件（自动建父目录） */
  const put = (rel: string, content = 'x') => {
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content)
  }

  // 这次线上事故的形状：根下 sess_191b4938/live.jsonl 让每次 resume 都抛
  // "uses the unsupported flat-file layout"，历史会话和新建会话全部不可用。
  it('根下 sess_xxx/live.jsonl → 整个目录搬进隔离区，根目录恢复可扫', async () => {
    put('sess_dead/live.jsonl', '{"type":"task"}')
    const moved = await quarantineFlatSessionArtifacts(root, quarantine)
    expect(moved).toHaveLength(1)
    expect(existsSync(join(root, 'sess_dead'))).toBe(false)
    expect(readFileSync(join(quarantine, 'sess_dead', 'live.jsonl'), 'utf8')).toBe('{"type":"task"}')
  })

  it('正常项目目录里混进了 *.jsonl → 只搬文件，项目目录和会话存档一个字节不动', async () => {
    put('--C-Users-Administrator--/sess_ok/session.v4.jsonl.zstd', 'keep')
    put('--C-Users-Administrator--/live.jsonl', 'stray')
    const moved = await quarantineFlatSessionArtifacts(root, quarantine)
    expect(moved).toHaveLength(1)
    expect(readFileSync(join(root, '--C-Users-Administrator--', 'sess_ok', 'session.v4.jsonl.zstd'), 'utf8')).toBe('keep')
    expect(existsSync(join(root, '--C-Users-Administrator--', 'live.jsonl'))).toBe(false)
    expect(existsSync(join(quarantine, '--C-Users-Administrator--', 'live.jsonl'))).toBe(true)
  })

  it('干净的根目录什么都不做（会话目录里的 session.v4.jsonl.zstd 不误伤，也不建空隔离区）', async () => {
    put('--D-projects-LingShell-source--/sess_a/session.v4.jsonl.zstd')
    put('_no-cwd/sess_b/session.v4.jsonl.zstd')
    put('--C-Users-Administrator--/sess_c/session.v4.jsonl.zstd')
    expect(await quarantineFlatSessionArtifacts(root, quarantine)).toEqual([])
    expect(existsSync(quarantine)).toBe(false)
    expect(existsSync(join(root, '--C-Users-Administrator--', 'sess_c', 'session.v4.jsonl.zstd'))).toBe(true)
  })

  it('根目录不存在 / 根下只有普通文件 → 安全返回空，不影响启动', async () => {
    expect(await quarantineFlatSessionArtifacts(join(dir, 'nope'), quarantine)).toEqual([])
    writeFileSync(join(root, 'readme.txt'), 'x')
    expect(await quarantineFlatSessionArtifacts(root, quarantine)).toEqual([])
  })

  it('隔离区已有同名东西 → 不覆盖旧留存，加序号', async () => {
    mkdirSync(join(quarantine, 'sess_dead'), { recursive: true })
    writeFileSync(join(quarantine, 'sess_dead', 'live.jsonl'), 'old')
    put('sess_dead/live.jsonl', 'new')
    await quarantineFlatSessionArtifacts(root, quarantine)
    expect(readFileSync(join(quarantine, 'sess_dead', 'live.jsonl'), 'utf8')).toBe('old')
    expect(readFileSync(join(quarantine, 'sess_dead-1', 'live.jsonl'), 'utf8')).toBe('new')
  })

  it('重复跑是幂等的（第二次没东西可搬）', async () => {
    put('sess_dead/live.jsonl')
    expect(await quarantineFlatSessionArtifacts(root, quarantine)).toHaveLength(1)
    expect(await quarantineFlatSessionArtifacts(root, quarantine)).toEqual([])
  })
})
