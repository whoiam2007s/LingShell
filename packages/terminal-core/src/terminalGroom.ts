// 终端输出净化 + 交互提示识别（exec_in_terminal 用）
//
// 为什么需要：命令输出里混着 TTY 控制序列和原地刷新帧——`\r` 覆盖、ANSI 颜色 / 擦行、
// 退格擦字、连续重复的进度行。原样交给模型既占 token 又难读，还会让人误判（一堆
// "Test Files 0 passed" 其实只是刷新中间帧）。

/** ANSI CSI / OSC / 单字符 ESC 序列 */
// eslint-disable-next-line no-control-regex -- 这里就是要匹配 ESC(0x1b) / BEL(0x07) 这些控制字符
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

/** 把 `a\rb\rc` 这种原地覆盖折成最终帧 `c`（模拟终端里同一行被反复改写） */
function foldCarriageReturn(line: string): string {
  if (!line.includes('\r')) return line
  const at = line.lastIndexOf('\r')
  return line.slice(at + 1)
}

/** 退格 `\b` 按「删掉前一个字符」处理（spinner 常用 `\b\b\b` 擦字） */
function applyBackspaces(text: string): string {
  if (!text.includes('\b')) return text
  const out: string[] = []
  for (const ch of text) {
    if (ch === '\b') out.pop()
    else out.push(ch)
  }
  return out.join('')
}

/** 连续完全相同的行折叠成一行 + (×N)，避免 "Waiting..." 刷几十遍 */
function foldRepeatedLines(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let prev: string | undefined
  let run = 0
  const flush = () => {
    if (prev === undefined || run <= 1) return
    out.pop()                       // 第一次出现时已经 push 过原文，这里替换成折叠后的写法
    out.push(`${prev}  (×${run})`)
  }
  for (const line of lines) {
    if (line === prev) { run++; continue }
    flush()
    out.push(line)
    prev = line
    run = 1
  }
  flush()
  return out.join('\n')
}

/**
 * 净化一段终端输出：去 ANSI / OSC、CRLF 归一、折叠 `\r` 覆盖帧、处理退格、
 * 清掉 NUL 等控制字符、折叠连续重复行。纯文本安全，可反复调用。
 */
export function groomOutput(text: string): string {
  if (!text) return text
  let s = text.replace(ANSI, '')
  s = s.replace(/\r\n/g, '\n')
  if (s.includes('\r')) s = s.split('\n').map(foldCarriageReturn).join('\n')
  s = applyBackspaces(s)
  // 控制字符：保留 \n(0a) \t(09)，其余（含 NUL、响铃、垂直制表）一律去掉
  // eslint-disable-next-line no-control-regex -- 这里就是要清掉 NUL / 响铃等控制字符
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
  return foldRepeatedLines(s)
}

/**
 * 「命令正在等用户输入」的提示特征（中英文）。只在输出末尾几行里找，
 * 并要求调用方另外满足「跑够久 + 静默够久」，避免把正常日志误判成等输入。
 */
const NEED_INPUT_PATTERNS: RegExp[] = [
  /\[[Yy]\/[Nn]\]/, /\([Yy]\/[Nn]\)/, /\[[Yy]es\/[Nn]o\]/, /\(yes\/no\)/i,
  /\[是\/否\]/, /（[Yy]\/[Nn]）/, /\(是\/否\)/, /[Yy]\/[Nn]\s*[?？]/,
  /password\s*[:：]\s*$/i, /passphrase\s*[:：]\s*$/i, /密码\s*[:：]\s*$/, /口令\s*[:：]\s*$/,
  /press\s+any\s+key/i, /按任意键/, /按回车键?继续/,
  /are\s+you\s+sure/i, /do\s+you\s+want\s+to\s+(continue|proceed|remove|delete|overwrite)/i,
  /是否(继续|确认|覆盖|删除)/, /您确定/, /确定要/, /确认继续/,
  /already\s+exists.*\?/i, /overwrite\b.*\?/i, /请输入[^\n]{0,16}[:：]\s*$/,
]

/** 命中就返回等输入的那行提示（给用户 / 模型看）；没命中返回 undefined */
export function detectNeedsInput(tail: string): string | undefined {
  if (!tail) return undefined
  const lines = tail.trimEnd().split('\n').slice(-3)
  const view = lines.join('\n')
  for (const re of NEED_INPUT_PATTERNS) {
    if (!re.test(view)) continue
    // 优先回最后一行非空内容（通常就是那句提示）
    const last = [...lines].reverse().find((l) => l.trim())?.trim() ?? ''
    return (last || view.trim()).slice(0, 200)
  }
  return undefined
}

/**
 * 去掉命令里引号包住的内容（判断危险命令前先过一遍）：
 * `grep "exit" 文件` 里的 exit 只是参数，不该当成会关终端的命令。
 */
export function stripQuotedText(command: string): string {
  let out = ''
  let quote: string | null = null
  for (const ch of command) {
    if (quote) {
      if (ch === quote) { quote = null; out += ' ' }
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    out += ch
  }
  return out
}
