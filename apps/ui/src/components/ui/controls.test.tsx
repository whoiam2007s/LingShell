import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseChildren, Select } from './Select.js'
import { filterSuggestions } from './Combobox.js'
import { Input } from './Input.js'
import { NumberInput } from './NumberInput.js'

describe('Select 的 <option> 子元素解析', () => {
  it('option / optgroup / hr / Fragment / 条件 false；数字值转字符串', () => {
    const show = false
    const entries = parseChildren(<>
      <option value="">未标注</option>
      {[1, 2].map((n) => <option key={n} value={n}>{n} 秒</option>)}
      {show && <option value="x">隐藏</option>}
      <hr />
      <optgroup label="使用凭据"><option value="cred:a" disabled>凭据 A</option></optgroup>
    </>)
    expect(entries).toEqual([
      { value: '', label: '未标注', disabled: undefined, title: undefined },
      { value: '1', label: [1, ' 秒'], disabled: undefined, title: undefined },
      { value: '2', label: [2, ' 秒'], disabled: undefined, title: undefined },
      'separator',
      { group: '使用凭据', options: [{ value: 'cred:a', label: '凭据 A', disabled: true, title: undefined }] },
    ])
  })
})

describe('Combobox 候选过滤', () => {
  const fonts = ['JetBrains Mono', 'Cascadia Code', 'Cascadia Mono', 'Consolas']
  it('空 / 恰好等于某候选：列全部（像 datalist 那样能直接换一个）', () => {
    expect(filterSuggestions(fonts, '')).toEqual(fonts)
    expect(filterSuggestions(fonts, 'consolas')).toEqual(fonts)
  })
  it('其它按包含过滤、不区分大小写', () => {
    expect(filterSuggestions(fonts, 'cascadia')).toEqual(['Cascadia Code', 'Cascadia Mono'])
    expect(filterSuggestions(fonts, 'MONO')).toEqual(['JetBrains Mono', 'Cascadia Mono'])
    expect(filterSuggestions(fonts, 'zzz')).toEqual([])
  })
})

describe('统一控件高度两档', () => {
  it('Select 触发器 / Input / NumberInput：md = h-8，sm = h-7', () => {
    const sel = renderToStaticMarkup(<Select value="a" onValueChange={() => {}} options={[{ value: 'a', label: 'A' }]} />)
    expect(sel).toContain('data-ui="select"')
    expect(sel).toMatch(/class="[^"]*\bh-8\b/)
    expect(renderToStaticMarkup(<Select size="sm" value="" placeholder="选择…" onValueChange={() => {}} options={[]} />)).toMatch(/class="[^"]*\bh-7\b/)
    expect(renderToStaticMarkup(<Input value="" onChange={() => {}} />)).toMatch(/class="[^"]*\bh-8\b/)
    expect(renderToStaticMarkup(<NumberInput value={1} min={0} max={9} onChange={() => {}} size="sm" />)).toMatch(/class="[^"]*\bh-7\b/)
  })
})

describe('PasswordInput 打码：圆点数 ≠ 真实长度', () => {
  it('每字 1~2 点；总数不等于长度；已有字符的点数不变', async () => {
    const { maskWeights } = await import('./PasswordInput.js')
    for (let len = 1; len <= 30; len++) {
      const w = maskWeights([], len)
      expect(w).toHaveLength(len)
      expect(w.every((x) => x === 1 || x === 2)).toBe(true)
      expect(w.reduce((a, b) => a + b, 0)).not.toBe(len)
    }
    const all1 = maskWeights([], 3, () => 0)          // 全抽到 1 → 最后一个补成 2
    expect(all1).toEqual([1, 1, 2])
    expect(maskWeights([2, 1, 2], 5, () => 0).slice(0, 3)).toEqual([2, 1, 2])
    expect(maskWeights([2, 1, 2], 0)).toEqual([])
  })
})
