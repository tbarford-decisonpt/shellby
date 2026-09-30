# Security

Shellby gives an AI agent hands on your PC, so it's built to keep those hands where you can see them.

## Model

- **Claude Code enforces permissions; Shellby only relays your answers.** In every mode except Autonomous, any action Claude Code would prompt for is sent to Shellby as a `can_use_tool` request and blocks until you answer. Shellby never answers on its own. Pending requests are denied if you stop the task or the panel session ends.
- **Autonomous mode** (`bypassPermissions`) is never the default. It requires a one-time explicit acknowledgement, and the UI shows it in red.
- **No credentials are handled by Shellby.** Authentication belongs to the Claude Code CLI. Shellby removes API-key and alternative-provider environment variables before starting it.
- **Renderers are sandboxed.** Both windows run with `sandbox: true`, `contextIsolation: true` and `nodeIntegration: false`, behind a strict CSP (`default-src 'none'`, no inline scripts, no remote content). Navigation and new windows are blocked. The preload script exposes a fixed list of IPC calls, and the main process validates their arguments.
- **Model output is untrusted.** Claude's replies are rendered by a small Markdown renderer that HTML-escapes everything first and only emits a fixed set of tags. Links are inert until clicked, and only `https:` links open (in your browser).
- **Skins are data, not code.** They're JSON, validated against a strict schema (hex colours only, bounded size), and drawn with DOM APIs.
- **Local data only.** History transcripts live in `%APPDATA%\Shellby\sessions`, with tool inputs stripped from saved permission requests. There's no telemetry.

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private vulnerability reporting (Security tab → *Report a vulnerability*). You'll get a reply within a week.
