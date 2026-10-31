// Hmind: typed decisions inside Claude Code.
//
// Five places a cheap, calibrated judgment pays for itself:
//   1. tool.call Bash (before): refuse a command judged destructive.
//   2. tool.call Bash (after): trim bulky output the assistant will not need.
//   3. turn.step 0: lower the model's effort for trivial prompts and small changes.
//   4. turn.complete: flag a "done" claim made without running any check.
//   5. prompt.submit: compact the conversation at a task boundary once it is full.
// Plus a `decide` tool the model can call itself, and `/hmind` for stats.
// Every hook fails open: when the judge is down or unsure, nothing changes.

import type { Register, EngineInterface } from 'claude-code'

import {
  bumpStats,
  calibration,
  clamp,
  decide,
  decideOne,
  defaultConfig,
  emptyStats,
  loadStats,
  markOutcome,
  recordAnswers,
  remember,
} from './judge'
import type { Answer, DecisionRecord, JudgeConfig, Question } from './judge'
import { boundaryQuestion, boundaryState, claimsQuestion, claimsState, gateQuestion, gateState, needQuestion, needState, sizeQuestion, sizeState } from './questions'

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
  /** per decision kind, the local confidence at which a local answer stands without escalation; 1 = always escalate */
  trust: Record<string, number>
}

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

/** A local answer stands only above its kind's trust; a Claude answer above the global threshold. */
function usable(a: Answer, kind: string, opt: Options, cfg: JudgeConfig): boolean {
  if (a.tier === 'none') return false
  const bar = a.tier === 'local' ? (opt.trust[kind] ?? opt.trust.default ?? cfg.confidence) : cfg.confidence
  return a.confidence >= bar
}

/** Everything the hooks share; a hot reload starts it over (stats live in $.store). */
type Shared = {
  cfg: JudgeConfig
  opt: Options
  enabled: boolean
  localUp: boolean
  wantsCompact: boolean
  mainTurn: string | undefined
  turns: Map<string, TurnState>
  pendingTrims: PendingTrim[]
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const normalize = (command: string) => command.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 160)
const pct = (p: number) => `${Math.round(p * 100)}%`

function headTail(out: string, head = 2500, tail = 2500): string {
  return `${out.slice(0, head)}\n…\n${out.slice(-tail)}`
}

function errorsOnly(out: string): string {
  const lines = out.split('\n')
  const hits = lines.filter(l => /error|fail|exception|traceback|panic|fatal|✗|✘|cannot|not found|denied|warning/i.test(l)).slice(0, 80)
  const ending = lines.slice(-25)
  return `${hits.join('\n')}\n…\n${ending.join('\n')}`
}

async function log($: EngineInterface, sh: Shared, kind: string, summary: string, answers: Answer[]): Promise<string> {
  const id = newId()
  const rec: DecisionRecord = { id, at: new Date().toISOString(), kind, summary: summary.slice(0, 160), answers }
  await recordAnswers($, answers, sh.localUp)
  await remember($, rec)
  return id
}

async function ping($: EngineInterface, cfg: JudgeConfig, ms: number): Promise<boolean> {
  const r = await Promise.race([$.http.fetch(`${cfg.ollamaUrl}/api/version`).catch(() => undefined), $.clock.sleep(ms).then(() => undefined)])
  return !!r && r.ok
}

/** Make sure the local tier is reachable and has its model; otherwise the Claude tier carries every decision. */
async function ensureLocal($: EngineInterface, sh: Shared): Promise<void> {
  const { cfg } = sh
  sh.localUp = await ping($, cfg, 1500)
  if (!sh.localUp) {
    // Start a server for the session's life; a port already in use just ends the child.
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

async function registerSurface($: EngineInterface): Promise<void> {
  await $.command.register({
    name: 'hmind',
    description: 'Hmind judge: stats, recent decisions, on/off, reset, label an outcome',
    argumentHint: '[log|on|off|reset|right <id>|wrong <id>]',
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
  return [
    `Hmind ${sh.enabled ? 'on' : 'off'}: ${s.decisions} decisions (local ${s.byTier.local}, claude ${s.byTier.claude}, unanswered ${s.byTier.none}), ${s.escalations} escalations`,
    `  latency: local avg ${avg(s.localMs, s.byTier.local)}, claude avg ${avg(s.claudeMs, s.byTier.claude)}`,
    `  actions: effort lowered on ${s.effortLowered} turns, ${s.trims} output trims saving ${Math.round(s.trimmedChars / 1000)}K chars (${s.trimRegrets} regretted), ${s.denies} shell refusals, ${s.unverifiedClaims} unverified done claims, ${s.compactions} boundary compactions`,
    `  calibration: ${c.labeled} labeled decisions, accuracy ${pct(c.accuracy)}, expected calibration error ${c.ece}`,
    `  tiers: ${cfg.ollamaModel} at ${cfg.ollamaUrl} (${sh.localUp ? 'up' : 'down'}), escalation ${cfg.escalate ? cfg.escalateModel : 'off'}, confidence threshold ${cfg.confidence}`,
    `  local trust: ${Object.entries(sh.opt.trust)
      .filter(([k]) => k !== 'default')
      .map(([k, v]) => `${k} ${v >= 1 ? 'never' : v}`)
      .join(', ')}`,
    '  /hmind log | on | off | reset | right <id> | wrong <id>',
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

export const register: Register = (on, options) => {
  const sh: Shared = {
    cfg: defaultConfig(options),
    opt: {
      bashGuard: options.bashGuard !== false,
      denyAt: clamp(Number(options.denyAt ?? 0.85), 0.5, 0.99),
      trimOver: Math.max(0, Number(options.trimOver ?? 6000)),
      routeEffort: options.routeEffort !== false,
      doneCheck: String(options.doneCheck ?? 'toast'),
      compactAt: Math.max(0, Number(options.compactAt ?? 55)),
      trust: parseTrust(options.localTrust ?? 'gate=0.75,done=0.75,boundary=0.8,effort=1,trim=1,tool=0.85', clamp(Number(options.confidence ?? 0.75), 0.5, 0.99)),
    },
    enabled: true,
    localUp: false,
    wantsCompact: false,
    mainTurn: undefined,
    turns: new Map(),
    pendingTrims: [],
  }
  const { cfg, opt } = sh

  // ------------------------------------------------------------ session

  on('session.start', async ($, e, next) => {
    sh.enabled = (await loadStats($)).enabled
    await registerSurface($)
    void ensureLocal($, sh).catch(() => undefined)
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
      if (sh.enabled && opt.routeEffort && e.agentId === undefined && e.index === 0 && typeof e.effort === 'string') {
        const text = sh.turns.get(e.turnId)?.prompt ?? ''
        if (text.length >= 8 && text.length <= 6000 && !text.startsWith('/')) {
          const a = await decideOne($, cfg, sizeState(text), [sizeQuestion], { threshold: opt.trust.effort })
          await log($, sh, 'effort', text, [a])
          const rank: Record<string, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 }
          if (usable(a, 'effort', opt, cfg) && a.choice) {
            if (a.choice.startsWith('a question')) effort = 'low'
            else if (a.choice.startsWith('a small') && (rank[e.effort] ?? 0) > 1) effort = 'medium'
          }
          if (effort !== e.effort) {
            await bumpStats($, s => {
              s.effortLowered += 1
            })
            $.ui.status(`Hmind: effort ${String(effort)} this turn (${a.tier} ${pct(a.confidence)})`)
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

  // ------------------------------------------------------------ Bash: gate, then trim

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const t = e.agentId === undefined && sh.mainTurn ? sh.turns.get(sh.mainTurn) : undefined
    if (t) {
      t.bash += 1
      if (VERIFY.test(e.command)) t.verifications += 1
    }

    // A trimmed output whose command is re-run right away was a trim the model regretted.
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
      const cwd = await $.session.cwd()
      const a = await decideOne($, cfg, gateState(cwd, e.command), [gateQuestion], { threshold: opt.trust.gate })
      await log($, sh, 'gate', e.command, [a])
      if (usable(a, 'gate', opt, cfg) && a.p !== undefined && a.p >= opt.denyAt) {
        await bumpStats($, s => {
          s.denies += 1
        })
        $.ui.toast(`Hmind: refused a shell command judged destructive (${pct(a.p)})`)
        return {
          deny:
            `Hmind refused this command: it looks destructive (p=${a.p}, ${a.tier}${a.why ? `: ${a.why}` : ''}). ` +
            'Do not retry it as is. If it is truly needed, explain the risk to the user and ask them to run it or approve it explicitly.',
        }
      }
    }

    const ran = await next(e)

    if (
      sh.enabled &&
      opt.trimOver > 0 &&
      ran.deny === undefined &&
      ran.isError === undefined &&
      ran.result &&
      typeof ran.result.stdout === 'string' &&
      ran.result.stdout.length > opt.trimOver &&
      !ran.result.isImage &&
      !ran.result.backgroundTaskId
    ) {
      const out = ran.result.stdout
      const a = await decideOne($, cfg, needState(e.command, out), [needQuestion], { threshold: opt.trust.trim })
      const id = await log($, sh, 'trim', e.command, [a])
      if (usable(a, 'trim', opt, cfg) && a.choice && !a.choice.startsWith('all')) {
        const kept = a.choice.startsWith('only') ? errorsOnly(out) : headTail(out)
        if (kept.length < out.length * 0.8) {
          const saved = out.length - kept.length
          sh.pendingTrims.push({ norm, id, callsLeft: 3 })
          await bumpStats($, s => {
            s.trims += 1
            s.trimmedChars += saved
          })
          $.ui.status(`Hmind: trimmed ${Math.round(saved / 1000)}K chars of output (${a.tier} ${pct(a.confidence)})`)
          const note = `\n\n[Hmind trimmed ${saved} of ${out.length} characters from the middle of this output (${a.choice.split(':')[0]}). Rerun with grep, head or tail if you need a specific part.]`
          return { result: { ...ran.result, stdout: kept + note } }
        }
      }
    }
    return ran
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
      if (percent >= opt.compactAt) {
        sh.wantsCompact = true
        $.ui.status(`Hmind: context ${percent}% full, will compact at the next task boundary`)
      }
    }

    if (opt.doneCheck !== 'off' && e.reason === 'answer' && t && t.edits > 0 && t.verifications === 0 && done.text.length > 40) {
      const a = await decideOne($, cfg, claimsState(t.edits, done.text), [claimsQuestion], { threshold: opt.trust.done })
      await log($, sh, 'done-check', done.text, [a])
      if (usable(a, 'done', opt, cfg) && a.p !== undefined && a.p >= cfg.confidence) {
        await bumpStats($, s => {
          s.unverifiedClaims += 1
        })
        $.ui.toast(`Hmind: completion claimed, but nothing was run to verify it this turn (${pct(a.p)})`)
        if (opt.doneCheck === 'prompt') {
          void $.prompt.submit({
            text: 'Hmind: you reported the work as done, but no test, build or run command was executed this turn. Verify it now with the relevant command, or state plainly that it is unverified.',
          })
        }
      }
    }
    return done
  })

  // ------------------------------------------------------------ next prompt: compact at a boundary

  on('prompt.submit', async ($, e, next) => {
    if (sh.enabled && sh.wantsCompact && opt.compactAt > 0 && e.command === undefined && !e.isMeta && e.turnId === undefined && e.text.length >= 4) {
      const msgs = await $.session.messages()
      const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant')?.text ?? ''
      const a = await decideOne($, cfg, boundaryState(lastAssistant, e.text), [boundaryQuestion], { threshold: opt.trust.boundary })
      await log($, sh, 'boundary', e.text, [a])
      if (usable(a, 'boundary', opt, cfg) && a.p !== undefined && a.p >= cfg.confidence) {
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
    // A registered tool answers with a string (or content blocks); the model reads it as the tool's result.
    const input = e as unknown as { state?: unknown; questions?: unknown }
    if (typeof input.state !== 'string') return { result: 'error: decide needs a string `state`.' }
    const questions = parseQuestions(input.questions)
    if (typeof questions === 'string') return { result: `error: ${questions}` }
    const answers = await decide($, cfg, input.state, questions, { threshold: opt.trust.tool })
    await log($, sh, 'tool', `${questions.length} question(s)`, answers)
    return { result: formatAnswers(answers) }
  })

  // ------------------------------------------------------------ /hmind

  on('command.run', { command: 'hmind' }, async ($, e) => {
    const args = String((e as { args?: unknown }).args ?? '').trim()
    const [verb, arg] = args.split(/\s+/)
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
    if ((verb === 'right' || verb === 'wrong') && arg) {
      const ok = await markOutcome($, arg, verb)
      return { text: ok ? `decision ${arg} marked ${verb}.` : `no decision ${arg} in the log.` }
    }
    if (verb === 'log') return { text: await logText($) }
    return { text: await statsText($, sh) }
  })
}
