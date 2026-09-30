# Changelog

## 0.2.1

### Fixed
- The panel's close button (✕) was clipped at the default width in Autonomous mode, the widest mode label. The title bar now adapts to its own width: window buttons never shrink, the mode label truncates if needed, and the "Shellby" wordmark steps aside on narrow panels. Checked at every width from 400 to 494 px in all five modes (`node scripts/titlebar-fit.js`).

## 0.2.0: Crew, Toolbox, Routines

Shellby now works the way people actually use Claude Code: orchestrating helpers and building tools for itself.

### New
- **Crew view.** Subagents get their own lanes in the conversation, with live activity, tool count, tokens, elapsed time and a summary when done. Helper crabs appear next to Shellby on the desktop for each running subagent. Click one to jump to its conversation.
- **Helper permission prompts** show up inside the helper's lane, labelled with which crab is asking.
- **Parallel conversations.** Tabs, each backed by its own Claude Code process, with <kbd>Ctrl</kbd>+<kbd>T</kbd>, <kbd>Ctrl</kbd>+<kbd>W</kbd> and <kbd>Ctrl</kbd>+<kbd>Tab</kbd>. Open tabs come back after a restart. The desktop crab shows how many are running.
- **Toolbox.** Skills, subagents, slash commands and MCP servers with status, merged from Claude Code's own report and a scan of `~/.claude` and the project's `.claude/`. Includes search, pinning and "show file".
- **Learns new tricks.** When Claude writes itself a new skill, agent or command, Shellby notices, celebrates on the desktop, tags it **new** and offers to pin it.
- **`/` autocomplete** for skills and commands in the composer, and pinned tricks as one-click chips on the start screen.
- **Routines.** Daily, weekly or every-N-hours tasks with their own folder and permission mode. They catch up after sleep or shutdown, and have run-now, pause and templates.
- **Safety flags for self-built tooling.** Permission cards warn when a command runs a file Claude wrote earlier in the conversation, or when an edit touches Claude Code's own setup (skills, agents, hooks, settings, `CLAUDE.md`).

### Fixed
- Scrolling artifacts at the top of the panel on high-DPI displays. The header is now opaque and isolated, scroll areas are separate compositor layers, and the full-window blend-mode grain that forced repaints on every scroll frame is gone.
- The panel no longer tucks under an auto-hiding taskbar.
- Background subagents can finish after the main turn without their pending prompts being cancelled.
- Releases publish as a single, complete release (no more stray drafts).

## 0.1.0

First release: desktop-layer critter, chat panel on the Claude Code CLI, permission cards, five permission modes, usage meter, history, drag-and-drop, hotkey, tray, notifications, auto-update and skins.
