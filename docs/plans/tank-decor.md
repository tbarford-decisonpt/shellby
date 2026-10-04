# The Tank: a home you decorate

> Status: **Phase 1 ("Move in") built.** Phases 2–4 are still the plan below.
> Written against 0.64.2. User docs: [TANK.md](../TANK.md).

## What changed from the plan (Phase 1)

- **The editor works on a draft.** Decorate copies the tank, every move happens
  locally (with undo and redo), and Done sends the whole thing once.
  `tank.sanitize` in main is the only way a layout gets kept: unlocked pieces,
  no more of a find than he has, within the tank's room, a size he's grown into.
- **No `level` unlock gate yet.** Tank sizes are gated in `tank.js` directly,
  and the one level-ish piece (the Sunken Ship) uses the existing
  *Double Digits* trophy (level 10).
- **Fewer trophies.** Only *Moving In* and *Interior Designer* are new.
  *Treasure Hunter* was dropped for now, and the chest is *Moving In*'s reward.
  A `curator` trophy already exists (complete a set of finds), so the plan's
  §9 *Curator* needs another id when sets on display arrive.
- **Some ids changed** because they were taken: `treasure-chest` is an
  accessory (the decor is `sunken-chest`), `jack-o-lantern` is an accessory
  (`carved-pumpkin`), and `sand` is taken (`soft-sand`).
- **He goes see-through while you decorate,** as well as stepping aside. In
  a nano tank, the side is still a quarter of the floor.
- **The Health porthole is 4 px a pixel, not 3,** so he stays readable at the
  size his mood effects were drawn for.
- **Decor spots are validated and stored but not used yet.** He wanders and
  visits pieces; hiding, sitting and the rest are Phase 2.
- **A "Where his decor comes from" key** under the tank counts what's his and
  names the next trophy piece, so locked decor is a goal, not a mystery.
- **Not done yet:** capture-mode screenshots (`docs/screenshot-tank.png`) and
  the crab card and profile card painting the tank (Phase 4).

The code: `src/main/tank.js` (pure), `src/main/ipc/tank.js`, the `decor` kind
in `src/main/wardrobe/catalog.js`, `src/wardrobe/tank-decor.json`, and
`src/renderer/panel/tank.js`, `tank-paint.js` and `tank.css`. Tests:
`test/tank.test.js`, decor cases in `test/wardrobe.test.js` and
`test/packs.test.js`, and `scripts/e2e-tank.js`.

## The pitch

Shellby has a tank. You can see it in the Health view, on the crab card and on the
GitHub profile card. But it's empty: sand, glass, him. Stickers decorate his
*shell*. The Beach shows what you've *shipped*. Finds sit on a *shelf*. Nothing
lets you make a place that's yours and his.

That's most of the pull of Rusty's Retirement and the Steam idle pets. A small
space sits beside your work, slowly fills up, and is arranged by you. The
creature in it *uses* what you put there. Shellby already has the collection
(60+ finds, outfits, stickers, sets). What's missing is somewhere to put it.

**The Tank** is that place. You get a castle he hides in, plants he nibbles, a
treasure chest that creaks open when he sits on it, and the pebble he dug up last
Tuesday, placed exactly where you want it. Later, a few pieces of decor quietly
show something real: a thermometer that reads your GPU, a bubbler that runs
with your CPU, a lighthouse that's lit while a dev server is up.

### How it differs from what's already there

| | Who arranges it | What it shows | Changes when |
|---|---|---|---|
| **Beach** (`beach.js`) | Nobody: laid out automatically | Your shipping history, streak tide, finds washed up | You ship, keep a streak, dig |
| **Sticker shell** (`stickers.js`) | Mostly automatic, editor to tweak | Projects shipped | You ship |
| **Tank** (new) | **You** | Whatever you choose, plus his life in it | You decorate; he lives there |

The Beach is a record of what you've done. The Tank is a place you build. That
difference decides the design: the Tank must be **editable, cosy and lived in**,
and it must never feel like a second Beach.

### Naming: "Tank", never "home"

`config.home` already means *the shell he wears* (`shells.js`: "Shellby's homes",
`homesView`, `critter:molt`). The feature is **the Tank** in the UI, the config key
is `tank`, and IPC is `tank:*`. Copy can still say "his tank is his home". The
code must never use `home` for it.

---

## 1. Where the Tank shows up

1. **A new Tank tab** in the Shellby screen's tab row (`panel.html` `shellby-tabs`,
   between **Finds** and **Us**). This is the big, editable view.
2. **The Health hero** (`.hl-tank`, `panel.html:370`) becomes a porthole into the
   real tank. It shows his backdrop, substrate and the two or three pieces nearest
   his spot, with the existing mood effects (`hlFx`) on top. A small "Visit his
   tank" link sits under it.
3. **The crab card PNG** (`card.js` `drawTank`, also used by `week-card.js`)
   paints the decorated tank instead of plain sand.
4. **The GitHub profile card SVG** (`profile-card.js:79`) does the same, as SVG.
5. **Friends** (Phase 4): a visiting friend's calling card can carry their tank
   layout (art only, opt-in), and the Friends view gets "Peek at their tank".
6. **The desktop:** not in this plan's committed phases. See open question 1.

---

## 2. What goes in it

### Decor categories

| Category | Examples | Layer |
|---|---|---|
| **Structures** | Sandcastle keep, rock cave, driftwood arch, sunken ship, lighthouse, tiny bridge, flowerpot house | floor |
| **Plants** | Kelp, java fern, anubias, moss ball, sea grass, red ludwigia, coral fan | floor / back |
| **Treasures** | Treasure chest (opens), old anchor, diver figurine, amphora, ship's wheel | floor |
| **Bubblers & lights** | Air stone, clam bubbler, treasure-chest bubbler, glowing jellyfish lamp | floor / float |
| **Finds** (existing, `gifts.js`) | Any find on the shelf: pebble, sea glass, rubber duck, golden duck | floor (small) |
| **On the glass** | Stickers from the Sticker Book, a suction-cup thermometer | glass |
| **Tank style** | Substrate (sand, gravel, black sand, pebbles), backdrop (plain, reef poster, deep sea, starry, retro CRT), light (follow the clock / day / night) | special |

### Where decor comes from: no currency

There's no shop and no coins. Every piece is earned by something specific, and a
locked piece's tooltip says exactly what (`lockReason`, already used by the
wardrobe). This follows PRODUCT.md's anti-references: no gacha frames, no FOMO
timers, nothing that nags toward the paid path.

| Source | How | Examples |
|---|---|---|
| **Starter set** | `unlock: { default: true }` | Sandcastle, kelp, 3 rocks, air stone, sand + gravel, plain backdrop |
| **Achievements** | Existing `rewards` arrays gain decor keys; new tank achievements (§9) | `check-up` adds a thermometer, `open-house` adds a guest bench, `green-light` adds a lighthouse |
| **Levels** | New `unlock: { level: n }` gate (shells already gate by level in code) | Bigger tank sizes, sunken ship (L15), geode cave (L40) |
| **Seasons** | Existing `unlock: { season }` + `collected` | Pumpkin and ghost in Halloween, snow globe in Winter, cherry blossom in Spring |
| **Finds** | Owning a find makes it placeable; you can place as many as you own | Every find in `gifts.js` |
| **Shipping** | Sticker tiers and counts (`stickers.js`) | Lighthouse at 10 projects shipped, foil trophy when a sticker hits foil |
| **Bond** | `bond.js` levels | A hammock at a bond level, a photo frame of your first day together |
| **Sets** | Display a complete find set (§6) | The pirate set on show unlocks the jolly-roger flag decor |

Not having a currency is a deliberate choice. Open question 2 covers the alternative.

### Tank sizes: progression you can see

Like molting into bigger shells, the tank itself grows:

| Size | Art px (w × h) | Pieces | Unlock |
|---|---|---|---|
| Nano | 96 × 56 | 10 | default |
| 10 gallon | 128 × 56 | 18 | level 5 |
| 30 gallon | 160 × 64 | 28 | level 15 |
| Reef | 200 × 72 | 40 | level 30 + 10 projects shipped |
| Grand aquarium | 240 × 80 | 56 | level 50 |

An upgrade plays a **moving day** moment: the old tank slides aside, decor hops
across in a little arc, and he scuttles in last and looks around. You can pick
any unlocked size (smaller ones stay available). Piece caps keep the scene
readable and rendering cheap.

---

## 3. Decor as a wardrobe pack kind (the key architectural call)

Decor joins `accessories`, `effects`, `skins`, `voices` and `scenes` as a new
kind in `src/main/wardrobe/catalog.js`. That gets us, without new machinery:

- **Unlock evaluation** (`isUnlocked` from the item's own `unlock` gate)
- **"New" badges** (`newItems`) and the **Mark all seen** flow
- **Achievement rewards** (`rewards` arrays; `packs.test.js` checks both directions)
- **Seasonal collection** (`collected`)
- **Sync**: `wardrobe.unlocked` and `collected` already go through the private gist
- **Third-party packs** can ship decor, under the same validators and limits
- **Capture mode** and the community gallery pipeline (`format-packs.js`,
  `validate-packs.js`, `preview-packs.py`)

### The decor item format

```json
{
  "id": "treasure-chest",
  "name": "Treasure Chest",
  "description": "He sits on it. It creaks open. There's nothing inside. He checks anyway.",
  "category": "treasures",
  "layer": "floor",
  "rarity": "rare",
  "palette": { "w": "#8a5a2b", "W": "#5e3b1a", "g": "#ffd23f", "k": "#2b2d42" },
  "pixels": ["..wwwww..", ".wgggggw.", "wWWWgWWWw", "wwwwkwwww", "wWWWWWWWw"],
  "frames": { "open": ["...", "..."] },
  "fps": 4,
  "spots": [{ "kind": "sit", "at": [4, -1] }, { "kind": "open", "at": [4, 0] }],
  "unlock": { "achievement": "treasure-hunter" }
}
```

Validation reuses `checkPalette` / `checkPixels`. New checks:

- `layer`: one of `floor | back | float | glass`
- `category`: one of a fixed list
- At most 32 × 32 pixels and 4 frames of the same size, `fps` between 1 and 8
- `spots`: up to 4, `kind` from a fixed list (`hide | sit | climb | sleep | nibble | open | peek`), `at` inside the item's box
- Limits: `decor: 100` per pack in `LIMITS`

Style items (substrate, backdrop) are decor with `layer: "style"` and a
`style: { role: "substrate" | "backdrop", tile: [...] }`. A backdrop is a tile
pattern, never a full-size bitmap, which keeps packs small and stops anyone
shipping an image through a pack.

New unlock gate in `checkUnlock`: `{ level: n }`. Accessories can use it too, a
small bonus.

Finds stay in `gifts.js` and aren't converted. The tank refers to them as
`find:<id>` and draws their existing `palette` / `pixels`.

---

## 4. The scene: layout and painting

The Tank uses the Beach's split: a **pure layout module** in main, a **painter**
in the renderer, everything in art pixels drawn at a whole-number scale.

### Depth: three rows, like the Beach's castle rows

```
 back glass  ──────────────────────────────  (backdrop, back-layer plants)
 row 0  (back)   ───────────────────────      castles, tall plants
 row 1  (middle) ───────────────────────      ← Shellby walks here
 row 2  (front)  ───────────────────────      rocks, finds, small plants
 front glass ──────────────────────────────  (stickers, thermometer)
```

- Each placed piece has `x` (art px), `row` (0–2), `z` (tie-break within a row)
  and `flip`.
- Paint order: backdrop, then back layer, row 0, row 1 (crab drawn here, sorted
  by baseline), row 2, float, glass.
- **He passes behind front-row pieces and in front of back-row pieces.** That one
  depth rule makes the tank feel like a place rather than a sticker sheet.
- Float items (jellyfish lamp, bubbles) bob a few pixels and aren't snapped to a row.

### Lighting

The palettes take the time of day like `beach-paint.js` THEMES do (night, dawn,
day, dusk). The tank light defaults to **follow the clock**, so at night the
water darkens, lamps and the lighthouse glow, and he sleeps in his cave. Pieces
can mark colour keys as `"lit"`, and those stay bright at night.

### Modules

| File | Kind | Does |
|---|---|---|
| `src/main/tank.js` | **pure** | `normalize(raw)`, `SIZES`, `capacity(size)`, `place / move / remove / flip` returning new state, `view({ tankState, catalog, finds, stickers, now })` → drawables in paint order plus walkable lanes and interaction spots, `merge(local, remote)`, `forCard(state)` / `cleanCard(raw)` |
| `src/main/tank-life.js` | **pure** | Picks what he does in the tank (§5) from the spots and `rand` / `now` |
| `src/renderer/panel/tank-paint.js` | render | Paints a `view()` onto a canvas context at scale `k`; shared by the Tank tab, the Health porthole, `card.js`, and (as SVG) `profile-card.js` |
| `src/renderer/panel/tank.js` + `tank.css` | UI | The Tank tab and the editor |
| `src/main/wardrobe/catalog.js` | validation | The `decor` kind and the `level` unlock gate |
| `src/wardrobe/tank-starter.json`, `tank-reef.json`, … | data | Built-in decor packs |
| `src/main/main.js` | wiring | The `tank:*` IPC, achievement stats, live-decor feeds (Phase 3) |
| `src/preload/preload.js` | IPC | The `tank:*` surface (`ipc-surface.test.js` must be updated) |

### Performance budget

- The canvas animates **only while the Tank tab or the Health view is visible**
  (stop on `visibilitychange` and on view switch). It runs at 10 fps, which is
  plenty for pixel art and drawn on a fixed-step timer, not a free-running rAF.
- Static layers (backdrop, substrate, unanimated pieces) are cached to an
  offscreen canvas, so each frame only redraws him, animated pieces and bubbles.
  The cache is rebuilt on edit or on a time-of-day change.
- `scripts/idle-cost.js` gets a tank case. The goal is no measurable idle cost
  with the panel closed, and under 1% CPU with the Tank tab open.
- **Reduced motion:** one static frame. He's drawn at his favourite spot, nothing
  bobs, and bubbles show as still dots.

---

## 5. He lives there (what makes it a pet, not a diorama)

`tank-life.js` picks small behaviours from the spots that pieces declare. They
run whenever the Tank tab or the Health porthole is visible:

| Spot | He… |
|---|---|
| `hide` (castle, cave) | Walks in, disappears, and his eye stalks peek out of the window a moment later |
| `sit` (chest, rock) | Climbs up and sits. The chest creaks open under him |
| `climb` (driftwood, arch) | Clambers up one side and slides down the other |
| `sleep` (cave, hammock) | At night (clock-driven light) he sleeps there, with the existing `snooze` z's |
| `nibble` (plants) | Picks at it; the plant's next frame is a leaf with a tiny bite out of it, which grows back the next day. Nothing decays |
| `open` (chest) | Lifts the lid, finds nothing, looks at you |
| `peek` (sunken ship porthole) | Pops his head out of the porthole |

He also reacts to you and your decor:

- **New piece placed:** he scuttles over, inspects it with the existing `look`
  animation, and the bubble says something specific ("a castle! for me?").
  Lines go in `wardrobe/dialogue.js`, with temperament variants like `scenes.js` lines.
- **Favourite piece:** the one he uses most becomes his favourite (shown in the
  Tank tab) and is where he sits on the Health porthole.
- **Bond journal moments** (`bond.js`): "You gave me a castle", "Moving day: the
  30 gallon". These use the existing moment mechanism and never shrink.
- **Desktop remarks** (`voice.js`, through `life.js`): now and then, on the
  desktop: "I moved the pebble back. It looked lonely." It's rare and respects
  the `chatter` setting.

### Tidying up (Phase 3, opt-in default on)

Very occasionally he carries **one find** a few pixels to a spot he prefers. He
never moves structures, plants or anything you placed in the last day. Ctrl+Z
undoes it like any edit, and **Let him tidy up** turns it off. This is the part
people screenshot.

---

## 6. Sets on display

`gifts.js` already groups finds into sets (beach, sea glass, junk drawer, toy
box, codebase, garden, pirate, deep…). The tank rewards *showing* a complete
set, not just owning it:

- With every piece of a set placed in the tank, the set gets a small plaque
  (glass layer) and a one-off scene. Codebase set: he rubber-ducks at the
  rubber duck. Pirate set: he wears an eyepatch near the chest.
- Each displayed set counts toward the **Curator** achievement (§9).

It's a reason to arrange things, not a chore. Nothing is lost if you take a set
back down later; the achievement stays.

---

## 7. The editor

The Tank tab has two states: **Watching** (default, he lives there) and
**Decorating**.

### Decorating

- **Tray** at the bottom: tabs for Structures, Plants, Treasures, Finds,
  Stickers and Style. Locked pieces show as silhouettes with their unlock reason
  ("Finish 5 focus sessions"). A **New** dot shows on unseen pieces.
- **Place:** drag from the tray onto the tank. The piece snaps to the nearest row
  and shows a ghost of where it'll land. You can't drop it past the glass.
- **Move / flip / remove:** drag on the tank; a small toolbar on the selected
  piece has **Flip**, **Forward**, **Back** and **Put away**.
- **Capacity** shows as "18 of 28 pieces". At the cap, the tray greys out with
  "Room for more in a bigger tank (level 15)".
- **Undo / redo:** Ctrl+Z / Ctrl+Y across the whole session. **Done** saves;
  **Cancel** reverts.
- While you decorate he steps to one side and watches. The crab is never a drop target.
- **Clear tank** asks first, in the confirm window like other destructive actions.

### Keyboard and screen readers (part of the plan, not a later fix)

A canvas isn't accessible. The editor puts **real buttons** over the canvas, one
per placed piece, positioned in CSS. Those buttons are the focus targets, and the
canvas only paints.

| Key | Does |
|---|---|
| Tab | Tray, then the placed pieces, left to right, back to front |
| Enter (on tray) | Places at the first free spot in the middle row |
| ← / → | Move 1 art pixel. Shift moves 8 |
| ↑ / ↓ | Move to the row behind / in front |
| F | Flip |
| [ / ] | Send back / bring forward |
| Delete | Put away |

Every piece has an accessible name, for example "Treasure chest, front row,
left of the castle, flipped". The Watching view has a text summary in a
visually hidden live region ("Shellby is hiding in the castle"), which updates
at most every 30 seconds. The tank goes through `panel-a11y.test.js` and the
`web-design-guidelines` gate before release, like the Sticker Book editor.

### Layouts (Phase 3)

Save up to 3 named layouts ("Everyday", "Spooky", "Reef"). **Switch with the
seasons** is an option: a layout tagged to a season goes up when the season
starts and comes down when it ends.

---

## 8. Data model

New config key `tank`, normalized defensively on read like `stickers` and
`streaks` (bad entries dropped, never throws):

```js
tank: {
  size: 'nano',                 // any size you've unlocked
  style: { substrate: 'tank-starter/sand', backdrop: 'tank-starter/plain', light: 'clock' }, // clock | day | night
  placed: [                     // at most capacity(size), hard cap 64
    { uid: 'p7', ref: 'tank-starter/castle', x: 42, row: 0, z: 1, flip: false },
    { uid: 'p8', ref: 'find:rubber-duck',    x: 70, row: 2, z: 0, flip: true  },
    { uid: 'p9', ref: 'sticker:3f9a1c2b7d01', x: 12, row: 'glass', z: 0 },
  ],
  layouts: { [name]: { size, style, placed, season: 'halloween' | null } }, // Phase 3, max 3
  favourite: 'p7' | null,       // the piece he uses most, from life
  uses: { [uid]: n },           // capped; drives the favourite
  tidy: true,                   // let him move finds now and then
  live: { thermometer: true },  // Phase 3, per PC, never synced or shared
  shareCard: false,             // Phase 4, friends see your tank (art only)
  editedAt: 0,                  // ms, newest edit wins in sync
}
```

Rules:

- `ref` is `<pack>/<id>` for decor, `find:<id>`, or `sticker:<projectId>`. Refs
  you don't own on this PC (a find not synced, a pack not installed) are **kept
  but not drawn**, and the editor lists them as "not on this PC". Nothing is
  silently deleted.
- `x` is clamped to the tank width when you move to a smaller tank. A piece past
  capacity in a smaller tank is put away, and the editor says which ones.
- Unlocking stays in the wardrobe (§3). The tank only stores *placement*.

### Sync (`github/sync.js`)

`tank.merge(a, b)`: the newer `editedAt` wins the whole layout (same as sticker
layouts). `uses` takes the max per uid. `live` and `tidy` stay per PC. The gist
note grows to "…and his tank".

Finds aren't synced today, so the tank on another PC may hold `find:` refs that
PC doesn't have. That's the "kept but not drawn" rule above. Open question 4
asks whether to sync finds.

---

## 9. Achievements and rewards

New entries in `wardrobe/achievements.js`. Rewards are decor keys gated by
`unlock: { achievement }`, and `packs.test.js` checks both directions.

| id | Name | Goal (stat) | Reward |
|---|---|---|---|
| `moving-in` | Moving In | Place your first piece (`tankPlaced` ≥ 1) | Welcome mat |
| `interior-designer` | Interior Designer | 15 pieces in the tank at once (`tankMax`) | Coral fan |
| `aquascaper` | Aquascaper | 5 different plants on show (`tankPlants`) | Moss ball |
| `curator` | Curator | Display 3 complete find sets (`setsShown`) | Display plinth |
| `treasure-hunter` | Treasure Hunter | Find 3 rare-or-better finds (`rareFinds`) | Treasure chest |
| `upsized` | Upsized | Move into the 30 gallon | Sunken ship |
| `night-light` *(hidden)* | Night Light | Watch him fall asleep in his cave | Jellyfish lamp |
| `house-guest` | House Guest | A friend's crab visits while your tank is shared *(Phase 4)* | Guest bench |

Existing achievements also gain decor rewards:

- `check-up`: thermometer
- `green-light`: lighthouse
- `spring-cleaning`: tiny broom-and-bucket
- `open-house`: doormat

The `stats` writes go through the existing `recordStat` path in `main.js`.

---

## 10. Gauges in disguise (Phase 3, Shellby's own twist)

No other desk pet has this. Shellby already *knows* things about your PC and your
work, and a few pieces of decor can show them quietly. Each one is opt-in per
piece (`tank.live`), local only, and **never on any card**.

| Piece | Shows | Source |
|---|---|---|
| Suction-cup thermometer | GPU (or CPU) temperature, red past your Health line | `health/monitor.js` |
| Air-stone bubbler | Bubbles faster with CPU load | `health/monitor.js` |
| Lighthouse | Lit while any dev server is running, blinks when one crashes | `devservers/` |
| Tide gauge on the glass | How much of the 5-hour usage window is left | `forecast.js` / `limits.js` |
| Treasure chest | Glints for a minute when a PR of yours merges | `CiWatcher` merged transition |
| Message in a bottle | Bobs up when there's an unread recap | `recap.js` |

The Health view's moods also reach the tank. **Hot** warms the water tint and
the plants sway faster. **Dizzy** swirls the water. **Stuffed** gets the
cardboard-box clutter from his desktop mood piled in a corner. All of it clears
the moment the mood does. Nothing is permanent, so it stays within "nothing
goes back down".

These pieces aren't status indicators you're expected to watch. They're a reason
the tank changes while you aren't decorating it.

---

## 11. The Health porthole

The Health hero is a 148 × 112 CSS px box with the crab at `--px: 5px`. Showing
the whole tank there would shrink him past readability, and his mood effects
are the point of that view. So:

- Draw a **porthole crop** of the real tank at **3 CSS px per art pixel**
  (about 49 × 37 art px). He's around 66 px wide, still clear, and there's room
  for two or three nearby pieces.
- Centre it on his **favourite** piece, or on the castle if he has none.
- Keep `hlSprite` and `hlFx` as DOM overlays exactly as today, so
  `health-fx.js` doesn't change. Only the background becomes the painted tank.
  Check that `hlFx` scales with `--px: 3px`. `scripts/e2e-health.js` must still
  pass for every scenario.
- `data-level="off"` keeps its grayscale filter. `warn` and `critical` keep the
  hero border colours, and the water tint comes from §10.
- If the tank is empty, it looks exactly like today.

---

## 12. Social (Phase 4)

- **Crab card** (`card.js` `drawTank`): paints the real tank, scaled to fit
  470 × 470. Stickers on the glass come from the tank's glass row when there is
  one, and fall back to today's best-five otherwise.
- **Profile card SVG** (`profile-card.js`): the same layout as SVG `<rect>` runs
  (reusing `SB.Sprite.grid`), at most 24 pieces to keep the SVG small.
- **Calling card** (`github/card.js`): a new optional `tank` field. It's added
  only when `tank.shareCard` is on, and the default is **off**, following the
  sticker card's privacy precedent. It holds `size`, `style` and up to 24
  `{ ref, x, row, flip }`, where `ref` is only built-in decor or `find:` ids.
  `sticker:` refs are included only as colour patches, and only if the Sticker
  Book's card mode allows it. **Live values are never included.** `cleanCard`
  validates every field (regex ids, integer ranges, array caps) the same way it
  does `home` and `find`.
- **Peek at their tank** (Friends view): draws a friend's tank from their card.
  Decor from packs you don't have is drawn as a plain rock with "from a pack
  you don't have".
- **Gifting** (stretch): a visiting friend's crab can leave a find in your tank's
  Finds tray, using the same rules as sticker swaps (capped, guestbook visits only).

---

## 13. Phases

Each phase ships as its own release, following the usual routine (bump,
CHANGELOG and tag on main at merge time only).

### Phase 1: "Move in" (MVP)

- `catalog.js`: the `decor` kind and the `level` unlock gate, with validator tests
- `tank.js` (pure, ≥ 90% coverage), `tank-paint.js`
- The starter pack (~20 pieces: castle, cave, driftwood, 4 plants, 3 rocks, air
  stone, chest, 3 substrates, 3 backdrops) and finds as placeable pieces
- The Tank tab: Watching (he wanders the middle row and idles) and Decorating
  (drag plus the full keyboard model, undo, capacity)
- Nano and 10 gallon sizes
- The Health porthole
- `moving-in`, `interior-designer` and `treasure-hunter`
- Capture mode: a deterministic demo tank, `docs/screenshot-tank.png` and
  `docs/critter-tank.png`
- `docs/TANK.md`, plus a line in README and HEALTH.md

### Phase 2: "He lives here"

- `tank-life.js`: hide, sit, climb, sleep, nibble, open, peek
- Favourite piece, new-piece reactions, bond moments, desktop remarks
- All five tank sizes and the moving-day moment
- Seasonal decor in each season's pack
- Sets on display and Curator
- The remaining achievements

### Phase 3: "Gauges in disguise"

- Live decor (§10) and health moods reaching the water
- Stickers on the glass
- Layouts, and switching with the seasons
- Tidying up

### Phase 4: "Open house"

- Crab card and profile card render the tank
- Calling-card `tank` field (opt-in), Peek at their tank, `house-guest`
- Sync through the private gist
- `decor` documented in `docs/ADDONS.md`, plus a community gallery category

Before each tag, run `/verify` and `/security-review`. The security review
matters most for Phase 1 (pack parsing of a new kind) and Phase 4 (what reaches
the public gist, and parsing friends' cards).

---

## 14. Tests

| Test | Covers |
|---|---|
| `test/tank.test.js` | `normalize` (junk in, safe state out); place, move, flip and remove return new objects; capacity and size downgrades; paint order (crab between rows 0 and 2); x clamping; unknown refs kept but not drawn; `merge`; `forCard` / `cleanCard` (rejects bad ids, oversize arrays, live data) |
| `test/tank-life.test.js` | Spot picking is deterministic with seeded `rand`; sleep only at night; favourite from `uses`; tidy never moves structures or fresh pieces |
| `test/packs.test.js` | Decor in built-in packs validates; every decor reward has a matching `unlock.achievement` and the reverse; `level` gate |
| Catalog validator cases | Oversize pixels, too many frames, bad `spots`, unknown `layer`, prototype keys in the palette |
| `test/ipc-surface.test.js` | The new `tank:*` channels |
| `test/panel-a11y.test.js` | Tank tab: every placed piece is a named, focusable button; live region present |
| `scripts/e2e-tank.js` | Place by keyboard, restart, still there; the Health porthole renders with and without decor under each `SHELLBY_FAKE_HEALTH` mood; the crab card renders the tank |
| `scripts/idle-cost.js` | Tank case within budget |

Mind the CI runners. They run with reduced motion on, so e2e checks must assert
on state and the static frame, never on animation timing. Their 8.3 short temp
paths matter for any path-based fixtures.

---

## 15. Risks and how they're handled

| Risk | Mitigation |
|---|---|
| Confusion with `config.home` (his shell) | Key `tank`, IPC `tank:*`, UI "Tank"; a test checks `normalize` never reads or writes `home` |
| Feels like a second Beach | The Beach stays automatic; the Tank is only what you place. Finds can be in both: the Beach washes up what you own, the Tank shows what you chose |
| Clutter, then slow rendering | Piece caps per size, a hard cap of 64, static-layer cache, 10 fps fixed step, animation only while visible |
| Battery and CPU on an always-open panel | No animation when the view is hidden; `idle-cost.js` guard in CI |
| Hostile or huge pack decor | Same validators as accessories, size and frame caps, prototype-free palette copy, data only, never HTML |
| Friend's card is a vector into your panel | `cleanCard` validates every field; refs must match known patterns; unknown pack items draw as a plain rock |
| Privacy: repo names or live data leaking | Live decor never serialised to card or sync; stickers on the card obey the Sticker Book's card mode; tank sharing off by default |
| Canvas editor locks out keyboard and screen-reader users | DOM button per piece over the canvas, full key map, live-region summary, a11y gate before release |
| Health view loses clarity | The porthole is a crop at 3 px; fx overlays unchanged; e2e-health checks every mood |
| Pressure and guilt (Tamagotchi anti-reference) | Nothing decays: nibbled plants regrow, moods clear, no "your tank is dirty". Tidying is his, small, and undoable |
| Decor sitting behind a paid path | Every unlock has a no-Claude route too (finds, bond, levels from petting and play), per design principle 4 |
| Line endings | New files written LF |

---

## 16. Open questions (each has a default)

1. **A tank on the desktop?** A low strip at the screen edge, Rusty's
   Retirement-style, where he walks among his decor. It's the strongest pull of
   the genre, but it fights with perching, wandering and the desktop layer.
   **Default: not in Phases 1–4.** Revisit after Phase 2 with a prototype behind
   a setting.
2. **A currency?** "Sand dollars" per task or dig would give *choice* over what
   comes next. **Default: no.** Earned-by-doing fits PRODUCT.md's anti-gacha
   stance, and level gates already give a steady drip. If added later, it must
   never be buyable.
3. **Does placing a find use it up?** **Default: no.** You can place as many of
   a find as you own, and it stays on the shelf too.
4. **Sync finds between PCs?** It would end "kept but not drawn". **Default:
   yes, in Phase 4**, merged like XP (`byDevice`, max per device) so nothing
   double-counts. Worth its own small plan.
5. **Should he tidy up by default?** **Default: on, finds only**, because it's
   the most charming thing in the feature. If early feedback says it's
   annoying, flip the default.
6. **Tab placement:** between Finds and Us (default), or replace the Beach
   tab's position? Keep the Beach as is.
