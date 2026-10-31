// 命令自动补全端到端（不起真 shell）：假 shell 输出 OSC 133 标记 + 行回显 → xterm 解析器（headless，与 UI 同一个）→
// ShellMarkTracker 判定停在提示符 → typedBeforeCursor 读输入 → matchCompletions → completionInsert 写回的字节再经「假 readline」回显，
// 核对最终输入行。UI 胶水见 apps/ui/src/features/terminals/pane/TerminalPane.tsx
import { describe, it, expect } from 'vitest'
import xtermHeadless from '@xterm/headless'
import type { IMarker } from '@xterm/headless'
import { COMPLETION_SNIPPETS, ShellMarkTracker, buildCompletionPool, completionInsert, isSecretPrompt, matchCompletions, onShellMarks, shouldComplete, typedBeforeCursor } from '@lingshell/shared'

const { Terminal } = xtermHeadless
type Pos = { m: IMarker; col: number }
const PROMPT = '\x1b]133;A\x07user@web:~$ \x1b]133;B\x07'

// 假 shell：维护一行输入，按 readline 的方式回显（可见字符原样、DEL 回退一格擦掉）
function fakeShell() {
  const t = new Terminal({ cols: 40, rows: 10, allowProposedApi: true })
  const tr = new ShellMarkTracker<Pos>({ onCommand: () => {}, onDrop: (p) => p.m.dispose() })
  onShellMarks(t, (m) => tr.feed(m, () => ({ m: t.registerMarker(0)!, col: t.buffer.active.cursorX })))
  let line = ''
  const flush = () => new Promise<void>((r) => t.write('', r))
  const out = (s: string) => t.write(s)
  const type = async (data: string) => {
    for (const ch of data) {
      if (ch === '\x7f') { if (line) { line = [...line].slice(0, -1).join(''); out('\b \b') } }
      else { line += ch; out(ch) }
    }
    await flush()
  }
  const input = () => {
    const b = t.buffer.active, st = tr.promptState()
    if (st.kind !== 'idle' || !st.input) return undefined
    return typedBeforeCursor(b, { line: st.input.m.line, col: st.input.col }, { line: b.baseY + b.cursorY, col: b.cursorX }, t.cols)
  }
  const cursorLine = () => { const b = t.buffer.active; return b.getLine(b.baseY + b.cursorY)!.translateToString(false, 0, b.cursorX) }
  return { t, tr, out, flush, type, input, cursorLine, get line() { return line } }
}

const pool = buildCompletionPool({
  history: [
    { command: 'systemctl status nginx', at: new Date().toISOString() },
    { command: 'systemctl status nginx', at: new Date().toISOString() },
    { command: 'journalctl -u nginx --since today', at: new Date().toISOString() },
  ],
  quick: [{ command: 'df -h', label: '查看磁盘' }],
  snippets: COMPLETION_SNIPPETS,
})

describe('命令补全（OSC 133 + xterm 解析器 + 假 readline）', () => {
  it('提示符后键入 → 读到输入 → 候选 → Tab 写入差额，输入行变成整条命令', async () => {
    const s = fakeShell()
    s.out(PROMPT); await s.type('systemctl st')
    expect(s.input()).toBe('systemctl st')
    const m = matchCompletions(pool, s.input()!)
    expect(m[0].item.text).toBe('systemctl status nginx')
    const bytes = completionInsert(s.input()!, m[0].item.text)
    expect(bytes).toBe('atus nginx')
    await s.type(bytes)
    expect(s.line).toBe('systemctl status nginx')
    expect(s.input()).toBe('systemctl status nginx')
    expect(matchCompletions(pool, s.input()!).map((x) => x.item.text)).not.toContain('systemctl status nginx')   // 敲完整了不再出
  })

  it('子串命中 → 退格删掉已输入的再写整条', async () => {
    const s = fakeShell()
    s.out(PROMPT); await s.type('nginx --s')
    const m = matchCompletions(pool, s.input()!)
    expect(m[0].item.text).toBe('journalctl -u nginx --since today')
    await s.type(completionInsert(s.input()!, m[0].item.text))
    expect(s.line).toBe('journalctl -u nginx --since today')
    expect(s.input()).toBe('journalctl -u nginx --since today')
  })

  it('输入很长软折行也能读全；空输入 / 只有空格不弹', async () => {
    const s = fakeShell()
    s.out(PROMPT); await s.type('   ')
    expect(shouldComplete(s.input())).toBe(false)
    await s.type('\x7f\x7f\x7fecho ' + 'x'.repeat(40))
    expect(s.input()).toBe('echo ' + 'x'.repeat(40))
  })

  it('回车后命令在跑（C 之后）不算提示符；密码提示被识别，不弹也不记历史', async () => {
    const s = fakeShell()
    s.out(PROMPT); await s.type('sudo ls')
    s.out('\r\n\x1b]133;C\x07[sudo] password for user: '); await s.flush()
    expect(s.tr.promptState().kind).toBe('busy')
    expect(s.input()).toBeUndefined()
    expect(isSecretPrompt(s.cursorLine())).toBe(true)
    // 命令结束、新提示符：又能补全
    s.out('\r\nfile1\r\n\x1b]133;D;0\x07' + PROMPT); await s.type('df')
    expect(s.input()).toBe('df')
    expect(isSecretPrompt(s.cursorLine())).toBe(false)
    expect(matchCompletions(pool, 'df')[0].item).toMatchObject({ text: 'df -h', kind: 'quick' })
  })

  it('光标左移到输入中间（编辑中）不弹', async () => {
    const s = fakeShell()
    s.out(PROMPT); await s.type('docker ps')
    s.out('\x1b[3D'); await s.flush()   // 光标左移 3 格
    expect(s.input()).toBeUndefined()
  })
})
