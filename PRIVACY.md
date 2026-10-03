# Privacy policy

*Last updated: 3 October 2026, for Shellby 0.54.1.*

Shellby is a desktop app that runs on your PC. It has **no servers, no accounts of its own, no telemetry, no analytics and no crash reporting**. Nobody behind Shellby, including its author, receives anything about you or how you use it.

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
| **Visiting crabs** | GitHub (a *public* gist in your account, and your friends' gists) | Your calling card: GitHub username, skin, shell, level, outfit, sticker art, and up to 3 project names only if you pick **Shell and names**. Waves are posted as gist comments. | Every few minutes, while it's on. Turning it off deletes your card. Off by default. |
| **Publishing a Wardrobe pack** | GitHub | Your pack, as a pull request to `x-salmon/shellby-packs` | When you publish one. |
| **Let Claude tasks push** | GitHub, through `git` and `gh` in your tabs | Your GitHub sign-in is handed to the Claude Code tasks Shellby runs, so they can push | Off by default, with a warning before it's turned on. |
| **Community packs and outfit codes** | `x-salmon.github.io/shellby-packs` | Requests for the pack index, catalog and pack files | When you open a `shellby://install` link or paste an outfit code that needs items you don't have. |
| **Phone notifications** | The service you pick: ntfy (or your own ntfy server), Pushover, Telegram, a Discord or Slack webhook, or your own endpoint | The notification's title and text and the project's name. For permission prompts that includes what Claude is asking to do, such as a command or a file path. | When an event you chose happens. Off by default, and the destination is confirmed in a separate window before anything is sent. |
| **Answering from your phone** | ntfy or Telegram | Shellby checks for your Allow/Deny reply | Only while a prompt is waiting. Off by default. |
| **Workflow web requests** | Any address you type into a workflow's **Web request** step | Whatever that step is set to send, including workflow secrets you put in it | When the workflow runs. |
| **Git** | Your project's own remote (e.g. GitHub) | `git fetch` and `git push`, with your usual git credentials | When you open a tab's repository menu, **Push**, or **Bring it home and push**. |
| **Skill Shop, MCP servers and the Shellby plugin** | The source of whatever you install (usually GitHub), through Claude Code | Claude Code's download requests | When you install or update one, after a confirmation window. |
| **Installing OpenRGB** | OpenRGB's GitHub releases, through winget | winget's download request | When you click install and confirm. |

**Report a problem** only opens a new GitHub issue in your browser, filled in with your Shellby, Windows, Electron and Claude Code versions and the log's last 40 lines (with your home folder and anything token-shaped removed). Nothing is sent until you read it and submit it yourself.

What these services do with your data is up to them, under their own policies: [GitHub](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement), and whichever notification service you pick.

## What never leaves your PC

- **Your PC's health readings:** temperatures, CPU, memory, disk, which apps are using them, what starts when you sign in, and LibreHardwareMonitor, HWiNFO and `nvidia-smi` readings. Shellby reads these to show them to you. They're only sent anywhere if you press one of the **Ask Shellby why** buttons (which hands them to a Claude Code task you can see) or turn on health alerts for phone notifications.
- **Push-to-talk audio.** Windows' offline speech recognizer hears it, on your PC. The microphone is only open while you hold the shortcut.
- **Which apps he perches on**, Now Playing, your usage counts and weekly summaries.
- **The local connections** for the `shellby` command, the Claude Code plugin and hooks (port 47913), the OBS overlay (port 47914, off by default), OpenRGB and sensor apps. They only accept connections from this PC (`127.0.0.1`).

## What's stored on your PC

- **`%APPDATA%\Shellby`:** settings, conversation history (`sessions`), logs (your home folder and anything token-shaped is scrubbed out of them), screenshots, your Wardrobe and skins, routines and workflows, prompt history, and Shellby's copies of your repositories (`worktrees`).
- **`%LOCALAPPDATA%\Shellby`:** the `shellby` command.
- **`Pictures\Shellby`:** crab and week cards you save. Chat exports go where you choose to save them.
- **Secrets are encrypted** with Windows' data protection, tied to your Windows account: your GitHub sign-in, your notification service's token, and workflow secrets. If Windows can't encrypt them, Shellby won't store them.

### Deleting your data

Uninstalling Shellby removes the app but **keeps your data**, so a reinstall picks up where you left off. To remove everything, uninstall and then delete `%APPDATA%\Shellby`, `%LOCALAPPDATA%\Shellby` and `Pictures\Shellby`.

Things stored in your GitHub account stay there until you remove them: turn off Visiting crabs to delete your calling card, delete the `shellby-sync.json` gist from [your gists](https://gist.github.com), and revoke Shellby under [GitHub → Settings → Applications](https://github.com/settings/applications).

## Changes

Any change to what Shellby sends goes in this file and in the [changelog](CHANGELOG.md), and this page's history is public in the repository.

## Questions

Open an issue at [github.com/x-salmon/shellby/issues](https://github.com/x-salmon/shellby/issues). For anything you'd rather not post publicly, use GitHub's private reporting (the repository's **Security** tab → **Report a vulnerability**).
