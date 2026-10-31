import { expect, mock, test } from 'claude-code/testing'

import { compactAtFor, effortFor, levelOf, trimOverFor } from '../hooks/budget'
import { ledgerText, loadLedger, recordAvoided, recordModelCall, recordRequest } from '../hooks/ledger'
import { loadRuns, parsePlan, rememberRun, runPlan, runText, runsText } from '../hooks/orchestrate'
import { isWindowsPath, joinPath } from '../hooks/platform'
import { money, priceOf, resolveModel, usdOf } from '../hooks/pricing'
import { matchRule, templateOf } from '../hooks/rules'
import { detectWith } from '../hooks/verify'

const NO_USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
/** The judge did not answer (an API error): every hook must fail open. */
const SILENT = { value: { isAnswered: false, reason: 'api-error', status: null, error: 'unknown', usage: NO_USAGE } }

/** A judge reply: one JSON line answering question `id` with the option letter `answer`. */
const judgeSays = (id: string, answer: string, confidence = 0.95) => ({
  value: {
    isAnswered: true,
    text: JSON.stringify({ id, answer, confidence, why: 'test' }),
    usage: { input_tokens: 400, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
})

/** A judge or digest reply in plain text. */
const modelSays = (text: string) => ({ value: { isAnswered: true, text, usage: { input_tokens: 400, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })

type Beneath = { stdout?: string; complete?: (e: any) => unknown; rateLimits?: { kind: string; percentUsed: number }[] }

/** A fake Agent tool beneath the plugin: each call is recorded in `calls` and answered from `answer`. */
const agentBeneath = (on: any, answer: (e: any) => string, calls: any[]) =>
  on('tool.call', { tool: 'Agent' }, (_: unknown, e: any) => {
    calls.push(e)
    return {
      result: {
        agentId: `ag${calls.length}`,
        status: 'completed',
        content: [{ type: 'text', text: answer(e) }],
        usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        resolvedModel: e.model === 'haiku' ? 'claude-haiku-5-5' : e.model === 'sonnet' ? 'claude-sonnet-5-5' : 'claude-opus-5-5',
        totalToolUseCount: 1,
        totalDurationMs: 10,
        totalTokens: 1100,
        prompt: e.prompt,
      },
    }
  })

/** The engine beneath the plugin: store and clock from memory, a judge that answers as `complete` says (silent by default), and a Bash that answers `stdout`. */
const engineBeneath = (on: any, b: Beneath = {}) => {
  mock.store(on)
  mock.clock(on)
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/' }))
  on('session.root', () => ({ value: '/' }))
  on('session.turns', () => ({ value: 1 }))
  on('session.messages', () => ({ value: [] }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 10 }, rateLimits: b.rateLimits ?? [] } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'hmind' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__hmind__decide' } }))
  on('model.complete', (_: unknown, e: any) => (b.complete ?? (() => SILENT))(e))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: b.stdout ?? 'ok', stderr: '', interrupted: false } }))
}

const start = ($: any) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

test('a risky command still runs when the judge does not answer (fail open)', async ($, on) => {
  engineBeneath(on)
  await start($)
  const ran = await $.tool.call({ tool: 'Bash', command: 'rm -rf ~/' })
  expect(ran.deny).toBeUndefined()
  expect((ran.result as { stdout: string }).stdout).toBe('ok')
})

test('long output passes through untouched when the judge does not answer', async ($, on) => {
  engineBeneath(on, { stdout: 'x'.repeat(20000) })
  await start($)
  const ran = await $.tool.call({ tool: 'Bash', command: 'cat big.log' })
  expect((ran.result as { stdout: string }).stdout.length).toBe(20000)
})

test('a command the judge calls destructive is refused, and the judge call is counted', async ($, on) => {
  engineBeneath(on, { complete: () => judgeSays('destructive', 'A') })
  await start($)
  const ran = await $.tool.call({ tool: 'Bash', command: 'rm -rf ~/' })
  expect(typeof ran.deny).toBe('string')
  expect(String(ran.deny).includes('p=0.95')).toBe(true)
  const shown = (await $.command.run({ command: 'hmind', args: 'usage' })).text ?? ''
  expect(/Hmind judge\s+claude-haiku-5-5\s+1\s+400\s+0\s+0\s+30\s+<\$0\.01/.test(shown)).toBe(true)
  expect(shown.includes("Hmind's own Claude calls: <$0.01")).toBe(true)
})

test('a learned allow rule skips the gate', async ($, on) => {
  let judged = 0
  engineBeneath(on, {
    complete: () => {
      judged += 1
      return SILENT
    },
  })
  await start($)
  const added = await $.command.run({ command: 'hmind', args: 'allow rm -rf ~/' })
  expect((added.text ?? '').includes('allowed')).toBe(true)
  const ran = await $.tool.call({ tool: 'Bash', command: 'rm  -rf ~/' })
  expect(ran.deny).toBeUndefined()
  expect(judged).toBe(0)
})

test('a safe-looking command is not even judged', async ($, on) => {
  let judged = 0
  engineBeneath(on, {
    complete: () => {
      judged += 1
      return SILENT
    },
  })
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  expect(judged).toBe(0)
})

test('the decide tool rejects bad input and answers good input', async ($, on) => {
  engineBeneath(on, { complete: () => judgeSays('q', 'A', 0.9) })
  await start($)
  const bad = await $.tool.call({ tool: 'mcp__hmind__decide', state: 'x', questions: [] })
  expect(String(bad.result).startsWith('error:')).toBe(true)
  const good = await $.tool.call({ tool: 'mcp__hmind__decide', state: 'the sky is blue', questions: [{ id: 'q', type: 'noul', statement: 'The sky is blue.' }] })
  expect(String(good.result).includes('q: yes p=0.9 confidence=0.9 tier=claude')).toBe(true)
})

test('/hmind prints its stats, usage and budget, and can be switched off', async ($, on) => {
  engineBeneath(on, { rateLimits: [{ kind: 'five_hour', percentUsed: 85 }] })
  await start($)
  const out = await $.command.run({ command: 'hmind', args: '' })
  expect((out.text ?? '').startsWith('Hmind on')).toBe(true)
  expect((out.text ?? '').includes('usage this session')).toBe(true)
  const budget = await $.command.run({ command: 'hmind', args: 'budget' })
  expect((budget.text ?? '').includes('budget high')).toBe(true)
  const off = await $.command.run({ command: 'hmind', args: 'off' })
  expect(off.text).toBe('Hmind is off.')
})

test('budget pressure maps to effort, trim and compaction', async () => {
  expect(levelOf(10)).toBe('normal')
  expect(levelOf(65)).toBe('elevated')
  expect(levelOf(85)).toBe('high')
  expect(levelOf(97)).toBe('critical')
  expect(effortFor('normal', 'trivial', 'xhigh')).toBe('low')
  expect(effortFor('normal', 'small', 'xhigh')).toBe('medium')
  expect(effortFor('normal', 'large', 'xhigh')).toBe('xhigh')
  expect(effortFor('high', 'small', 'xhigh')).toBe('low')
  expect(effortFor('high', 'large', 'xhigh')).toBe('medium')
  expect(effortFor('critical', 'large', 'low')).toBe('low')
  expect(trimOverFor('high', 6000)).toBe(3000)
  expect(compactAtFor('critical', 55)).toBe(25)
})

test('a PowerShell command with a risky marker is judged like a Unix one', async ($, on) => {
  const asked: string[] = []
  engineBeneath(on, {
    complete: e => {
      asked.push(JSON.stringify(e))
      return SILENT
    },
  })
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'Remove-Item -Recurse -Force C:\\Users\\me\\Documents' })
  await $.tool.call({ tool: 'Bash', command: 'Get-ChildItem -Recurse src' })
  expect(asked.some(s => s.includes('Remove-Item'))).toBe(true)
  expect(asked.some(s => s.includes('Get-ChildItem'))).toBe(false)
})

test('verify commands follow the platform of the project root', async () => {
  const files = new Set<string>()
  const fs = {
    exists: async (p: string) => [...files].some(f => p.endsWith(f)),
    read: async () => JSON.stringify({ scripts: { test: 'vitest run' } }),
    list: async () => [],
  }
  files.add('package.json')
  expect(await detectWith(fs, 'C:\\work\\app')).toBe('npm test')
  files.clear()
  files.add('pytest.ini')
  expect((await detectWith(fs, 'C:\\work\\app'))?.startsWith('python -m pytest')).toBe(true)
  expect((await detectWith(fs, '/home/dev/app'))?.startsWith('python3 -m pytest')).toBe(true)
  files.clear()
  files.add('build.gradle.kts')
  files.add('gradlew.bat')
  expect(await detectWith(fs, 'C:\\work\\app')).toBe('gradlew.bat test -q')
  expect(await detectWith(fs, '/home/dev/app')).toBe('./gradlew test -q')
  files.clear()
  expect(await detectWith(fs, '/home/dev/empty')).toBeUndefined()
})

test('paths join with the root platform separator', async () => {
  expect(isWindowsPath('C:\\work\\app')).toBe(true)
  expect(isWindowsPath('/home/dev/app')).toBe(false)
  expect(joinPath('C:\\work\\app\\', 'package.json')).toBe('C:\\work\\app\\package.json')
  expect(joinPath('/home/dev/app', 'package.json')).toBe('/home/dev/app/package.json')
})

test('rule templates mask numbers and ids and fold whitespace', async () => {
  const rules = [{ template: templateOf('kill -9 48213'), root: '/', at: '', via: 'manual' as const, example: 'kill -9 48213' }]
  expect(matchRule(rules, '/', 'kill  -9 777')).toBeDefined()
  expect(matchRule(rules, '/', 'kill -9 777 && rm -rf /')).toBeUndefined()
  expect(matchRule(rules, '/other', 'kill -9 777')).toBeUndefined()
})

test('list prices resolve aliases and price a call', async () => {
  expect(resolveModel('haiku')).toBe('claude-haiku-5-5')
  expect(priceOf('claude-fable-5-1')?.cacheRead).toBe(0.25)
  expect(priceOf('claude-haiku-5-5', 200000)?.input).toBe(0.5)
  expect(priceOf('some-other-model')).toBeUndefined()
  expect(usdOf('claude-opus-5-5', { input_tokens: 1000000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })).toBe(4)
  expect(money(0.004)).toBe('<$0.01')
  expect(money(3.456)).toBe('$3.46')
})

test('the ledger counts tokens by who and model, and prices what trimming kept out of the window', async () => {
  const kept = new Map<string, unknown>()
  const $ = { store: { get: async (k: string) => kept.get(k), set: async (k: string, v: unknown) => void kept.set(k, v) } } as any
  const u = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50000, cache_creation_input_tokens: 2000 }
  await recordModelCall($, 'main', 'claude-fable-5-1', u, 3)
  await recordModelCall($, 'routed', 'haiku', u, 2, 'claude-fable-5-1')
  await recordAvoided($, 40000)
  await recordRequest($, 'claude-fable-5-1')
  await recordRequest($, 'claude-fable-5-1')
  const led = await loadLedger($, 'all')
  expect(led.lines['main|claude-fable-5-1']?.calls).toBe(3)
  expect(led.lines['main|claude-fable-5-1']?.cacheRead).toBe(50000)
  expect(led.lines['routed|claude-haiku-5-5']?.insteadUsd).toBeGreaterThan(led.lines['routed|claude-haiku-5-5']?.usd ?? 1)
  expect(led.avoided.total).toBe(10000)
  expect(led.avoided.rereads).toBe(2)
  expect(led.avoided.rereadTokens).toBe(20000)
  const text = ledgerText(led, { title: 'Hmind usage' })
  expect(text.includes('main loop')).toBe(true)
  expect(text.includes('routed by Hmind')).toBe(true)
  expect(text.includes('10,000 tokens kept out of the context window')).toBe(true)
  expect(text.includes('on the parent model')).toBe(true)
})

test('a plan runs independent tasks at once, feeds dependents, and retries a failure one model up', async () => {
  const kept = new Map<string, unknown>()
  let now = 0
  const $ = {
    clock: { now: async () => (now += 10), sleep: async () => undefined },
    store: { get: async (k: string) => kept.get(k), set: async (k: string, v: unknown) => void kept.set(k, v) },
    model: { complete: async () => ({ isAnswered: false, reason: 'api-error', usage: NO_USAGE }) },
  } as any
  const calls: { id: string; model: string | undefined; prompt: string }[] = []
  let bTries = 0
  const usage = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  const ctx = {
    cfg: { judgeModel: 'haiku', confidence: 0.75, timeoutMs: 1000 },
    parentModel: 'claude-opus-5-5',
    maxParallel: 3,
    retry: true,
    classify: async () => undefined,
    judgeStatus: async () => 'partial' as const,
    progress: () => undefined,
    launch: async (task: { id: string }, model: string | undefined, prompt: string) => {
      calls.push({ id: task.id, model, prompt })
      const name = model ?? 'claude-opus-5-5'
      if (task.id === 'b') {
        bTries += 1
        return { text: bTries === 1 ? 'could not find it\nSTATUS: failed\nFILES: none\nSUMMARY: stuck' : 'found it\nSTATUS: done\nFILES: none\nSUMMARY: b done on retry', usage, model: name, ms: 10 }
      }
      if (task.id === 'e') return { text: 'no way\nSTATUS: failed\nFILES: none\nSUMMARY: cannot', usage, model: name, ms: 10 }
      if (task.id === 'c') return { text: `saw: ${prompt.includes('SUMMARY: a done') ? 'a-digest' : 'nothing'}\nSTATUS: done\nFILES: src/c.ts\nSUMMARY: c done`, usage, model: name, ms: 10 }
      return { text: 'STATUS: done\nFILES: none\nSUMMARY: a done', usage, model: name, ms: 10 }
    },
  }
  const plan = parsePlan({
    goal: 'test plan',
    tasks: [
      { id: 'a', prompt: 'find the config loader', kind: 'lookup' },
      { id: 'b', prompt: 'find the second thing', kind: 'lookup' },
      { id: 'c', prompt: 'change the loader as a says', kind: 'mechanical', needs: ['a'] },
      { id: 'd', prompt: 'depends on a task that fails', needs: ['e'] },
      { id: 'e', prompt: 'this one always fails', model: 'opus' },
    ],
  })
  expect(typeof plan).toBe('object')
  if (typeof plan === 'string') return
  const rec = await runPlan($, ctx as any, plan)
  const text = runText(rec, 'claude-opus-5-5')
  expect(text.includes('3/5 done')).toBe(true)
  expect(text.includes('## b: done')).toBe(true)
  expect(text.includes('2 attempts')).toBe(true)
  expect(calls.filter(c => c.id === 'b').map(c => c.model).join(',')).toBe('haiku,sonnet')
  const c = calls.find(x => x.id === 'c')!
  expect(c.model).toBe('sonnet')
  expect(c.prompt.includes('Results of the tasks yours depends on')).toBe(true)
  expect(text.includes('saw: a-digest')).toBe(true)
  const eCalls = calls.filter(x => x.id === 'e')
  expect(eCalls.length).toBe(1)
  expect(eCalls[0]!.model).toBeUndefined()
  expect(text.includes('## e: failed')).toBe(true)
  expect(text.includes('## d: skipped')).toBe(true)
  await rememberRun($, rec)
  expect(runsText(await loadRuns($)).includes('3/5 done')).toBe(true)
  expect(parsePlan({ goal: 'cycle', tasks: [{ id: 'x', prompt: 'x needs y first', needs: ['y'] }, { id: 'y', prompt: 'y needs x first', needs: ['x'] }] })).toBe('the tasks depend on each other in a cycle.')
})

test('the orchestrate tool validates its plan', async ($, on) => {
  engineBeneath(on)
  await start($)
  const bad = await $.tool.call({ tool: 'mcp__hmind__orchestrate', goal: 'cycle', tasks: [{ id: 'x', prompt: 'x needs y first', needs: ['y'] }, { id: 'y', prompt: 'y needs x first', needs: ['x'] }] })
  expect(String(bad.result)).toBe('error: the tasks depend on each other in a cycle.')
  const missing = await $.tool.call({ tool: 'mcp__hmind__orchestrate', goal: 'goal of the test', tasks: [{ id: 'x', prompt: 'do the thing', needs: ['nope'] }] })
  expect(String(missing.result).includes('not in the plan')).toBe(true)
})

test('an agent that duplicates one already running is refused with its id', async ($, on) => {
  engineBeneath(on, { complete: () => judgeSays('duplicate', 'A') })
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'audit the auth module', type: 'general-purpose', status: 'running' }] }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a2' }))
  await start($)
  const r = await $.agent.spawn({ prompt: 'Audit the auth module for injection bugs and report what you find', description: 'audit the auth module' })
  expect(typeof r.deny).toBe('string')
  expect(String(r.deny).includes('a1')).toBe(true)
  const other = await $.agent.spawn({ prompt: 'Write the changelog entry for this release', description: 'changelog entry' })
  expect(other.deny).toBeUndefined()
})

test('a long agent report is digested before it reaches the parent, and kept in full', async ($, on) => {
  engineBeneath(on, { complete: () => modelSays('STATUS: done\nRESULT: all fine\nFILES: none\nOPEN: none') })
  const calls: any[] = []
  agentBeneath(on, () => 'line of findings\n'.repeat(1000), calls)
  await start($)
  const r = await $.tool.call({ tool: 'Agent', prompt: 'review every file under src for dead code', description: 'dead code review' })
  const text = (r.result as any).content[0].text as string
  expect(text.startsWith('STATUS: done')).toBe(true)
  expect(text.includes('Hmind digested this report')).toBe(true)
  const full = (await $.command.run({ command: 'hmind', args: 'report ag1' })).text ?? ''
  expect(full.length).toBe(17000)
})
