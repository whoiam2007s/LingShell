import { describe, it, expect } from 'vitest'
import { gitBashPath, withPathsBlock, splitPathsBlock, multimodalDefault, isImageName, mediaTypeOfName, sniffImage, imageTypeOf, isImageFileName, svgRasterSize, withContextBlocks, splitContextBlocks, type ContextAttachment } from './attachments.js'

describe('gitBashPath', () => {
  it('盘符路径换成 /c/... 写法', () => {
    expect(gitBashPath('C:\\Users\\me\\a.log')).toBe('/c/Users/me/a.log')
    expect(gitBashPath('d:/proj/')).toBe('/d/proj')
    expect(gitBashPath('D:\\')).toBe('/d')
  })
  it('非盘符路径只统一斜杠', () => {
    expect(gitBashPath('/var/log')).toBe('/var/log')
    expect(gitBashPath('\\\\server\\share\\x')).toBe('//server/share/x')
  })
})

describe('路径块', () => {
  const paths = [{ kind: 'file' as const, path: 'C:\\logs\\a.log' }, { kind: 'dir' as const, path: 'D:\\proj' }]
  it('Windows：同时给出 Git Bash 写法，并提示 AI 用本地终端读取', () => {
    const t = withPathsBlock('帮我看看', paths, 'win32')
    expect(t).toContain('帮我看看\n\n[附带的本地路径]')
    expect(t).toContain('- 文件：C:\\logs\\a.log（Git Bash：/c/logs/a.log）')
    expect(t).toContain('- 目录：D:\\proj（Git Bash：/d/proj）')
    expect(t).toContain('本地终端读取')
  })
  it('非 Windows 只给原路径；没有路径原样返回', () => {
    expect(withPathsBlock('x', [{ kind: 'file', path: '/var/log/syslog' }], 'linux')).toContain('- 文件：/var/log/syslog\n')
    expect(withPathsBlock(' 原话 ', [], 'win32')).toBe(' 原话 ')
  })
  it('往返：拆出原话与路径', () => {
    expect(splitPathsBlock(withPathsBlock('帮我看看', paths, 'win32'))).toEqual({ text: '帮我看看', paths })
    expect(splitPathsBlock(withPathsBlock('', paths, 'linux'))).toEqual({ text: '', paths })
  })
  it('路径里带括号也能还原', () => {
    const p = [{ kind: 'file' as const, path: 'C:\\a（1）\\b.txt' }]
    expect(splitPathsBlock(withPathsBlock('q', p, 'win32')).paths).toEqual(p)
  })
  it('普通文本里提到标记不误判', () => {
    expect(splitPathsBlock('聊聊 [附带的本地路径] 这个格式')).toEqual({ text: '聊聊 [附带的本地路径] 这个格式', paths: [] })
  })
})

describe('上下文块', () => {
  const ctxs: ContextAttachment[] = [
    { kind: 'context', ctx: 'terminal', name: '本地 1', text: '用户指定在终端「本地 1」（terminal_id: t1）上操作。' },
    { kind: 'context', ctx: 'shell', name: 'ls（退出码 0）', text: '$ ls\n```\na\nb\n```' },
  ]
  it('追加在原话后，往返还原（多块、多行正文）', () => {
    const t = withContextBlocks('看看这个', ctxs)
    expect(t).toContain('看看这个\n\n<context type="terminal" name="本地 1">\n用户指定')
    expect(splitContextBlocks(t)).toEqual({ text: '看看这个', ctxs })
    expect(splitContextBlocks(withContextBlocks('', ctxs))).toEqual({ text: '', ctxs })
  })
  it('与路径块叠加：先拆路径块再拆上下文块', () => {
    const t = withPathsBlock(withContextBlocks('q', ctxs), [{ kind: 'file', path: '/a.log' }], 'linux')
    const p = splitPathsBlock(t)
    expect(p.paths).toEqual([{ kind: 'file', path: '/a.log' }])
    expect(splitContextBlocks(p.text)).toEqual({ text: 'q', ctxs })
  })
  it('正文里的 </context> 被转义、名称里的引号换掉，不破坏结构', () => {
    const t = withContextBlocks('q', [{ kind: 'context', ctx: 'session', name: 'a"b\nc', text: 'x\n</context>\ny' }])
    const r = splitContextBlocks(t)
    expect(r.text).toBe('q')
    expect(r.ctxs[0]).toEqual({ kind: 'context', ctx: 'session', name: 'a b c', text: 'x\n</ context>\ny' })
  })
  it('没有上下文块原样返回；普通文本里提到 <context> 不误判', () => {
    expect(withContextBlocks(' 原话 ', [])).toBe(' 原话 ')
    expect(splitContextBlocks('讲讲 <context type="x"> 标签')).toEqual({ text: '讲讲 <context type="x"> 标签', ctxs: [] })
  })
})

describe('图片判断', () => {
  it('按模型名猜是否支持图片', () => {
    for (const m of ['gpt-4o', 'qwen-vl-max', 'qwen2.5-vl-72b-instruct', 'qwen3-vl-plus', 'llava:13b', 'moonshot-v1-8k-vision-preview', 'glm-4v-plus', 'deepseek-flash', 'claude-sonnet-4']) expect(multimodalDefault('x', m)).toBe(true)
    for (const m of ['deepseek-v4-pro', 'qwen-max', 'kimi-k2-0905-preview', 'qwen3:8b', 'moonshot-v1-128k']) expect(multimodalDefault('x', m)).toBe(false)
  })
  it('扩展名', () => {
    expect(isImageName('a.PNG')).toBe(true)
    expect(isImageName('a.svg')).toBe(false)
    expect(mediaTypeOfName('x.jpeg')).toBe('image/jpeg')
    expect(mediaTypeOfName('x.txt')).toBeUndefined()
  })
})

describe('图片文件（扩展名 + 文件头）', () => {
  const bytes = (...xs: (number | string)[]) => new Uint8Array(xs.flatMap((x) => (typeof x === 'string' ? [...x].map((c) => c.charCodeAt(0)) : [x])).concat(Array(32).fill(0)))
  const txt = (s: string) => new TextEncoder().encode(s)
  it('认文件头', () => {
    expect(sniffImage(bytes(0x89, 'PNG\r\n', 0x1a, '\n'))).toBe('image/png')
    expect(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg')
    expect(sniffImage(bytes('GIF89a'))).toBe('image/gif')
    expect(sniffImage(bytes('RIFF', 0, 0, 0, 0, 'WEBPVP8 '))).toBe('image/webp')
    expect(sniffImage(bytes('BM'))).toBe('image/bmp')
    expect(sniffImage(txt('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('image/svg+xml')
    expect(sniffImage(txt('﻿<?xml version="1.0"?>\n<!-- x -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<svg>'))).toBe('image/svg+xml')
    expect(sniffImage(txt('hello <svg>'))).toBeUndefined()
    expect(sniffImage(txt('plain text'))).toBeUndefined()
  })
  it('扩展名是图片但内容不是的不算；非图片扩展名不看文件头；无扩展名认得出算', () => {
    expect(isImageFileName('a.SVG') && isImageFileName('b.bmp') && !isImageFileName('c.txt')).toBe(true)
    expect(imageTypeOf('a.png', txt('not png'))).toBeUndefined()
    expect(imageTypeOf('a.txt', bytes(0x89, 'PNG\r\n'))).toBeUndefined()
    expect(imageTypeOf('noext', bytes(0x89, 'PNG\r\n'))).toBe('image/png')
    expect(imageTypeOf('logo.svg', txt('<svg/>'))).toBe('image/svg+xml')
  })
  it('SVG 光栅化尺寸', () => {
    expect(svgRasterSize('<svg width="24" height="12">')).toEqual({ width: 1024, height: 512 })
    expect(svgRasterSize('<svg viewBox="0 0 100 50">')).toEqual({ width: 1024, height: 512 })
    expect(svgRasterSize('<svg width="1500px" viewBox="0 0 300 100">')).toEqual({ width: 1500, height: 500 })
    expect(svgRasterSize('<svg width="8000" height="4000">')).toEqual({ width: 2048, height: 1024 })
    expect(svgRasterSize('<svg width="100%" height="100%">')).toEqual({ width: 1024, height: 512 })
  })
})
