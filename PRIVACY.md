# Privacy policy

*Last updated: 4 October 2026, adding crash reports.*

Shellby is a desktop app that runs on your PC. It has **no servers, no accounts of its own, no telemetry and no analytics**. Nobody behind Shellby, including its author, receives anything about you or how you use it, except a crash report you choose to send (below).

What Shellby does do is talk to a few services on your behalf: GitHub to check for updates, and others only when you use a feature that needs them. This page lists every one, what goes to it, and how to turn it off.

## Automatic, for everyone

**Update checks (GitHub Releases).** At startup and every 6 hours, the installed version asks GitHub's servers for `x-salmon/shellby`'s latest release, downloads it in the background when there is one, and installs it when you quit or click **Restart and update**. GitHub sees an ordinary download request (your IP address, the app's version). This can't be switched off in Settings; the portable build never updates itself.

**Claude Code.** Shellby doesn't contact Anthropic itself. It runs the official `claude` command-line tool that you installed and signed in to, and that tool sends your prompts and the files Claude reads to Anthropic, under [Anthropic's terms](https://www.anthropic.com/legal/consumer-terms) and [privacy policy](https://www.anthropic.com/legal/privacy). If you choose **Just the crab** and never set up Claude Code, none of this happens.

## Only when you use the feature

| Feature | Who it talks to | What's sent | When |
|---|---|---|---|
| **GitHub sign-in** | GitHub | The sign-in code you approve, then requests for your profile and avatar | When you sign in. Off by default. |
| **Sync** | GitHub (a *private* gist in your account) | Trophies, XP and its log, outfit, skin, project names and their GitHub remote addresses (e.g. `github.com/you/repo`), stats, and a random ID for this PC | Every 15 minutes and shortly after changes, while Sync is on. Off by default. |
| **CI status** | GitHub | Searches for your open pull requests and ones awaiting your review, and their check results | Every 3 minutes, while it's on. |
| **Visiting crabs** | GitHub (a *public* gist in your account, and your friends' gists) | Your calling card: GitHub username, skin, shell, level, outfit, sticker art, his temperament and his favourite find from digging, and up to 3 project names only if you pick **Shell and names**. Waves are posted as gist comments. | Every few minutes, while it's on. Turning it off deletes your card. Off by default. |
| **Profile card** | GitHub (a *public* gist in your account) | An SVG picture: your GitHub username, crab and outfit, level and title, streak length, and the art of your five latest stickers (no project names; hidden projects left off). A GitHub Action you add to your profile repository copies it there. | When it changes, and at most once a day otherwise, while it's on. Turning it off or signing out deletes the gist; the copy in your profile repository stays until you remove it. Off by default. |
| **Publishing a Wardrobe pack** | GitHub | Your pack, as a pull request to `x-salmon/shellby-packs` | When you publish one. |
| **Let Claude tasks push** | GitHub, through `git` and `gh` in your tabs | Your GitHub sign-in is handed to the Claude Code tasks Shellby runs, so they can push | Off by default, with a warning before it's turned on. |
| **Community packs and outfit codes** | `x-salmon.github.io/shellby-packs` | Requests for the pack index, catalog and pack files | When you open a `shellby://install` link or paste an outfit code that needs items you don't have. |
| **Phone notifications** | The service you pick: ntfy (or your own ntfy server), Pushover, Telegram, a Discord or Slack webhook, or your own endpoint | The notification's title and text and the project's name. For permission prompts that includes what Claude is asking to do, such as a command or a file path. | When an event you chose happens. Off by default, and the destination is confirmed in a separate window before anything is sent. |
| **Answering from your phone** | ntfy or Telegram | Shellby checks for your Allow/Deny reply | Only while a prompt is waiting. Off by default. |
| **Dependency watch** | The npm registry, through `npm outdated` and `npm audit` | The names and versions of each npm project's dependencies, as npm normally sends them | Once a week, for the npm projects you work in. Off by default. Fixing what it finds is a Claude Code task you start, which can open a pull request. |
| **Workflow web requests** | Any address you type into a workflow's **Web request** step | Whatever that step is set to send, including workflow secrets you put in it | When the workflow runs. |
| **Git** | Your project's own remote (e.g. GitHub) | `git fetch` and `git push`, with your usual git credentials | When you open a tab's repository menu, **Push**, or **Bring it home and push**. |
| **Skill Shop, MCP servers and the Shellby plugin** | The source of whatever you install (usually GitHub), through Claude Code | Claude Code's download requests | When you install or update one, after a confirmation window. |
| **Installing OpenRGB** | OpenRGB's GitHub releases, through winget | winget's download request | When you click install and confirm. |

**Crash reports (Sentry).** When Shellby crashes, hits an error it carries on from, or closes without being quit, it gets a report ready and keeps it on your PC (`%APPDATA%\Shellby\sentry`). The first time, it asks: **Send report**, **Always send** or **Don't send**. Nothing goes until you answer, and you can change it in **Settings → About → Crash reports** (Ask me each time, Always send, Never send). A report goes to [Sentry](https://sentry.io/privacy/), the crash-report service Shellby uses, and has:

- the error and where in Shellby's code it happened
- Shellby's, Windows' and Electron's versions, and basic facts about your PC: CPU, memory, graphics card, screen size, language and time zone
- what Shellby's windows and processes were doing just before (opened, closed, crashed)
- for a close without quitting, the log's last 40 lines from that run
- for a crash of the app itself, a crash dump: where each part of the app was, which can hold fragments of whatever it was working on at that moment

Your home folder becomes `~` and anything token-shaped is cut from all of it, and the PC's name is removed. Error messages and log lines can still name files and projects (an error about a missing file says which file). Not collected: your conversations, prompts, the contents of your files, the addresses Shellby talks to, console output, usage or sessions. Sentry sees the IP address a report comes from, as any server does. A report you turn down is deleted from your PC, and so is everything waiting when you choose **Never send**. Unsent reports are deleted after 30 days, and at most 30 are kept.

**Report a problem** only opens a new GitHub issue in your browser, filled in with your Shellby, Windows, Electron and Claude Code versions and the log's last 40 lines (with your home folder and anything token-shaped removed). Nothing is sent until you read it and submit it yourself.

What these services do with your data is up to them, under their own policies: [GitHub](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement), and whichever notification service you pick.

## What never leaves your PC

- **Your PC's health readings:** temperatures, CPU, memory, disk, which apps are using them, what starts when you sign in, and LibreHardwareMonitor, HWiNFO and `nvidia-smi` readings. Shellby reads these to show them to you. They're only sent anywhere if you press one of the **Ask Shellby why** buttons (which hands them to a Claude Code task you can see) or turn on health alerts for phone notifications.
- **Push-to-talk audio.** Windows' offline speech recognizer hears it, on your PC. The microphone is only open while you hold the shortcut.
- **The time tracker.** It reads the title of the window in front to tell which project you're in, and keeps only the project, the day and the minutes. It is never synced.
- **Which apps he perches on**, Now Playing, your usage counts and weekly summaries.
- **Toolbox → Lean.** To tell which plugins and MCP servers sit idle, Shellby reads Claude Code's own transcripts on this PC (`.claude\projects`), and keeps only the names of the skills, agents, commands and servers used and when. Never what was said. It also keeps token counts per day (how much came from the prompt cache) and what a new conversation carries before your first word.
- **The local connections** for the `shellby` command, the Claude Code plugin and hooks (port 47913), the OBS overlay (port 47914, off by default), OpenRGB and sensor apps. They only accept connections from this PC (`127.0.0.1`).

## What's stored on your PC

- **`%APPDATA%\Shellby`:** settings, conversation history (`sessions`), logs (your home folder and anything token-shaped is scrubbed out of them), screenshots, your Wardrobe and skins, routines and workflows, prompt history, and Shellby's copies of your repositories (`worktrees`).
- **`%LOCALAPPDATA%\Shellby`:** the `shellby` command.
- **`Pictures\Shellby`:** crab and week cards you save. Chat exports go where you choose to save them.
- **Secrets are encrypted** with Windows' data protection, tied to your Windows account: your GitHub sign-in, your notification service's token, and workflow secrets. If Windows can't encrypt them, Shellby won't store them.

### Deleting your data

Uninstalling Shellby removes the app but **keeps your data**, so a reinstall picks up where you left off. To remove everything, uninstall and then delete `%APPDATA%\Shellby`, `%LOCALAPPDATA%\Shellby` and `Pictures\Shellby`.

Things stored in your GitHub account stay there until you remove them: turn off Visiting crabs to delete your calling card, turn off Profile card to delete its gist (and remove `shellby-profile.svg` from your profile repository yourself), delete the `shellby-sync.json` gist from [your gists](https://gist.github.com), and revoke Shellby under [GitHub → Settings → Applications](https://github.com/settings/applications).

## Changes

Any change to what Shellby sends goes in this file and in the [changelog](CHANGELOG.md), and this page's history is public in the repository.

## Questions

Open an issue at [github.com/x-salmon/shellby/issues](https://github.com/x-salmon/shellby/issues). For anything you'd rather not post publicly, use GitHub's private reporting (the repository's **Security** tab → **Report a vulnerability**).
