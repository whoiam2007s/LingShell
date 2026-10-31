import { describe, it, expect } from 'vitest'
import { parseStagedReview, splitHunks, hunkable, parseConflicts, mergeResult, hasConflictMarkers, parseGitBlame, isUncommittedHash, gitGraph, gitNetHint, gitOpCommand, gitOpDangerous, isRefName, isStashRef, parseGitLog, parseGitRefs, parseNameStatusZ, parseGitProgress,
  gitStashFilesCommand, gitReadFileCommand, gitChangelogCommand, gitRebasePlanCommand, parseRebasePlan } from './gitOps.js'

describe('名称校验', () => {
  it('分支 / 标签名', () => {
    for (const ok of ['main', 'feature/x', 'v1.0.2', 'fix_1-a', 'origin/main']) expect(isRefName(ok)).toBe(true)
    for (const bad of ['', '-x', 'a b', 'a..b', 'a~1', 'x^', 'a:b', 'a?', 'a*', 'a[', 'a\\b', '@', 'a@{1}', 'a/', 'a.', '.a', 'x.lock', 'a//b']) expect(isRefName(bad)).toBe(false)
    expect(isStashRef('stash@{3}')).toBe(true)
    expect(isStashRef('stash@{0};x')).toBe(false)
  })
  it('命令里的参数都被引起来 / 校验', () => {
    expect(gitOpCommand('/r', { op: 'checkout', branch: 'feature/x' }).cmd).toContain("git switch 'feature/x'")
    expect(() => gitOpCommand('/r', { op: 'reset', hash: 'HEAD~1', mode: 'hard' })).toThrow('非法')
    expect(() => gitOpCommand('/r', { op: 'deleteRemoteBranch', remote: '-o', name: 'x' })).toThrow('非法')
    expect(gitOpCommand('/r', { op: 'fetch' }).cmd).toContain('GIT_TERMINAL_PROMPT=0')
    expect(gitOpCommand('/r', { op: 'checkout', branch: 'x' }).cmd).not.toContain('GIT_TERMINAL_PROMPT')
    expect(gitOpDangerous({ op: 'reset', hash: 'abcd', mode: 'hard' })).toBe(true)
    expect(gitOpDangerous({ op: 'reset', hash: 'abcd', mode: 'soft' })).toBe(false)
  })
})

describe('解析', () => {
  const US = '\x1f', RS = '\x1e'
  it('refs：当前分支、上游领先落后、gone、跳过 origin/HEAD', () => {
    const out = [
      ['*', 'refs/heads/main', 'main', 'origin/main', 'ahead 2, behind 1', 'abc1234', '2026-10-19T10:00:00+08:00', 'msg'],
      [' ', 'refs/heads/old', 'old', 'origin/old', 'gone', 'abc1235', 'd', 's'],
      [' ', 'refs/remotes/origin/HEAD', 'origin', '', '', 'x', 'd', 's'],
      [' ', 'refs/tags/v1', 'v1', '', '', 'x', 'd', 's'],
    ].map((f) => f.join(US) + RS).join('\n')
    const r = parseGitRefs(out)
    expect(r.map((x) => [x.kind, x.name, x.current, x.ahead, x.behind, x.gone])).toEqual([['local', 'main', true, 2, 1, false], ['local', 'old', false, 0, 0, true], ['tag', 'v1', false, 0, 0, false]])
  })
  it('log：refs 简写', () => {
    const c = parseGitLog(['a'.repeat(40), 'b'.repeat(40), 'T', 't@x', '2026', 'HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1, refs/stash', 'sub'].join(US) + RS)
    expect(c[0].refs).toEqual(['HEAD -> main', 'origin/main', 'tag: v1'])
  })
  it('name-status -z：重命名带旧路径、带空格的路径', () => {
    expect(parseNameStatusZ('M\0a b.txt\0R100\0old.txt\0new.txt\0A\0x\0')).toEqual([{ code: 'M', path: 'a b.txt' }, { code: 'R', orig: 'old.txt', path: 'new.txt' }, { code: 'A', path: 'x' }])
  })
  it('进行中的操作', () => {
    expect(parseGitProgress('@@git:progress:cherry-pick\n@@git:rc:0')).toBe('cherry-pick')
    expect(parseGitProgress('@@git:rc:0')).toBeUndefined()
  })
  it('网络错误提示', () => {
    expect(gitNetHint('fatal: could not read Username for https://x: terminal prompts disabled')).toContain('凭据')
    expect(gitNetHint(' ! [rejected] main -> main (fetch first)')).toContain('先「拉取」')
    expect(gitNetHint('ok')).toBeUndefined()
  })
})

describe('按块 / 冲突 / 追溯', () => {
  it('拆块：每块的补丁带文件头；新文件不能按块', () => {
    const raw = 'diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-a\n+A\n b\n@@ -9,2 +9,2 @@ fn x\n i\n-j\n+J\n\\ No newline at end of file\n'
    const r = splitHunks(raw)
    expect(r.hunks.map((h) => h.header)).toEqual(['@@ -1,2 +1,2 @@', '@@ -9,2 +9,2 @@ fn x'])
    expect(r.hunks[1].patch).toBe('diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -9,2 +9,2 @@ fn x\n i\n-j\n+J\n\\ No newline at end of file\n')
    expect(hunkable(r.fileHeader)).toBe(true)
    expect(hunkable('diff --git a/n b/n\nnew file mode 100644')).toBe(false)
  })
  it('冲突：普通 / diff3 / CRLF / 没闭合', () => {
    const t = 'x\n<<<<<<< HEAD\nours\n||||||| base\nbase\n=======\ntheirs\n>>>>>>> dev\ny\n'
    const c = parseConflicts(t)
    expect(c).toEqual([{ kind: 'text', text: 'x\n' }, { kind: 'conflict', ours: 'ours\n', base: 'base\n', theirs: 'theirs\n', oursLabel: 'HEAD', theirsLabel: 'dev' }, { kind: 'text', text: 'y\n' }])
    expect(mergeResult(c, ['bothReverse'])).toBe('x\ntheirs\nours\ny\n')
    expect(mergeResult(c, [{ custom: 'mine\n' }])).toBe('x\nmine\ny\n')
    expect(mergeResult(c, ['base'])).toBe('x\nbase\ny\n')
    const crlf = 'a\r\n<<<<<<< HEAD\r\nO\r\n=======\r\nT\r\n>>>>>>> x\r\n'
    expect(mergeResult(parseConflicts(crlf), ['theirs'])).toBe('a\r\nT\r\n')
    expect(parseConflicts('<<<<<<< HEAD\nours\n').filter((x) => x.kind === 'conflict')).toEqual([])
    expect(hasConflictMarkers('a\n=======\nb')).toBe(false)   // Markdown 的分隔线不能当成未解决
    expect(hasConflictMarkers('<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> dev')).toBe(true)
    expect(hasConflictMarkers('a == b')).toBe(false)
  })
  it('blame --porcelain', () => {
    const h1 = 'a'.repeat(40), h0 = '0'.repeat(40)
    const out = `${h1} 1 1 2\nauthor 张三\nauthor-time 1700000000\nsummary init\nfilename f\n\tline1\n${h1} 2 2\n\tline2\n${h0} 3 3 1\nauthor Not Committed Yet\nauthor-time 1800000000\nsummary Version of f from f\n\tnew\n`
    const r = parseGitBlame(out)
    expect(r.map((l) => [l.line, l.author, l.text])).toEqual([[1, '张三', 'line1'], [2, '张三', 'line2'], [3, 'Not Committed Yet', 'new']])
    expect(r[1].summary).toBe('init')
    expect(isUncommittedHash(r[2].hash)).toBe(true)
    // SHA-256 仓库的 64 位提交号也要认
    const h64 = 'b'.repeat(64)
    expect(parseGitBlame(`${h64} 1 1 1\nauthor A\nauthor-time 1\nsummary s\n\tx\n`)).toHaveLength(1)
  })
})

describe('安全修复相关的命令构造 / 解析', () => {
  it('提交并推送：push 失败不能掉进 || 分支改推 origin', () => {
    const cmd = gitOpCommand('/r', { op: 'commit', amend: false, push: true, branch: 'feature/x' }, 'm').cmd
    expect(cmd).toContain("if git rev-parse -q --verify '@{u}'")
    expect(cmd).toContain("then git push; else git push -u origin 'feature/x'; fi")
    expect(cmd).not.toContain('&& git push ||')
  })
  it('撤销提交：浅克隆里拒绝，不能把分支 ref 删掉', () => {
    expect(gitOpCommand('/r', { op: 'undoCommit' }).cmd).toContain('--is-shallow-repository')
  })
  it('没有 -u 的储藏：README / 文件列表命令不再必然返回 1', () => {
    expect(gitStashFilesCommand('/r', 'stash@{0}')).toContain('; true; printf')
  })
  it('读合并文件：带真实字节数与 blob 哈希标记', () => {
    const cmd = gitReadFileCommand('/r', 'a b.txt')
    expect(cmd).toContain('wc -c')
    expect(cmd).toContain('git hash-object')
    expect(cmd).toContain('@@git:size:')
  })
  it('保存合并结果：文件被外部改过就拒绝，写入走同目录临时文件', () => {
    const cmd = gitOpCommand('/r', { op: 'resolveFile', path: 'a.txt', add: true, expectedHash: 'a'.repeat(40) }).cmd
    expect(cmd).toContain(`git hash-object -- 'a.txt'`)
    expect(cmd).toContain('文件在打开合并编辑器后已被修改')
    expect(cmd).toContain('.lingshell-merge-$$')
    expect(cmd).toContain('mv "$tmp"')
  })
  it('更新日志没有 from 时用空树..to，不把工作区改动算进统计', () => {
    expect(gitChangelogCommand('/r', undefined, 'HEAD')).toContain('git hash-object -t tree /dev/null')
    const withFrom = gitChangelogCommand('/r', 'v1.0.0', 'HEAD')
    expect(withFrom).toContain("diff --shortstat 'v1.0.0' 'HEAD'")
    expect(withFrom).not.toContain('hash-object -t tree /dev/null')
  })
  it('变基计划：校验 from 是 HEAD 祖先，带 HEAD / 提交总数，输出被截断能发现', () => {
    const cmd = gitRebasePlanCommand('/r', 'a'.repeat(40))
    expect(cmd).toContain('merge-base --is-ancestor')
    expect(cmd).toContain('@@git:head:')
    expect(cmd).toContain('@@git:count:')
    const p = parseRebasePlan(`@@git:notancestor\n@@git:rc:0`)
    expect(p.notAncestor).toBe(true)
    const h = 'c'.repeat(40)
    const ok = parseRebasePlan(`@@git:head:${h}\n@@git:count:2\n@@git:notroot\n@@git:merges:0\n@@git:log\n${h}\x1fA\x1f2026\x1fmsg\x1e\n@@git:rc:0`)
    expect(ok).toMatchObject({ head: h, count: 2 })
    expect(ok.notAncestor).toBeUndefined()
    expect(ok.commits).toHaveLength(1)
  })
  it('变基执行前校验 HEAD 没变', () => {
    const cmd = gitOpCommand('/r', { op: 'interactiveRebase', from: 'a'.repeat(40), root: false, steps: [{ hash: 'a'.repeat(40), action: 'pick' }], expectedHead: 'b'.repeat(40) }).cmd
    expect(cmd).toContain(`[ "$(git rev-parse HEAD)" = '${'b'.repeat(40)}' ]`)
  })
})

describe('AI 审查结果解析', () => {
  it('JSON → 按等级排序；有中高问题就是 fix；不是 JSON 返回 undefined', () => {
    const r = parseStagedReview('<think>x</think>```json\n{"verdict":"ok","summary":"","issues":[{"level":"low","file":"a.js","line":3,"title":"命名","suggestion":"改名"},{"level":"medium","file":"b.js","line":null,"title":"调试代码","suggestion":"删掉"},{"title":""}]}\n```')
    expect(r).toEqual({ verdict: 'fix', summary: '建议修改后再提交', issues: [{ level: 'medium', file: 'b.js', title: '调试代码', suggestion: '删掉' }, { level: 'low', file: 'a.js', line: 3, title: '命名', suggestion: '改名' }] })
    expect(parseStagedReview('{"verdict":"ok","summary":"没问题","issues":[]}')).toEqual({ verdict: 'ok', summary: '没问题', issues: [] })
    expect(parseStagedReview('可以提交')).toBeUndefined()
  })
})

describe('提交图', () => {
  it('线性历史：一列', () => {
    const g = gitGraph([{ hash: 'c', parents: ['b'] }, { hash: 'b', parents: ['a'] }, { hash: 'a', parents: [] }])
    expect(g.map((r) => r.col)).toEqual([0, 0, 0])
    expect(g[2].lines.filter((l) => l.half === 'bottom')).toEqual([])
  })
  it('分叉再合并：合并点开第二列，分支提交在第二列，汇合后回到一列', () => {
    // m 合并 (x, y)；x、y 都来自 a
    const g = gitGraph([{ hash: 'm', parents: ['x', 'y'] }, { hash: 'y', parents: ['a'] }, { hash: 'x', parents: ['a'] }, { hash: 'a', parents: [] }])
    expect(g.map((r) => r.col)).toEqual([0, 1, 0, 0])
    expect(g[0].lines.filter((l) => l.half === 'bottom').map((l) => [l.from, l.to])).toEqual([[0, 0], [0, 1]])
    // a 那一行：两条线从上面汇到节点
    expect(g[3].lines.filter((l) => l.half === 'top').map((l) => [l.from, l.to])).toEqual([[0, 0], [1, 0]])
    expect(g[3].width).toBe(2)
  })
})
