// List prices per million tokens, in US dollars, behind the estimate `/hmind usage` prints.
// Cache writes are priced at the 5-minute rate (1.25x input). Haiku 5.5 has a second tier
// above 100K prompt tokens. Older lines stay for sessions pinned to them. A model no row
// matches is counted in tokens and shown as unpriced.

export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

const ALIASES: Record<string, string> = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-1' }

const TABLE: [RegExp, Price][] = [
  [/fable-5-1|mythos-5-1/, { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }],
  [/fable|mythos/, { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }],
  [/opus-5-5/, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }],
  [/opus-5|opus-4-[5-8]/, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  [/opus/, { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  [/sonnet-5/, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
  [/sonnet/, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  [/haiku-5/, { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }],
  [/haiku-4/, { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
  [/haiku/, { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }],
]
const HAIKU_5_LONG: Price = { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }

/** An alias (`haiku`) to the id it means today; an id comes back as is. */
export const resolveModel = (model: string): string => ALIASES[model.trim().toLowerCase()] ?? model.trim()

export function priceOf(model: string, promptTokens = 0): Price | undefined {
  const id = resolveModel(model).toLowerCase()
  if (/haiku-5/.test(id) && promptTokens > 100000) return HAIKU_5_LONG
  for (const [re, p] of TABLE) if (re.test(id)) return p
  return undefined
}

/** What one call cost at list price; 0 for a model without a known price. */
export function usdOf(model: string, u: Usage): number {
  const p = priceOf(model, u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens)
  if (!p) return 0
  return (u.input_tokens * p.input + u.output_tokens * p.output + u.cache_read_input_tokens * p.cacheRead + u.cache_creation_input_tokens * p.cacheWrite) / 1e6
}

export const fmt = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
export const money = (usd: number) => (usd === 0 ? '$0.00' : Math.abs(usd) < 0.005 ? `${usd < 0 ? '-' : ''}<$0.01` : `${usd < 0 ? '-' : ''}$${Math.abs(usd).toFixed(2)}`)
