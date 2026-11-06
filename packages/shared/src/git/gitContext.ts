// i18n-ignore-file  本文件产出的是给模型读的仓库上下文纯文本（同 buildCommitPrompt），不进界面词表
// 「发送到对话」的 git 上下文：仓库状态 + 变更清单 + 最近提交 + 工作区 diff。
// 纯函数，便于单测；内容给模型读，所以是纯文本（不进 i18n 词表，同 buildCommitPrompt）。
import { GIT_PROMPT_DIFF_MAX, groupGitFiles, gitCodeLabel } from './gitStatus.js'
import type { GitFile } from './gitStatus.js'

export interface GitContextInput {
  root: string
  branch: string
  detached?: boolean
  ahead?: number
  behind?: number
  /** 进行中的操作：merge / rebase / cherry-pick 等 */
  progress?: string | null
  files: GitFile[]
  commits?: { hash: string; subject: string }[]
  /** 已清洗的工作区 diff（cleanGitDiff 的输出） */
  diff?: string
}

const MAX_LIST_PER_GROUP = 30   // 每组最多列这么多文件（运维仓库动辄上百个改动）

const groupLine = (label: string, files: GitFile[]): string[] => {
  if (!files.length) return []
  const shown = files.slice(0, MAX_LIST_PER_GROUP)
  const out = [`${label}（${files.length}）：`]
  for (const f of shown) out.push(`  - ${f.path}${f.orig ? ` ← ${f.orig}` : ''}  [${gitCodeLabel(f.x)}/${gitCodeLabel(f.y)}]`)
  if (files.length > shown.length) out.push(`  … 还有 ${files.length - shown.length} 个`)
  return out
}

/** 拼成一段可读的仓库上下文。diff 超长按 GIT_PROMPT_DIFF_MAX 截断并注明省略量 */
export function gitContextText(o: GitContextInput): string {
  const g = groupGitFiles(o.files)
  const lines: string[] = [
    `仓库：${o.root}`,
    `分支：${o.detached ? '（分离头指针）' : o.branch || '（未知）'}`,
  ]
  if (o.ahead || o.behind) lines.push(`与上游：领先 ${o.ahead ?? 0}，落后 ${o.behind ?? 0}`)
  if (o.progress) lines.push(`进行中的操作：${o.progress}`)
  lines.push(`变更文件：共 ${o.files.length} 个`)
  lines.push(...groupLine('已暂存', g.staged))
  lines.push(...groupLine('未暂存', g.unstaged))
  lines.push(...groupLine('未跟踪', g.untracked))
  lines.push(...groupLine('冲突', g.conflict))

  if (o.commits?.length) {
    lines.push('最近提交：')
    for (const c of o.commits) lines.push(`  - ${c.hash.slice(0, 7)} ${c.subject}`)
  }

  if (o.diff?.trim()) {
    const d = o.diff.length > GIT_PROMPT_DIFF_MAX
      ? `${o.diff.slice(0, GIT_PROMPT_DIFF_MAX)}\n…（diff 过长，后面省略 ${o.diff.length - GIT_PROMPT_DIFF_MAX} 字）`
      : o.diff
    lines.push('', '工作区 diff：', '```diff', d.trimEnd(), '```')
  } else if (o.files.length) {
    lines.push('', '（没有可显示的文本 diff：可能是二进制文件或改动都在未跟踪文件里）')
  }
  return lines.join('\n')
}
