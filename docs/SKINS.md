# Making a Shellby skin

A skin is one JSON file: a pixel grid, a palette, and a map that says which body part each colour belongs to (so the animations know what to move).

## Try it in 2 minutes

1. Right-click Shellby → **Data folder**, then open `skins/` (or **Settings → Look → Open skins folder**).
2. Copy [`src/skins/classic.json`](../src/skins/classic.json) in, rename it `my-crab.json`, and change `"id"` to `"my-crab"`.
3. Change some colours, then hit **Reload** in Settings and pick your skin.

## Format

```jsonc
{
  "id": "my-crab",              // letters, numbers, - and _ ; matches the filename
  "name": "My Crab",
  "author": "you",
  "description": "One line shown on hover.",
  "palette": {                   // one character → one #rrggbb colour
    "S": "#1d5f5a",
    "b": "#ff7a5c",
    "e": "#16201f"
  },
  "parts": {                     // which animated part each character belongs to
    "S": "shell",
    "b": "body",
    "e": "eyes"
  },
  "pixels": [                    // up to 32 rows × 40 columns; "." (or any unmapped char) is transparent
    "..SSSS....",
    ".SSSSSbb.e",
    "..SSSSbbbb"
  ]
}
```

### Parts and what they do

| Part | Animation |
|---|---|
| `shell` | Stays put. Rocks gently while Shellby naps. |
| `body` | Tucks into the shell when he sleeps. |
| `claw` | Snaps while working, raised while asking, waves on hover. Rotates from its left edge. |
| `eyes` | Blink when idle, scan while working. |
| `stalks` | Move with the eyes. |
| `legs` | Split automatically into alternating groups that scuttle while working. Each separate leg should be its own connected shape. |
| `extra` | Decorations (hats!). No animation. |

### Tips

- Keep the classic proportions (22×13) and he'll sit nicely in the window at every size setting.
- Face right: the panel's permission card crops him on that assumption.
- `python scripts/make-icons.py my-crab --preview out.png` renders a big preview (needs the file in `src/skins/` and Pillow).
- Shellby validates skins on load. Bad colours or oversized grids are skipped with a console warning, so a broken skin can't break the app.

## Sharing

Open a PR adding your file to `src/skins/`. Original designs only, please: no copyrighted characters or logos.
