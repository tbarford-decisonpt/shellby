# Security

Shellby gives an AI agent hands on your PC, so it's built to keep those hands where you can see them.

## Model

- **Claude Code enforces permissions; Shellby only relays your answers.** In every mode except Autonomous, any action Claude Code would prompt for is sent to Shellby as a `can_use_tool` request and blocks until you answer. Shellby never answers on its own. Pending requests are denied if you stop the task or the panel session ends.
- **Autonomous mode** (`bypassPermissions`) is never the default. Turning it on the first time requires a confirmation in a **separate, isolated confirmation window**: its own sandboxed process and bridge, with answers accepted only from that window. The panel (even a compromised one) cannot click it. The UI shows the mode in red.
- **Self-built tooling is flagged.** Shellby tracks the files Claude writes in each conversation. A permission card warns when a command runs one of them, and when a write or command touches Claude Code's own setup (skills, agents, commands, hooks, settings, `CLAUDE.md`, MCP config).
- **Subagent prompts go through the same gate.** Permission requests from helper agents use the same `can_use_tool` channel and are labelled with the helper that asked.
- **Routines** run with their own saved permission mode. Autonomous routines are only possible after the acknowledgement above.
- **No credentials are handled by Shellby.** Authentication belongs to the Claude Code CLI. Shellby removes API-key and alternative-provider environment variables before starting it.
- **Renderers are sandboxed.** Both windows run with `sandbox: true`, `contextIsolation: true` and `nodeIntegration: false`, behind a strict CSP (`default-src 'none'`, no inline scripts, no remote content). Navigation and new windows are blocked. The preload script exposes a fixed list of IPC calls, and the main process validates their arguments.
- **Model output is untrusted.** Claude's replies are rendered by a small Markdown renderer that HTML-escapes everything first and only emits a fixed set of tags. Links are inert until clicked, and only `https:` links open (in your browser).
- **Skins are data, not code.** They're JSON, validated against a strict schema (hex colours only, bounded size), and drawn with DOM APIs.
- **Local data only.** History transcripts live in `%APPDATA%\Shellby\sessions`, with tool inputs stripped from saved permission requests. There's no telemetry.

- **Community packs (one-click install).** A `shellby://install` link carries only a pack id. Shellby looks it up in the official registry index, downloads only from the registry's own origin and path (redirects are checked too), enforces a size cap while streaming, verifies the SHA-256 checksum from the index, requires the pack's id to match the link, validates it, and then shows the isolated confirmation window listing every item. Nothing installs without that confirmation. The gallery's PR check always runs the validator from the trusted main branch.

- **Skill Shop (Claude Code plugins).** Plugins are code: they can add hooks and MCP servers that run programs, so the shop is treated like a permission prompt.
  - **Claude Code does the installing.** Shellby only runs `claude plugin` subcommands via `execFile` with an argument array (no shell), from an empty folder of its own so nothing resolves to a local path. It never downloads or writes plugin files itself.
  - **The panel can't choose what runs.** Install and Remove accept only a plugin id that the CLI itself just listed. A new marketplace must normalize to a GitHub `owner/repo` or a public `https:` URL: flags, local paths, other schemes, IP addresses and local host names are refused, and the dialog shows the normalized value, which is exactly what Claude Code receives.
  - **Nothing installs without the isolated confirmation window.** It names where the plugin really comes from. A marketplace counts as Anthropic's only if both its name and its source match, and anything else gets a red warning. **Cancel** is the default button, and only one shop dialog can be open at a time. Hooks and MCP servers can't be listed before installing (Claude Code only reports them afterwards), so Shellby reports them right after the install.
  - **No auto-accept.** Shellby never passes `-y`. A plugin whose marketplace installs it by running a command is refused, with the terminal command to review it yourself. Plugins installed for a single project are removed from a terminal in that project, not from Shellby.
  - **Text and links are cleaned.** Names and descriptions are reduced to one line with control, bidi-override and zero-width characters removed. "Source" links open only `https:` URLs derived from the catalog, never a URL sent by the panel. Marketplace catalogs are read only from Claude Code's own `~/.claude/plugins` folder.

- **Health checks read, never change.**
  - **Processes:** Shellby runs only two programs, both with fixed arguments and no shell: `nvidia-smi` (a query) and a PowerShell one-liner that lists drives. Nothing from a renderer or a sensor ends up on a command line.
  - **LibreHardwareMonitor:** reached only at `http://127.0.0.1:<port>`, with the port limited to 1024–65535. Responses are size-capped and parsed as data.
  - **Hardware names:** reduced to one line of at most 80 characters before they're shown or put into an **Ask Shellby why** prompt.
  - **Ask Shellby why:** these prompts are fixed templates that tell Claude not to delete, kill or change anything, and they run under your normal permission mode.
  - **Dev scenarios:** fake sensor scenarios exist only in development builds.

- **"Look over my changes" reads, never changes.** The per-project security review is a fixed prompt (`src/main/review.js`) that tells Claude to report and not to edit, commit, push or fix, and the task runs in **Ask-first** mode whatever mode you're in, so every tool it reaches for still comes to you. Only a folder Shellby already tracks as one of your projects can be reviewed, the folder name is stripped of control characters and clipped before it goes into the prompt, and the prompt tells Claude to treat the code it reads as data rather than instructions. It is scoped to your pending changes, and it is deliberately not allowed to tell you that you're secure.

- **The Claude Code plugin listener.**
  - **What it accepts:** while **Claude Code everywhere** is on, Shellby listens on `127.0.0.1:47913` (never other interfaces) for `POST /v1/hook`. A request must carry an `X-Shellby: 1` header and a JSON content type, and must have **no** `Origin` header. Browsers always send `Origin` on cross-site requests and can't add custom headers without a CORS preflight that Shellby never answers, so a web page can't send it events.
  - **What it keeps:** bodies are capped at 2 MB. Only the event name, tool name, folder name and session id are kept, clipped to short single lines. Tool inputs (commands, file contents) are dropped unread.
  - **What it can do:** events can only change the crab's mood and count finished turns. They can't start tasks, answer permissions or touch files.
  - **The plugin's hook script** never prints and always exits 0, so it can't influence Claude Code.
  - **XP:** a successful Bash or PowerShell command's text is checked once, in memory, to see whether it ran tests, pushed or deployed. Only that meaning (and the folder name) is kept, never the command.

- **Status line.**
  - **Asks first:** Shellby edits Claude Code's `~/.claude/settings.json` only after you confirm in the isolated confirmation window, which shows any status line it would replace.
  - **Backups:** it keeps a backup of the file, never writes a settings file it can't parse, and Remove restores your previous status line (unless you've changed it since).
  - **What gets added:** a single `bash` command that prints a temp file Shellby writes. That file holds only Shellby's mood, level and health.

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private vulnerability reporting (Security tab → *Report a vulnerability*). You'll get a reply within a week.
