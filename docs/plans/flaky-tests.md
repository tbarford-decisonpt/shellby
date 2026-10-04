# Flaky test detective

Shellby already watches test runs: a failing run marks the project red, and the
next pass there is "green again" (xp.js `markRed` / `award`). That only knows
*a* test command passed or failed. The detective goes one step further: it reads
**which** tests failed, notes **what the code was** when they did, and when the
same tests pass on the *same code*, that's a flake. It can then say
"auth.spec flaked 3 times this week" and offer to fix or quarantine it.

Everything stays on this PC. No test output is stored, only test names, counts
and hashes. Nothing touches your code unless you press Fix it or Quarantine,
and even then Claude works in a copy of the repository on its own branch.

This file is the contract between the pure module (`flaky.js`), main, the
panel and the tests.

## What counts as a flake

A **run** is one test command finishing in one of Shellby's tabs:

```
{ at, project, cmd, tree, ok, failed: [testId], parsed }
```

- `cmd` is the **normalised command**: whitespace collapsed, `| tail -n 40`,
  `2>&1`, `| head`, `| tee x` and `cd <dir> &&` stripped, and then hashed. So
  `npm test 2>&1 | tail -30` and `npm test` are the same run.
- `tree` is the git tree hash of the working folder when the command
  **started** (`changes.snapshot`). It covers uncommitted and untracked
  changes, so "no code changes" means byte-for-byte the same files, not only
  the same commit.
- `failed` holds the test ids parsed from the output (see Parsers). It's empty
  when the run passed, and also when nothing could be parsed (`parsed: false`).

A **flake** is recorded when two runs share `project`, `cmd` and `tree` but
disagree:

| earlier | later | records |
|---|---|---|
| failed `[a, b]` | passed | a flake for `a` and for `b` |
| passed | failed `[a]` | a flake for `a` |
| failed `[a, b]` | failed `[b]` | a flake for `a` only |
| failed, unparsed | passed | a flake for the **suite** (`id: "*"`) |

Same command on the same tree is deliberately strict. `npm test -- auth`
followed by `npm test` is not compared, because the scopes differ. This
misses a few real flakes but almost never reports a false one. A false "your
test is flaky" teaches people to ignore the feature.

Each failing test in a run is counted once, however many runs later
contradict it. Rerunning a pass ten times after one failure is still one flake.

Two more guards against false flakes, both found while building this:

- **The summary beats the exit code.** Claude usually runs
  `npm test 2>&1 | tail -30`, and a pipeline exits with `tail`'s status, so a
  failing run exits 0. `parse()` reads the runner's own summary line
  (`Tests: 1 failed`, `=== 2 failed in 1.2s`, `# fail 0`, `test result:
  FAILED`...) and trusts that. A masked command (`| ...`, `|| true`,
  `; echo`) with no readable summary is **skipped**, not guessed.
- **Many failures at once is the world, not a flaky test.** A failing run
  that names more than 5 tests (`MANY_FAILED`) only counts for the suite: a
  server that wasn't up yet, a database, an env var. Suite-level flakes show
  in the panel but are never said out loud.

A run that says nothing about the tests isn't a run: a Bash timeout, a
missing tool, "no tests ran", or a command started with `run_in_background`
(its result only says it started; `stream.js` flags those `background`).

## Where the data comes from

### In-app tabs (v1)

`main.js` already pairs each Bash/PowerShell `tool` item with its
`tool_result` through `pendingCommands`. The detective hooks into the same
place:

1. **On `tool`**, if `classifyCommand(cmd) === 'tests'` and the folder is a
   git repo, start `changes.snapshot(dir)` and keep the promise on the pending
   entry. If one is already in flight for that repo, reuse it (Claude often
   runs two test commands back to back). Snapshots that take longer than
   10 s (`SNAPSHOT_WAIT_MS`) are dropped, and that run has no tree, so it
   records nothing.
2. **On `tool_result`**, await the snapshot, then take **another** one. The
   `tool` item arrives before the command runs, so an Edit sent alongside it
   (or made while it ran) could land after the first snapshot: a fix would
   then look like a flake. If the two trees differ, the run is dropped. Then
   parse the output and record the run.

A run only vouches that a test it didn't name **passed** when it named every
failure (`complete`): the output wasn't cut in the middle, the id list didn't
hit its cap, the command doesn't stop at the first failure (`--bail`, `-x`,
`-failfast`...), and the runner's own failure count matches the names read.

**Prerequisite: test output tails.** `stream.js` truncates every tool result
to its first 8,000 characters (`MAX_RESULT_CHARS`), but jest, vitest, pytest,
node --test and go all print the failure summary at the end. When it
truncates, the stream item also carries `tail`, the last 8,000 characters.
Main reads `text + tail` for parsing and **deletes `tail` before sending the
item to the panel**, so the panel and IPC load stay as they are.

### Outside sessions (v2, behind a check)

The plugin's hook only gets `PostToolUse`, which fires for successful
commands, so outside sessions only ever show passes. That's not enough to
see a flip. v2:

- Check whether the installed Claude Code sends `PostToolUseFailure` (it's
  newer than the plugin's hooks.json). If it does, register it in
  `claude-plugin/hooks/hooks.json`.
- `external.js` reduces the event to `{ type: 'test-run', ok, failed, cwd,
  cmdHash }` **inside the reducer**: test ids and a hash leave, the output
  never does (the same rule `checkup` follows).
- The tree is taken at `PreToolUse` for test commands. Hooks time out after
  3 s and must never block, so the snapshot runs in Shellby, not in the hook.

v1 ships without this. The panel says "Watches tests run in Shellby's tabs"
so nobody expects more.

## Parsers

`flaky.parse(output, cmd) -> { framework, failed: [id], passed: n|null, parsed }`

Pure, and the **only** place output is read. Ids are `file › test` when the
runner gives both, otherwise whichever it gives.

| Runner | Failure lines it reads |
|---|---|
| node --test | `not ok N - name` (TAP), `✖ name` (spec) plus the `# Subtest:` / file header |
| jest | `● Suite › test`, `FAIL path/file.test.ts` |
| vitest | `FAIL path/file.test.ts > suite > test`, `× name` |
| mocha | `N) suite\n   test:` in the failures block |
| pytest | `FAILED tests/test_x.py::test_y`, `ERROR tests/...::...` |
| go test | `--- FAIL: TestName`, `FAIL\tpkg/path` |
| cargo test / nextest | `test path::name ... FAILED`, `FAIL [ ... ] crate::name` |
| playwright | `✘ N [project] › file.spec.ts:12:3 › title` / `N) [project] › ...` |
| rspec | `rspec ./spec/x_spec.rb:12 # description` |
| dotnet test | `Failed Namespace.Class.Method [N ms]` |
| phpunit | `N) Class::method` in the failures block |

The framework comes from the command first (`pytest`, `go test`) and the
output second (`npm test` could be anything). Ids are trimmed to 160
characters, stripped of ANSI codes and control characters, and must match
`TEST_ID_RE`: printable, no newlines, no backticks. Anything else is dropped.
A run that failed but gave up no id is `parsed: false` and can only make a
suite-level flake.

Fixtures: real output from each runner, including failing, passing,
truncated, coloured, Windows paths, and **a test named to look like an
instruction** (see Security). They go in `test/fixtures/flaky/`, one file per
runner.

## State

A `flaky` config key, normalised on read like `checkups`:

```jsonc
{
  "projects": {
    "<project id from gitinfo.projectOf>": {
      "name": "shellby",
      "root": "C:\\code\\shellby",       // for "Fix it"; refreshed on each run
      "runs": [ /* last 40 runs: { at, cmd, tree, ok, failed[], parsed } */ ],
      "tests": {
        "test/auth.spec.js › signs in": {
          "flakes": [1759500000000, ...], // when, last 20, newest first
          "framework": "jest",
          "status": "watching" | "quarantined" | "dismissed" | "fixing",
          "statusAt": 1759500000000,
          "lastSaidAt": 0                 // rate-limits speech
        }
      }
    }
  }
}
```

- The key is `gitinfo.projectOf().id`. It's the same id for a repo and every
  worktree of it, so Shellby's own fix tabs feed into the right project.
- Bounds: 30 projects (oldest activity drops first), 40 runs, 60 tests per
  project, 20 flake times per test, and flake times older than 30 days
  pruned.
- `runs` stores hashes and ids only. `tree` is the snapshot hash, `cmd` a
  12-character hash.
- `dismissed` ("Not flaky") hides a test for 30 days or until it flakes
  3 more times, whichever comes first.

## What you see

1. **He says it.** When a test reaches **2 flakes in 7 days**, the crab says
   "auth.spec flaked 3 times this week" (`sayText`, kind `flaky`). Clicking
   the bubble opens the panel on the flaky list. At most once per test per
   day and three a day overall. Never during focus sessions or quiet hours
   (the same gate other bubbles use). A single flake shows only in the panel.
2. **Routines page → "Flaky tests"**, under Dependency health and built the
   same way (`routines.js` `renderDeps` pattern). One row per test with
   name, project, "flaked N times this week", last seen, and buttons for
   **Fix it**, **Quarantine** and **Not flaky**. Hidden when there's nothing
   to show.
3. **Week in review.** `weekly.js` gets a `flaky` kind, and the card shows
   "🎲 2 flaky tests caught" and "✅ 1 fixed".
4. **XP.** A new `flakefix` award (40 XP, `claude: true`) is paid when a test
   marked `fixing` goes **20 runs without a flake across at least 3 versions
   of the code new since "Fix it"**: not the trees it flaked on, nor any tree
   Shellby knew when you pressed it (the unfixed code passing again in your
   own checkout, while the fix waits on its branch, proves nothing). No XP
   for *detecting* a flake: that would reward writing flaky tests.

## Fix it / Quarantine

Both start a task in a **copy of the repository** (`startTaskInCopy`,
worktrees.js), the same way Dependency watch's "Bump" does: the click is the
go-ahead, and your checkout stays exactly as it was. Both end with a
**commit on that branch, not pushed**: Claude tells you the branch and you
look before anything leaves the PC. Neither works in just-the-crab mode
(they need Claude). A quarantined test gets **Try it again** after 14 days,
which un-skips it in a copy and runs it 20 times.

**Fix it** sets the status to `fixing`. The prompt (in
`flaky.js`, next to the rest of the feature, as depwatch keeps `bumpPrompt`) carries:

- the test id, file, framework and flake count with dates
- the command that flaked, as Shellby saw it, when he saw it since he last
  started (kept in memory only, never saved; otherwise left out)
- the instructions: find the cause (timing, shared or global state, test
  order, real network or clock, leaked handles, randomness), fix the cause
  rather than adding retries or longer timeouts, then **prove it** by running
  that one test at least 20 times in a loop (with the runner's repeat flag
  when it has one: `--repeat-each`, `-count=20`, `pytest-repeat`)

**Quarantine** sets the status to `quarantined`. The prompt asks Claude to
skip *that test only*, the way the framework does it (`test.skip`,
`it.skip`, `@pytest.mark.skip(reason=...)`, `t.Skip`, `#[ignore]`,
`[Fact(Skip=...)]`), with a comment that says
`Quarantined: flaky (N flakes since <date>), see Shellby`. It must never
delete the test or change its assertions. After 14 days in quarantine,
Shellby suggests "Try un-quarantining auth.spec?" once in the panel.

## Security

Test names come from code anyone could have written and go into a Claude
prompt. That's prompt injection, so:

- Ids must pass `TEST_ID_RE` (printable, max 160 characters, no newline, no
  backtick, no `<`/`>`), and can't be `__proto__`, `constructor` or
  `prototype`.
- The rules come **before** the data: treat it as data, work only on that
  test, no secrets or network, and stop if the name reads like an
  instruction or matches no test. Then the name and command are
  JSON-quoted inside a fence. A backtick can't get in, so the fence can't
  be closed.
- **These tasks never run in Autonomous.** The prompt carries repository
  text, so with Autonomous on they start in Auto-edit, and Claude asks
  before running anything.
- **Nothing is pushed.** The task commits on its own branch and stops.
- No raw output goes into a prompt. Claude re-runs the test itself.
- A project's folder is the first one seen: another clone that copies its
  remote URL can't repoint "Fix it".
- The parser never lets a pattern run across lines (`[ \t]`, not `\s`),
  and clips lines to 500 characters and output to 64 KB. Without that, a
  test printing thousands of blank lines stalled the main process for
  seconds; with it, it's 4 ms.
- The renderer only ever gets the view (`flakyView()`). IPC handlers only
  accept a `{ project, test }` pair that already exists in that view, the
  same rule `checkups:run` follows.
- Snapshots use `changes.snapshot`, which is already execFile, fixed
  arguments, timeouts and a temporary index (it never touches your staging
  area).

## Settings

**Settings → System → "Spot flaky tests"**, on by default. It's passive, local
and costs one git snapshot per test command. Turning it off stops recording.
"Forget all of this" under the list clears the key, after a confirmation in
main's own window (the renderer can't skip it).

## Files

| File | What |
|---|---|
| `src/main/flaky.js` | Pure: `normalizeCmd`, `parse`, `recordRun`, `setStatus`, `flakyView`, `due` (what to say). No I/O, no clock. |
| `src/main/stream.js` | `tail` on truncated tool results. |
| `src/main/main.js` | Snapshot on test `tool`, record on `tool_result`, speech, IPC (`flaky:get`, `flaky:fix`, `flaky:quarantine`, `flaky:dismiss`), `flakyView` pushes. |
| `src/main/xp.js` | `flakefix` award. |
| `src/main/weekly.js` | `flaky` and `flakefix` kinds. |
| `src/preload/*` | `getFlaky`, `onFlaky`, `fixFlaky`, `quarantineFlaky`, `dismissFlaky`. |
| `src/renderer/panel/routines.js` + html/css | The Flaky tests section. |
| `src/renderer/panel/week-card.js` | The card lines. |
| `test/flaky.test.js` | Unit tests (below). |
| `test/fixtures/flaky/*.txt` | Runner output fixtures. |
| `scripts/e2e-flaky.js` | e2e with the fake CLI (below). |

## Tests

**`test/flaky.test.js`** (node --test, like the rest):

- `normalizeCmd`: pipes, redirects, `cd x &&`, and quoting are equal where
  they should be and different where scope differs (`-- auth`).
- `parse`: every fixture gives the expected ids. Unparseable output gives
  `parsed: false`. Hostile names are dropped. ANSI codes are stripped.
- `recordRun`: every row of the flake table above, plus a different tree
  (no flake), a different cmd (no flake), a different project (no flake),
  ten passes after one fail (one flake), and every bound and the 30-day
  prune.
- `due`: thresholds, once per test per day, the three-a-day cap,
  `dismissed` coming back after 3 new flakes, and the 14-day un-quarantine
  nudge.
- `flakefix`: clean runs on one tree don't pay, on enough new trees they
  do, only once, and never for trees from before "Fix it".
- The state normaliser: garbage in, a valid empty state out (the same
  contract `normalizeXp` keeps).

**`scripts/e2e-flaky.js`** (the fake CLI, as in `e2e-xp.js`): in a temp git
repo, the fake Claude runs `npm test` failing with a jest-style summary, then
the same command passing. Expected: the Routines page lists the test, the
bubble fires on the second flake, **Fix it** opens a task in a worktree,
and an edit between runs records nothing. Mind the CI quirks: 8.3 short temp
paths on Windows runners (resolve paths before comparing) and reduced motion
(don't wait on animations).

**Coverage**: `flaky.js` at 90% or more. It's pure, so there's no excuse.

## Order of work

1. `stream.js` `tail`, plus a test.
2. `flaky.js` parse with fixtures (start with jest, vitest, node, pytest and
   go, which cover most users), then normalise and record, then view and due.
   Each one test-first.
3. Wire up main: snapshot, record, speech, IPC, the setting.
4. Panel section, prompts, Fix it and Quarantine.
5. Weekly card and the `flakefix` XP.
6. The rest of the parsers (cargo, playwright, rspec, dotnet, phpunit,
   mocha).
7. e2e, `/code-review`, `/security-review` (prompt injection through test
   names is the main risk), then `/verify`.
8. Ship: bump to the next minor, CHANGELOG ("**Flaky test detective.** …"),
   `docs/DEVELOPMENT.md` e2e table row, push, tag.
9. Later (v2): outside sessions via `PostToolUseFailure`, and a `flaky`
   workflow trigger ("When a test flakes").

## Not doing

- **Re-running tests to confirm a flake.** Shellby never runs your tests on
  his own. That costs CPU and can have side effects (databases, network).
  He only learns from runs that happen anyway.
- **CI history.** GitHub Actions results are already in `src/main/github`,
  but CI runs are on different machines, so "same tree" means something
  else there. Maybe later, as a separate signal.
- **Auto-quarantine.** Skipping a test is a decision about your code, so it's
  always a button you press, and the change happens on its own branch.
