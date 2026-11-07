// git → 对话：把当前仓库状态（分支 / 变更清单 / 最近提交 / 工作区 diff）作为上下文放进输入框，
// 由用户补上"要 AI 做什么"再发。通道复用 lib/chatBus 的 pushChatContext（与「问 AI：上次怎么解决」同一条）。
import { useState } from 'react'
import { MessageSquarePlus, Loader2 } from 'lucide-react'
import { baseName, cleanGitDiff, gitContextText, groupGitFiles, tr, type GitStatus, type TerminalInfo } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { pushChatContext } from '../../lib/chatBus.js'

const MAX_DIFF_FILES = 5   // 只取前几个有改动的文件的 diff：避免一次拉几十条，上下文也不该塞满

export function GitSendToChat({ term, status, onDone, className }: {
  term: TerminalInfo
  status: GitStatus
  onDone?: (msg: string) => void
  className?: string
}) {
  const [busy, setBusy] = useState(false)

  const run = async () => {
    if (busy) return
    setBusy(true)
    try {
      const g = groupGitFiles(status.files)
      const targets = [...g.staged, ...g.unstaged].slice(0, MAX_DIFF_FILES)
      const parts: string[] = []
      for (const f of targets) {
        try {
          // 工作区有改动就看工作区，否则看暂存区
          const raw = await client.git.diff(term.id, status.root, f.path, f.y !== '.' ? 'work' : 'staged')
          const d = cleanGitDiff(raw)
          if (d.trim()) parts.push(`# ${f.path}\n${d}`)
        } catch { /* 单个文件读失败（二进制 / 权限）就跳过，不影响整体 */ }
      }
      let commits: { hash: string; subject: string }[] = []
      try {
        commits = (await client.git.log(term.id, status.root, { limit: 5 })).map((c) => ({ hash: c.hash, subject: c.subject }))
      } catch { /* 空仓库没有提交 */ }

      const text = gitContextText({
        root: status.root,
        branch: status.branch,
        detached: status.detached,
        ahead: status.ahead,
        behind: status.behind,
        progress: status.merging ? 'merge（正在合并）' : undefined,   // i18n-ignore 给模型读的上下文
        files: status.files,
        commits,
        diff: parts.join('\n\n'),
      })
      pushChatContext({ chips: [{ ctx: 'git', name: `${baseName(status.root) || status.root}@${status.branch || 'HEAD'}`, text }] })
      onDone?.(tr('已放入对话输入框'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      data-git-send-to-chat
      disabled={busy}
      onClick={() => void run()}
      title={tr('把当前仓库状态（分支、变更清单、最近提交、工作区 diff）放进对话输入框，再补上你要 AI 做什么')}
      className={className}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageSquarePlus className="h-3.5 w-3.5" />}
    </button>
  )
}
