// Orchestration: the model plans, Hmind runs, and the agents work as one team.
//
// A plan is a set of tasks with dependencies. Hmind runs them in waves, as many at
// once as the budget allows, each on the cheapest model adequate for its kind, with
// the digested results of its dependencies in its prompt. A task that ends blocked,
// failed, silent or out of time is retried once on the next model up.
//
// The agents know about each other through a plan board Hmind keeps on disk for
// the run: the goal, the contract every agent follows, every task with its status,
// model and agent name, and the results so far. Each agent keeps a notes file next
// to it (the files it owns, the shared names it decided) that the others read before
// they edit. When the tasks are done, Hmind runs the project's verification, then an
// integrator on the parent model that checks the combined work for consistency and
// fixes what is small, then verification again. The main model gets one digest per
// task, the integration verdict and the cost; the full reports stay for `/hmind run`.

import type { EngineInterface } from 'claude-code'

import type { Level } from './budget'
import { digestReport } from './digest'
import type { JudgeConfig } from './judge'
import { joinPath } from './platform'
import { fmt, money, usdOf } from './pricing'
import type { Usage } from './pricing'

export type Kind = 'lookup' | 'mechanical' | 'judgment'
export type Alias = 'haiku' | 'sonnet' | 'opus' | 'fable'
export type Task = { id: string; description: string; prompt: string; needs: string[]; kind?: Kind; model?: Alias; subagentType?: string }
export type Plan = { goal: string; tasks: Task[]; maxParallel?: number; retry: boolean; conventions?: string; integrate: boolean; verify: boolean }
export type Status = 'done' | 'partial' | 'blocked' | 'failed' | 'timeout' | 'skipped'
export type TaskResult = {
  id: string
  description: string
  status: Status
  model: string
  attempts: number
  ms: number
  usage: Usage
  usd: number
  /** what the same tokens would have cost on the parent model */
  parentUsd: number
  files: string[]
  digest: string
  report: string
}
export type VerifyOutcome = { when: 'before' | 'after'; command: string; ok: boolean; tail: string }
export type RunRecord = {
  id: string
  goal: string
  at: string
  ms: number
  dir: string
  tasks: TaskResult[]
  integration?: TaskResult
  verify: VerifyOutcome[]
  usd: number
  parentUsd: number
}

const KINDS = new Set(['lookup', 'mechanical', 'judgment'])
const ALIASES = new Set(['haiku', 'sonnet', 'opus', 'fable'])
export const ZERO: Usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
export const addUsage = (a: Usage, b: Usage): Usage => ({
  input_tokens: a.input_tokens + b.input_tokens,
  output_tokens: a.output_tokens + b.output_tokens,
  cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
  cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
})

// ---------------------------------------------------------------- the plan

export function parsePlan(raw: unknown): Plan | string {
  const r = raw as { goal?: unknown; tasks?: unknown; maxParallel?: unknown; retry?: unknown; conventions?: unknown; integrate?: unknown; verify?: unknown }
  if (typeof r.goal !== 'string' || r.goal.trim().length < 3) return 'orchestrate needs a `goal` string.'
  if (!Array.isArray(r.tasks) || r.tasks.length === 0 || r.tasks.length > 24) return 'orchestrate needs 1 to 24 `tasks`.'
  const tasks: Task[] = []
  const ids = new Set<string>()
  for (const item of r.tasks as Record<string, unknown>[]) {
    const id = String(item.id ?? '')
      .trim()
      .replace(/[^A-Za-z0-9_-]+/g, '-')
    if (!id) return 'every task needs an `id`.'
    if (id === 'integrate') return 'the id "integrate" is reserved for the integration pass.'
    if (ids.has(id)) return `task id "${id}" is used twice.`
    ids.add(id)
    if (typeof item.prompt !== 'string' || item.prompt.trim().length < 10) return `task "${id}" needs a \`prompt\` of at least 10 characters.`
    const needs = Array.isArray(item.needs) ? item.needs.map(n => String(n).trim().replace(/[^A-Za-z0-9_-]+/g, '-')) : []
    const kind = item.kind === undefined ? undefined : String(item.kind)
    if (kind !== undefined && !KINDS.has(kind)) return `task "${id}": kind must be lookup, mechanical or judgment.`
    const model = item.model === undefined ? undefined : String(item.model)
    if (model !== undefined && !ALIASES.has(model)) return `task "${id}": model must be haiku, sonnet, opus or fable.`
    tasks.push({
      id,
      description: String(item.description ?? id)
        .replace(/[\r\n|]+/g, ' ')
        .trim()
        .slice(0, 60),
      prompt: item.prompt.trim(),
      needs,
      kind: kind as Kind | undefined,
      model: model as Alias | undefined,
      subagentType: item.subagentType === undefined ? undefined : String(item.subagentType),
    })
  }
  for (const t of tasks) for (const n of t.needs) if (!ids.has(n)) return `task "${t.id}" needs "${n}", which is not in the plan.`
  if (hasCycle(tasks)) return 'the tasks depend on each other in a cycle.'
  const maxParallel = r.maxParallel === undefined ? undefined : Math.max(1, Math.min(8, Number(r.maxParallel) || 1))
  const conventions = typeof r.conventions === 'string' && r.conventions.trim() ? r.conventions.trim().slice(0, 4000) : undefined
  return { goal: r.goal.trim(), tasks, maxParallel, retry: r.retry !== false, conventions, integrate: r.integrate !== false, verify: r.verify !== false }
}

function hasCycle(tasks: Task[]): boolean {
  const indeg = new Map(tasks.map(t => [t.id, t.needs.length]))
  const users = new Map<string, string[]>()
  for (const t of tasks) for (const n of t.needs) users.set(n, [...(users.get(n) ?? []), t.id])
  const queue = tasks.filter(t => t.needs.length === 0).map(t => t.id)
  let seen = 0
  while (queue.length) {
    const id = queue.shift()!
    seen += 1
    for (const u of users.get(id) ?? []) {
      const d = (indeg.get(u) ?? 1) - 1
      indeg.set(u, d)
      if (d === 0) queue.push(u)
    }
  }
  return seen < tasks.length
}

// ---------------------------------------------------------------- models

const RANK: Record<Alias, number> = { haiku: 0, sonnet: 1, opus: 2, fable: 3 }
export const rankOf = (model: string): number => (/haiku/i.test(model) ? 0 : /sonnet/i.test(model) ? 1 : /opus/i.test(model) ? 2 : /fable|mythos/i.test(model) ? 3 : 2)

/** The alias a task starts on; undefined means the parent's own model. Never above the parent. */
export function modelFor(task: Task, kind: Kind | undefined, parentModel: string): Alias | undefined {
  const want: Alias | undefined = task.model ?? (kind === 'lookup' ? 'haiku' : kind === 'mechanical' ? 'sonnet' : undefined)
  if (!want) return undefined
  return RANK[want] < rankOf(parentModel) ? want : undefined
}

/** One step up for a retry: haiku -> sonnet -> the parent; null when already on the parent. */
export function stepUp(model: Alias | undefined, parentModel: string): Alias | undefined | null {
  if (model === undefined) return null
  if (model === 'haiku' && rankOf(parentModel) > 1) return 'sonnet'
  return undefined
}

/** How many tasks or agents may run at once under this budget pressure. */
export function parallelFor(level: Level, base: number): number {
  if (level === 'high' || level === 'critical') return 1
  if (level === 'elevated') return Math.max(1, Math.ceil(base * 0.66))
  return base
}

// ---------------------------------------------------------------- the board

export const agentNameFor = (taskId: string) => `hmind-${taskId}`
export const boardDirFor = (root: string, runId: string) => joinPath(joinPath(joinPath(root, '.hmind'), 'runs'), runId)
const boardPath = (dir: string) => joinPath(dir, 'board.md')
const notesDir = (dir: string) => joinPath(dir, 'notes')
const notesPath = (dir: string, taskId: string) => joinPath(notesDir(dir), `${taskId}.md`)

const CONTRACT = [
  'Read the board before you start and again before you write your report; it is the one place every task sees.',
  "Follow the project's existing conventions: style, naming, file layout, error handling, test framework. Do not reformat, rename or move what your task does not need.",
  'Before you edit a file, write its path under FILES in your notes file. If another task\'s notes already list that file, do not edit it: say in your report what change it needs, and the owner or the integrator makes it.',
  'When you introduce a shared name (a function, type, route, env var, flag, message format), write it under DECISIONS in your notes with its exact signature before you use it, so every task uses the same one. Reuse a name another task already decided.',
  'Do only your task. If a sibling\'s work conflicts with yours, report it; never undo it.',
  'Write for the integrator: exact paths, names and commands, no narrative.',
]

type Live = { status: 'pending' | 'running' | Status; model?: string }

/** The board every agent reads: goal, contract, tasks with their status, results so far. */
export function renderBoard(runId: string, plan: Plan, live: Map<string, Live>, done: Map<string, TaskResult>, dir: string, parentModel: string, finished: boolean): string {
  const rows = plan.tasks.map(t => {
    const l = live.get(t.id)
    const r = done.get(t.id)
    const cell = (text: string) => text.replace(/[\r\n|]+/g, ' ')
    return `| ${t.id} | ${r?.status ?? l?.status ?? 'pending'} | ${r?.model ?? l?.model ?? '-'} | ${agentNameFor(t.id)} | ${t.needs.join(', ') || '-'} | ${cell(t.description)} | ${cell(r?.files.join(', ') ?? '')} |`
  })
  const results = [...done.values()].map(r => `### ${r.id} (${r.status}, ${r.model})\n${r.digest.length > 700 ? `${r.digest.slice(0, 700)}…` : r.digest}`)
  return [
    `# Hmind run ${runId}`,
    `Goal: ${plan.goal}`,
    `Parent model: ${parentModel}. Status: ${finished ? 'finished' : `running, ${done.size}/${plan.tasks.length} done`}.`,
    '',
    '## Contract (every agent follows this)',
    ...CONTRACT.map(c => `- ${c}`),
    ...(plan.conventions ? ['', '### Conventions for this plan', plan.conventions] : []),
    '',
    '## Tasks',
    '| id | status | model | agent | needs | task | files |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '## Notes',
    `Each agent keeps its own notes file in ${notesDir(dir)} named <task id>.md, with the headings DECISIONS, FILES and OPEN. Read every file there to see what the others decided and which files they own. Running agents are named as in the table; when you have a SendMessage tool you can message one by that name.`,
    '',
    '## Results so far',
    ...(results.length ? results : ['(none yet)']),
    '',
  ].join('\n')
}

async function writeBoard($: EngineInterface, text: string, dir: string): Promise<void> {
  await $.fs.write(boardPath(dir), text)
}

async function prepareBoardDir($: EngineInterface, root: string, dir: string): Promise<void> {
  const ignore = joinPath(joinPath(root, '.hmind'), '.gitignore')
  if (!(await $.fs.exists(ignore).catch(() => true))) await $.fs.write(ignore, '*\n')
  await $.fs.write(joinPath(notesDir(dir), '.keep'), '')
}

/** Every notes file of the run, concatenated, for the integrator and the record. */
export async function readNotes($: EngineInterface, dir: string): Promise<string> {
  const entries = await $.fs.list(notesDir(dir)).catch(() => [])
  const parts: string[] = []
  for (const e of entries) {
    if (e.kind !== 'file' || !e.name.endsWith('.md')) continue
    const text = await $.fs.read(joinPath(notesDir(dir), e.name)).catch(() => '')
    if (typeof text === 'string' && text.trim()) parts.push(`### notes of ${e.name.replace(/\.md$/, '')}\n${text.trim().slice(0, 6000)}`)
  }
  return parts.join('\n\n')
}

// ---------------------------------------------------------------- prompts and reports

export function taskPrompt(plan: Plan, task: Task, done: Map<string, TaskResult>, live: Map<string, Live>, dir: string | undefined, previous?: { model: string; status: Status; tail: string }): string {
  const deps = task.needs.map(n => done.get(n)).filter((r): r is TaskResult => !!r)
  const others = plan.tasks
    .filter(t => t.id !== task.id)
    .map(t => {
      const r = done.get(t.id)
      const l = live.get(t.id)
      const state = r ? r.status : l?.status === 'running' ? `running on ${l.model ?? '?'}` : 'not started'
      return `- ${t.id} (${state}): ${t.description}${r?.files.length ? `; files: ${r.files.join(', ')}` : ''}`
    })
  const parts = [
    `You are running task "${task.id}" of a plan that Hmind is orchestrating for the main assistant. Your agent name is ${agentNameFor(task.id)}.`,
    `Goal of the whole plan: ${plan.goal}`,
    `Your task: ${task.prompt}`,
    ...(dir
      ? [
          `Plan board: ${boardPath(dir)}. Read it first: it has the contract every task follows, every task with its status and files, and the results so far.`,
          `Your notes file: ${notesPath(dir, task.id)}. Create it at once with the headings DECISIONS, FILES and OPEN. Write every file you will edit under FILES before you edit it, and every shared name you introduce under DECISIONS with its exact signature. Read the other files in ${notesDir(dir)} before you edit and again before you report.`,
        ]
      : [`Contract every task follows:\n${CONTRACT.filter(c => !/board|notes/i.test(c)).map(c => `- ${c}`).join('\n')}\nFollow the conventions, touch only the files your task needs, and report every shared name you introduce with its exact signature.`]),
    others.length ? `The other tasks of this plan:\n${others.join('\n')}` : 'You are the only task of this plan.',
  ]
  if (plan.conventions) parts.push(`Conventions for this plan:\n${plan.conventions}`)
  if (deps.length) parts.push(`Results of the tasks yours depends on:\n${deps.map(d => `### ${d.id} (${d.status})\n${d.digest}`).join('\n\n')}`)
  if (previous) parts.push(`A previous attempt on ${previous.model} ended ${previous.status}. Its last lines:\n${previous.tail}\nTake a different approach where that one got stuck.`)
  parts.push(
    'Do only your task; the other tasks have their own agents. Be concise. End your report with exactly these three lines:\n' +
      'STATUS: done | partial | blocked | failed\nFILES: the paths you changed, comma-separated, or none\nSUMMARY: one line',
  )
  return parts.join('\n\n')
}

export function integratorPrompt(plan: Plan, tasks: TaskResult[], notes: string, dir: string | undefined, verify: VerifyOutcome | undefined): string {
  const changed = tasks.filter(t => t.files.length)
  return [
    `You are the integrator of a plan that Hmind orchestrated for the main assistant: ${plan.tasks.length} tasks ran as separate agents, and your job is to make their combined work consistent. Your agent name is ${agentNameFor('integrate')}.`,
    `Goal of the plan: ${plan.goal}`,
    dir ? `Plan board: ${boardPath(dir)}. Notes of every task: ${notesDir(dir)}. Read both.` : 'No board was written for this run; the reports below are what you have.',
    `Files the tasks changed: ${changed.map(t => `${t.id}: ${t.files.join(', ')}`).join('; ') || 'none reported'}.`,
    `Reports:\n${tasks.map(t => `### ${t.id} (${t.status}, ${t.model})\n${t.digest}`).join('\n\n')}`,
    notes ? `Notes:\n${notes}` : 'No notes files were written.',
    verify ? `Verification (${verify.command}) ${verify.ok ? 'PASSED' : 'FAILED'} before you started.${verify.ok ? '' : ` Last lines:\n${verify.tail}`}` : 'No verification command is known for this project.',
    ...(plan.conventions ? [`Conventions for this plan:\n${plan.conventions}`] : []),
    'Check the combined work for consistency: one name for one thing across the tasks, no duplicated helpers, no conflicting or half-applied edits, nothing referenced that is missing, the conventions kept, and every OPEN item in the notes either resolved or carried into your report. ' +
      'Fix what is small and clearly needed, inside the files the tasks touched. Do not redo a task. If verification failed, fix the cause when it is in the tasks\' changes.',
    'End your report with these lines:\nCONSISTENCY: what you checked, what you fixed, what remains (a few lines)\nSTATUS: done | partial | blocked | failed\nFILES: the paths you changed, comma-separated, or none\nSUMMARY: one line',
  ].join('\n\n')
}

/** The LAST status line of a report (an agent may quote the template before its real footer), with markdown bold or list prefixes allowed. */
export function statusOf(report: string): Status | undefined {
  const all = [...report.matchAll(/^[\s>*_`-]*STATUS[*_`]*:[*_`\s]*(done|partial|blocked|failed)\b/gim)]
  const m = all[all.length - 1]
  return m ? (m[1]!.toLowerCase() as Status) : undefined
}

/** The paths of a report's FILES line, split on commas and semicolons only, so a path with spaces survives. */
export function filesOf(report: string): string[] {
  const all = [...report.matchAll(/^[\s>*_`-]*FILES[*_`]*:[*_`]*\s*(.+)$/gim)]
  const m = all[all.length - 1]
  if (!m) return []
  const seen = new Set<string>()
  for (const raw of m[1]!.split(/[,;]/)) {
    const f = raw
      .trim()
      .replace(/^[`'"(*_]+|[`'")*_]+$/g, '')
      .replace(/\.$/, '')
      .trim()
    if (f && !/^(none|n\/a|-|no files?( changed)?|the paths you changed.*)$/i.test(f)) seen.add(f)
  }
  return [...seen].slice(0, 40)
}

// ---------------------------------------------------------------- running

export type AgentOutcome = { text: string; usage: Usage; model: string; ms: number; error?: string; timedOut?: boolean }
export type Launch = (task: Task, model: Alias | undefined, prompt: string) => Promise<AgentOutcome>
export type Finished = { text: string; usage?: Usage & { model?: string }; reason: string }
export type Waiter = (o: Finished) => void

export type Progress = { id: string; phase: 'tasks' | 'verify' | 'integrate' | 'finished'; done: number; total: number; running: number; usd: number; text: string }

export type RunCtx = {
  cfg: JudgeConfig
  root: string
  parentModel: string
  maxParallel: number
  retry: boolean
  launch: Launch
  classify: (task: Task) => Promise<Kind | undefined>
  judgeStatus: (task: Task, report: string) => Promise<Status>
  /** run the project's own verification; undefined when none is known */
  verify: () => Promise<{ command: string; ok: boolean; text: string } | undefined>
  progress: (p: Progress) => void
}

/**
 * The launcher behind the orchestrator: spawn through the engine under the task's
 * agent name, wait for the agent's turn to complete (the `turn.complete` hook
 * resolves the waiter by agent id), and stop an agent that runs past the timeout.
 */
export function makeLauncher($: EngineInterface, waiting: Map<string, Waiter>, ours: Set<string>, parentModel: string, timeoutMs: number): Launch {
  return async (task, model, prompt) => {
    const started = await $.clock.now()
    const label = model ?? parentModel
    ours.add(prompt)
    try {
      const r = await $.agent.spawn({ prompt, description: task.description, subagentType: task.subagentType ?? 'general-purpose', name: agentNameFor(task.id), ...(model ? { model } : {}) })
      if (r.deny !== undefined || r.agentId === undefined) {
        return { text: '', usage: ZERO, model: label, ms: (await $.clock.now()) - started, error: r.deny ?? 'the agent did not start' }
      }
      const id = r.agentId
      const finished = new Promise<Finished>(resolve => waiting.set(id, resolve))
      const timer = new AbortController()
      const out = await Promise.race([finished, $.clock.sleep(timeoutMs, { signal: timer.signal }).then(() => 'timeout' as const, () => 'timeout' as const)])
      const ms = (await $.clock.now()) - started
      if (out !== 'timeout') timer.abort()
      if (out === 'timeout') {
        waiting.delete(id)
        await $.tool.call({ tool: 'TaskStop', task_id: id }).catch(() => undefined)
        return { text: '', usage: ZERO, model: r.model, ms, timedOut: true }
      }
      const { model: ended, ...usage } = out.usage ?? { ...ZERO, model: undefined }
      const error = out.reason === 'aborted' ? 'the agent was aborted' : out.reason === 'error' || out.reason === 'refusal' ? `the agent ended by ${out.reason}` : undefined
      return { text: out.text.trim(), usage, model: ended ?? r.model, ms, error }
    } finally {
      ours.delete(prompt)
    }
  }
}

const failed = (t: Task, why: string): TaskResult => ({ id: t.id, description: t.description, status: 'failed', model: '-', attempts: 0, ms: 0, usage: { ...ZERO }, usd: 0, parentUsd: 0, files: [], digest: why, report: '' })

async function runTask($: EngineInterface, ctx: RunCtx, task: Task, model: Alias | undefined, prompt: (previous?: { model: string; status: Status; tail: string }) => string, onStart: (model: string) => void): Promise<TaskResult> {
  let attempts = 0
  let usage: Usage = { ...ZERO }
  let usd = 0
  let parentUsd = 0
  let ms = 0
  let previous: { model: string; status: Status; tail: string } | undefined
  let last = { text: '', status: 'failed' as Status, model: model ?? ctx.parentModel }
  while (attempts < 2) {
    attempts += 1
    onStart(model ?? ctx.parentModel)
    const out = await ctx.launch(task, model, prompt(previous))
    ms += out.ms
    usage = addUsage(usage, out.usage)
    usd += usdOf(out.model, out.usage)
    parentUsd += usdOf(ctx.parentModel, out.usage)
    const status: Status = out.timedOut ? 'timeout' : out.error || out.text === '' ? 'failed' : (statusOf(out.text) ?? (await ctx.judgeStatus(task, out.text)))
    last = { text: out.text || out.error || '', status, model: out.model }
    if (status === 'done' || status === 'partial' || !ctx.retry || out.error === 'the agent was aborted') break
    const up = stepUp(model, ctx.parentModel)
    if (up === null) break
    previous = { model: out.model, status, tail: last.text.slice(-1200) }
    model = up
  }
  const digest = last.text.length > 1800 ? ((await digestReport($, ctx.cfg, task.description, last.text).catch(() => undefined)) ?? last.text.slice(0, 1800)) : last.text
  return { id: task.id, description: task.description, status: last.status, model: last.model, attempts, ms, usage, usd, parentUsd, files: filesOf(last.text), digest: digest || '(empty report)', report: last.text }
}

const tailOf = (text: string) => text.trim().split('\n').slice(-25).join('\n').slice(-2500)

export const newRunId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

export async function runPlan($: EngineInterface, ctx: RunCtx, plan: Plan, id = newRunId()): Promise<RunRecord> {
  const started = await $.clock.now()
  const dir = boardDirFor(ctx.root, id)
  const byId = new Map(plan.tasks.map(t => [t.id, t]))
  const done = new Map<string, TaskResult>()
  const live = new Map<string, Live>(plan.tasks.map(t => [t.id, { status: 'pending' }]))
  const pending = new Set(plan.tasks.map(t => t.id))
  const running = new Map<string, Promise<void>>()
  const limit = Math.max(1, Math.min(ctx.maxParallel, plan.maxParallel ?? ctx.maxParallel))
  let chain: Promise<void> = Promise.resolve()
  let boardOk = true
  const board = (finished = false) => {
    chain = chain.then(() => writeBoard($, renderBoard(id, plan, live, done, dir, ctx.parentModel, finished), dir)).catch(() => undefined)
    return chain
  }
  const spent = () => [...done.values()].reduce((s, r) => s + r.usd, 0)
  const report = (phase: Progress['phase'] = 'tasks', text?: string) =>
    ctx.progress({ id, phase, done: done.size, total: plan.tasks.length, running: running.size, usd: spent(), text: text ?? `Hmind run ${id}: ${done.size}/${plan.tasks.length} done, ${running.size} running, ${money(spent())}` })
  await prepareBoardDir($, ctx.root, dir).catch(() => undefined)
  try {
    await writeBoard($, renderBoard(id, plan, live, done, dir, ctx.parentModel, false), dir)
  } catch (err) {
    boardOk = false
    ctx.progress({ id, phase: 'tasks', done: 0, total: plan.tasks.length, running: 0, usd: 0, text: `Hmind run ${id}: cannot write the board at ${dir} (${String(err).slice(0, 80)}); the agents run without it` })
  }

  while (pending.size > 0 || running.size > 0) {
    let progressed = false
    for (const tid of [...pending]) {
      const t = byId.get(tid)!
      if (!t.needs.every(n => done.has(n))) continue
      const bad = t.needs.map(n => done.get(n)!).find(d => d.status !== 'done' && d.status !== 'partial')
      if (bad) {
        pending.delete(tid)
        done.set(tid, { ...failed(t, `skipped: depends on "${bad.id}", which ended ${bad.status}`), status: 'skipped' })
        progressed = true
        continue
      }
      if (running.size >= limit) break
      pending.delete(tid)
      progressed = true
      const start = async () => {
        const kind = t.kind ?? (t.model ? undefined : await ctx.classify(t))
        const model = modelFor(t, kind, ctx.parentModel)
        return runTask(
          $,
          ctx,
          t,
          model,
          previous => taskPrompt(plan, t, done, live, boardOk ? dir : undefined, previous),
          m => {
            live.set(tid, { status: 'running', model: m })
            void board()
          },
        )
      }
      running.set(
        tid,
        start()
          .then(
            r => {
              done.set(tid, r)
            },
            e => {
              done.set(tid, failed(t, `failed: ${String(e).slice(0, 300)}`))
            },
          )
          .finally(() => {
            running.delete(tid)
            live.set(tid, { status: done.get(tid)?.status ?? 'failed', model: done.get(tid)?.model })
            void board()
            report()
          }),
      )
      report()
    }
    if (running.size > 0) {
      await Promise.race(running.values())
      continue
    }
    if (!progressed) {
      for (const tid of pending) done.set(tid, failed(byId.get(tid)!, 'never became ready'))
      pending.clear()
    }
  }

  const tasks = plan.tasks.map(t => done.get(t.id)!)
  const verify: VerifyOutcome[] = []
  let integration: TaskResult | undefined
  const changed = tasks.some(t => t.files.length > 0)
  const finished = tasks.filter(t => t.status === 'done' || t.status === 'partial').length
  if (changed && plan.verify) {
    report('verify', `Hmind run ${id}: verifying the combined work`)
    const v = await ctx.verify().catch(() => undefined)
    if (v) verify.push({ when: 'before', command: v.command, ok: v.ok, tail: tailOf(v.text) })
  }
  const before = verify[0]
  if (plan.integrate && changed && (finished >= 2 || (before && !before.ok))) {
    report('integrate', `Hmind run ${id}: integrating ${finished} results on ${ctx.parentModel}`)
    await chain
    const notes = boardOk ? await readNotes($, dir).catch(() => '') : ''
    const task: Task = { id: 'integrate', description: 'integrate the plan', prompt: '', needs: [] }
    live.set('integrate', { status: 'running', model: ctx.parentModel })
    integration = await runTask($, { ...ctx, retry: false }, task, undefined, () => integratorPrompt(plan, tasks, notes, boardOk ? dir : undefined, before), () => undefined).catch(e => failed(task, `failed: ${String(e).slice(0, 300)}`))
    if (integration.files.length > 0 && plan.verify && before) {
      report('verify', `Hmind run ${id}: verifying again`)
      const v = await ctx.verify().catch(() => undefined)
      if (v) verify.push({ when: 'after', command: v.command, ok: v.ok, tail: tailOf(v.text) })
    }
  }
  const all = integration ? [...tasks, integration] : tasks
  const rec: RunRecord = { id, goal: plan.goal, at: new Date().toISOString(), ms: (await $.clock.now()) - started, dir, tasks, integration, verify, usd: all.reduce((s, r) => s + r.usd, 0), parentUsd: all.reduce((s, r) => s + r.parentUsd, 0) }
  if (integration) done.set('integrate', integration)
  await board(true)
  report('finished', `Hmind run ${id}: finished, ${money(rec.usd)}`)
  return rec
}

// ---------------------------------------------------------------- memory and text

const RUNS = 'runs'

export async function rememberRun($: EngineInterface, rec: RunRecord): Promise<void> {
  const list = ((await $.store.get(RUNS)) as RunRecord[] | undefined) ?? []
  const trim = (t: TaskResult): TaskResult => ({ ...t, report: t.report.slice(0, 20000) })
  list.push({ ...rec, tasks: rec.tasks.map(trim), integration: rec.integration ? trim(rec.integration) : undefined })
  await $.store.set(RUNS, list.slice(-20))
}

export async function loadRuns($: EngineInterface): Promise<RunRecord[]> {
  return (((await $.store.get(RUNS)) as RunRecord[] | undefined) ?? []).slice().reverse()
}

export const duration = (ms: number) => (ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`)

const taskLine = (t: TaskResult) =>
  `## ${t.id}: ${t.status} (${t.model}, ${t.attempts} attempt${t.attempts === 1 ? '' : 's'}, ${duration(t.ms)}, ${fmt(t.usage.input_tokens + t.usage.cache_read_input_tokens + t.usage.cache_creation_input_tokens)} in / ${fmt(t.usage.output_tokens)} out, ${money(t.usd)})${t.files.length ? `\nfiles: ${t.files.join(', ')}` : ''}\n${t.digest}`

function consistencyText(rec: RunRecord): string {
  const lines: string[] = []
  for (const v of rec.verify) lines.push(`verification ${v.when} integration: \`${v.command}\` ${v.ok ? 'PASSED' : 'FAILED'}${v.ok ? '' : `\n${v.tail}`}`)
  if (rec.integration) lines.push(`integrator: ${rec.integration.status} on ${rec.integration.model} (${money(rec.integration.usd)})\n${rec.integration.digest}`)
  if (lines.length === 0) lines.push(rec.tasks.some(t => t.files.length) ? 'no verification command is known for this project and no integration pass ran' : 'no files were changed, so no verification or integration pass ran')
  return `## Consistency\n${lines.join('\n\n')}`
}

export function runText(rec: RunRecord, parentModel: string): string {
  const n = (s: Status) => rec.tasks.filter(t => t.status === s).length
  const notDone = rec.tasks.filter(t => t.status !== 'done' && t.status !== 'partial')
  const head = `Hmind run ${rec.id}: "${rec.goal}". ${n('done')}/${rec.tasks.length} done${n('partial') ? `, ${n('partial')} partial` : ''}${notDone.length ? `, ${notDone.length} not done` : ''}; ${duration(rec.ms)}; ${money(rec.usd)} (≈ ${money(rec.parentUsd)} with every task on ${parentModel})`
  const tail = notDone.length ? `Not done: ${notDone.map(t => `${t.id} (${t.status})`).join(', ')}. Decide what to do about them.` : 'Every task finished.'
  return [head, ...rec.tasks.map(taskLine), consistencyText(rec), `${tail} Board and notes: ${rec.dir}. Full reports: /hmind run ${rec.id}`].join('\n\n')
}

export function runsText(runs: RunRecord[]): string {
  if (runs.length === 0) return 'no orchestrated runs yet. The model starts one by calling the orchestrate tool with a plan.'
  return `last ${runs.length} runs (newest first); /hmind run <id> for the reports\n${runs
    .map(r => `${r.id}  ${r.at.slice(0, 16).replace('T', ' ')}  ${r.tasks.filter(t => t.status === 'done').length}/${r.tasks.length} done  ${duration(r.ms).padStart(6)}  ${money(r.usd).padStart(7)}  ${r.goal.slice(0, 60)}`)
    .join('\n')}`
}

export function runDetail(rec: RunRecord): string {
  const all = rec.integration ? [...rec.tasks, rec.integration] : rec.tasks
  return [
    `run ${rec.id}: "${rec.goal}" (${rec.at.slice(0, 16).replace('T', ' ')}, ${duration(rec.ms)}, ${money(rec.usd)}); board: ${rec.dir}`,
    ...all.map(t => `## ${t.id}: ${t.status} on ${t.model}, ${t.attempts} attempt(s), ${duration(t.ms)}, ${money(t.usd)}${t.files.length ? `; files: ${t.files.join(', ')}` : ''}\n${t.report || t.digest}`),
    consistencyText(rec),
  ].join('\n\n')
}
