import { describe, it, expect } from 'vitest'
import {
  buildCommitPrompt, cleanGitDiff, gitAuditCommand, gitAuditLabel, gitConflictPrompt, gitDiffCommand, gitStageCommand, gitStatusCommand,
  groupGitFiles, normalizeCommitMsg, parseGitStatus, splitGitRc, GIT_PROMPT_DIFF_MAX,
} from './gitStatus.js'

const N = '\0'
const out = (recs: string[], extra = '') =>
  `@@git:root:/home/u/proj\n${extra}@@git:status\n${recs.map((r) => r + N).join('')}\n@@git:rc:0\n`

describe('parseGitStatus', () => {
  it('分支 / 上游 / 领先落后 + 各类条目（含空格路径、重命名、冲突、未跟踪）', () => {
    const r = parseGitStatus(out([
      '# branch.oid 1234567890abcdef', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1',
      '1 M. N... 100644 100644 100644 aaa bbb src/a.ts',
      '1 .M N... 100644 100644 100644 aaa bbb dir with space/b c.md',
      '1 MM N... 100644 100644 100644 aaa bbb both.txt',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new name.ts', 'old name.ts',
      'u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.js',
      '? 新文件.txt',
      '! ignored.log',
    ], '@@git:merging\n'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const s = r.status
    expect([s.root, s.branch, s.upstream, s.ahead, s.behind, s.merging, s.detached]).toEqual(['/home/u/proj', 'main', 'origin/main', 2, 1, true, false])
    expect(s.oid).toBe('1234567890abcdef')
    expect(s.files.map((f) => [f.path, f.x, f.y, f.orig ?? '', f.conflict, f.untracked])).toEqual([
      ['src/a.ts', 'M', '.', '', false, false],
      ['dir with space/b c.md', '.', 'M', '', false, false],
      ['both.txt', 'M', 'M', '', false, false],
      ['new name.ts', 'R', '.', 'old name.ts', false, false],
      ['conflict.js', 'U', 'U', '', true, false],
      ['新文件.txt', '?', '?', '', false, true],
    ])
    const g = groupGitFiles(s.files)
    expect(g.staged.map((f) => f.path)).toEqual(['src/a.ts', 'both.txt', 'new name.ts'])
    expect(g.unstaged.map((f) => f.path)).toEqual(['dir with space/b c.md', 'both.txt'])
    expect(g.conflict.map((f) => f.path)).toEqual(['conflict.js'])
    expect(g.untracked.map((f) => f.path)).toEqual(['新文件.txt'])
  })
  it('空仓库（initial）/ 分离头指针 / 干净', () => {
    const a = parseGitStatus(out(['# branch.oid (initial)', '# branch.head master']))
    expect(a.ok && [a.status.oid, a.status.branch, a.status.files.length]).toEqual([undefined, 'master', 0])
    const b = parseGitStatus(out(['# branch.oid abc', '# branch.head (detached)']))
    expect(b.ok && b.status.detached).toBe(true)
  })
  it('目录不存在 / 没有 git / 不在仓库 / 状态失败', () => {
    expect(parseGitStatus('@@git:nodir\n')).toMatchObject({ ok: false, problem: 'nodir' })
    expect(parseGitStatus('@@git:nogit\n')).toMatchObject({ ok: false, problem: 'nogit' })
    expect(parseGitStatus('@@git:norepo:fatal: not a git repository\n')).toMatchObject({ ok: false, problem: 'norepo' })
    // 把 git 的原因带出来（safe.directory / 权限问题不能都显示成「不在仓库里」）
    const nr = parseGitStatus('@@git:norepo:fatal: detected dubious ownership in repository\n')
    expect(nr).toMatchObject({ ok: false, problem: 'norepo' })
    expect(nr.ok === false && nr.message).toContain('dubious ownership')
    expect(parseGitStatus('@@git:root:/x\n@@git:status\n\n@@git:rc:128\n')).toMatchObject({ ok: false, problem: 'error' })
    // 没有 rc 标记 = 输出被截断，给出可操作的提示
    const cut = parseGitStatus('@@git:root:/x\n@@git:status\n?? many\n')
    expect(cut).toMatchObject({ ok: false, problem: 'error' })
    expect(cut.ok === false && cut.message).toContain('截断')
    expect(parseGitStatus('garbage')).toMatchObject({ ok: false, problem: 'error' })
  })
  it('CRLF 输出（Windows 远端 / 本机）也能认', () => {
    const r = parseGitStatus(out(['# branch.head dev', '? a.txt']).replace(/\n/g, '\r\n'))
    expect(r.ok && r.status.files[0].path).toBe('a.txt')
  })
})

describe('命令构造', () => {
  it('路径单引号包起来；含换行 / NUL 拒绝；按字面 pathspec 处理', () => {
    expect(gitStatusCommand("/tmp/it's")).toContain(`cd '/tmp/it'\\''s'`)
    expect(gitStatusCommand('/r')).toContain('GIT_LITERAL_PATHSPECS=1')
    expect(gitDiffCommand('/r', 'a b.ts', 'staged')).toContain(`diff --no-ext-diff --cached -- 'a b.ts'`)
    expect(gitDiffCommand('/r', 'n.ts', 'untracked')).toContain(`--no-index -- /dev/null 'n.ts'`)
    expect(gitStageCommand('/r', ['x', 'y z'], true)).toContain(`git add -A -- 'x' 'y z'`)
    expect(gitStageCommand('/r', ['x'], false)).toContain('restore --staged')
    expect(() => gitStageCommand('/r', ['a\nb'], true)).toThrow('非法的路径')
    expect(() => gitStageCommand('/r', [], true)).toThrow()
    expect(() => gitDiffCommand('/r', 'a\0', 'work')).toThrow()
  })
  it('splitGitRc', () => {
    expect(splitGitRc('ok\n\n@@git:rc:0\n')).toEqual({ rc: 0, text: 'ok' })
    expect(splitGitRc('fatal: x\n@@git:rc:128')).toEqual({ rc: 128, text: 'fatal: x' })
    expect(splitGitRc('@@git:nodir\n').problem).toBe('nodir')
  })
})

describe('cleanGitDiff', () => {
  it('去掉文件头，只留 hunk；二进制给提示', () => {
    const d = cleanGitDiff('diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n-b\n+c\ndiff --git a/p.png b/p.png\nBinary files a/p.png and b/p.png differ\n')
    expect(d).toBe('@@ -1,2 +1,2 @@\n a\n-b\n+c\n（二进制文件，不显示内容差异）')
  })
  it('合并冲突的 combined diff 压成一列', () => {
    const d = cleanGitDiff('diff --cc c.js\nindex 1,2..0\n--- a/c.js\n+++ b/c.js\n@@@ -1,1 -1,1 +1,5 @@@\n++<<<<<<< HEAD\n +ours\n++=======\n+ theirs\n++>>>>>>> dev\n  same\n')
    expect(d.split('\n')).toEqual(['@@ -1 +1 @@', '+<<<<<<< HEAD', '+ours', '+=======', '+theirs', '+>>>>>>> dev', ' same'])
  })
})

describe('提交说明', () => {
  it('提示词带统计和截断后的 diff', () => {
    const p = buildCommitPrompt(' a.ts | 2 +-', 'x'.repeat(GIT_PROMPT_DIFF_MAX + 50), 'main')
    expect(p.user).toContain('分支：main')
    expect(p.user).toContain('后面省略 50 字')
    expect(p.system).toContain('conventional commit')
  })
  it('去思考块 / 代码块 / 引号', () => {
    expect(normalizeCommitMsg('<think>嗯</think>\n```\nfeat: 加 Git 助手\n\n- 改动列表\n```')).toBe('feat: 加 Git 助手\n\n- 改动列表')
    expect(normalizeCommitMsg('"fix: 修正 diff"')).toBe('fix: 修正 diff')
  })
  it('冲突提示 / 执行记录', () => {
    const t = gitConflictPrompt({ terminalTitle: 'dev', root: '/r', branch: 'main', files: ['a.js', 'b.js'] })
    expect(t).toContain('- `a.js`')
    expect(t).toContain('不要执行 git commit')
    expect(gitAuditCommand('commit', [], "feat: it's\nbody")).toBe(`git commit -m 'feat: it'\\''s'`)
    expect(gitAuditCommand('stage', ['1', '2', '3', '4', '5', '6'], '')).toContain('共 6 个')
    expect(gitAuditLabel('git_commit')).toBe('Git 提交')
    expect(gitAuditLabel('docker_stop')).toBeUndefined()
  })
})
