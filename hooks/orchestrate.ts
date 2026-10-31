// Orchestration: the model plans, Hmind runs.
//
// A plan is a set of tasks with dependencies. Hmind runs them in waves, as many at
// once as the budget allows, each on the cheapest model adequate for its kind, with
// the digested results of its dependencies in its prompt. A task that ends blocked,
// failed, silent or out of time is retried once on the next model up. Every report
// is digested for the tasks that depend on it and for the summary the main model
// receives; the full reports are kept for `/hmind run <id>`.

import type { EngineInterface } from 'claude-code'

import type { Level } from './budget'
import { digestReport } from './digest'
import type { JudgeConfig } from './judge'
import { fmt, money, usdOf } from './pricing'
import type { Usage } from './pricing'

export type Kind = 'lookup' | 'mechanical' | 'judgment'
export type Alias = 'haiku' | 'sonnet' | 'opus' | 'fable'
export type Task = { id: string; description: string; prompt: string; needs: string[]; kind?: Kind; model?: Alias; subagentType?: string }
export type Plan = { goal: string; tasks: Task[]; maxParallel?: number; retry: boolean }
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
  digest: string
  report: string
}
export type RunRecord = { id: string; goal: string; at: string; ms: number; tasks: TaskResult[]; usd: number; parentUsd: number }

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
  const r = raw as { goal?: unknown; tasks?: unknown; maxParallel?: unknown; retry?: unknown }
  if (typeof r.goal !== 'string' || r.goal.trim().length < 3) return 'orchestrate needs a `goal` string.'
  if (!Array.isArray(r.tasks) || r.tasks.length === 0 || r.tasks.length > 24) return 'orchestrate needs 1 to 24 `tasks`.'
  const tasks: Task[] = []
  const ids = new Set<string>()
  for (const item of r.tasks as Record<string, unknown>[]) {
    const id = String(item.id ?? '').trim()
    if (!id) return 'every task needs an `id`.'
    if (ids.has(id)) return `task id "${id}" is used twice.`
    ids.add(id)
    if (typeof item.prompt !== 'string' || item.prompt.trim().length < 10) return `task "${id}" needs a \`prompt\` of at least 10 characters.`
    const needs = Array.isArray(item.needs) ? item.needs.map(String) : []
    const kind = item.kind === undefined ? undefined : String(item.kind)
    if (kind !== undefined && !KINDS.has(kind)) return `task "${id}": kind must be lookup, mechanical or judgment.`
    const model = item.model === undefined ? undefined : String(item.model)
    if (model !== undefined && !ALIASES.has(model)) return `task "${id}": model must be haiku, sonnet, opus or fable.`
    tasks.push({
      id,
      description: String(item.description ?? id).slice(0, 60),
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
  return { goal: r.goal.trim(), tasks, maxParallel, retry: r.retry !== false }
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

// ---------------------------------------------------------------- prompts and reports

export function taskPrompt(plan: Plan, task: Task, done: Map<string, TaskResult>, previous?: { model: string; status: Status; tail: string }): string {
  const deps = task.needs.map(n => done.get(n)).filter((r): r is TaskResult => !!r)
  const parts = [
    `You are running task "${task.id}" of a plan that Hmind is orchestrating for the main assistant.`,
    `Goal of the whole plan: ${plan.goal}`,
    `Your task: ${task.prompt}`,
  ]
  if (deps.length) parts.push(`Results of the tasks yours depends on:\n${deps.map(d => `### ${d.id} (${d.status})\n${d.digest}`).join('\n\n')}`)
  if (previous) parts.push(`A previous attempt on ${previous.model} ended ${previous.status}. Its last lines:\n${previous.tail}\nTake a different approach where that one got stuck.`)
  parts.push(
    'Do only your task; the other tasks have their own agents. Be concise. End your report with exactly these three lines:\n' +
      'STATUS: done | partial | blocked | failed\nFILES: the paths you changed, comma-separated, or none\nSUMMARY: one line',
  )
  return parts.join('\n\n')
}

export function statusOf(report: string): Status | undefined {
  const m = report.match(/^STATUS:\s*(done|partial|blocked|failed)\b/im)
  return m ? (m[1]!.toLowerCase() as Status) : undefined
}

// ---------------------------------------------------------------- running

export type AgentOutcome = { text: string; usage: Usage; model: string; ms: number; error?: string; timedOut?: boolean }
export type Launch = (task: Task, model: Alias | undefined, prompt: string) => Promise<AgentOutcome>
export type Finished = { text: string; usage?: Usage & { model?: string }; reason: string }
export type Waiter = (o: Finished) => void

export type RunCtx = {
  cfg: JudgeConfig
  parentModel: string
  maxParallel: number
  retry: boolean
  launch: Launch
  classify: (task: Task) => Promise<Kind | undefined>
  judgeStatus: (task: Task, report: string) => Promise<Status>
  progress: (text: string) => void
}

/**
 * The launcher behind the orchestrator: spawn through the engine, wait for the
 * agent's turn to complete (the `turn.complete` hook resolves the waiter by agent
 * id), and stop an agent that runs past the timeout.
 */
export function makeLauncher($: EngineInterface, waiting: Map<string, Waiter>, ours: Set<string>, parentModel: string, timeoutMs: number): Launch {
  return async (task, model, prompt) => {
    const started = await $.clock.now()
    const label = model ?? parentModel
    ours.add(prompt)
    try {
      const r = await $.agent.spawn({ prompt, description: task.description, subagentType: task.subagentType ?? 'general-purpose', ...(model ? { model } : {}) })
      if (r.deny !== undefined || r.agentId === undefined) {
        return { text: '', usage: ZERO, model: label, ms: (await $.clock.now()) - started, error: r.deny ?? 'the agent did not start' }
      }
      const id = r.agentId
      const finished = new Promise<Finished>(resolve => waiting.set(id, resolve))
      const out = await Promise.race([finished, $.clock.sleep(timeoutMs).then(() => 'timeout' as const)])
      const ms = (await $.clock.now()) - started
      if (out === 'timeout') {
        waiting.delete(id)
        await $.tool.call({ tool: 'TaskStop', task_id: id }).catch(() => undefined)
        return { text: '', usage: ZERO, model: r.model, ms, timedOut: true }
      }
      const { model: ended, ...usage } = out.usage ?? { ...ZERO, model: undefined }
      return { text: out.text.trim(), usage, model: ended ?? r.model, ms, error: out.reason === 'error' || out.reason === 'refusal' ? `the agent ended by ${out.reason}` : undefined }
    } finally {
      ours.delete(prompt)
    }
  }
}

const failed = (t: Task, why: string): TaskResult => ({ id: t.id, description: t.description, status: 'failed', model: '-', attempts: 0, ms: 0, usage: { ...ZERO }, usd: 0, parentUsd: 0, digest: why, report: '' })

async function runTask($: EngineInterface, ctx: RunCtx, plan: Plan, task: Task, done: Map<string, TaskResult>): Promise<TaskResult> {
  const kind = task.kind ?? (task.model ? undefined : await ctx.classify(task))
  let model = modelFor(task, kind, ctx.parentModel)
  let attempts = 0
  let usage: Usage = { ...ZERO }
  let usd = 0
  let parentUsd = 0
  let ms = 0
  let previous: { model: string; status: Status; tail: string } | undefined
  let last = { text: '', status: 'failed' as Status, model: model ?? ctx.parentModel }
  while (attempts < 2) {
    attempts += 1
    const out = await ctx.launch(task, model, taskPrompt(plan, task, done, previous))
    ms += out.ms
    usage = addUsage(usage, out.usage)
    usd += usdOf(out.model, out.usage)
    parentUsd += usdOf(ctx.parentModel, out.usage)
    const status: Status = out.timedOut ? 'timeout' : out.error || out.text === '' ? 'failed' : (statusOf(out.text) ?? (await ctx.judgeStatus(task, out.text)))
    last = { text: out.text || out.error || '', status, model: out.model }
    if (status === 'done' || status === 'partial' || !ctx.retry) break
    const up = stepUp(model, ctx.parentModel)
    if (up === null) break
    previous = { model: out.model, status, tail: last.text.slice(-1200) }
    model = up
  }
  const digest = last.text.length > 1800 ? ((await digestReport($, ctx.cfg, task.description, last.text).catch(() => undefined)) ?? last.text.slice(0, 1800)) : last.text
  return { id: task.id, description: task.description, status: last.status, model: last.model, attempts, ms, usage, usd, parentUsd, digest: digest || '(empty report)', report: last.text }
}

export async function runPlan($: EngineInterface, ctx: RunCtx, plan: Plan): Promise<RunRecord> {
  const started = await $.clock.now()
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const byId = new Map(plan.tasks.map(t => [t.id, t]))
  const done = new Map<string, TaskResult>()
  const pending = new Set(plan.tasks.map(t => t.id))
  const running = new Map<string, Promise<void>>()
  const limit = Math.max(1, Math.min(ctx.maxParallel, plan.maxParallel ?? ctx.maxParallel))
  const report = () => ctx.progress(`Hmind run ${id}: ${done.size}/${plan.tasks.length} done, ${running.size} running, ${money([...done.values()].reduce((s, r) => s + r.usd, 0))}`)
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
      running.set(
        tid,
        runTask($, ctx, plan, t, done)
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
  const ms = (await $.clock.now()) - started
  const tasks = plan.tasks.map(t => done.get(t.id)!)
  return { id, goal: plan.goal, at: new Date().toISOString(), ms, tasks, usd: tasks.reduce((s, r) => s + r.usd, 0), parentUsd: tasks.reduce((s, r) => s + r.parentUsd, 0) }
}

// ---------------------------------------------------------------- memory and text

const RUNS = 'runs'

export async function rememberRun($: EngineInterface, rec: RunRecord): Promise<void> {
  const list = ((await $.store.get(RUNS)) as RunRecord[] | undefined) ?? []
  list.push({ ...rec, tasks: rec.tasks.map(t => ({ ...t, report: t.report.slice(0, 20000) })) })
  await $.store.set(RUNS, list.slice(-20))
}

export async function loadRuns($: EngineInterface): Promise<RunRecord[]> {
  return (((await $.store.get(RUNS)) as RunRecord[] | undefined) ?? []).slice().reverse()
}

export const duration = (ms: number) => (ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`)

export function runText(rec: RunRecord, parentModel: string): string {
  const n = (s: Status) => rec.tasks.filter(t => t.status === s).length
  const notDone = rec.tasks.filter(t => t.status !== 'done' && t.status !== 'partial')
  const head = `Hmind run ${rec.id}: "${rec.goal}". ${n('done')}/${rec.tasks.length} done${n('partial') ? `, ${n('partial')} partial` : ''}${notDone.length ? `, ${notDone.length} not done` : ''}; ${duration(rec.ms)}; ${money(rec.usd)} (≈ ${money(rec.parentUsd)} with every task on ${parentModel})`
  const body = rec.tasks.map(t => `## ${t.id}: ${t.status} (${t.model}, ${t.attempts} attempt${t.attempts === 1 ? '' : 's'}, ${duration(t.ms)}, ${fmt(t.usage.input_tokens + t.usage.cache_read_input_tokens + t.usage.cache_creation_input_tokens)} in / ${fmt(t.usage.output_tokens)} out, ${money(t.usd)})\n${t.digest}`)
  const tail = notDone.length ? `Not done: ${notDone.map(t => `${t.id} (${t.status})`).join(', ')}. Decide what to do about them.` : 'Every task finished.'
  return [head, ...body, `${tail} Full reports: /hmind run ${rec.id}`].join('\n\n')
}

export function runsText(runs: RunRecord[]): string {
  if (runs.length === 0) return 'no orchestrated runs yet. The model starts one by calling the orchestrate tool with a plan.'
  return `last ${runs.length} runs (newest first); /hmind run <id> for the reports\n${runs
    .map(r => `${r.id}  ${r.at.slice(0, 16).replace('T', ' ')}  ${r.tasks.filter(t => t.status === 'done').length}/${r.tasks.length} done  ${duration(r.ms).padStart(6)}  ${money(r.usd).padStart(7)}  ${r.goal.slice(0, 60)}`)
    .join('\n')}`
}

export function runDetail(rec: RunRecord): string {
  return [`run ${rec.id}: "${rec.goal}" (${rec.at.slice(0, 16).replace('T', ' ')}, ${duration(rec.ms)}, ${money(rec.usd)})`, ...rec.tasks.map(t => `## ${t.id}: ${t.status} on ${t.model}, ${t.attempts} attempt(s), ${duration(t.ms)}, ${money(t.usd)}\n${t.report || t.digest}`)].join('\n\n')
}
