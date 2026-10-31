// The usage ledger: every model call the session makes, by who made it and on which model,
// with the tokens it cost at list price; the local judge's own token counts; and the tokens
// Hmind kept out of the context window, priced by what re-reading them would have cost.
// Two copies live in the store: this session's (keyed by when it began) and all sessions'.

import type { EngineInterface } from 'claude-code'

import { fmt, money, priceOf, resolveModel, usdOf } from './pricing'
import type { Usage } from './pricing'

export type Who = 'main' | 'subagent' | 'routed' | 'compact' | 'judge' | 'digest'

export type Line = {
  who: Who
  model: string
  calls: number
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
  usd: number
  /** routed subagents: what the same tokens would have cost on the parent model */
  insteadUsd: number
}

export type Ledger = {
  since: string
  lines: Record<string, Line>
  local: { calls: number; prompt: number; output: number }
  avoided: {
    /** tokens currently kept out of the live window (reset by a compaction) */
    tokens: number
    /** of those, not yet charged their first re-read at the cache-write rate */
    fresh: number
    /** all tokens ever kept out */
    total: number
    rereads: number
    rereadTokens: number
    usd: number
  }
  /** main-loop requests counted */
  requests: number
  /** actions that save tokens but cannot be priced honestly */
  notPriced: { effortLowered: number; compactions: number }
}

const ALL = 'ledger'
let sessionKey = 'ledger:session'
let chain: Promise<void> = Promise.resolve()

export const emptyLedger = (): Ledger => ({
  since: new Date().toISOString(),
  lines: {},
  local: { calls: 0, prompt: 0, output: 0 },
  avoided: { tokens: 0, fresh: 0, total: 0, rereads: 0, rereadTokens: 0, usd: 0 },
  requests: 0,
  notPriced: { effortLowered: 0, compactions: 0 },
})

/** Name this session's ledger; `startedAt` stays the same across a resume. */
export function setLedgerSession(key: string): void {
  sessionKey = `ledger:${key}`
}

export async function loadLedger($: EngineInterface, scope: 'session' | 'all'): Promise<Ledger> {
  const raw = (await $.store.get(scope === 'all' ? ALL : sessionKey)) as Partial<Ledger> | undefined
  const e = emptyLedger()
  if (!raw) return e
  return { ...e, ...raw, lines: raw.lines ?? {}, local: { ...e.local, ...(raw.local ?? {}) }, avoided: { ...e.avoided, ...(raw.avoided ?? {}) }, notPriced: { ...e.notPriced, ...(raw.notPriced ?? {}) } }
}

export async function clearLedgers($: EngineInterface): Promise<void> {
  await $.store.set(ALL, emptyLedger())
  await $.store.set(sessionKey, emptyLedger())
}

/** Apply one change to both ledgers, serialized so hooks running at once never lose an increment. */
export function updateLedger($: EngineInterface, fn: (l: Ledger) => void): Promise<void> {
  const run = async () => {
    for (const scope of ['session', 'all'] as const) {
      const l = await loadLedger($, scope)
      fn(l)
      await $.store.set(scope === 'all' ? ALL : sessionKey, l)
    }
  }
  chain = chain.then(run, run).catch(() => undefined)
  return chain
}

/** One Claude call (or a turn of `calls` requests) by `who` on `model`; `insteadOf` prices the counterfactual for a routed subagent. */
export async function recordModelCall($: EngineInterface, who: Who, model: string, u: Usage, calls = 1, insteadOf?: string): Promise<void> {
  const id = resolveModel(model)
  const usd = usdOf(id, u)
  const insteadUsd = insteadOf ? usdOf(resolveModel(insteadOf), u) : 0
  await updateLedger($, l => {
    const key = `${who}|${id}`
    const line = (l.lines[key] ??= { who, model: id, calls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, usd: 0, insteadUsd: 0 })
    line.calls += calls
    line.input += u.input_tokens
    line.cacheWrite += u.cache_creation_input_tokens
    line.cacheRead += u.cache_read_input_tokens
    line.output += u.output_tokens
    line.usd += usd
    line.insteadUsd += insteadUsd
  })
}

/** The local judge's calls and the tokens it processed (free, but counted). */
export async function recordLocalCalls($: EngineInterface, calls: number, prompt: number, output: number): Promise<void> {
  await updateLedger($, l => {
    l.local.calls += calls
    l.local.prompt += prompt
    l.local.output += output
  })
}

/** Characters of tool output Hmind kept out of the window (about 4 characters per token). */
export async function recordAvoided($: EngineInterface, chars: number): Promise<void> {
  const tokens = Math.round(chars / 4)
  await updateLedger($, l => {
    l.avoided.tokens += tokens
    l.avoided.fresh += tokens
    l.avoided.total += tokens
  })
}

/** A main-loop request on `model`: the avoided tokens would have ridden along, written once, then read from the cache. */
export async function recordRequest($: EngineInterface, model: string): Promise<void> {
  const p = priceOf(model)
  await updateLedger($, l => {
    l.requests += 1
    if (l.avoided.tokens <= 0) return
    l.avoided.rereads += 1
    l.avoided.rereadTokens += l.avoided.tokens
    if (p) l.avoided.usd += (l.avoided.fresh * p.cacheWrite + (l.avoided.tokens - l.avoided.fresh) * p.cacheRead) / 1e6
    l.avoided.fresh = 0
  })
}

/** After a compaction the trimmed output would have been summarized away anyway. */
export async function resetAvoided($: EngineInterface): Promise<void> {
  await updateLedger($, l => {
    l.avoided.tokens = 0
    l.avoided.fresh = 0
  })
}

// ---------------------------------------------------------------- text

const WHO_LABEL: Record<Who, string> = { main: 'main loop', subagent: 'subagents', routed: 'routed by Hmind', compact: 'compaction', judge: 'Hmind judge', digest: 'Hmind digest' }
const ORDER: Who[] = ['main', 'subagent', 'routed', 'compact', 'judge', 'digest']

export type LedgerExtras = { title: string; localModel: string; cliUsd?: number }

export type LedgerSummary = { claudeUsd: number; ownUsd: number; savedUsd: number; mainModel: string; requests: number }

export function summarize(l: Ledger): LedgerSummary {
  const lines = Object.values(l.lines)
  const sum = (f: (r: Line) => boolean) => lines.filter(f).reduce((s, r) => s + r.usd, 0)
  const routedSaved = lines.filter(r => r.who === 'routed').reduce((s, r) => s + r.insteadUsd - r.usd, 0)
  const main = lines.filter(r => r.who === 'main').sort((a, b) => b.calls - a.calls)[0]
  return { claudeUsd: sum(() => true), ownUsd: sum(r => r.who === 'judge' || r.who === 'digest'), savedUsd: l.avoided.usd + routedSaved, mainModel: main?.model ?? '', requests: l.requests }
}

const cell = (s: string, w: number, right = true) => (right ? s.padStart(w) : s.padEnd(w))
const row = (who: string, model: string, calls: string, input: string, write: string, read: string, output: string, cost: string) =>
  `  ${cell(who, 16, false)} ${cell(model.slice(0, 24), 24, false)} ${cell(calls, 6)} ${cell(input, 10)} ${cell(write, 12)} ${cell(read, 12)} ${cell(output, 9)} ${cell(cost, 10)}`

export function ledgerText(l: Ledger, x: LedgerExtras): string {
  const lines = Object.values(l.lines).sort((a, b) => ORDER.indexOf(a.who) - ORDER.indexOf(b.who) || b.usd - a.usd)
  const s = summarize(l)
  const out = [`${x.title} (since ${l.since.slice(0, 16).replace('T', ' ')})`, row('who', 'model', 'calls', 'input', 'cache write', 'cache read', 'output', 'est. cost')]
  for (const r of lines) {
    const note = r.who === 'routed' && r.insteadUsd > 0 ? `  (≈ ${money(r.insteadUsd)} on the parent model)` : priceOf(r.model) ? '' : '  (no list price known)'
    out.push(row(WHO_LABEL[r.who], r.model, fmt(r.calls), fmt(r.input), fmt(r.cacheWrite), fmt(r.cacheRead), fmt(r.output), money(r.usd)) + note)
  }
  if (l.local.calls > 0) out.push(row('Hmind local', x.localModel, fmt(l.local.calls), fmt(l.local.prompt), '', '', fmt(l.local.output), 'free') + '  (on this machine)')
  if (lines.length === 0 && l.local.calls === 0) out.push('  no model calls recorded yet.')
  out.push(row('total Claude', '', '', '', '', '', '', money(s.claudeUsd)) + (x.cliUsd !== undefined ? `  (the CLI's own ledger: ${money(x.cliUsd)})` : ''))
  const main = lines.filter(r => r.who === 'main')
  const mainIn = main.reduce((a, r) => a + r.input + r.cacheWrite + r.cacheRead, 0)
  const cached = main.reduce((a, r) => a + r.cacheRead, 0)
  if (mainIn > 0) out.push(`  main loop: ${fmt(l.requests)} requests, ${fmt(mainIn)} input tokens, ${Math.round((cached / mainIn) * 100)}% served from the prompt cache`)
  const routed = lines.filter(r => r.who === 'routed')
  const routedUsd = routed.reduce((a, r) => a + r.usd, 0)
  const routedInstead = routed.reduce((a, r) => a + r.insteadUsd, 0)
  const net = s.savedUsd - s.ownUsd
  out.push('Savings estimate:')
  out.push(
    l.avoided.total > 0
      ? `  trimmed output: ≈ ${fmt(l.avoided.total)} tokens kept out of the context window, re-read by ${fmt(l.avoided.rereads)} later requests (${fmt(l.avoided.rereadTokens)} cached tokens avoided) ≈ ${money(l.avoided.usd)}`
      : '  trimmed output: nothing trimmed yet',
  )
  out.push(
    routed.length > 0
      ? `  cheaper subagents: ${fmt(routed.reduce((a, r) => a + r.calls, 0))} requests on ${routed.map(r => r.model).join(', ')} for ${money(routedUsd)} instead of ≈ ${money(routedInstead)} on the parent model: ${money(routedInstead - routedUsd)}`
      : '  cheaper subagents: none routed yet',
  )
  out.push(`  Hmind's own Claude calls: ${money(s.ownUsd)}`)
  out.push(`  net ≈ ${money(Math.abs(net))} ${net >= 0 ? 'saved' : 'spent'}; not priced: effort lowered on ${l.notPriced.effortLowered} turns, ${l.notPriced.compactions} boundary compactions`)
  out.push('  List API prices per model, cache writes at the 5-minute rate; on a subscription this is plan usage, not a bill.')
  return out.join('\n')
}
