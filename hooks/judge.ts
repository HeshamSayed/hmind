// The typed-decision engine behind the Hmind mod.
//
// Tier 1 ("local"): a small model served by Ollama answers with ONE token and
// we read the probability of each option off its logprobs. No text generation,
// no parsing. Position bias is removed by asking twice with the options in the
// opposite order and averaging. ~150-400 ms, free.
//
// Tier 2 ("claude"): when tier 1 is unsure (or down), the same questions go to
// a Claude model through the session's own client ($.model.complete), which
// reads the whole state with real understanding. A few seconds, cheap.
//
// Every answer carries probabilities, a confidence and the tier that produced
// it. Callers fail open: no confident answer means "do nothing".

import type { EngineInterface } from 'claude-code'

import { recordLocalCalls, recordModelCall } from './ledger'

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
  /** how sure: max probability (choice, noul) or peakedness (score) */
  confidence: number
  tier: 'local' | 'claude' | 'none'
  ms: number
  why?: string
  /** on a Claude answer: the local attempt it replaced, kept for calibration */
  shadow?: Answer
}

export type JudgeConfig = {
  ollamaUrl: string
  ollamaModel: string
  escalateModel: string
  escalate: boolean
  confidence: number
  /** temperature applied to local logits per question type; 1 = raw */
  temperature: Record<Question['type'], number>
  localTimeoutMs: number
  claudeTimeoutMs: number
}

export const defaultConfig = (o: Readonly<Record<string, unknown>>): JudgeConfig => ({
  ollamaUrl: String(o.ollamaUrl ?? 'http://127.0.0.1:11434').replace(/\/$/, ''),
  ollamaModel: String(o.ollamaModel ?? 'qwen2.5:1.5b-instruct'),
  escalateModel: String(o.escalateModel ?? 'haiku'),
  escalate: o.escalate !== false,
  confidence: clamp(Number(o.confidence ?? 0.75), 0.5, 0.99),
  temperature: { noul: 1, choice: 1, score: 1 },
  localTimeoutMs: 2500,
  claudeTimeoutMs: 12000,
})

const LETTERS = 'ABCDEFGHIJ'
const SCORE_OPTIONS = ['0 (not at all)', '0.25 (slightly)', '0.5 (somewhat)', '0.75 (mostly)', '1 (completely)']
const SCORE_VALUES = [0, 0.25, 0.5, 0.75, 1]

export const clamp = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo)

const optionsOf = (q: Question): readonly string[] =>
  q.type === 'noul' ? ['yes', 'no'] : q.type === 'choice' ? q.options : SCORE_OPTIONS

const questionText = (q: Question): string =>
  q.type === 'noul' ? `Is this statement true?\n${q.statement}` : q.question

/** Soft-max over logits with a temperature; missing options get a floor. */
function softmax(logits: number[], temperature: number): number[] {
  const t = Math.max(0.05, temperature)
  const max = Math.max(...logits)
  const exps = logits.map(l => Math.exp((l - max) / t))
  const sum = exps.reduce((a, b) => a + b, 0)
  return exps.map(x => x / sum)
}

function answerFrom(q: Question, options: readonly string[], probs: number[], tier: Answer['tier'], ms: number, why?: string): Answer {
  const probabilities: Record<string, number> = {}
  options.forEach((o, i) => (probabilities[o] = round(probs[i] ?? 0)))
  const best = probs.reduce((b, p, i, arr) => (p > (arr[b] ?? 0) ? i : b), 0)
  const top = probs[best] ?? 0
  if (q.type === 'noul') {
    const p = probs[0] ?? 0
    return { id: q.id, type: q.type, choice: p >= 0.5 ? 'yes' : 'no', probabilities, p: round(p), confidence: round(Math.max(p, 1 - p)), tier, ms, why }
  }
  if (q.type === 'score') {
    const score = probs.reduce((acc, p, i) => acc + p * (SCORE_VALUES[i] ?? 0), 0)
    return { id: q.id, type: q.type, probabilities, score: round(score), confidence: round(top), tier, ms, why }
  }
  return { id: q.id, type: q.type, choice: options[best] ?? '', probabilities, confidence: round(top), tier, ms, why }
}

const round = (n: number) => Math.round(n * 1000) / 1000

// ---------------------------------------------------------------- tier 1

type LogprobEntry = { token: string; logprob: number }
type LocalReply = { byLetter: Map<string, number>; prompt: number; output: number }

/** Models Ollama refused `think: false` for (they take no thinking switch); asked once per model. */
const noThinkSwitch = new Set<string>()

async function localLogprobs(
  $: EngineInterface,
  cfg: JudgeConfig,
  state: string,
  q: Question,
  options: readonly string[],
): Promise<LocalReply | undefined> {
  const lines = options.map((o, i) => `${LETTERS[i]}) ${o}`).join('\n')
  const messages = [
    {
      role: 'system',
      content:
        'You are a strict classifier inside a software engineering tool. Read the STATE, then answer the QUESTION by choosing exactly one option. Reply with the option letter only.',
    },
    { role: 'user', content: `STATE:\n${state}\n\nQUESTION: ${questionText(q)}\nOPTIONS:\n${lines}\nAnswer with one letter:` },
  ]
  // Ollama's native endpoint: one token, its top logprobs, and thinking off so a
  // reasoning model answers with the letter instead of opening a thought channel.
  const call = (withThink: boolean) =>
    Promise.race([
      $.http.fetch(`${cfg.ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: cfg.ollamaModel,
          messages,
          stream: false,
          ...(withThink ? { think: false } : {}),
          logprobs: true,
          top_logprobs: 20,
          options: { num_predict: 1, temperature: 0 },
        }),
      }),
      $.clock.sleep(cfg.localTimeoutMs).then(() => undefined),
    ])
  let res = await call(!noThinkSwitch.has(cfg.ollamaModel))
  if (res && res.status === 400 && !noThinkSwitch.has(cfg.ollamaModel)) {
    // Ollama refuses `think` for a model without a thinking switch: ask once more without it.
    noThinkSwitch.add(cfg.ollamaModel)
    res = await call(false)
  }
  if (!res || !res.ok) return undefined
  const data = JSON.parse(res.text) as { logprobs?: { top_logprobs?: LogprobEntry[] }[]; prompt_eval_count?: number; eval_count?: number }
  const top = data.logprobs?.[0]?.top_logprobs
  if (!top || top.length === 0) return undefined
  const byLetter = new Map<string, number>()
  for (const { token, logprob } of top) {
    const letter = token.trim().toUpperCase().replace(/[^A-J]/g, '')
    if (letter.length !== 1) continue
    const i = LETTERS.indexOf(letter)
    if (i < 0 || i >= options.length) continue
    byLetter.set(letter, Math.max(byLetter.get(letter) ?? -Infinity, logprob))
  }
  return byLetter.size === 0 ? undefined : { byLetter, prompt: data.prompt_eval_count ?? 0, output: data.eval_count ?? 0 }
}

/** Ask once per ordering (forward and reversed) and average the probabilities. */
async function localAnswer($: EngineInterface, cfg: JudgeConfig, state: string, q: Question): Promise<Answer | undefined> {
  const started = await $.clock.now()
  const options = optionsOf(q)
  const reversed = [...options].reverse()
  const [fwd, rev] = await Promise.all([
    localLogprobs($, cfg, state, q, options),
    options.length <= 6 ? localLogprobs($, cfg, state, q, reversed) : Promise.resolve(undefined),
  ])
  if (!fwd) return undefined
  await recordLocalCalls($, rev ? 2 : 1, fwd.prompt + (rev?.prompt ?? 0), fwd.output + (rev?.output ?? 0)).catch(() => undefined)
  const toProbs = (m: Map<string, number>, order: readonly string[]): number[] => {
    const seen = [...m.values()]
    const floor = Math.min(...seen) - 4
    const logits = order.map((_, i) => m.get(LETTERS[i] ?? '') ?? floor)
    return softmax(logits, cfg.temperature[q.type])
  }
  let probs = toProbs(fwd.byLetter, options)
  if (rev) {
    const revProbs = toProbs(rev.byLetter, reversed).reverse()
    probs = probs.map((p, i) => (p + (revProbs[i] ?? p)) / 2)
  }
  const ms = (await $.clock.now()) - started
  return answerFrom(q, options, probs, 'local', ms)
}

// ---------------------------------------------------------------- tier 2

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
  const r = await $.model.complete({ model: cfg.escalateModel, system, prompt, effort: 'low', maxTokens: 60 + 60 * questions.length, timeoutMs: cfg.claudeTimeoutMs })
  await recordModelCall($, 'judge', cfg.escalateModel, r.usage).catch(() => undefined)
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
    out.set(q.id, answerFrom(q, options, probs, 'claude', ms, parsed.why))
  }
  return out
}

// ---------------------------------------------------------------- facade

export type DecideOptions = {
  /** override the escalation switch for this call */
  escalate?: boolean
  /** escalate when local confidence is below this (default cfg.confidence) */
  threshold?: number
}

/**
 * Answer typed questions over one state. Local first; the questions the local
 * tier is unsure about (or all of them when it is down) go to Claude when
 * escalation is on. Never throws: a question nobody could answer comes back
 * with tier 'none' and confidence 0.
 */
export async function decide($: EngineInterface, cfg: JudgeConfig, state: string, questions: Question[], opts: DecideOptions = {}): Promise<Answer[]> {
  const threshold = opts.threshold ?? cfg.confidence
  const escalate = opts.escalate ?? cfg.escalate
  const clipped = state.length > 24000 ? `${state.slice(0, 16000)}\n…[${state.length - 20000} chars omitted]…\n${state.slice(-4000)}` : state

  const locals = await Promise.all(questions.map(q => localAnswer($, cfg, clipped, q).catch(() => undefined)))
  const answers: (Answer | undefined)[] = [...locals]
  const unsure = questions.filter((_, i) => !answers[i] || answers[i]!.confidence < threshold)

  if (escalate && unsure.length > 0) {
    const better = await claudeAnswers($, cfg, clipped, unsure).catch(() => new Map<string, Answer>())
    questions.forEach((q, i) => {
      const b = better.get(q.id)
      if (b) answers[i] = { ...b, shadow: answers[i] }
    })
  }
  return questions.map((q, i) => answers[i] ?? { id: q.id, type: q.type, confidence: 0, tier: 'none', ms: 0 })
}

/** Claude's answers alone, for a shadow check of a local answer that stood. */
export async function decideClaude($: EngineInterface, cfg: JudgeConfig, state: string, questions: Question[]): Promise<Answer[]> {
  const m = await claudeAnswers($, cfg, state, questions).catch(() => new Map<string, Answer>())
  return questions.map(q => m.get(q.id) ?? { id: q.id, type: q.type, confidence: 0, tier: 'none', ms: 0 })
}

/** Whether two answers to the same question agree (scores within a quarter). */
export function agrees(a: Answer, b: Answer): boolean {
  if (a.tier === 'none' || b.tier === 'none') return false
  if (a.type === 'score') return Math.abs((a.score ?? 0) - (b.score ?? 0)) <= 0.25
  return a.choice === b.choice
}

/** `decide` for a single question: always one Answer back. */
export async function decideOne($: EngineInterface, cfg: JudgeConfig, state: string, questions: Question[], opts: DecideOptions = {}): Promise<Answer> {
  const [a] = await decide($, cfg, state, questions, opts)
  const q = questions[0]
  return a ?? { id: q?.id ?? '?', type: q?.type ?? 'noul', confidence: 0, tier: 'none', ms: 0 }
}

/** True when the answer is usable for an automatic action. */
export const isConfident = (a: Answer | undefined, threshold: number): a is Answer => !!a && a.tier !== 'none' && a.confidence >= threshold

// ---------------------------------------------------------------- stats

export type Stats = {
  decisions: number
  byTier: { local: number; claude: number; none: number }
  escalations: number
  localMs: number
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
}

export const emptyStats = (): Stats => ({
  decisions: 0,
  byTier: { local: 0, claude: 0, none: 0 },
  escalations: 0,
  localMs: 0,
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
})

export async function loadStats($: EngineInterface): Promise<Stats> {
  const raw = (await $.store.get('stats')) as Partial<Stats> | undefined
  return { ...emptyStats(), ...(raw ?? {}), byTier: { ...emptyStats().byTier, ...(raw?.byTier ?? {}) } }
}

export async function bumpStats($: EngineInterface, fn: (s: Stats) => void): Promise<Stats> {
  const s = await loadStats($)
  fn(s)
  await $.store.set('stats', s)
  return s
}

/** Count what a batch of answers cost and which tier served it. */
export async function recordAnswers($: EngineInterface, answers: Answer[], localAttempted: boolean): Promise<void> {
  await bumpStats($, s => {
    for (const a of answers) {
      s.decisions += 1
      s.byTier[a.tier] += 1
      if (a.tier === 'local') s.localMs += a.ms
      if (a.tier === 'claude') {
        s.claudeMs += a.ms
        if (localAttempted) s.escalations += 1
      }
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
