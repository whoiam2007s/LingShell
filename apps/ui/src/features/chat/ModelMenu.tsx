import type { ModelProfile } from '@lingshell/shared'

/**
 * 会话所用模型 + 切换回调（ChatPanel 的 SessionModel 基于这个类型）。
 * 面板 UI 已移到 ModelPicker.tsx（列表 + 推理等级粒子滑杆 + 查看用量），这里只留契约。
 */
export interface ModelMenuProps { profiles: ModelProfile[]; current?: ModelProfile; defaultId?: string; onPick: (id: string) => void; onManage?: () => void }
