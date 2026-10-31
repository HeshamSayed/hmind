# Hmind

**A second brain and an orchestrator for Claude Code.** Every coding session is full of small judgment calls: is this command safe to run, does this output matter, how hard should the model think about this prompt, which model should this subagent get, is the work really done, is now a good time to compact? Hmind answers them for a few hundred tokens each and acts only when it is sure. Hand it a plan and it runs the pieces as parallel subagents on the cheapest adequate model, retries what fails, digests what comes back and prices the run. The result is leaner sessions, fewer wasted tokens, safer hands on the shell, work that fans out without the main model babysitting it, and decisions you can audit.

## Why you will feel it

- **It orchestrates, so the main model does not have to.** The model writes the plan: tasks with ids, prompts and the ids each one needs. Hmind runs independent tasks at once, each on the cheapest model adequate for its kind (lookups on Haiku, mechanical changes on Sonnet, judgment on the parent model), feeds each task the digested results of the ones it depends on, retries a failed or stalled task once on a stronger model, stops a task that runs past its time, and hands back one digest per task with status, model, tokens and cost. The main model reads a page, not twenty reports.
- **The agents work as one team, and the result holds together.** Every agent of a run reads the same plan board: the goal, a contract of rules, the conventions the model set for the plan, every task with its status, model, agent name and files, and the results so far. Each agent keeps a notes file the others read: the files it owns, the shared names it decided with their exact signatures. Nobody edits a file another task owns; nobody invents a second name for the same thing. When the tasks are done, Hmind runs the project's own verification, then an integrator on the parent model that reads every report and notes file, checks the combined work for consistency and fixes what is small, then verification again. The answer carries the verdict.
- **It keeps the model's own agents in order.** When the model launches agents itself, Hmind caps how many run at once (a launch over the cap is held a few seconds for a slot, then refused with the list of what is running), refuses one that duplicates an agent already running (naming the running one so the model waits for it instead), digests long reports before they re-enter the parent's context, and keeps an account per agent.
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
| The model calls `orchestrate` | Which model fits each task, how did each end, what did it say? | Runs the plan in waves, retries a tier up, digests each report, prices the run |
| The model launches an agent | Is this the work of an agent already running? Is there a slot? | Refuse the duplicate with the running agent's id; hold the launch until a slot frees |
| An agent reports back | Is the report longer than the parent needs? | Digest it to status, result, files and open points; keep the full text for `/hmind report` |
| Any time | The model calls `decide` with its own typed questions | Answers with probabilities and confidence |
| Every model call | Who made it, on which model, at what token cost? | Adds it to the usage ledger (`/hmind usage`) |

## How it works

Hmind asks typed questions and gets probabilities back, never prose: a **choice** among options, a **score** from 0 to 1, or a yes/no **noul** with the probability the statement is true.

Every question goes to a Claude judge model, `haiku` by default, through your own Claude Code session, batched when several questions share one state. The judge reads the whole state with real understanding and answers each question with an option, a confidence and a one-line reason. Hmind acts on an answer only above the confidence threshold (0.75 by default); below it, nothing changes. A judge call is a few hundred tokens, and the ledger shows exactly what they add up to, so the cost of the second brain is never a guess.

There is nothing to install beyond the plugin: no server, no local model, no GPU. Wherever Claude Code runs, Hmind runs.

## Orchestration

The model calls the `orchestrate` tool with a goal and a list of tasks:

```json
{
  "goal": "Add rate limiting to the public API",
  "tasks": [
    { "id": "routes", "description": "list public routes", "prompt": "List every public route under src/api with its handler file and method.", "kind": "lookup" },
    { "id": "lib", "description": "pick a limiter", "prompt": "Check package.json and the lockfile: is a rate limiter already a dependency? Report the name and version, or none.", "kind": "lookup" },
    { "id": "middleware", "description": "write the middleware", "prompt": "Write src/api/rateLimit.ts using the limiter found, keyed by client IP, 100 requests a minute. Export a function usable by every route.", "needs": ["lib"], "kind": "mechanical" },
    { "id": "wire", "description": "wire every route", "prompt": "Apply the rate-limit middleware to every public route listed. Do not change handler logic.", "needs": ["routes", "middleware"], "kind": "mechanical" },
    { "id": "tests", "description": "test the limiter", "prompt": "Add tests that the 101st request in a minute from one IP gets 429 and that other IPs are unaffected. Run the suite and report.", "needs": ["wire"], "kind": "judgment" }
  ]
}
```

The tool answers at once with the run id and the first wave, and the run continues in the background: `routes` and `lib` start on Haiku; `middleware` starts when `lib` is in, on Sonnet, with `lib`'s digest in its prompt; `wire` waits for both, `tests` for `wire`, on the parent model. A task that ends failed, blocked, silent or out of time is retried once a tier up with the previous attempt's last lines; a task whose dependency did not finish is skipped and says so. When the run finishes, the result reaches the model as a message, so the model is free meanwhile and nothing waits on a tool call. The reports the agents hand back on their own are absorbed by Hmind, so the main context receives one digest per task rather than every report in full.

**How the agents know about each other.** Hmind writes a board for the run at `.hmind/runs/<id>/board.md` under the project root (the folder ignores itself in git). It holds the goal, the contract, the plan's `conventions` (pass them in the call: naming, layout, libraries, interfaces, the shared signatures), a table of every task with its status, model, agent name (`hmind-<task id>`), dependencies and files, and the digest of every finished task. Each agent's prompt names the board, lists the other tasks with their state at that moment, and gives it a notes file at `.hmind/runs/<id>/notes/<task id>.md` with three headings: DECISIONS (shared names it introduced, with signatures), FILES (files it will edit, written before editing) and OPEN. The contract says: read the board first and again before reporting; follow the project's conventions; do not edit a file another task's notes own, report the change it needs instead; reuse a name another task decided; report a conflict, never undo a sibling's work.

**How the result is made consistent.** When every task has ended and any of them changed files, Hmind runs the project's verification command (the same one auto-verify recognises), then launches the integrator on the parent model with the board, every notes file, every digest and the verification result: it checks for one name per thing, duplicated helpers, conflicting or half-applied edits, missing references and open items, fixes what is small inside the files the tasks touched, and reports a CONSISTENCY section. If it changed files, verification runs again. The answer to the model is one digest per task, the consistency section with both verification results, the cost of the run against the cost with every task on the parent model, and the board's path. `/hmind runs` lists runs, `/hmind run <id>` shows the full reports, `/hmind agents` every agent of the session with its model, time, tokens and cost.

A task may name a `model` outright (never above the parent) or a `subagentType`. `maxParallel` caps the wave, and budget pressure lowers it on its own; under high pressure every task runs one at a time. `integrate: false` or `verify: false` skip those passes.

## Measured (74 labeled cases, `eval/`)

| Decision | Claude Haiku |
| --- | --- |
| gate (destructive?) | 100% |
| effort (trivial / small / large) | 100% |
| trim (all / head+tail / errors) | 100% |
| done claim (asserts finished?) | 100% |
| duplicate agent (same work?) | 100% |
| task outcome (done / partial / not done) | 100% |
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
- `/hmind usage` (also `/hmind cost` or `/hmind tokens`) the ledger for this session: tokens and list-price cost by who and model (main loop, subagents, subagents Hmind routed cheaper, compaction, Hmind's judge and digest calls), the prompt-cache hit rate, and the savings estimate; `/hmind usage all` across sessions. Prices are list API prices; on a subscription this is plan usage, not a bill.
- `/hmind agents` every agent of the session: status, model, time, tokens, cost, who launched it. `/hmind runs` the orchestrated runs; `/hmind run <id>` one run with its full reports; `/hmind report <agent>` the full text of a report Hmind digested.
- `/hmind log` the last 15 decisions with ids; `/hmind right <id>` or `/hmind wrong <id>` to label one and track the judge's accuracy and calibration.
- `/hmind rules`, `/hmind allow <command>`, `/hmind forget <n>` for the project's allow rules.
- `/hmind verify on|off` to let Hmind run the project's test or build command after an unverified done claim; `/hmind verify` shows the command it recognised.
- `/hmind budget` the current pressure; `/hmind off`, `/hmind on`, `/hmind reset` to clear the stats and usage ledgers.

Settings live in the config menu under the plugin's name: the judge model, the confidence threshold, tasks in parallel, the task timeout, the agent cap, the report digest threshold, thresholds for each action, and each feature on or off (orchestrate, retry a tier up, refuse duplicate agents, budget pressure mode, shell guard, learn allow rules, digest failures, route effort, subagent governance, auto-verify everywhere). The done check (`doneCheck`) is `toast`, `prompt` or `off`.
