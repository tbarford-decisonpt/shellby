---
description: Show Shellby (mood, level, XP) in your Claude Code status line
---

Add Shellby, the desktop crab, to my Claude Code status line. Use the statusline-setup agent to make the change.

Shellby keeps a ready-made line in a temp file, so the segment is just this shell command (it prints nothing when Shellby isn't running):

```
bash -c 'f="${TEMP:-${TMPDIR:-/tmp}}/shellby-status.txt"; [ -f "$f" ] && cat "$f"; exit 0'
```

- If I don't have a `statusLine` yet, set it in my user settings (`~/.claude/settings.json`) to `{ "type": "command", "command": <that command>, "padding": 0 }`.
- If I already have one, keep it: make the status line print my existing output first, then " · " and Shellby's segment. Don't drop anything I already show.
- Don't change any other settings. Afterwards, tell me what changed and that I'll see Shellby in new sessions while the Shellby app is running.

(The Shellby app can also do this for me from Settings → Claude Code everywhere → Status line.)
