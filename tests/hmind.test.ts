import { expect, mock, test } from 'claude-code/testing'

import { compactAtFor, effortFor, levelOf, trimOverFor } from '../hooks/budget'
import { isWindowsPath, joinPath } from '../hooks/platform'
import { matchRule, templateOf } from '../hooks/rules'
import { detectWith } from '../hooks/verify'

const NO_USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const DOWN = { value: { status: 500, ok: false, headers: {}, text: '' } }

/** A fake Ollama `/api/chat` reply whose top logprob names `letter`. */
const ollamaReply = (letter: string) =>
  JSON.stringify({
    message: { role: 'assistant', content: letter },
    done: true,
    logprobs: [{ token: letter, logprob: -0.01, top_logprobs: [{ token: letter, logprob: -0.01 }, { token: letter === 'A' ? 'B' : 'A', logprob: -6 }] }],
  })

type Beneath = { stdout?: string; fetch?: (e: any) => unknown; rateLimits?: { kind: string; percentUsed: number }[] }

/** The engine beneath the plugin: store and clock from memory, no Claude, a Bash that answers `stdout`, and `fetch` as given (down by default). */
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
  on('http.fetch', (_: unknown, e: any) => (b.fetch ?? (() => DOWN))(e))
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'api-error', status: null, error: 'unknown', usage: NO_USAGE } }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: b.stdout ?? 'ok', stderr: '', interrupted: false } }))
}

const start = ($: any) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

test('a risky command still runs when the judge is down (fail open)', async ($, on) => {
  engineBeneath(on)
  await start($)
  const ran = await $.tool.call({ tool: 'Bash', command: 'rm -rf ~/' })
  expect(ran.deny).toBeUndefined()
  expect((ran.result as { stdout: string }).stdout).toBe('ok')
})

test('long output passes through untouched when the judge is down', async ($, on) => {
  engineBeneath(on, { stdout: 'x'.repeat(20000) })
  await start($)
  const ran = await $.tool.call({ tool: 'Bash', command: 'cat big.log' })
  expect((ran.result as { stdout: string }).stdout.length).toBe(20000)
})

test('a command the local judge calls destructive is refused', async ($, on) => {
  engineBeneath(on, {
    fetch: e => {
      const asked = JSON.stringify(e)
      if (!asked.includes('api/chat')) return { value: { status: 200, ok: true, headers: {}, text: '{"version":"test"}' } }
      return { value: { status: 200, ok: true, headers: {}, text: ollamaReply(asked.includes('A) yes') ? 'A' : 'B') } }
    },
  })
  await start($)
  const ran = await $.tool.call({ tool: 'Bash', command: 'rm -rf ~/' })
  expect(typeof ran.deny).toBe('string')
})

test('a learned allow rule skips the gate', async ($, on) => {
  let judged = 0
  engineBeneath(on, {
    fetch: e => {
      if (JSON.stringify(e).includes('api/chat')) judged += 1
      return DOWN
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
    fetch: e => {
      if (JSON.stringify(e).includes('api/chat')) judged += 1
      return DOWN
    },
  })
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  expect(judged).toBe(0)
})

test('the decide tool rejects bad input and answers good input', async ($, on) => {
  engineBeneath(on)
  await start($)
  const bad = await $.tool.call({ tool: 'mcp__hmind__decide', state: 'x', questions: [] })
  expect(String(bad.result).startsWith('error:')).toBe(true)
  const good = await $.tool.call({ tool: 'mcp__hmind__decide', state: 'the sky is blue', questions: [{ id: 'q', type: 'noul', statement: 'The sky is blue.' }] })
  expect(String(good.result).includes('tier=none')).toBe(true)
})

test('/hmind prints its stats, trust and budget, and can be switched off', async ($, on) => {
  engineBeneath(on, { rateLimits: [{ kind: 'five_hour', percentUsed: 85 }] })
  await start($)
  const out = await $.command.run({ command: 'hmind', args: '' })
  expect((out.text ?? '').startsWith('Hmind on')).toBe(true)
  const trust = await $.command.run({ command: 'hmind', args: 'trust' })
  expect((trust.text ?? '').includes('effort never')).toBe(true)
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
    fetch: e => {
      const s = JSON.stringify(e)
      if (s.includes('api/chat')) asked.push(s)
      return DOWN
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
