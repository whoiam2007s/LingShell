import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { crc32, deflateRawSync, gzipSync } from 'node:zlib'
import { DOC_TEXT_MAX_CHARS, artifactInfo, docToText, htmlToText, zipRead } from './docText.js'

// 最小 zip 写入（测试造 docx / zip 产物用）
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = []
  let off = 0
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text), data = deflateRawSync(raw), nm = Buffer.from(name)
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26)
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42)
    locals.push(lh, nm, data); central.push(ch, nm)
    off += 30 + nm.length + data.length
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16)
  return Buffer.concat([...locals, cd, end])
}
function tar(files: Record<string, string>): Buffer {
  const parts: Buffer[] = []
  for (const [name, text] of Object.entries(files)) {
    const h = Buffer.alloc(512), body = Buffer.from(text)
    h.write(name, 0); h.write(body.length.toString(8).padStart(11, '0') + '\0', 124); h.write('0', 156)
    parts.push(h, Buffer.concat([body, Buffer.alloc((512 - (body.length % 512)) % 512)]))
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)])
}
// 手写一个最小的文字 PDF（xref 偏移按实际算）
function pdf(text: string): Buffer {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${`BT /F1 12 Tf 20 100 Td (${text}) Tj ET`.length} >>\nstream\nBT /F1 12 Tf 20 100 Td (${text}) Tj ET\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  let s = '%PDF-1.4\n'
  const offs: number[] = []
  objs.forEach((o, i) => { offs.push(s.length); s += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const x = s.length
  s += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`
  return Buffer.from(s, 'latin1')
}

describe('docToText', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lingshell-doc-'))
  it('docx：段落、编号、表格、转义', async () => {
    const xml = '<w:document><w:body><w:p><w:r><w:t>部署 app &amp; web</w:t></w:r></w:p><w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>停服务</w:t></w:r></w:p>'
      + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>端口</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>8080</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'
    writeFileSync(join(dir, 'a.docx'), zip({ '[Content_Types].xml': '<x/>', 'word/document.xml': xml }))
    const r = await docToText(join(dir, 'a.docx'))
    expect(r.name).toBe('a.docx')
    expect(r.text).toContain('部署 app & web')
    expect(r.text).toContain('- 停服务')
    expect(r.text).toMatch(/端口\s*\n?\s*\|\s*8080/)
  })
  it('pdf', async () => {
    writeFileSync(join(dir, 'b.pdf'), pdf('Deploy order-service 2.1'))
    expect((await docToText(join(dir, 'b.pdf'))).text).toContain('Deploy order-service 2.1')
  })
  it('GBK 文本 / 旧 doc / 空文件', async () => {
    writeFileSync(join(dir, 'c.txt'), Buffer.from([0xb2, 0xbf, 0xca, 0xf0]))   // 「部署」GBK
    expect((await docToText(join(dir, 'c.txt'))).text).toBe('部署')
    writeFileSync(join(dir, 'd.doc'), 'x')
    await expect(docToText(join(dir, 'd.doc'))).rejects.toThrow('另存为 .docx')
    writeFileSync(join(dir, 'e.md'), '  \n')
    await expect(docToText(join(dir, 'e.md'))).rejects.toThrow('空的')
  })
  it('文字超过上限时拒绝（界面会把全文渲染出来）', async () => {
    writeFileSync(join(dir, 'big.md'), 'x'.repeat(DOC_TEXT_MAX_CHARS + 1))
    await expect(docToText(join(dir, 'big.md'))).rejects.toThrow('文档文字过长')
  })
  it('zip 解压超过上限时拒绝（防 zip 炸弹）', () => {
    const raw = Buffer.alloc(1024 * 1024), data = deflateRawSync(raw), nm = Buffer.from('word/document.xml')
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt16LE(nm.length, 26)
    const buf = Buffer.concat([lh, nm, data]), e = { name: 'word/document.xml', method: 8, csize: data.length, offset: 0 }
    expect(() => zipRead(buf, e, 1024)).toThrow()
    expect(zipRead(buf, e, 2 * 1024 * 1024).length).toBe(raw.length)
  })
  it('HTML 里的非法字符实体不崩、按原文保留', () => {
    expect(htmlToText('a &#x110000; b &amp; c')).toBe('a &#x110000; b & c')
  })
  it('产物：sha256 + 压缩包文件列表', async () => {
    const z = zip({ 'lib/a.jar': 'a', 'conf/': '', 'app.yml': 'x' })
    writeFileSync(join(dir, 'app-1.0.zip'), z)
    writeFileSync(join(dir, 'web.tar.gz'), gzipSync(tar({ 'web/index.html': '<h1>', 'web/app.js': 'x' })))
    const a = await artifactInfo(join(dir, 'app-1.0.zip'))
    expect(a).toEqual({ name: 'app-1.0.zip', size: z.length, sha256: createHash('sha256').update(z).digest('hex'), entries: ['lib/a.jar', 'app.yml'] })
    expect((await artifactInfo(join(dir, 'web.tar.gz'))).entries).toEqual(['web/index.html', 'web/app.js'])
  })
})
