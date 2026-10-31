// Hmind: a second brain for Claude Code.
//
// Where a cheap, calibrated judgment pays for itself:
//   1. tool.call Bash (before): refuse a command judged destructive, unless a learned rule allows it.
//   2. tool.call Bash (after): trim bulky output, or digest it when the failures are what matters.
//   3. turn.step 0: right-size the model's effort to the prompt, tighter as the plan's budget fills.
//   4. turn.complete: flag a "done" claim made without running any check; optionally verify it.
//   5. prompt.submit: compact at a task boundary once context is full; learn allow rules from approvals.
//   6. agent.spawn: route lookup and mechanical subagent work to cheaper models; warn on needless forks.
//   7. every model call: a ledger of tokens and list-price cost by who made it and on which model (/hmind usage).
//   8. orchestrate tool: the model hands over a plan of tasks with dependencies; Hmind runs them as parallel
//      subagents on the cheapest adequate model, retries failures a tier up, digests the reports, prices the run.
//   9. the model's own agents: a cap on how many run at once, duplicates refused, long reports digested.
// Plus a `decide` tool the model can call itself, and `/hmind` for stats, usage and control.
// Every hook fails open: when the judge is unavailable or unsure, nothing changes.

import type { Register, EngineInterface } from 'claude-code'

import { agentsText, isActive, overlap, waitForSlot } from './agents'
import type { AgentNote } from './agents'
import { compactAtFor, describePressure, effortFor, readPressure, trimOverFor } from './budget'
import type { Effort, Pressure, Size } from './budget'
import { digest, digestReport } from './digest'
import { clearLedgers, ledgerText, loadLedger, recordAvoided, recordModelCall, recordRequest, resetAvoided, setLedgerSession, summarize, updateLedger } from './ledger'
import { ZERO, addUsage, agentNameFor, boardDirFor, duration, loadRuns, makeLauncher, newRunId, parallelFor, parsePlan, rememberRun, runDetail, runPlan, runText, runsText } from './orchestrate'
import type { Plan, Progress, RunCtx, Status, Waiter } from './orchestrate'
import { money, usdOf } from './pricing'
import { bumpStats, calibration, clamp, decide, decideOne, defaultConfig, emptyStats, loadStats, markOutcome, recordAnswers, remember } from './judge'
import type { Answer, DecisionRecord, JudgeConfig, Question } from './judge'
import {
  approvalQuestion,
  approvalState,
  boundaryQuestion,
  boundaryState,
  claimsQuestion,
  claimsState,
  dupQuestion,
  dupState,
  forkQuestion,
  gateQuestion,
  gateState,
  needQuestion,
  needState,
  outcomeQuestion,
  outcomeState,
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

// Read-only commands that are never judged (Unix shells, Git Bash on Windows, and PowerShell).
const SAFE_BASH =
  /^\s*(ls|cat|head|tail|wc|grep|rg|fd|pwd|which|where|echo|printf|stat|file|du|df|env|printenv|date|uname|sw_vers|sysctl|dir|type|tree|Get-ChildItem|Get-Content|Get-Location|Get-Item|Select-String|Get-Process|Get-Date|gci|gc|git (status|log|diff|show|branch|remote|rev-parse|ls-files|blame)|npm (ls|list|view|outdated|test)|pnpm (ls|test)|yarn (test|lint)|node -v|python3? (-V|--version)|py -(V|-version)|pip3? (list|show)|tsc\b|cargo (check|test|build)|go (test|build|vet)|dotnet (test|build)|pytest|vitest|jest)\b/i
// A command that chains or substitutes other commands: a safe prefix then proves nothing about the rest.
const CHAINED = /&&|\|\||;|\||\$\(|`|\n/
// Markers that make a command worth judging (Unix, Windows cmd, and PowerShell forms).
const RISKY =
  /\brm\b|\bmv\b|--force|\s-f\b|-rf\b|reset --hard|checkout -- |\bpush\b|\bsudo\b|\bchmod\b|\bchown\b|\bdd\b|mkfs|\btruncate\b|\bDROP\b|\bDELETE\b|\bTRUNCATE\b|\bkill\b|pkill|killall|launchctl|defaults write|git clean|\brebase\b|\bshred\b|:\(\)\s*\{|>\s*\/|\b(curl|wget)\b.*\|\s*(ba|z)?sh\b|diskutil|\bcrontab\b|\bsystemctl\b|\bbrew (uninstall|remove)\b|npm (uninstall|publish|unpublish)|pip3? uninstall|\bdel\b|\berase\b|\brd\b|\brmdir\b|\bformat\b|\bdiskpart\b|Remove-Item|Remove-ItemProperty|Clear-Content|Format-Volume|Clear-Disk|Initialize-Disk|Stop-Process|taskkill|Stop-Computer|Restart-Computer|\bshutdown\b|\bbcdedit\b|\breg (delete|add)\b|\bicacls\b|\btakeown\b|Set-ExecutionPolicy|Invoke-Expression|\biex\b|Invoke-WebRequest.*\|\s*iex|\birm\b.*\|\s*iex|\bschtasks\b|\bnet (user|localgroup)\b|\bsc (delete|config)\b|\bwmic\b|Set-ItemProperty.*HK(LM|CU)/i
// Commands that count as verifying the work (tests, builds, type checks, runs) on any platform.
const VERIFY =
  /\b(npm|pnpm|yarn|bun)\s+(test|run\s+(test|build|lint|typecheck|check|e2e|dev))\b|\bpytest\b|\bvitest\b|\bjest\b|\bcargo (test|build|check|clippy|run)\b|\bgo (test|build|vet|run)\b|\btsc\b|\bmvnw?(\.cmd)?\b|\bgradlew?(\.bat)?\b|\bmake\b|\bflutter (test|analyze|build|run)\b|\bdart (test|analyze)\b|\bphpunit\b|\brspec\b|\beslint\b|\bruff\b|\bmypy\b|\bxcodebuild\b|\bdotnet (test|build|run)\b|\bmsbuild\b|\bcurl\b.*(localhost|127\.0\.0\.1)|Invoke-WebRequest.*(localhost|127\.0\.0\.1)|\bnpx playwright\b|\bcypress\b|\b(python3?|py)\b.*(-m pytest|test)|\bnode .*test|\bmix test\b/i

type TurnState = { prompt: string; edits: number; verifications: number; bash: number }
type PendingTrim = { norm: string; id: string; callsLeft: number }

type Options = {
  bashGuard: boolean
  denyAt: number
  trimOver: number
  routeEffort: boolean
  doneCheck: string
  compactAt: number
  budgetMode: boolean
  subagents: boolean
  digest: boolean
  autoVerify: boolean
  learnRules: boolean
  orchestrate: boolean
  maxParallel: number
  taskTimeoutMin: number
  retryUp: boolean
  agentCap: number
  dedupeAgents: boolean
  agentReportOver: number
}

/** Everything the hooks share; a hot reload starts it over (trust, rules and stats live in $.store). */
type Shared = {
  cfg: JudgeConfig
  opt: Options
  enabled: boolean
  wantsCompact: boolean
  mainTurn: string | undefined
  turns: Map<string, TurnState>
  pendingTrims: PendingTrim[]
  rules: Rule[]
  pressure: Pressure
  root: string
  lastDeny?: { command: string; turn: number }
  verifyPrompted: boolean
  /** subagents Hmind routed to a cheaper model: agent id -> the parent model it would have run on */
  routed: Map<string, string>
  /** requests made per turn, counted at turn.step */
  steps: Map<string, number>
  mainModel: string
  /** every agent seen this session, by id */
  agents: Map<string, AgentNote>
  /** prompts of the agents the orchestrator itself spawned, while they run */
  ours: Set<string>
  /** orchestrated agents: agent id -> the parent model they would have run on */
  orchestrated: Map<string, string>
  /** orchestrations in flight */
  runs: number
  /** orchestrated agents whose report the launcher is waiting for */
  waiting: Map<string, Waiter>
  /** the run in flight, for /hmind runs */
  live?: Progress & { goal: string; startedAt: number }
  /** agent names of the current and last run, whose hand-back messages Hmind absorbs */
  recentAgents: Set<string>
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const normalize = (command: string) => command.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 160)
const pct = (p: number) => `${Math.round(p * 100)}%`

/** A judge answer is usable for an automatic action above the confidence threshold. */
const usable = (a: Answer, sh: Shared): boolean => a.tier !== 'none' && a.confidence >= sh.cfg.confidence

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

// ------------------------------------------------------------ logging

/** Record a batch of answers for the stats and the decision log. */
async function log($: EngineInterface, kind: string, summary: string, answers: Answer[]): Promise<string> {
  const id = newId()
  const rec: DecisionRecord = { id, at: new Date().toISOString(), kind, summary: summary.slice(0, 160), answers }
  await recordAnswers($, answers)
  await remember($, rec)
  return id
}

// ------------------------------------------------------------ the model's own agents: a cap and a duplicate check

/** Hold a new agent until a slot frees, and refuse one that duplicates an agent already running. Returns the refusal text, if any. */
async function govern($: EngineInterface, sh: Shared, e: { description: string; prompt: string }): Promise<string | undefined> {
  const { opt, cfg } = sh
  if (opt.agentCap > 0) {
    const cap = opt.budgetMode ? parallelFor(sh.pressure.level, opt.agentCap) : opt.agentCap
    const { waited, active } = await waitForSlot($, cap, 7000)
    if (active.length >= cap) {
      await bumpStats($, s => {
        s.agentsHeld += 1
      })
      $.ui.toast(`Hmind: refused a new agent, ${active.length} already running (cap ${cap})`)
      return (
        `Hmind refused this agent for now: ${active.length} agents are already running (cap ${cap}${sh.pressure.level !== 'normal' ? `, lowered by budget pressure` : ''}): ` +
        `${active.map(a => `${a.description} (${a.id})`).join('; ')}. Wait for one to finish, then launch it again.`
      )
    }
    if (waited > 2500) {
      await bumpStats($, s => {
        s.agentsHeld += 1
      })
      $.ui.toast(`Hmind: held "${e.description.slice(0, 40)}" ${Math.round(waited / 1000)} s until an agent slot freed`)
    }
  }
  if (!opt.dedupeAgents) return undefined
  const active = (await $.agent.list().catch(() => [])).filter(isActive)
  const mine = `${e.description} ${e.prompt.slice(0, 400)}`
  const twin = active.map(a => ({ a, note: sh.agents.get(a.id) })).find(({ a, note }) => overlap(mine, `${a.description} ${note?.prompt.slice(0, 400) ?? ''}`) >= 0.35)
  if (!twin) return undefined
  const a = await decideOne($, cfg, dupState(twin.a.description, twin.note?.prompt ?? '', e.description, e.prompt), [dupQuestion])
  await log($, 'duplicate', e.description, [a])
  if (!usable(a, sh) || a.p === undefined || a.p < 0.85) return undefined
  await bumpStats($, s => {
    s.agentsDeduped += 1
  })
  $.ui.toast(`Hmind: refused a duplicate agent ("${e.description.slice(0, 40)}" is already running)`)
  return (
    `Hmind refused this agent: one is already doing this work ("${twin.a.description}", id ${twin.a.id}). ` +
    'Wait for its result instead of starting another; if the task really differs, say how in the description and the prompt.'
  )
}

// ------------------------------------------------------------ orchestration in the background

/** Run a plan after the tool call has answered: a hook's own time is bounded, a detached run is not. The result reaches the model as a message. */
async function startRun($: EngineInterface, sh: Shared, ctx: RunCtx, plan: Plan, id: string): Promise<void> {
  try {
    const rec = await runPlan($, ctx, plan, id)
    await rememberRun($, rec).catch(() => undefined)
    await bumpStats($, s => {
      s.orchestrations += 1
    }).catch(() => undefined)
    $.ui.status(undefined)
    $.ui.toast(`Hmind: run ${id} finished, ${rec.tasks.filter(t => t.status === 'done').length}/${rec.tasks.length} done, ${money(rec.usd)}`)
    await $.prompt.submit({ text: `Hmind run ${id} has finished. Act on the result below.\n\n${runText(rec, ctx.parentModel)}` })
  } catch (err) {
    $.ui.status(undefined)
    $.ui.toast(`Hmind: run ${id} failed: ${String(err).slice(0, 100)}`)
    await $.prompt.submit({ text: `Hmind run ${id} failed before it could finish: ${String(err).slice(0, 500)}. The board at ${boardDirFor(ctx.root, id)} holds what the tasks wrote; /hmind runs may hold a partial record.` }).catch(() => undefined)
  } finally {
    sh.runs -= 1
    sh.live = undefined
  }
}

const liveText = (sh: Shared): string =>
  sh.live ? `in flight: run ${sh.live.id} "${sh.live.goal.slice(0, 60)}", ${sh.live.phase}, ${sh.live.done}/${sh.live.total} done, ${sh.live.running} running, ${money(sh.live.usd)} so far, ${duration(Date.now() - sh.live.startedAt)}\n` : ''

// ------------------------------------------------------------ surface

async function registerSurface($: EngineInterface, withOrchestrate: boolean): Promise<void> {
  await $.command.register({
    name: 'hmind',
    description: 'Hmind: stats, usage and cost by model, decisions, rules, verify, on/off',
    argumentHint: '[usage|cost|tokens [all]|agents|runs|run <id>|report <agent>|log|rules|budget|verify [on|off]|allow <cmd>|forget <n>|right|wrong <id>|reset|on|off]',
  })
  await $.tool.register({
    name: 'decide',
    description:
      'Typed decisions over a state: choice (pick one option), score (0..1 on a rubric) and noul (is a statement true?). ' +
      'Each answer carries probabilities, a confidence (0..1) and a short reason. ' +
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
  if (!withOrchestrate) return
  await $.tool.register({
    name: 'orchestrate',
    description:
      'Run a plan of subtasks as parallel subagents. Give the goal and the tasks (id, prompt, optional description, needs = ids it depends on, kind = lookup | mechanical | judgment). ' +
      'Independent tasks run at once on the cheapest adequate model, each with the digested results of the tasks it needs; a task that fails is retried once on a stronger model; ' +
      'the agents share a plan board and notes so they know each other\'s decisions and files; an integrator then checks the combined work for consistency and the project\'s verification runs. ' +
      'The answer is one digest per task, the consistency verdict and the cost. Use it when work splits into independent pieces instead of launching agents one by one.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'What the whole plan achieves, one or two sentences.' },
        tasks: {
          type: 'array',
          description: 'The tasks, 1 to 24, each self-contained enough for a fresh agent.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Short unique id, e.g. "scan-auth".' },
              description: { type: 'string', description: '3 to 6 words naming the task.' },
              prompt: { type: 'string', description: 'The full task for the agent: what to do, where, and what to report.' },
              needs: { type: 'array', items: { type: 'string' }, description: 'Ids of tasks whose results this one needs; it starts after they finish and sees their digests.' },
              kind: { type: 'string', enum: ['lookup', 'mechanical', 'judgment'], description: 'lookup: find or read facts; mechanical: a well-specified change; judgment: design, debugging, tradeoffs. Picks the model; omitted, Hmind judges it.' },
              model: { type: 'string', enum: ['haiku', 'sonnet', 'opus', 'fable'], description: 'Force a model (never above the parent).' },
              subagentType: { type: 'string', description: 'Agent type, default general-purpose.' },
            },
            required: ['id', 'prompt'],
          },
        },
        conventions: { type: 'string', description: 'Rules every task must follow for the work to be consistent: naming, file layout, libraries, interfaces, test style. Put shared names and signatures here.' },
        maxParallel: { type: 'number', description: 'At most this many tasks at once (default from settings, lowered under budget pressure).' },
        retry: { type: 'boolean', description: 'Retry a failed task once on a stronger model (default true).' },
        integrate: { type: 'boolean', description: 'After the tasks, run an integrator on the parent model that reads every report and notes file, checks the combined work for consistency and fixes what is small (default true).' },
        verify: { type: 'boolean', description: "Run the project's own test or build command on the combined work before and after integration (default true)." },
      },
      required: ['goal', 'tasks'],
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
  const answered = s.decisions - s.unanswered
  const verifyOn = sh.opt.autoVerify || (await $.store.get(`verify:${sh.root}`)) === true
  const u = summarize(await loadLedger($, 'session'))
  return [
    `Hmind ${sh.enabled ? 'on' : 'off'}: ${s.decisions} decisions by ${cfg.judgeModel} (${s.unanswered} unanswered), avg ${answered ? `${Math.round(s.claudeMs / answered)} ms` : 'n/a'} each`,
    `  actions: effort lowered on ${s.effortLowered} turns, ${s.trims} output trims saving ${Math.round(s.trimmedChars / 1000)}K chars (${s.digests} digests, ${s.trimRegrets} regretted), ${s.denies} shell refusals (${s.rulesApplied} allowed by rule), ${s.unverifiedClaims} unverified done claims, ${s.verifications} verification runs (${s.verificationsFailed} failed), ${s.compactions} boundary compactions, ${s.subagentsRouted} subagents routed cheaper, ${s.forkWarnings} fork warnings, ${s.orchestrations} orchestrated runs, ${s.agentsHeld} agents held for a slot, ${s.agentsDeduped} duplicate agents refused, ${s.reportsDigested} agent reports digested, ${s.handbacksDropped} hand-backs absorbed`,
    `  labels: ${c.labeled} labeled decisions, accuracy ${pct(c.accuracy)}, calibration error ${c.ece}`,
    `  budget: ${sh.opt.budgetMode ? describePressure(sh.pressure) || `normal (${sh.pressure.percent}% of the ${sh.pressure.window} window)` : 'budget mode off'}`,
    `  usage this session: Claude ${money(u.claudeUsd)}${u.mainModel ? ` (${u.mainModel}, ${u.requests} requests)` : ''}, Hmind's own calls ${money(u.ownUsd)}, est. ${money(u.savedUsd)} saved at list prices; /hmind usage for the breakdown by model`,
    `  rules: ${sh.rules.filter(r => r.root === sh.root).length} learned for this project; auto-verify ${verifyOn ? 'on' : 'off'} here`,
    `  judge: ${cfg.judgeModel}, confidence threshold ${cfg.confidence}`,
    '  /hmind usage [all] | agents | runs | run <id> | report <agent> | log | rules | allow <cmd> | forget <n> | verify on|off | right|wrong <id> | reset | on | off',
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
      budgetMode: options.budgetMode !== false,
      subagents: options.subagents !== false,
      digest: options.digest !== false,
      autoVerify: options.autoVerify === true,
      learnRules: options.learnRules !== false,
      orchestrate: options.orchestrate !== false,
      maxParallel: clamp(Number(options.maxParallel ?? 3), 1, 8),
      taskTimeoutMin: clamp(Number(options.taskTimeoutMin ?? 10), 1, 120),
      retryUp: options.retryUp !== false,
      agentCap: Math.max(0, Number(options.agentCap ?? 4)),
      dedupeAgents: options.dedupeAgents !== false,
      agentReportOver: Math.max(0, Number(options.agentReportOver ?? 6000)),
    },
    enabled: true,
    wantsCompact: false,
    mainTurn: undefined,
    turns: new Map(),
    pendingTrims: [],
    rules: [],
    pressure: { level: 'normal', percent: 0, window: 'none' },
    root: '',
    verifyPrompted: false,
    routed: new Map(),
    steps: new Map(),
    mainModel: '',
    agents: new Map(),
    ours: new Set(),
    orchestrated: new Map(),
    runs: 0,
    waiting: new Map(),
    recentAgents: new Set(),
  }
  const { opt } = sh
  let lastLevel = 'normal'

  // ------------------------------------------------------------ session

  on('session.start', async ($, e, next) => {
    sh.enabled = (await loadStats($)).enabled
    sh.root = await $.session.root().catch(() => e.cwd)
    sh.rules = await loadRules($)
    const usage = await $.session.usage().catch(() => undefined)
    setLedgerSession(String(usage?.startedAt ?? Date.now()))
    await registerSurface($, opt.orchestrate)
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
            'served by a Claude judge model. Reach for it when you must classify, rank, route, gate or triage many items, or check a claim quickly, instead of reasoning about each at length.' +
            (opt.orchestrate
              ? ' An `orchestrate` tool (mcp__hmind__orchestrate) runs a plan you write as parallel subagents: give it the goal and the tasks with ids, prompts, `needs` (the ids a task depends on) and a kind (lookup, mechanical, judgment). ' +
                'Hmind runs independent tasks at once on the cheapest adequate model, keeps a shared board and notes so every agent knows the others\' decisions and files, feeds each task the digested results of the ones it needs, retries a failed task once on a stronger model, then runs an integrator and the project\'s verification over the combined work, and returns one digest per task with the consistency verdict and the cost. Put the rules the work must share in `conventions`. ' +
                'Use it instead of launching agents one by one when work splits into three or more independent pieces; keep the judgment-heavy work for yourself.'
              : ''),
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
      sh.steps.set(e.turnId, (sh.steps.get(e.turnId) ?? 0) + 1)
      if (e.agentId === undefined) {
        sh.mainModel = e.model
        await recordRequest($, e.model)
      }
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
            const a = await decideOne($, cfg, state, [sizeQuestion])
            await log($, 'effort', text, [a])
            if (usable(a, sh) && a.choice) {
              const size: Size = a.choice.startsWith('a question') ? 'trivial' : a.choice.startsWith('a small') ? 'small' : 'large'
              effort = effortFor(opt.budgetMode ? sh.pressure.level : 'normal', size, e.effort as Effort)
            }
            if (effort !== e.effort) {
              await bumpStats($, s => {
                s.effortLowered += 1
              })
              await updateLedger($, l => {
                l.notPriced.effortLowered += 1
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

    const plainlySafe = SAFE_BASH.test(e.command) && !CHAINED.test(e.command)
    if (sh.enabled && opt.bashGuard && RISKY.test(e.command) && !plainlySafe) {
      const rule = matchRule(sh.rules, sh.root, e.command)
      if (rule) {
        await bumpStats($, s => {
          s.rulesApplied += 1
        })
        $.ui.status(`Hmind: allowed by a learned rule (${rule.via})`)
      } else {
        const cwd = await $.session.cwd()
        const state = gateState(cwd, e.command)
        const a = await decideOne($, cfg, state, [gateQuestion])
        await log($, 'gate', e.command, [a])
        if (usable(a, sh) && a.p !== undefined && a.p >= opt.denyAt) {
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
      const a = await decideOne($, cfg, state, [needQuestion])
      const id = await log($, 'trim', e.command, [a])
      if (usable(a, sh) && a.choice && !a.choice.startsWith('all')) {
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
          await recordAvoided($, saved).catch(() => undefined)
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
    if (!sh.enabled || e.parentAgentId !== undefined) return next(e)
    const ours = sh.ours.has(e.prompt)
    let spawn = e
    let rerouted = false
    if (!ours && opt.subagents) {
      const refused = await govern($, sh, e)
      if (refused) return { deny: refused }
      if (e.subagentType === 'fork') {
        const state = spawnState(e.subagentType, e.description, e.prompt)
        const a = await decideOne($, cfg, state, [forkQuestion])
        await log($, 'fork', e.description, [a])
        if (usable(a, sh) && a.p !== undefined && a.p <= 1 - cfg.confidence) {
          await bumpStats($, s => {
            s.forkWarnings += 1
          })
          $.ui.toast(`Hmind: this fork copies the whole conversation, but its task looks self-contained (${pct(1 - a.p)}); a general-purpose agent would be far cheaper`)
        }
      } else if (e.model === undefined) {
        const state = spawnState(e.subagentType, e.description, e.prompt)
        const a = await decideOne($, cfg, state, [spawnQuestion])
        await log($, 'spawn', e.description, [a])
        if (usable(a, sh) && a.choice) {
          const tight = opt.budgetMode && (sh.pressure.level === 'high' || sh.pressure.level === 'critical')
          const target = a.choice.startsWith('a lookup') ? 'haiku' : a.choice.startsWith('mechanical') || tight ? 'sonnet' : undefined
          if (target && rankOf(target) < rankOf(e.parentModel)) {
            await bumpStats($, s => {
              s.subagentsRouted += 1
            })
            $.ui.status(`Hmind: subagent "${e.description.slice(0, 40)}" routed to ${target} (${a.tier} ${pct(a.confidence)})`)
            spawn = { ...e, model: target }
            rerouted = true
          }
        }
      }
    }
    const r = await next(spawn)
    if (r.agentId !== undefined) {
      sh.agents.set(r.agentId, { id: r.agentId, description: e.description, prompt: e.prompt, model: r.model, startedAt: await $.clock.now(), usage: { ...ZERO }, usd: 0, ours })
      if (ours) sh.orchestrated.set(r.agentId, e.parentModel)
      else if (rerouted) sh.routed.set(r.agentId, e.parentModel)
    }
    return r
  }).catch(($, e, next) => next(e))

  // ------------------------------------------------------------ the model's own agents: long reports digested

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const ran = await next(e)
    if (!sh.enabled || opt.agentReportOver <= 0 || sh.ours.has(e.prompt) || ran.deny !== undefined || ran.isError) return ran
    const res = ran.result as unknown as { status?: string; agentId?: string; content?: { type: 'text'; text: string }[] }
    if (res.status !== 'completed' || !res.content || !res.agentId) return ran
    const text = res.content.map(c => c.text).join('\n')
    if (text.length <= opt.agentReportOver) return ran
    const d = await digestReport($, cfg, e.description, text).catch(() => undefined)
    if (!d || d.length >= text.length * 0.8) return ran
    await $.store.set(`report:${res.agentId}`, text.slice(0, 60000))
    await recordAvoided($, text.length - d.length)
    await bumpStats($, s => {
      s.reportsDigested += 1
      s.trimmedChars += text.length - d.length
    })
    $.ui.status(`Hmind: digested a ${Math.round(text.length / 1000)}K-char agent report`)
    const result = { ...res, content: [{ type: 'text' as const, text: `${d}\n\n[Hmind digested this report from ${text.length} characters; the full text: /hmind report ${res.agentId}]` }] } as unknown as typeof ran.result
    return { result }
  }).catch(($, e, next) => next(e))

  // ------------------------------------------------------------ orchestrate: the model plans, Hmind runs

  on('tool.call', { tool: /^mcp__hmind__orchestrate$/ }, async ($, e) => {
    if (e.agentId !== undefined) return { result: 'error: orchestrate runs from the main conversation only; a subagent cannot start a plan.' }
    const plan = parsePlan(e)
    if (typeof plan === 'string') return { result: `error: ${plan}` }
    if (sh.runs > 0) return { result: `error: run ${sh.live?.id ?? '?'} is still in flight (${sh.live ? `${sh.live.done}/${sh.live.total} done` : 'starting'}); its result will arrive as a message. Wait for it before starting another plan.` }
    if (opt.budgetMode) sh.pressure = await readPressure($)
    const id = newRunId()
    {
      const ctx: RunCtx = {
        cfg,
        root: sh.root || (await $.session.cwd()),
        parentModel: sh.mainModel || 'opus',
        maxParallel: opt.budgetMode ? parallelFor(sh.pressure.level, opt.maxParallel) : opt.maxParallel,
        retry: plan.retry && opt.retryUp,
        launch: makeLauncher($, sh.waiting, sh.ours, sh.mainModel || 'opus', opt.taskTimeoutMin * 60000),
        classify: async t => {
          const state = spawnState(t.subagentType ?? 'general-purpose', t.description, t.prompt)
          const a = await decideOne($, cfg, state, [spawnQuestion])
          await log($, 'spawn', t.description, [a])
          if (!usable(a, sh) || !a.choice) return undefined
          return a.choice.startsWith('a lookup') ? 'lookup' : a.choice.startsWith('mechanical') ? 'mechanical' : 'judgment'
        },
        judgeStatus: async (t, report) => {
          const a = await decideOne($, cfg, outcomeState(t.prompt, report), [outcomeQuestion])
          await log($, 'outcome', t.description, [a])
          const status: Status = usable(a, sh) && a.choice ? (a.choice.startsWith('done') ? 'done' : a.choice.startsWith('partial') ? 'partial' : 'failed') : 'partial'
          return status
        },
        verify: async () => {
          const command = await detectVerifyCommand($, sh.root)
          if (!command) return undefined
          const r = await runVerify($, command)
          await bumpStats($, s => {
            s.verifications += 1
            if (!r.ok) s.verificationsFailed += 1
          })
          return { command, ok: r.ok && !r.denied, text: r.denied ? `the run was refused: ${r.denied}` : r.text }
        },
        progress: p => {
          sh.live = { ...p, goal: plan.goal, startedAt: sh.live?.startedAt ?? Date.now() }
          $.ui.status(p.text)
        },
      }
      sh.runs += 1
      sh.recentAgents = new Set([...plan.tasks.map(t => agentNameFor(t.id)), agentNameFor('integrate')])
      sh.live = { id, phase: 'tasks', done: 0, total: plan.tasks.length, running: 0, usd: 0, text: 'starting', goal: plan.goal, startedAt: Date.now() }
      $.ui.toast(`Hmind: run ${id} started, ${plan.tasks.length} task${plan.tasks.length === 1 ? '' : 's'}, up to ${ctx.maxParallel} at once`)
      void startRun($, sh, ctx, plan, id)
      const first = plan.tasks.filter(t => t.needs.length === 0).map(t => t.id)
      return {
        result:
          `Hmind started run ${id} in the background: ${plan.tasks.length} task${plan.tasks.length === 1 ? '' : 's'}, up to ${ctx.maxParallel} at once; starting now: ${first.slice(0, ctx.maxParallel).join(', ')}. ` +
          `Lookups run on haiku, mechanical tasks on sonnet, judgment on ${ctx.parentModel}; the agents share the board at ${boardDirFor(ctx.root, id)}. ` +
          'You will receive the result as a message when the run finishes: one digest per task, the consistency verdict and the cost. ' +
          'Do not start another plan or launch agents for these tasks meanwhile; /hmind runs shows progress. If nothing else is pending, end your turn and wait.',
      }
    }
  })

  // ------------------------------------------------------------ end of turn

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const usage = done.usage ?? e.usage
    const waiter = e.agentId !== undefined ? sh.waiting.get(e.agentId) : undefined
    if (waiter && e.agentId !== undefined) {
      sh.waiting.delete(e.agentId)
      waiter({ text: e.answer, usage, reason: e.reason })
    }
    const calls = sh.steps.get(e.turnId) ?? 1
    sh.steps.delete(e.turnId)
    if (usage) {
      const orch = e.agentId !== undefined ? sh.orchestrated.get(e.agentId) : undefined
      const parent = e.agentId !== undefined ? (orch ?? sh.routed.get(e.agentId)) : undefined
      await recordModelCall($, e.agentId === undefined ? 'main' : orch ? 'orchestrated' : parent ? 'routed' : 'subagent', usage.model, usage, calls, parent).catch(() => undefined)
      const note = e.agentId !== undefined ? sh.agents.get(e.agentId) : undefined
      if (note) {
        note.usage = addUsage(note.usage, usage)
        note.usd += usdOf(usage.model, usage)
        note.model = usage.model
        note.endedAt = await $.clock.now()
      }
    }
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
      const a = await decideOne($, cfg, state, [claimsQuestion])
      await log($, 'done-check', done.text, [a])
      if (usable(a, sh) && a.p !== undefined && a.p >= cfg.confidence) {
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
    if (sh.recentAgents.size > 0 && (e.origin.kind === 'peer-send-message' || e.origin.kind === 'peer') && e.command === undefined) {
      const from = e.text.match(/from="(hmind-[A-Za-z0-9_-]+)"/)?.[1]
      if (from && sh.recentAgents.has(from)) {
        await bumpStats($, s => {
          s.handbacksDropped += 1
        })
        return { drop: `Hmind took the report of ${from} into its run; the digest comes with the run's result, the full text with /hmind run <id>.` }
      }
    }
    const typed = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (typed && e.command === undefined && !e.isMeta) sh.verifyPrompted = false

    if (sh.enabled && opt.learnRules && sh.lastDeny && typed && e.command === undefined && !e.isMeta && e.text.length >= 2) {
      const turn = await $.session.turns().catch(() => 0)
      if (turn - sh.lastDeny.turn <= 2) {
        const state = approvalState(sh.lastDeny.command, e.text)
        const a = await decideOne($, cfg, state, [approvalQuestion])
        await log($, 'approval', e.text, [a])
        if (usable(a, sh) && a.p !== undefined && a.p >= 0.8) {
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
      const a = await decideOne($, cfg, state, [boundaryQuestion])
      await log($, 'boundary', e.text, [a])
      if (usable(a, sh) && a.p !== undefined && a.p >= cfg.confidence) {
        const r = await $.session.compact({ instructions: KEEP_RULES })
        if (!('skip' in r)) {
          sh.wantsCompact = false
          await bumpStats($, s => {
            s.compactions += 1
          })
          await updateLedger($, l => {
            l.notPriced.compactions += 1
          })
          $.ui.toast('Hmind: compacted the conversation at a task boundary')
        }
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    const instructions = e.instructions?.includes(KEEP_RULES) ? e.instructions : e.instructions ? `${e.instructions}\n\n${KEEP_RULES}` : KEEP_RULES
    const r = await next({ ...e, instructions })
    if (!('skip' in r)) {
      await resetAvoided($).catch(() => undefined)
      if (r.usage) await recordModelCall($, 'compact', sh.mainModel || 'unknown', r.usage).catch(() => undefined)
    }
    return r
  })

  // ------------------------------------------------------------ the model's own tool

  on('tool.call', { tool: 'mcp__hmind__decide' }, async ($, e) => {
    const input = e as unknown as { state?: unknown; questions?: unknown }
    if (typeof input.state !== 'string') return { result: 'error: decide needs a string `state`.' }
    const questions = parseQuestions(input.questions)
    if (typeof questions === 'string') return { result: `error: ${questions}` }
    const answers = await decide($, cfg, input.state, questions)
    await log($, 'tool', `${questions.length} question(s)`, answers)
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
      await clearLedgers($)
      return { text: 'Hmind stats and usage ledgers cleared.' }
    }
    if (verb === 'usage' || verb === 'cost' || verb === 'tokens') {
      const all = rest === 'all'
      const led = await loadLedger($, all ? 'all' : 'session')
      const cli = all ? undefined : (await $.session.usage().catch(() => undefined))?.cost?.usd
      return { text: ledgerText(led, { title: all ? 'Hmind usage, all sessions' : 'Hmind usage, this session', cliUsd: cli }) }
    }
    if ((verb === 'right' || verb === 'wrong') && rest) {
      const ok = await markOutcome($, rest, verb)
      return { text: ok ? `decision ${rest} marked ${verb}.` : `no decision ${rest} in the log.` }
    }
    if (verb === 'log') return { text: await logText($) }
    if (verb === 'agents') return { text: agentsText(await $.agent.list().catch(() => []), sh.agents, await $.clock.now()) }
    if (verb === 'runs') return { text: `${liveText(sh)}${runsText(await loadRuns($))}` }
    if (verb === 'run' && rest) {
      const rec = (await loadRuns($)).find(r => r.id === rest)
      if (!rec && sh.live?.id === rest) return { text: `${liveText(sh)}board: ${boardDirFor(sh.root, rest)}` }
      return { text: rec ? runDetail(rec) : `no run ${rest}; /hmind runs lists them.` }
    }
    if (verb === 'report' && rest) {
      const full = (await $.store.get(`report:${rest}`)) as string | undefined
      return { text: full ?? `no stored report for agent ${rest}; only reports Hmind digested are kept.` }
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
