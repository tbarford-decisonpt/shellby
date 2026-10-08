# Shellby

A pixel hermit crab desktop pet for Windows that also runs Claude Code: Electron,
plain JS, no renderer framework. The rules for contributors are in
[CONTRIBUTING.md](CONTRIBUTING.md). Every script, the e2e checks and a map of the
code are in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Read those before working
in an area you haven't touched.

## Checks

```powershell
npm run lint
npm run typecheck   # jsconfig over src/preload and src/main/{ipc,flaky,remote,backlog,bugdex} only
npm test            # node:test, a fake Claude CLI stands in for the real one
npm run e2e:ci      # the real app over CDP; `npm run e2e:ci -- queue voice` runs only those
```

CI runs all four on `windows-latest`. `npm test` needs no Electron binary, but the
e2e scripts do: run `node node_modules/electron/install.js` first.

## Working in a copy (worktree)

Shellby moves each conversation into its own worktree under
`%APPDATA%\Shellby\worktrees\<id>\<repo>`, which starts with no `node_modules`.
Shellby installs them for you (`npm ci --ignore-scripts`) when the original
checkout has exactly that lockfile installed and every package comes from the
registry. It says so when the conversation moves. If it hasn't, run
`$env:ELECTRON_SKIP_BINARY_DOWNLOAD='1'; npm ci` in the copy. Don't copy or
junction the main checkout's `node_modules`, which is incomplete.

The git stash stack is shared by every worktree. Use a WIP commit instead.

## Versions and the CHANGELOG

- **Never bump `version` or add a `## X.Y.Z` CHANGELOG heading on a branch.** Several
  branches run off the same main at once, and each one claiming the next version
  makes every later merge conflict.
- Instead, describe a user-facing change in a note: `changes/<short-name>.md`, with
  `### New`, `### Fixed`, `### Faster` or `### Changed` sections of bullets in the
  CHANGELOG's own voice. One file per branch, so notes never conflict. See
  [changes/README.md](changes/README.md).
- Releases are cut on main: `npm run release:cut -- X.Y.Z "Title"` gathers the
  notes into the CHANGELOG, bumps the version, commits and tags locally. Then push
  main, run `npm run release:ready` (waits for CI on that commit to be green) and
  push the tag. A tag that fails to release is never moved: the fix ships as the
  next patch.

## Commits

`<type>: <description>`, with types feat, fix, perf, refactor, test, docs, chore and
ci. The Releases card and `release:cut` group commits by type, so a subject without
one lands under "Changed" word for word.

## Traps that have bitten before

- **panel.html is built.** Edit the pieces in `src/renderer/panel/html/` (a file per
  screen), then `npm run panel:html`. A test fails while the built file is stale.
- **Line endings are LF.** Edits through Python's text mode on Windows rewrite whole
  files as CRLF. Use the Edit tool, Node `fs`, or `open(..., newline='')`.
  `claude-plugin/mcp/server.js` has literal control characters in a regex, and its
  older commits diff as binary, so read those with `git diff --text`.
- **Temp paths on CI are 8.3 short names** (`C:\Users\RUNNER~1\...`) and git reports
  the long path. Tests that compare paths with git output make their temp dirs with
  `fs.realpathSync.native(fs.mkdtempSync(...))`. The dev PC has no short paths, so
  only CI catches this.
- **CI has reduced motion on.** Motion-gated UI is skipped there. e2e that watches
  animations launches with `--force-prefers-no-reduced-motion`.
- **Unpainted windows never answer `Page.captureScreenshot`.** Capture through
  `scripts/lib/shot.js` (`savePng`), which races the shot against a 10 s wait. The
  crab hung locally whenever a window or game covered his corner (Chromium stops
  painting him, and Shellby itself hides him under a game). Test runs (the fake CLI,
  `SHELLBY_MOTION_TEST`, `SHELLBY_FAKE_HEALTH`, or `SHELLBY_E2E=1`, which `e2e:ci` sets)
  now keep every window painting, skip the cover/game watch and ignore who has the
  mic (`src/main/test-desktop.js`). `SHELLBY_COVER_POLL=1` brings the watch back for
  a check about it (e2e-on-top).
- **The mic reads as a call** on a dev PC with Discord or a game open, and he goes
  silent. e2e that expects speech or sound pins it off:
  `shellby.dev.life({ what: 'call', on: false })` (needs `SHELLBY_MOTION_TEST=1`).
- **Electron 44's clipboard is async and W3C-style.** `readImage`, `writeImage` and
  `availableFormats` are gone, and `writeText` returns a promise. Check
  `node_modules/electron/electron.d.ts` before using an Electron API from memory.
- **e2e counts come from source** (`FINDS`, `SETS`, `BITS`, `templates()`), never
  hardcoded numbers.
- `claude-plugin/.claude-plugin/plugin.json` has its own version. Bump it together
  with `PLUGIN_VERSION` in `src/main/statusline.js` (a test checks they match), and
  only when the plugin changes.

## Running the app and probes

- Never move, resize, focus or minimize a window you didn't create and find by pid.
  Never act on `GetForegroundWindow()`: a game often holds it.
- Close every Electron, test runner and helper process you start. Dev runs that
  leave them behind add up to dozens of processes.
- A dev instance with its own `SHELLBY_USER_DATA` runs alongside an installed
  Shellby. `SHELLBY_FAKE_CLAUDE` and `SHELLBY_HOOK_PORT` keep it off the real CLI and
  the live app's hook port.
  `npm run dev:crab` starts one with all three set (`--poses` previews every pose).
