// 历史图片裁剪：只保留最近 N 条消息里的图片原图，更早的在「发给模型的请求」里替换成
// 占位文字（占位里带附件 id 与本地路径，模型可以自己用 read_image 读回来）。
//
// 机制与官方 @deepseek-ai/dsh-compaction-image-offload 相同：往会话 append 一条
// `image/offload` 决策，再由 message projection 在构造请求时把对应图片块标记成 offloaded。
// 区别在**触发时机与策略**：
//   - 官方只在「适配器报请求超预算 / 压缩」时被动卸载最老的图；
//   - 我们在每次发送前主动按「保留最近 N 条消息」裁剪；
//   - 超预算时**不自动删图**（只由 relay 翻译成提示，让用户自己决定）。
//
// 为什么不改原始消息：offload 只是投影，历史与界面展示都不变（UI 照常显示缩略图）。
// 不注册官方插件，是因为它会响应 IMAGE_OFFLOAD_REQUIRED 自动卸载——用户要求超限时
// 必须让他知道，不能静默删图。

const OFFLOAD_EVENT = 'image/offload'

/** 保留最近几条（含图片的）消息原图，更早的卸载 */
export const IMAGE_KEEP_MESSAGES = 3

interface AnySession {
  surface: { nodes: readonly number[] }
  eventAt(seq: number): any
  deriveEventMessage(event: any): any
  append(type: string, data: unknown): unknown
}

/** 把一条消息里指定下标的图片块标记为 offloaded（不可变：只替换改动的块） */
export function offloadMessageImages(message: any, indexes: readonly number[]): any {
  let imageIndex = 0
  let selected = 0
  const visit = (blocks: any[]): any[] => {
    let next: any[] | undefined
    for (const [i, block] of blocks.entries()) {
      let projected = block
      if (block?.type === 'image') {
        if (imageIndex === indexes[selected]) {
          if (block.offloaded === true) throw new Error(`image/offload: image index ${imageIndex} is already offloaded`)
          projected = { ...block, offloaded: true }
          selected += 1
        }
        imageIndex += 1
      }
      if (projected !== block) next ??= blocks.slice(0, i)
      next?.push(projected)
    }
    return next ?? blocks
  }
  const content = visit(message.content)
  if (selected !== indexes.length) throw new Error(`image/offload: image index ${indexes[selected]} does not exist`)
  return { ...message, content }
}

/** 会话消息投影：处理 image/offload 决策（格式与官方插件一致，事件类型是 dsh 内置的） */
export const imagePruneProjection = {
  type: OFFLOAD_EVENT,
  project(event: any, context: any): Map<number, any> {
    const data = event?.data
    if (!data || !Array.isArray(data.targets) || data.targets.length === 0) {
      throw new Error('image/offload: data must contain a nonempty targets array')
    }
    const messages = new Map<number, any>()
    for (const target of data.targets) {
      const seq = target?.seq
      const indexes = target?.imageIndexes
      if (typeof seq !== 'number' || !Array.isArray(indexes) || indexes.length === 0) {
        throw new Error('image/offload: each target needs a seq and nonempty imageIndexes')
      }
      const source = context.events[seq - context.baseSeq]
      if (!source || (source.type !== 'user/message' && source.type !== 'tool/result')) {
        throw new Error(`image/offload: target seq ${seq} must be user/message or tool/result`)
      }
      const message = context.messages.get(seq) ?? (source.type === 'user/message' ? source.data : source.data.message)
      messages.set(seq, offloadMessageImages(message, indexes))
    }
    return messages
  },
}

/** 一条消息里还没卸载的图片下标 */
function pendingImageIndexes(message: any): number[] {
  const out: number[] = []
  let index = 0
  for (const block of message?.content ?? []) {
    if (block?.type !== 'image') continue
    if (block.offloaded !== true) out.push(index)
    index += 1
  }
  return out
}

/**
 * 按「保留最近 keep 条含图片消息」计算并 append 一次 image/offload 决策。
 * 没有需要卸载的就什么都不做（不污染会话日志），返回是否真的卸载了。
 */
export function pruneOldImages(session: AnySession, keep = IMAGE_KEEP_MESSAGES): boolean {
  const nodes = session.surface?.nodes ?? []
  const withImages: { seq: number; indexes: number[] }[] = []
  for (const seq of nodes) {
    const event = session.eventAt(seq)
    if (!event || (event.type !== 'user/message' && event.type !== 'tool/result')) continue
    const indexes = pendingImageIndexes(session.deriveEventMessage(event))
    if (indexes.length) withImages.push({ seq, indexes })
  }
  if (withImages.length <= keep) return false
  const targets = withImages.slice(0, withImages.length - keep).map(({ seq, indexes }) => ({ seq, imageIndexes: indexes }))
  session.append(OFFLOAD_EVENT, { targets })
  return true
}

/** cordis 插件：注册消息投影（写法与 DshController 里其它 ctx.plugin 一致） */
export const name = 'image-prune'
export const inject = ['sessions']
export function apply(ctx: any): void {
  ctx.sessions.registerMessageProjection(imagePruneProjection)
}
