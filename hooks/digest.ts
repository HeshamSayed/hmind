// Digest: a compact, structured summary of a long command output, written by
// the Claude tier, for the cases where a head-and-tail cut would lose the
// failures the assistant has to act on.

import type { EngineInterface } from 'claude-code'

import type { JudgeConfig } from './judge'
import { recordModelCall } from './ledger'

const SYSTEM =
  'You compress the output of a shell command for a coding agent that must act on it. Output a digest, nothing else, in this shape:\n' +
  'STATUS: <passed | failed | error | unclear>, one line with the key numbers (tests run/failed, errors, warnings, duration).\n' +
  'FAILURES: one line per distinct failure or error: where (file:line or test name), what (the message, verbatim and short). Up to 25; then "... and N more".\n' +
  'NOTES: at most 3 lines of anything else the agent needs (a hint printed by the tool, a missing dependency, a deprecation that blocks).\n' +
  'Keep identifiers, paths, messages and numbers exact. No advice, no prose.'

const REPORT_SYSTEM =
  "You compress a subagent's report for the agent that delegated the task and must act on it. Output nothing but this shape:\n" +
  'STATUS: done | partial | blocked | failed, one line with what was and was not done.\n' +
  'RESULT: up to 10 lines with the findings or answers; identifiers, paths, numbers and error messages kept verbatim.\n' +
  'FILES: one line per file changed: path, what changed; or none.\n' +
  'OPEN: up to 3 lines of questions, risks or follow-ups the delegating agent must know.\n' +
  'No advice, no prose beyond these lines; keep a code snippet only when it is under 10 lines and essential.'

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max / 2)}\n…[${text.length - max} chars omitted]…\n${text.slice(-max / 2)}` : text)

async function compress($: EngineInterface, cfg: JudgeConfig, system: string, prompt: string, maxTokens: number): Promise<string | undefined> {
  const r = await $.model.complete({ model: cfg.judgeModel, system, prompt, effort: 'low', maxTokens, timeoutMs: 25000 })
  await recordModelCall($, 'digest', cfg.judgeModel, r.usage).catch(() => undefined)
  if (!r.isAnswered || r.text.trim().length < 10) return undefined
  return r.text.trim()
}

/** A digest of a long command output: status, failures, notes. */
export function digest($: EngineInterface, cfg: JudgeConfig, command: string, out: string): Promise<string | undefined> {
  return compress($, cfg, SYSTEM, `Command: ${command.slice(0, 500)}\nOutput (${out.length} chars):\n${clip(out, 60000)}`, 1200)
}

/** A digest of a subagent's report: status, result, files, open points. */
export function digestReport($: EngineInterface, cfg: JudgeConfig, task: string, report: string): Promise<string | undefined> {
  return compress($, cfg, REPORT_SYSTEM, `Task: ${task.slice(0, 300)}\nReport (${report.length} chars):\n${clip(report, 60000)}`, 900)
}
