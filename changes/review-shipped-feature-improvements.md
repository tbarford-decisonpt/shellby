### Fixed
- **Every push checks for secrets.** Cutting a release or opening a pull request asks before anything that looks like a key or password goes out.
- **A crashed turn still ends properly**: queued messages wait, changes and Undo show up, and Stop no longer reports "Claude Code exited".
- **Removing a queued message as Claude picks it up** no longer sends it anyway.
- **Ctrl+F finds text inside edits you haven't opened yet.**
- **Popped-out conversations get everything the panel does**: zoom, "Checking…", "Send after the reset".
- **Sync leaves Autonomous alone**, and **snippets and pins merge one by one** instead of vanishing.
- **Your calling card comes down** when you turn off Visiting crabs, retrying until it's gone.
- **Phone alerts say when they're failing**, in Settings → Elsewhere, and a Telegram task that arrives too late gets a reply.
- **Failed update checks** say why and retry within the hour.
- **After a crash, Claude Code in your terminal no longer stalls on every step.**
- **Python turn checks use the project's own `.venv` or `venv`.**
- **The dependency watch shows each project's own problem** instead of blaming the registries.
- **Dev servers that never print a localhost address** count as up, and one that crashes later says "Crashed".
- **Routines after sleep** only catch up if you asked, and start a few seconds apart.
- **MCP servers added with npx, pnpm, yarn or bunx start on Windows.**
- **The "Run the tests before Claude finishes" hook** no longer fails in projects without tests.
- **Permission cards flag more setup changes**, like `claude mcp add`.
- **His firsts stay in the Us journal**, and Claude's pins can't push yours out.
- **With Windows' animation effects off, he stays put**, and keeps his sounds.

### New
- **Undo for layouts, Wardrobe packs and journal pins.** The toast (or Ctrl+Z) puts them back.
- **A word when Sync changes your settings.**

### Changed
- **Messages Claude read mid-turn say "sent mid-turn".**

### Faster
- **Less work while you're not looking**, and **smoother while Claude works**: fewer settings writes, batched history saves.
