# Changelog

## 0.15.1

### Fixed
- **The level badge no longer covers Shellby** in the top-left of the panel. It used to sit on top of the crab; it now follows his name as a small yellow pill (or sits right next to him when the window is narrow and the name is hidden). The new-outfit dot moved over a little so it doesn't touch the pill either.

## 0.15.0: GitHub sign-in

### New
- **Sign in with GitHub** (Settings → GitHub). Shellby shows a short code and you approve it on github.com, the same way `gh auth login` works. You never type a password into Shellby. The sign-in is encrypted by Windows in its own file (never in settings.json), and GitHub is asked only for what the features you turn on need. Turning on another feature later asks GitHub again for just that.
- **Sync between PCs.** Trophies, collected seasonal items, XP, streak days, your outfit and your color go into a private gist. Sign in on another PC and they meet there. Syncing only ever adds progress (nothing gets lost on either side), and the outfit and color follow whichever PC changed them last. It syncs every 15 minutes, shortly after you change an outfit or win a trophy, or when you press **Sync now**.
- **Publish Wardrobe packs.** Your own packs get a **Publish** button. After one confirm, Shellby forks `x-salmon/shellby-packs`, adds `packs/<id>/pack.json` on a new branch and opens the pull request, so the gallery's Pack check takes it from there. It won't publish a pack with invalid items or an unchanged version number.
- **Let Claude tasks push code.** Off by default, and Shellby warns you first. When it's on, tasks in Shellby's tabs get your sign-in, so `git push`, `git pull`, `gh pr create` and the official GitHub plugin's tools (issues, pull requests, reviews) just work, including for private repos. It's provided through environment variables, so your git config is never changed, and Claude Code in your terminal isn't affected.
- **Your GitHub name and avatar** in Settings, and "@you's Shellby" on the share card.

## 0.14.3

### Fixed
- **A cleaner status line in cmd.exe.** The plain-text line no longer starts with the ASCII crab `(V)(;,,;)(V)`, which read as garbage more than as a crab. It now just says `Shellby working | Lv 5 Claw Coder [###--]`.

## 0.14.2

### Fixed
- **Shellby no longer vanishes or drifts on PCs with mixed display scaling** (for example a 4K screen at 150% next to monitors at 100% or 125%). When his window crossed between monitors, Windows kept its pixel size instead of its real size, so it shrank or grew under him: "Reset position" could clip him out of sight, and dragging made him wander away from his own effects (like the autumn leaves). Every move now keeps his size, and any size Windows forces on him afterwards is put back.
- **Dragging follows your mouse exactly**, across monitors too. It used to compute the motion from inside his own moving window, which drifts when the scale changes mid-drag.

### New
- **Settings → Look → Find Shellby** puts him back in the bottom-right corner of your main screen (same as the tray's Reset position).

## 0.14.1

### Fixed
- **No more question marks in cmd.exe.** The classic Windows console can't draw emoji or the ▰▱ XP bar, so Shellby now also writes a plain-text status line (`Shellby working | Lv 5 Claw Coder [###--] | streak 4d`). The status-line command picks it automatically there, and keeps the emoji line in Windows Terminal, VS Code, macOS and Linux. If you already added Shellby's status line, it's updated for you.
- **Shellby stops missing your terminal sessions.** The plugin only talks to Shellby while a small "I'm listening" marker file exists. A second copy of Shellby that couldn't get the port (a restart racing the old one, a dev run) used to delete the real one's marker, and from then on every Claude Code hook quietly did nothing. Now only the Shellby that wrote the marker can remove it, it puts it back every minute if anything else does, and dev/test copies listen on their own port.

### New
- **Settings → Claude Code everywhere → Shellby plugin** says whether the plugin is installed on this PC, with an **Install the plugin** button: one confirm, then Shellby adds the marketplace and installs the plugin with Claude Code for you. (Each computer needs it, and each talks only to its own Shellby.)

## 0.14.0: Streaks and nudges

### New
- **Streaks.** Finish a Claude task on consecutive days, in Shellby or with the plugin anywhere, and the 🔥 streak grows. It stays alive until the end of the next day. The status line shows it ("🔥 6d").
- **Projects.** Shellby remembers the git repos you work in (by repo root, even from a subfolder) and reads each one's real last commit with `git log`, so commits made outside Claude count too.
- **Nudges:** *"You haven't committed to 3d-rack in 5 days 🐚"*.
  - **Limits:** at most one a day, only between 9:00 and 21:00, only for projects you touched in the last month, and never in just-the-crab mode.
  - **Pick it up** opens a new tab in that project with a "where did we leave off?" prompt ready to send.
- **Trophies → Streaks card:** your streak and best streak, your projects with days since their last commit (quiet ones highlighted), a mute button per project, and how many quiet days before a nudge (2 days to 2 weeks).

## 0.13.1

### Fixed
- **Questions from Shellby look like questions.** When Claude asks you something (Claude Code's multiple-choice questions), you used to see the raw JSON in a permission card. Now you get a proper question card:
  - **Layout:** the question, a topic chip, and each option with its description.
  - **Answering:** press **1–9** to pick, select several when it's multi-choice, or type your own answer. **Send** returns your answers to Claude, or **Skip** tells Claude you'd rather not answer.
  - **Afterwards:** the card shows what you answered, the activity line reads "Asked you: …", and the notification says "Shellby has a question".
- **Your prompt is no longer cut off after you send it.** The "Working…" bar appearing above the box made the conversation shorter right as your message arrived, hiding its last line. The conversation now stays pinned to the bottom when the box area grows (the Working bar, queued messages, attachments), and sending always brings your prompt into view, even if you'd scrolled up. A reply still won't pull you away from history you're reading.

## 0.13.0: Status-line face

### New
- **Shellby in Claude Code's status line,** right under the prompt in the terminal and VS Code, for example `🦀💨 Shellby working · Lv 5 Claw Coder ▰▰▰▱▱ · 🥵 GPU 84°C · +25 XP`.
  - **His face follows his mood:** 💨 working, ✋ needs your OK, 🎉 done, ⭐ level up, 💤 napping. Helper crabs show as "+3 🦀".
  - **The line also shows** his level, title and XP bar, any health warning, and a fresh "+XP".
  - **It's fast and quiet:** the line comes from a file Shellby keeps up to date, so it costs about nothing, and it's simply empty when Shellby isn't running.
- **Turning it on or off:**
  - **In the app:** **Settings → Claude Code everywhere → Status line** shows a live preview and **Add to Claude Code**. It asks first, keeps a backup of your settings, and warns if it would replace an existing status line. **Remove** puts yours back.
  - **In the terminal:** **`/shellby:statusline`**, a new command in the Shellby Claude Code plugin (v1.1.0), has Claude's statusline-setup agent add Shellby while keeping your existing status line.

## 0.12.0: XP and levels

### New
- **Shellby earns XP and levels up.** The biggest award is for **writing himself a new skill or agent** (+150), which usually tips him into the next level:
  - Deploys and publishes (`vercel --prod`, `wrangler deploy`, `gh release create`, `npm publish` and more): **+50**
  - `git push`: **+40**
  - Passing tests (`npm test`, `pytest`, `go test`, `cargo test`, `dotnet test` and more): **+25**
  - Trophies: **+20**
  - Finished tasks: **+10**
  - Each day you use him: **+5**
- **It counts everywhere you use Claude Code:** in Shellby's tabs and, with the Shellby plugin, in your terminal and editor.
- **Levels have crab titles,** from Hatchling through Claw Coder and Reef Architect to Legend of the Tides.
- **On the desktop,** "+25 XP" floats up from him, and a level-up gets a gold "LV 5" bubble, a jump and confetti. In the panel, level-ups get a celebration card, plus a notification if the panel's closed.
- **Your level is always visible** as a gold badge on the crab in the title bar, with a thin XP bar. **Trophies** has an XP card: level and title, progress to the next level, how he earns XP and a recent XP log. The crab card shows his level too.

### Fair play
- **Only successes count.** Failing test runs earn nothing, and `--dry-run` rehearsals don't count.
- **Hourly caps** stop a test loop from farming XP.

## 0.11.0: Skill Shop

### New
- **Skill Shop.** **Toolbox → Get more** lists every plugin in your Claude Code marketplaces (skills, agents, commands), most popular first, with search and a filter per marketplace:
  - **Install** and **Remove** with one click; new plugins are ready in your next conversation
  - **Installed** shows what you already have, with its version and a link to its source
  - **Add a marketplace** from a GitHub repo or link; Anthropic's official marketplaces are one click
  - It all runs through Claude Code's own `claude plugin` commands, so plugins installed here show up in your terminal and editor too, and vice versa

### Security
- **Skill Shop installs always ask first**, in the isolated confirmation window, which names where the plugin really comes from and shows a red warning for anything outside Anthropic's marketplaces. Cancel is the default. After an install, Shellby says plainly if it added hooks or MCP servers. Plugins that install by running a command are never installed from Shellby: you're told to review them in a terminal.
- **What you approve is what gets installed.** Marketplaces aren't refreshed while an install confirmation is open, and if the catalog changed anyway while you were deciding, Shellby asks you to look again instead of installing.
- **A stalled install is cleaned up completely.** When an install times out, its whole process tree is stopped, including any `git` it started, not just Claude Code.

## 0.10.0: Outfit codes

### New
- **Outfit codes.** Every look has a short code like `SHB-B1T7-2DB1-7MXH-JW90`. It's shown under the Wardrobe preview with a **Copy** button. Post it in a comment, a thread or on Discord.
- **Wear a code…** previews a pasted code on your crab before you put it on:
  - Items you have are worn.
  - Locked items say which trophy unlocks them.
  - Items from community packs you don't have are looked up in the gallery, with a **Get pack** button (the usual install confirmation).
- **Codes are forgiving:** any case, spaces, and `O`/`0` or `I`/`L`/`1` mix-ups all work. A built-in checksum catches typos instead of putting on the wrong outfit.
- **No server, and future-proof:** a code doesn't depend on the order of items, so it keeps working as new items and packs arrive.
- **The crab card shows your code** ("Wear my look"), and the X and Bluesky post text includes it.

## 0.9.0: Queue it up

### New
- **Queue messages while Shellby works**, like in Claude Code:
  - Keep typing while a task runs. Enter queues the message, and queued messages are sent one at a time as each turn finishes.
  - They show as chips above the box. Click one, or press **↑** in an empty box, to pull it back and edit it; ✕ removes it. The status line shows how many are queued.
  - **Stop** hands the queue back: your queued messages go into the box instead of firing.
  - If a turn ends with an error, the queue pauses until you press **Send next now**.
  - Each tab has its own queue, and a background tab keeps draining its queue while you look at another.

### For developers
- `SHELLBY_FAKE_CLAUDE=test/fixtures/fake-claude.js` runs a dev build against the fake CLI, with no account and no usage. The fixture gained `wait <ms>` and `fail [ms]` turns.
- `node scripts/e2e-queue.js` covers the whole queue flow.

## 0.8.0: Claude Code everywhere

### New
- **Shellby reacts to every Claude Code session on your PC**, not just the ones started in Shellby. Install the Shellby plugin in Claude Code (`/plugin marketplace add x-salmon/shellby`, then `/plugin install shellby@shellby`):
  - he scuttles while Claude works in your terminal or editor
  - he raises a claw when it needs permission
  - he celebrates finished turns, which count toward trophies
  - he sends out helper crabs, labeled with the project, for subagents
- **Settings → Claude Code everywhere:** copy the install commands, turn the feature on or off, and see your connected sessions live (project, working or waiting, tool, helpers).
- **The plugin costs nothing when Shellby is closed:** the hook checks a marker file and returns in milliseconds.

### Security
- The listener is local only (`127.0.0.1`), refuses browser-originated requests, caps bodies, and keeps only event, tool and folder names. Details in SECURITY.md.

## 0.7.0: Just the crab

### New
- **Just the crab: no Claude needed.** First run now offers two paths:
  - **Just the crab:** a desktop pet that watches your PC, with Health, the Wardrobe, trophies and crab cards. No account and no CLI.
  - **Crab + Claude Code:** the full setup, as before.

  In crab mode, Health is home, and chat, permission modes, Toolbox, Routines and History are hidden.
- **The Claude bits explain themselves.** In crab mode, **Ask Shellby why**, dropping files on him, and a "Give Shellby a brain" card in Health show what Claude Code would add, with a **Set up Claude Code** button. Settings switches modes either way, and your conversations stay saved.

### Fixed
- A trophy celebration and a toast arriving together no longer stack on top of each other, and dialogs always sit above both.

## 0.6.0: Show him off

### New
- **Crab card.** **📸 Share** in the Wardrobe or Trophies makes a 1200×630 picture of your Shellby as he's dressed (with his effect), titled by your best trophy, with tasks done, trophies, helper crabs sent and your trophy shelf. One click copies it to the clipboard and saves it to `Pictures\Shellby`. The preview has **Post on X** and **Post on Bluesky** buttons with the text filled in; paste the image into the post. The card contains counts only: no name, email or folders.
- **New trophy: 📸 Show-Off.** Share your crab card to unlock a camera for him to hold.
- **Trophy unlocks get a proper celebration card:** a medallion, the trophy's name and description, pixel previews of each reward, **Wear it** (or **Wear them**) and **Share**. It stays up while you hover, and several unlocks queue up instead of replacing each other.

### Changed
- Notifications inside the panel are rounded cards instead of pills, so longer messages and their buttons no longer look squashed.

## 0.5.1

### Fixed
- **Health view:** the "Set up CPU temperature" link was cut off when the panel was wide enough for three gauge columns. Cards without a reading now wrap their text instead of clipping it.

### New
- **Demo GIF at the top of the README** (and an MP4 for sharing). `npm run reel` records it through the real UI with scripted data.
- **Checksums:** every release now includes `SHA256SUMS.txt` for verifying downloads.
- **Code signing support:** releases are signed automatically once Azure Artifact Signing credentials are configured. See [docs/SIGNING.md](docs/SIGNING.md).

## 0.5.0: Health

Shellby now keeps an eye on your PC, and his mood follows it.

### New
- **Health view** (the pulse icon in the title bar):
  - live GPU and CPU temperatures, CPU and GPU load, memory and every drive, with 10-minute sparklines
  - a sensor checklist, adjustable thresholds and a log of recent alerts
  - a titlebar badge when something needs attention
- **Health moods on the desktop:**
  - **hot:** sweat, flushed cheeks and fanning with his claw
  - **scorching:** panting and a heat shimmer; it wakes him if he's asleep
  - **dizzy (memory):** stars circling his eyes
  - **stuffed (full drive):** junk spilling out of his shell

  The speech bubble shows the reading, e.g. `84°` or `C: 8.4 GB`. Readings must hold for about 20 seconds, so short spikes are ignored.
- **Notifications** when a reading crosses your line (once per problem, with a 30-minute cooldown) and when it recovers.
- **Ask Shellby why:** one click starts a read-only Claude Code task that finds what's heating the GPU, eating memory or filling a drive.
- **CPU temperature** through LibreHardwareMonitor's local web server, with step-by-step setup in the Health view. NVIDIA GPUs work out of the box through `nvidia-smi`. See [docs/HEALTH.md](docs/HEALTH.md).
- **Three new trophies and four accessories:**
  - 🩺 Check-Up: Stethoscope
  - 🧊 Keep Your Cool (secret): Sweatband and Handheld Fan
  - 🧹 Spring Cleaning: Broom
- **Health in the tray:** the menu and tooltip show what's wrong.

### For developers
- Dev builds can fake sensors with `SHELLBY_FAKE_HEALTH=hot|scorching|dizzy|stuffed|calm|nocpu`.
- `node scripts/e2e-health.js` checks every mood end to end.
- The pack schema accepts the new trophy ids as unlock conditions.

## 0.4.1

### Fixed
- While a command ran, its tool card spun three garbled letters instead of the ◌ spinner, and the ✓ / ✕ / ⊘ result icons were garbled too. A Windows-1252 re-encode had mangled them in 0.3.0. A new test now fails the build if any source file contains garbled text or stray control characters.

### Docs
- The README has a **Community wardrobe** section and a top-level link to the [community gallery](https://x-salmon.github.io/shellby-packs/).

## 0.4.0: Community packs

Find wardrobe packs other people made and add them in one click.

### New
- **Community gallery:** https://x-salmon.github.io/shellby-packs/. Browse packs, try items on Shellby in the browser, design your own in **Pack Studio** (live preview with Shellby's own validator and renderer), and submit by pull request.
- **Themed confirmations.** "Install pack?", "Enable Autonomous?" and error notices now appear in Shellby-styled windows instead of plain Windows dialogs. The install confirmation previews **every item in the pack** as pixel art. Each confirmation is a separate, isolated window, so the panel can't answer it, which keeps the security of a native dialog.
- **One-click installs from the community gallery.** Every pack on [the Shellby community gallery](https://x-salmon.github.io/shellby-packs/) has an **Add to Shellby** button. Click it and Shellby opens the Wardrobe, downloads the pack, shows you what's inside and asks before installing. If you already have that version, Shellby tells you instead of reinstalling.
- **Browse community packs** button in **Wardrobe → Wardrobe packs**.

### Security
- Gallery links (`shellby://install?pack=<id>`) carry only a pack id. Shellby never downloads from an address that comes from a link.
- Packs are only fetched from the official registry, and the download must match the sha256 checksum published in the registry's index, byte for byte. Downloads are size-capped while they stream and time out.
- Nothing is installed without the native confirmation dialog, and gallery packs go through the same strict validation as packs you install from a file.

### Fixed
- Toasts without an action button showed a stray "null" at the end.
- Opening Shellby from an **Add to Shellby** link now lands on the Wardrobe even when the link launched the app.
- Clicking a notification could open Electron's default page. Dev and test builds no longer post Windows notifications and use a separate app identity, so notifications always belong to the installed Shellby.

### Developer
- `SHELLBY_REGISTER_PROTOCOL=1` makes a dev run register itself for `shellby://` links (off by default so it doesn't take them over from an installed Shellby). `SHELLBY_REGISTRY_URL` points a dev run at a different registry.

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
