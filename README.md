# Hmind

**A second brain for Claude Code.** Every coding session is full of small judgment calls: is this command safe to run, does this output matter, how hard should the model think about this prompt, which model should this subagent get, is the work really done, is now a good time to compact? Hmind answers them in milliseconds, hands the hard ones to Claude, and learns which calls it can trust. The result is leaner sessions, fewer wasted tokens, safer hands on the shell, and decisions you can audit.

## Why you will feel it

- **Fewer tokens, same work.** Long tool output is trimmed to what the assistant actually needs, or replaced by a digest of the failures when that is what matters. Effort is right-sized to the prompt. The conversation is compacted at natural task boundaries instead of mid-task. Subagents doing lookups or mechanical work run on cheaper models. Context and subagents are where most Claude Code spend goes; Hmind keeps both small.
- **It tightens when your plan is running low.** Hmind watches your 5-hour and 7-day usage windows. As they fill, it lowers effort on more turns, trims harder, compacts sooner, routes more subagent work to cheaper models, and tells you.
- **Safer sessions.** A shell command that could wipe data, rewrite shared history or change your system is stopped before it runs, with a reason the model can act on. Approve one and Hmind learns the rule for that project, so it never asks about that shape again.
- **Honest status, optionally enforced.** When a turn says "done" but nothing was tested, built or run, you hear about it. Turn on auto-verify and Hmind runs the project's own test or build command itself and puts the result in front of the model.
- **Trust that calibrates itself.** A sample of the fast tier's answers is shadow-checked against Claude, every escalation compares the two for free, and your labels count too. Trust per decision kind moves up or down from that evidence, so Hmind gets sharper the more you use it.
- **A tool for the model too.** Claude can ask Hmind its own typed questions, batched over one state, instead of reasoning at length about each item.

Everything fails open: if the judge is unavailable or unsure, Claude Code behaves exactly as it did before.

## What it decides

| Where | Decision | Action |
| --- | --- | --- |
| Before a Bash call | Could this command destroy data or system state? | Refuse it above the `denyAt` probability, unless a learned rule allows it |
| After a Bash call | How much of this long output will the assistant need? | Head and tail, errors only, or a Claude-written digest of the failures |
| First model request of a turn | Is the prompt trivial, a small change, or real work? | Lower the effort for that turn; lower still under budget pressure (keeps the prompt cache on Fable 5.1 and Opus 5.5) |
| Subagent launch | Is this task a lookup, mechanical, or does it need judgment? | Route lookups to `haiku` and mechanical work to `sonnet`; warn when a full-context fork is launched for a self-contained task |
| End of a turn | Did the answer claim "done" with no test, build or run this turn? | Toast, push the model to verify, or run the verification yourself |
| Next prompt after a refusal | Is the user approving the refused command? | Learn an allow rule for that command shape in this project |
| Next prompt once context is full | Does this prompt start a new task? | Compact at that boundary with keep rules |
| Any time | The model calls `decide` with its own typed questions | Answers with probabilities and confidence |

## How it works

Hmind asks typed questions and gets probabilities back, never prose: a **choice** among options, a **score** from 0 to 1, or a yes/no **noul** with the probability the statement is true.

1. **Fast tier.** A small local model served by Ollama (`qwen2.5:1.5b-instruct` by default) answers with a single token, and the probabilities are read straight off its logprobs. Each question is asked in both option orders to cancel position bias. About 300 ms, free, private.
2. **Deep tier.** When the fast tier is not trusted on a question, it goes to Claude (`haiku` by default) through your own Claude Code session, which reads the whole state with real understanding and returns a reason.

A local answer stands only above its kind's trust; otherwise the question escalates. The starting values come from measurement, and self-calibration moves them: every ten samples of a kind, trust steps down 0.05 when the local tier agreed with Claude at least 90% of the time, and up 0.05 when it agreed under 80%. `/hmind trust` shows the live values and the evidence behind them.

## Measured (52 labeled cases, `eval/`)

| Decision | qwen2.5 1.5B | qwen2.5 7B | Claude Haiku |
| --- | --- | --- | --- |
| gate (destructive?) | 90% (100% on the 9/20 it is sure of) | 85% | 100% |
| effort (trivial / small / large) | 50% | 86% | 100% |
| trim (all / head+tail / errors) | 38% | 100% | 100% |
| done claim (asserts finished?) | 90% (100% on the 5/10 it is sure of) | 70% | 100% |
| latency per decision | 0.3 s (trim 1.3 s) | 0.7 to 5.8 s | 0.4 to 0.8 s batched |

So the small model starts trusted on the yes/no questions it scores 90% on and not on the three-way choices; those go to Claude until the calibration earns them back. A bigger local model is not a free upgrade: the 7B is overconfident when wrong. Re-run the eval before trusting any model on more kinds:

```sh
node eval/local.mts qwen2.5:1.5b-instruct   # the local tier
node eval/claude.mts haiku                   # the Claude tier, one batched claude -p call per kind
```

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install hmind --marketplace HeshamSayed/hmind
```

Answer `y` to add the marketplace, then pick a scope (user is the usual choice). From a shell: `claude plugin install hmind --marketplace HeshamSayed/hmind`. In the desktop app, click + next to the prompt box, then Plugins, Add marketplace with `HeshamSayed/hmind`, then Add plugin.

## Setup

Ollama must be installed (`brew install ollama`) for the fast tier. Hmind starts `ollama serve` if it is not running and pulls the model on first use. Without Ollama, every decision goes to Claude.

## Commands

- `/hmind` stats: decisions per tier, latency, every action taken, calibration, trust, budget pressure, rules.
- `/hmind log` the last 15 decisions with ids; `/hmind right <id>` or `/hmind wrong <id>` to label one.
- `/hmind trust` the live trust per kind and the shadow-check evidence; `/hmind trust reset` back to the configured start.
- `/hmind rules`, `/hmind allow <command>`, `/hmind forget <n>` for the project's allow rules.
- `/hmind verify on|off` to let Hmind run the project's test or build command after an unverified done claim; `/hmind verify` shows the command it recognised.
- `/hmind budget` the current pressure; `/hmind off`, `/hmind on`, `/hmind reset`.

Settings live in the config menu under the plugin's name: thresholds, models, starting trust, shadow rate, and each feature on or off.
