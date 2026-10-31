// 终端里的「文件:行号」与常见语言堆栈行识别（纯函数）：TerminalPane 注册 xterm link provider 用，
// 主进程按终端 cwd 解析相对路径后用编辑器跳到对应行（见 desktop/main/files/fileLinksIpc.ts）。

export interface FileLink {
  start: number      // 在行文本里的起止下标（含 / 不含），即下划线范围
  end: number
  path: string
  line: number
  col?: number
}

/** 渲染层发给主进程的打开请求；how：SSH 终端用哪种方式（下载到本地编辑器 / VS Code Remote） */
export interface FileLinkReq { path: string; line: number; col?: number; cwd?: string; how?: 'download' | 'vscode' }

// 源码 / 配置常见扩展名（只认这些，免得把 example.com:443 这类当成文件）
import { tk } from '../i18n/i18n.js'

const EXT = 'tsx?|jsx?|mjs|cjs|mts|cts|vue|svelte|astro|py|pyw|pyi|rb|go|rs|java|kts?|scala|groovy|gradle|c|h|cc|cpp|cxx|hpp|hh|hxx|cs|fs|vb|php|pl|pm|swift|m|mm|lua|sh|bash|zsh|ps1|psm1|exs?|erl|hrl|hs|ml|mli|clj|cljs|dart|r|jl|zig|nim|sql|json|jsonc|ya?ml|toml|xml|html?|css|scss|sass|less|ini|conf|cfg|properties|env|md|txt|log|tf|proto|graphql|gql|cmake|mk|bzl|ejs|hbs|twig|jinja2?|j2|ipynb'
const NAMES = 'Dockerfile|Makefile|Jenkinsfile|Vagrantfile|Gemfile|Rakefile|CMakeLists\\.txt'
// 路径段：不含空白、引号、括号、冒号等分隔符（中文目录名可以）
const SEG = `[^\\s:"'()<>\\[\\]{}|,;*?\\\\/：，。；（）【】「」]`   // i18n-ignore 正则
const PATH = `(?:[A-Za-z]:[\\\\/]|\\.{1,2}[\\\\/]|~/|/)?(?:${SEG}+[\\\\/])*(?:${SEG}*\\.(?:${EXT})|${NAMES})`

// 顺序 = 优先级：先认整句格式（Python / PHP / Perl），再认括号式（tsc / MSBuild），最后通用的 path:line:col
const PATTERNS: RegExp[] = [
  /File "(?<p>[^"]+)", line (?<l>\d+)/g,                                 // Python traceback
  new RegExp(`(?<p>${PATH}) on line (?<l>\\d+)`, 'g'),                    // PHP: in /x.php on line 12
  new RegExp(`(?<p>${PATH}) line (?<l>\\d+)\\b`, 'g'),                    // Perl: at x.pl line 12.
  new RegExp(`(?<p>${PATH})\\((?<l>\\d+)(?:,(?<c>\\d+))?\\)`, 'g'),       // tsc / MSBuild / C#: a.ts(42,7)
  new RegExp(`(?<p>${PATH}):(?<l>\\d+)(?::(?<c>\\d+))?`, 'g'),            // 通用：gcc / Node / Go / Rust / Java / pytest …
  // 没扩展名的配置文件（/etc/ssh/sshd_config:40、~/.bashrc:12，grep -Hn 的输出）：必须以 / ~/ ./ 开头且带一层以上目录，免得把 example.com:443 当文件
  new RegExp(`(?<p>(?:/|~/|\\.{1,2}/)(?:${SEG}+/)+${SEG}+|~/${SEG}+):(?<l>\\d+)(?::(?<c>\\d+))?`, 'g'),
]
// URL（file:// 除外）里的不算：http://x.com/a.js:10 交给 web-links
const URL_RE = /\b(?!file:)[a-z][\w+.-]*:\/\/\S+/gi

export function findFileLinks(text: string): FileLink[] {
  const urls = [...text.matchAll(URL_RE)].map((m) => [m.index!, m.index! + m[0].length] as const)
  const taken: [number, number][] = []
  const overlaps = (s: number, e: number, spans: readonly (readonly [number, number])[]) => spans.some(([a, b]) => s < b && e > a)
  const out: FileLink[] = []
  for (const re of PATTERNS) {
    re.lastIndex = 0
    for (const m of text.matchAll(re)) {
      const g = m.groups!
      const start = m.index!, end = start + m[0].length
      const line = Number(g.l)
      if (!g.p || !line || overlaps(start, end, urls) || overlaps(start, end, taken)) continue
      // 前一个字符是路径字符：说明匹配从词中间开始（如 abc:12 里的 bc），跳过
      if (start > 0 && /[\w.\-/\\]/.test(text[start - 1]) && !/^[A-Za-z]:|^\//.test(g.p)) continue
      taken.push([start, end])
      out.push({ start, end, path: g.p.replace(/^file:\/\/\/?/, ''), line, ...(g.c ? { col: Number(g.c) } : {}) })
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

/** 绝对路径？（posix /x、~/x、Windows C:\x 或 C:/x） */
export const isAbsLinkPath = (p: string): boolean => /^(?:\/|~\/|[A-Za-z]:[\\/])/.test(p)

/** 按 cwd 解析相对路径（只做 . / .. 归一，不访问文件系统）；win = 本地 Windows 路径（结果用 \） */
export function resolveLinkPath(p: string, cwd: string | undefined, win = false): string {
  const sep = win ? '\\' : '/'
  const base = isAbsLinkPath(p) || !cwd ? p : `${cwd.replace(/[\\/]+$/, '')}/${p}`
  const m = /^([A-Za-z]:)?([\\/])?/.exec(base)!
  const head = (m[1] ?? '') + (m[2] ? sep : '')
  const parts: string[] = []
  for (const s of base.slice(m[0].length).split(/[\\/]+/)) {
    if (!s || s === '.') continue
    if (s === '..') { if (parts.length && parts[parts.length - 1] !== '..') parts.pop(); else if (!head) parts.push('..') }
    else parts.push(s)
  }
  return head + parts.join(sep)
}

/** 本地 Git Bash 的 /c/x 路径 → C:\x；其它原样 */
export const msysToWinPath = (p: string): string => {
  const m = /^\/([A-Za-z])(?:\/(.*))?$/.exec(p)
  return m ? `${m[1].toUpperCase()}:\\${(m[2] ?? '').replace(/\//g, '\\')}` : p
}

/** 经命令行（shell）传给编辑器 / VS Code 的路径不能带这些字符（终端输出里的文本不可信，防注入） */
export const unsafeShellPath = (p: string): boolean => /["`$%!^&|<>\r\n]/.test(p)

/** 「跳到行」的参数模板预设（{file} {line} {col}）；按编辑器命令名自动识别 */
export const EDITOR_GOTO_PRESETS: { id: string; label: string; args: string }[] = [
  { id: 'vscode', label: tk('VS Code / Cursor（code -g）'), args: '-g "{file}:{line}:{col}"' },
  { id: 'jetbrains', label: tk('JetBrains（IDEA / PyCharm / GoLand…）'), args: '--line {line} "{file}"' },
  { id: 'npp', label: 'Notepad++', args: '-n{line} -c{col} "{file}"' },
  { id: 'sublime', label: 'Sublime Text', args: '"{file}:{line}:{col}"' },
]

/** 编辑器命令 / 路径 → 预设 id（认不出返回 undefined：只打开文件、不跳行） */
export function editorKind(editor: string): string | undefined {
  // 程序部分：引号包住的整段 / 带 .exe 等后缀的路径（可含空格）/ 第一个词
  const s = editor.trim(), q = /^"([^"]+)"/.exec(s), ext = s.search(/\.(exe|cmd|bat)\b/i)
  const prog = q ? q[1] : ext > 0 ? s.slice(0, ext + 4) : s.split(/\s+/)[0]
  const b = prog.split(/[\\/]/).pop()!.toLowerCase().replace(/\.(exe|cmd|bat)$/, '')
  if (/^(code|code-insiders|cursor|codium|vscodium|windsurf|trae)$/.test(b)) return 'vscode'
  if (/^(idea|idea64|pycharm|pycharm64|webstorm|webstorm64|goland|goland64|clion|clion64|rider|rider64|phpstorm|phpstorm64|rubymine|rubymine64|studio|studio64|datagrip|datagrip64)$/.test(b)) return 'jetbrains'
  if (b === 'notepad++') return 'npp'
  if (b === 'subl' || b === 'sublime_text') return 'sublime'
  return undefined
}

/** 本次用的参数模板：设置里自填的优先；否则按编辑器认预设；留空编辑器默认按 VS Code（code -g） */
export function gotoArgsOf(editor: string, custom?: string): string | undefined {
  if (custom?.trim()) return custom.trim()
  const k = editor.trim() ? editorKind(editor) : 'vscode'
  return EDITOR_GOTO_PRESETS.find((p) => p.id === k)?.args
}

/** 模板填值，并按空白切成参数（双引号包住的是一个参数，引号去掉）。直接起进程用 */
export function fillGotoArgs(tpl: string, file: string, line: number, col = 1): string[] {
  const out: string[] = []
  for (const m of tpl.matchAll(/"([^"]*)"|(\S+)/g)) {
    out.push((m[1] ?? m[2]).replace(/\{file\}/g, file).replace(/\{line\}/g, String(line)).replace(/\{col\}/g, String(col)))
  }
  return out
}
