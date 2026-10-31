// Governance of the subagents the model launches itself: a cap on how many run at
// once, a check that a new task is not the work of one already running, a digest of
// long reports before they re-enter the parent's context, and an account per agent.

import type { AgentInfo, EngineInterface } from 'claude-code'

import { duration } from './orchestrate'
import { fmt, money } from './pricing'
import type { Usage } from './pricing'

export type AgentNote = { id: string; description: string; prompt: string; model: string; startedAt: number; endedAt?: number; usage: Usage; usd: number; ours: boolean }

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4))

/** Word overlap of two task descriptions, 0..1 (Jaccard). */
export function overlap(a: string, b: string): number {
  const x = words(a)
  const y = words(b)
  if (x.size === 0 || y.size === 0) return 0
  let both = 0
  for (const w of x) if (y.has(w)) both += 1
  return both / (x.size + y.size - both)
}

export const isActive = (a: AgentInfo): boolean => a.status === 'running' || a.status === 'pending' || a.status === 'waiting'

/** Wait until fewer than `cap` agents are active, polling every two seconds, at most `maxWaitMs` (a hook's own time is bounded); returns how long it waited and what is still active. */
export async function waitForSlot($: EngineInterface, cap: number, maxWaitMs: number): Promise<{ waited: number; active: AgentInfo[] }> {
  const started = await $.clock.now()
  for (;;) {
    const active = (await $.agent.list().catch(() => [] as AgentInfo[])).filter(isActive)
    const waited = (await $.clock.now()) - started
    if (active.length < cap || waited >= maxWaitMs) return { waited, active }
    await $.clock.sleep(2000)
  }
}

export function agentsText(list: AgentInfo[], notes: Map<string, AgentNote>, now: number): string {
  const ids = new Set<string>([...list.map(a => a.id), ...notes.keys()])
  if (ids.size === 0) return 'no agents this session.'
  const rows = [...ids].map(id => {
    const a = list.find(x => x.id === id)
    const n = notes.get(id)
    const status = a?.status ?? (n?.endedAt ? 'completed' : 'unknown')
    const ms = n ? (n.endedAt ?? now) - n.startedAt : 0
    const tokens = n ? n.usage.input_tokens + n.usage.cache_read_input_tokens + n.usage.cache_creation_input_tokens + n.usage.output_tokens : 0
    return `  ${id.slice(0, 10).padEnd(10)} ${status.padEnd(9)} ${(n?.model ?? '?').slice(0, 22).padEnd(22)} ${duration(ms).padStart(6)} ${fmt(tokens).padStart(9)} ${money(n?.usd ?? 0).padStart(7)}  ${n?.ours ? 'Hmind' : 'model'}  ${(a?.description ?? n?.description ?? '').slice(0, 40)}`
  })
  return `agents this session (status, model, time, tokens, est. cost, launched by, task):\n${rows.join('\n')}`
}
