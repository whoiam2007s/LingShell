import { describe, expect, it } from 'vitest'
import { detectNeedsInput, groomOutput, stripQuotedText } from './terminalGroom.js'

describe('groomOutput：把终端控制序列洗干净', () => {
  it('\\r 原地覆盖只保留最终帧', () => {
    expect(groomOutput('progress 10%\rprogress 50%\rprogress 100%\n')).toBe('progress 100%\n')
  })

  it('去掉 ANSI 颜色 / 擦行 / OSC 标题', () => {
    expect(groomOutput('\x1b[31mred\x1b[0m\n\x1b[2Kclean\x1b]0;title\x07')).toBe('red\nclean')
  })

  it('退格按删前一个字符处理', () => {
    expect(groomOutput('ab\b\bc')).toBe('c')
  })

  it('CRLF 归一，连续相同行折叠成 (×N)', () => {
    expect(groomOutput('wait\r\nwait\r\nwait\r\nok')).toBe('wait  (×3)\nok')
  })

  it('NUL 等控制字符清掉，保留换行与制表', () => {
    expect(groomOutput('a\x00b\x07\tc\nd')).toBe('ab\tc\nd')
  })
})

describe('detectNeedsInput：识别在等输入', () => {
  it('英文 yes/no 与 password', () => {
    expect(detectNeedsInput('Remove it? [y/N] ')).toBeTruthy()
    expect(detectNeedsInput('Password: ')).toBeTruthy()
    expect(detectNeedsInput('Are you sure you want to continue?')).toBeTruthy()
  })

  it('中文提示也要认', () => {
    expect(detectNeedsInput('是否继续？[是/否]')).toBeTruthy()
    expect(detectNeedsInput('请输入密码：')).toBeTruthy()
    expect(detectNeedsInput('按任意键继续')).toBeTruthy()
  })

  it('普通日志不误判', () => {
    expect(detectNeedsInput('Build succeeded in 3s')).toBeUndefined()
    expect(detectNeedsInput('Tests  217 passed (217)')).toBeUndefined()
  })
})

describe('stripQuotedText：判断危险命令前先剥引号内容', () => {
  it('grep "exit" 不算会关终端的命令', () => {
    expect(stripQuotedText('grep "exit" file')).not.toMatch(/\bexit\b/)
  })

  it('真正的 cd && exit 仍然保留', () => {
    expect(stripQuotedText('cd /tmp && exit')).toMatch(/\bexit\b/)
  })
})
