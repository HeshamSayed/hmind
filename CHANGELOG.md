# Changelog

Release notes for Hmind, a decision-layer plugin for Claude Code.

## 0.7.2

- The shell guard no longer trusts a safe-looking prefix: a command that chains, pipes or substitutes (`pwd && rm -rf .git`) is judged whole. Found while recording the demo, where the model chained the destructive command behind `pwd`.
- README rewritten with a quick start, reference tables for commands and settings, and an FAQ; an MIT license file; author email in the manifest.

## 0.7.1

- The two orchestration questions are measured: 12 labeled duplicate-agent cases and 10 task-outcome cases in `eval/cases-agents.mts`, run by the same harness; Haiku scores 100% on both, and on every other kind, over 74 cases.
- Two question wordings sharpened from the misses: a report-only task whose report delivers what was asked counts as done, and the done-claim check judges what a message claims rather than whether the claim could be true.

## 0.7.0

- Orchestrated runs happen in the background: the `orchestrate` tool answers at once with the run id and the first wave, and the result reaches the model as a message when the run finishes (a tool call's hook has a ten-second budget, so a run cannot live inside it).
- The reports orchestrated agents hand back on their own are absorbed by Hmind, so the main conversation receives one digest per task instead of every report in full.
- An agent launched over the cap is held a few seconds for a slot, then refused with the list of what is running, instead of waiting without bound.
- `FILES` lines are split on commas and semicolons only, so a path with spaces stays whole; `/hmind runs` shows the run in flight.
- The manifest names the author and ships an icon; a changelog; the README names every command alias and setting.

## 0.6.0

- Every orchestrated run keeps a plan board in the project under `.hmind/runs/<id>/` (ignored by git), listing the goal, the rules, each task with its status, model, agent name, dependencies and files, and the digest of every finished task.
- Agents are named `hmind-<task>`, know about every other task and its state, read the board before starting and before reporting, and keep a notes file that the others can read, so two tasks do not edit the same file or invent two names for one thing.
- When files changed, the project's verification runs, an integrator on the parent model checks the combined work for consistency and fixes small problems, and verification runs again.
- The answer carries one digest per task, a consistency section and the cost.
- `orchestrate` accepts `conventions`, `integrate` and `verify` options.

## 0.5.0

- New `orchestrate` tool: the model hands Hmind a plan of tasks with dependencies, and Hmind runs them as parallel subagents in waves, each on the cheapest model suited to its kind of work, with the digested results of its dependencies in its prompt.
- A task that ends failed, blocked, silent or out of time is retried once on a stronger model; a task whose dependency did not finish is skipped.
- The result is one digest per task (status, model, tokens, cost) plus what the run would have cost with every task on the parent model; `/hmind runs` and `/hmind run <id>` show past runs.
- Agents the model launches itself are now governed: a cap on how many run at once (lowered under budget pressure), and a duplicate check that refuses an agent doing the work of one already running.
- Long agent reports are digested before they return to the main conversation (`/hmind report <agent>` shows the full text), and `/hmind agents` gives a per-agent account.

## 0.4.0

- The local Ollama tier is gone: every question now goes to a Claude judge model (haiku by default) through the session, and an answer is acted on above the confidence threshold.
- Nothing to install beyond the plugin: no server, no local model, no GPU.
- The `judgeModel` setting replaces `ollamaUrl`, `ollamaModel`, `escalateModel`, `escalate`, `localTrust` and `shadowRate`.
- The per-kind trust, shadow checks and self-calibration that existed only to grade the local model are removed, and `/hmind trust` no longer exists; labels, rules, verify, budget and usage remain.
- The usage ledger no longer has a local row.

## 0.3.0

- Every model call is now recorded in a usage ledger by model: the main loop, subagents, subagents Hmind routed to a cheaper model, compaction, and Hmind's own judge and digest calls.
- Input, cache-write, cache-read and output tokens are priced at list price, and cost for subagents routed cheaper is shown against the parent-model alternative.
- Trimmed tool output is credited with what carrying it through every later request would have cost, reset at compaction.
- `/hmind usage [all]` prints the breakdown and the netted savings estimate, `/hmind` shows the session's spend in one line, and `/hmind reset` clears the ledger.

## 0.2.1

- Support for macOS, Linux and Windows.
- The shell guard recognises PowerShell and cmd forms such as `Remove-Item`, `rd /s`, `del`, `format`, `diskpart`, `Stop-Process`, `reg delete`, `Set-ExecutionPolicy` and `irm | iex`, and treats read-only cmdlets as safe.
- Auto-verify spells commands for the platform (python vs python3, `gradlew.bat` vs `./gradlew`, `mvnw.cmd` vs `./mvnw`) and recognises Gradle, Maven, .NET and PHPUnit projects.
- The shell guard starts out more cautious about calling a command safe, since a wrong "safe" is the costly mistake, and the local model only retries without `think` after a 400 error.
- The evaluation harness runs on Windows, and the README gives setup steps per platform.

## 0.2.0

- Trust for each kind of decision recalibrates itself from shadow checks against Claude, from the local attempt behind every escalation, and from labels.
- Budget pressure mode reads the plan's 5-hour and 7-day usage windows and tightens effort, trimming and compaction as they fill.
- Subagent routing sends lookup work to haiku and mechanical work to sonnet, and warns when a full-context fork is launched for a self-contained task.
- "Errors only" trims become a Claude-written digest of the failures.
- Opt-in auto-verify runs the project's test or build command after an unverified "done" claim and shows the result to the model; approving a refused command teaches a per-project allow rule.
- `/hmind` gains `trust`, `rules`, `allow`, `forget`, `verify` and `budget` subcommands.

## 0.1.0

- First release: a decision layer that runs inside Claude Code as a hooks module, with a fast local judge that escalates to Claude when unsure.
- Trust per kind of decision is measured on a labeled set.
- Guards destructive shell commands and trims bulky tool output.
- Right-sizes effort per turn, flags unverified "done" claims, and compacts at task boundaries.
- Gives the model a `decide` tool for typed decisions.
