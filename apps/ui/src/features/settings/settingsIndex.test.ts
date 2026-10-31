import { describe, it, expect } from 'vitest'
import { extract, buildIndex, renderIndex } from './settingsIndexGen.js'

describe('设置项索引', () => {
  it('抽取：字符串 / 表达式里的字符串 / JSX 说明、所属分组，跳过非字符串标签', () => {
    const src = `<Section title="文件传输" tip="说明">
      <Row label="传输限速" hint="KB/s，0 = 不限" tip="每个任务的速度上限"><X /></Row>
      <Row label={'跳到行'} tip={<>先 <b>粗</b> 后{x}细</>} />
      <Row label={label} />
    </Section>`
    expect(extract(src)).toEqual([
      { kind: 'section', label: '文件传输', tip: '说明' },
      { kind: 'row', label: '传输限速', section: '文件传输', hint: 'KB/s，0 = 不限', tip: '每个任务的速度上限' },
      { kind: 'row', label: '跳到行', section: '文件传输', tip: '先 粗 后 细' },
    ])
  })
  it('与设置页源码一致（不一致就 -u 重新生成）', async () => {
    const raw = import.meta.glob('./**/*.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
    const files = Object.fromEntries(Object.entries(raw).map(([f, src]) => [f.replace(/^\.\/|\.tsx$/g, ''), src]))
    const idx = buildIndex(files)
    expect(idx.some((e) => e.label === '传输限速' && e.tab === 'general')).toBe(true)
    await expect(renderIndex(idx)).toMatchFileSnapshot('./settingsIndex.gen.ts')
  })
})
