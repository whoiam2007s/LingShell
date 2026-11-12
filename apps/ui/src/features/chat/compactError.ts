import { tr } from '@lingshell/shared'

/**
 * 上下文压缩失败的原因转成人话。
 * dsh 压缩引擎抛的是英文 + token 数字（如 "summary is not smaller than the shadowed content (3172 …)"），
 * 直接显示用户读不懂、也不知道下一步该做什么。认识的原因翻成中文并给建议；不认识的保留原文，别吞掉信息。
 */
export function compactErrorText(raw?: string): string {
  const s = (raw ?? '').trim()
  if (!s) return tr('压缩失败，稍后再试一次')
  // 摘要不比被压掉的原文短：说明能压的冗余已经没了（常见于刚压缩过 / 历史本来就很短的会话）
  if (/summary is not smaller than the shadowed content/i.test(s))
    return tr('较早的对话已经压不动了（摘要不会比原文更短）。建议新开一个会话，或从某条消息「从这里分叉」继续')
  if (/surface changed/i.test(s))
    return tr('压缩时对话又变了（有新消息进来），再点一次压缩就好')
  if (/not idle|is busy|already running|in progress|turn.*running/i.test(s))
    return tr('本轮还在跑，等结束再点一次压缩')
  if (/timed? ?out|etimedout/i.test(s))
    return tr('压缩超时（历史太长或模型响应慢），可以再点一次；反复超时建议新开一个会话')
  if (/abort|cancel/i.test(s))
    return tr('压缩被中断，再点一次就好')
  // 不认识的原因：保留原文（方便复制给开发者），前面加一句说明
  return tr('压缩失败（可复制给开发者）：{error}', { error: s })
}
