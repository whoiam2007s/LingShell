// read_image：把最多 8 张图片交给**当前会话的多模态模型**识别，返回文字。
//
// 为什么是工具而不是界面按钮：用户贴的图本来就会随消息发出；这里解决的是「AI 在工作过程中
// 自己需要看图」——截图落在磁盘上、日志目录里有一张报错图、远端主机上有一张图。
//
// 走的是 hand-built 一次性请求（llm.stream），复用当前会话的路由与模型：
// 不新建会话、不写入会话历史、不额外占一轮。
import { tr } from '@lingshell/shared'
import {
  MAX_IMAGES, mimeOfPath, nameOfPath, parseRef, sniffMime, validateBatch, type LoadedImage,
} from './imageInput.js'

const optStr = (description: string) => ({ type: 'string' as const, description })
const arr = (description: string) => ({ type: 'array' as const, items: { type: 'string' as const }, required: true, description })
const textOut = { schema: { type: 'string' as const }, render: (_a: unknown, v: string) => [{ type: 'text' as const, text: v }] }

/** 默认问题：不给问题时按「描述 + 关键信息」问，报错截图/界面/架构图都吃得下 */
export const DEFAULT_QUESTION = '描述这些图片里有什么。如果是报错或界面截图，把报错原文、关键字段和按钮照抄出来；如果是架构图或流程图，说明模块与流向。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果

export interface ImageToolDeps {
  /** 取会话 id：入参是 dsh 的 **agent id**（同 askUser / plan 的约定），由控制器映射成我方会话 id */
  sessionIdOf(agentId: string): string
  /** 当前会话所用模型是否支持图片（模型配置里开了「支持图片」） */
  supportsImages(sessionId: string): boolean
  /** 读本机文件字节（本地路径） */
  readLocalFile(path: string): Promise<Uint8Array>
  /** 按附件库 id 取图（用户贴过的图 / 之前读过的图） */
  readImageId(id: string): Promise<{ bytes: Uint8Array; mediaType: string } | undefined>
  /** SSH 远端路径 → 先下到本机再读（复用上传下载同一条 sftp 通道） */
  downloadFile?(terminalId: string, remotePath: string): Promise<{ localPath: string }>
  /** 把图片交给当前会话的模型看一次，返回文本 */
  chatWithImages(sessionId: string, question: string, images: LoadedImage[]): Promise<string>
  /** 终端当前目录（解析相对路径用；只对本地终端有意义） */
  cwdOf?(terminalId?: string): string | undefined
  audit?(entry: { sessionId: string; terminalId: string; command: string; decision: string }): void
}

/** 把工具入参里的 paths 规整成字符串数组（模型有时给数组、有时给一段逗号/换行分隔的文本） */
export function normalizePaths(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\n,，;；]+/) : []
  return list.map((x) => String(x).trim()).filter(Boolean)
}

export function imageToolDef(deps: ImageToolDeps) {
  return {
    name: 'read_image',
    description: '看图片：把 1–8 张图片交给当前会话的多模态模型识别，返回文字描述（界面截图、报错弹窗、架构图、日志截图都可以）。paths 里每一项可以是：本机绝对路径、终端工作目录下的相对路径、SSH 主机上的路径（传 terminal_id），或图片存档 id（用户贴过的图）。多张图会在同一次请求里一起送，适合「对比这两张」「按顺序看这一组」。单张 ≤ 5MB、合计 ≤ 20MB、最多 8 张；只支持 png / jpg / webp / gif。仅当当前会话的模型支持图片时可用（模型设置里开了「支持图片」）。',   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
    parameters: {
      paths: arr('图片列表：1–8 个路径或图片 id'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      question: optStr('想让它看什么，缺省则描述图片内容（报错原文、界面要素、图表结构）'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      terminal_id: optStr('终端 id：给相对路径或 SSH 远端路径时用来确定工作目录与主机'),   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
    },
    output: textOut,
    async execute(args: { paths: unknown; question?: string; terminal_id?: string }, exec: unknown) {
      // 与 askUser / plan 同一约定：sessionIdOf 吃的是 **agent id 字符串**，不是 exec 对象。
      // 传错会让映射查不到、chatWithImages 拿着 dsh 内部 id 找不到会话，报「会话还没启动」。
      const sid = deps.sessionIdOf(String((exec as { agent?: { id?: unknown } } | undefined)?.agent?.id ?? ''))
      if (!deps.supportsImages(sid)) {
        throw new Error(tr('当前模型不支持图片，无法识别：可在模型设置里开启「支持图片」或切换到多模态模型'))
      }
      const refs = normalizePaths(args.paths)
      if (!refs.length) throw new Error(tr('没有给图片路径'))
      if (refs.length > MAX_IMAGES) throw new Error(tr('一次最多读取 {n} 张图片，这次给了 {got} 张', { n: MAX_IMAGES, got: refs.length }))

      const cwd = deps.cwdOf?.(args.terminal_id)
      const images: LoadedImage[] = []
      for (const raw of refs) {
        const ref = parseRef(raw, cwd)
        if (ref.kind === 'imageId') {
          const got = await deps.readImageId(ref.id)
          if (!got) throw new Error(tr('图片存档不存在或已损坏：{id}', { id: ref.id }))
          images.push({ name: ref.id, bytes: got.bytes, mediaType: got.mediaType })
          continue
        }
        const mime = mimeOfPath(ref.path)
        if (!mime) throw new Error(tr('不支持的图片格式：{name}（支持 png / jpg / webp / gif）', { name: nameOfPath(ref.path) }))
        let bytes: Uint8Array
        try {
          // 远端路径：先下到本机再读字节；本地路径直接读
          if (args.terminal_id && deps.downloadFile && !(cwd && ref.path.startsWith(cwd))) {
            const dl = await deps.downloadFile(args.terminal_id, ref.path)
            bytes = await deps.readLocalFile(dl.localPath)
          } else bytes = await deps.readLocalFile(ref.path)
        } catch (e) {
          throw new Error(tr('无法读取图片：{path}（{msg}）', { path: ref.path, msg: String((e as Error)?.message ?? e).slice(0, 160) }), { cause: e })
        }
        images.push({ name: nameOfPath(ref.path), bytes, mediaType: sniffMime(bytes, mime) })
      }
      // 大小/张数/类型统一在这里兜底（读之前已按扩展名挡过一次，这里看真实字节）
      validateBatch(images)

      const question = (args.question ?? '').trim() || DEFAULT_QUESTION
      const answer = await deps.chatWithImages(sid, question, images)
      deps.audit?.({
        sessionId: sid, terminalId: args.terminal_id ?? '',
        command: tr('识别 {n} 张图片', { n: images.length }), decision: 'read_allowed',
      })
      return answer || tr('模型没有返回内容')
    },
  }
}
