import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { normalizeKnowledge, tr, type KnowledgeCard, type KnowledgeInput } from '@lingshell/shared'
import { readJson, writeJson } from './jsonFile.js'

// 主机知识库：<dir>/knowledge.json。cards = 知识卡；legacy = 已迁移的旧「主机备注」（hostKey → 迁移时的备注原文）。
interface KnowledgeFile { cards: KnowledgeCard[]; legacy?: Record<string, string> }

/** 旧主机备注迁移出来的卡：每台主机固定一张（id 由 hostKey 派生），备注再改时更新这张，不重复建 */
export const legacyCardId = (hostKey: string) => `kb_note_${hostKey}`

export class KnowledgeStore {
  readonly file: string
  constructor(dir: string, private now: () => Date = () => new Date()) { this.file = join(dir, 'knowledge.json') }

  private read(): KnowledgeFile {
    const f = readJson<KnowledgeFile>(this.file)
    return { cards: Array.isArray(f?.cards) ? f.cards : [], legacy: f?.legacy ?? {} }
  }

  list(): KnowledgeCard[] { return this.read().cards }

  save(input: KnowledgeInput): KnowledgeCard {
    const n = normalizeKnowledge(input)
    const f = this.read()
    const card: KnowledgeCard = { ...n, id: n.id ?? `kb_${randomUUID().slice(0, 8)}`, updatedAt: this.now().toISOString() }
    const i = f.cards.findIndex((x) => x.id === card.id)
    if (i >= 0) f.cards[i] = card; else f.cards.push(card)
    writeJson(this.file, f)
    return card
  }

  delete(id: string): void {
    const f = this.read()
    writeJson(this.file, { ...f, cards: f.cards.filter((c) => c.id !== id) })
  }

  /** 导入（配置导入用）：整表替换写回，legacy 保留 */
  replaceAll(cards: KnowledgeCard[]): void { writeJson(this.file, { ...this.read(), cards }) }

  /**
   * 旧「主机备注」→ 该主机的一张「主机备注」卡（向后兼容，不丢数据）：备注原文没变过的不动；
   * 新出现 / 改过的（主机表单里改备注、导入了带备注的主机）更新那张卡。备注本身原样保留在主机配置里。
   * 返回本次是否有改动。
   */
  syncLegacy(notes: { hostKey: string; notes?: string }[]): boolean {
    const f = this.read()
    let changed = false
    for (const { hostKey, notes: raw } of notes) {
      const text = (raw ?? '').trim()
      if (!text || f.legacy![hostKey] === text) continue
      const id = legacyCardId(hostKey)
      const card: KnowledgeCard = { id, scope: 'host', target: hostKey, title: tr('主机备注'), content: text, category: 'other', source: 'manual', updatedAt: this.now().toISOString() }
      const i = f.cards.findIndex((c) => c.id === id)
      if (i >= 0) f.cards[i] = { ...f.cards[i], content: text, updatedAt: card.updatedAt }; else f.cards.push(card)
      f.legacy![hostKey] = text
      changed = true
    }
    if (changed) writeJson(this.file, f)
    return changed
  }
}
