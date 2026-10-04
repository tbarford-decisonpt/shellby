# Out in the world

Your phone, your stream, your desk lights, your pull requests and your GitHub account. All optional, all off until you turn them on. Back to the [README](../README.md).

<p align="center"><img src="screenshot-away.png" width="420" alt="Settings → Tell me when I'm away: ntfy selected, a QR code to scan with your phone, and a topic Shellby picked"></p>

## 📱 Your phone

- **Tell me when I'm away:** a permission prompt, a finished run, a reset usage limit, a red build or an overheating GPU can reach your phone. **ntfy** is one QR scan with no account; **Telegram** finds your chat by itself; **Pushover**, a **Discord** or **Slack** webhook, or your own endpoint work too. Nothing goes through a server of ours, a four-second task doesn't buzz your pocket, and **Guard my focus** holds them back unless you say otherwise.
- **Answer from your phone (optional):** with Telegram or ntfy, **Let me answer Allow or Deny from my phone** puts the two buttons on the notification. Each prompt gets its own single-use code that expires after 30 minutes. Only your private chat with the bot counts, and an ntfy topic has to be one nobody will guess. Questions, plans, **Always allow**, long commands, and anything the card would warn you about still wait for you at the desk.

## 🎥 On a stream

**Settings → On a stream** serves him as an OBS browser source on a transparent background: the same crab, outfit and animations, reacting live in the corner. It's the critter's own stylesheet behind it, on 127.0.0.1 only.

## 💡 Desk lighting

Through [OpenRGB](https://openrgb.org): coral while he works, amber when he needs you, red when a build goes red or something overheats. **Install OpenRGB for me** does it with winget after you confirm, and he starts it in the tray whenever the lighting is on.

## ✅ CI on your pull requests

Sign in with GitHub, and when a build goes red he holds up a ✗ sign, when it's fixed he dances, and a review request makes him raise a claw. **Ask Shellby why** reads the failing logs and explains them without changing anything.

## GitHub sign-in

Sign in with a short code you approve on github.com, with no password typed into Shellby. GitHub is only asked for what the features you turn on need:

- **Sync between PCs:** trophies, collected items, XP, streak days, outfit and color, through a private gist. Syncing only ever adds progress.
- **Visiting crabs:** add friends by GitHub username and their crab drops by your desktop now and then, wearing their outfit, and leaves a souvenir in your guestbook. You can also invite them over or send a wave (a few fixed lines, so nobody can put words in your crab's mouth). It works through a small public "calling card" gist with your crab's look and level, and nothing else. Waves are comments on it, and only friends you added get through. Turning it off, or signing out, deletes the card. Its own switch, never turned on by a first sign-in.
- **Watch CI on your pull requests**, as above. Public repos need nothing beyond the sign-in; private ones need "Let Claude tasks push" too.
- **Your repositories on the Projects page**, to clone the ones that aren't on this PC yet.
- **Publish your Wardrobe packs** to the community gallery: Shellby forks it and opens the pull request for you.
- **Let Claude tasks push:** Shellby's tabs get your sign-in for `git push`/`pull`, `gh` and the official GitHub plugin. Off by default, with a warning before it's turned on.
- **…including changes to CI workflows:** its own switch, off by default, because a workflow runs on GitHub's machines with your repository's secrets. It can't be granted by a first sign-in.

Your name and avatar show in Settings and on your crab card. The sign-in is encrypted by Windows and never stored in settings.json.
