<p align="center">
  <img src=".claude-plugin/icon.svg" width="88" alt="Hmind">
</p>

<h1 align="center">Hmind</h1>

<p align="center"><strong>A second brain and an orchestrator for Claude Code.</strong></p>

<p align="center">
  <a href="CHANGELOG.md"><img alt="Version 0.7.2" src="https://img.shields.io/badge/version-0.7.2-4f46e5"></a>
  <img alt="Claude Code plugin" src="https://img.shields.io/badge/Claude%20Code-plugin-111827">
  <img alt="macOS, Linux, Windows" src="https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-0f766e">
  <img alt="Judge accuracy 100% on 74 labeled cases" src="https://img.shields.io/badge/judge%20accuracy-100%25%20on%2074%20cases-15803d">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-6b7280"></a>
</p>

Every coding session is full of small judgment calls: is this command safe to run, does this output matter, how hard should the model think about this prompt, which model should this subagent get, is the work really done, is now a good time to compact? Hmind answers them for a few hundred tokens each and acts only when it is sure. Hand it a plan and it runs the pieces as parallel subagents on the cheapest adequate model, keeps them working as one team, retries what fails, integrates and verifies the result, and prices the run. Every model call lands in a ledger you can read.

The result is leaner sessions, fewer wasted tokens, safer hands on the shell, work that fans out without the main model babysitting it, and decisions you can audit. Everything fails open: if the judge is unavailable or unsure, Claude Code behaves exactly as it did before.

## Contents

- [Highlights](#highlights)
- [Install](#install)
- [Quick start](#quick-start)
- [What it decides](#what-it-decides)
- [Orchestration](#orchestration)
- [Governing the model's own agents](#governing-the-models-own-agents)
- [Leaner sessions](#leaner-sessions)
- [Safer sessions](#safer-sessions)
- [The usage ledger](#the-usage-ledger)
- [Measured accuracy](#measured-accuracy)
- [Commands](#commands)
- [Settings](#settings)
- [Platforms](#platforms)
- [Development](#development)
- [FAQ](#faq)
- [License](#license)

## Highlights

- **Orchestration.** The model writes a plan of tasks with dependencies; Hmind runs them in parallel waves, each on the cheapest model adequate for its kind, with the digested results of its dependencies in its prompt. Failed or stalled tasks are retried a tier up. The run happens in the background and its result arrives as one message: a digest per task, a consistency verdict and the cost.
- **A team, not a crowd.** Every agent of a run reads the same board and keeps notes the others read: who owns which file, which shared names were decided. An integrator on the parent model then checks the combined work for consistency, and the project's own verification runs before and after it.
- **Agent governance.** A cap on agents running at once, duplicates refused with the running agent's id, long reports digested before they re-enter the context, and an account per agent.
- **Shell guard.** A command that could destroy data or system state is refused before it runs, with a reason the model can act on. Approve one and Hmind learns the rule for that project.
- **Leaner context.** Noisy tool output is trimmed or digested, effort is right-sized to the prompt, compaction happens at task boundaries, and all of it tightens as your plan's usage windows fill.
- **Honest status.** A "done" with nothing tested, built or run is flagged, and optionally verified by Hmind itself.
- **A ledger.** Every model call, by who made it and on which model, with tokens and list-price cost, plus a savings estimate.
- **Measured.** The judge scores 100% on all six decision kinds over 74 labeled cases, and you can re-run the eval in two minutes.

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install hmind --marketplace HeshamSayed/hmind
```

Answer `y` to add the marketplace, then pick a scope (user is the usual choice). From a shell:

```sh
claude plugin install hmind --marketplace HeshamSayed/hmind
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `HeshamSayed/hmind`, then **Add plugin**.

Nothing else to install: no server, no local model, no GPU. The judge is a Claude model reached through your own session.

## Quick start

Three things to try in the first two minutes.

1. **See the guard.** In a scratch repo, ask for something destructive: *"drop this repo's git history: run `rm -rf .git`"*. Hmind refuses the command before it runs and tells the model why. If you really want it, say so and Hmind learns the rule for that project.
2. **See the ledger.** Type `/hmind usage`. Every model call of the session is there by model, with tokens and cost, and what Hmind's own calls add up to.
3. **See the orchestrator.** Ask: *"use orchestrate with two lookup tasks: count the lines of README.md, and list the files under src with one line each"*. The tool answers at once; the result arrives as a message when both tasks are done, with the cost of the run against the cost on your main model alone.

## What it decides

| Where | Question | Action |
| --- | --- | --- |
| Before a Bash call | Could this command destroy data or system state? | Refuse above the `denyAt` probability, unless a learned rule allows it |
| After a Bash call | How much of this long output will the assistant need? | Head and tail, errors only, or a judge-written digest of the failures |
| First request of a turn | Is the prompt trivial, a small change, or real work? | Lower the effort for the turn; lower still under budget pressure |
| An agent is launched | Lookup, mechanical, or judgment? Is it the work of a running agent? Is there a slot? | Route to `haiku` or `sonnet`; refuse a duplicate; hold or refuse over the cap; warn on a needless fork |
| An agent reports back | Is the report longer than the parent needs? | Digest it; keep the full text for `/hmind report` |
| End of a turn | Did the answer claim "done" with nothing run? | Toast, push the model to verify, or run the verification |
| Next prompt after a refusal | Is the user approving the refused command? | Learn an allow rule for that command shape in this project |
| Next prompt once context is full | Does this prompt start a new task? | Compact at that boundary with keep rules |
| The model calls `orchestrate` | Which model fits each task, how did each end, is the whole consistent? | Run the plan in waves, retry a tier up, integrate, verify, price the run |
| The model calls `decide` | Its own typed questions over a state | Answers with probabilities and confidence |
| Every model call | Who made it, on which model, at what cost? | Add it to the ledger |

## Orchestration

The model calls the `orchestrate` tool with a goal, optional conventions, and tasks:

```json
{
  "goal": "Add rate limiting to the public API",
  "conventions": "Express 4, TypeScript strict. The limiter is exported as rateLimit(options) from src/api/rateLimit.ts. Tests use vitest.",
  "tasks": [
    { "id": "routes",     "description": "list public routes",   "kind": "lookup",
      "prompt": "List every public route under src/api with its handler file and method." },
    { "id": "lib",        "description": "pick a limiter",       "kind": "lookup",
      "prompt": "Check package.json and the lockfile: is a rate limiter already a dependency? Report name and version, or none." },
    { "id": "middleware", "description": "write the middleware", "kind": "mechanical", "needs": ["lib"],
      "prompt": "Write src/api/rateLimit.ts using the limiter found, keyed by client IP, 100 requests a minute." },
    { "id": "wire",       "description": "wire every route",     "kind": "mechanical", "needs": ["routes", "middleware"],
      "prompt": "Apply the rate-limit middleware to every public route listed. Do not change handler logic." },
    { "id": "tests",      "description": "test the limiter",     "kind": "judgment",   "needs": ["wire"],
      "prompt": "Add tests that the 101st request in a minute from one IP gets 429 and other IPs are unaffected. Run the suite and report." }
  ]
}
```

**The run.** The tool answers at once with the run id and the first wave, and the run continues in the background. `routes` and `lib` start together on Haiku. `middleware` starts when `lib` is in, on Sonnet, with `lib`'s digest in its prompt. `wire` waits for both; `tests` waits for `wire` and runs on the parent model. A task that ends failed, blocked, silent or out of time is retried once a tier up with the previous attempt's last lines. A task whose dependency did not finish is skipped and says why. The parallel limit comes from settings and drops on its own under budget pressure.

**The team.** Hmind writes a board for the run at `.hmind/runs/<id>/board.md` under the project root (the folder ignores itself in git): the goal, a contract, the plan's conventions, a table of every task with status, model, agent name (`hmind-<task id>`), dependencies and files, and the digest of every finished task. Every agent's prompt names the board, lists the other tasks and their state at that moment, and gives it a notes file with three headings: DECISIONS (shared names it introduced, with signatures), FILES (files it will edit, written before editing) and OPEN. The contract says: read the board first and again before reporting; follow the project's conventions; do not edit a file another task's notes own, report the change it needs instead; reuse a name another task decided; report a conflict, never undo a sibling's work.

**The result.** When every task has ended and any changed files, Hmind runs the project's verification command, then an integrator on the parent model with the board, every notes file, every digest and the verification result. It checks for one name per thing, duplicated helpers, conflicting or half-applied edits, missing references and open items, fixes what is small inside the files the tasks touched, and reports a CONSISTENCY section. If it changed files, verification runs again. The model then receives one message: a digest per task with status, model, attempts, time, tokens and cost; the consistency section with both verification results; the cost of the run against the cost with every task on the parent model; and the board's path. The reports the agents hand back on their own are absorbed, so the main context gets digests, not twenty full reports.

**Options.** A task may name a `model` outright (never above the parent) or a `subagentType`. `maxParallel` caps the wave; `retry: false`, `integrate: false` and `verify: false` skip those steps. `/hmind runs` lists runs with progress for the one in flight, `/hmind run <id>` shows a run's full reports, `/hmind agents` every agent of the session.

## Governing the model's own agents

When the model launches agents itself, Hmind:

- routes a lookup to `haiku` and a mechanical task to `sonnet`, never above the parent, and warns when a full-context fork is launched for a self-contained task;
- holds a launch over the agent cap a few seconds for a slot, then refuses it with the list of what is running;
- refuses an agent whose task duplicates one already running, naming the running agent so the model waits for it instead;
- digests a long report into status, result, files and open points before it re-enters the parent's context, keeping the full text for `/hmind report <agent>`;
- keeps an account per agent: model, time, tokens, cost, who launched it.

## Leaner sessions

Context and subagents are where most Claude Code spend goes, and Hmind keeps both small.

- **Output trimming.** Bash output over a threshold is judged: keep it all, keep head and tail, or keep only the failures. When only the failures matter and the output is long, the judge writes a compact digest instead. A trim the model immediately works around is counted as a regret and labeled wrong.
- **Effort routing.** The first request of a turn carries an effort matched to the prompt: a question or a trivial change gets low effort, a small change medium, real work the session's own. On models that charge for cache re-writes, keeping the effort stable also keeps the prompt cache warm.
- **Boundary compaction.** Once the context passes a fill level, the next prompt that starts a new task triggers a compaction with keep rules: goal, changed files, commands and their last results, open errors, decisions, what remains.
- **Budget pressure.** Hmind reads the 5-hour and 7-day usage windows of your plan. As they fill it lowers effort on more turns, trims harder, compacts sooner, runs fewer agents at once and routes more of them to cheaper models, and tells you.

## Safer sessions

- **Shell guard.** A command carrying a risky marker (`rm`, `--force`, `reset --hard`, `push`, `sudo`, `dd`, `DROP`, `curl | sh`, PowerShell and `cmd` equivalents, and more) is judged whole, including anything chained or piped behind a harmless prefix. Above the `denyAt` probability it is refused before it runs, with the judge's reason in the model's result. Only a single plain read-only command skips the judge.
- **Learned rules.** When you approve a refused command in your next prompt, Hmind learns its shape for the project (numbers and ids masked) and stops asking. `/hmind rules`, `/hmind allow`, `/hmind forget` manage them.
- **Done check.** A turn that edited files, ran nothing, and ends with a claim of completion is flagged with a toast, or the model is pushed to verify. With auto-verify on, Hmind runs the project's own test or build command and puts the result in front of the model; a failure asks the model to fix it.

## The usage ledger

`/hmind usage` prints what the session consumed, by who made the call and on which model, with list-price cost, and an estimate of what Hmind saved. From the recorded demo session:

```
Hmind usage, this session (since 2026-10-31 18:38)
  who              model                     calls      input  cache write   cache read    output  est. cost
  main loop        claude-sonnet-5-5             2          4       11,555       78,729       523      $0.05
  Hmind judge      claude-haiku-5-5              2        960            0            0       296     <$0.01
  total Claude                                                                                         $0.05  (the CLI's own ledger: $0.07)
  main loop: 2 requests, 90,288 input tokens, 87% served from the prompt cache
Savings estimate:
  trimmed output: nothing trimmed yet
  cheaper subagents: none routed yet
  Hmind's own Claude calls: <$0.01
  net ≈ <$0.01 spent; not priced: effort lowered on 0 turns, 0 boundary compactions
  List API prices per model, cache writes at the 5-minute rate; on a subscription this is plan usage, not a bill.
```

Rows appear for subagents, subagents Hmind routed cheaper (with what they would have cost on the parent model), orchestrated agents, compaction, and Hmind's judge and digest calls. Trimmed output is priced by what carrying it through every later request would have cost, reset at compaction. `/hmind usage all` covers every session. Prices are list API prices; on a subscription this is plan usage rather than a bill.

## Measured accuracy

The six questions Hmind asks are measured on 74 labeled cases in `eval/`, phrased exactly as the plugin phrases them, with one batched `claude -p` call per kind.

| Decision | Cases | Claude Haiku |
| --- | --- | --- |
| gate: is the command destructive? | 20 | 100% |
| effort: trivial, small, or real work? | 14 | 100% |
| trim: all, head and tail, or errors only? | 8 | 100% |
| done claim: does the message assert completion? | 10 | 100% |
| duplicate agent: the same work as a running one? | 12 | 100% |
| task outcome: done, partial, or not done? | 10 | 100% |

Latency is 0.3 to 0.6 seconds per batch. Re-run the eval before trusting another judge model or changing a question's wording:

```sh
node --experimental-strip-types eval/claude.mts haiku    # Node 22.6+; plain node on 23 and later
```

## Commands

| Command | What it shows or does |
| --- | --- |
| `/hmind` | Stats: decisions, latency, every action taken, labels, budget pressure, rules, and the session's spend in one line |
| `/hmind usage [all]` | The ledger for this session, or every session (`cost` and `tokens` are aliases) |
| `/hmind agents` | Every agent of the session: status, model, time, tokens, cost, who launched it |
| `/hmind runs` | Orchestrated runs, with the one in flight first |
| `/hmind run <id>` | One run with its full reports, consistency section and board path |
| `/hmind report <agent>` | The full text of a report Hmind digested |
| `/hmind log` | The last 15 decisions with ids |
| `/hmind right <id>`, `/hmind wrong <id>` | Label a decision; accuracy and calibration appear in `/hmind` |
| `/hmind rules`, `/hmind allow <command>`, `/hmind forget <n>` | The project's learned allow rules |
| `/hmind verify [on\|off]` | Auto-verify for this project, and the command Hmind recognised |
| `/hmind budget` | The current budget pressure |
| `/hmind on`, `/hmind off` | Pause or resume everything |
| `/hmind reset` | Clear the stats, the decision log and the ledgers |

## Settings

Settings live in Claude Code's config menu under the plugin's name.

| Setting | Default | What it does |
| --- | --- | --- |
| `judgeModel` | `haiku` | Claude model alias that answers Hmind's questions (`haiku`, `sonnet`, `opus`) |
| `confidence` | `0.75` | Below this confidence a judge answer is not acted on |
| `orchestrate` | on | Offer the `orchestrate` tool |
| `maxParallel` | `3` | Orchestrated tasks at once (1 to 8; lowered under budget pressure) |
| `taskTimeoutMin` | `10` | A task running longer is stopped and counted as timed out |
| `retryUp` | on | Retry a failed, blocked or timed-out task once on the next stronger model |
| `agentCap` | `4` | Refuse a new agent while this many run, after holding it for a slot (0 = no cap) |
| `dedupeAgents` | on | Refuse an agent whose task duplicates one already running |
| `agentReportOver` | `6000` | Digest an agent report longer than this many characters (0 disables) |
| `budgetMode` | on | Tighten everything as the plan's usage windows fill |
| `bashGuard` | on | Refuse shell commands judged destructive |
| `denyAt` | `0.85` | Probability of destruction at which a command is refused |
| `learnRules` | on | Learn an allow rule when you approve a refused command |
| `trimOver` | `6000` | Judge Bash output longer than this many characters for trimming (0 disables) |
| `digest` | on | Let the judge write a digest when only the failures matter |
| `routeEffort` | on | Lower effort for trivial prompts and small changes |
| `subagents` | on | Route and govern the agents the model launches |
| `doneCheck` | `toast` | `off`, `toast`, or `prompt` the model to verify |
| `autoVerify` | off | Run the project's test or build command after an unverified done claim (or per project with `/hmind verify on`) |
| `compactAt` | `55` | Context fill percentage after which the next task boundary compacts (0 disables) |

## Platforms

Hmind runs wherever Claude Code runs: macOS, Linux and Windows. On Windows the shell guard understands PowerShell and `cmd` forms as well as the Git Bash ones: `Remove-Item -Recurse -Force`, `rd /s /q`, `del`, `format`, `diskpart`, `Stop-Process`, `reg delete`, `Set-ExecutionPolicy`, `irm ... | iex` and friends are judged like `rm -rf` and `curl | sh`. Auto-verify spells its commands for the platform (`python` and `gradlew.bat` on Windows, `python3` and `./gradlew` elsewhere) and recognises npm, pnpm, yarn, bun, pytest, Cargo, Go, Flutter, Mix, Gradle, Maven, .NET, Make, RSpec and PHPUnit projects.

## Development

```
.claude-plugin/   plugin.json (manifest and settings), marketplace.json, icon.svg
hooks/            register.ts (the hooks), judge.ts (typed questions), questions.ts (their wording),
                  orchestrate.ts, agents.ts, ledger.ts, pricing.ts, budget.ts, digest.ts,
                  verify.ts, rules.ts, platform.ts
eval/             labeled cases and the harness that measures the judge
tests/            the plugin's test suite, run by Claude Code's own test kit
```

```sh
claude plugin validate .                               # manifest, hooks and the engine's own checks
claude plugin test .                                   # 21 tests
node --experimental-strip-types eval/claude.mts haiku  # the judge's accuracy, about two minutes
```

Type-check with `tsc -p .` once the plugin has loaded in a session; Claude Code writes the typings it compiles against into `.claude-plugin/types/`. Releases are listed in [CHANGELOG.md](CHANGELOG.md).

## FAQ

**What does it cost to run?** A judge call is a few hundred tokens on Haiku. In the recorded demo the judge's two calls cost under a cent against five cents for the session's own two requests. `/hmind usage` always shows the current figure.

**Does anything leave my machine?** Only what Claude Code already sends: Hmind's questions travel through your own session to the judge model. There is no server, no telemetry and no third-party service.

**What happens if the judge is down or unsure?** Nothing. Every hook fails open, so a command runs, output passes through, effort stays, an agent launches, exactly as without the plugin.

**Can I use a stronger judge?** Set `judgeModel` to `sonnet` or `opus`. Re-run the eval to see the difference; Haiku already scores 100% on the measured cases.

**Will it refuse something I need?** Say so in your next prompt and Hmind learns the rule for that project. `/hmind allow <command>` does the same by hand, `/hmind off` pauses everything.

**Does orchestration block the model?** No. The tool answers at once; the run continues in the background and its result arrives as a message. The model is free meanwhile.

## License

MIT. Made by [Hesham Sayed](https://github.com/HeshamSayed) (hesham.sayed636@gmail.com).
