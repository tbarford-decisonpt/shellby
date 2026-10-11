# File viewer: browse a folder and see what a worktree changed

Status: design approved in brainstorming on 2026-10-11. No code yet.
Branch: `file-viewer`, cut from `split-panes` (PR #27, on upstream 0.79.0).

## Why

Tyler's principal engineer says he'd use Shellby if he could look inside a git worktree and see the files that changed in it, including while Claude is still working. Tyler has his own version of the problem: when Claude says "look at this file", he has to leave Shellby to open it.

From any pane, one click should open a read-only, VS Code-style view of that pane's folder. It lists what changed since the branch split off, shows each diff with line numbers, shows any file in colour, and keeps up while Claude edits.

## Decisions

| Question | Decision |
|---|---|
| Where it lives | A full-panel screen. A pane beside the chat would take a whole grid cell and squeeze every chat next to it. Esc or Back returns to the grid exactly as it was. |
| Scope | Read-only. Nothing in the viewer changes a file or sends to Claude. |
| File links in replies | Click opens the viewer at that line. Ctrl+click opens the editor (today's click). Shift+click shows the file in Explorer (unchanged). Paths outside the pane's folder keep opening the editor. |
| Data access | Folder handles kept in main (approach A). The UI never sends main a raw path or git ref to read. |
| What "changed" means | Since the branch split off: merge-base to the working folder, untracked files included. A "Just uncommitted" toggle switches to HEAD to the working folder. |
| Which worktrees | Every worktree `git worktree list` reports for a known project, not just Shellby's copies. |
| Freshness | Nudges from hooks that already exist, plus a refresh button. No file watcher. |
| Big files | Colour up to 4,000 lines and plain text past that. Over 2 MB, or binary, shows "Open in editor". |
| Diff layout | Unified, with old and new line numbers. |
| Tree contents | Tracked and untracked files, gitignored ones left out (the same list as @-mentions). |

Rejected: a viewer pane in the grid, which costs reading room and changes the panes model; its own window, a second window to manage; path-based reads with an allowlist (approach B), which breaks the "handlers take ids, not paths" rule; handing diffs to VS Code (approach C), which leaves Shellby.

## The screen

```
┌─ ← Back │ shellby · viewer-a1b2 (from main) │ ● Working │ ⟳ │ Open in editor ─┐
│ [Changes 7] [All files]        │ src/main/viewer.js       M  +12 −3          │
│ ☐ Just uncommitted             │─────────────────────────────────────────────│
│ M  src/main/viewer.js  +12 −3  │  41  41    const root = handle.root         │
│ A  src/main/ipc/view.js   +80  │  42      − return read(p)                   │
│ D  old/files.js           −40  │      42  + return readInside(root, p)       │
│ ?  notes.md               +9   │  43  43  }                                  │
│                                │                       [Whole file]          │
│ [Filter…]                      │                                             │
└────────────────────────────────┴─────────────────────────────────────────────┘
```

Header:
- Back (Esc).
- Folder name, then branch and the base it came from.
- The conversation's live state (working, needs you, done) when the viewer was opened from a pane or a reply link.
- Refresh, and "Open in editor" for the file on screen.

Left side:
- Changes is the default whenever there are changes. A row shows a status letter (A, M, D, T, and ? for untracked), the path and +/− counts. "Just uncommitted" narrows the list.
- All files is a folding tree. Changed files carry their status colour. A filter box narrows the tree.
- ↑/↓ moves through the list. Enter opens a file.

Right side:
- A changed file opens as a unified diff with old and new line numbers. "Whole file" switches to the full text.
- An unchanged file opens as its full text with line numbers and colour. A link with `:42` scrolls to that line and highlights it.

Ways in:
1. A Files button at the right end of each pane's tab strip (`.pane-head`), or of the main tab strip when there's one pane, where `.pane-head` is hidden. It opens the folder of that pane's active conversation.
2. File paths in Claude's replies.
3. A "View changes" entry in the branch chip menu (`tab-git.js`), which opens on Changes. The branch chip (`#branchChip`, `tab-chips.js`) shows for every git folder, not only Shellby copies. For a plain checkout it shows the branch name, and its menu offers just "View changes".
4. The Worktrees list and a "Browse files" button on the Project page.

The Files button is hidden for remote (ssh) tabs and for tabs with no folder yet.

Limits on purpose:
- One viewer at a time. Opening it from another pane swaps the folder. It remembers the last file per folder while Shellby runs.
- Pop-out windows keep today's link behaviour (editor), since they only show chat.

## Main: handles and channels

### Handles

`viewer:open` takes either `{tabId}` or `{projectRoot, worktreePath}`.
- A tab resolves to `tab.session.cwd`. Remote tabs are refused, since their folder is a local stand-in (`src/main/remote/service.js`).
- A worktree path is accepted only if `git worktree list` for that known project reports it (the list `leaving.js` already reads).

The handle's root is the git top level of that folder (`changes.rootOf`), or the folder itself when it isn't in a repo. A conversation started in a subfolder still gets the whole repo, so the changes list, the tree, reads and reply links all agree on one root.

Main resolves the root's real path once and stores a handle `{root, base, changed}` in a map of at most 8, dropping the oldest first. It returns the handle id plus header details (name, branch, base).

### What "changed" is built from

All of it is existing code in `src/main/changes.js`.
- `snapshot(root)` writes the working folder, untracked files included, as a git tree.
- The base commit:
  - For a Shellby copy: `merge-base <tab.worktree.base> HEAD`.
  - For any other worktree: merge-base with the branch the project's main checkout is on. The header names it, so the choice is visible.
  - For a plain checkout, with "Just uncommitted" on, or when merge-base fails: `HEAD`.
- `summarize(base, snapshot)` produces the list (500-file cap). Main stores it on the handle.
- In a snapshot diff an untracked file looks like any other added file. Main marks it `?` by checking `git status --porcelain -z --untracked-files=all`, the call `clash-scan.js` already makes.

Snapshots hash the working folder into git, the same work `branch:compare` does. They run when the viewer opens and on refresh, debounced to at most once every 2 s.

### Channels

| Channel | Does |
|---|---|
| `viewer:open` | Makes a handle, returns header info |
| `viewer:tree(h)` | `fileIndex.list(root)` (cached 20 s). The UI builds the tree |
| `viewer:changes(h, {uncommittedOnly})` | Takes a fresh snapshot, summarizes, stores the list |
| `viewer:read(h, rel)` | File text, confined to the handle's root |
| `viewer:diff(h, rel)` | `patchFor` (400 KB cap), only for a path on the stored list |
| `viewer:locate(tabId, target)` | For a reply link: `filelinks.parseTarget`, then whether the file is inside the tab's folder. If it isn't, the UI falls back to `file:open` |
| `viewer:close(h)` | Drops the handle |
| `viewer:stale` (event, main to UI) | A handle's folder changed |

### Read rules

`viewer:read` resolves `rel` against the root and resolves the real path. It refuses anything outside the root. The comparison ignores case and expands 8.3 short names, so a junction or symlink pointing out of the folder fails. Over 2 MB returns `{tooBig}`. A NUL byte in the first 8 KB returns `{binary}`. Text is decoded as UTF-8, with any BOM stripped.

### Files

- `src/main/viewer.js`: handle store, `readInside`, base choice. Pure where possible, covered by node:test.
- `src/main/ipc/viewer.js`: the channels, registered in `src/main/ipc/index.js`, exposed in `src/preload/preload.js`, and typed for `npm run typecheck`.
- `src/renderer/shared/filetree.js`: pure flat-list-to-tree with change marks, covered by node:test.
- Renderer: a new view (`html/viewer.html`, included in `frame.html`, registered in `SB.views`), its script and CSS. It reuses `syntax.js` / `SB.paintTokens` for colour, `F.diffRows` for parsing patches, and the line-number gutter style of `SB.diffView`.
- `src/renderer/panel/files.js`: the link click routes through `viewer:locate`.
- `src/renderer/panel/project-page.js`: `copiesList` rows become clickable, plus "Browse files".
- `src/renderer/panel/tab-panes.js` / `tab-strip.js`: the Files button.
- `src/renderer/panel/tab-git.js`: "View changes" in the branch menu. `src/renderer/panel/tab-chips.js`: the branch chip shows for every git folder.
- `docs/THREAT-MODEL.md`: a new "Renderer → main file read" row.

## Staying fresh

Main sends `viewer:stale` to each open handle whose root contains the folder that changed. It fires on:
- every tool result in a conversation working in that folder. Bash counts, since it can write files.
- the end of each turn (`src/main/wiring/sessions.js`, beside the existing `fileIndex.forget`).
- `!` shell commands (`src/main/parity.js`) and step undo (`src/main/wiring/step-undo.js`), the other places that call `forget`.

`viewer:stale` is a nudge with no payload. The UI re-fetches only when the viewer is open on Changes, at most once every 2 s. The file on screen reloads only if its status or counts changed, and keeps its scroll position near the same line.

Worktrees opened from the Project page with no conversation in them get no nudges. Refresh is manual there.

The header's live state comes from what the renderer already knows about the tab. No new IPC.

## Project page

`copiesList` (`project-page.js`) is display-only today. Each row becomes clickable and opens that worktree in the viewer, keeping its branch and "N changed" chip, plus a Files icon. It's fed by `git worktree list` minus the main checkout (`projects/service.js` `gitView`), so Claude Code's `.claude/worktrees/*` and hand-made worktrees appear too. The 12-row cap stays, with "and N more" added when it's hit. The project card gets a "Browse files" button for the main checkout.

## When things go wrong

| Case | What you see |
|---|---|
| Worktree deleted while open | "This folder is gone" and Back |
| Not a git repo | No Changes tab. All files uses `fileindex`'s bounded walk |
| git missing or timed out | Changes shows "Couldn't read changes" and Retry. The tree still works |
| File gone between list and open | "This file is gone". A deleted (D) entry still shows its diff, with Whole file turned off |
| Handle dropped (cap or reload) | The UI reopens it once, silently |
| More than 500 changes | "Showing the first 500 of N" |
| Too many untracked files to snapshot (`snapshot` returns null with `SKIPPED_TOO_MANY`) | "Too many new files to compare". The tree still works |
| Patch over 400 KB, file over 2 MB, binary | A short note and "Open in editor" |

## Tests

- **node:test, `src/main/viewer.js`:**
  - `readInside`: inside the root, `..`, an absolute path outside, a junction pointing out, case differences, and 8.3 names. Temp dirs are made with `fs.realpathSync.native(fs.mkdtempSync(...))`.
  - The size and binary rules.
  - Base choice for a copy, another worktree, a plain checkout, and merge-base failing.
  - The handle cap, and diffs refused for paths not on the list.
- **node:test, IPC:** remote tabs refused, and worktree paths `git worktree list` didn't report refused.
- **node:test, `filetree.js`:** tree building and change marks.
- **Link routing:** click goes to the viewer, Ctrl to the editor, Shift to Explorer, and outside-folder paths fall back to the editor.
- **e2e, `e2e-viewer.js`, added to `e2e:ci`:**
  - The fake Claude edits a file in a copy, in a two-pane layout.
  - The pane's Files button lists that file under Changes, and the diff renders.
  - A second edit nudges the count.
  - Esc returns the grid with both panes intact.
  - Screenshots race a 10 s wait. Counts come from source.
- Done means `npm run lint`, `npm run typecheck`, `npm test` and `npm run e2e:ci` all pass.

## Delivery

- Work in `.claude/worktrees/file-viewer` on branch `file-viewer`.
- The PR opens after #27 merges, rebased onto upstream/main, so it doesn't carry #27's commits.
- A `changes/file-viewer.md` note under `### New`. No version bump, no CHANGELOG heading.
- `panel.html` regenerated with `npm run panel:html`.
- Upstream has no `docs/superpowers/` folder. This spec is dropped from the branch before the PR unless Tyler wants it shipped.

## Out of scope for v1

Comments to Claude, undo from the viewer, side-by-side diffs, Ctrl+F inside a file, a pop-out viewer, and the agent tray (its own spec).
