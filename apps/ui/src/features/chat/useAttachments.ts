// 输入框附件草稿：「+ → 添加上下文」的图片 / 文件 / 目录、Ctrl+V 粘贴（截图、或资源管理器里复制的文件 / 文件夹）、从系统拖入。
// 本机图片文件（png / jpg / gif / webp / bmp / svg）一律显示为图片 tag：模型支持图片时作为图片发送，不支持时只发路径。
// 粘贴 / 拖入的位图（截图等，没有路径）只能作为图片发送：模型不支持时只给提示。
import { useEffect, useRef, useState } from 'react'
import { IMAGE_MAX_PER_MESSAGE, redactSecrets, tr, type ContextKind } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { normalizeImage, imageFileAtt, pathAtt, contextAtt, toTurn, toView, toChip, imageCount, errMsg, NO_IMAGE_HINT, termBlockAtt, TERM_BLOCK_MIME, type DraftAtt, type TermBlock } from './attachments.js'
import { onAttachTermBlock, parseBlockDrag } from '../../lib/termBlock.js'
import { onAttachPaths, LOCAL_PATHS_MIME } from '../../lib/localPaths.js'
import type { OutgoingAttachments } from './useConversation.js'


const pathForFile = (f: File) => (window as unknown as { electronAPI?: { pathForFile?: (f: File) => string } }).electronAPI?.pathForFile?.(f) ?? ''

export function useAttachments(multimodal: boolean, sessionId: string) {
  const [items, setItems] = useState<DraftAtt[]>([])
  const [hint, setHint] = useState('')
  // 异步读取（主进程判断文件类型 / 图片光栅化）期间切了会话：结果不能落到新会话的草稿里
  const sidRef = useRef(sessionId); sidRef.current = sessionId
  useEffect(() => { if (!hint) return; const t = setTimeout(() => setHint(''), 5000); return () => clearTimeout(t) }, [hint])
  // 切会话：草稿附件不带过去
  useEffect(() => { setItems([]); setHint('') }, [sessionId])

  const add = (next: DraftAtt[]) => setItems((cur) => {
    // 同一路径只留一个
    const seen = new Set(cur.map((a) => a.path))
    const merged = [...cur, ...next.filter((a) => { if (!a.path) return true; if (seen.has(a.path)) return false; seen.add(a.path); return true })]
    const imgs = merged.filter((a) => a.kind === 'image' && (multimodal || !a.path))   // 只发路径的图片文件不占张数
    if (imgs.length <= IMAGE_MAX_PER_MESSAGE) return merged
    setHint(tr('每条消息最多 {n} 张图片', { n: IMAGE_MAX_PER_MESSAGE }))
    const drop = new Set<DraftAtt>(imgs.slice(IMAGE_MAX_PER_MESSAGE))
    return merged.filter((a) => !drop.has(a))
  })
  const addBitmaps = async (srcs: { blob: Blob; name: string }[]) => {
    if (!srcs.length) return
    if (!multimodal) { setHint(tr(NO_IMAGE_HINT)); return }
    const sid = sessionId
    const out: DraftAtt[] = []
    for (const s of srcs) {
      try { out.push(await normalizeImage(s.blob, s.name)) } catch (e) { if (sidRef.current === sid) setHint(errMsg(e)) }
    }
    if (sidRef.current !== sid) return
    if (out.length) add(out)
  }
  // 本机路径（选择 / 拖入 / 粘贴）：主进程判断文件 / 目录 / 图片文件，图片文件读出来做缩略图并光栅化备发送
  const addPaths = async (paths: string[]) => {
    if (!paths.length) return
    const sid = sessionId
    try {
      const ks = await client.attachments.kinds(paths)
      const out: DraftAtt[] = []
      for (const [i, p] of paths.entries()) {
        const k = ks[i]
        if (k === 'image') out.push(await imageFileAtt(p).catch(() => pathAtt('file', p)))
        else if (k) out.push(pathAtt(k, p))
      }
      if (sidRef.current !== sid) return   // 读取期间切了会话
      if (out.length) add(out)
    } catch (e) { if (sidRef.current === sid) setHint(errMsg(e)) }
  }

  const pick = (f: () => Promise<string[]>) => () => { f().then(addPaths).catch((e) => setHint(errMsg(e))) }
  const pickFiles = pick(() => client.attachments.pickFiles())
  const pickDirs = () => {
    const sid = sessionId
    client.attachments.pickDirs().then((ps) => {
      if (sidRef.current === sid) add(ps.map((p) => pathAtt('dir', p)))
    }).catch((e) => { if (sidRef.current === sid) setHint(errMsg(e)) })
  }
  const pickImages = pick(() => client.attachments.pickImages())

  // 粘贴：有文字照常粘贴文字。资源管理器里复制的文件 / 文件夹 → 路径附件（Chromium 的 paste 事件 files 里两者都有，
  // 经 preload 的 webUtils.getPathForFile 取路径；拿不到路径时向主进程读系统剪贴板兜底）；截图等位图 → 图片附件
  const onPaste = (e: React.ClipboardEvent) => {
    const cd = e.clipboardData
    if (cd.getData('text/plain')) return
    const files = [...cd.files]
    const paths = files.map(pathForFile).filter(Boolean)
    if (paths.length) { e.preventDefault(); void addPaths(paths); return }
    const imgs = files.filter((f) => f.type.startsWith('image/'))
    if (imgs.length) {
      e.preventDefault()
      const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '')
      void addBitmaps(imgs.map((f, i) => ({ blob: f, name: f.name && f.name !== 'image.png' ? f.name : `${tr('粘贴的图片-{stamp}', { stamp })}${i ? `-${i}` : ''}.png` })))
      return
    }
    if (cd.types.includes('Files')) { e.preventDefault(); client.attachments.clipboardPaths().then(addPaths).catch(() => {}) }
  }

  // 拖入：本机文件 / 目录 / 图片文件 → 同选择；从网页等拖来的位图（没有路径）→ 图片附件
  // 终端里选中的文字拖进来（TerminalPane 设的 TERM_BLOCK_MIME）→ 终端块
  const dropProps = {
    onDragOver: (e: React.DragEvent) => { const t = e.dataTransfer.types; if (t.includes('Files') || t.includes(TERM_BLOCK_MIME) || t.includes(LOCAL_PATHS_MIME)) e.preventDefault() },
    onDrop: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes(LOCAL_PATHS_MIME)) {   // 从本机资源管理器拖来的
        e.preventDefault()
        void addPaths(e.dataTransfer.getData(LOCAL_PATHS_MIME).split('\n').filter(Boolean))
        return
      }
      const blk = e.dataTransfer.types.includes(TERM_BLOCK_MIME) ? parseBlockDrag(e.dataTransfer.getData(TERM_BLOCK_MIME)) : undefined
      if (blk) {   // 同「附加到对话」：按「发给 AI 前脱敏」处理
        e.preventDefault()
        void client.settings.get().catch(() => undefined).then((s) => add([termBlockAtt(s?.system?.aiRedact === false ? blk : { ...blk, output: redactSecrets(blk.output) })]))
        return
      }
      const files = [...e.dataTransfer.files]
      if (!files.length) return
      e.preventDefault()
      void addPaths(files.map(pathForFile).filter(Boolean))
      void addBitmaps(files.filter((f) => !pathForFile(f) && f.type.startsWith('image/')).map((f) => ({ blob: f, name: f.name })))
    },
  }

  // 发送用：有没路径的图片（截图）但模型不支持 → 提示并返回 null（不发）；没有附件返回 undefined
  // 终端块不在其中（见 blocks()，由调用方拼进消息文本）
  const outgoing = (): OutgoingAttachments | undefined | null => {
    const files = items.filter((a): a is Exclude<DraftAtt, { kind: 'termBlock' }> => a.kind !== 'termBlock')
    if (!files.length) return undefined
    if (!multimodal && files.some((a) => a.kind === 'image' && !a.path)) { setHint(tr('{hint}（粘贴的图片请先移除）', { hint: tr(NO_IMAGE_HINT) })); return null }
    if (imageCount(files, multimodal) > IMAGE_MAX_PER_MESSAGE) { setHint(tr('每条消息最多 {n} 张图片', { n: IMAGE_MAX_PER_MESSAGE })); return null }
    return { send: files.map((a) => toTurn(a, multimodal)), view: files.map(toView) }
  }
  const blocks = (): TermBlock[] => items.flatMap((a) => (a.kind === 'termBlock' ? [a.block] : []))
  // 红点菜单「附加到对话」
  useEffect(() => onAttachTermBlock((b) => setItems((cur) => [...cur, termBlockAtt(b)])), [])
  useEffect(() => onAttachPaths((ps) => { void addPaths(ps) }), [multimodal])

  // 上下文标签（@ 引用 / 终端块）：同一个终端 / 主机 / 会话只留一个（终端块每次执行都是新的，不去重）
  const addContext = (ctx: ContextKind, name: string, text: string) => setItems((cur) =>
    ctx !== 'shell' && cur.some((a) => a.kind === 'context' && a.ctx === ctx && a.name === name) ? cur : [...cur, contextAtt(ctx, name, text)])

  return {
    addContext,
    items: items.map((a) => ({ ...toChip(a), key: a.key })), hint, setHint, blocks,
    remove: (i: number) => setItems((cur) => cur.filter((_, j) => j !== i)),
    clear: () => setItems([]),
    pickFiles, pickDirs, pickImages, onPaste, dropProps, outgoing,
  }
}
