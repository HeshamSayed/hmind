// Self-calibrating trust: how much a local answer of each kind is believed
// without asking Claude, learned from evidence rather than fixed for good.
//
// Evidence arrives two ways. When a local answer stands, a sample of them
// (`shadowRate`) is also sent to Claude and the two are compared. When a
// question escalates anyway, the local attempt that lost is compared with
// Claude's answer for free. Outcome labels (`/hmind right|wrong`) count too.
// Every ten samples of a kind, its trust moves one step: down when the local
// tier agreed with Claude at least 90% of the time, up when under 80%.

import type { EngineInterface } from 'claude-code'

export type TrustState = {
  trust: Record<string, number>
  samples: Record<string, { n: number; agree: number }>
  adjustments: { kind: string; from: number; to: number; at: string }[]
  /** lifetime counters for the stats line */
  checks: number
  agreements: number
}

const KEY = 'trust'
export const WINDOW = 10
export const STEP = 0.05
export const FLOOR = 0.6
export const SAMPLE_BAR = 0.75

const round2 = (n: number) => Math.round(n * 100) / 100

export async function loadTrust($: EngineInterface, defaults: Record<string, number>): Promise<TrustState> {
  const raw = (await $.store.get(KEY)) as Partial<TrustState> | undefined
  return {
    trust: { ...defaults, ...(raw?.trust ?? {}) },
    samples: raw?.samples ?? {},
    adjustments: raw?.adjustments ?? [],
    checks: raw?.checks ?? 0,
    agreements: raw?.agreements ?? 0,
  }
}

export async function resetTrust($: EngineInterface): Promise<void> {
  await $.store.delete(KEY)
}

/** Record one comparison for a kind; returns the adjustment it triggered, if any. */
export async function recordSample($: EngineInterface, t: TrustState, kind: string, agreed: boolean): Promise<{ from: number; to: number } | undefined> {
  const s = t.samples[kind] ?? { n: 0, agree: 0 }
  s.n += 1
  if (agreed) s.agree += 1
  t.samples[kind] = s
  t.checks += 1
  if (agreed) t.agreements += 1
  let changed: { from: number; to: number } | undefined
  if (s.n >= WINDOW) {
    const rate = s.agree / s.n
    const from = t.trust[kind] ?? 0.75
    let to = from
    if (rate >= 0.9) to = Math.max(FLOOR, round2(from - STEP))
    else if (rate < 0.8) to = Math.min(1, round2(from + STEP))
    if (to !== from) {
      t.trust[kind] = to
      t.adjustments = [...t.adjustments, { kind, from, to, at: new Date().toISOString() }].slice(-50)
      changed = { from, to }
    }
    t.samples[kind] = { n: 0, agree: 0 }
  }
  await $.store.set(KEY, t)
  return changed
}

export function describeTrust(t: TrustState): string {
  const kinds = Object.entries(t.trust).filter(([k]) => k !== 'default')
  const parts = kinds.map(([k, v]) => {
    const s = t.samples[k]
    return `${k} ${v >= 1 ? 'never' : v}${s && s.n ? ` (${s.agree}/${s.n} agree)` : ''}`
  })
  const last = t.adjustments.at(-1)
  return `${parts.join(', ')}${last ? `; last change ${last.kind} ${last.from}→${last.to}` : ''}`
}
