import { tr } from '@lingshell/shared'
import { parseIni, portOf, noUserWarning, type ParsedSessions } from './common.js'

// MobaXterm.ini（或导出的 .mxtsessions）里的 [Bookmarks] / [Bookmarks_N] 段：
//   SubRep=生产\Web      ← 文件夹（\ 分级）
//   ImgNum=41
//   web01=#109#0%10.0.0.1%22%root%%-1%-1%…#MobaFont%…
// 值按 # 分段：第 2 段是会话类型（109 = SSH），第 3 段按 % 分：[0]=标志 [1]=主机 [2]=端口 [3]=用户名
const SSH_TYPE = '109'

export function parseMobaXterm(text: string): ParsedSessions {
  const sessions: ParsedSessions['sessions'] = [], warnings: string[] = []
  for (const [sec, vals] of parseIni(text)) {
    if (!/^bookmarks(_\d+)?$/.test(sec)) continue
    const group = (vals.get('subrep') ?? '').split('\\').map((s) => s.trim()).filter(Boolean).join('/')
    for (const [rawName, v] of vals) {
      if (rawName === 'subrep' || rawName === 'imgnum') continue
      const segs = v.split('#')
      if (segs.length < 3) continue
      const name = originalCase(text, rawName)
      if (segs[1] !== SSH_TYPE) { warnings.push(tr('{name}：不是 SSH 会话，已跳过', { name })); continue }
      const f = segs[2].split('%')
      const host = f[1] ?? ''
      if (!host) { warnings.push(tr('{name}：没有主机地址，已跳过', { name })); continue }
      const w: string[] = []
      const username = f[3] ?? ''
      if (!username) w.push(tr(noUserWarning))
      sessions.push({ name, host, port: portOf(f[2], w), username, warnings: w, ...(group ? { group } : {}) })
    }
  }
  return { sessions, warnings }
}

// parseIni 把键转成了小写；会话名要原样显示，回原文里找（找不到就用小写的）
function originalCase(text: string, lower: string): string {
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('=')
    if (i > 0 && line.slice(0, i).trim().toLowerCase() === lower) return line.slice(0, i).trim()
  }
  return lower
}
