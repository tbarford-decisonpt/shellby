# Developing Shellby

How to build Shellby, how he drives Claude Code, the test and maintenance scripts, and a map of the code. For the contribution guidelines, see [CONTRIBUTING.md](../CONTRIBUTING.md); for the short version with a diagram, see [How it works](../README.md#how-it-works).

## How Shellby drives Claude Code

Shellby doesn't talk to any AI API itself. Each conversation is one long-lived Claude Code process:

```
claude -p --input-format stream-json --output-format stream-json --verbose
       --permission-prompt-tool stdio --permission-mode <mode> [--resume <id>]
```

- **Tasks** go in as JSON user messages on stdin. One process holds the whole conversation, so follow-ups keep context.
- **Permission prompts** come out as `control_request { subtype: "can_use_tool" }` and Shellby answers with `allow` / `deny` (plus the suggested rules for "Always allow"). This is the same host protocol the Claude Agent SDK uses.
- **Stop** sends an `interrupt` control request, and falls back to killing the process tree if the CLI doesn't wind down.
- **Mode changes** mid-conversation send `set_permission_mode`.
- **Subagents** come through as `task_started` / `task_progress` / `task_notification` system events. Their messages carry `parent_tool_use_id`, the Agent call that spawned them, and their permission prompts carry `agent_id`, which equals the `task_id`. That's all it takes to route every event, prompt and helper crab to the right lane.
- **The toolbox** merges the skills, agents, commands and MCP servers reported in Claude Code's `init` event with a scan of `~/.claude` and the project's `.claude/`. A file watcher on those folders is how Shellby notices new tricks.
- **Billing safety:** Shellby never sees your Claude sign-in. You log in to the official, unmodified Claude Code CLI yourself, and Shellby only reads `claude auth status` to show which account and plan it's on. Claude Code gets the environment as it is on your PC, so if `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` or a Bedrock/Vertex/Foundry switch is set, Settings warns that it may bill that instead. **Always use my Claude plan** leaves them all out. Usage counts against your plan's normal limits, exactly as if you'd typed the task into a terminal.

**Staying on the desktop layer:** the critter window is made an *owned window* of the shell's desktop host (the `Progman`/`WorkerW` window that contains `SHELLDLL_DefView`), via [koffi](https://koffi.dev) FFI calls into `user32.dll`. Owned windows share their owner's z-order band, so he sits above your wallpaper and icons and below every app. A `TaskbarCreated` hook re-pins him when Explorer restarts, and a slow watchdog covers anything else.

## Build and run

```powershell
git clone https://github.com/x-salmon/shellby
cd shellby
npm install
node node_modules/electron/install.js   # only if npm skipped the Electron download
npm start
```

### Crash reports

Crash reports go to Sentry only from builds with a DSN: `DSN` in `src/main/crash-report.js` for releases, and `SHELLBY_SENTRY_DSN` for a dev run (point it at a separate Sentry project, or at a local server that records what arrives). With neither, Sentry is never loaded and the **Crash reports** row in Settings stays hidden. To see the "closed unexpectedly" path, end a run from Task Manager and start it again. The run marker is `logs\running.json` in the profile.

## Scripts

| Script | What it does |
|---|---|
| `npm start` | Run in development |
| `npm test` | Unit and integration tests (Node's built-in runner; a fake Claude CLI stands in for the real one) |
| `npm run lint` | ESLint over main, the renderers, the tests and the scripts, each with the globals it really has (see eslint.config.mjs) |
| `npm run e2e:ci` | The end-to-end checks that need no Claude account, no GitHub and no network, one after another. This is what CI runs, and the only automated coverage the renderer has. It sets `SHELLBY_E2E=1`, so the app ignores what else is open on your desktop (src/main/test-desktop.js). Words narrow it (`npm run e2e:ci -- queue voice`); `--shard=i/n` takes every nth check, which is how CI splits them across four machines |
| `node scripts/smoke-real.js` | End-to-end check against your real Claude Code install |
| `node scripts/cli-compat.js` | Checks the installed Claude Code against what Shellby relies on: flags, permission modes, effort levels and the control protocol, with no account needed. `--real` adds one tiny Haiku turn (a Write approved over the protocol) and audits every event it sends. Nightly in CI; see [Keeping up with Claude Code](#keeping-up-with-claude-code) |
| `node scripts/e2e-ui.js` | Drives the real UI over CDP: two parallel tabs, a subagent needing approval, helper crabs on the desktop |
| `node scripts/overlay-visual-test.js` | Proves the critter never paints over apps: covers it with a window, cycles every mood, and counts real screen pixels |
| `node scripts/e2e-shop.js` | The Skill Shop against your real Claude Code, read-only: plugin list, search and filters, then Install is cancelled in the confirm window, so nothing is installed |
| `node scripts/e2e-lean.js` | Lean Shell: with the fake CLI, the prompt-cache dot on the context chip (warm, then cold) and the fresh-start XP; then Toolbox → Lean against your real Claude Code, read-only: plugins with their estimates, CLAUDE.md apart from path-scoped rules, and Turn off cancelled in the confirm window, so nothing is turned off |
| `node scripts/e2e-registry.js` | One-click install from the live community registry: warm and cold, themed confirmation, every item previewed |
| `node scripts/e2e-wardrobe.js` | Real task → first trophy unlocks → desktop celebration and the celebration card → wear the Party Hat from it (isolated profile) |
| `python scripts/preview-wardrobe.py` | Contact sheet of every accessory worn by the crab, for pixel-art work |
| `node scripts/e2e-plugin.js` | A **real** `claude -p` session with `--plugin-dir ./claude-plugin` drives a dev Shellby: the crab works, then celebrates. Also checks the hook is instant when Shellby is closed (uses one tiny prompt) |
| `node scripts/e2e-outfit-code.js` | Outfit codes: read your code, undress, paste it back for the same look; locked items, a community item traced to its pack in the live gallery, a typo, the code on the crab card |
| `node scripts/e2e-editor.js [folder]` | An edit's permission card shows its diff with line numbers, the tool row folds open to it, a path in a reply becomes a link (checked, never clicked), Ctrl+F counts and steps through matches, Ctrl+= zooms, Ctrl+Shift+P opens the palette, and Settings → Editor says what Automatic means. Screenshots go in `[folder]` |
| `node scripts/e2e-questions.js` | Claude's multiple-choice questions: a real question card, number keys, multi-select and your own words, Skip, and exactly what Claude receives |
| `node scripts/e2e-feed-cap.js` | A very long conversation stops growing the DOM: 3,600 blocks pumped through one tab, the cap holds, the tool and lane maps let go with the elements, a result for a long-trimmed tool is ignored, and replay is capped too |
| `node scripts/e2e-feed-scroll.js` | Your prompt is fully visible after sending, with the Working bar and queued messages, even when scrolled up; replies don't yank you out of history |
| `node scripts/e2e-streaks.js` | Streaks and nudges with a real throwaway git repo (last commit 6 days ago): the streak starts, the repo root is found from a subfolder, the nudge fires once, and "Pick it up" opens a tab there |
| `node scripts/e2e-inbox.js` | The Projects inbox with a real throwaway repo: a merged branch and one with a commit nowhere else under Stale branches, Delete takes the merged one at once, Keep files the other away (still in git, still away after a refresh), and the pull-request half says how to turn it on |
| `node scripts/e2e-github-workflows.js` | The CI-workflow permission toggle: present, gated on "Let Claude tasks push", never on by default, and the right wording in each state (a fake signed-in view, so no account or network) |
| `node scripts/e2e-friends.js` | Visiting crabs against a mock GitHub: asked first, a public calling card with only the look, a friend added by username, their crab on the desktop in their outfit, guestbook and souvenir, the Open House trophy, Peek at their tank (a hostile card's bits never drawn), his own tank on the card only once you choose and House Guest, waves both ways (strangers ignored), and the card deleted when it's turned off |
| `node scripts/e2e-github.js` | GitHub sign-in against a mock GitHub: the device code, only the chosen permissions, profile, the first sync into a private gist (his tank's layout included, its sharing left behind), publishing a pack as a pull request through the confirm window, Claude's git access (asked for separately, then present in new tasks), sign-out removes the encrypted token |
| `node scripts/e2e-sync.js` | Your friends list and settings following you between two PCs (two profiles, one mock GitHub): PC A's settings and friends reach a fresh PC B (the Settings view shows them, the friends' crabs are fetched, start at login stays A's), a change from another PC takes effect while B is open (mode, size, the open Settings view), and a friend B removes is gone from A too |
| `node scripts/e2e-plugin-card.js` | The plugin card (missing → Install button, installed → says so), an isolated copy on its own hook port with its marker, and the emoji + plain ASCII status files |
| `node scripts/e2e-forecast.js` | The usage forecast with backdated readings (SHELLBY_FORECAST_TEST): the composer warning and the meter, the setting, Ctrl+Shift+Enter holding a message (edit it back, drop it), then at the limit a held message and a held routine that both go by themselves at the reset |
| `node scripts/e2e-recap.js` | "While you were away" with fake idle readings: two hours away while one task finishes, one fails and one asks; the recap lists all three, a row opens its conversation, a 20-minute break or the setting turned off says nothing, and the usage block splits the window by conversation |
| `node scripts/e2e-team.js` | Team packs in throwaway repos: opening a repo with `.shellby/team.json` says so, Toolbox → Team lists it, Use these snippets makes `/ship` work there and only there, and Make a team pack writes the file (isolated profile) |
| `node scripts/e2e-statusline.js` | The status line: working, +XP and asking show up in the line; add it through the confirm window (isolated settings file), run the real statusLine command, remove restores the settings |
| `node scripts/e2e-xp.js` | XP and levels with the fake CLI and hook events: passing tests, a failing run (no XP), green again, git push, an outside deploy, desktop "+XP", level-up, Trophies card (next unlock, bounties, 30 days) |
| `node scripts/e2e-flaky.js` | The flaky test detective with the fake CLI: a Jest run piped through `tail` failing then passing on the same code, the Routines list, his "flaked 2 times this week" line, an edit between runs not counting, a click on the bubble, Fix it in a copy of the repository, and the Settings switch |
| `node scripts/e2e-bugdex.js` | The Bugdex with the fake CLI (commands replayed from `test/fixtures/bugdex/`): a failed command seen and on the loose with nothing paid, an edit and the same command passing caught (XP, the jar), the same bug soon after not counted twice, no catch for an unchanged tree, a deleted test or a grep through a log, the page, and the Settings switch |
| `node scripts/e2e-queue.js` | Queued messages with the fake CLI: queue behind a running turn, edit with ↑, drain in order, Stop hands them back, an error pauses the queue, a message queued while a tool runs is steered into the same turn (no Claude account needed) |
| `node scripts/e2e-routines.js` | Claude's other help with routines with the fake CLI: Describe it fills the editor, Fix with Claude on a failed routine opens a corrected one as an edit (nothing saved), and a request that needs a workflow is handed to the workflow builder |
| `node scripts/e2e-mcp.js` | MCP servers in workflows and routines, with the fake CLI and a fake MCP server in a throwaway home folder: the server list, reading its tools, an MCP tool step that runs and hands on its answer, the confirmation window naming what a step may use unasked, and the pickers in both editors |
| `node scripts/e2e-workflows.js` | Workflows with the fake CLI: typed Claude output steering an If, the confirmation window for risky saves, an Ask answered, Stop and Resume, a web hook on the local port |
| `node scripts/workflows-shots.js [dir]` | Screenshots of the Automate page (list, editor, a waiting run, a failed run) for a visual check |
| `node scripts/e2e-history-done.js` | The Done tick in History: a ticked conversation leaves the default list, the Not done / Done / All tabs only appear once something is done, Undo puts it back, and sending a done conversation more work un-ticks it |
| `node scripts/e2e-crab-only.js` | A brand-new user picks "Just the crab": Health as home, chat hidden, Claude features become the upsell, survives a restart |
| `node scripts/e2e-work-mode.js` | A brand-new user with a lively crab picks Work mode: the Claude setup, a bar that leads with the tools, Work mode's quiet settings on show while the file keeps theirs, a pal added in Work mode kept as its own, his needs resting, and Ctrl+K → Leave Work mode putting everything back |
| `node scripts/e2e-card.js` | The crab card: Share, preview, a 1200×630 PNG in the test profile, the Show-Off trophy, junk bytes refused, his tank painted on it, and on the profile card only once you share it |
| `node scripts/e2e-shellby-life.js` | Shellby's own life with the fake CLI and a mock GitHub: a level-up molts him into the Snail Shell (every beat, the Homes tab), petting, a throw that lands, an idle stroll, a focus session (helmet, countdown, XP, break), CI on a pull request going red, then fixed, then a review request, and a usage limit that's reached and then resets |
| `node scripts/e2e-voice.js` | His voice and his little habits with the fake CLI: Quiet says nothing at all, Normal puts words in his bubble (and clears them), the bubble never clips or resizes his window, he remarks on a test run and a push, each idle habit plays, he keeps quiet on guard, a health warning outranks him, and he's the same crab after a restart |
| `node scripts/e2e-push-to-talk.js` | Push-to-talk, pressing the real hotkey through Windows with a recording in place of the microphone: the Settings switch, a tap still opens and closes the panel, a hold shows *listening…* and puts the words in the box after what's typed (not sent), and switched off a hold is just a tap |
| `node scripts/e2e-updates.js` | The update button with a scripted updater (`SHELLBY_FAKE_UPDATE=1`, `=fail` or `=current`): the download and its progress, "Restart and update" and the dot on the gear, the toast, the route the tray and the notification take, and a failed check offering another go |
| `node scripts/e2e-health.js` | Every health mood with scripted sensors: desktop reaction, speech bubble, Health view, the badge on Health in the bottom bar, screenshots |
| `node scripts/ui-regressions.js` | Closing the last tab leaves one tab; themed tooltips replace the OS ones; dragging a tab; keyboard only: switching tabs, the Ctrl+/ list, the palette's actions, where focus lands, Ctrl+W on a working tab |
| `node scripts/titlebar-fit.js` | Checks the title bar fits at every panel width in every permission mode |
| `node scripts/wardrobe-shots.js` | Screenshots the Outfits screen and the desktop crab in his current outfit, and reports renderer errors |
| `node scripts/idle-cost.js [seconds] [--unfocused \| --awake] [--closed]` | What he costs while doing nothing, per process: CPU as a share of one core, and resident memory. Run it before and after anything touching animation or timers (see the budget below) |
| `npm run perf` | The performance budget, ~4 min, run by CI as its own job: cold start, crab click to panel shown, Shellby's own share of the wait for Claude's first word, idle CPU (panel closed, and open behind a window) and memory, each held against `scripts/perf-budgets.js`. Prints a table, writes `perf-result.json` (CI keeps it as an artifact), and fails when a number is over budget twice running. `--only cold,latency,idle`, `--cold N`, `--samples N`, `--settle S`, `--idle S`, `--out file` |
| `node scripts/zorder-probe.js` | Shows where the running critter sits in the window stack and whether it's owned by the desktop |
| `node scripts/e2e-perch.js [dir]` | Perching against a real Notepad (needs a desktop, so not in CI): the hop up, ownership and click-through, riding a slow drag, shaken off dizzy, the window closing under him, the walk home, Hop down. Screenshots each beat. If a fullscreen window covers his screen, give him another: `SHELLBY_E2E_HOME=x,y` (DIPs) |
| `npx electron scripts/perch-probe.js` | The Win32 behaviour perching rests on: an owned window above a window of another process, surviving that window closing or crashing, hiding with it when it minimizes |
| `npm run screenshots` | Re-render the README screenshots (with fake account details) |
| `npm run reel` | Record the README demo GIF: a scripted task, helper crabs and a trophy, played through the real UI (needs Python + Pillow; `pip install imageio-ffmpeg` adds the MP4) |
| `python scripts/make-banners.py` | Compose the README banner and crab lineups from the crabs `npm run screenshots` just captured (needs Pillow) |
| `npm run icons` | Regenerate the app icons from the classic skin (needs Python + Pillow) |
| `npm run dist` | Build the NSIS installer and portable exe into `dist/` |
| `npm run release:cut -- X.Y.Z "Title"` | On main: the [change notes](../changes/README.md) into a CHANGELOG entry, the version bumped, one commit and a tag, nothing pushed. `--dry-run` shows the entry. Then `npm run release:ready` and push the tag (CONTRIBUTING.md) |

## Keeping up with Claude Code

Claude Code ships often, and Shellby drives it through flags and a protocol that can change under it. So every night `.github/workflows/cli-compat.yml` installs the newest `@anthropic-ai/claude-code` and runs `scripts/cli-compat.js` against it:

- **Flags.** Every flag `ClaudeSession.buildArgs()` can launch with is listed in `src/main/cli-contract.js`, and a unit test fails if the two drift apart. The documented ones must be in `claude --help`. Two (`--permission-prompt-tool`, `--resume-session-at`) are hidden from it, so the check also launches with every flag at once and fails on `unknown option`.
- **Values.** Each `--permission-mode` Shellby's modes map to, and each `--effort` level, must be accepted (and a made-up one refused, or the check can't tell). Ask mode launches as `default`, which `--help` no longer lists but the CLI still takes.
- **Protocol.** The `initialize` control request, with the same hook registration Shellby sends, must be answered. It is answered before sign-in, so this needs no account.
- **A real turn**, only when the `ANTHROPIC_API_KEY` repository secret is set: one Haiku turn writes a file through an approved permission prompt, and every event it sends must be one `stream.js` understands. `KNOWN` in `stream.js` lists the events Shellby reads past on purpose; an event outside it is reported, and the transcript is kept as a run artifact.

A pass updates the **Works with Claude Code** badge in the README (a shields.io endpoint, `cli-compat.json` on the `badges` branch, which the workflow creates on its first run). A failure turns the badge red with the last version that worked, and opens an issue labelled `cli-compat`, or comments on the open one once per new version. The next pass closes it.

The app watches too: a top-level event type Shellby has never seen is written to the log once per run (`session.js`), so a "Report a problem" paste says what a Claude Code update added.

`test/fixtures/cli-transcripts/` holds real transcripts, scrubbed of paths, names, ids and per-user setup, and a unit test audits them on every CI run. To record one for a new version, on a signed-in machine (one tiny Haiku turn):

```
node scripts/cli-compat.js --real --transcript test/fixtures/cli-transcripts/<version>.jsonl
```

Read it before committing it.



## What he costs when idle

He is on the wallpaper all day, so this is the number that decides whether a
laptop user keeps him. Measure with `node scripts/idle-cost.js`, which reports a
share of **one core** (so 100% is one core saturated). `--closed` never opens
the panel; `--awake` keeps him and the panel as if focused and uncovered
(`SHELLBY_IDLE_AWAKE`) without taking focus from anything, so it's safe with a
game up. Never `--unfocused` while someone is playing: it starts Notepad in front.

Ryzen 9 3950X, October 2026 (all processes added up, no debugger, medians of
interleaved runs on a shared, busy desktop: expect ±1 point):

| State | CPU | Resident |
|---|---|---|
| Panel closed, crab visible, the October bats (default) | ~1.6–2.1% (GPU process 0.7–1.4, main 0.3, crab 0.1–0.3) | ~495 MB |
| Panel open behind your windows, no outfit | ~0.5–0.8% (crab and panel both calm or covered) | ~490 MB |
| Panel open and focused | ~4% (the panel's drifting light ticks at 12 fps) | ~500 MB |
| Nobody at the desk for 5 minutes (any outfit) | ~0.1% | ~490 MB |

The first row was ~3.4–4.2% before the bats flew in flights and the idle went
to pixel-art frames (interleaved with the same build minus those, same hour).
Of what's left, about half is his idle (about one frame a second: the breathe,
a blink, the snap) and half is life: a habit (dig, polish, peek...) about once
a minute at 12 fps for two or three seconds, a stroll, and a bat flight every
three minutes. Under 1% would mean fewer of those, which is a call about how
alive he looks rather than a fix. `--unfocused` on a busy desktop may leave the
panel focused (Notepad doesn't always get the foreground): if the panel's body
has no `calm` class, you measured the focused row.

Before this round (0.71.0) the crab alone was ~7% and a panel opened behind
your windows ~3.8%; the 37% / 75% of earlier releases went with the 12 fps
frame clock. Not counted above, because they aren't electron.exe: every
child process he starts. Until 0.71 that was `reg.exe` every 20 s (~330 ms of
CPU each, the microphone check) and `nvidia-smi` every 5 s (~50 ms each), about
2.6% of a core between them; now the registry is read in place and nvidia-smi
runs every 15 s while all is well and the panel is closed (~0.35%).

Where the rest goes: nearly all of it is the GPU process presenting frames of
the transparent crab window, roughly 0.5% of a core per frame per second. So
the work is in drawing fewer frames, not cheaper ones:

- **shared/framecap.js** ticks 12 times a second but only moves an animation
  when that tick changes the picture (it reads the keyframes once). A loop that
  eases the whole way round (the bats' orbit, a working hop) still draws every
  tick; one that steps (the idle breathe, blink and claw snap) draws a few
  frames a cycle. Prefer `steps()` for anything that runs all day. A step at
  the start of a hold changes nothing, so `steps(n)` (jump-end) isn't moved there.
- **Particle effects** (the seasonal bats are on by default in October) cost
  ~2 points while they play, so on the crab's window they come in flights
  (effects.js `FLIGHT`: 8 s every 3 min, fading in and out) and the particles
  are removed in between. Previews (the wardrobe, the OBS overlay) play them
  all the time. They stop with everything else when he's covered, the screen
  is locked, or nobody is at the desk.
- **The window in front** is read once for the game and cover checks
  (front-poll.js): its exe is kept while it stays in front, and the poll goes
  from 2 s to 5 s after half a minute without a change.
- **Away**: no key or mouse for five minutes (`powerMonitor.getSystemIdleTime`,
  in the front poll in wiring/windows.js) is treated like being covered.
  Isolated dev and test runs never count as away unless `SHELLBY_AWAY_S` is set.

The `calm` and `calm-deep` classes (see panel.css and `watchIdleCost` in wiring/windows.js)
drop the decorative animations when the panel isn't focused, and everything when
the screen is locked. Two findings worth keeping if you touch this:

- **`animation-play-state: paused` saves nothing.** A paused animation keeps its
  compositing alive and costs the same as a running one. Only `animation: none`
  (or removing the element) frees the work.
- **Never measure with a debugger attached.** `--remote-debugging-port` keeps the
  renderer and compositor awake; it turns 1% into 80% and will send you chasing
  the wrong thing.

- **Calm has to survive a repaint.** critter.js rebuilds the body's classes on
  every state push, so `calm-deep` is part of that list (`stillNow`), not a
  class toggled on the side.

Redrawing the sprite as a canvas or pre-rendered frames was the plan here, but
the SVG isn't what costs: the renderer is ~0.1–0.5% of a core, and the price is
per presented frame, whatever draws it. Fewer frames was the win.

### The budget CI holds him to

`npm run perf` (scripts/perf-budget.js) measures the numbers above, and a few
more, on every push, with an isolated profile and the fake Claude CLI. The
budgets are in `scripts/perf-budgets.js`, each with a comment saying where the
number comes from:

| Metric | Budget | Local (Ryzen 9 3950X, busy desktop) |
|---|---|---|
| Cold start to the crab painted | 8 s | 0.8–1.6 s |
| Cold start to the panel booted | 10 s | 1.1–1.5 s |
| Crab clicked to the panel shown and painted | 500 ms | ~20 ms (the very first open, ~1.2 s, is reported but not judged) |
| Shellby's share of the wait for Claude's first word | 600 ms | ~90 ms |
| Idle CPU, panel closed | 25% of a core | 1.5–5% (more with a particle outfit on) |
| Idle CPU, panel open behind a window | 60% of a core | 0.5–6% (the same) |
| Memory, panel closed / open | 900 / 1000 MB | ~500 MB |

They're loose on purpose: CI's runners have a few slow cores, no GPU and reduced
motion on, so they read several times slower than a desktop and vary between
runs. They catch a number that doubles, not one that creeps. Over a budget by up
to 15% prints a warning; past that the phase is measured once more, and the job
fails only if it's over again. Each run's `perf-result.json` artifact holds every
sample, so once a few runs show where the runner really sits, tighten the budgets
towards 1.5x that.

How each is measured, briefly (the header of perf-budget.js has the rest):

- **Cold start** is from spawning electron.exe to the `shellby:crab-painted` and
  `shellby:panel-ready` performance marks (critter.js, boot.js), read over CDP.
  The script's clock and the renderers' `performance.timeOrigin` are both the
  system clock, so the times line up.
- **First-token overhead** is Enter to the reply painted in the feed, minus the
  fake CLI's scripted 100 ms. Today most of it is the snapshot of the folder that
  `beginTurn` (wiring/sessions.js) takes before the message goes out, for the
  turn's diff.
- **Idle CPU and memory** use idle-cost.js's method (scripts/process-tree.js, now
  shared by both) in two launches with **no** debugger attached, for the reason
  above. The panel-closed launch uses a profile that has done onboarding; the
  open one is a fresh profile, focused, then Notepad takes focus.

Health shows the same thing to the person running him: **Shellby himself: 1% CPU,
450 MB** above the hogs list (health/footprint.js, from `app.getAppMetrics()`'s
`cumulativeCPUUsage`, since its `percentCPUUsage` is reset by anybody's call).

## Project layout

```
src/main/        Electron main process
  main.js          `shared` (the state every area reads and changes), the order areas are
                   wired in, and boot; nothing else. `share(wireX(shared))` adds an area's
                   exports to shared and stops boot if two areas give the same name
  wiring/          one module per area of the app: `wireX(shared)` returns its functions,
                   which only run once boot calls them. Besides windows, critter, sessions,
                   progress, timetrack, toolbox, github, tray and the rest:
    crash.js         snags (all logged, the first few said out loud) and starting Sentry
    profile.js       settings and history, opened first at boot
    panel.js         the panel's window: beside the crab, behind a game, making room
    crew-slots.js    room in the crab's window for helper and visiting crabs; saving his spot
    streaks.js       streaks and the hourly nudge check
    settings.js      settings' side effects: the hotkey, opening at login, the skins folder
    wardrobe.js      the Wardrobe at boot, its unlocks, the first-run credit from history
    services.js      usage, held work, routines, away, stickers and copies (the *-service.js files)
    quit.js          what quitting stops, in order
  ipc/             the panel's and crab's IPC handlers, one module per area: `registerXIpc(ipcMain, shared)`;
                   index.js registers them all behind the window check (ipc-guard.js)
  sessions.js      parallel conversations (tabs) + the critter's rolled-up mood
  session.js       one Claude Code process per conversation (stream-json + control protocol)
  stream.js        pure parser: CLI events (incl. subagent tasks) → UI items
  checks.js        turn checks: which test commands a folder has, running them (cmd, fixed lines only), the verdict and the bring-home gate
  shots.js         before/after pictures of a dev server either side of a turn, in a hidden locked-down window
  editor.js        "Open in VS Code": a turn's file in VS Code's diff, both sides read out of git
  filelinks.js     file links in a conversation: which editor, its vscode://-style link, and what's never opened (pure); ipc/files.js opens them
  safety.js        flags "runs a file Claude wrote" / "changes Claude Code itself"
  clash.js         copies that changed the same files (pure); clash-scan.js asks git which files each changed
  toolbox.js       skills/agents/commands/MCP scan + "learned a new trick" watcher
  marketplace.js   the Skill Shop, on top of Claude Code's own `claude plugin` CLI
  confirm.js       themed confirmation windows (installs, sign-in, publishing), each in its own sandbox
  routines.js      schedule maths + scheduler for recurring tasks
  routine-draft.js Claude's prompts and answers for routines: Describe it, the editor's chat, Fix with Claude
  corrections.js   learning from corrections (pure): the same comment, Deny or undo twice in a project -> a rule offered;
                   learned-rules.js appends it to that project's CLAUDE.md, correction-draft.js lets Claude word it
  workflows/       the workflow engine (docs/plans/workflows.md): schema, expr (templates and conditions),
                   engine (replaying interpreter), effects, triggers, store, draft, templates, service
  wardrobe/        catalog (packs + validation), seasons, achievements, and the outfit service
  health/          sensors (nvidia-smi, LibreHardwareMonitor, Windows), pure threshold rules, the monitor loop, alerts, his own footprint
  external.js      Claude Code sessions outside Shellby: the local hook listener and session tracking
  handoff.js       a conversation to a terminal and back (pure): the launch command per shell, ids, folders
  xp.js            XP and levels: awards, falloff and bonuses, the level curve and its unlocks, per-PC counts for sync, and what a shell command means
  bounties.js      the day's three bounties, picked from the date alone
  shells.js        the shells he grows into as he levels up (molting)
  motion.js        throws (release velocity, flight, landing) and idle strolls
  voice.js         what he says and when (pure): line pools, cooldowns, temperament, idle habits
  dictation.js     push-to-talk: tap-or-hold on the hotkey, and Windows' offline speech recognizer in one warm PowerShell
  focus.js         focus sessions: focus, break, and what a restart picks up
  limits.js        usage limits: when one is reached, when it resets
  forecast.js      the 5-hour window's pace (pure): when it fills, and whether that's worth a warning
  turncost.js      what a turn and a tab cost (pure): tokens, share of the 5-hour window, the costliest turns, the crowded nudge
  held.js          messages and routine runs held for after the usage reset (pure list ops; held-service.js sends them)
  usage-ledger.js  what each turn cost (pure): the per-turn ledger, a prompt's kind of ask, and the estimate the
                   composer shows; wiring/usageplan.js brackets each turn and answers usage:estimate
  statusline.js    Shellby's line for Claude Code's status line, and adding/removing it in Claude's settings
  updates.js       the self-update state machine behind the button in Settings → About (electron-updater is injected, so it's testable)
  github/          sign-in (device flow, encrypted token), the REST client, gist sync, pack publishing, CI on your pull requests (ci.js), calling cards and waves for visiting crabs (card.js, mail.js), and the service tying them together
  friends.js       visiting crabs: friends list, drop-ins, guestbook and souvenirs, on top of github/card.js and mail.js
  streaks.js       streaks and nudges (pure); gitinfo.js finds a folder's repo and its last commit
  startfrom.js     prompts for Fix this build, Address the review and loose ends (pure): log trimming
                   and redaction, review threads quoted, TODO parsing; github/prwork.js fetches them
  desktop-layer.js keeps the critter on the wallpaper layer (koffi → user32)
  claude-cli.js    finds the CLI, checks auth, scrubs billing env vars
  claude-update.js keeps the CLI itself current: the daily registry check, `claude update` on request or by itself while idle, tell | auto | off (fetch and run are injected; wiring/claude-updates.js)
  history.js       local conversation index + transcripts
  log.js           the log behind "Report a problem" (scrubbed of paths and tokens)
  trouble.js       a failed turn in one sentence and the button for the next step (pure); the raw words go to the log
  skins.js         loads and validates skins
  config.js        settings in %APPDATA%\Shellby\settings.json
  workmode.js      Work mode (pure): the settings it lays over yours, where a change made in it is kept, and what else it quiets
  placement.js     pure geometry for placing the critter and panel across monitors
  capture.js       `npm run screenshots`; reel.js records the README demo
src/preload/     the only bridge between sandboxed renderers and main
src/renderer/    critter + panel UIs (plain HTML/CSS/JS, no framework)
  critter/         the desktop crab: critter.js (moods, bubble, habits) · sound.js (the WebAudio engine: volume, footsteps, bumps, ta-das) · chirp.js (his voice) · ambient.js (surf, rock pool); none use audio files, and main decides what may play (src/main/sounds.js)
  panel/           core · shortcuts (every key, the palette's ranking; pure) · nav (bottom bar, Ctrl+K, Ctrl+/) · files (file links, an edit's diff, zoom) · find (Ctrl+F) · feed (crew lanes) · tabs · toolbox · shop · routines · workflows · settings · wardrobe · xp · streaks · health · card · celebrate · crabonly · workmode · outfitcode · github · boot
                   a big screen is a file per part (tab-strip, tab-send, feed-asks, settings-account, health-gauges…), and its words and decisions live in a pure module beside it with node:test coverage (tab-logic, feed-logic, settings-text, health-logic, projects-logic, tab-sort)
src/skins/       built-in skins (JSON pixel grids)
src/wardrobe/    the built-in wardrobe pack (same format as community packs)
test/            node:test suites and a fake Claude CLI
claude-plugin/   the Shellby plugin for Claude Code (hooks that report sessions to the app)
```
