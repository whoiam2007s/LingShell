// 输入框附件草稿：「+ → 添加上下文」的图片 / 文件 / 目录、Ctrl+V 粘贴（截图、或资源管理器里复制的文件 / 文件夹）、从系统拖入。
// 本机图片文件（png / jpg / gif / webp / bmp / svg）一律显示为图片 tag：模型支持图片时作为图片发送，不支持时只发路径。
// 粘贴 / 拖入的位图（截图等，没有路径）只能作为图片发送：模型不支持时只给提示。
import { useEffect, useRef, useState } from 'react'
import { IMAGE_MAX_PER_MESSAGE, IMAGE_MAX_SOURCE_BYTES, IMAGE_MAX_TOTAL_BYTES, base64Bytes, fitImageBudget, redactSecrets, tr, type ContextKind } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { normalizeImage, imageFileAtt, pathAtt, contextAtt, toTurn, toView, toChip, imageCount, errMsg, NO_IMAGE_HINT, termBlockAtt, TERM_BLOCK_MIME, type DraftAtt, type TermBlock } from './attachments.js'
import { onAttachTermBlock, parseBlockDrag } from '../../lib/termBlock.js'
import { onAttachPaths, LOCAL_PATHS_MIME } from '../../lib/localPaths.js'
import type { OutgoingAttachments } from './useConversation.js'


const pathForFile = (f: File) => (window as unknown as { electronAPI?: { pathForFile?: (f: File) => string } }).electronAPI?.pathForFile?.(f) ?? ''

export function useAttachments(multimodal: boolean, sessionId: string) {
  const [items, setItems] = useState<DraftAtt[]>([])
  const [hint, setHint] = useState('')
  // 最新草稿的同步镜像：add / addContext 之后「马上」读（outgoing / blocks）时，state 还是上一帧的值，
  // 「用摘要开新会话」这种加完上下文立刻发送的流程会读到空列表，摘要就发不出去 —— 一律以 ref 为准
  const itemsRef = useRef<DraftAtt[]>([])
  const setItemsBoth = (next: DraftAtt[] | ((cur: DraftAtt[]) => DraftAtt[])) => {
    const v = typeof next === 'function' ? (next as (cur: DraftAtt[]) => DraftAtt[])(itemsRef.current) : next
    itemsRef.current = v
    setItems(v)
  }
  // 异步读取（主进程判断文件类型 / 图片光栅化）期间切了会话：结果不能落到新会话的草稿里
  const sidRef = useRef(sessionId); sidRef.current = sessionId
  useEffect(() => { if (!hint) return; const t = setTimeout(() => setHint(''), 5000); return () => clearTimeout(t) }, [hint])
  // 切会话：草稿附件不带过去
  useEffect(() => { setItemsBoth([]); setHint('') }, [sessionId])

  const add = (next: DraftAtt[]) => {
    const cur = itemsRef.current
    // 同一路径只留一个
    const seen = new Set(cur.map((a) => a.path))
    let merged = [...cur, ...next.filter((a) => { if (!a.path) return true; if (seen.has(a.path)) return false; seen.add(a.path); return true })]
    const imgs = merged.filter((a) => a.kind === 'image' && (multimodal || !a.path))   // 只发路径的图片文件不占张数
    if (imgs.length > IMAGE_MAX_PER_MESSAGE) {
      setHint(tr('每条消息最多 {n} 张图片', { n: IMAGE_MAX_PER_MESSAGE }))
      const drop = new Set<DraftAtt>(imgs.slice(IMAGE_MAX_PER_MESSAGE))
      merged = merged.filter((a) => !drop.has(a))
    }
    // 总量上限：压缩后合计超过 20MB 时，从尾部开始丢（先加的优先保留），并说明丢了几张
    const kept = merged.filter((a) => a.kind === 'image')
    const sizes = kept.map((a) => base64Bytes((a as { data?: string }).data ?? ''))
    const fit = fitImageBudget(sizes)
    if (fit < kept.length) {
      const dropped = new Set<DraftAtt>(kept.slice(fit))
      merged = merged.filter((a) => !dropped.has(a))
      setHint(tr('图片总量超过 {mb}MB，已保留前 {n} 张', { mb: Math.round(IMAGE_MAX_TOTAL_BYTES / 1024 / 1024), n: fit }))
    }
    setItemsBoth(merged)
  }
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
        if (k === 'image') {
          const att = await imageFileAtt(p).catch(() => pathAtt('file', p))
          // 原图超过 10MB 或解码失败时只留了路径：明确告诉用户「这张没压缩，只发路径」
          if (att.kind === 'image' && !att.data) setHint(tr('图片超过 {mb}MB 或无法解码，将只发送路径：{name}', { mb: Math.round(IMAGE_MAX_SOURCE_BYTES / 1024 / 1024), name: att.name }))
          out.push(att)
        }
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
    const files = itemsRef.current.filter((a): a is Exclude<DraftAtt, { kind: 'termBlock' }> => a.kind !== 'termBlock')
    if (!files.length) return undefined
    if (!multimodal && files.some((a) => a.kind === 'image' && !a.path)) { setHint(tr('{hint}（粘贴的图片请先移除）', { hint: tr(NO_IMAGE_HINT) })); return null }
    if (imageCount(files, multimodal) > IMAGE_MAX_PER_MESSAGE) { setHint(tr('每条消息最多 {n} 张图片', { n: IMAGE_MAX_PER_MESSAGE })); return null }
    return { send: files.map((a) => toTurn(a, multimodal)), view: files.map(toView) }
  }
  const blocks = (): TermBlock[] => itemsRef.current.flatMap((a) => (a.kind === 'termBlock' ? [a.block] : []))
  // 红点菜单「附加到对话」
  useEffect(() => onAttachTermBlock((b) => setItemsBoth((cur) => [...cur, termBlockAtt(b)])), [])
  // 订阅「资源管理器 → 添加到对话」：必须经 ref 取最新的 addPaths。
  // 以前直接把 addPaths 闭包进订阅、依赖只写 [multimodal]，订阅里一直是**首次渲染**的那个函数：
  // 那时会话还在异步恢复（sessionId 为空），addPaths 末尾“会话变了就别落地”的守卫会直接 return，
  // 于是文件读出来了又被静默丢掉 —— 表现为右击「添加到对话」毫无反应（0.1.0 起就有）。
  const addPathsRef = useRef(addPaths)
  addPathsRef.current = addPaths
  useEffect(() => onAttachPaths((ps) => { void addPathsRef.current(ps) }), [])

  // 上下文标签（@ 引用 / 终端块）：同一个终端 / 主机 / 会话只留一个（终端块每次执行都是新的，不去重）
  // 同一个来源（ctx + name）再发一次：更新内容而不是叠加 —— git / 容器这类上下文每次都是"当前状态"，
  // 用户可能反复点；shell（终端块）每次都是新的执行，仍然叠加。
  const addContext = (ctx: ContextKind, name: string, text: string) => setItemsBoth((cur) => {
    if (ctx === 'shell') return [...cur, contextAtt(ctx, name, text)]
    const i = cur.findIndex((a) => a.kind === 'context' && a.ctx === ctx && a.name === name)
    if (i < 0) return [...cur, contextAtt(ctx, name, text)]
    const next = cur.slice()
    next[i] = contextAtt(ctx, name, text)
    return next
  })

  return {
    addContext,
    items: items.map((a) => ({ ...toChip(a), key: a.key })), hint, setHint, blocks,
    remove: (i: number) => setItemsBoth((cur) => cur.filter((_, j) => j !== i)),
    clear: () => setItemsBoth([]),
    pickFiles, pickDirs, pickImages, onPaste, dropProps, outgoing,
  }
}
