// 英文词典 = 各分块合并（分块只是为了按模块分开维护；同一个中文键在不同块里译文应一致，校验脚本会查）
import { common } from './common.js'
import { help } from './help.js'
import { settings } from './settings.js'
import { terminals } from './terminals.js'
import { chat } from './chat.js'
import { files } from './files.js'
import { ops } from './ops.js'
import { sharedA } from './sharedA.js'
import { sharedB } from './sharedB.js'
import { desktop } from './desktop.js'
import { core } from './core.js'
import { shell } from './shell.js'
import { gitdb } from './gitdb.js'

export const EN: Record<string, string> = { ...core, ...desktop, ...gitdb, ...shell, ...sharedB, ...sharedA, ...ops, ...files, ...chat, ...terminals, ...settings, ...help, ...common }
