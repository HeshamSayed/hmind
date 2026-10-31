# Hmind

**A second brain for Claude Code.** Every coding session is full of small judgment calls: is this command safe to run, does this output matter, how hard should the model think about this prompt, is the work really done, is now a good time to compact? Hmind answers them in milliseconds, hands the hard ones to Claude, and learns which calls it can trust. The result is leaner sessions, fewer wasted tokens, and decisions you can audit.

## Why you will feel it

- **Fewer tokens, same work.** Long tool output is trimmed to what the assistant actually needs, effort is right-sized to the prompt, and the conversation is compacted at natural task boundaries instead of mid-task. Context is where most Claude Code spend goes; Hmind keeps it small.
- **Safer sessions.** A shell command that could wipe data, rewrite shared history or change your system is stopped before it runs, with a reason the model can act on.
- **Honest status.** When a turn says "done" but nothing was tested, built or run, you hear about it.
- **Decisions you can trust, measured.** Every judgment is logged with its confidence and the tier that made it. Label the ones it got wrong and Hmind reports its own accuracy and calibration.
- **A tool for the model too.** Claude can ask Hmind its own typed questions, batched over one state, instead of reasoning at length about each item.

Everything fails open: if the judge is unavailable or unsure, Claude Code behaves exactly as it did before.

## What it decides

| Where | Decision | Action |
| --- | --- | --- |
| Before a Bash call | Could this command destroy data or system state? | Refuse it above the `denyAt` probability |
| After a Bash call | How much of this long output will the assistant need? | Keep head and tail, or errors only; note what was trimmed |
| First model request of a turn | Is the prompt trivial, a small change, or real work? | Lower the effort for that turn (keeps the prompt cache on Fable 5.1 and Opus 5.5) |
| End of a turn | Did the answer claim "done" with no test, build or run this turn? | Toast, or (optional) push the model to verify |
| Next prompt once context is full | Does this prompt start a new task? | Compact at that boundary with keep rules |
| Any time | The model calls `decide` with its own typed questions | Answers with probabilities and confidence |

## How it works

Hmind asks typed questions and gets probabilities back, never prose: a **choice** among options, a **score** from 0 to 1, or a yes/no **noul** with the probability the statement is true.

1. **Fast tier.** A small local model served by Ollama (`qwen2.5:1.5b-instruct` by default) answers with a single token, and the probabilities are read straight off its logprobs. Each question is asked in both option orders to cancel position bias. About 300 ms, free, private.
2. **Deep tier.** When the fast tier is not trusted on a question, it goes to Claude (`haiku` by default) through your own Claude Code session, which reads the whole state with real understanding and returns a reason.

A local answer stands only above its kind's trust (`localTrust`); otherwise the question escalates. The defaults come from measurement, not guesswork.

## Measured (52 labeled cases, `eval/`)

| Decision | qwen2.5 1.5B | qwen2.5 7B | Claude Haiku |
| --- | --- | --- | --- |
| gate (destructive?) | 90% (100% on the 9/20 it is sure of) | 85% | 100% |
| effort (trivial / small / large) | 50% | 86% | 100% |
| trim (all / head+tail / errors) | 38% | 100% | 100% |
| done claim (asserts finished?) | 90% (100% on the 5/10 it is sure of) | 70% | 100% |
| latency per decision | 0.3 s (trim 1.3 s) | 0.7 to 5.8 s | 0.4 to 0.8 s batched |

So the small model is trusted on the yes/no questions it scores 90% on and never on the three-way choices; those go to Claude. A bigger local model is not a free upgrade: the 7B is overconfident when wrong. Re-run the eval before trusting any model on more kinds:

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

- `/hmind` stats: decisions per tier, latency, actions taken, calibration, trust per kind.
- `/hmind log` the last 15 decisions with ids.
- `/hmind right <id>` or `/hmind wrong <id>` to label an outcome; accuracy and expected calibration error are computed from labels. A trimmed output whose command is re-run right away is labeled wrong automatically.
- `/hmind off` and `/hmind on`, `/hmind reset`.

Settings live in the config menu under the plugin's name: thresholds, models, trust per kind, each feature on or off.
