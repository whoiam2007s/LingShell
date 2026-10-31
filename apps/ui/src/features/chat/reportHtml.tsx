import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getLocale } from '@lingshell/shared'

// Markdown 报告 → 自包含 HTML（内联样式，无外部资源），方便直接附进工单/邮件。
// 按需动态 import，不进首屏包
const CSS = `body{font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#222}
h1{font-size:22px}h2{font-size:18px;border-bottom:1px solid #ddd;padding-bottom:4px;margin-top:28px}h3{font-size:15px}
pre{background:#f6f8fa;padding:10px;overflow:auto;border-radius:4px;font-size:12px}code{font-family:Consolas,monospace}
table{border-collapse:collapse;font-size:12px;width:100%}th,td{border:1px solid #ddd;padding:4px 6px;text-align:left;vertical-align:top}th{background:#f6f8fa}
blockquote{margin:0;padding:0 12px;color:#555;border-left:3px solid #ddd}`

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

// 报告里工具输出用 <details> 折叠（见 shared/ai/report.ts）。react-markdown 不渲染原始 HTML、会转义成字面文本，
// 而放开原始 HTML 又会让命令输出里的标签/脚本生效 → 只把整行的这两种固定标签还原
// summary 文字随界面语言（shared/ai/report.ts 里 tr('输出') / tr('输出（失败）')），两种语言都认
const DETAILS_OPEN = /^&lt;details&gt;&lt;summary&gt;(输出(?:（失败）)?|Output(?: \(failed\))?)&lt;\/summary&gt;$/gm   // i18n-ignore 匹配报告固定标签
const DETAILS_CLOSE = /^&lt;\/details&gt;$/gm

export function markdownToHtml(title: string, md: string): string {
  const body = renderToStaticMarkup(<Markdown remarkPlugins={[remarkGfm]}>{md}</Markdown>)
    .replace(DETAILS_OPEN, '<details><summary>$1</summary>').replace(DETAILS_CLOSE, '</details>')
  return `<!DOCTYPE html>\n<html lang="${getLocale()}"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>\n`
}
