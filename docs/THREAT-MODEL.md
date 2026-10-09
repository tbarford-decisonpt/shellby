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
| Model output → screen | Markup or script injection | Escape everything, emit a fixed tag set, links are inert until clicked, `https:` only | `src/renderer/shared/markdown.js`, `src/main/filelinks.js` |
| Renderer → main | A window calling what it shouldn't | Each window's preload exposes a fixed list, and every handler checks the sender | `src/preload/`, `src/main/ipc-guard.js`, `src/main/ipc/` |
| Panel → riskier settings | A compromised panel lowering protections | Isolated confirmation window, Cancel by default, one at a time | `src/main/confirm.js` |
| Claude → your machine | Acting without an Allow | Claude Code enforces permissions, and Shellby only relays answers and denies pending prompts on stop | `src/main/session.js`, `src/main/stream.js` |
| Claude → its own setup | Writing hooks, skills or settings that run later | Permission cards flag self-built tooling and edits to Claude Code's config | `src/main/session.js` |
| Repository → Shellby | Hooks or git config running programs | Bring home merges with hooks off, and reads run with `core.fsmonitor` off | `src/main/branch.js`, `src/main/gitinfo.js` |
| Web → plugin listener | DNS rebinding, CSRF | Loopback only, `X-Shellby` header, JSON only, no `Origin`, `Host` check, 2 MB cap | `src/main/external.js` |
| Packs → install | Swapped or oversized downloads | Registry lookup, origin-pinned download, size cap, SHA-256, id match, confirmation | `src/main/registry.js` |
| Plugins → install | Malicious marketplace | Only CLI-listed ids, normalized sources, no `-y`, confirmation window | `src/main/marketplace.js` |
| Workflows → commands | Outside data turning into code | Values passed as environment variables, never spliced into command text, plus host and path checks | `src/main/workflows/` |
| Secrets → output | Tokens leaking into logs or prompts | Encrypted by Windows, kept out of prompts, redacted from run logs | `src/main/secret-gate.js` |
| Phone → tasks | Stolen token starting work | Off by default, sender-bound, Ask first only, rate limits, no `!` or `/` | `src/main/phone-tasks.js` |
| Billing | Silently using an API key | **Always use my Claude plan** strips provider variables | `src/main/clipath.js`, `src/main/handoff.js` |

## When you change something here

Changes that touch a row above need a test and a note in the PR
([CONTRIBUTING.md](../CONTRIBUTING.md#guidelines)). If you add a new way in
(a new port, a new IPC channel, a new kind of download, a new place where outside text
reaches a prompt or a shell), add a row to this table in the same PR.
