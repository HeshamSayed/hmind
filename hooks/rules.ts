// Learned allow rules: commands the shell gate no longer judges in a project,
// because the user approved one like it after a refusal, or added it by hand.

import type { EngineInterface } from 'claude-code'

export type Rule = { template: string; root: string; at: string; via: 'approval' | 'manual'; example: string }

const KEY = 'rules'

/** A command's shape: whitespace folded, numbers and hex ids masked, lowercase. */
export function templateOf(command: string): string {
  return command
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,40}\b/g, '#')
    .replace(/\b\d+\b/g, '#')
    .slice(0, 200)
}

export async function loadRules($: EngineInterface): Promise<Rule[]> {
  return ((await $.store.get(KEY)) as Rule[] | undefined) ?? []
}

export async function addRule($: EngineInterface, rules: Rule[], rule: Rule): Promise<Rule[]> {
  const next = [...rules.filter(r => !(r.root === rule.root && r.template === rule.template)), rule].slice(-200)
  await $.store.set(KEY, next)
  return next
}

export async function removeRule($: EngineInterface, rules: Rule[], index: number): Promise<Rule[]> {
  const next = rules.filter((_, i) => i !== index)
  await $.store.set(KEY, next)
  return next
}

export function matchRule(rules: Rule[], root: string, command: string): Rule | undefined {
  const t = templateOf(command)
  return rules.find(r => r.root === root && r.template === t)
}
