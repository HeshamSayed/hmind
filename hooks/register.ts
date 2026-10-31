// Hmind: a second brain for Claude Code.
//
// Where a cheap, calibrated judgment pays for itself:
//   1. tool.call Bash (before): refuse a command judged destructive, unless a learned rule allows it.
//   2. tool.call Bash (after): trim bulky output, or digest it when the failures are what matters.
//   3. turn.step 0: right-size the model's effort to the prompt, tighter as the plan's budget fills.
//   4. turn.complete: flag a "done" claim made without running any check; optionally verify it.
//   5. prompt.submit: compact at a task boundary once context is full; learn allow rules from approvals.
//   6. agent.spawn: route lookup and mechanical subagent work to cheaper models; warn on needless forks.
// Plus a `decide` tool the model can call itself, `/hmind` for stats and control, and a trust in the
// local judge that recalibrates itself from shadow checks against Claude.
// Every hook fails open: when the judge is down or unsure, nothing changes.

import type { Register, EngineInterface } from 'claude-code'

import { describeTrust, loadTrust, recordSample, resetTrust, SAMPLE_BAR } from './calibration'
import type { TrustState } from './calibration'
import { compactAtFor, describePressure, effortFor, readPressure, trimOverFor } from './budget'
import type { Effort, Pressure, Size } from './budget'
import { digest } from './digest'
import { agrees, bumpStats, calibration, clamp, decide, decideClaude, decideOne, defaultConfig, emptyStats, loadStats, markOutcome, recordAnswers, remember } from './judge'
import type { Answer, DecisionRecord, JudgeConfig, Question } from './judge'
import {
  approvalQuestion,
  approvalState,
  boundaryQuestion,
  boundaryState,
  claimsQuestion,
  claimsState,
  forkQuestion,
  gateQuestion,
  gateState,
  needQuestion,
  needState,
  sizeQuestion,
  sizeState,
  spawnQuestion,
  spawnState,
} from './questions'
import { addRule, loadRules, matchRule, removeRule, templateOf } from './rules'
import type { Rule } from './rules'
import { detectVerifyCommand, runVerify } from './verify'

const KEEP_RULES =
  'Keep, verbatim where short: the current goal and the latest user instructions; every file changed with a one-line note of what changed; ' +
  'the exact commands used to run, build and test, with their last result; open errors and what was tried; decisions made and why; what remains. ' +
  'Drop: file contents, long tool outputs, resolved dead ends, exploration that led nowhere.'

const SAFE_BASH =
  /^\s*(ls|cat|head|tail|wc|grep|rg|fd|pwd|which|echo|printf|stat|file|du|df|env|printenv|date|uname|sw_vers|sysctl|git (status|log|diff|show|branch|remote|rev-parse|ls-files|blame)|npm (ls|list|view|outdated|test)|pnpm (ls|test)|yarn (test|lint)|node -v|python3? (-V|--version)|pip3? (list|show)|tsc\b|cargo (check|test|build)|go (test|build|vet)|pytest|vitest|jest)\b/
const RISKY =
  /\brm\b|\bmv\b|--force|\s-f\b|-rf\b|reset --hard|checkout -- |\bpush\b|\bsudo\b|\bchmod\b|\bchown\b|\bdd\b|mkfs|\btruncate\b|\bDROP\b|\bDELETE\b|\bTRUNCATE\b|\bkill\b|pkill|killall|launchctl|defaults write|git clean|\brebase\b|\bshred\b|:\(\)\s*\{|>\s*\/|\b(curl|wget)\b.*\|\s*(ba|z)?sh\b|diskutil|\bcrontab\b|\bsystemctl\b|\bbrew (uninstall|remove)\b|npm (uninstall|publish|unpublish)|pip3? uninstall/i
const VERIFY =
  /\b(npm|pnpm|yarn|bun)\s+(test|run\s+(test|build|lint|typecheck|check|e2e|dev))\b|\bpytest\b|\bvitest\b|\bjest\b|\bcargo (test|build|check|clippy|run)\b|\bgo (test|build|vet|run)\b|\btsc\b|\bmvn\b|\bgradle\b|\bmake\b|\bflutter (test|analyze|build|run)\b|\bdart (test|analyze)\b|\bphpunit\b|\brspec\b|\beslint\b|\bruff\b|\bmypy\b|\bxcodebuild\b|\bdotnet (test|build|run)\b|\bcurl\b.*(localhost|127\.0\.0\.1)|\bnpx playwright\b|\bcypress\b|\bpython3? (-m pytest|.*test)|\bnode .*test/i

type TurnState = { prompt: string; edits: number; verifications: number; bash: number }
type PendingTrim = { norm: string; id: string; callsLeft: number }

type Options = {
  bashGuard: boolean
  denyAt: number
  trimOver: number
  routeEffort: boolean
  doneCheck: string
  compactAt: number
  shadowRate: number
  budgetMode: boolean
  subagents: boolean
  digest: boolean
  autoVerify: boolean
  learnRules: boolean
}

/** Everything the hooks share; a hot reload starts it over (trust, rules and stats live in $.store). */
type Shared = {
  cfg: JudgeConfig
  opt: Options
  enabled: boolean
  localUp: boolean
  wantsCompact: boolean
  mainTurn: string | undefined
  turns: Map<string, TurnState>
  pendingTrims: PendingTrim[]
  trust: TrustState
  rules: Rule[]
  pressure: Pressure
  root: string
  lastDeny?: { command: string; turn: number }
  verifyPrompted: boolean
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const normalize = (command: string) => command.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 160)
const pct = (p: number) => `${Math.round(p * 100)}%`

/** "gate=0.75,effort=1" -> { gate: 0.75, effort: 1 }; unknown kinds fall back to the global threshold. */
function parseTrust(raw: unknown, fallback: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const pair of String(raw ?? '').split(',')) {
    const [kind, value] = pair.split('=').map(s => s.trim())
    if (kind && value !== undefined && Number.isFinite(Number(value))) out[kind] = clamp(Number(value), 0.5, 1)
  }
  out.default = fallback
  return out
}

const trustFor = (sh: Shared, kind: string): number => sh.trust.trust[kind] ?? sh.trust.trust.default ?? sh.cfg.confidence

/** A local answer stands only above its kind's trust; a Claude answer above the global threshold. */
function usable(a: Answer, kind: string, sh: Shared): boolean {
  if (a.tier === 'none') return false
  return a.confidence >= (a.tier === 'local' ? trustFor(sh, kind) : sh.cfg.confidence)
}

function headTail(out: string, head = 2500, tail = 2500): string {
  return `${out.slice(0, head)}\n…\n${out.slice(-tail)}`
}

function errorsOnly(out: string): string {
  const lines = out.split('\n')
  const hits = lines.filter(l => /error|fail|exception|traceback|panic|fatal|✗|✘|cannot|not found|denied|warning/i.test(l)).slice(0, 80)
  const ending = lines.slice(-25)
  return `${hits.join('\n')}\n…\n${ending.join('\n')}`
}

const rankOf = (model: string): number => (/haiku/i.test(model) ? 0 : /sonnet/i.test(model) ? 1 : /opus/i.test(model) ? 2 : /fable|mythos/i.test(model) ? 3 : 2)

// ------------------------------------------------------------ logging and calibration

type ShadowSource = { state: string; question: Question }

/** Record a batch of answers; feed the calibration with what the escalation already showed, and shadow-check a sample of the local answers that stood. */
async function log($: EngineInterface, sh: Shared, kind: string, summary: string, answers: Answer[], source?: ShadowSource): Promise<string> {
  const id = newId()
  const rec: DecisionRecord = { id, at: new Date().toISOString(), kind, summary: summary.slice(0, 160), answers }
  await recordAnswers($, answers, sh.localUp)
  await remember($, rec)
  for (const a of answers) {
    if (a.tier === 'claude' && a.shadow?.tier === 'local' && a.shadow.confidence >= SAMPLE_BAR) {
      await noteSample($, sh, kind, agrees(a.shadow, a))
    } else if (a.tier === 'local' && source && sh.cfg.escalate && Math.random() < sh.opt.shadowRate) {
      void shadowCheck($, sh, kind, source, a).catch(() => undefined)
    }
  }
  return id
}

async function noteSample($: EngineInterface, sh: Shared, kind: string, agreed: boolean): Promise<void> {
  const changed = await recordSample($, sh.trust, kind, agreed)
  if (changed) $.ui.toast(`Hmind: trust in the local judge for ${kind} ${changed.from} → ${changed.to}`)
}

async function shadowCheck($: EngineInterface, sh: Shared, kind: string, source: ShadowSource, local: Answer): Promise<void> {
  const [c] = await decideClaude($, sh.cfg, source.state, [source.question])
  if (!c || c.tier === 'none') return
  const ok = agrees(local, c)
  await noteSample($, sh, kind, ok)
  if (!ok && kind === 'gate' && (c.p ?? 0) >= sh.opt.denyAt) $.ui.toast('Hmind: a shadow check disagreed with a shell gate; Claude would have refused it')
}

// ------------------------------------------------------------ local tier

async function ping($: EngineInterface, cfg: JudgeConfig, ms: number): Promise<boolean> {
  const r = await Promise.race([$.http.fetch(`${cfg.ollamaUrl}/api/version`).catch(() => undefined), $.clock.sleep(ms).then(() => undefined)])
  return !!r && r.ok
}

/** Make sure the local tier is reachable and has its model; otherwise the Claude tier carries every decision. */
async function ensureLocal($: EngineInterface, sh: Shared): Promise<void> {
  const { cfg } = sh
  sh.localUp = await ping($, cfg, 1500)
  if (!sh.localUp) {
    void (async () => {
      try {
        for await (const _chunk of $.process.spawn({ argv: ['ollama', 'serve'] })) {
          /* output ignored */
        }
      } catch {
        /* ollama not installed */
      }
    })()
    for (let i = 0; i < 12 && !sh.localUp; i += 1) {
      await $.clock.sleep(500)
      sh.localUp = await ping($, cfg, 800)
    }
  }
  if (!sh.localUp) {
    $.ui.status(cfg.escalate ? `Hmind: local judge down, ${cfg.escalateModel} only` : 'Hmind: judge down, idle')
    return
  }
  const tags = await $.http.fetch(`${cfg.ollamaUrl}/api/tags`).catch(() => undefined)
  const hasModel = !!tags && tags.ok && tags.text.includes(`"${cfg.ollamaModel}"`)
  if (!hasModel) {
    $.ui.toast(`Hmind: pulling ${cfg.ollamaModel} for the local judge`)
    const pulled = await $.process.run(['ollama', 'pull', cfg.ollamaModel], { timeoutMs: 600000 }).catch(() => undefined)
    if (!pulled || pulled.exitCode !== 0) {
      sh.localUp = false
      $.ui.status(`Hmind: could not pull ${cfg.ollamaModel}; ${cfg.escalateModel} only`)
      return
    }
  }
  $.ui.status(`Hmind: ${cfg.ollamaModel} ready${cfg.escalate ? `, escalates to ${cfg.escalateModel}` : ''}`)
}

// ------------------------------------------------------------ surface

async function registerSurface($: EngineInterface): Promise<void> {
  await $.command.register({
    name: 'hmind',
    description: 'Hmind: stats, decisions, trust, rules, verify, on/off',
    argumentHint: '[log|trust|rules|budget|verify on|off|allow <cmd>|forget <n>|right|wrong <id>|reset|on|off]',
  })
  await $.tool.register({
    name: 'decide',
    description:
      'Typed decisions over a state: choice (pick one option), score (0..1 on a rubric) and noul (is a statement true?). ' +
      'Each answer carries probabilities, a confidence (0..1) and the tier that served it (a fast local judge, or Claude when it was unsure). ' +
      'Use it to classify, rank, route, gate or triage many items cheaply instead of reasoning about each at length. Batch several questions over one state.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', description: 'The data every question is asked about (text or JSON, up to ~24K chars).' },
        questions: {
          type: 'array',
          description: 'Typed questions, each with a unique id.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              type: { type: 'string', enum: ['choice', 'score', 'noul'] },
              question: { type: 'string', description: 'choice and score: the question' },
              statement: { type: 'string', description: 'noul: the statement to judge true or false' },
              options: { type: 'array', items: { type: 'string' }, description: 'choice: 2 to 10 options' },
            },
            required: ['id', 'type'],
          },
        },
      },
      required: ['state', 'questions'],
    },
    isDeferred: false,
  })
}

function parseQuestions(raw: unknown): Question[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'decide needs a non-empty `questions` array.'
  const questions: Question[] = []
  for (const item of raw as Record<string, unknown>[]) {
    const id = String(item.id ?? questions.length + 1)
    if (item.type === 'noul' && typeof item.statement === 'string') questions.push({ id, type: 'noul', statement: item.statement })
    else if (item.type === 'score' && typeof item.question === 'string') questions.push({ id, type: 'score', question: item.question })
    else if (item.type === 'choice' && typeof item.question === 'string' && Array.isArray(item.options) && item.options.length >= 2 && item.options.length <= 10)
      questions.push({ id, type: 'choice', question: item.question, options: item.options.map(String) })
    else return `question ${id}: unknown type or missing fields (noul needs statement; score needs question; choice needs question and 2-10 options).`
  }
  return questions
}

function formatAnswers(answers: Answer[]): string {
  return answers
    .map(a => {
      const head = a.type === 'noul' ? `${a.choice} p=${a.p}` : a.type === 'score' ? `score=${a.score}` : `choice=${JSON.stringify(a.choice)}`
      return `${a.id}: ${head} confidence=${a.confidence} tier=${a.tier}${a.why ? ` why=${JSON.stringify(a.why)}` : ''}\n  probabilities=${JSON.stringify(a.probabilities)}`
    })
    .join('\n')
}

async function statsText($: EngineInterface, sh: Shared): Promise<string> {
  const s = await loadStats($)
  const c = await calibration($)
  const { cfg } = sh
  const avg = (ms: number, n: number) => (n ? `${Math.round(ms / n)} ms` : 'n/a')
  const verifyOn = sh.opt.autoVerify || (await $.store.get(`verify:${sh.root}`)) === true
  return [
    `Hmind ${sh.enabled ? 'on' : 'off'}: ${s.decisions} decisions (local ${s.byTier.local}, claude ${s.byTier.claude}, unanswered ${s.byTier.none}), ${s.escalations} escalations`,
    `  latency: local avg ${avg(s.localMs, s.byTier.local)}, claude avg ${avg(s.claudeMs, s.byTier.claude)}`,
    `  actions: effort lowered on ${s.effortLowered} turns, ${s.trims} output trims saving ${Math.round(s.trimmedChars / 1000)}K chars (${s.digests} digests, ${s.trimRegrets} regretted), ${s.denies} shell refusals (${s.rulesApplied} allowed by rule), ${s.unverifiedClaims} unverified done claims, ${s.verifications} verification runs (${s.verificationsFailed} failed), ${s.compactions} boundary compactions, ${s.subagentsRouted} subagents routed cheaper, ${s.forkWarnings} fork warnings`,
    `  calibration: ${sh.trust.checks} shadow checks, ${sh.trust.checks ? pct(sh.trust.agreements / sh.trust.checks) : 'n/a'} agreement; ${c.labeled} labeled decisions, accuracy ${pct(c.accuracy)}, calibration error ${c.ece}`,
    `  trust in the local judge: ${describeTrust(sh.trust)}`,
    `  budget: ${sh.opt.budgetMode ? describePressure(sh.pressure) || `normal (${sh.pressure.percent}% of the ${sh.pressure.window} window)` : 'budget mode off'}`,
    `  rules: ${sh.rules.filter(r => r.root === sh.root).length} learned for this project; auto-verify ${verifyOn ? 'on' : 'off'} here`,
    `  tiers: ${cfg.ollamaModel} at ${cfg.ollamaUrl} (${sh.localUp ? 'up' : 'down'}), escalation ${cfg.escalate ? cfg.escalateModel : 'off'}, confidence threshold ${cfg.confidence}, shadow rate ${sh.opt.shadowRate}`,
    '  /hmind log | trust [reset] | rules | allow <cmd> | forget <n> | verify on|off | right|wrong <id> | reset | on | off',
  ].join('\n')
}

async function logText($: EngineInterface): Promise<string> {
  const recent = (((await $.store.get('recent')) as DecisionRecord[] | undefined) ?? []).slice(-15).reverse()
  if (recent.length === 0) return 'no decisions yet.'
  const rows = recent.map(r => {
    const a = r.answers[0]
    const head = a ? (a.type === 'noul' ? `${a.choice} p=${a.p}` : a.type === 'score' ? `score=${a.score}` : `${a.choice ?? '?'}`.slice(0, 40)) : '?'
    return `${r.id}  ${r.at.slice(11, 19)}  ${r.kind.padEnd(10)} ${head} (${a?.tier ?? 'none'} ${a ? pct(a.confidence) : ''})${r.outcome ? ` [${r.outcome}]` : ''}  ${r.summary.replace(/\s+/g, ' ').slice(0, 60)}`
  })
  return `last ${recent.length} decisions (newest first); label one with /hmind right|wrong <id>\n${rows.join('\n')}`
}

// ------------------------------------------------------------ verification

async function verifyNow($: EngineInterface, sh: Shared): Promise<void> {
  const command = await detectVerifyCommand($, sh.root)
  if (!command) {
    $.ui.toast('Hmind: no test or build command recognised in this project, nothing run')
    return
  }
  $.ui.toast(`Hmind: running \`${command}\` to verify the claim`)
  const r = await runVerify($, command)
  await bumpStats($, s => {
    s.verifications += 1
    if (!r.ok) s.verificationsFailed += 1
  })
  const body = r.denied ? `The run was refused: ${r.denied}` : r.text.length > 3500 ? errorsOnly(r.text).slice(0, 3500) : r.text
  const verdict = r.denied ? 'not run' : r.ok ? 'PASSED' : 'FAILED'
  await $.session
    .append({
      message: {
        type: 'user',
        content: [{ type: 'text', text: `Hmind ran \`${command}\` because the last message claimed completion without any verification this turn. Result: ${verdict}.\n\n${body}` }],
      },
    })
    .catch(() => undefined)
  $.ui.toast(`Hmind: verification ${verdict.toLowerCase()} (${command})`)
  if (!r.ok && !r.denied && !sh.verifyPrompted) {
    sh.verifyPrompted = true
    void $.prompt.submit({ text: `Hmind: the verification run (\`${command}\`) failed; its output is in the note above. Fix the failures, or explain why they are unrelated.` })
  }
}

// ------------------------------------------------------------ register

export const register: Register = (on, options) => {
  const cfg = defaultConfig(options)
  const sh: Shared = {
    cfg,
    opt: {
      bashGuard: options.bashGuard !== false,
      denyAt: clamp(Number(options.denyAt ?? 0.85), 0.5, 0.99),
      trimOver: Math.max(0, Number(options.trimOver ?? 6000)),
      routeEffort: options.routeEffort !== false,
      doneCheck: String(options.doneCheck ?? 'toast'),
      compactAt: Math.max(0, Number(options.compactAt ?? 55)),
      shadowRate: clamp(Number(options.shadowRate ?? 0.15), 0, 1),
      budgetMode: options.budgetMode !== false,
      subagents: options.subagents !== false,
      digest: options.digest !== false,
      autoVerify: options.autoVerify === true,
      learnRules: options.learnRules !== false,
    },
    enabled: true,
    localUp: false,
    wantsCompact: false,
    mainTurn: undefined,
    turns: new Map(),
    pendingTrims: [],
    trust: { trust: parseTrust(options.localTrust ?? 'gate=0.75,done=0.75,boundary=0.8,effort=1,trim=1,tool=0.85,spawn=0.85,fork=0.85,approval=1', cfg.confidence), samples: {}, adjustments: [], checks: 0, agreements: 0 },
    rules: [],
    pressure: { level: 'normal', percent: 0, window: 'none' },
    root: '',
    verifyPrompted: false,
  }
  const { opt } = sh
  const defaults = { ...sh.trust.trust }
  let lastLevel = 'normal'

  // ------------------------------------------------------------ session

  on('session.start', async ($, e, next) => {
    sh.enabled = (await loadStats($)).enabled
    sh.root = await $.session.root().catch(() => e.cwd)
    sh.trust = await loadTrust($, defaults)
    sh.rules = await loadRules($)
    await registerSurface($)
    void ensureLocal($, sh).catch(() => undefined)
    if (opt.budgetMode) void readPressure($).then(p => (sh.pressure = p)).catch(() => undefined)
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    return {
      sections: [
        ...r.sections,
        {
          id: 'hmind:decide',
          scope: 'session',
          text:
            'A `decide` tool (mcp__hmind__decide) answers typed questions about a state you give it: choice, score or yes/no, each with probabilities and a confidence, ' +
            'served by a fast local judge and escalated to Claude when unsure. Reach for it when you must classify, rank, route, gate or triage many items, or check a claim quickly, instead of reasoning about each at length.',
        },
      ],
    }
  })

  // ------------------------------------------------------------ turns

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) {
      sh.mainTurn = e.turnId
      sh.turns.set(e.turnId, { prompt: e.text, edits: 0, verifications: 0, bash: 0 })
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    let effort = e.effort
    try {
      if (sh.enabled && e.agentId === undefined && e.index === 0) {
        if (opt.budgetMode) {
          sh.pressure = await readPressure($)
          if (sh.pressure.level !== lastLevel) {
            lastLevel = sh.pressure.level
            if (sh.pressure.level !== 'normal') $.ui.toast(`Hmind: ${describePressure(sh.pressure)}; tightening effort, trimming and compaction`)
          }
        }
        if (opt.routeEffort && typeof e.effort === 'string') {
          const text = sh.turns.get(e.turnId)?.prompt ?? ''
          if (text.length >= 8 && text.length <= 6000 && !text.startsWith('/')) {
            const state = sizeState(text)
            const a = await decideOne($, cfg, state, [sizeQuestion], { threshold: trustFor(sh, 'effort') })
            await log($, sh, 'effort', text, [a], { state, question: sizeQuestion })
            if (usable(a, 'effort', sh) && a.choice) {
              const size: Size = a.choice.startsWith('a question') ? 'trivial' : a.choice.startsWith('a small') ? 'small' : 'large'
              effort = effortFor(opt.budgetMode ? sh.pressure.level : 'normal', size, e.effort as Effort)
            }
            if (effort !== e.effort) {
              await bumpStats($, s => {
                s.effortLowered += 1
              })
              $.ui.status(`Hmind: effort ${String(effort)} this turn (${a.tier} ${pct(a.confidence)}${sh.pressure.level !== 'normal' ? `, budget ${sh.pressure.level}` : ''})`)
            }
          }
        }
      }
    } catch {
      effort = e.effort
    }
    return yield* next(effort === e.effort ? e : { ...e, effort })
  })

  on('tool.call', ($, e, next) => {
    const t = e.agentId === undefined && sh.mainTurn ? sh.turns.get(sh.mainTurn) : undefined
    if (t && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(String(e.tool))) t.edits += 1
    return next(e)
  })

  // ------------------------------------------------------------ Bash: gate, then trim or digest

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const t = e.agentId === undefined && sh.mainTurn ? sh.turns.get(sh.mainTurn) : undefined
    if (t) {
      t.bash += 1
      if (VERIFY.test(e.command)) t.verifications += 1
    }

    const norm = normalize(e.command)
    for (const p of sh.pendingTrims) {
      p.callsLeft -= 1
      if (p.norm === norm) {
        await markOutcome($, p.id, 'wrong')
        await bumpStats($, s => {
          s.trimRegrets += 1
        })
        p.callsLeft = 0
      }
    }
    sh.pendingTrims = sh.pendingTrims.filter(p => p.callsLeft > 0)

    if (sh.enabled && opt.bashGuard && RISKY.test(e.command) && !SAFE_BASH.test(e.command)) {
      const rule = matchRule(sh.rules, sh.root, e.command)
      if (rule) {
        await bumpStats($, s => {
          s.rulesApplied += 1
        })
        $.ui.status(`Hmind: allowed by a learned rule (${rule.via})`)
      } else {
        const cwd = await $.session.cwd()
        const state = gateState(cwd, e.command)
        const a = await decideOne($, cfg, state, [gateQuestion], { threshold: trustFor(sh, 'gate') })
        await log($, sh, 'gate', e.command, [a], { state, question: gateQuestion })
        if (usable(a, 'gate', sh) && a.p !== undefined && a.p >= opt.denyAt) {
          await bumpStats($, s => {
            s.denies += 1
          })
          sh.lastDeny = { command: e.command, turn: await $.session.turns().catch(() => 0) }
          $.ui.toast(`Hmind: refused a shell command judged destructive (${pct(a.p)})`)
          return {
            deny:
              `Hmind refused this command: it looks destructive (p=${a.p}, ${a.tier}${a.why ? `: ${a.why}` : ''}). ` +
              'Do not retry it as is. If it is truly needed, explain the risk to the user and ask them to run it or approve it explicitly.',
          }
        }
      }
    }

    const ran = await next(e)

    const trimOver = opt.budgetMode ? trimOverFor(sh.pressure.level, opt.trimOver) : opt.trimOver
    if (
      sh.enabled &&
      trimOver > 0 &&
      ran.deny === undefined &&
      ran.isError === undefined &&
      ran.result &&
      typeof ran.result.stdout === 'string' &&
      ran.result.stdout.length > trimOver &&
      !ran.result.isImage &&
      !ran.result.backgroundTaskId
    ) {
      const out = ran.result.stdout
      const state = needState(e.command, out)
      const a = await decideOne($, cfg, state, [needQuestion], { threshold: trustFor(sh, 'trim') })
      const id = await log($, sh, 'trim', e.command, [a], { state, question: needQuestion })
      if (usable(a, 'trim', sh) && a.choice && !a.choice.startsWith('all')) {
        let kept: string | undefined
        let how = a.choice.split(':')[0] ?? 'trimmed'
        if (a.choice.startsWith('only') && opt.digest && out.length > 8000) {
          kept = await digest($, cfg, e.command, out).catch(() => undefined)
          if (kept) {
            how = 'digest of the failures and final status'
            await bumpStats($, s => {
              s.digests += 1
            })
          }
        }
        kept ??= a.choice.startsWith('only') ? errorsOnly(out) : headTail(out)
        if (kept.length < out.length * 0.8) {
          const saved = out.length - kept.length
          sh.pendingTrims.push({ norm, id, callsLeft: 3 })
          await bumpStats($, s => {
            s.trims += 1
            s.trimmedChars += saved
          })
          $.ui.status(`Hmind: ${how.startsWith('digest') ? 'digested' : 'trimmed'} ${Math.round(saved / 1000)}K chars of output (${a.tier} ${pct(a.confidence)})`)
          const note = `\n\n[Hmind replaced ${saved} of ${out.length} characters of this output with ${how}. Rerun with grep, head or tail if you need a specific part.]`
          return { result: { ...ran.result, stdout: kept + note } }
        }
      }
    }
    return ran
  }).catch(($, e, next) => next(e))

  // ------------------------------------------------------------ subagents

  on('agent.spawn', async ($, e, next) => {
    if (!sh.enabled || !opt.subagents || e.parentAgentId !== undefined) return next(e)
    if (e.subagentType === 'fork') {
      const state = spawnState(e.subagentType, e.description, e.prompt)
      const a = await decideOne($, cfg, state, [forkQuestion], { threshold: trustFor(sh, 'fork') })
      await log($, sh, 'fork', e.description, [a], { state, question: forkQuestion })
      if (usable(a, 'fork', sh) && a.p !== undefined && a.p <= 1 - cfg.confidence) {
        await bumpStats($, s => {
          s.forkWarnings += 1
        })
        $.ui.toast(`Hmind: this fork copies the whole conversation, but its task looks self-contained (${pct(1 - a.p)}); a general-purpose agent would be far cheaper`)
      }
      return next(e)
    }
    if (e.model !== undefined) return next(e)
    const state = spawnState(e.subagentType, e.description, e.prompt)
    const a = await decideOne($, cfg, state, [spawnQuestion], { threshold: trustFor(sh, 'spawn') })
    await log($, sh, 'spawn', e.description, [a], { state, question: spawnQuestion })
    if (!usable(a, 'spawn', sh) || !a.choice) return next(e)
    const tight = opt.budgetMode && (sh.pressure.level === 'high' || sh.pressure.level === 'critical')
    const target = a.choice.startsWith('a lookup') ? 'haiku' : a.choice.startsWith('mechanical') || tight ? 'sonnet' : undefined
    if (!target || rankOf(target) >= rankOf(e.parentModel)) return next(e)
    await bumpStats($, s => {
      s.subagentsRouted += 1
    })
    $.ui.status(`Hmind: subagent "${e.description.slice(0, 40)}" routed to ${target} (${a.tier} ${pct(a.confidence)})`)
    return next({ ...e, model: target })
  }).catch(($, e, next) => next(e))

  // ------------------------------------------------------------ end of turn

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || !sh.enabled) return done
    const t = sh.turns.get(e.turnId)
    sh.turns.delete(e.turnId)

    if (opt.compactAt > 0) {
      const usage = await $.session.usage().catch(() => undefined)
      const percent = usage?.context.percent ?? 0
      const bar = opt.budgetMode ? compactAtFor(sh.pressure.level, opt.compactAt) : opt.compactAt
      if (percent >= bar) {
        sh.wantsCompact = true
        $.ui.status(`Hmind: context ${percent}% full, will compact at the next task boundary`)
      }
    }

    if (opt.doneCheck !== 'off' && e.reason === 'answer' && t && t.edits > 0 && t.verifications === 0 && done.text.length > 40) {
      const state = claimsState(t.edits, done.text)
      const a = await decideOne($, cfg, state, [claimsQuestion], { threshold: trustFor(sh, 'done') })
      await log($, sh, 'done-check', done.text, [a], { state, question: claimsQuestion })
      if (usable(a, 'done', sh) && a.p !== undefined && a.p >= cfg.confidence) {
        await bumpStats($, s => {
          s.unverifiedClaims += 1
        })
        $.ui.toast(`Hmind: completion claimed, but nothing was run to verify it this turn (${pct(a.p)})`)
        const verifyOn = opt.autoVerify || (await $.store.get(`verify:${sh.root}`)) === true
        if (verifyOn) await verifyNow($, sh).catch(() => undefined)
        else if (opt.doneCheck === 'prompt') {
          void $.prompt.submit({
            text: 'Hmind: you reported the work as done, but no test, build or run command was executed this turn. Verify it now with the relevant command, or state plainly that it is unverified.',
          })
        }
      }
    }
    return done
  })

  // ------------------------------------------------------------ next prompt: approvals, boundary compaction

  on('prompt.submit', async ($, e, next) => {
    const typed = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (typed && e.command === undefined && !e.isMeta) sh.verifyPrompted = false

    if (sh.enabled && opt.learnRules && sh.lastDeny && typed && e.command === undefined && !e.isMeta && e.text.length >= 2) {
      const turn = await $.session.turns().catch(() => 0)
      if (turn - sh.lastDeny.turn <= 2) {
        const state = approvalState(sh.lastDeny.command, e.text)
        const a = await decideOne($, cfg, state, [approvalQuestion], { threshold: trustFor(sh, 'approval') })
        await log($, sh, 'approval', e.text, [a], { state, question: approvalQuestion })
        if (usable(a, 'approval', sh) && a.p !== undefined && a.p >= 0.8) {
          sh.rules = await addRule($, sh.rules, { template: templateOf(sh.lastDeny.command), root: sh.root, at: new Date().toISOString(), via: 'approval', example: sh.lastDeny.command.slice(0, 200) })
          await bumpStats($, s => {
            s.rulesLearned += 1
          })
          $.ui.toast(`Hmind: learned to allow \`${sh.lastDeny.command.slice(0, 50)}\` in this project (/hmind rules)`)
          sh.lastDeny = undefined
        }
      } else sh.lastDeny = undefined
    }

    if (sh.enabled && sh.wantsCompact && opt.compactAt > 0 && e.command === undefined && !e.isMeta && e.turnId === undefined && e.text.length >= 4) {
      const msgs = await $.session.messages()
      const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant')?.text ?? ''
      const state = boundaryState(lastAssistant, e.text)
      const a = await decideOne($, cfg, state, [boundaryQuestion], { threshold: trustFor(sh, 'boundary') })
      await log($, sh, 'boundary', e.text, [a], { state, question: boundaryQuestion })
      if (usable(a, 'boundary', sh) && a.p !== undefined && a.p >= cfg.confidence) {
        const r = await $.session.compact({ instructions: KEEP_RULES })
        if (!('skip' in r)) {
          sh.wantsCompact = false
          await bumpStats($, s => {
            s.compactions += 1
          })
          $.ui.toast('Hmind: compacted the conversation at a task boundary')
        }
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.compact', ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    if (e.instructions?.includes(KEEP_RULES)) return next(e)
    return next({ ...e, instructions: e.instructions ? `${e.instructions}\n\n${KEEP_RULES}` : KEEP_RULES })
  })

  // ------------------------------------------------------------ the model's own tool

  on('tool.call', { tool: 'mcp__hmind__decide' }, async ($, e) => {
    const input = e as unknown as { state?: unknown; questions?: unknown }
    if (typeof input.state !== 'string') return { result: 'error: decide needs a string `state`.' }
    const questions = parseQuestions(input.questions)
    if (typeof questions === 'string') return { result: `error: ${questions}` }
    const answers = await decide($, cfg, input.state, questions, { threshold: trustFor(sh, 'tool') })
    await log($, sh, 'tool', `${questions.length} question(s)`, answers)
    return { result: formatAnswers(answers) }
  })

  // ------------------------------------------------------------ /hmind

  on('command.run', { command: 'hmind' }, async ($, e) => {
    const args = String((e as { args?: unknown }).args ?? '').trim()
    const [verb, ...restWords] = args.split(/\s+/)
    const rest = restWords.join(' ')
    if (verb === 'on' || verb === 'off') {
      sh.enabled = verb === 'on'
      await bumpStats($, s => {
        s.enabled = sh.enabled
      })
      return { text: `Hmind is ${sh.enabled ? 'on' : 'off'}.` }
    }
    if (verb === 'reset') {
      await $.store.set('stats', { ...emptyStats(), enabled: sh.enabled })
      await $.store.set('recent', [])
      return { text: 'Hmind stats cleared.' }
    }
    if ((verb === 'right' || verb === 'wrong') && rest) {
      const ok = await markOutcome($, rest, verb)
      const recent = ((await $.store.get('recent')) as DecisionRecord[] | undefined) ?? []
      const rec = recent.find(r => r.id === rest)
      if (ok && rec?.answers[0]?.tier === 'local') await noteSample($, sh, rec.kind, verb === 'right')
      return { text: ok ? `decision ${rest} marked ${verb}.` : `no decision ${rest} in the log.` }
    }
    if (verb === 'log') return { text: await logText($) }
    if (verb === 'trust') {
      if (rest === 'reset') {
        await resetTrust($)
        sh.trust = await loadTrust($, defaults)
        return { text: `trust reset to the configured defaults: ${describeTrust(sh.trust)}` }
      }
      return { text: `trust in the local judge: ${describeTrust(sh.trust)}\n${sh.trust.checks} shadow checks, ${sh.trust.checks ? pct(sh.trust.agreements / sh.trust.checks) : 'n/a'} agreement; a kind moves 0.05 every 10 samples (down at 90%+ agreement, up under 80%).` }
    }
    if (verb === 'rules') {
      const mine = sh.rules.map((r, i) => ({ r, i })).filter(({ r }) => r.root === sh.root)
      if (mine.length === 0) return { text: 'no learned rules for this project. Add one with /hmind allow <command>.' }
      return { text: `allow rules for ${sh.root}:\n${mine.map(({ r, i }) => `  ${i}  ${r.via.padEnd(8)} ${r.example}`).join('\n')}\nRemove one with /hmind forget <n>.` }
    }
    if (verb === 'allow' && rest) {
      sh.rules = await addRule($, sh.rules, { template: templateOf(rest), root: sh.root, at: new Date().toISOString(), via: 'manual', example: rest.slice(0, 200) })
      return { text: `commands shaped like \`${rest}\` are allowed in this project without judging.` }
    }
    if (verb === 'forget' && rest) {
      const i = Number(rest)
      if (!Number.isInteger(i) || !sh.rules[i]) return { text: `no rule ${rest}.` }
      sh.rules = await removeRule($, sh.rules, i)
      return { text: `rule ${i} removed.` }
    }
    if (verb === 'verify') {
      if (rest === 'on' || rest === 'off') {
        await $.store.set(`verify:${sh.root}`, rest === 'on')
        return { text: `auto-verify ${rest} for this project${rest === 'on' ? `; command: ${(await detectVerifyCommand($, sh.root)) ?? 'none recognised yet'}` : ''}.` }
      }
      const cmd = await detectVerifyCommand($, sh.root)
      return { text: `auto-verify is ${opt.autoVerify || (await $.store.get(`verify:${sh.root}`)) === true ? 'on' : 'off'} here; recognised command: ${cmd ?? 'none'}. Toggle with /hmind verify on|off.` }
    }
    if (verb === 'budget') {
      sh.pressure = await readPressure($)
      return { text: `${describePressure(sh.pressure) || `budget normal: ${sh.pressure.percent}% of the ${sh.pressure.window} window used`}; mode ${opt.budgetMode ? 'on' : 'off'}.` }
    }
    return { text: await statsText($, sh) }
  })
}
