# Shell Stickers: every repo you ship leaves a mark on his shell

> Status: **built, all four phases, in 0.44.0.** The plan below is kept as written;
> where the build differs, it's listed here.

## What changed from the plan

- **One release, not four.** Phases 1–4 all ship in 0.44.0.
- **The calling card shows nothing about stickers by default** (the plan said "art").
  0.40.0 told everyone who turned on Visiting crabs that the card holds no projects, so
  sharing anything now needs a choice in the Sticker Book: **Nothing** (default),
  **His shell** (3×3 colour patches only) or **Shell and names** (adds your three
  most-shipped, full art and names).
- **Swaps go both ways.** A friend's crab only leaves a sticker when you share names too,
  and only on a visit that signs the guestbook. Gifts go in the book, not straight on
  the shell, are capped (3 per friend, 30 in all), and are the first to go when the book
  is full.
- **A new release or a merged PR always counts** toward the tier, even right after a
  push; only bursts of pushes are limited to once an hour. A draft release ships nothing.
- **Hiding a project syncs** between PCs (latest change wins), so a project kept off
  the card on one PC stays off everywhere.
- **Merged PRs** are found when an open PR leaves the CI watcher's list; a lookup that
  fails is retried a few times.
- **Sticker spots** are computed from each shell's shape (3–6 per shell), and the same
  spot number lands in the same place on a friend's crab, whatever skin it wears here.

The code: `src/main/stickers.js` (state, pure), `stickers/art.js` (drawing),
`stickers/slots.js` (spots), the `shell stickers` section of `main.js`, and
`src/renderer/panel/stickers.js` (the Sticker Book). Tests: `test/stickers.test.js`,
`scripts/e2e-stickers.js`, `scripts/e2e-stickers-molt.js`, and the swap in
`scripts/e2e-friends.js`.

## The pitch

Developers cover their laptops in stickers, one for every project, conference
and tool they've loved. Shellby carries his laptop on his back.

The first time you **ship** a repo (push it, deploy it, cut a release, merge a
PR), Shellby gets a sticker for it. Each sticker is pixel art generated from
the repo itself. He holds it up in his claw, turns, and **slaps it onto his
shell** with a squash and a puff of sand. Ship the same repo again and its
sticker levels up from paper to vinyl, then holo, then foil. Leave a project
alone for a long time and its sticker starts to peel at one corner, and the
next ship presses it back down.

After a few months his shell shows what you've built: crowded, layered, a bit
worn, and different for everyone. When he molts into a bigger shell the old
one goes on a shelf with its stickers still on it, so each shell holds a
stretch of your work.

---

## 1. What counts as "shipping"

| Event | Where it's already detected | Sticker effect |
|---|---|---|
| Push from **Bring it home → Push** | `pushHome()` in `main.js` (already calls `awardXp('ship')`) | +1 ship |
| `git push` run in a Shellby tab | `classifyCommand()` → `'ship'` in `xp.js`, scored via `pendingCommands` in `main.js` | +1 ship |
| Deploy command (`vercel --prod`, `fly deploy`, `wrangler deploy`, …) | `classifyCommand()` → `'deploy'` | +2 ships, adds the **Live** mark |
| Release (`gh release create`, `npm publish`, `cargo publish`, pushing a `v*` tag) | currently folded into `'deploy'`. `stickers.js` adds a finer `releaseOf(cmd)` that reads the version | +2 ships, adds a **version ribbon** (`v1.0.0` gets the gold ribbon) |
| PR merged on GitHub | `CiWatcher` in `github/ci.js` already polls your PRs. Add a `merged` transition | +1 ship, adds the **Merged** mark |
| Push from Claude Code outside Shellby | the plugin already reports finished tasks. Phase 3 adds a push report | +1 ship |

**Not** shipping: a local Bring it home that merges a branch without pushing.
The work hasn't left the machine yet. (Open question 3.)

**Rate limit:** at most one counted ship per project per hour, the same idea as
`perHour` in `xp.js`. A flurry of pushes in one afternoon counts once, so you
can't farm tiers.

---

## 2. Project identity (the gotcha that matters)

A sticker belongs to a **project**, not a folder. Three things break naive keying:

1. **Shellby worktrees.** `repoOf()` in `gitinfo.js` returns the *worktree*
   root (`%APPDATA%/Shellby/worktrees/…`), so every tab copy would look like a
   new project. Resolve through `git rev-parse --git-common-dir` to the main
   repository first.
2. **Multiple machines.** Progress sync (`github/sync.js`) merges state across
   PCs. A path-based key splits one project into two stickers.
3. **Renames and moves.** Moving `C:\code\rack` to `D:\rack` shouldn't cost you
   the sticker.

**Key:** `sha256(normalizedOriginUrl).slice(0, 12)` when the repo has an
`origin` remote (`git@github.com:x-salmon/shellby.git` and
`https://github.com/x-salmon/shellby` normalize to the same
`github.com/x-salmon/shellby`), otherwise `sha256(mainRoot)`. If a path-keyed
project later gets a remote, it's re-keyed once (merge the two records, keep
the earliest `firstShipAt`).

New helper in `gitinfo.js`: `projectOf(dir) → { id, root, name, remote | null }`.
Fixed-argument `execFile`, never throws, same pattern as `repoOf`.

---

## 3. The sticker itself: generated from the repo

Each sticker is drawn at two sizes from one deterministic seed (the project
id), so the same repo always gets the same sticker on every machine.

### Full size: 16×16, for the Sticker Book, crab card and celebrations
- **Shape** (picked by seed): circle, rounded square, hexagon, shield, star,
  banner, die-cut blob. Each shape has a 1px white die-cut border and a 1px
  dark outline, so it reads as a sticker.
- **Palette** from the repo's **main language**: count file extensions in
  `git ls-files` (capped at 5k entries, cached per project) and map them to
  linguist-style colours (JS `#f1e05a`, TS `#3178c6`, Python `#3572a5`, Rust
  `#dea584`, Go `#00add8`, C# `#178600`, …). The seed nudges the hue so two JS
  repos don't come out identical.
- **Glyph:** a 5×5 pixel-font monogram from the repo name (`shellby` → `S`,
  `3d-rack` → `3`), or a language glyph when the name starts with a symbol.
- **Pattern** behind the glyph (stripes, dots, checker, waves) by seed.

### Micro: 3×3, the version stuck on the shell
The crab sprite is 22×13 and his shell is about 13×12, so stickers on the
shell are three pixels square: a border colour, a fill and one accent pixel
taken from the full-size palette. It's enough to tell two stickers apart at a
glance, the way real laptop stickers are recognisable from across a room.

### Repo-defined stickers (Phase 3)
A repo can ship its own official sticker as `.shellby/sticker.json`:
`{ "palette": {...}, "pixels": [16 rows], "micro": [3 rows] }`. It's checked
with the same validators wardrobe packs already use (`checkPalette`,
`checkPixels` in `wardrobe/catalog.js`), under the same rules: data only,
strict limits, a bad file is ignored and logged without throwing. An
open-source project can then give every contributor's crab the same sticker
for it.

Pure module: `src/main/stickers/art.js`. `art(project) → { full, micro }`, no
I/O, fully unit-testable.

---

## 4. Tiers, marks and weathering

### Tiers (from the ship count)
| Tier | Ships | Look |
|---|---|---|
| Paper | 1 | flat colours |
| Vinyl | 5 | adds a 1px highlight on the top-left edge |
| Holo | 15 | slow rainbow shimmer sweeping across it (CSS `hue-rotate` on the sticker's `<g>`, off under reduced motion) |
| Foil | 40 | gold border, and a glint every few seconds |

A tier-up is its own small moment: the sticker flashes and Shellby pats his shell.

### Marks: small corner badges on the full-size art
- **Live:** deployed at least once.
- **v1.0:** a release at or above 1.0.0 (gold ribbon). Other versions get a plain ribbon.
- **Merged:** PR merged on GitHub.
- **Green Light:** a PR that failed CI and then went green (ties to the existing `buildsFixed`).
- **Moon:** shipped between midnight and 5 AM *(hidden until earned)*.
- **Friday Deploy:** deployed on a Friday after 3 PM. A daredevil skull *(hidden)*.
- **1 yr / 2 yr…:** anniversary of the first ship.

### Weathering (ties into streak nudges)
`streaks.js` already tracks when each project last saw a commit. A sticker
whose project hasn't shipped in **60 days** starts to peel: one corner pixel
lifts to a lighter backing colour and the sticker drops to ~85% opacity. At
**180 days** it's faded. The next ship of that repo presses it back down
(short animation with a "fwip" chirp). It's a reminder of the project that
doesn't come as another notification.

Weathering is cosmetic only. Stickers are never removed automatically.

---

## 5. Where stickers go on the shell

### Slots are computed from the shell's shape, not authored by hand
Shellby wears the skin's own shell (`home`) or one of the molt shells in
`shells.js` (snail, tin can, teacup, toy brick, golden conch), and community
skins can have any shape. So instead of hand-placing slots:

`stickerSlots(shellMask) → [[x, y], …]`: every 3×3 block that lies entirely
on shell pixels **and** whose surrounding ring is also shell, so the outline
always stays visible. A greedy farthest-point pass then picks a spread of up
to 6. This runs once per (skin, shell) pair and is cached.

A test (beside `test/shells.test.js`) runs this over every built-in skin ×
every shell and checks that each combination yields at least 2 slots and that
no slot touches the body, claw, eyes or legs.

### Overlap is allowed, as on a real laptop
Each placed sticker has a `z`. A new sticker goes on the emptiest slot, and
when all slots are full it goes **on top**, partly over an older one, offset
by one pixel so the old edge still shows. You can always see how many layers
there are.

### Layouts are per shell
`layouts[shellId] = [{ id, slot, z, flip }]`. Switching shells in the Wardrobe
brings that shell's stickers with it.

### Molting carries a few with him
When he outgrows a shell (`molt()` in `main.js`), the old shell keeps its
stickers and goes on **The Shelf**, a row of retired shells in the Wardrobe.
His **three most-shipped** stickers move to the new shell with him; the rest
stay behind. The molt animation already shows him crawling out of the old
shell and into the new one, so the three carried stickers can fly across
during that crawl.

---

## 6. The big moment: the slap

On the first ship of a project:

1. `main` emits `critter:sticker` with `{ micro, full, name, slot }`.
2. **Hold-up (0–1.2s):** the full-size sticker appears in his claw as a
   temporary `held` accessory. Bubble: `shipped 3d-rack!`
3. **Turn (1.2–1.6s):** the shell tilts toward the viewer (rotate on
   `.part-shell`, using the pivot `sprite.js` already computes).
4. **Slap (1.6–2.0s):** the claw swings to the slot, the sticker shrinks into
   its 3×3 form, the shell squashes slightly, and a 4-particle sand puff
   reuses `critter:burst`.
5. **Admire (2.0–3.5s):** Shellby looks back at the shell with the existing
   `look` animation, then plays `state-success`.

New critter state: `state-stickered` in `critter.css`. Under
`prefers-reduced-motion` it's a single fade-in on the shell.

**Panel side:** if the panel is open, `celebrate.js` shows the full sticker
peeling off a backing sheet, with "**New sticker:** 3d-rack · first shipped
today". If it's closed, a Windows notification shows the sticker art, and
clicking it opens the Sticker Book on that page. It goes through the same
acknowledge / unseen-badge flow as other unlocks, so it waits until you've
seen it.

Tier-ups and marks get a smaller version: the sticker glints on the shell and
a toast appears. There's no claw sequence, so a busy shipping day doesn't
fill the desktop with animations.

---

## 7. The Sticker Book (new panel view)

A binder you page through, one page per project:

- The **full sticker**, big, with its tier finish and marks.
- **Stats:** first shipped, last shipped, ships, deploys, releases (latest
  version), PRs merged, main language.
- **The story line:** "Shipped 23 times since March. Last deploy 4 days ago."
- **Actions:** *Pick up where we left off* (opens a tab in that repo, reusing
  the streak nudge's `tab:new-in` draft), *Put on shell / Take off shell*,
  *Hide from card*.
- **Silhouettes** for projects you've worked in but never shipped (from
  `streaks.projects`): "Ship **rack-builder** to earn its sticker." This gives
  a reason to push the project you've been sitting on.

The index page shows a grid of every sticker, sortable by most shipped, newest,
or most weathered, with a total along the lines of **"14 projects shipped"**.

### The shell editor (inside Wardrobe)
- Shellby's shell zoomed to 16×, using `sprite.build()` with `opts.stickers`.
  Slots show as faint dashed squares.
- Drag a sticker from the tray onto a slot, drag it off to peel it, and use
  *Bring forward / Send back* for overlaps and *Flip* to mirror it.
- **Keyboard:** Tab to the tray, arrow keys between slots, Enter to place,
  Delete to peel, `[` / `]` for z-order. Every sticker has an accessible name
  ("3d-rack sticker, holo, slot 2, on top"). This UI is client-facing, so it
  goes through the accessibility gate (`web-design-guidelines`) before release.
- **Auto-arrange** button, plus a setting: "Put new stickers on automatically"
  (on by default).

---

## 8. Data model

New config key `stickers`, normalized defensively on read like `streaks` and
`xp` (bad entries dropped, no throws):

```js
stickers: {
  projects: {
    [id]: {
      id, name,                 // name clipped to 60 chars, control chars stripped
      remote: 'github.com/x-salmon/shellby' | null,
      firstShipAt, lastShipAt,  // ms
      ships, deploys, releases, merges,
      lastVersion: '0.40.0' | null,
      lang: 'JavaScript' | null,
      marks: ['live', 'v1', 'moon', ...],
      custom: { palette, pixels, micro } | null,   // from .shellby/sticker.json
      hidden: false,            // hide from card and sync
      lastCountedAt,            // for the 1/hour rate limit
    },
  },
  layouts: { [shellId]: [{ id, slot, z, flip }] },
  shelf: [shellId, ...],        // retired shells, in molt order
  auto: true,                   // put new stickers on automatically
  card: 'art' | 'names' | 'off',// what the public calling card shows (default 'art')
  unseen: [id, ...],            // for the acknowledge flow
}
```

Limits: 300 projects, 24 placed stickers per shell. Past 300 projects, the
least-shipped untouched ones are dropped from the *book*, never from a shell.

### Modules
| File | Kind | Does |
|---|---|---|
| `src/main/stickers.js` | **pure** (callers pass `now`, like `xp.js`/`streaks.js`) | `normalize`, `recordShip(state, project, kind, now, meta)` → `{ state, minted, tierUp, newMarks }`, `tierFor`, `weathering(project, now)`, `autoPlace`, `carryOnMolt`, `merge(local, remote)` for sync |
| `src/main/stickers/art.js` | **pure** | seed → full and micro art; language palettes; pixel font; shapes |
| `src/main/stickers/slots.js` | **pure** | shell mask → slots |
| `src/main/gitinfo.js` | I/O | `projectOf(dir)`, `languageOf(root)` (cached) |
| `src/renderer/shared/sprite.js` | render | `opts.stickers`: painted after the home shell, in the `shell` group so they follow its animation (they snooze along when he sleeps) |
| `src/renderer/panel/stickers.js` + `.css` | UI | Sticker Book and shell editor |
| `src/renderer/critter/critter.js` / `.css` | UI | `critter:sticker`, `state-stickered`, holo and peel styles |
| `main.js` | wiring | hooks in `pushHome`, the `pendingCommands` result, `molt`, the CI watcher; `stickers:*` IPC |
| `preload.js` | IPC | the `stickers:*` surface (`ipc-surface.test.js` must be updated) |

The `pendingCommands` entry stores only `path.basename(dir)` today. It has to
keep the full `dir` so the hook can resolve `projectOf(dir)`.

---

## 9. Social (Phase 4)

- **Crab card PNG (`card.js`):** the crab drawn large with his stickered shell,
  plus a "**14 projects shipped**" line and his top 5 stickers in a row.
- **Calling card (public gist, `github/card.js`):** by default it carries
  **sticker art and layout only, never repo names** (`card: 'art'`), so a
  visiting friend's crab shows up with its decorated shell. `'names'` is an
  explicit opt-in, and `hidden` projects are never included.
- **Sticker swaps:** a visiting friend's crab can leave one of *its* stickers
  as a souvenir (`friends.js` souvenirs), like trading stickers at a
  conference. Guest stickers go in a "Friends" section of the book, can be
  placed on the shell, and get a small corner mark with the friend's avatar
  colour.
- **Sync:** stickers merge across your machines through the existing
  **private** sync gist (`sync.js`): max of counts, min of `firstShipAt`, union
  of marks, and the newest edit wins for layouts.

---

## 10. Phases

### Phase 1: "First mark" (0.41.0), the MVP
- `stickers.js`, `stickers/art.js` and `stickers/slots.js`, with tests (target
  ≥ 90% coverage, since they're all pure).
- `projectOf()` with worktree resolution and remote-based ids.
- Hooks: `pushHome` plus `git push` / deploy commands in tabs.
- `sprite.js` renders `opts.stickers`, and `outfit()` includes them.
- The slap animation, a notification, and the unseen badge.
- A minimal Sticker Book (grid and detail page, with no editor yet).
- Auto-placement only, paper tier only.
- Capture mode: deterministic demo stickers for `npm run screenshots`, plus
  `docs/img/critter-stickers.png` and `docs/img/screenshot-stickers.png`.

### Phase 2: "Decorate" (0.42.0)
- The shell editor (drag, keyboard, z-order, flip).
- Per-shell layouts, The Shelf, and the molt carry-over.
- Tiers (vinyl, holo, foil) and weathering.

### Phase 3: "Marks of the trade" (0.43.0)
- Release detection with version ribbons, and PR merges via `CiWatcher`.
- Night, Friday and anniversary marks.
- Plugin push reports for work done outside Shellby.
- Repo-defined `.shellby/sticker.json`, documented in `docs/ADDONS.md`.

### Phase 4: "Trading" (0.44.0)
- The crab card, the calling card (art only by default), sticker swaps with
  visiting friends, and multi-machine sync.

Each phase follows the usual release routine: bump the version, update
CHANGELOG, push, and tag `vX.Y.Z`. Before each tag, run `/verify` and
`/security-review`. The security review matters most for Phase 3 (parsing
`.shellby/sticker.json` from arbitrary repos) and Phase 4 (what reaches the
public gist).

---

## 11. Achievements that fit

These go in `wardrobe/achievements.js`, with matching items gated by
`unlock: { achievement }`. `packs.test.js` checks both directions.

| id | Name | Goal | Reward idea |
|---|---|---|---|
| `first-sticker` | Tagged | Ship your first project | `sticker-sheet` (held item) |
| `sticker-bomb` | Sticker Bomb | 10 projects shipped | `paint-can` (held) |
| `well-traveled` | Well Traveled | Stickers on 3 different shells | `luggage-tag` (neck) |
| `shiny` | Shiny | A sticker reaches holo | `holo-visor` (face) |
| `liftoff` | Liftoff | Release a 1.0.0 | `rocket` (shell) |
| `swap-meet` | Swap Meet | Place a friend's sticker *(Phase 4)* | `trade-binder` |

---

## 12. Risks and how they're handled

| Risk | Mitigation |
|---|---|
| Worktree paths become fake projects | `projectOf()` resolves `--git-common-dir`; covered by a test with a real temp worktree (pattern in `worktrees.test.js`) |
| Repo names leak through the public calling card | Art only by default, `hidden` per project, names behind an explicit opt-in. Sync goes only through the private gist |
| Hostile `.shellby/sticker.json` | Size cap, strict validators reused from `catalog.js`, prototype-free palette copy (`copyPalette`), skipped on any error, never rendered as HTML |
| Tiny or odd community skins with no room | `stickerSlots` may return 0, in which case stickers still mint into the book and the shell just shows none. Tested per skin |
| Shipping days flood the desktop with animations | Full slap only on first mint. Tier-ups and marks are a glint plus a toast, and more than one at once collapse into a summary. Focus guard (`focus.guarding`) and crab-only mode suppress them |
| False "ship" from a failed push | Only scored on non-error tool results (already true in the `pendingCommands` path), and dry runs are already excluded by `classifyCommand` |
| `git ls-files` slow on huge repos | 5k-entry cap and 3s timeout, cached per project and refreshed at most daily, and it runs after the slap, never blocking it |
| Line endings | New files are written LF (scripted edits on Windows have turned files CRLF before) |

---

## 13. Open questions (each has a default)

1. **Overlap or fixed slots?** Default is overlap with z-order, which looks
   more like a real laptop. Fixed slots would be tidier but cap the shell at
   about 6 stickers.
2. **Names on the calling card?** Default is art only, with names opt-in.
3. **Does a local Bring it home with no push count?** Default is no, because
   shipping means the work left the machine. A softer alternative is an
   "unshipped" pencil-sketch sticker that turns real on first push.
4. **Carry-over on molt:** 3 most-shipped automatically, or let you choose
   during the molt? Default is automatic, with changes allowed afterwards in
   the editor.
