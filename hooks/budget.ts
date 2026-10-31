// Budget pressure: how full the plan's usage windows are, and what Hmind
// tightens as they fill. Read from the session's own rate-limit figures, the
// same ones the status line shows; nothing is requested from the API.

import type { EngineInterface } from 'claude-code'

export type Level = 'normal' | 'elevated' | 'high' | 'critical'
export type Pressure = { level: Level; percent: number; window: string }
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Size = 'trivial' | 'small' | 'large'

const RANK: Record<Effort, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 }

export function levelOf(percent: number): Level {
  if (percent >= 93) return 'critical'
  if (percent >= 80) return 'high'
  if (percent >= 60) return 'elevated'
  return 'normal'
}

export async function readPressure($: EngineInterface): Promise<Pressure> {
  const usage = await $.session.usage().catch(() => undefined)
  let percent = 0
  let window = 'none'
  for (const r of usage?.rateLimits ?? []) {
    if (r.kind !== 'five_hour' && r.kind !== 'seven_day') continue
    if (r.percentUsed > percent) {
      percent = r.percentUsed
      window = r.kind === 'five_hour' ? '5h' : '7d'
    }
  }
  return { level: levelOf(percent), percent, window }
}

/** The effort a turn of this size gets under this pressure; never above the session's own. */
export function effortFor(level: Level, size: Size, current: Effort): Effort {
  const cap = (e: Effort): Effort => (RANK[e] < RANK[current] ? e : current)
  const tight = level === 'high' || level === 'critical'
  if (size === 'trivial') return cap('low')
  if (size === 'small') return cap(tight ? 'low' : 'medium')
  return tight ? cap('medium') : current
}

/** Output longer than this is judged for trimming: the base, shrunk under pressure. */
export function trimOverFor(level: Level, base: number): number {
  const factor = { normal: 1, elevated: 0.75, high: 0.5, critical: 0.35 }[level]
  return Math.round(base * factor)
}

/** The context fill at which a boundary compaction is wanted, lowered under pressure. */
export function compactAtFor(level: Level, base: number): number {
  const minus = { normal: 0, elevated: 10, high: 20, critical: 30 }[level]
  return Math.max(20, base - minus)
}

export const describePressure = (p: Pressure) => (p.level === 'normal' ? '' : `budget ${p.level}: ${p.percent}% of the ${p.window} window used`)
