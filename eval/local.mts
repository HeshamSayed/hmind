// Measures the Hmind judge's local tier against the labeled cases, outside the engine.
// Usage: node run.mts [ollamaModel]
import { decide, defaultConfig } from '../hooks/judge.ts'
import { cases, report, tally } from './cases.mts'

const model = process.argv[2] ?? 'qwen2.5:1.5b-instruct'
const store = new Map<string, unknown>()
const $: any = {
  http: {
    fetch: async (url: string, init: any = {}) => {
      const r = await fetch(url, { method: init.method ?? 'GET', headers: init.headers, body: init.body })
      return { status: r.status, ok: r.ok, headers: {}, text: await r.text() }
    },
  },
  clock: { now: async () => Date.now(), sleep: (ms: number) => new Promise(res => setTimeout(res, ms)) },
  model: { complete: async () => ({ isAnswered: false, reason: 'api-error', status: null, error: 'unknown', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) },
  store: { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => void store.set(k, v) },
}
const cfg = { ...defaultConfig({ ollamaModel: model }), escalate: false, localTimeoutMs: 20000 }
const threshold = 0.75
const byKind = tally()
const wrongs: string[] = []
const t0 = Date.now()
for (const c of cases) {
  const [a] = await decide($, cfg, c.state, [c.q])
  const got = a!.choice ?? ''
  const right = got === c.label
  const k = byKind.get(c.kind) ?? { n: 0, right: 0, confRight: [], confWrong: [], covered: 0, coveredRight: 0, ms: 0 }
  k.n += 1
  k.ms += a!.ms
  if (right) k.right += 1
  ;(right ? k.confRight : k.confWrong).push(a!.confidence)
  if (a!.confidence >= threshold) {
    k.covered += 1
    if (right) k.coveredRight += 1
  }
  byKind.set(c.kind, k)
  if (!right) wrongs.push(`  [${c.kind}] got "${got.slice(0, 28)}" (conf ${a!.confidence}) wanted "${c.label.slice(0, 28)}" :: ${c.short.slice(0, 60)}`)
}
report(`local tier ${model}: ${cases.length} cases in ${Date.now() - t0} ms`, byKind, threshold, wrongs)
