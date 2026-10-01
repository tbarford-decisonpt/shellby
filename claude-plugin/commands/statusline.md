---
description: Show Shellby (mood, level, XP) in your Claude Code status line
---

Add Shellby, the desktop crab, to my Claude Code status line. Use the statusline-setup agent to make the change.

Shellby keeps a ready-made line in a temp file, plus a plain-ASCII twin for the classic Windows console (cmd.exe), which can't draw emoji. The segment is just this shell command (it prints nothing when Shellby isn't running):

```
bash -c 'd="${TEMP:-${TMPDIR:-/tmp}}"; f="$d/shellby-status.txt"; if [ "$OS" = Windows_NT ] && [ -z "$WT_SESSION$TERM_PROGRAM" ]; then f="$d/shellby-status-plain.txt"; fi; [ -f "$f" ] && cat "$f"; exit 0'
```

- If I don't have a `statusLine` yet, set it in my user settings (`~/.claude/settings.json`) to `{ "type": "command", "command": <that command>, "padding": 0 }`.
- If I already have one, keep it: make the status line print my existing output first, then " · " and Shellby's segment. Don't drop anything I already show.
- Don't change any other settings. Afterwards, tell me what changed and that I'll see Shellby in new sessions while the Shellby app is running.

(The Shellby app can also do this for me from Settings → Claude Code everywhere → Status line.)
