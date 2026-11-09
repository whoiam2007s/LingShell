// 提示音：两类事件两种声音，用 WebAudio 现场合成（不占安装包体积、不用管音频格式）。
//
//   done —— 一轮任务跑完了：两声上行（880 → 1174Hz），短、不刺耳
//   wait —— 等你确认 / 交互（授权卡、计划审批、提问卡）：三声短促（660·660·880）
//
// 开关在 设置 → AI 与安全 → 「声音提醒」；同一种音 2 秒内只响一次（一轮里连着几个授权卡不会连响）。
import { client } from '../client/index.js'

export type Cue = 'done' | 'wait'

let ctx: AudioContext | undefined
let lastAt: Partial<Record<Cue, number>> = {}
const THROTTLE_MS = 2000

const audio = (): AudioContext | undefined => {
  try {
    if (!ctx) {
      const AC = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      const Ctor = AC.AudioContext ?? AC.webkitAudioContext
      if (!Ctor) return undefined
      ctx = new Ctor()
    }
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch {
    return undefined
  }
}

/** 单个音符：三角波 + 快起慢落，音量很低（只是提醒，不吓人） */
const beep = (at: number, freq: number, dur = 0.12, gain = 0.06) => {
  const ac = audio()
  if (!ac) return
  const osc = ac.createOscillator()
  const g = ac.createGain()
  osc.type = 'triangle'
  osc.frequency.value = freq
  g.gain.setValueAtTime(0, at)
  g.gain.linearRampToValueAtTime(gain, at + 0.012)
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
  osc.connect(g).connect(ac.destination)
  osc.start(at)
  osc.stop(at + dur + 0.02)
}

const PRESET: Record<Cue, (t: number) => void> = {
  done: (t) => { beep(t, 880); beep(t + 0.16, 1174, 0.16) },
  wait: (t) => { beep(t, 660, 0.1); beep(t + 0.14, 660, 0.1); beep(t + 0.28, 880, 0.14) },
}

/** 直接响（供测试 / 调试用）；正常业务用 playCue */
export function playNow(cue: Cue): void {
  const ac = audio()
  if (!ac) return
  PRESET[cue](ac.currentTime + 0.01)
}

/** 按设置决定要不要响；读设置失败按「开」处理（默认开） */
export async function playCue(cue: Cue): Promise<void> {
  const now = Date.now()
  if (now - (lastAt[cue] ?? 0) < THROTTLE_MS) return
  const s = await client.settings.get().catch(() => undefined)
  if ((s?.system as { notifySound?: boolean } | undefined)?.notifySound === false) return
  lastAt = { ...lastAt, [cue]: now }
  playNow(cue)
}

/** 测试用：清掉节流记录 */
export const clearCueThrottle = (): void => { lastAt = {} }

export interface CueEvent {
  /** 回合结束（正常完成；用户自己中断的不算） */
  turnEnded?: boolean
  /** 新出现的待确认项：授权 / 计划审批 / 提问 */
  awaiting?: boolean
}

/** 事件 → 该响哪种音（两者同时发生时以「等你处理」优先，它更需要你动手） */
export function cueOf(e: CueEvent): Cue | null {
  if (e.awaiting) return 'wait'
  if (e.turnEnded) return 'done'
  return null
}
