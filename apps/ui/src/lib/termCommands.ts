// 终端里每条用户命令跑完（OSC 133 C→D，见 shared/terminal/shellMarks.ts）的通知：TerminalPane 发，运维手册视图等着拿退出码和耗时。
// 组件树隔得远，用模块级订阅直连（同 activeTerminal.ts）
export interface TermCommandDone { terminalId: string; text: string; exitCode?: number; durationMs: number; at: number }

const subs = new Set<(c: TermCommandDone) => void>()
export function emitTermCommand(c: TermCommandDone): void { subs.forEach((f) => f(c)) }
export function onTermCommand(h: (c: TermCommandDone) => void): () => void { subs.add(h); return () => { subs.delete(h) } }

// 终端停在哪：idle = 在提示符；busy = 有命令在跑；unknown = 还没见过提示符（如渲染页刚重载、非 bash），这时第一条命令收不到结束标记
type PromptKind = 'idle' | 'busy' | 'unknown'
const probes = new Map<string, () => PromptKind>()
export function registerPromptProbe(terminalId: string, f: () => PromptKind): () => void { probes.set(terminalId, f); return () => { if (probes.get(terminalId) === f) probes.delete(terminalId) } }
export const promptStateOf = (terminalId: string): PromptKind | undefined => probes.get(terminalId)?.()

/** 等这个终端的下一条命令跑完（signal 中止 → reject('aborted')） */
export function nextTermCommand(terminalId: string, signal?: AbortSignal): Promise<TermCommandDone> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return }
    const off = onTermCommand((c) => { if (c.terminalId === terminalId) { off(); signal?.removeEventListener('abort', ab); resolve(c) } })
    const ab = () => { off(); reject(new Error('aborted')) }
    signal?.addEventListener('abort', ab, { once: true })
  })
}
