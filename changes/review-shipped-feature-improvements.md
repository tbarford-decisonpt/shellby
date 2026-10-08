### Fixed
- **Every push checks for secrets.** Cutting a release or opening a pull request now looks for API keys and passwords first, just like bringing work home does, and asks before anything that looks like one goes out.
- **A crashed turn still ends properly.** If Claude Code crashes partway through a turn, your queued messages wait, the turn's changes and Undo show up, and the tab gets its unread mark. Pressing Stop on a turn that won't wind down no longer shows a "Claude Code exited" error, and the next turn no longer bounces your queued messages back.
- **Removing a queued message as Claude picks it up** no longer sends it anyway: he tells you it was too late, and focus moves to the next message or the box.
- **Ctrl+F finds text inside edits you haven't opened yet**, and opens them to the match.
- **Popped-out conversations get everything the panel does.** Ctrl+= and Ctrl+- zoom them too and every window stays the same size, they show "Checking…" while tests run, offer "Send after the reset" at the usage limit, and a held message that can't be sent lands back in their own box.
- **Sync leaves Autonomous alone.** A PC in Autonomous is no longer switched back to Ask a few seconds later.
- **Snippets and pins merge one by one.** One you add on one PC no longer vanishes when you change your snippets on another, and deleting one still deletes it everywhere.
- **Your calling card comes down.** If it can't be deleted when you turn off Visiting crabs, Shellby says so and keeps trying until it's gone, sign-out included.
- **Phone alerts say when they're failing.** Settings → Elsewhere shows why and when, you get one heads-up at the desk after three misses in a row, and permission prompts get a second try when the service is briefly busy. If Telegram turns down your bot token, or another app is reading the same bot, Settings says so and he stops asking every few seconds.
- **A Telegram task that arrives too late to start** now gets a reply saying so, instead of disappearing.
- **Failed update checks** say what went wrong in plain words and try again in 10, 30 and 60 minutes, not six hours.
- **After a crash, Claude Code in your terminal no longer stalls on every step**, and its status line goes blank instead of showing an old one.
- **Python turn checks use the project's own `.venv` or `venv`.** If pytest isn't installed where he looks, he says it needs its virtualenv instead of blocking Bring it home.
- **The dependency watch shows each project's own problem**, like a missing folder or a check that took too long, instead of blaming the registries.
- **Dev servers that never print a localhost address** count as up after about 25 seconds, network addresses and "Server on 3000" lines are read too, and one that crashes hours later says "Crashed", not "Didn't start".
- **Routines after sleep.** A missed routine only catches up if you've turned catch-up on and it's under 12 hours late, and several due at once start 5 seconds apart.
- **MCP servers added with npx, pnpm, yarn or bunx start on Windows**: Shellby runs them through `cmd /c` for you.
- **The "Run the tests before Claude finishes" hook** no longer fails every turn in projects without real tests, and when tests fail Claude sees the end of the output.
- **Permission cards flag more setup changes**: a short path like `.claude/settings.local.json`, or `claude mcp add` and `claude config`.
- **His firsts stay in the Us journal for good.** Feeding him every day no longer writes "first snack" again with today's date.
- **Claude's pins can no longer push yours out** of a project's journal.
- **With Windows' animation effects off, he stays put**: no strolls, climbs or flying throws, unless you switch strolling on yourself. And it no longer mutes his chirps and sound effects.

### New
- **Undo for the things that couldn't be undone.** Put up a layout by mistake, saved over one or removed one? The toast (or Ctrl+Z) puts it back. A removed Wardrobe pack can come back too, and waits a week before it's really gone. Unpin and Forget in a project's journal can be undone.
- **A word when Sync changes your settings.** A short note says which settings came from your other PC, and the Sync line says everything it carries.

### Changed
- **Messages Claude read mid-turn say "sent mid-turn"**, and their ↶ goes back to just before the message they joined.

### Faster
- **Less work while you're not looking.** His tank sits still while the panel is behind your windows, and on the desktop he stops wandering and talking to nobody while a window or a game covers him.
- **Smoother while Claude works.** Shellby no longer rewrites your settings file on every token count, saves history in small batches (nothing is lost when you close a tab or quit), and reads big edits, turn changes and moved transcripts without holding up the app.
