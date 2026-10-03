# Changelog

## 0.40.1: your sign-in, your call

### Changed
- **Shellby no longer hides API keys from Claude Code.** Until now Shellby quietly removed `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and the Bedrock, Vertex and Foundry switches before starting Claude Code, so it always ran on your Claude plan. Claude Code now gets them as they're set on your PC, and signs in however you've set it up.
- **Always use my Claude plan.** To keep the old behavior, turn this on in **Settings → Claude → Claude Code**. Shellby then leaves those variables out, so its conversations always run on your Claude Pro or Max plan. It applies to new conversations.
- **A heads-up when a key is set.** If one of those variables is set and the switch is off, Settings and the sign-in step say which one, because Claude Code may bill it per token instead of using your plan.

## 0.40.0: visiting crabs

### New
- **Friends' crabs come to visit.** Turn on **Visiting crabs** in Settings → Connections → GitHub and add friends by their GitHub username. Now and then, when Shellby is idle and not guarding your focus, a friend's crab strolls onto your desktop next to him for a few minutes, in their own outfit, colors and shell, with their name above it. Shellby says who dropped by. Want company now? Press **Invite over**.
- **They hang out.** A few times during a visit the two crabs do something together: a dance with notes floating up, a party with confetti and jumping, a claw-bump high five, or a little duet. Shellby says something to match. If a task starts or you're in a focus session, they skip it.
- **A guestbook with souvenirs.** Every visit signs your guestbook, and the visitor leaves a keepsake: sea glass, a sand dollar, a pearl, a bottle cap and more. Which one depends on who came and on which day, so regulars bring a mix.
- **Waves.** Send a friend a wave ("loves the outfit", "go ship it!", "go to bed!" and a few more) and it pops up in their crab's bubble and their Waves list. These are fixed lines, so nobody can make your crab say anything else, and only friends you added get through.
- **Two new trophies.** *Open House* (a friend's crab drops by) unlocks Sea Glass and a Friendship Cord. *Pen Pals* (wave 5 times) unlocks a Message in a Bottle.
- **How it works, and what's public.** There's no Shellby server. Your crab gets a small public *calling card* gist with its look and level under your GitHub username, and nothing else: no stats, projects or history. Waves are comments on that gist. Shellby asks before putting the card up, a first sign-in never turns this on, and switching it off or signing out deletes the card.
## 0.39.0: everything the terminal does

### New
- **Rewind to an earlier message.** Press <kbd>Esc</kbd> twice in an empty box, type `/rewind`, or hover one of your messages and press ↶. Pick a message and choose **Conversation and code**, **Conversation only** or **Code only**. The conversation goes back to just before that message, as if the rest never happened, and your message comes back into the box to change and send again. The code goes back with Shellby's own record of each turn, so changes made by scripts and installs are undone too, not just Claude's edits. The code goes back newest turn first. If a file changed again since and can't go back, it stops there and says which, and the conversation is left as it was. The old version of the conversation isn't lost: Claude Code keeps it, and Shellby carries on from a copy. Messages sent before this version can have their code put back, but not the conversation.
- **`!` runs a command yourself.** Start a message with `!` (for example `!git status`) and Shellby runs it in PowerShell in the conversation's folder. The output shows in the conversation, and Claude gets the command and its output along with your next message, without spending a turn on it. The first time, Shellby asks in the confirmation window. To send Claude a message that starts with `!`, type `!!`.
- **`@` mentions files.** Type `@` and start typing a file or folder name: a list of matches from the project comes up, the way it does in the terminal. <kbd>Tab</kbd> or <kbd>Enter</kbd> puts it in. Picking a folder keeps the list open inside it. Paths with spaces are quoted for you. Claude Code reads the file itself when the message goes.
- **Up and Ctrl+R bring back what you've sent.** In the box, <kbd>↑</kbd> and <kbd>↓</kbd> step through your last 100 messages, across every conversation. They're kept in their own file in Shellby's data folder, and anything that looks like it carries a key or password is left out. <kbd>Ctrl</kbd>+<kbd>R</kbd> searches them: type to narrow it down, <kbd>Ctrl</kbd>+<kbd>R</kbd> again for older matches, <kbd>Enter</kbd> to use one, <kbd>Esc</kbd> to go back to what you had. <kbd>↑</kbd> in an empty box still takes back a queued message first.
- **Effort.** A new chip next to the folder sets how hard Claude thinks: Auto, Low, Medium, High, Extra high or Max. It applies to every open conversation straight away, from the next message. `/effort high` does the same from the box.
- **Output style.** **Settings → Claude → Model** has an **Output style** picker: Default, Explanatory (explains its choices as it goes), Learning (leaves small pieces for you to write), and any styles you or the project keep in an `output-styles` folder. It applies to new conversations.
- **Toolbox → Rules.** The allow, ask and deny rules Claude Code follows, from your settings and the project's, in one list (what `/permissions` shows in the terminal). Add one, like `Bash(npm run test:*)` or `Read(./.env)`, or remove one. Adding an allow rule, or removing an ask or deny rule, asks you first in the confirmation window. A backup of the settings file is kept.
- **Toolbox → MCP can change things now.** **Add server** adds one that runs a program or connects to a URL, for just you here, the project, or you everywhere, after you confirm. Each server has **Turn off** / **Turn on** and **Reconnect** (when it has failed), which act on every open conversation that's running, and ✕ to remove it. **Refresh** asks a running conversation for the latest statuses.
- **`/export`** saves the conversation as a Markdown file. `/export clipboard` copies it instead.
- **Shellby's own commands in the `/` menu:** `/rewind`, `/export`, `/effort`, `/permissions`, `/mcp`, `/model` and `/output-style`. Typing a command out in full and pressing <kbd>Enter</kbd> runs it, instead of completing its name.

## 0.38.0: Claude sets up routines

### New
- **Ask Claude for a routine.** In any Claude Code session with the Shellby plugin, including Shellby's own tabs, say what you want done and when ("every weekday at 8:30, list what changed in my Documents") and Claude sets up the routine for you. Shellby opens his confirmation window with the name, the schedule, the folder, the mode and the whole prompt, and saves it only if you press **Add routine**. Claude is told whether you said yes, and the new routine appears in **Routines** straight away, where you can pause, edit or delete it as usual.
- **Change one by asking.** Claude can also see your routines, so "move my morning briefing to 9" changes the existing one rather than adding a second. The window says **Change a routine?**, and the routine keeps its history and stays paused if you'd paused it.
- Claude can't pick **Autonomous** for a routine, and can't turn one on without your yes. Prompts it writes are capped at 1,000 characters and 20 lines, with runs of blank lines squeezed out, so the window can always show every word. The folder and mode are listed above the prompt, where a long prompt can't push them away. Only one routine question is open at a time, and after you say no, Claude has to wait a moment before asking again.
- Long details in Shellby's confirmation windows now scroll, so the buttons always stay in view.
- The plugin is now version 1.3.0. Update it in Claude Code to get the two new tools.

## 0.37.0: home and done

### New
- **Bringing a copy home ticks the conversation off.** When you bring a copy home and tidy it away (the tab closes), History marks that conversation done. It's merged, so it's finished. Bringing it home and keeping the copy leaves it alone, because you might carry on there, and so does throwing a copy away. If a done conversation gets more work, it's marked not done again, the same as when you tick it yourself.

## 0.36.0: on the clock

### New
- **See how long he's been at it.** While a prompt runs, the Working bar shows a clock next to what he's doing, like Claude Code's *(12s · esc to interrupt)*. It ticks every second (*7s*, *1m 05s*, *1h 02m*) and starts over for each prompt, including queued ones as they go out. The time comes from the moment the turn actually started, so it stays right if you switch tabs or reopen the panel mid-task. When the turn ends, the *done · 48s* line under it keeps the final figure as before.

## 0.35.0: what's hogging it

### New
- **What's hogging it.** When Shellby sweats or gets dizzy, the Health view lists the busiest processes right under the warning, so "your GPU is at 84°C" comes with the reason. It's sorted by whatever explains the warning (GPU use, CPU use or memory), and you can switch between them. Each one has an **End task** button that asks first, in the separate confirmation window, showing what you're about to close and what it's using. Windows' own processes and Shellby himself can't be ended from here. If the process closes while the question is open, Shellby won't end whatever took its place.
- **Starts with Windows.** The Health view lists everything that launches when you sign in, with the ones you've switched off in Task Manager crossed out. **Ask Shellby which ones I need** starts a read-only task that explains each one, also checks scheduled tasks and services that start on their own, and gives you a table of what to keep, what to switch off and how. It doesn't switch anything off itself, and it always runs in **Ask** mode, so anything Claude wants to run asks you first.

## 0.34.0: call it what you like

### New
- **Rename a conversation.** Double-click a tab, or press F2 on it, and type a new name. In History, hover a row and press ✎. Enter saves it and Escape leaves it as it was. You can name a fresh tab before you send it anything, and your first message won't replace the name. Renaming doesn't count as activity, so the conversation keeps its place in History.

## 0.33.0: off to GitHub

### New
- **Push from the folder menu.** In a git project, the folder menu has a **This repository** section with **Push main** (or whichever branch you're on). It says how many commits would go and how many the remote has that you don't, for example *14 commits to push · 2 to take in from origin first*. It shows the figures from the last fetch straight away, then checks with the remote. Pressing it fetches, merges in the remote's work (a merge, never a rebase, so your "Bring home" merges stay as they are), then pushes. It never force-pushes. If the remote's work clashes with yours, the merge is backed out, nothing is pushed, and he can sort it out on his branch. If a pre-push hook says no, its own words are written into the conversation. A branch with no upstream is pushed to `origin` under the same name and starts tracking it. The conversation notes each push, and a push earns ship XP like a `git push` he runs himself.
- **Bring it home and push.** The branch menu has a third way home: merge the copy into its branch, then push that branch. If the push doesn't go through, the merge stays and the copy is kept, so you can push again from the folder menu.
- **Bring all home.** When copies of the repository have work that isn't in your branch yet, from open tabs or conversations in History, the folder menu offers to merge them all, one at a time. A copy that started from another branch is left alone, and so is a tab that's still working. The first clash stops it: the copies merged before it stay merged, and if that conversation is open he can sort it out. **Bring all home and push** then pushes the lot.
- Neither runs while a conversation is working in your checkout itself, since a merge from the remote would land under its feet.

## 0.32.0: getting crowded in here

### New
- **See how full each conversation is.** A thin bar under each tab fills as the conversation uses up Claude's context window. It turns amber past 80% and red past 95%. The **ctx** chip next to the folder shows the active tab's exact figure, for example *86% full · 172k of 200k tokens*. Click it to make room. The window size comes from Claude Code itself, so models with a 1M-token window are measured against 1M.
- **Compact, or start fresh with a summary.** Once a conversation passes 80%, Shellby says it's getting crowded, and a strip above the box offers two ways out. **Compact** runs Claude Code's `/compact`: Claude sums up the conversation so far and carries on in the room that frees up. **Start fresh with a summary** has Claude write a handoff note (the goal, what's done, what's left, decisions and the files that matter), then starts a brand-new conversation in the same tab and hands it the note. The tab keeps its own copy of the repo and its History entry. Both actions are in the chip's menu at any time, and the strip can be dismissed until the conversation fills up again. The transcript marks each compaction (Claude Code's automatic ones too) and each fresh start.
## 0.31.0: Claude sets up CPU temperature

### New
- **Let Claude set up LibreHardwareMonitor.** When CPU temperature isn't available, the Health view's setup card has a **Let Claude set it up** button. It fills in a task asking Claude to install LibreHardwareMonitor with winget, turn on its web server on the port Shellby uses (no password), start it minimized as administrator and check that Shellby can reach it. You accept the Windows admin prompt yourself. The task isn't sent until you press Enter, and Claude asks before making LHM start with Windows. The manual steps are still there. In just-the-crab mode the button explains what Claude Code would add.

## 0.30.0: Settings in four tabs

### New
- **Settings is split into four tabs** instead of one long page: **Shellby** (his look, music, desk lighting, streaming), **Claude** (Claude Code, permission mode, model, working folder, Claude Code everywhere), **Connections** (notifications on your phone, GitHub) and **General** (startup, the shortcut, updates and About). Settings reopens on whichever tab you last looked at. The first time, it opens on Claude, or on Shellby in just-the-crab mode. The arrow keys move between tabs.
- **Nothing is hidden from search.** <kbd>Ctrl</kbd>+<kbd>K</kbd> still finds every setting and shows which tab it's on. Picking one opens that tab, scrolls there and briefly lights up the section. The tray's update item and the "update ready" notification land in the right place the same way.
- When an update is ready, the **General** tab gets the same dot as the gear.

### Changed
- **Shortcut & model** is split in two: the shortcut that opens Shellby is under **General**, and the model picker (with every model from 0.29.0) is under **Claude**.

## 0.29.0: every model

### New
- **Pick any Claude model.** **Settings → Shortcut & model** now lists every current model, grouped by family: Fable 5.1 and 5, Opus 5.5 down to 4.5, Sonnet 5.5 down to 4.5, and Haiku 4.5. **Opus**, **Sonnet** and **Haiku (latest)** are still there and follow whatever Claude Code treats as newest. The others pin that exact release. Like before, the choice applies to new conversations.

## 0.28.0: Claude can tidy your memory

### New
- **Ask Claude to review your memory.** Toolbox → Memory has a **Review with Claude** button, and each open `CLAUDE.md` has an **Ask Claude** button next to Save. Either one starts a task asking Claude to look the files over and suggest what to tighten, add or cut, and to show you the changes before making them. It's filled into the box but not sent, so you can say what you want changed first. If the `claude-md-management` plugin is installed, the task uses its `/claude-md-improver` skill. Without it, Claude still does the review from a plain prompt. If you have the file open with unsaved changes and Claude edits it too, saving won't overwrite Claude's version and offers to reload.

## 0.27.1: tidier health warnings

### Fixed
- **Health warnings fit their cards.** In the Health view, a **very high** warning no longer wraps onto two lines and swells into a blob, and labels like **GPU temp** stay on one line, so the readings line up across cards again. When the cards are narrow, a critical warning just says **high**. It stays solid red and pulsing, so it doesn't look like the amber warning.

## 0.27.0: hooks and memory in the Toolbox

### New
- **Toolbox → Hooks.** Every hook Claude Code will run, in one list: yours (`~/.claude/settings.json`), the project's (shared and just-you) and the ones your plugins bring. Add a hook, edit one or remove it right there: pick when it runs, which tools it's for and the command. Each change asks first in the isolated confirmation window, shows the exact command and where it's saved, and keeps a backup of the settings file. Plugin hooks are listed but left to the plugin.
- **Toolbox → Memory.** The `CLAUDE.md` files that load for the folder you're in: yours, the project's, `CLAUDE.local.md`, your and the project's `.claude/rules/`, and any `CLAUDE.md` in the folders above. Open one in a plain editor, or create yours or the project's if it isn't there yet. <kbd>Ctrl</kbd>+<kbd>S</kbd> saves. If the file changed somewhere else since you opened it, Shellby won't save over it and offers to reload. Windows line endings stay as they were.

## 0.26.0: who used it all

### New
- **See what used up your limits.** Click the **5h / 7d** meters to see what filled each window: every tab and routine with its share, or switch to **Projects** to see it by folder. A conversation working in its own copy counts toward the project it came from. Each call is weighed by the model it used, since a limit fills faster on Opus than on Haiku. Only what Shellby ran is listed. Claude Code used elsewhere (a terminal, claude.ai) fills the meters too, and the breakdown says so. The tally stays on your PC and keeps just over a week.

## 0.25.0: while you were away

### New
- **A recap when you come back.** Step away for an hour or more (or lock the PC) and, when you're back, a short digest waits above the box: what finished, what failed, and what's waiting on you, whether that's a question or a permission prompt in Shellby or in Claude Code elsewhere. It also shows roughly how much of your 5-hour usage window went while you were out, split by conversation. Click a row to open that conversation, even one whose tab you've closed. If the panel isn't in front, a notification sums it up and Shellby says hello. The usage split is approximate: Claude Code only reports how full the window is, so each rise is put down to whichever conversation reported it, and Claude Code running outside Shellby fills the same window. Turn it off under **Settings → System**.

## 0.24.0: show him what's wrong

### New
- **Screenshot to task.** Snip with **Win+Shift+S** and press **Ctrl+V** in the box: the screenshot is attached, with a thumbnail. Claude sees the picture itself, not just a file name, so "this button is cut off" needs no more explaining. You can also drop a picture on the crab or the panel, including one dragged straight out of a browser. With a snip already on the clipboard, right-click the crab for **Task from screenshot**. Send a screenshot with nothing typed and he takes a look at it, in a tab called **Screenshot**.
- **A 📎 button in the box** attaches files from a picker, for when there's nothing handy to drag.
- **Pictures show as pictures.** Attached screenshots and images get a thumbnail in the box and a preview in the conversation.

Big snips are shrunk to 2000 pixels on the long side before they go, which is about as much as Claude looks at anyway. They're kept in the data folder's `screenshots` folder for 30 days. Pasting something that carries text as well (a cell copied out of Excel) still pastes the text.

## 0.23.0: Shift+Tab switches mode

### New
- **Shift+Tab switches the permission mode,** just like in Claude Code. Press it in the message box to step through **Ask → Smart → Auto-edit → Plan** and back round. The chip and the hint under the box change as you go, and the new mode applies to every open conversation. **Autonomous** isn't in the loop on purpose: holding a key down should never land on the one mode that never asks. Pick it from the chip or Settings as before.

### Fixed
- **The little shell beside his messages is your shell now.** In his own shell, the mark in the chat (and the one that scuttles while he works) was always coral, whatever skin you'd picked. It now takes the colours of your skin's shell, so Classic gets teal, Midnight indigo, and so on. Shells he's grown into (the teacup, the golden conch…) still show as themselves.

## 0.22.2

### Fixed
- **A tab's own copy started in the right subfolder only when Windows spelled the path out in full.** Under a shortened folder name (like `C:\Users\RUNNER~1\`), a conversation started in a subfolder of a git project landed at the top of its copy instead. Shellby now asks git where the folder sits in the project rather than comparing the two spellings. This failed the checks for 0.22.0 and 0.22.1, so neither was published. 0.22.2 is the first release with everything from both.

## 0.22.1: the lights come on for slow boards

### Fixed
- **Desk lighting could never connect on some PCs,** including ones with Corsair memory. Shellby misread OpenRGB's description of each device, which shifted everything after it, so the lighting never matched up with the hardware.
- **OpenRGB on a board that takes a while to start** (memory and motherboard lighting found over SMBus can take a minute or more) no longer gets a second copy started on top of the first. The two fought over the hardware and neither one answered. Shellby now waits up to a minute and a half for the copy it started. If it still hasn't answered by then, the message says where to find it in the tray and what to check.
- **"New trick" no longer repeats itself.** A skill or plugin that briefly went missing from a scan and then came back (two cached versions of a plugin, or a skill deleted and put back) was announced as newly learned again. Each one is now announced only once.

## 0.22.0: answer from your phone, see what changed

### New
- **Allow or Deny from your phone.** With Telegram or ntfy set up under **Settings → Tell me when I'm away**, turn on **Let me answer Allow or Deny from my phone** and the permission notification gets the two buttons. Telegram uses inline buttons in your chat with the bot; ntfy's buttons answer on a second topic beside yours. Nothing goes through a server of ours. Each prompt carries its own single-use code that expires after 30 minutes, and the card on your desktop says **Allowed from your phone** when you do. Only your own private chat with the bot can answer, and on ntfy the topic has to be one nobody will guess (like the one Shellby picks) or the server needs a token. Questions, plans, **Always allow**, commands too long to read on a phone, and anything the desktop card would warn you about still wait for you at the desk. Answering at the desk takes the buttons off the phone.
- **See what every turn changed.** In a git project each turn now ends with a **± files changed** block: every file it touched, with lines added and removed. Click a file for its diff. **Undo** (press it twice) puts those files back the way they were before the turn, and refuses if any of them changed again since. It sees everything the turn did, including files written by scripts and installs, not just Claude's own edits. Your staging area, branches and stash are never touched.
- **A copy of the project for each tab (optional).** **Settings → Working folder → Give each new conversation its own copy of a git project** gives each new tab its own git worktree on its own branch, starting from your last commit, so two tabs in one repo stop stepping on each other. The branch shows next to the folder. **Bring it home** commits what's left, merges it into the branch it came from and removes the copy; **Throw it away** deletes it unmerged. A merge that would clash is backed out completely, with an offer to have him sort it out on his own branch. Routines and his own errands (like **Look over my changes**) still work in your real checkout.

## 0.21.3: a fresh coat for the README

### Fixed
- **A "⚙ 0" badge sat on every crab** in the top-left corner, even with nothing left running in the background. It now only shows up when there's actually something to see.
- **"fingers crossed" read as "Angers crossed"** in his speech bubble: the pixel font joins "fi" into one glyph that looks like an "A". Every "fi" in his bubble is spelled out now — *"this file again?"* included.

### Docs
- **The README is rebuilt around everything since 0.17:** his voice, the shells he grows into, the `shellby` command and MCP server, phone notifications, the OBS overlay, desk lighting, the new packs and crabs, the security read and tickable chats. A **What's new** grid sits near the top.
- **New pictures, all rendered from the real app:** a banner, lineups of the head-to-tail sets, the new crab species and his moods, the phone-notification QR screen, refreshed screenshots, and a new demo reel in which he talks while he works. `python scripts/make-banners.py` rebuilds the composites after `npm run screenshots`.

## 0.21.2

### Releases
- **A release can't go out wrong any more.** 0.21.1 was briefly published empty, which broke "Check for updates" with a missing latest.yml. The release build now stops before building if the tag doesn't match the version, has moved to another commit, or already has a published release. Before publishing, it checks the installer, portable build, blockmap, checksums and a latest.yml for that exact version are all there. If a tag is pushed again, the older run is cancelled instead of racing it.

## 0.21.1: nobody gets left at the edge

### Fixed
- Helper crabs no longer get cut off when they spawn. One that arrived just as another finished was pushed past the edge of Shellby's window, and one that arrived just after could stay clipped until the crew changed again.

## 0.21.0: he sets it up himself

### New
- **Phone notifications in one scan.** Turn on **Settings → Tell me when I'm away** and Shellby picks an ntfy topic nobody will guess and shows a QR code. Scan it with your phone, open the link in the free ntfy app, and press **Send a test**. No account, nothing to type.
- **Telegram finds your chat by itself.** Paste your bot's token, send the bot any message, and Shellby fills in the chat id (or press **Find my chat**).
- **OpenRGB, installed for you.** **Settings → Desk lighting → Install OpenRGB for me** installs it with winget after you confirm (Windows asks for permission too). Whenever the lighting is on, Shellby starts OpenRGB in the tray with its SDK server running, including when Shellby itself starts.

### Fixed
- Switching where notifications go no longer carries the old address over. A Telegram chat id would otherwise have become a public, guessable ntfy topic.
- 0.20.4 couldn't start: a line meant for the PATH update sat outside its function. Its release never published, so nobody got it.

## 0.20.4

### Fixed
- After **Add to my PATH**, a new Command Prompt opened from the Start menu still said "'shellby' is not recognized" until you signed out. Shellby now tells Windows the PATH changed, so the next terminal you open has it.

## 0.20.3

### Fixed
- **`shellby` could go missing right after you added it.** Settings said it was ready, but cmd answered "'shellby' is not recognized". A test run of Shellby on the same PC was deleting the real command along with its own copy. Test runs now keep theirs to themselves.
- The **`shellby` command** card no longer says "Ready" while **React to Claude Code sessions outside Shellby** is off. The command reaches him through that, so the card now tells you to turn it on.

## 0.20.2

### Fixed
- The **Where**, topic and token boxes under **Settings → Tell me when I'm away** were plain white Windows controls. They now look like every other field in Shellby.

## 0.20.1

### Fixed
- The **OpenRGB** link in Settings was dark blue, hard to read and did nothing when clicked. It now matches the sea-glass links in chat and opens openrgb.org in your browser. Links in a helper's summary got the same color fix.

## 0.20.0: he gets out more

### Claude can drive him now
- **The plugin brings an MCP server with it**, so Claude can put a line in Shellby's bubble on purpose instead of Shellby guessing from hook events. A skill can have him say what it's up to, celebrate when a release actually lands, or put a hat on.
- **`status` works the other way round:** Claude can ask how the machine is doing — his level, what's running, CPU and GPU temperature, memory, a drive that's filling up — which is worth knowing before kicking off something heavy.
- **It cannot start tasks.** Anything running on this PC can reach that port, and spending your Claude subscription is not something a local port should be able to do. Shellby's own permission cards are still the only way work begins.

### A `shellby` command
- **Hand him a task from any terminal:** `shellby do "tidy my Downloads"`, in whatever folder you're standing in. Also `shellby say` and `shellby status`.
- **Settings → Claude Code everywhere → the shellby command** puts it on your PATH. It's appended, never prepended, so it can't shadow anything you already had, and removing it puts your PATH back exactly as it was.
- Starting a task needs a token Shellby writes into its own settings folder, so a web page can't do it, and **Autonomous is not reachable from a terminal** at all.

### He can tell you when you're not at the desk
- **Autonomous mode expects you to walk away**, and walking away meant missing the moment he raised a claw. Now a permission prompt, a finished run, a reset usage limit, a red build or an overheating GPU can reach your phone.
- **ntfy, Pushover, Telegram, a Discord or Slack webhook, or your own endpoint.** One pasted address, no account, no app to install, and nothing goes through a server of ours. Off until you ask for it, and **Guard my focus holds them back** unless you say otherwise.
- A task that took four seconds doesn't buzz your pocket; the prompts that need you always get through.

### On a stream
- **Settings → On a stream** serves him as an OBS browser source on a transparent background: the same crab, the same outfit, the same animations, reacting live in the corner of a stream.
- It's the critter's own stylesheet and sprite builder behind it, so he can't drift out of sync with the one on your desktop, and it listens on 127.0.0.1 only.

### Your desk lights up with him
- **Through [OpenRGB](https://openrgb.org):** coral while he works, amber when he needs you, red when a build goes red or something overheats. No account, no cloud, no vendor software.
- Health beats CI beats what he's doing, so an overheating GPU is what the room shows you.

### He listens along
- **Shellby notices what's playing** — Spotify, a browser tab, anything in the volume flyout — and **puts his headphones on**, with the odd remark about it. Read from Windows itself, so there's no account and nothing leaves the PC.
- A **Now Playing** pack comes with it: a boombox, a vinyl record, a microphone, and notes drifting up while it plays.

### He can see more of your PC
- **AMD and Intel cards get the rest of their gauges.** Load, memory, power and fan speed were only ever read for NVIDIA; now whatever LibreHardwareMonitor knows about your card shows up beside its temperature.
- **Drive temperatures, case fans and the battery** are read too, and a drive cooking itself gets its own warning — an NVMe throttles somewhere around 75°C and nothing else tells you.
- **HWiNFO works now**, through its Remote Sensor Monitor, for the people who already run that instead.
- **What Docker, WSL and the package caches are sitting on.** On a developer's PC these are usually the biggest things on the drive and none of them show up as something you can point at. He'll say when there are tens of gigabytes to reclaim, and **Ask Shellby** comes back with what's safe to clear and the exact command — it never prunes or deletes anything itself.

### He knows which editor you're in
- Three Claude Code sessions open in three places used to read as three identical "Claude Code" rows. Now it's **"shellby in Cursor"**, or VS Code, Windsurf, Zed, a JetBrains IDE, Windows Terminal and the rest.
- The hook works it out and sends **one word**: the paths it recognised it from carry your user name, and those stay on your PC.

### Eleven more packs to wear
- **The empty slots are filled in.** His shell had three things you could put on it and his face had four, so there are now ten things for the shell — a backpack, a satellite dish, a bonsai — nine for the face, and seven for his neck. Two of the face items ride his eyes, so they scan along with him while he reads.
- **Sets that dress him head to tail:** a dev desk with a rubber duck, a tide pool he'd actually come from, and an on-call kit with a pager and an extinguisher. Each one covers every slot, so you can wear the whole thing at once.
- **The quiet seasons got their due.** Summer, autumn and Valentine's had two items each. They have ten, ten and nine now — a parasol, a wheat sheaf, cupid wings — and the look he puts on when a season opens actually uses them. Valentine's used to hand him a rose and leave it there; now he turns up in heart antennae, a blush and a pair of cupid wings. Seasonal items are still only collectable while their season is running, so be around for it.
- **Ten new crabs:** four that aren't the classic shape at all — a fiddler with one enormous claw, a crab that outgrew its shell, a flat one, and one that's mostly legs — and six recolours for a themed desktop, including a monochrome one and a pale one for light wallpapers.
- **Most of it is earned, not handed to you.** Twenty-two of the new pieces hang off trophies you already have: the rubber duck arrives when you let him run a script he wrote, the barnacles after seven days together, the starfish once you've petted him twenty-five times. Trophies hand out two or three things each now instead of one.
- All of it is in the app, so it's there the moment you update — nothing to download, nothing to turn on. The wardrobe holds 119 things to wear and 12 crabs, and 91 of them are still waiting on a trophy or a season.

### He can look over your changes
- **The shield next to a project in Trophies** hands the work you haven't pushed yet to Claude for a security read: your uncommitted changes, plus the commits on this branch that aren't on the default one. He comes back with a list — file, line, what someone could do with it, and the smallest fix — worst first.
- **He reads and reports, and changes nothing.** The prompt tells Claude not to edit, commit, push or fix, and the task runs in **Ask-first** mode whatever mode you're in, so every tool it reaches for still comes to you. Only a folder he already knows as one of your projects can be reviewed.
- **He won't give you a clean bill of health.** Finding nothing, he says what he looked at and what still wants a human: it's one read of one diff, not an audit. There's no trophy or XP for a clean result either, so there's nothing to farm.
- **A focus session wears a helmet now.** ⛑️ replaces the shield on the Focus card, in Claude Code's status line and on the Deep Focus trophy — which is what Shellby actually puts on while he guards you anyway. The shield moved to the review.

### Chats you can tick off
- **A ✓ on every row in History** marks that conversation done. The list shows what isn't done by default, so the twenty you've finished with stop burying the two you haven't — and **Not done / Done / All** appears above the list once you've ticked anything, with a count on each.
- **Nothing is deleted or hidden for good.** A done chat still opens, still searches, and still turns up in the command palette. Ticking one brings up an **Undo**, and sending it something new marks it not done again on its own — you're clearly not finished with it.
- It's kept with the rest of your history, on your PC, so it's still there next time he starts.

### Tabs you can put in order
- **Drag a tab along the strip** to move it. The ones you cross slide out of the way as you go, and if the strip is too full to show where you're heading, holding the tab against either edge scrolls it along. Let go and that's where it stays.
- **The order comes back with the tabs.** It's the same order he reopens your conversations in, so the one you keep returning to can sit on the left instead of wherever it happened to open.
- **Ctrl+Shift+PageUp / PageDown** moves the tab you're in one place over, for when dragging isn't an option. Ctrl+K knows how to do it too.

## 0.19.0: steadier on his feet

### Updating is a button now
- **Settings → About tells you where you stand:** the version you're on, whether a new one is waiting, and a progress bar while it downloads. When it has landed, **Restart and update** installs it and brings Shellby back — no more closing him twice to find out there was an update at all.
- **Check for updates** is there too, for when you don't want to wait for the six-hourly check. A failed check says why (offline, rate-limited) instead of going quiet.
- **The same button is in the tray menu**, so you never have to open the panel for it, and a dot on the ⚙ gear says an update is waiting from whatever screen you're on. The "update ready" notification now takes you straight to it.
- Quitting Shellby still installs a downloaded update, exactly as before.

### When something goes wrong
- **Report a problem**, in his right-click menu, opens a GitHub issue with the facts already filled in: his version, your Windows build, whether Claude Code was found, and the last lines of his log. Your home folder is shortened to `~` and anything token-shaped is cut out before you ever see it, and nothing is sent anywhere until you've read it and pressed submit.
- **He keeps a log** now, in `logs/` inside his data folder. Until now a crash took him off the desktop with nothing written down at all.
- **A stray error no longer makes him disappear.** He carries on, says so once, and writes it down.

### Kinder to your battery
- **He stops animating when you aren't looking.** The drifting light and his breathing stop while the panel isn't the window in front, and everything in both windows stops while your screen is locked — together, about half of what he costs when idle. Spinners and progress carry on, so a task that's still running still looks like one.

### Tasks can fix your CI now
- **"…including changes to CI workflows"**, under **Settings → GitHub**. `repo` access was never enough to push a file in `.github/workflows` — GitHub refuses those pushes without a scope of their own — so "Shellby, fix my failing build" got all the way to the push and then failed. Turning this on asks GitHub for that permission.
- It's **off by default and its own decision**, not folded into "Let Claude tasks push", because a workflow is what runs on GitHub's machines with your repository's secrets. Shellby spells that out before asking, and it can't be granted by a first sign-in.

### Claude Code in an unusual place
- **Find it myself…** in setup, for when Shellby can't find Claude Code where it normally lives: a portable copy, another drive, a locked-down work PC. He runs the file once to check it really is Claude Code before keeping it, so a wrong pick tells you straight away instead of becoming a task that won't start.

### Fixed
- **A crash can no longer empty your conversation list.** The index of past conversations was written in place, so losing power partway through left a half-written file — which reads as empty and took every conversation out of History with it. It goes through a temp file and a rename now, the way settings always have. A half-written last line in a transcript is skipped rather than discarding the rest of it.
- **Old transcripts no longer pile up for ever.** History keeps 200 conversations, but the ones that fell off the end left their transcripts in the data folder with nothing listing them and nothing able to delete them. They go with their entry now, and any left behind by older builds are cleared on the next start.
- **A full or locked disk can't take him down mid-task.** Antivirus holding a file, a cloud-synced folder, a disk with nothing left: writing a transcript line is allowed to fail quietly and go to the log, instead of throwing in the middle of a running task.
- **A very long conversation stays quick.** An overnight run with thousands of steps kept every one of them on screen for the life of the window. The oldest are hidden now, with a line saying how many — and the whole conversation is still in History.

### Under the hood
- The twelve end-to-end checks that need no Claude account now run in CI, so the panel and the desktop crab are covered by something other than a person remembering to run them. ESLint runs there too.
- `scripts/idle-cost.js` measures what he costs while doing nothing, per process, with the numbers written down in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#what-he-costs-when-idle).

### Open source, properly
- **He's GPL-3.0 now**, up from MIT. Nothing changes if you just use him, and he's still free and still yours to read and change. The difference is for anyone handing out a changed version: it has to stay open under the same licence, so fixes come back to everyone instead of vanishing into a closed-source app. Everything up to and including 0.18.0 stays MIT.
- **The name and the crab are reserved**, in the new [TRADEMARK.md](TRADEMARK.md). Fork the code all you like — give your crab its own name, so nobody downloads a fork thinking it's this one.
- **Pull requests now say what licence they land under**, in [CONTRIBUTING.md](CONTRIBUTING.md), so the project can keep being licensed as a whole.

## 0.18.0: he has a voice

### New
- **He says things.** The bubble that used to hold a single mark now holds a few words of his own: *"on it"* while he works, *"nailed it"* when it lands, *"uh oh"* when it doesn't. He never quotes Claude; the lines are all his.
- **He reacts to what the work actually is,** not just that work is happening. A test run gets *"fingers crossed"* and passing tests *"all green!"*; a push that lands gets *"shipped it"*; a big write gets *"phew"*; the third visit to the same file gets *"this file again?"*. Three helpers out and he mentions the crowd; a task still going after three minutes gets *"bear with me"*.
- **He notices the time and your absence.** A *"morning"* first thing, *"you too?"* in the small hours, and *"you're back!"* when Shellby hasn't run for a few days.
- **Little habits when he's idle.** He digs a hole in your wallpaper, buffs his shell, leans out to peek at what you're doing, has a proper stretch, or flops over for a moment. They're separate from his strolls, which **Settings → Look → stroll** still governs.
- **Your crab has a temperament.** Every install picks one of four — chipper, fussy, cocky or sleepy — from a seed made on first run, so it never changes on you. It adds lines of its own (a cocky crab says *"obviously"*) and shifts which idle habits he favours (a sleepy one flops more).
- **A chirp when he speaks,** synthesized on the spot rather than shipped as audio files. **Off by default**, under **Settings → Look → Chirp when he speaks**.

### How talkative he is
**Settings → Look → Personality** has three settings, and **Normal** is the default:
- **Quiet** is exactly the Shellby you had before: a single mark in the bubble, never a word.
- **Normal** lets him say a few words about what he's up to, with at least 40 seconds between any two lines.
- **Chatty** shortens that to 12 seconds and lets him mutter to himself when nothing's happening.

He never speaks while he's guarding your focus, he never repeats a line while another one is unused, and anything that matters — a health warning, a red build, a countdown — still takes the bubble back off him.

### Install and packaging
- **winget manifests** for `winget install x-salmon.Shellby`, in [packaging/winget](packaging/winget). `winget` fetches with its own HTTP client, so it usually skips the SmartScreen dialog entirely, and it checks the installer's SHA-256 from the manifest. The first submission to `microsoft/winget-pkgs` is manual; every release after that is updated by the release workflow when a `WINGET_TOKEN` secret is set.
- **Two free stopgaps for SmartScreen** written up in [docs/SIGNING.md](docs/SIGNING.md): submitting each build to Microsoft's file-submission form, and publishing to winget. Neither replaces code signing, and both are explained alongside what they don't fix.

## 0.17.0: Shellby's own life

### New
- **He grows into new shells.** Hermit crabs move into bigger shells as they grow, and now Shellby does too: level 3 brings a Snail Shell, then a Tin Can (level 5), a Teacup (8), a Toy Brick (12) and the Golden Conch (20). The level-up that unlocks one plays a molt on your desktop: he crawls out of the old shell, shivers for a moment without one, and the new shell drops onto his back. Pick any shell you've grown into under **Outfits → Homes**, including the one he hatched with.
- **Pet him.** Rub the mouse back and forth over him (no clicking) and he squints happily, wiggles and sends up hearts. Petting a sleeping Shellby wakes him up.
- **Throw him.** Flick him while dragging and he tumbles through the air, bounces off the screen edges and lands on the taskbar. Where he lands is his new spot.
- **He strolls a little.** When he's idle and awake he sometimes ambles a few steps (sideways, like a crab) and always stays near his spot. Turn it off in **Settings → Look**.
- **He guards your focus.** Right-click him (or the tray icon, or Ctrl+K) → **Guard my focus** for 15, 25 or 50 minutes. He puts on a helmet and counts down in his bubble, and notifications that can wait are held back and summed up afterwards. A task waiting for your OK and health alerts still come through. When time's up he takes a short break with you. A finished session earns 15 XP and keeps your streak going, and the **Focus** card on Trophies & XP shows the clock.
- **He watches CI on your pull requests.** Turn it on in **Settings → GitHub**. When a build goes red he holds up a ✗ sign and his bubble says so, when it's fixed he dances, and a review request makes him raise a claw. Settings lists your open pull requests, and **Ask Shellby why** starts a task that reads the failing logs and explains them without changing anything. Public repos need nothing beyond the sign-in; private ones need "Let Claude tasks push" too.
- **Four new trophies:** Good Crab (secret) for petting him, Frequent Flyer (secret) for throwing him, Deep Focus for 5 focus sessions and Green Light for fixing a red build. They unlock Heart Shades, an Aviator Cap, a Guard Helmet and a Green Flag.
- **A heads-up when your usage limit resets.** When Claude Code says your 5-hour or weekly limit is reached, Shellby tells you when it resets and naps with a countdown in his bubble. The moment it resets he wakes up with a big stretch and taps you, so anything you queued can go. It also works after your PC wakes from sleep or Shellby restarts.
- The status line shows a running focus session (`🛡️ focus 18m`), red CI (`❌ CI`) and when a reached limit resets (`⏳ limit · back in 2h 5m`).

## 0.16.4

### Docs
- **A quicker README.** A three-step "Get started" sits right under the demo, the demo is the one image at the top, badges show the latest release, downloads and license at a glance, and the screenshots are bigger.
- **Developer docs have their own page.** Building, every test and maintenance script, and the map of the code moved to [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md), linked from CONTRIBUTING.md.
- **An everyday Outfits screenshot,** so the README doesn't look out of season after Halloween.
- **GitHub now recognizes the MIT license.** The fonts note moved from LICENSE to the README footer, so LICENSE is the standard MIT text (same terms as before).

## 0.16.3

### Fixed
- **"No XP yet" fits on one line** in Trophies & XP. Before your first XP it was squeezed into a narrow column, one word per line.

### Docs
- **An easier-to-read README.** It now leads with the crab, each section opens with a few one-line points, and the longer explanations, protocol notes, script list and project layout fold away until you open them.
- **Clean screenshots of Shellby's screen.** A trophy card was covering the Outfits and Trophies & XP screenshots; the screenshot script now clears it first.

## 0.16.2

### Docs
- **A new demo at the top of the README**, recorded with the 0.16 layout: the bottom bar with Shellby leading it, helper crabs, and a trophy unlocking.

## 0.16.1

### Docs
- **The README catches up** with everything through 0.16.0: the bottom bar, Ctrl+K and the other shortcuts, question cards, one-click plugin install, the plain-text status line in cmd.exe, and Find Shellby. Its screenshots now show the new layout, and the project layout and test-script list are complete again.

## 0.16.0: easier to get around

### New
- **A labeled bar along the bottom of the panel**: Shellby, Chat, Toolbox, Routines, Health and History, always visible, with the current screen lit up. Shellby leads it, drawn as himself in whatever he's wearing. The title bar keeps just Settings, search, and the window buttons.
- **Shellby's own screen.** Outfits and Trophies & XP are now two tabs of one screen, instead of the Wardrobe hiding behind the logo and Trophies hiding inside the Wardrobe. Click the yellow level badge to go straight to your level, XP and streak.
- **Jump anywhere with Ctrl+K** (or the magnifier in the title bar). Type a few letters to open any screen, any Settings section, a permission mode, a past conversation, or a skill or command (it's put in the composer for you).
- **Keyboard shortcuts for every screen in the bar:** Ctrl+1 for Shellby through Ctrl+6 for History.
- **Settings has section links.** A row of links (Mode, Folder, Look, Claude Code, GitHub and more) stays at the top while you scroll, and highlights where you are.

### Changed
- **Back and Esc go up one level.** From the Skill Shop they return to the Toolbox instead of jumping all the way to Chat. Esc on any other screen goes home, and Esc on the home screen hides the panel, as before. In just-the-crab mode, Health is home.
- **Clicking the screen you're already on** scrolls it back to the top (or, in Chat, puts the cursor in the composer) instead of quietly switching to Chat.
- **Trophy celebrations and notices sit just above the bottom bar** on every screen, instead of floating over the middle of what you're reading.
- History's note now says exactly where to clear it: Settings → About → Data folder.

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
