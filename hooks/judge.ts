// The typed-decision engine behind Hmind.
//
// Typed questions over one state go to a Claude model (haiku by default) through the
// session's own client, which reads the whole state with real understanding and answers
// every question with an option, a confidence and a short reason. Every answer carries
// probabilities; callers fail open: no confident answer means "do nothing".

import type { EngineInterface } from 'claude-code'

import { recordModelCall } from './ledger'

export type Question =
  | { id: string; type: 'noul'; statement: string }
  | { id: string; type: 'choice'; question: string; options: readonly string[] }
  | { id: string; type: 'score'; question: string }

export type Answer = {
  id: string
  type: Question['type']
  /** choice: the option picked; noul: 'yes' | 'no' */
  choice?: string
  /** choice: probability per option; noul: { yes, no } */
  probabilities?: Record<string, number>
  /** noul: P(statement is true) */
  p?: number
  /** score: 0..1 expected value */
  score?: number
  /** how sure: the probability of the option picked */
  confidence: number
  tier: 'claude' | 'none'
  ms: number
  why?: string
}

export type JudgeConfig = {
  judgeModel: string
  confidence: number
  timeoutMs: number
}

export const defaultConfig = (o: Readonly<Record<string, unknown>>): JudgeConfig => ({
  judgeModel: String(o.judgeModel ?? 'haiku'),
  confidence: clamp(Number(o.confidence ?? 0.75), 0.5, 0.99),
  timeoutMs: 12000,
})

const LETTERS = 'ABCDEFGHIJ'
const SCORE_OPTIONS = ['0 (not at all)', '0.25 (slightly)', '0.5 (somewhat)', '0.75 (mostly)', '1 (completely)']
const SCORE_VALUES = [0, 0.25, 0.5, 0.75, 1]

export const clamp = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo)

const optionsOf = (q: Question): readonly string[] =>
  q.type === 'noul' ? ['yes', 'no'] : q.type === 'choice' ? q.options : SCORE_OPTIONS

const questionText = (q: Question): string =>
  q.type === 'noul' ? `Is this statement true?\n${q.statement}` : q.question

const round = (n: number) => Math.round(n * 1000) / 1000

function answerFrom(q: Question, options: readonly string[], probs: number[], ms: number, why?: string): Answer {
  const probabilities: Record<string, number> = {}
  options.forEach((o, i) => (probabilities[o] = round(probs[i] ?? 0)))
  const best = probs.reduce((b, p, i, arr) => (p > (arr[b] ?? 0) ? i : b), 0)
  const top = probs[best] ?? 0
  if (q.type === 'noul') {
    const p = probs[0] ?? 0
    return { id: q.id, type: q.type, choice: p >= 0.5 ? 'yes' : 'no', probabilities, p: round(p), confidence: round(Math.max(p, 1 - p)), tier: 'claude', ms, why }
  }
  if (q.type === 'score') {
    const score = probs.reduce((acc, p, i) => acc + p * (SCORE_VALUES[i] ?? 0), 0)
    return { id: q.id, type: q.type, probabilities, score: round(score), confidence: round(top), tier: 'claude', ms, why }
  }
  return { id: q.id, type: q.type, choice: options[best] ?? '', probabilities, confidence: round(top), tier: 'claude', ms, why }
}

async function claudeAnswers($: EngineInterface, cfg: JudgeConfig, state: string, questions: Question[]): Promise<Map<string, Answer>> {
  const started = await $.clock.now()
  const spec = questions
    .map(q => {
      const opts = optionsOf(q).map((o, i) => `${LETTERS[i]}) ${o}`).join(' | ')
      return `- id "${q.id}": ${questionText(q).replace(/\n/g, ' ')}\n  options: ${opts}`
    })
    .join('\n')
  const system =
    'You are a careful judge inside a software engineering tool. You answer typed questions about a STATE. ' +
    'For every question output exactly one JSON object on its own line: {"id":"<id>","answer":"<option letter>","confidence":<0..1>,"why":"<at most 12 words>"}. ' +
    'confidence is the probability that your answer is right. No prose, no markdown, nothing but the JSON lines.'
  const prompt = `STATE:\n${state}\n\nQUESTIONS:\n${spec}\n\nAnswer every id, one JSON object per line.`
  const r = await $.model.complete({ model: cfg.judgeModel, system, prompt, effort: 'low', maxTokens: 60 + 60 * questions.length, timeoutMs: cfg.timeoutMs })
  await recordModelCall($, 'judge', cfg.judgeModel, r.usage).catch(() => undefined)
  const out = new Map<string, Answer>()
  if (!r.isAnswered) return out
  const ms = (await $.clock.now()) - started
  for (const line of r.text.split('\n')) {
    const m = line.match(/\{.*\}/)
    if (!m) continue
    let parsed: { id?: string; answer?: string; confidence?: number; why?: string }
    try {
      parsed = JSON.parse(m[0])
    } catch {
      continue
    }
    const q = questions.find(x => x.id === parsed.id)
    if (!q || typeof parsed.answer !== 'string') continue
    const options = optionsOf(q)
    const letter = parsed.answer.trim().toUpperCase().slice(0, 1)
    let idx = LETTERS.indexOf(letter)
    if (idx < 0 || idx >= options.length) idx = options.findIndex(o => o.toLowerCase() === parsed.answer!.trim().toLowerCase())
    if (idx < 0) continue
    const conf = clamp(Number(parsed.confidence ?? 0.8), 0.5, 0.99)
    const rest = options.length > 1 ? (1 - conf) / (options.length - 1) : 0
    const probs = options.map((_, i) => (i === idx ? conf : rest))
    out.set(q.id, answerFrom(q, options, probs, ms, parsed.why))
  }
  return out
}

const none = (q: Question | undefined): Answer => ({ id: q?.id ?? '?', type: q?.type ?? 'noul', confidence: 0, tier: 'none', ms: 0 })

/**
 * Answer typed questions over one state. Never throws: a question nobody could
 * answer comes back with tier 'none' and confidence 0.
 */
export async function decide($: EngineInterface, cfg: JudgeConfig, state: string, questions: Question[]): Promise<Answer[]> {
  const clipped = state.length > 24000 ? `${state.slice(0, 16000)}\n…[${state.length - 20000} chars omitted]…\n${state.slice(-4000)}` : state
  const m = await claudeAnswers($, cfg, clipped, questions).catch(() => new Map<string, Answer>())
  return questions.map(q => m.get(q.id) ?? none(q))
}

/** `decide` for a single question: always one Answer back. */
export async function decideOne($: EngineInterface, cfg: JudgeConfig, state: string, questions: Question[]): Promise<Answer> {
  const [a] = await decide($, cfg, state, questions)
  return a ?? none(questions[0])
}

/** True when the answer is usable for an automatic action. */
export const isConfident = (a: Answer | undefined, threshold: number): a is Answer => !!a && a.tier !== 'none' && a.confidence >= threshold

// ---------------------------------------------------------------- stats

export type Stats = {
  decisions: number
  unanswered: number
  claudeMs: number
  trims: number
  trimmedChars: number
  trimRegrets: number
  denies: number
  effortLowered: number
  unverifiedClaims: number
  compactions: number
  enabled: boolean
  digests: number
  subagentsRouted: number
  forkWarnings: number
  verifications: number
  verificationsFailed: number
  rulesApplied: number
  rulesLearned: number
  orchestrations: number
  agentsHeld: number
  agentsDeduped: number
  reportsDigested: number
}

export const emptyStats = (): Stats => ({
  decisions: 0,
  unanswered: 0,
  claudeMs: 0,
  trims: 0,
  trimmedChars: 0,
  trimRegrets: 0,
  denies: 0,
  effortLowered: 0,
  unverifiedClaims: 0,
  compactions: 0,
  enabled: true,
  digests: 0,
  subagentsRouted: 0,
  forkWarnings: 0,
  verifications: 0,
  verificationsFailed: 0,
  rulesApplied: 0,
  rulesLearned: 0,
  orchestrations: 0,
  agentsHeld: 0,
  agentsDeduped: 0,
  reportsDigested: 0,
})

export async function loadStats($: EngineInterface): Promise<Stats> {
  const raw = (await $.store.get('stats')) as Partial<Stats> | undefined
  return { ...emptyStats(), ...(raw ?? {}) }
}

export async function bumpStats($: EngineInterface, fn: (s: Stats) => void): Promise<Stats> {
  const s = await loadStats($)
  fn(s)
  await $.store.set('stats', s)
  return s
}

/** Count a batch of answers and what they took. */
export async function recordAnswers($: EngineInterface, answers: Answer[]): Promise<void> {
  await bumpStats($, s => {
    for (const a of answers) {
      s.decisions += 1
      if (a.tier === 'none') s.unanswered += 1
      else s.claudeMs += a.ms
    }
  })
}

export type DecisionRecord = {
  at: string
  kind: string
  summary: string
  answers: Answer[]
  outcome?: 'right' | 'wrong'
  id: string
}

/** Keep the last 200 decisions in the store for `/hmind log`. */
export async function remember($: EngineInterface, rec: DecisionRecord): Promise<void> {
  const list = ((await $.store.get('recent')) as DecisionRecord[] | undefined) ?? []
  list.push(rec)
  await $.store.set('recent', list.slice(-200))
}

export async function markOutcome($: EngineInterface, id: string, outcome: 'right' | 'wrong'): Promise<boolean> {
  const list = ((await $.store.get('recent')) as DecisionRecord[] | undefined) ?? []
  const rec = list.find(r => r.id === id)
  if (!rec) return false
  rec.outcome = outcome
  await $.store.set('recent', list)
  return true
}

/** Accuracy and calibration over the decisions that have an outcome. */
export async function calibration($: EngineInterface): Promise<{ labeled: number; accuracy: number; ece: number }> {
  const list = ((await $.store.get('recent')) as DecisionRecord[] | undefined) ?? []
  const labeled = list.filter(r => r.outcome && r.answers.length > 0)
  if (labeled.length === 0) return { labeled: 0, accuracy: 0, ece: 0 }
  const bins = new Map<number, { n: number; conf: number; right: number }>()
  let right = 0
  for (const r of labeled) {
    const a = r.answers[0]
    if (!a) continue
    const isRight = r.outcome === 'right'
    if (isRight) right += 1
    const bin = Math.min(9, Math.floor(a.confidence * 10))
    const b = bins.get(bin) ?? { n: 0, conf: 0, right: 0 }
    b.n += 1
    b.conf += a.confidence
    b.right += isRight ? 1 : 0
    bins.set(bin, b)
  }
  let ece = 0
  for (const b of bins.values()) ece += (b.n / labeled.length) * Math.abs(b.conf / b.n - b.right / b.n)
  return { labeled: labeled.length, accuracy: round(right / labeled.length), ece: round(ece) }
}
