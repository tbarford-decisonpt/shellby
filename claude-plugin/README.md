# Shellby plugin for Claude Code

Makes [Shellby](https://github.com/x-salmon/shellby), the pixel hermit crab on your Windows desktop, react to **every** Claude Code session on your PC, not just the ones you start from Shellby:

- **Working:** he scuttles while Claude works in your terminal or editor.
- **Needs permission:** he raises his claw when Claude needs your OK.
- **Turn finished:** he celebrates, and it counts toward his trophies.
- **Subagents:** helper crabs go out for them, labeled with the project.
- **Routines:** ask Claude to do something on a schedule ("every Friday at 5, tidy my Downloads") and it sets up a Shellby routine with the `add_routine` tool. Shellby shows you the whole routine and only saves it if you say yes.
- **Workflows:** ask Claude for something with several steps or another trigger ("when CI fails on my repo, have Claude look and notify me") and it proposes a Shellby workflow with `add_workflow`. You see everything it would do in a confirmation window and approve it there. Claude can also start the workflows you've given the **Claude Code** trigger.

## MCP tools

| Tool | What it does |
|---|---|
| `say` | A short line in Shellby's speech bubble. |
| `celebrate` | Confetti and a little dance. |
| `wear` | Puts on an accessory you've unlocked. |
| `status` | The crab's level and what he's up to, plus CPU/GPU/memory/disk if Health is on. |
| `add_routine` / `list_routines` | Proposes a scheduled Claude Code task (you confirm it) / lists your routines. |
| `add_workflow` / `list_workflows` | Proposes a workflow (you confirm it) / lists your workflows and which ones Claude may run. |
| `run_workflow` | Starts a workflow that has the **Claude Code** trigger, with its inputs. Returns once it has started. |
| `projects` | The projects on Shellby's Projects page: where each is, servers running, and what needs attention. |
| `next_up` | "What's next on this repo?": crashed servers, failing CI and serious vulnerabilities, then your to-dos, then housekeeping. Defaults to the repo Claude Code is in; `everywhere` covers every project. |
| `server_log` | The last lines a dev server printed (the one that crashed, else the one running), secrets redacted. Read-only: it can't start or stop one. |
| `add_task` / `finish_task` | Adds a note to the project's to-do list / ticks one off by its id or number. You see the list on the project's page. |
| `journal` | The project's handoff notes from earlier sessions (what's half-done, what was decided, what's next), or `pin` to leave one for the next session. |

Claude Code mods can call `say`, `celebrate`, `wear` and `status` too, with `$.mcp.call('plugin:shellby:shellby', …)`: see [Making Shellby react from a mod](../docs/MODS.md).

The same workflows can be listed and started from a terminal with `shellby flow list` and `shellby flow run <name> [key=value ...]`. `shellby projects` and `shellby next` (with `next add` and `next done`) give the project answers in a terminal too.

## Install

In Claude Code:

```
/plugin marketplace add x-salmon/shellby
/plugin install shellby@shellby
```

Then make sure the Shellby app is running (**Settings → Claude Code everywhere** shows your connected sessions).

## Status line

Run `/shellby:statusline` to put Shellby in Claude Code's status line (mood, level, XP and health), for example `🦀💨 Shellby working · Lv 5 Claw Coder ▰▰▰▱▱`. It asks Claude's statusline-setup agent to add it, keeping any status line you already have. You can also turn it on in the Shellby app: **Settings → Claude Code everywhere → Status line**.

## Where did we leave off?

When a session ends, Shellby writes a short handoff note for its project: what was asked, what's half-done, what was decided, the files it touched and where git stood. It reads the note out of Claude Code's own record of the session, never by asking Claude, so keeping the journal costs no tokens. Run `/shellby:leftoff` and Claude answers from those notes in one small tool call instead of re-reading the project. The notes are also on the project's page in Shellby, where **Carry on with Claude** starts a conversation with them in the prompt.

## Handing a session to Shellby

Run `/shellby:handoff` to carry the conversation you're in on in a Shellby tab. It runs `shellby take`, which needs the `shellby` command (**Settings → Claude Code everywhere → the shellby command**). Type `/exit` in the terminal before you send anything in Shellby: two copies of one conversation trip over each other. Going the other way, **Continue in a terminal** on a Shellby tab opens it here with `claude --resume`.

## How it works

Each hook runs [`hooks/notify.sh`](hooks/notify.sh), which sends the hook's JSON to Shellby at `http://127.0.0.1:47913`:

- **It stays on your PC.** Requests go only to `127.0.0.1`, on your machine.
- **It never gets in Claude's way.** The script prints nothing and always exits 0, so it can't block or change anything Claude does.
- **It's instant when Shellby is closed.** It checks for a marker file Shellby leaves while it's running, and skips when the file isn't there.
- **Shellby keeps almost nothing.** It reads only the event name, tool name, folder and session id (the folder and id are what **Bring it into Shellby** needs to open the conversation). Commands and file contents in the payload are dropped unread and never stored.

Requires `bash` and `curl`, which come with Git for Windows (Claude Code on Windows already needs it).
