# Developing Shellby

How to build Shellby, the test and maintenance scripts, and a map of the code. For the contribution guidelines, see [CONTRIBUTING.md](../CONTRIBUTING.md); for how Shellby drives Claude Code, see [How it works](../README.md#how-it-works).

## Build and run

```powershell
git clone https://github.com/x-salmon/shellby
cd shellby
npm install
node node_modules/electron/install.js   # only if npm skipped the Electron download
npm start
```

## Scripts

| Script | What it does |
|---|---|
| `npm start` | Run in development |
| `npm test` | Unit and integration tests (Node's built-in runner; a fake Claude CLI stands in for the real one) |
| `node scripts/smoke-real.js` | End-to-end check against your real Claude Code install |
| `node scripts/e2e-ui.js` | Drives the real UI over CDP: two parallel tabs, a subagent needing approval, helper crabs on the desktop |
| `node scripts/overlay-visual-test.js` | Proves the critter never paints over apps: covers it with a window, cycles every mood, and counts real screen pixels |
| `node scripts/e2e-shop.js` | The Skill Shop against your real Claude Code, read-only: plugin list, search and filters, then Install is cancelled in the confirm window, so nothing is installed |
| `node scripts/e2e-registry.js` | One-click install from the live community registry: warm and cold, themed confirmation, every item previewed |
| `node scripts/e2e-wardrobe.js` | Real task → first trophy unlocks → desktop celebration and the celebration card → wear the Party Hat from it (isolated profile) |
| `python scripts/preview-wardrobe.py` | Contact sheet of every accessory worn by the crab, for pixel-art work |
| `node scripts/e2e-plugin.js` | A **real** `claude -p` session with `--plugin-dir ./claude-plugin` drives a dev Shellby: the crab works, then celebrates. Also checks the hook is instant when Shellby is closed (uses one tiny prompt) |
| `node scripts/e2e-outfit-code.js` | Outfit codes: read your code, undress, paste it back for the same look; locked items, a community item traced to its pack in the live gallery, a typo, the code on the crab card |
| `node scripts/e2e-questions.js` | Claude's multiple-choice questions: a real question card, number keys, multi-select and your own words, Skip, and exactly what Claude receives |
| `node scripts/e2e-feed-scroll.js` | Your prompt is fully visible after sending, with the Working bar and queued messages, even when scrolled up; replies don't yank you out of history |
| `node scripts/e2e-streaks.js` | Streaks and nudges with a real throwaway git repo (last commit 6 days ago): the streak starts, the repo root is found from a subfolder, the nudge fires once, and "Pick it up" opens a tab there |
| `node scripts/e2e-github.js` | GitHub sign-in against a mock GitHub: the device code, only the chosen permissions, profile, the first sync into a private gist, publishing a pack as a pull request through the confirm window, Claude's git access (asked for separately, then present in new tasks), sign-out removes the encrypted token |
| `node scripts/e2e-plugin-card.js` | The plugin card (missing → Install button, installed → says so), an isolated copy on its own hook port with its marker, and the emoji + plain ASCII status files |
| `node scripts/e2e-statusline.js` | The status line: working, +XP and asking show up in the line; add it through the confirm window (isolated settings file), run the real statusLine command, remove restores the settings |
| `node scripts/e2e-xp.js` | XP and levels with the fake CLI and hook events: passing tests, a failing run (no XP), git push, an outside deploy, desktop "+XP", level-up, Trophies card |
| `node scripts/e2e-queue.js` | Queued messages with the fake CLI: queue behind a running turn, edit with ↑, drain in order, Stop hands them back, an error pauses the queue (no Claude account needed) |
| `node scripts/e2e-crab-only.js` | A brand-new user picks "Just the crab": Health as home, chat hidden, Claude features become the upsell, survives a restart |
| `node scripts/e2e-card.js` | The crab card: Share, preview, a 1200×630 PNG in the test profile, the Show-Off trophy, junk bytes refused |
| `node scripts/e2e-health.js` | Every health mood with scripted sensors: desktop reaction, speech bubble, Health view, the badge on Health in the bottom bar, screenshots |
| `node scripts/ui-regressions.js` | Closing the last tab leaves one tab; themed tooltips replace the OS ones |
| `node scripts/titlebar-fit.js` | Checks the title bar fits at every panel width in every permission mode |
| `node scripts/wardrobe-shots.js` | Screenshots the Outfits screen and the desktop crab in his current outfit, and reports renderer errors |
| `node scripts/zorder-probe.js` | Shows where the running critter sits in the window stack and whether it's owned by the desktop |
| `npm run screenshots` | Re-render the README screenshots (with fake account details) |
| `npm run reel` | Record the README demo GIF: a scripted task, helper crabs and a trophy, played through the real UI (needs Python + Pillow; `pip install imageio-ffmpeg` adds the MP4) |
| `npm run icons` | Regenerate the app icons from the classic skin (needs Python + Pillow) |
| `npm run dist` | Build the NSIS installer and portable exe into `dist/` |


## Project layout

```
src/main/        Electron main process
  main.js          windows, tray, hotkey, IPC, notifications, updates
  sessions.js      parallel conversations (tabs) + the critter's rolled-up mood
  session.js       one Claude Code process per conversation (stream-json + control protocol)
  stream.js        pure parser: CLI events (incl. subagent tasks) → UI items
  safety.js        flags "runs a file Claude wrote" / "changes Claude Code itself"
  toolbox.js       skills/agents/commands/MCP scan + "learned a new trick" watcher
  marketplace.js   the Skill Shop, on top of Claude Code's own `claude plugin` CLI
  confirm.js       themed confirmation windows (installs, sign-in, publishing), each in its own sandbox
  routines.js      schedule maths + scheduler for recurring tasks
  wardrobe/        catalog (packs + validation), seasons, achievements, and the outfit service
  health/          sensors (nvidia-smi, LibreHardwareMonitor, Windows), pure threshold rules, the monitor loop, alerts
  external.js      Claude Code sessions outside Shellby: the local hook listener and session tracking
  xp.js            XP and levels: awards, hourly caps, the level curve, and what a shell command means
  statusline.js    Shellby's line for Claude Code's status line, and adding/removing it in Claude's settings
  github/          sign-in (device flow, encrypted token), the REST client, gist sync, pack publishing, and the service tying them together
  streaks.js       streaks and nudges (pure); gitinfo.js finds a folder's repo and its last commit
  desktop-layer.js keeps the critter on the wallpaper layer (koffi → user32)
  claude-cli.js    finds the CLI, checks auth, scrubs billing env vars
  history.js       local conversation index + transcripts
  skins.js         loads and validates skins
  config.js        settings in %APPDATA%\Shellby\settings.json
  placement.js     pure geometry for placing the critter and panel across monitors
  capture.js       `npm run screenshots`; reel.js records the README demo
src/preload/     the only bridge between sandboxed renderers and main
src/renderer/    critter + panel UIs (plain HTML/CSS/JS, no framework)
  panel/           core · nav (bottom bar, Ctrl+K) · feed (crew lanes) · tabs · toolbox · shop · routines · settings · wardrobe · xp · streaks · health · card · celebrate · crabonly · outfitcode · github · boot
src/skins/       built-in skins (JSON pixel grids)
src/wardrobe/    the built-in wardrobe pack (same format as community packs)
test/            node:test suites and a fake Claude CLI
claude-plugin/   the Shellby plugin for Claude Code (hooks that report sessions to the app)
```
