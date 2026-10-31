// Approximates the Claude tier on the same cases with one batched `claude -p` call per kind.
// Usage: node haiku.mts [model alias]
import { spawnSync } from 'node:child_process'
import { cases as baseCases, report, tally } from './cases.mts'
import { agentCases } from './cases-agents.mts'

const cases = [...baseCases, ...agentCases]
const model = process.argv[2] ?? 'haiku'
const LETTERS = 'ABCDEFGHIJ'
const optionsOf = (q: any): string[] => (q.type === 'noul' ? ['yes', 'no'] : q.options)
const byKind = tally()
const wrongs: string[] = []
const kinds = [...new Set(cases.map(c => c.kind))]
for (const kind of kinds) {
  const items = cases.filter(c => c.kind === kind)
  const spec = items
    .map((c, i) => {
      const opts = optionsOf(c.q).map((o, j) => `${LETTERS[j]}) ${o}`).join(' | ')
      const qtext = c.q.type === 'noul' ? `Is this statement true?\n${(c.q as any).statement}` : (c.q as any).question
      return `### item ${i}\nSTATE:\n${c.state}\n\nQUESTION: ${qtext}\nOPTIONS: ${opts}`
    })
    .join('\n\n')
  const prompt =
    'You are a careful judge inside a software engineering tool. For every item below, output exactly one JSON object on its own line: ' +
    '{"id":<item number>,"answer":"<option letter>","confidence":<0..1>}. confidence is the probability that your answer is right. No prose, nothing but JSON lines.\n\n' +
    spec
  const t0 = Date.now()
  const r = spawnSync('claude', ['-p', '--model', model, '--output-format', 'text', '--no-session-persistence', prompt], { encoding: 'utf8', maxBuffer: 1 << 24, shell: process.platform === 'win32' })
  const ms = Date.now() - t0
  const answers = new Map<number, { letter: string; confidence: number }>()
  for (const line of (r.stdout ?? '').split('\n')) {
    const m = line.match(/\{.*\}/)
    if (!m) continue
    try {
      const p = JSON.parse(m[0])
      answers.set(Number(p.id), { letter: String(p.answer).trim().toUpperCase().slice(0, 1), confidence: Number(p.confidence ?? 0.8) })
    } catch {}
  }
  const k = { n: 0, right: 0, confRight: [] as number[], confWrong: [] as number[], covered: 0, coveredRight: 0, ms: 0 }
  items.forEach((c, i) => {
    const a = answers.get(i)
    const opts = optionsOf(c.q)
    const got = a ? opts[LETTERS.indexOf(a.letter)] ?? '' : ''
    const conf = a?.confidence ?? 0
    const right = got === c.label
    k.n += 1
    k.ms += ms / items.length
    if (right) k.right += 1
    ;(right ? k.confRight : k.confWrong).push(conf)
    if (conf >= 0.75) {
      k.covered += 1
      if (right) k.coveredRight += 1
    }
    if (!right) wrongs.push(`  [${kind}] got "${got.slice(0, 28)}" (conf ${conf}) wanted "${c.label.slice(0, 28)}" :: ${c.short.slice(0, 60)}`)
  })
  byKind.set(kind, k)
  if (r.status !== 0) console.error(`claude -p failed for ${kind}: ${r.stderr?.slice(0, 300)}`)
}
report(`claude tier (${model}, batched per kind): ${cases.length} cases`, byKind, 0.75, wrongs)
