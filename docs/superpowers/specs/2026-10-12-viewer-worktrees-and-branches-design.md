# File viewer: switch between worktrees and branches

Status: design approved in brainstorming on 2026-10-12. No code yet.
Branch: `file-viewer`, on top of the file viewer (spec `2026-10-11-file-viewer-design.md`, head 02fc2727 plus the layout fix).

## Why

Agents often work in a worktree of their own (`.claude\worktrees\agent-*`), and branches pile up while they work. Tyler wants to see all of that from the viewer: every worktree of the repo, and every branch still in flight, with what each one changed. Today the viewer shows one folder, and you reach another worktree only through the Project page.

## Decisions

| Question | Decision |
|---|---|
| Which places | Every worktree `git worktree list` reports for the repo (local folders only), plus unmerged local branches |
| Unmerged | A local branch with commits the main checkout's branch doesn't have. Merged, stale and remote branches stay out |
| A branch with no worktree shows | Changes since it left main, each diff, Whole file for any file in it, and All files as its tree. Read from git; nothing is checked out |
| How branches are read | A branch handle in main (approach A), read with read-only git commands |
| Where the list lives | A menu on the viewer's header ("repo · branch ▾") |

Rejected: checking a branch out into a hidden temporary worktree and reusing folder handles (approach B), which writes a worktree record into the repo, copies files to disk and runs the repo's checkout hooks; a summary-only list without diffs or contents (approach C); remote branches, which need a fetch Shellby wouldn't do on its own; a cross-project dashboard.

## Main: branch handles

`src/main/viewer.js` gains a second kind of handle: `{ id, kind: 'branch', root, ref, commit, base, ... }`, where `ref` is the branch's full name (`refs/heads/feature-x`), `commit` the commit it pointed at when last read, and `base` the branch the main checkout is on (as `mainBranchFor` finds it). Folder handles are `kind: 'folder'` and behave as today.

- **Changes:** `fork = merge-base <base> <commit>`, else the empty tree when they share no history. The list is `changes.summarize({ root, tree: fork }, { root, tree: commit })`, the 500-file cap included. No snapshot, no temporary index, no `git add`, no `git status`; branch files are never marked `?`. `uncommittedOnly` doesn't apply and is ignored.
- **Refresh:** each `changesOf` re-reads `rev-parse --verify <ref>^{commit}`, so new commits show; the 2 s reuse and the generation counter work as for folders. A ref that no longer resolves answers `{ ok: false, branchGone: true }`.
- **Diffs:** `changes.patchFor({ root, before: fork, after: commit, file })` for a path on the handle's last list, 400 KB cap.
- **All files:** `git ls-tree -r -z --name-only <commit>`, folders derived from the paths, in the same `entries` shape `fileIndex.list` returns (`dir/` entries and files, forward slashes). Gitignored files never appear, since they aren't in a commit.
- **Whole file:** only for a path in that `ls-tree` list (case-sensitive match on git's own path). `git cat-file -s <commit>:<path>` first: over 2 MB answers `{ tooBig, size }`. Then `git cat-file blob <commit>:<path>` with `GIT_LITERAL_PATHSPECS=1`; a NUL in the first 8 KB answers `{ binary }`; a BOM is stripped. A path not in the list answers `{ ok: false, missing: true }`, as folder reads do.
- **Nothing runs and nothing is written:** every call is `merge-base`, `rev-parse`, `diff`, `ls-tree`, `cat-file` or `for-each-ref`, through `execFile` with fixed arguments, `core.fsmonitor=false`, `GIT_OPTIONAL_LOCKS=0`, a timeout. `cat-file blob` doesn't run clean or smudge filters.
- **Header:** `open` for a branch returns `{ ok, id, root, name, branch, base, git: true, kind: 'branch' }`.

## Main: the list and picking

### `viewer:places(id)`

For the handle's repo (`changes.rootOf` of a folder handle's root, or a branch handle's root), returns `{ ok, places: [{ key, kind: 'worktree'|'branch', label, branch, changed?, ahead?, when?, current }] }`.

- **Worktrees:** `git worktree list --porcelain` (`leaving.parseWorktrees`), `okDir` only, at most 20, never the home folder or above (the viewer's `tooWide`). Each gets its folder's short name, its branch (or "detached"), and a changed-file count from `git status --porcelain -z --untracked-files=all` run in it, four at a time, 8 s timeout each (a timeout shows no count).
- **Branches:** `git for-each-ref --sort=-committerdate --format=%(refname)%00%(committerdate:unix) refs/heads`, the first 30 checked, each kept when `git rev-list --count <base>..<ref>` > 0. A branch checked out in a listed worktree is left out (it shows under Worktrees). Each gets `ahead` (that count) and `when` (the commit time). When the repo has no main checkout branch to compare with, no branches are listed.
- **Current:** the entry for the handle being viewed is marked.
- **Keys:** main stores the list on the handle and issues each entry an opaque random key. Nothing else from the panel names a place.
- **Cost:** built when the menu opens; a list under 10 s old is reused.

### `viewer:switch(id, key)`

Looks the key up on that handle's stored list only (a key from another handle, or forged, answers `{ ok: false, error }`). Then checks the entry again before opening:

- a worktree must still be in `git worktree list`, pass `okDir`, share the repo's git directory (`changes.sameRepo`) and not be too wide (home folder, above it, a drive root);
- a branch must still resolve.

It opens a new handle (a folder handle carries the old one's `tabId` only when the folder is that tab's own folder) and returns the `open` result. A stale entry answers `{ ok: false, gone: true, error: 'That worktree or branch is gone.' }`.

Preload adds `viewerPlaces` and `viewerSwitch` (the 800-line cap on `preload.js` applies; it stands at 799, so the two names join an existing bridge line).

## The panel

- **Header menu:** `#viewerWhere` becomes a button, "GSDCockpit · master ▾", opening `SB.openMenu` with two labelled groups, Worktrees and Branches. Each row: name, branch, and "N changed" (worktrees) or "N ahead · 2 h ago" (branches); the current one is checked. Arrow keys and Enter work as in other Shellby menus. A non-git folder has no menu (plain text, as today).
- **On a branch:** the header reads "feature-x · branch (from main)". "Just uncommitted" and "Open in editor" are hidden. Refresh re-reads the branch. Changes is the default when the branch changed anything.
- **Switching:** keeps the file you had open when it exists in the new place (on its list or in its tree), else shows the placeholder. `lastFile` is remembered per place.
- **Live state:** the Working / Needs you / Done badge shows when the place is an open conversation's folder (matched by path against `state.tabs`), or a worktree inside one.

## Staying fresh

`staleFor(dir)` matches, besides today's handles whose root contains `dir`:

- folder handles whose root is inside `dir` (an agent's worktree under the conversation's folder);
- branch handles whose root is the repo `dir` belongs to, but only for the turn-end and step-undo forgets, not for each tool result (commits land at turn end; this keeps a busy turn from re-reading branches on every write).

The renderer's 2 s throttle and the hidden-viewer catch-up apply unchanged.

## When things go wrong

| Case | What you see |
|---|---|
| Branch deleted while viewed | "This branch is gone" with Back; the menu still works |
| Worktree removed while viewed | "This folder is gone" (today's screen) |
| A pick that went stale | Toast "That worktree or branch is gone"; the list rebuilds next time it opens |
| git missing or timed out | Changes: "Couldn't read changes" and Retry. The menu: "Couldn't list worktrees" |
| Branch file over 2 MB, binary, or diff over 400 KB | Today's notes, without "Open in editor" |

## Tests

- **node:test, main, real temp repos:** a branch handle's changes since main (committed only), diffs, All files from `ls-tree`, Whole file from `cat-file`; a path not in the tree refused; a blob over the cap and a binary blob; a branch with no shared history compares with the empty tree; a ref deleted mid-view answers `branchGone`; new commits picked up after a refresh; no hook runs and no index is written (a `post-index-change` marker stays absent, `.git/index` mtime unchanged).
- **node:test, places/switch:** worktrees listed (including a hand-made one and one under `.claude/worktrees`), only unmerged branches, no branch listed twice, caps; a forged key, another handle's key and a stale key refused; the home-folder rule on a switch; a branch name starting with `-` can't reach git as an option (refs come from `for-each-ref` and are passed after `--` or as full `refs/heads/...` names).
- **IPC:** only the panel may call `viewer:places`/`viewer:switch`; `test/ipc-surface.test.js` and the preload line cap pass.
- **e2e (`scripts/e2e-viewer.js`):** the script makes an unmerged branch with git; the header menu lists the conversation's copy and that branch (counts from the script's own data); switching to the branch shows its change, its diff and Whole file; switching back returns to the copy; a nudge refreshes a viewer on a worktree inside the conversation's folder.
- Done means `npm run lint`, `npm run typecheck`, `npm test` and `npm run e2e:ci` pass.

## Delivery

On branch `file-viewer`, after the layout fix. `changes/file-viewer.md` gains a bullet. `docs/THREAT-MODEL.md`'s viewer row gains the branch reads (paths only from the commit's own tree, opaque keys). The PR still waits on #27 and Tyler's go-ahead, and this spec is dropped from the branch with the other design notes.

## Out of scope

Remote branches and fetching; the branch's commit list; checking anything out; editing; a cross-project list.
