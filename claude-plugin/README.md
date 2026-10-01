# Shellby plugin for Claude Code

Makes [Shellby](https://github.com/x-salmon/shellby), the pixel hermit crab on your Windows desktop, react to **every** Claude Code session on your PC, not just the ones you start from Shellby:

- **Working:** he scuttles while Claude works in your terminal or editor.
- **Needs permission:** he raises his claw when Claude needs your OK.
- **Turn finished:** he celebrates, and it counts toward his trophies.
- **Subagents:** helper crabs go out for them, labeled with the project.

## Install

In Claude Code:

```
/plugin marketplace add x-salmon/shellby
/plugin install shellby@shellby
```

Then make sure the Shellby app is running (**Settings → Claude Code everywhere** shows your connected sessions).

## Status line

Run `/shellby:statusline` to put Shellby in Claude Code's status line (mood, level, XP and health), for example `🦀💨 Shellby working · Lv 5 Claw Coder ▰▰▰▱▱`. It asks Claude's statusline-setup agent to add it, keeping any status line you already have. You can also turn it on in the Shellby app: **Settings → Claude Code everywhere → Status line**.

## How it works

Each hook runs [`hooks/notify.sh`](hooks/notify.sh), which sends the hook's JSON to Shellby at `http://127.0.0.1:47913`:

- **It stays on your PC.** Requests go only to `127.0.0.1`, on your machine.
- **It never gets in Claude's way.** The script prints nothing and always exits 0, so it can't block or change anything Claude does.
- **It's instant when Shellby is closed.** It checks for a marker file Shellby leaves while it's running, and skips when the file isn't there.
- **Shellby keeps almost nothing.** It reads only the event name, tool name, folder name and session id. Commands and file contents in the payload are dropped unread and never stored.

Requires `bash` and `curl`, which come with Git for Windows (Claude Code on Windows already needs it).
