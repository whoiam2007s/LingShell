// AI 回复里代码块的按钮（复制 / 插入终端 / 执行）用到的纯逻辑。
import { stripHidden } from '@lingshell/shared'

// 能发到终端的语言：sh 一族 + 没写语言的；PowerShell / cmd 也给（本地终端可能就是它们，用户自己判断）
const SHELL_LANGS = new Set(['', 'bash', 'sh', 'shell', 'zsh', 'console', 'shellsession', 'terminal', 'powershell', 'pwsh', 'ps1', 'cmd', 'bat'])

/** react-markdown 给 code 元素的 className（language-xxx）→ 语言名（小写，没有 = ''） */
export const langOf = (className: unknown): string => {
  const cls = Array.isArray(className) ? className.join(' ') : String(className ?? '')
  return /(?:^|\s)language-([\w+-]+)/.exec(cls)?.[1]?.toLowerCase() ?? ''
}

export const isShellLang = (lang: string): boolean => SHELL_LANGS.has(lang)

/**
 * 代码块文本 → 要发到终端的命令：去掉末尾换行；所有非空行都以「$ 」提示符开头的（console 风格）去掉提示符
 * （混着输出行的不动——分不清哪行是命令；「# 」不当提示符：全是注释的块去掉 # 就成了命令）
 */
export function commandOf(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n')
  const prompt = /^\s*\$ /
  const body = lines.filter((l) => l.trim())
  return body.length && body.every((l) => prompt.test(l)) ? lines.map((l) => l.replace(prompt, '')).join('\n') : lines.join('\n')
}

/** 单行插入到提示符的内容：去掉隐藏 / 控制字符（不回车，不需要确认） */
export const insertText = (cmd: string): string => stripHidden(cmd)

/** 是否多行（多行插入走撰写栏，避免逐行立即执行） */
export const isMultiline = (cmd: string): boolean => cmd.split('\n').filter((l) => l.trim()).length > 1
