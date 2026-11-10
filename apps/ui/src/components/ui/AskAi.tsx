import { MessageCircleQuestion } from 'lucide-react'

// 「问 AI」在哪儿都该长一样：一个**蓝色问号气泡**。
// 各面板的按钮容器（小图标按钮 / 带文字的次要按钮 / 行内小链接）各自的尺寸和位置不同，
// 所以这里只统一「图标 + 颜色」，容器还是用各自的样式：
//
//   <button className={BTN}><AskAiIcon />{tr('问 AI')}</button>
//
// 颜色走 --color-ask（见 index.css）：暗色主题亮蓝、浅色主题深蓝，不跟各主题的 accent 走
// —— accent 在不同主题里是青绿 / 紫 / 黄，混在一起会让人以为「问 AI」是不同功能。
export const ASK_AI_COLOR = 'text-[var(--color-ask)]'
/** 按钮整体着色（文字 + 图标一起蓝） */
export const ASK_AI_BTN_COLOR = 'text-[var(--color-ask)]'

export function AskAiIcon({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return <MessageCircleQuestion className={`${className} shrink-0 ${ASK_AI_COLOR}`} />
}
