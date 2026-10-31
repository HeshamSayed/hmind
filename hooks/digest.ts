// Digest: a compact, structured summary of a long command output, written by
// the Claude tier, for the cases where a head-and-tail cut would lose the
// failures the assistant has to act on.

import type { EngineInterface } from 'claude-code'

import type { JudgeConfig } from './judge'

const SYSTEM =
  'You compress the output of a shell command for a coding agent that must act on it. Output a digest, nothing else, in this shape:\n' +
  'STATUS: <passed | failed | error | unclear>, one line with the key numbers (tests run/failed, errors, warnings, duration).\n' +
  'FAILURES: one line per distinct failure or error: where (file:line or test name), what (the message, verbatim and short). Up to 25; then "... and N more".\n' +
  'NOTES: at most 3 lines of anything else the agent needs (a hint printed by the tool, a missing dependency, a deprecation that blocks).\n' +
  'Keep identifiers, paths, messages and numbers exact. No advice, no prose.'

export async function digest($: EngineInterface, cfg: JudgeConfig, command: string, out: string): Promise<string | undefined> {
  const clipped = out.length > 60000 ? `${out.slice(0, 30000)}\n…[${out.length - 60000} chars omitted]…\n${out.slice(-30000)}` : out
  const r = await $.model.complete({
    model: cfg.escalateModel,
    system: SYSTEM,
    prompt: `Command: ${command.slice(0, 500)}\nOutput (${out.length} chars):\n${clipped}`,
    effort: 'low',
    maxTokens: 1200,
    timeoutMs: 25000,
  })
  if (!r.isAnswered || r.text.trim().length < 10) return undefined
  return r.text.trim()
}
