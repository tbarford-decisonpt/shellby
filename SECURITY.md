<div align="center">

<img src="docs/critter-asking.png" width="180" alt="Shellby, a pixel hermit crab with a teal shell, with a speech bubble holding a question mark: he's asking before he acts">

# Security

**Shellby gives an AI agent hands on your PC,<br>so it's built to keep those hands where you can see them.**

[Report a vulnerability](#-reporting-a-vulnerability) · [At a glance](#-at-a-glance) · [Know the limits](#-know-the-limits) · [Privacy policy](PRIVACY.md)

</div>

> [!IMPORTANT]
> **Found a security problem? Please don't open a public issue.**
> Use GitHub's private reporting: **[Report a vulnerability →](https://github.com/x-salmon/shellby/security/advisories/new)**. You'll get a reply within a week.

---

## 👀 At a glance

| | Promise | In short |
|---|---|---|
| 🙋 | **Shellby never answers for you** | In every mode except Autonomous, Claude Code enforces the permissions and waits for your answer. Shellby only relays it. |
| 🪟 | **Going further needs a separate window** | Anything that would mean fewer prompts, or answers from somewhere else, goes through an isolated confirmation window that even a compromised panel can't click. |
| 🔴 | **Autonomous is never the default** | It needs the confirmation window the first time, asks again once each time Shellby starts, and shows in red. |
| 📦 | **Every window is sandboxed** | A strict CSP with no remote content and no inline scripts. Each window gets a fixed list of IPC calls, and the main process validates them and checks which window is calling. |
| 🧾 | **Untrusted text is escaped or cleaned** | Claude's replies are HTML-escaped, friends' crabs and plugin names are cleaned, and workflow values never become code. |
| 🏠 | **Local data, no telemetry** | History transcripts live in `%APPDATA%\Shellby\sessions`. The online features you can turn on are listed in the [privacy policy](PRIVACY.md). |

**Contents:** [Permissions](#-permissions) · [The app itself](#-the-app-itself) · [Unattended work](#-unattended-work) · [Your credentials](#-your-credentials) · [Online features](#-online-features) · [Things that touch your PC](#-things-that-touch-your-pc) · [Plugin listener](#-the-claude-code-plugin-listener)

---

## 🙋 Permissions

**Claude Code enforces permissions; Shellby only relays your answers.** In every mode except Autonomous, any action Claude Code would prompt for is sent to Shellby as a `can_use_tool` request and blocks until you answer. Shellby never answers on its own. Pending requests are denied if you stop the task or the panel session ends.

- **The panel answers; the confirmation window guards the rest.** Permission cards are answered in the panel, so the panel can allow what Claude asks for. Anything that would go further (fewer prompts, or answers from somewhere else) goes through a **separate, isolated confirmation window** instead. That window has:
  - its own sandboxed process and bridge
  - answers accepted only from that window
  - **Cancel** as the default
  - one at a time: a stack of them is refused, not queued

  The panel, even a compromised one, cannot click it.
- **Autonomous mode** (`bypassPermissions`) is never the default. Turning it on the first time needs the confirmation window, and switching into it asks again once each time Shellby starts. The UI shows the mode in red.
- **`!` commands** (a message starting with `!` runs in PowerShell, as you) are confirmed in the window the first time. After that they are yours to use, like a terminal. PowerShell is started by its full path in System32, never by a name a project folder could shadow.
- **Self-built tooling is flagged.** Shellby tracks the files Claude writes in each conversation. A permission card warns when a command runs one of them, and when a write or command touches Claude Code's own setup (skills, agents, commands, hooks, settings, `CLAUDE.md`, MCP config).
- **Subagent prompts go through the same gate.** Permission requests from helper agents use the same `can_use_tool` channel and are labelled with the helper that asked.

## 📦 The app itself

- **Renderers are sandboxed.** Every window runs with `sandbox: true`, `contextIsolation: true` and `nodeIntegration: false`, behind a strict CSP (`default-src 'none'`, no inline scripts, no remote content).
  - Navigation, new windows and browser permissions (camera, microphone and the rest) are refused.
  - Each window's preload exposes a fixed list of IPC calls, the main process validates their arguments, and every handler checks which window is calling.
  - The crab's window, which draws friends' visiting crabs and stickers, has a bridge of its own that can only move him and take a file drop.
  - Paths a renderer hands over are never opened on a network share, so nothing makes Windows sign in to another machine.
- **Model output is untrusted.** Claude's replies are rendered by a small Markdown renderer that HTML-escapes everything first and only emits a fixed set of tags. Links are inert until clicked, only `https:` links open (in your browser), and hovering one shows where it really goes, whatever its text says.
- **Skins are data, not code.** They're JSON, validated against a strict schema (hex colours only, bounded size), and drawn with DOM APIs.
- **Local data only.** History transcripts live in `%APPDATA%\Shellby\sessions`, with tool inputs stripped from saved permission requests. There's no telemetry.

## 🕒 Unattended work

### Workflows

Workflows run unattended, with every step's permission mode fixed when you save it.

> [!NOTE]
> **Saving a workflow that can act without asking** shows the confirmation window. That covers a command, a web request, a file write, or a Claude step in Smart, Auto-edit or Autonomous. The window lists every such command, prompt, address, header name, body and file in full. It asks again whenever any of them, its folder or its triggers change.
>
> **A workflow Claude proposes** is always confirmed and can't use Autonomous. If it's too long to show in full, it's refused outright rather than shown shortened.

**Outside data stays data.** Values from a trigger, a web response, a file or an earlier step never become code:

| Step | How outside values get in |
|---|---|
| `run` | Each `{{ value }}` is passed to PowerShell as an environment variable (`${env:SHELLBY_VALUE_1}`), never in the command's text. |
| Claude | Values arrive inside «», with a line saying they're data, not instructions. |
| Web request | Values are encoded after the base address, and a value that changed the host is refused. |
| File path | A value that would leave its folder is refused. |

**Secrets** (Automate → Secrets):

- are encrypted by Windows and never sent back to the panel
- are only allowed in commands and web requests, never in prompts, messages or files
- reach commands through the environment rather than the command line
- are blanked out of everything a run records

Redirects to another site drop a request's headers, and https never redirects down to http.

**Limits:**

| Runs at once | Steps per run | Items per loop | Workflow calls deep | Paused after |
|:---:|:---:|:---:|:---:|:---:|
| 4 | 1000 | 100 | 3 | a workflow starts more than 60 times in an hour |

A folder trigger watches only the top level of its folder.

### Routines

Routines run unattended with their own saved permission mode. Saving one that doesn't ask first (Smart, Auto-edit or Autonomous) is confirmed in the window whenever its prompt, folder or mode changes. Autonomous routines are only possible after you've [turned Autonomous on in the confirmation window](#-permissions).

## 🔑 Your credentials

- **Claude's sign-in is Claude Code's.** Shellby never sees your Claude credentials. Claude Code gets the environment as it is on your PC, API keys and provider switches included. **Always use my Claude plan** (Settings → Claude) leaves out `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and the Bedrock, Vertex and Foundry switches, so it always runs on your plan.
- **Your GitHub token, if you let Claude use it.** Shellby keeps its GitHub sign-in encrypted by Windows. If you turn on **Let Claude tasks push code and open pull requests** (Settings → GitHub), that token goes into Claude Code's environment as `GH_TOKEN` and `GITHUB_PERSONAL_ACCESS_TOKEN`, so `gh`, `git` and GitHub MCP servers work.

> [!WARNING]
> With **Let Claude tasks push** on, anything Claude runs can read your GitHub token. It is off unless you turn it on.

## 🌐 Online features

### Phone notifications

Notifications go only where you confirmed.

- A new destination (provider, topic or chat, token), or turning on Allow/Deny answers from the phone, is confirmed in the confirmation window. Nothing is sent to a destination you haven't confirmed.
- A random ntfy topic Shellby makes up for you, with answers off, needs no question.
- Answers from the phone use single-use codes, and prompts the card would warn about can only be answered at the desk.
- Plain `http:` is only used for this PC and private network addresses.

### Visiting crabs (friends' calling cards)

**Off by default** and never granted by a first sign-in. It's turned on only through the confirmation window, because it publishes a public gist.

- **What you publish:** the card holds only your crab's look and level, under your GitHub username. Turning it off or signing out deletes the card.
- **What you receive is untrusted.** Friends' cards and gist comments come from other people, so:
  - a card counts only if GitHub says the gist belongs to that friend
  - every field is cleaned to known keys and lengths before it reaches a window
  - item keys are only looked up in your own catalog, so a card can't carry pixels or markup
  - waves are a marker for one of a few fixed lines, and only friends you added are delivered, so nobody can choose what your crab says

### Community packs (one-click install)

A `shellby://install` link carries only a pack id. Before anything installs, Shellby:

1. looks the id up in the official registry index
2. downloads only from the registry's own origin and path (redirects are checked too)
3. enforces a size cap while streaming
4. verifies the SHA-256 checksum from the index
5. requires the pack's id to match the link, and validates it
6. shows the isolated confirmation window listing every item

Nothing installs without that confirmation. The gallery's PR check always runs the validator from the trusted main branch.

### Skill Shop (Claude Code plugins)

> [!CAUTION]
> Plugins are code: they can add hooks and MCP servers that run programs. The shop is treated like a permission prompt.

- **Claude Code does the installing.** Shellby only runs `claude plugin` subcommands via `execFile` with an argument array (no shell), from an empty folder of its own so nothing resolves to a local path. It never downloads or writes plugin files itself.
- **The panel can't choose what runs.** Install and Remove accept only a plugin id that the CLI itself just listed. A new marketplace must normalize to a GitHub `owner/repo` or a public `https:` URL. Flags, local paths, other schemes, IP addresses and local host names are refused. The dialog shows the normalized value, which is exactly what Claude Code receives.
- **Nothing installs without the isolated confirmation window.** It names where the plugin really comes from. A marketplace counts as Anthropic's only if both its name and its source match, and anything else gets a red warning. **Cancel** is the default button, and only one shop dialog can be open at a time. Hooks and MCP servers can't be listed before installing (Claude Code only reports them afterwards), so Shellby reports them right after the install.
- **No auto-accept.** Shellby never passes `-y`. A plugin whose marketplace installs it by running a command is refused, with the terminal command to review it yourself. Plugins installed for a single project are removed from a terminal in that project, not from Shellby.
- **Text and links are cleaned.** Names and descriptions are reduced to one line with control, bidi-override and zero-width characters removed. "Source" links open only `https:` URLs derived from the catalog, never a URL sent by the panel. Marketplace catalogs are read only from Claude Code's own `~/.claude/plugins` folder.

## 💻 Things that touch your PC

### Git worktrees: copies don't run your repository's hooks

When a conversation works in its own copy (a git worktree), **Bring home** commits and merges Claude's work with git hooks turned off. That's because Claude can edit a tracked hook (`.husky/pre-commit`, say) without a prompt in Auto-edit. **Push** is yours and runs your hooks as a terminal would.

### "Look over my changes" reads, never changes

- The per-project security review is a fixed prompt (`src/main/review.js`) that tells Claude to report and not to edit, commit, push or fix.
- The task runs in **Ask-first** mode whatever mode you're in, so every tool it reaches for still comes to you.
- Only a folder Shellby already tracks as one of your projects can be reviewed. The folder name is stripped of control characters and clipped before it goes into the prompt, and the prompt tells Claude to treat the code it reads as data rather than instructions.
- It's scoped to your pending changes, and it is deliberately not allowed to tell you that you're secure.

### Health checks read, never change

| What | How it's kept safe |
|---|---|
| **Processes** | Shellby runs only two programs, both with fixed arguments and no shell: `nvidia-smi` (a query) and a PowerShell one-liner that lists drives. Nothing from a renderer or a sensor ends up on a command line. |
| **LibreHardwareMonitor** | Reached only at `http://127.0.0.1:<port>`, with the port limited to 1024–65535. Responses are size-capped and parsed as data. |
| **Hardware names** | Reduced to one line of at most 80 characters before they're shown or put into an **Ask Shellby why** prompt. |
| **Ask Shellby why** | Fixed templates that tell Claude not to delete, kill or change anything, run under your normal permission mode. |
| **Dev scenarios** | Fake sensor scenarios exist only in development builds. |

### Status line

- **Asks first:** Shellby edits Claude Code's `~/.claude/settings.json` only after you confirm in the isolated confirmation window, which shows any status line it would replace.
- **Backups:** it keeps a backup of the file, never writes a settings file it can't parse, and Remove restores your previous status line (unless you've changed it since).
- **What gets added:** a single `bash` command that prints a temp file Shellby writes. That file holds only Shellby's mood, level and health.

## 🔌 The Claude Code plugin listener

While **Claude Code everywhere** is on, Shellby listens on **`127.0.0.1:47913`** (never other interfaces) on four routes.

**What it accepts.** Every request must have:

- ✅ an `X-Shellby: 1` header
- ✅ a JSON content type
- ✅ a `Host` of `127.0.0.1` or `localhost`
- ❌ **no** `Origin` header

Browsers always send `Origin` on cross-site requests and can't add custom headers without a CORS preflight that Shellby never answers. A page that rebinds its own name to this PC still sends that name as `Host`. So a web page can't reach it.

**What it keeps.** Bodies are capped at 2 MB while they arrive. From hooks, only the event name, tool name, folder name and session id are kept, clipped to short single lines. Tool inputs (commands, file contents) are dropped unread.

| Route | Used by | What it can do |
|---|---|---|
| `/v1/hook` | The plugin's hooks | Events change the crab's mood, count finished turns and XP, note the project for streaks and stickers, and can send "he needs you" and "done" to your phone if you set that up. They **can't** start tasks, answer permissions or change files. The only git Shellby runs for them reads, with `core.fsmonitor` off, so a repository's own config can't name a program to run. |
| `/v1/crab` | The plugin's MCP tools | Claude can make the crab say something, put on something you own, propose a routine or a workflow, list your workflows, and start a workflow you gave the **Claude Code** trigger. A proposal is only saved after you confirm it in the confirmation window, and Autonomous is never accepted from it. |
| `/v1/cli` | The `shellby` command, if you install it | `shellby do` starts a task in any mode except Autonomous, and `shellby flow run` starts a workflow you gave the **Claude Code** trigger. It needs a token Shellby keeps in its own profile folder. |
| `/v1/flow` | Workflow web hooks | Starts the one workflow whose **Web hook** trigger holds the 48-character token in the body, compared in constant time. No token, no run. The posted `data` is treated like any other [outside data in a run](#workflows). |

- **The plugin's hook script** never prints and always exits 0, so it can't influence Claude Code.
- **XP:** a successful Bash or PowerShell command's text is checked once, in memory, to see whether it ran tests, pushed or deployed. Only that meaning (and the folder name) is kept, never the command.

## 🚧 Know the limits

What these protections don't cover:

- **Other programs running as you.** Any program running as you on this PC can reach the plugin listener, as with any local port, and that includes reading the `shellby` command's token. The listener keeps out browsers and other machines, not your own programs. Another program holding the port before Shellby starts would get what the plugin's hooks send; Shellby shows the port as busy when that happens.
- **Autonomous mode** (`bypassPermissions`) skips the permission prompts above. It's never the default and has to be confirmed in the confirmation window.
- **A GitHub token handed to Claude is readable by whatever Claude runs**, if you turn on **Let Claude tasks push**.
- **Plugins you install are code**, with whatever hooks and MCP servers they bring.

## 📬 Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private vulnerability reporting: the **Security** tab → **[Report a vulnerability](https://github.com/x-salmon/shellby/security/advisories/new)**. You'll get a reply within a week.
