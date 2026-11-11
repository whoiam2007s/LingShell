import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getLocale, tr } from '@lingshell/shared'

// Markdown 报告 → 自包含 HTML（内联样式，无外部资源），方便直接附进工单/邮件。
// 按需动态 import，不进首屏包
const CSS = `body{font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#222}
h1{font-size:22px}h2{font-size:18px;border-bottom:1px solid #ddd;padding-bottom:4px;margin-top:28px;scroll-margin-top:12px}h3{font-size:15px}
pre{background:#f6f8fa;padding:10px;overflow:auto;border-radius:4px;font-size:12px}code{font-family:Consolas,monospace}
table{border-collapse:collapse;font-size:12px;width:100%}th,td{border:1px solid #ddd;padding:4px 6px;text-align:left;vertical-align:top}th{background:#f6f8fa}
blockquote{margin:0;padding:0 12px;color:#555;border-left:3px solid #ddd}
.toc{background:#f6f8fa;border:1px solid #e1e4e8;border-radius:4px;padding:10px 14px;margin-bottom:20px;font-size:13px}
.toc-h{font-weight:600;margin-bottom:4px}.toc ol{margin:0;padding-left:20px}.toc a{color:#0366d6;text-decoration:none}.toc a:hover{text-decoration:underline}`

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

// 报告里工具输出用 <details> 折叠（见 shared/ai/report.ts）。react-markdown 不渲染原始 HTML、会转义成字面文本，
// 而放开原始 HTML 又会让命令输出里的标签/脚本生效 → 只把整行的这两种固定标签还原
// summary 文字随界面语言（shared/ai/report.ts 里 tr('输出') / tr('输出（失败）')），两种语言都认
const DETAILS_OPEN = /^&lt;details&gt;&lt;summary&gt;(输出(?:（失败）)?|Output(?: \(failed\))?)&lt;\/summary&gt;$/gm   // i18n-ignore 匹配报告固定标签
const DETAILS_CLOSE = /^&lt;\/details&gt;$/gm

export function markdownToHtml(title: string, md: string): string {
  const body = renderToStaticMarkup(<Markdown remarkPlugins={[remarkGfm]}>{md}</Markdown>)
    .replace(DETAILS_OPEN, '<details><summary>$1</summary>').replace(DETAILS_CLOSE, '</details>')
  // 目录：从渲染结果里取二级标题（顺序即出现顺序），同时给每个 <h2> 补锚点；标题少于 2 个不放目录
  const heads: string[] = []
  const linked = body.replace(/<h2>(.*?)<\/h2>/g, (_m, inner: string) => {
    heads.push(inner)
    return `<h2 id="sec-${heads.length}">${inner}</h2>`
  })
  const toc = heads.length > 1
    ? `<nav class="toc"><div class="toc-h">${esc(tr('本页目录'))}</div><ol>${heads.map((h, i) => `<li><a href="#sec-${i + 1}">${h}</a></li>`).join('')}</ol></nav>`
    : ''
  return `<!DOCTYPE html>\n<html lang="${getLocale()}"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head><body>${toc}${linked}</body></html>\n`
}
