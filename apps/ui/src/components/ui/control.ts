// 表单控件共享样式：全站两档高度（sm=28px 紧凑 / md=32px 常规），深色底 + 聚焦 accent 边框。
export type ControlSize = 'sm' | 'md'

/** 外框：边框、背景、聚焦/禁用态（不含高度与内边距） */
export const CONTROL_BOX = 'rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] text-[var(--color-text-primary)] outline-none transition-colors placeholder:text-[var(--color-text-muted)] focus:border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)] focus-visible:border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)] disabled:cursor-not-allowed disabled:opacity-50'

/** 单行控件高度 + 字号 + 横向内边距 */
export const CONTROL_SIZE: Record<ControlSize, string> = {
  sm: 'h-7 px-2 text-[12px]',
  md: 'h-8 px-2.5 text-[12.5px]',
}

/** 下拉 / 候选面板 */
export const PANEL = 'z-[300] overflow-hidden rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-raised)] text-[12.5px] text-[var(--color-text-primary)] shadow-lg'
/** 面板里的一项（data-highlighted 由 Radix / 自建列表设置） */
export const PANEL_ITEM = 'relative flex cursor-default select-none items-center rounded py-1 pl-6 pr-2.5 outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[highlighted]:bg-[var(--color-bg-hover)] data-[highlighted]:text-[var(--color-text-primary)]'
