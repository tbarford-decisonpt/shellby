# Reef health

Each project you choose to watch grows a coral in his tank. The coral gets bigger only when the project's code gets better than it has ever been, and nothing you do takes a polyp away. Back to the [README](../README.md). See also [Projects](PROJECTS.md) and [His tank](TANK.md).

## Watching a reef

Open a project on **Projects** and press **Watch this reef** on the Reef card at the bottom of its page. Every reef is off until you do. **Stop watching** pauses it: the coral, its polyps and every best stay, and watching again carries on from there. Up to 40 projects can be watched. A repo and the copies Shellby makes of it share one reef.

The card shows the coral, its stage and polyps, one row per signal (the last reading, its best, a sparkline with the best as a dotted line, and whether it's getting better), the **Next best** to aim for (*"Remove 2 escape hatches (a ts-ignore, an any, an eslint-disable)"*) and the signals that haven't been read yet. **Check now** reads the ledgers and coverage again straight away.

> Counts only, kept on this PC. Shellby reads git and coverage files that are already there; it never runs your code.

## Fix this

Each signal that can still get better has **Fix this** under its name, and the card has **Fix the worst**, which picks the signal with the most room to get better (a vulnerable package or a failing CI check weighs more than one more escape hatch). Either one opens a new conversation in the project's folder with a prompt already in the box. Nothing is sent until you press Enter, so you can read it and change it first.

The prompt names where the problem is, says what better means for that signal and its best so far, and asks Claude to check the fix (run the linter, the type check or the tests):

| Signal | What the prompt names |
|---|---|
| Escape hatches | the files with the most, and how many of each kind (any, ts-ignore, eslint-disable…) |
| Lint problems | the lint command, the files with the most problems and the rules hit most |
| Line coverage | the coverage file and the files with the most uncovered lines |
| CI green rate | the checks failing most on your pull requests, and the pull requests failing now |
| Flaky tests | the open flaky tests and how often each flaked |
| Vulnerable packages | each package, how bad, whether it's indirect and whether a fix needs a major bump |
| Bug nests | each nest's bug, how often it came back, since when, and how many times it was cleared before |
| Tests | the least-covered files, when coverage was read |

There's no Fix this on a signal at zero, CI at 100% or coverage at 90% and up. Fixing pays nothing by itself: when the next reading beats the best, it's a new best and a polyp like any other.

## What it reads

Nothing here runs anything in the project. Shellby reads what's already lying around:

| Signal | Where it comes from | Better |
|---|---|---|
| Escape hatches | `git grep` over HEAD's tracked text files for `ts-ignore`, `any`, `eslint-disable`, `noqa` and the like (the same rule the bug battles use), leaving out `node_modules`, `vendor`, `dist`, `build` and minified files. Once a day, after 10 minutes away from the keyboard, with a 5 s timeout. Repos with more than 20,000 tracked files are skipped. | lower |
| Lint problems | the count at the end of a lint run Claude did: eslint's *✖ 12 problems*, ruff's and biome's *Found 3 errors*, clippy's *generated 4 warnings* | lower |
| Line coverage | `coverage/coverage-summary.json`, `coverage/lcov.info`, `lcov.info`, `coverage.xml` or `coverage/cobertura-coverage.xml`, only when the file changed, up to 5 MB, never followed out of the repo | higher |
| CI green rate | the checks on your last 20 pull request runs Shellby already watches (needs 3) | higher |
| Flaky tests | open ones on the Flaky page | lower |
| Vulnerable packages | the weekly dependency check | lower |
| Bug nests | open nests the Bugdex reports | lower |
| Tests | how many tests a run Claude did counted (jest, vitest, node:test, mocha, pytest, cargo) | higher |

For Fix this, each reading also keeps where its count came from: the file paths behind the escape hatches (from the same `git grep`, whose matched lines are thrown away), the files and rule names in the lint run's output, the files in the coverage file it already read (summary JSON and lcov; Cobertura XML is only read for its total), the failing check names CI already showed, the flaky tests' names, the vulnerable packages' names and the Bugdex's open nests. At most 10 of each, and never a line of code.

Every git call has the repository's fsmonitor, hooks, external diff and textconv drivers switched off, and runs hidden with a timeout.

## How it grows

- **The first reading** of a signal sets its mark and pays nothing.
- **A new best** is a reading that beats the mark by the signal's step: one fewer escape hatch, lint problem, flaky test, vulnerable package or nest; coverage up 0.5 points; CI green up 5 points; 1% more tests and at least 3. It sets the new mark, adds a **polyp**, and pays the *Reef reached a new best* XP once a day per project.
- **A worse reading takes nothing.** The mark and the polyps stay; only the reef's health drops.
- **Anti-cheat.** More tests don't count while escape hatches went up in the last two days, coverage doesn't count while the test count went down, lint only counts runs of the same command as its first reading, and fewer escape hatches because over 30% of the code was deleted since the mark was set start a new mark without paying.

## Health and colour

Health runs from 0 to 5: **Bleached, Pale, Settling, Growing, Healthy, Thriving**. It comes from the last two weeks: the share of signals at or within one step of their best, half credit for one getting better, and a bonus for bug nests cleared. A young reef is still settling: it can't pass Settling before three days of readings, Growing before its first best, or Healthy before its third. A reef that hasn't been read for two weeks turns Pale.

Health only sets the coral's colour, from vivid to nearly white. Polyps set its size, and they only go up. Faded coral is never removed.

## Coral in the tank

Each reef's coral is a piece on the tray's **Plants** shelf (`coral:<project>`), one per project, and the **Coral** list on the Tank page shows them all. Its shape is grown from the project's id, so it's always the same coral, getting bigger and branching more as polyps add up. The top half sways with the current. A friend peeking at your tank sees a rock in its place.

## Rewards and trophies

A new best pays the `reef` XP award (once a day per project, at most once an hour) and counts toward the `reef-best` trophy stat. The number of watched projects at Thriving is the `reef-thriving` stat, which unlocks the reef's milestone pieces.

## Where it's kept

Config `reef`, on this PC only, never synced: per project, its name, folder and remote, whether it's watched, its polyps, and per signal the best, the last reading, up to 60 days of readings and where the last count came from (up to 10 file paths, rule, test, check, package or nest names, each with its count). No file contents, only names and counts.

## For developers

- `src/main/reef/index.js`: the model (pure): `enable`, `reading`, `setDetail`, `fixPrompt`, `healthOf`, `nextImprovement`, `coralArt`, `reefView`, `corals`.
- `src/main/reef/signals.js`: each signal's step and the parsers (pure).
- `src/main/reef/detail.js`: where a count came from, for Fix this (pure): `escapeScan`, `lintDetail`, `coverageFiles`, `flakyTests`, `vulnPackages`, `ciFailing`, `openNests`, `normalizeDetail`.
- `src/main/reef/prompts.js`: the Fix this prompt per signal and `worstOf` (pure).
- `src/main/reef/probe.js`: the only I/O: `git grep`, `git diff --shortstat` and coverage files.
- `src/main/wiring/reef.js`: the daily scheduler, `d.onCommandResult` (lint and test runs, with `dir` and `output`), `d.onReefNote(project, sig, value)` (project: its id, `{ id }` or a folder; the Bugdex sends `'nest', { open, cleared }`), the game-hub view `reef` (actions `watch`, `unwatch`, `check`, `fix` with `{ id, sig }` or `sig: 'worst'` -> `{ sig, prompt, root }`, and `dev-reading` with an optional `detail` in test runs), and `d.reefCorals()` for the tank.
- Panel: `reef.js`, `reef.css`, `html/reef.html` (the project page) and `html/reef-tank.html` (the Tank page).
- Tests: `test/reef.test.js`, `test/reef-signals.test.js`, `test/reef-probe.test.js`, `test/reef-detail.test.js`, `test/reef-prompts.test.js`, `test/reef-review-wiring.test.js`; e2e `scripts/e2e-reef.js`.
