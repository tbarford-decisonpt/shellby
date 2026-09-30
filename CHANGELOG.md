# Changelog

## 0.3.0: The Wardrobe

Dress Shellby up, earn outfits by using him, and let him celebrate the seasons.

### New
- **Wardrobe.** Open it by clicking the crab logo (or tray → Wardrobe). It has 32 hand-drawn accessories and 7 particle effects across hats, face, neck, held items, shell and effects, plus seasonal color schemes. There's a live preview stage where you can hover any item to try it on, even locked ones, and switch moods to see the outfit while working, asking or sleeping. There's also a 🎲 randomize button.
- **Trophies.** 18 achievements, a few of them secret, each rewarding an item. Unlocks celebrate on the desktop (★ bubble and confetti burst) and in the panel ("Wear it"). Your existing history is credited on first launch, so you don't start from zero.
- **Seasons.** Spooky Season, Winter Holidays, Valentine's, Spring, Summer and Autumn, each with its own look that Shellby wears automatically. Change it and he respects your choice for the rest of that season. Seasonal items are collectibles you keep once their season has come around.
- **Effects** around the desktop crab: snowfall, orbiting bats, falling leaves, floating hearts, fireflies and sparkles, plus a confetti burst when a task finishes (once earned). All CSS-animated and cheap on the CPU.
- **Helper crabs wear matching hats.**
- **Community wardrobe packs.** A documented JSON format with a JSON Schema (`docs/addon.schema.json`) and a creator guide (`docs/ADDONS.md`). Install from the Wardrobe or by dropping a `.json` file on it. Packs are validated strictly, are data only (no code), and are previewed in a native confirmation dialog before install. The built-in wardrobe uses the same format.

### Fixed
- **The long-standing "top of the panel gets messed up when scrolling" bug.** The drifting background layer was larger than the window, which made the page itself scrollable by code. Any `scrollIntoView` that ran out of room (for example an approval card appearing) shoved the whole panel up, hiding the title bar. The layer is now `position: fixed`, which adds no scrollable area. `scripts/ui-regressions.js` reproduces the old bug (the title bar was pushed up 44–114 px) and verifies the fix.

### Developer
- `SHELLBY_USER_DATA` runs a dev build in its own profile, so tests never touch your real settings or need your Shellby closed. Screenshot runs use a throwaway profile automatically.

## 0.2.2

### Fixed
- Closing the last tab opened **two** blank tabs. All tab creation now goes through one shared request, so simultaneous "make sure a tab exists" calls can't double up.
- Tooltips (including hovering a helper crab) used the unstyled Windows tooltip. They're now themed to match Shellby's speech bubbles and also appear on keyboard focus.
- The crab window now carries the app icon explicitly.

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
