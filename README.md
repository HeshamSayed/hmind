# Hmind

**A second brain for Claude Code.** Every coding session is full of small judgment calls: is this command safe to run, does this output matter, how hard should the model think about this prompt, which model should this subagent get, is the work really done, is now a good time to compact? Hmind answers them for a few hundred tokens each, acts only when it is sure, and shows you what every model in the session consumed. The result is leaner sessions, fewer wasted tokens, safer hands on the shell, and decisions you can audit.

## Why you will feel it

- **Fewer tokens, same work.** Long tool output is trimmed to what the assistant actually needs, or replaced by a digest of the failures when that is what matters. Effort is right-sized to the prompt. The conversation is compacted at natural task boundaries instead of mid-task. Subagents doing lookups or mechanical work run on cheaper models. Context and subagents are where most Claude Code spend goes; Hmind keeps both small.
- **It tightens when your plan is running low.** Hmind watches your 5-hour and 7-day usage windows. As they fill, it lowers effort on more turns, trims harder, compacts sooner, routes more subagent work to cheaper models, and tells you.
- **Safer sessions.** A shell command that could wipe data, rewrite shared history or change your system is stopped before it runs, with a reason the model can act on. Approve one and Hmind learns the rule for that project, so it never asks about that shape again.
- **Honest status, optionally enforced.** When a turn says "done" but nothing was tested, built or run, you hear about it. Turn on auto-verify and Hmind runs the project's own test or build command itself and puts the result in front of the model.
- **You see where the tokens go.** Every model call is written to a ledger: the main loop, each subagent, subagents Hmind routed cheaper, compaction, and Hmind's own judge and digest calls, by model, with input, cache-write, cache-read and output tokens and the list-price cost of each. `/hmind usage` prints the breakdown with a savings estimate: what the trimmed output would have cost to carry through every later request, what routed subagents cost against the model they would have run on, and what Hmind's own calls cost, netted.
- **A tool for the model too.** Claude can ask Hmind its own typed questions, batched over one state, instead of reasoning at length about each item.

Everything fails open: if the judge is unavailable or unsure, Claude Code behaves exactly as it did before.

## What it decides

| Where | Decision | Action |
| --- | --- | --- |
| Before a Bash call | Could this command destroy data or system state? | Refuse it above the `denyAt` probability, unless a learned rule allows it |
| After a Bash call | How much of this long output will the assistant need? | Head and tail, errors only, or a judge-written digest of the failures |
| First model request of a turn | Is the prompt trivial, a small change, or real work? | Lower the effort for that turn; lower still under budget pressure (keeps the prompt cache on Fable 5.1 and Opus 5.5) |
| Subagent launch | Is this task a lookup, mechanical, or does it need judgment? | Route lookups to `haiku` and mechanical work to `sonnet`; warn when a full-context fork is launched for a self-contained task |
| End of a turn | Did the answer claim "done" with no test, build or run this turn? | Toast, push the model to verify, or run the verification yourself |
| Next prompt after a refusal | Is the user approving the refused command? | Learn an allow rule for that command shape in this project |
| Next prompt once context is full | Does this prompt start a new task? | Compact at that boundary with keep rules |
| Any time | The model calls `decide` with its own typed questions | Answers with probabilities and confidence |
| Every model call | Who made it, on which model, at what token cost? | Adds it to the usage ledger (`/hmind usage`) |

## How it works

Hmind asks typed questions and gets probabilities back, never prose: a **choice** among options, a **score** from 0 to 1, or a yes/no **noul** with the probability the statement is true.

Every question goes to a Claude judge model, `haiku` by default, through your own Claude Code session, batched when several questions share one state. The judge reads the whole state with real understanding and answers each question with an option, a confidence and a one-line reason. Hmind acts on an answer only above the confidence threshold (0.75 by default); below it, nothing changes. A judge call is a few hundred tokens, and the ledger shows exactly what they add up to, so the cost of the second brain is never a guess.

There is nothing to install beyond the plugin: no server, no local model, no GPU. Wherever Claude Code runs, Hmind runs.

## Measured (52 labeled cases, `eval/`)

| Decision | Claude Haiku |
| --- | --- |
| gate (destructive?) | 100% |
| effort (trivial / small / large) | 100% |
| trim (all / head+tail / errors) | 100% |
| done claim (asserts finished?) | 100% |
| latency per batch of decisions | 0.4 to 0.8 s |

Re-run the eval before trusting another judge model or changing a question's wording:

```sh
node eval/claude.mts haiku    # one batched claude -p call per decision kind
```

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install hmind --marketplace HeshamSayed/hmind
```

Answer `y` to add the marketplace, then pick a scope (user is the usual choice). From a shell: `claude plugin install hmind --marketplace HeshamSayed/hmind`. In the desktop app, click + next to the prompt box, then Plugins, Add marketplace with `HeshamSayed/hmind`, then Add plugin.

## Platforms

Hmind runs wherever Claude Code runs: macOS, Linux and Windows, on any machine, since the judge is a Claude model reached through your session.

On Windows the shell guard understands PowerShell and `cmd` forms as well as the Git Bash ones Claude Code uses: `Remove-Item -Recurse -Force`, `rd /s /q`, `del`, `format`, `diskpart`, `Stop-Process`, `reg delete`, `Set-ExecutionPolicy`, `irm ... | iex` and friends are judged like `rm -rf` and `curl | sh`. Auto-verify spells its commands for the platform too (`python` and `gradlew.bat` on Windows, `python3` and `./gradlew` elsewhere) and recognises npm, pnpm, yarn, bun, pytest, Cargo, Go, Flutter, Mix, Gradle, Maven, .NET, Make, RSpec and PHPUnit projects.

The eval script needs Node 22.6 or newer (`node --experimental-strip-types` on 22, plain `node` on 23 and later).

## Commands

- `/hmind` stats: decisions, latency, every action taken, labels, budget pressure, rules, and this session's spend in one line.
- `/hmind usage` the ledger for this session: tokens and list-price cost by who and model (main loop, subagents, subagents Hmind routed cheaper, compaction, Hmind's judge and digest calls), the prompt-cache hit rate, and the savings estimate; `/hmind usage all` across sessions. Prices are list API prices; on a subscription this is plan usage, not a bill.
- `/hmind log` the last 15 decisions with ids; `/hmind right <id>` or `/hmind wrong <id>` to label one and track the judge's accuracy and calibration.
- `/hmind rules`, `/hmind allow <command>`, `/hmind forget <n>` for the project's allow rules.
- `/hmind verify on|off` to let Hmind run the project's test or build command after an unverified done claim; `/hmind verify` shows the command it recognised.
- `/hmind budget` the current pressure; `/hmind off`, `/hmind on`, `/hmind reset`.

Settings live in the config menu under the plugin's name: the judge model, the confidence threshold, thresholds for each action, and each feature on or off.
