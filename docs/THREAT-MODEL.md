# Threat model

Shellby gives an AI agent hands on your PC. This page is the map behind
[SECURITY.md](../SECURITY.md): what's worth protecting, who might go after it,
where the trust boundaries are, and the code that holds each one. SECURITY.md
has the full detail for each feature; this page links the pieces together so
a reviewer knows where to look.

Found a hole? [Report it privately](https://github.com/x-salmon/shellby/security/advisories/new).

## What's worth protecting

| Asset | Why it matters |
|---|---|
| Your files and repositories | Claude Code can read, edit and run things in them. |
| Your permission answers | An Allow that you didn't give is the same as giving Claude your keyboard. |
| Your Claude plan and billing | Shellby must never quietly move work onto an API key. |
| Tokens Shellby keeps | GitHub sign-in, phone notification tokens, workflow secrets and the `shellby` CLI token. |
| Your machine's state | Startup apps, processes and Claude Code's own `~/.claude` setup. |

## Who might attack it

| Actor | What they control | What they want |
|---|---|---|
| **Model output** | Anything Claude writes: replies, file contents, commands it proposes | To get rendered as code, to run without an Allow, or to change Claude's own setup for next time |
| **A repository you open** | Its files, git config, hooks and `CLAUDE.md` | To run a program when Shellby reads or merges it |
| **Web pages** | Requests from your browser | To reach the local plugin listener |
| **Other people's content** | Friends' calling cards, community packs, plugin marketplaces | To get pixels, markup or code onto your PC |
| **Someone with your phone token** | Your Telegram bot or ntfy topic | To start tasks remotely |
| **A compromised renderer** | One window's JavaScript | To reach IPC it shouldn't, or click its own confirmations |

Out of scope: other programs already running as you (they can reach any local
port and read your profile, see [Know the limits](../SECURITY.md#-know-the-limits)),
and Autonomous mode, which skips prompts by design.

## Trust boundaries

```
 ┌──────────────── untrusted ─────────────────┐
 │ model output · repos · web · friends · packs │
 └───────────────────┬─────────────────────────┘
                     │
 ┌───────────────────▼───────────────────┐   ┌─────────────────────┐
 │ Renderer windows (sandboxed, CSP)     │   │ Confirmation window │
 │ panel · crab · notes · toys           │   │ (own process+bridge)│
 └───────────────────┬───────────────────┘   └──────────┬──────────┘
          preload bridge + ipc-guard                    │ confirm.js
 ┌───────────────────▼─────────────────────────────────▼──────────┐
 │ Main process: validates every argument, checks the sender      │
 └───────┬──────────────────────┬─────────────────────┬───────────┘
         │ stdin/stdout JSON     │ 127.0.0.1:47913     │ execFile, no shell
 ┌───────▼────────┐    ┌─────────▼─────────┐   ┌───────▼──────────────┐
 │ Claude Code CLI│    │ Plugin listener   │   │ git, PowerShell, etc │
 │ (enforces perms)│   │ (hooks, MCP, CLI) │   │                      │
 └────────────────┘    └───────────────────┘   └──────────────────────┘
```

## Where each boundary is held

| Boundary | Threat | Mitigation | Code |
|---|---|---|---|
| Model output → screen | Markup or script injection | Escape everything, emit a fixed tag set, links are inert until clicked, `https:` only. Code colours and Mermaid diagrams are built after that from the escaped text: spans and SVG made with `textContent` and `createElementNS`, attributes only numbers and fixed words, no inline style, so the CSP stays `style-src 'self'` | `src/renderer/shared/markdown.js`, `src/renderer/shared/syntax.js`, `src/renderer/shared/mermaid.js`, `src/renderer/shared/mermaid-draw.js`, `src/renderer/panel/code.js`, `src/main/filelinks.js` |
| Check output → prompt | A project's tool output steering Claude when Problems' **Fix it** quotes it | Main writes the message from the problems it noted, never from panel text; each problem is fenced in `<problems>` with `<`/`>` and invisible characters neutralised, and labelled as output, not instructions | `src/main/problems.js`, `src/main/ipc/tabs.js` |
| Renderer → main | A window calling what it shouldn't | Each window's preload exposes a fixed list, and every handler checks the sender | `src/preload/`, `src/main/ipc-guard.js`, `src/main/ipc/` |
| Renderer → main file read | The panel reading files outside the folder it was shown, aiming git at another repo, reaching a UNC network path, being handed the whole home folder, a browsed repo running its own programs, or a branch name read by git as an option | The panel opens a handle on a conversation id or on a local worktree that `git worktree list` reports and that shares the project's git directory, never on a UNC path; a folder (or the repo root it belongs to) that is the home folder, a folder above it or a whole drive is refused, so a conversation left in `~` or a dotfiles repo at `~` never hands over `.ssh` or `.claude`; paths with a drive, a stream, a network or rooted start, or `..` are refused before the disk is touched, then links and 8.3 names are resolved and the file opened is checked to be the one inside; outside and missing answer alike; diffs only for files on that handle's own changes list; 2 MB cap, binary refused. The header's menu lists the repo's local worktrees (none too wide to browse, and only folders that share the repo's git common dir, so a hand-made `.git/worktrees` record can't send `git status` into another repo or the home folder) and its unmerged local branches under random keys main keeps on that handle; the list is built once per repo at a time and its git runs share one limit of four; a pick names only a key and is checked again before it opens (still listed, same git directory, not too wide; a branch still resolves). A branch is read from git alone (`rev-parse`, `merge-base`, `diff`, `ls-tree`, `cat-file`) with full `refs/heads/` names, and a folder's base reaches `merge-base` as `refs/heads/<base>`, so no ref reaches git as an option; Whole file only for a path in the commit's own tree; nothing is checked out, no index written, no hook run. Every viewer git call that reads an object, the `changes.js` snapshot and diffs it asks for included, runs with lazy fetch off and no transport (`GIT_NO_LAZY_FETCH=1`, `-c protocol.allow=never`): a repo whose config says it is a partial clone can't make git run the program it names (`core.sshCommand`, an `ext::` url) or write a pack, and a missing object reads as "Couldn't read changes." or "Couldn't read that."; Claude's own turn snapshots still fetch as before. The file tree's `viewer:status` reads a folder handle only, with fixed arguments (`status --porcelain=v1 -b -z`, `rev-list --parents -n 1 HEAD`, `diff-index -M --numstat -z HEAD`, `diff-index --cached --name-only -z`, `diff-tree --name-only` between two commits it just read, and `--literal-pathspecs ls-files --others --exclude-standard -z` over the folders git lists whole, at most 50, their names from git's own status: plumbing throughout, since porcelain `git diff` refreshes and rewrites the index whatever `GIT_OPTIONAL_LOCKS` says) and optional locks off (`GIT_OPTIONAL_LOCKS=0`), so it never writes the index, never takes its lock from a turn's snapshot and never runs a `post-index-change` hook; a failure answers "Couldn't read git status.", never git's words. The file picked in the tree reaches main as a path relative to the conversation's repo with the next message; main checks it by name first (no drive, stream, network or rooted start, no `..`, inside the root) and only then resolves links and checks it is a file still there, not in a folder too wide to browse. The name is the repo's own text inside a line Claude takes as Shellby's, so one with a control, format (bidi) or separator character, or over 300 characters, is refused, and the rest goes in quotes a Windows name can't break out of; nothing is read from the file, and a `/command` never carries the line. Its snapshots run `git add` into a temporary index with hooks pointed at an empty folder; clean filters (git-lfs) still run, as they do for status reads and the menu's per-worktree `git status` counts | `src/main/viewer.js`, `src/main/ipc/viewer.js`, `src/main/changes.js`, `src/main/viewer-status.js`, `src/main/ipc/tabs.js` |
| Panel → riskier settings | A compromised panel lowering protections | Isolated confirmation window, Cancel by default, one at a time | `src/main/confirm.js` |
| Claude → your machine | Acting without an Allow | Claude Code enforces permissions, and Shellby only relays answers and denies pending prompts on stop | `src/main/session/`, `src/main/stream.js` |
| Claude → its own setup | Writing hooks, skills or settings that run later | Permission cards flag self-built tooling and edits to Claude Code's config | `src/main/session/` |
| Repository → Shellby | Hooks or git config running programs | Bring home merges with hooks off, and reads run with `core.fsmonitor` off | `src/main/branch.js`, `src/main/gitinfo.js` |
| Web → plugin listener | DNS rebinding, CSRF | Loopback only, `X-Shellby` header, JSON only, no `Origin`, `Host` check, 2 MB cap | `src/main/external.js` |
| Web → OBS overlay | A request reading files it shouldn't | Off by default, loopback only, GET only, every URL from a fixed table built at startup (nothing in a request becomes a path), 8 clients at most | `src/main/obs.js` |
| Web → Stream Deck keys | A web page pressing Allow | Off by default, loopback only, a token Shellby packs into the plugin on every request, no `Origin`, `Host` check, 1 KB bodies; Allow and Deny only, and flagged prompts are never answered from a key | `src/main/deck.js` |
| Web → Debug mode's receiver | Planted lines steering Claude | Open only while a conversation is in Debug mode, on a port Windows picks; answers only `/debug/<32 hex>` addresses it handed out, `Host` must be `127.0.0.1` or `localhost`, 16 KB bodies; lines are shown redacted and go to Claude fenced as output only after you press Send | `src/main/debug-ingest.js`, `src/main/wiring/debug-mode.js` |
| Packs → install | Swapped or oversized downloads | Registry lookup, origin-pinned download, size cap, SHA-256, id match, confirmation | `src/main/registry.js` |
| Plugins → install | Malicious marketplace | Only CLI-listed ids, normalized sources, no `-y`, confirmation window | `src/main/marketplace.js` |
| Workflows → commands | Outside data turning into code | Values passed as environment variables, never spliced into command text, plus host and path checks | `src/main/workflows/` |
| Secrets → output | Tokens leaking into logs or prompts | Encrypted by Windows, kept out of prompts, redacted from run logs | `src/main/secret-gate.js` |
| Phone → tasks | Stolen token starting work | Off by default, sender-bound, Ask first only, rate limits, no `!` or `/` | `src/main/channels/phone-tasks.js` |
| Billing | Silently using an API key | **Always use my Claude plan** strips provider variables | `src/main/clipath.js`, `src/main/handoff.js` |

## When you change something here

Changes that touch a row above need a test and a note in the PR
([CONTRIBUTING.md](../CONTRIBUTING.md#guidelines)). If you add a new way in
(a new port, a new IPC channel, a new kind of download, a new place where outside text
reaches a prompt or a shell), add a row to this table in the same PR.
