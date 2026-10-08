# Privacy policy

*Last updated: 7 October 2026, adding friends and settings to Sync, sharing the Bugdex, and what Claude is told about Shellby.*

Shellby is a desktop app that runs on your PC. It has **no servers, no accounts of its own, no telemetry and no analytics**. Nobody behind Shellby, including its author, receives anything about you or how you use it, except a crash report you choose to send (below).

What Shellby does do is talk to a few services on your behalf: GitHub to check for updates, and others only when you use a feature that needs them. This page lists every one, what goes to it, and how to turn it off.

## Automatic, for everyone

**Update checks (GitHub Releases).** At startup and every 6 hours, the installed version asks GitHub's servers for `x-salmon/shellby`'s latest release, downloads it in the background when there is one, and installs it when you quit or click **Restart and update**. GitHub sees an ordinary download request (your IP address, the app's version). This can't be switched off in Settings; the portable build never updates itself.

**Claude Code.** Shellby doesn't contact Anthropic itself. It runs the official `claude` command-line tool that you installed and signed in to, and that tool sends your prompts and the files Claude reads to Anthropic, under [Anthropic's terms](https://www.anthropic.com/legal/consumer-terms) and [privacy policy](https://www.anthropic.com/legal/privacy). If you choose **Just the crab** and never set up Claude Code, none of this happens.

## Only when you use the feature

| Feature | Who it talks to | What's sent | When |
|---|---|---|---|
| **GitHub sign-in** | GitHub | The sign-in code you approve, then requests for your profile and avatar | When you sign in. Off by default. |
| **Sync** | GitHub (a *private* gist in your account) | Trophies, XP and its log, outfit, skin, project names and their GitHub remote addresses (e.g. `github.com/you/repo`), stats, his tank's layout (which decor, finds, specimen jars and project stickers stand where, its size, floor, back glass and light; not whether you show it on your cards), his tank's saved layouts (their names, seasons and the same details; not which one a season put up on this PC), your Bugdex catches (how many of each kind, when, how quickly and in which languages; never projects or error text), your friends list (their GitHub usernames and card addresses, and ones you removed), your settings (permission mode but never Autonomous, model, effort, output style, hotkey, his size, on/off switches, chatter and mischief levels, spending guard, Work mode, pinned tools, and the text of your prompt snippets), and a random ID for this PC | Every 15 minutes and shortly after changes, while Sync is on. Off by default. |
| **CI status** | GitHub | Searches for your open pull requests and ones awaiting your review, and their check results | Every 3 minutes, while it's on. |
| **Visiting crabs** | GitHub (a *public* gist in your account, and your friends' gists) | Your calling card: GitHub username, skin, shell, level, outfit, sticker art, his temperament and his favourite find from digging, and up to 3 project names only if you pick **Shell and names**. With **Show his tank** on (Tank, off by default): his tank's size, floor, back glass and light, and up to 24 pieces as built-in decor and find names with where they stand (no specimen jars, no stickers, no decor from packs, no saved layouts, and nothing its gauges show). With **Share my Bugdex with friends** on (Settings → Safety nets, off by default): which kinds of bug you've caught, how many badges you hold and whether you've made the Hall of Fame; never counts, projects, times or errors. Friends' cards are fetched and drawn with your own Shellby's art; nothing on them is loaded from anywhere else. Waves are posted as gist comments. | Every few minutes, while it's on. Turning it off deletes your card. Off by default. |
| **Profile card** | GitHub (a *public* gist in your account) | An SVG picture: your GitHub username, crab and outfit, level and title, streak length, and the art of your five latest stickers (no project names; hidden projects left off). With **Show his tank** on (Tank, off by default), he stands in his tank: the same pieces the calling card would carry, drawn. A GitHub Action you add to your profile repository copies it there. To tick off the setup steps, Shellby reads (never writes) that public repository: whether it exists, the Action and card files, and your README. | When it changes, and at most once a day otherwise, while it's on. Turning it off or signing out deletes the gist; the copy in your profile repository stays until you remove it. Off by default. |
| **Built with Shellby (pull request badge)** | GitHub (a *public* repository in your account, `shellby-badge`, and the descriptions of your pull requests) | An SVG picture of your crab in his outfit (shell stickers from hidden projects left off), committed to `shellby-badge` (each new look is a new commit, so earlier looks stay in its history). Needs GitHub's `public_repo` permission, which covers all your public repositories; Shellby writes only to `shellby-badge` and your own pull requests with it. Pull requests your Shellby tabs open get that picture, your level and a link to Shellby added at the bottom of their description; only ones you authored. | The picture is uploaded only when a tab opens a pull request and his look has changed since the last one. Turning it off stops new badges; the repository stays so badges on earlier pull requests keep working, and you can delete it yourself. Off by default. |
| **Publishing a Wardrobe pack** | GitHub | Your pack, as a pull request to `x-salmon/shellby-packs` | When you publish one. |
| **Let Claude tasks push** | GitHub, through `git` and `gh` in your tabs | Your GitHub sign-in is handed to the Claude Code tasks Shellby runs, so they can push | Off by default, with a warning before it's turned on. |
| **Community packs and outfit codes** | `x-salmon.github.io/shellby-packs` | Requests for the pack index, catalog and pack files | When you open a `shellby://install` link or paste an outfit code that needs items you don't have. |
| **Phone notifications** | The service you pick: ntfy (or your own ntfy server), Pushover, Telegram, a Discord or Slack webhook, or your own endpoint | The notification's title and text and the project's name. For permission prompts that includes what Claude is asking to do, such as a command or a file path. | When an event you chose happens. Off by default, and the destination is confirmed in a separate window before anything is sent. |
| **Answering from your phone** | ntfy or Telegram | Shellby checks for your Allow/Deny reply | Only while a prompt is waiting. Off by default. |
| **Starting tasks from your phone** | Telegram (your bot's messages) or ntfy (a `<topic>-tasks` topic beside yours) | Shellby reads what you send: Telegram's long poll (one request about every 25 seconds) or the ntfy tasks topic (about every 15 seconds), from where it last read. It answers on the same channel with short lines: "On it", the folder's name, and for `/status` the titles of your open tabs and whether they're waiting for you, never file contents, diffs or commands. The task itself is a Claude Code task like any other. | While it's on, until Shellby quits. Off by default; turning it on is confirmed in a separate window, and changing the bot, chat or topic turns it off. |
| **Claude Code updates** | The npm registry (registry.npmjs.org) | One request for the `@anthropic-ai/claude-code` package page: your IP address, nothing else | Once a day while Claude Code is set up, to say when a newer version is out. **Leave it to me** in **Settings → About** stops it. Installing an update runs Claude Code's own `claude update`, which downloads from wherever Anthropic serves it. |
| **Dependency watch** | The npm registry, through `npm outdated` and `npm audit` | The names and versions of each npm project's dependencies, as npm normally sends them | Once a week, for the npm projects you work in. Off by default. Fixing what it finds is a Claude Code task you start, which can open a pull request. |
| **Workflow web requests** | Any address you type into a workflow's **Web request** step | Whatever that step is set to send, including workflow secrets you put in it | When the workflow runs. |
| **Git** | Your project's own remote (e.g. GitHub) | `git fetch` and `git push`, with your usual git credentials | When you open a tab's repository menu, **Push**, or **Bring it home and push**. |
| **Skill Shop, MCP servers and the Shellby plugin** | The source of whatever you install (usually GitHub), through Claude Code | Claude Code's download requests | When you install or update one, after a confirmation window. |
| **Installing OpenRGB** | OpenRGB's GitHub releases, through winget | winget's download request | When you click install and confirm. |
| **Weather** | [Open-Meteo](https://open-meteo.com/en/terms) (`api.open-meteo.com`, `geocoding-api.open-meteo.com`) | The town name you type when you search for it, then only your chosen town's latitude and longitude rounded to one decimal place (about 11 km). Nothing else about you; like any web request it carries your IP address, and Electron's usual headers (Shellby's name and version in the User-Agent, your language). | A search when you press **Find**; then every 30 minutes and when the PC wakes, while it's on. Off until you turn it on and pick a town. |

**Crash reports (Sentry).** When Shellby crashes, hits an error it carries on from, or closes without being quit, it gets a report ready and keeps it on your PC (`%APPDATA%\Shellby\sentry`). The first time, it asks: **Send report**, **Always send** or **Don't send**. Nothing goes until you answer, and you can change it in **Settings → About → Crash reports** (Ask me each time, Always send, Never send). A report goes to [Sentry](https://sentry.io/privacy/), the crash-report service Shellby uses, and has:

- the error and where in Shellby's code it happened
- Shellby's, Windows' and Electron's versions, and basic facts about your PC: CPU, memory, graphics card, screen size, language and time zone
- what Shellby's windows and processes were doing just before (opened, closed, crashed)
- for a close without quitting, the log's last 40 lines from that run
- for a crash of the app itself, a crash dump: where each part of the app was, which can hold fragments of whatever it was working on at that moment

Your home folder becomes `~` and anything token-shaped is cut from all of it, and the PC's name is removed. Error messages and log lines can still name files and projects (an error about a missing file says which file). Not collected: your conversations, prompts, the contents of your files, the addresses Shellby talks to, console output, usage or sessions. Sentry sees the IP address a report comes from, as any server does. A report you turn down is deleted from your PC, and so is everything waiting when you choose **Never send**. Unsent reports are deleted after 30 days, and at most 30 are kept.

**Report a problem** only opens a new GitHub issue in your browser, filled in with your Shellby, Windows, Electron and Claude Code versions and the log's last 40 lines (with your home folder and anything token-shaped removed). Nothing is sent until you read it and submit it yourself.

What these services do with your data is up to them, under their own policies: [GitHub](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement), and whichever notification service you pick.

**What Claude is told about Shellby.** With **Settings → Claude → Tell Claude it's running in Shellby** on (it is by default), each conversation Shellby starts carries a short fixed note saying so, and when your usage passes 80% or 95% a line with that percentage goes with your message. Claude can then ask for his status: his level, mood and what he's doing, your focus timer, when your usage resets, and your PC's latest health readings (temperatures, memory, disk). Like everything Claude reads, that goes to Anthropic through Claude Code. Turn the switch off and none of it is sent.

## What never leaves your PC

- **Your PC's health readings:** temperatures, CPU, memory, disk, which apps are using them, what starts when you sign in, and LibreHardwareMonitor, HWiNFO and `nvidia-smi` readings. Shellby reads these to show them to you. They're only sent anywhere if you press one of the **Ask Shellby why** buttons (which hands them to a Claude Code task you can see), turn on health alerts for phone notifications, or a Claude conversation in Shellby asks for his status (below).
- **Push-to-talk audio.** Windows' offline speech recognizer hears it, on your PC. The microphone is only open while you hold the shortcut.
- **The time tracker.** It reads the title of the window in front to tell which project you're in, and keeps only the project, the day and the minutes. It is never synced.
- **Which apps he perches on**, Now Playing, your usage counts and weekly summaries.
- **What each task cost.** For the "usually about 8% of your window" line, each finished turn keeps its project folder, model, what kind of ask it was (a fix, a review, a question…), how long the prompt was (short, medium or long), and how much of your usage window and how many tokens it took. Never the prompt itself. It's kept for 60 days, never synced, and **Clear all history** deletes it.
- **Typing along** (off until you turn it on in **Settings → Typing along**). Windows hands Shellby each key event, in any app, so he can tap along. He looks only at whether a key was let go and wipes the rest of the event straight away: never which key, never what you typed. His window on the desktop isn't even told when each key was pressed, only that some were, on a steady beat. From your speed he keeps one number, your fastest burst in words a minute.
- **Toolbox → Lean.** To tell which plugins and MCP servers sit idle, Shellby reads Claude Code's own transcripts on this PC (`.claude\projects`), and keeps only the names of the skills, agents, commands and servers used and when. Never what was said. It also keeps token counts per day (how much came from the prompt cache) and what a new conversation carries before your first word.
- **The local connections** for the `shellby` command, the Claude Code plugin and hooks (port 47913), the OBS overlay (port 47914, off by default), OpenRGB and sensor apps. They only accept connections from this PC (`127.0.0.1`).

## What's stored on your PC

- **`%APPDATA%\Shellby`:** settings, conversation history (`sessions`), logs (your home folder and anything token-shaped is scrubbed out of them), screenshots, your Wardrobe and skins, routines and workflows, prompt history, and Shellby's copies of your repositories (`worktrees`).
- **`%LOCALAPPDATA%\Shellby`:** the `shellby` command.
- **`Pictures\Shellby`:** crab and week cards you save. Chat exports go where you choose to save them.
- **Secrets are encrypted** with Windows' data protection, tied to your Windows account: your GitHub sign-in, your notification service's token, the passphrase for starting tasks from your phone over ntfy, and workflow secrets. If Windows can't encrypt them, Shellby won't store them.

### Deleting your data

When you uninstall Shellby, it asks whether to delete your data too. **No** is the default and keeps it, so a reinstall picks up where you left off. **Yes** deletes `%APPDATA%\Shellby` and `%LOCALAPPDATA%\Shellby`. Updates never ask and never delete anything. A silent uninstall (`/S`, as winget runs it) keeps your data unless you add `--delete-app-data`. `Pictures\Shellby` holds cards you saved, so it's always left alone. Delete it yourself if you don't want them.

Things stored in your GitHub account stay there until you remove them: turn off Visiting crabs to delete your calling card, turn off Profile card to delete its gist (and remove `shellby-profile.svg` from your profile repository yourself), delete the `shellby-badge` repository if you used the pull request badge (badges on earlier pull requests then show a broken image), delete the `shellby-sync.json` gist from [your gists](https://gist.github.com), and revoke Shellby under [GitHub → Settings → Applications](https://github.com/settings/applications).

## Changes

Any change to what Shellby sends goes in this file and in the [changelog](CHANGELOG.md), and this page's history is public in the repository.

## Questions

Open an issue at [github.com/x-salmon/shellby/issues](https://github.com/x-salmon/shellby/issues). For anything you'd rather not post publicly, use GitHub's private reporting (the repository's **Security** tab → **Report a vulnerability**).
