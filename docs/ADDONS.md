# Making a Shellby wardrobe pack

A wardrobe pack is **one JSON file** that adds things Shellby can wear or show:

- **Accessories**: hats, glasses, scarves, things to hold, things on his shell.
- **Effects**: little sprites that drift around him, like snow, bats or sparkles.
- **Skins**: whole new crabs. They use the same format as [SKINS.md](SKINS.md).
- **Voices**: new ways for him to talk, like a pirate, a grump, or another language. See [Voices](#voices).
- **Scenes**: little stories he acts out in beats, like building a sandcastle that crumbles. See [Scenes](#scenes).

Packs hold **data only**: pixels, colours, short lines of text and a few settings. There is no code, scripting, HTML or links that run. Shellby checks every pack when it loads, so a broken pack can't break the app. The strict rules are in [`addon.schema.json`](addon.schema.json), and editors like VS Code can use that file to check your pack as you type.

## Try it in 5 minutes

1. Save this as `my-first-pack.json`:

   ```json
   {
     "$schema": "https://github.com/x-salmon/shellby/blob/main/docs/addon.schema.json",
     "format": 1,
     "id": "my-first-pack",
     "name": "My First Pack",
     "author": "you",
     "version": "1.0.0",
     "accessories": [
       {
         "id": "beanie",
         "name": "Beanie",
         "slot": "hat",
         "pivot": [2, 2],
         "palette": { "R": "#d6453d", "r": "#a83129", "W": "#fff4e4" },
         "pixels": [
           "..W..",
           ".RRR.",
           "rRrRr"
         ]
       }
     ]
   }
   ```

2. Open **Wardrobe → Install pack…** (**Shellby** in the bar at the bottom of the panel, or tray → Wardrobe) and pick the file. Shellby copies it to `%APPDATA%\Shellby\wardrobe\my-first-pack.json`.
3. Open the Wardrobe and put the beanie on. To try a change, edit the file in `%APPDATA%\Shellby\wardrobe\` and hit **Reload** in the Wardrobe's packs section. You can also just drop the `.json` file onto the Wardrobe.

Shellby's own packs in [`src/wardrobe/`](../src/wardrobe/) use this exact format, so they work as examples: `shell-cargo` for the shell slot, `dev-desk` for a set that spans every slot, `crab-species` for skins that move their anchors.

If something is wrong, the Wardrobe lists the pack with its warnings, for example `skipped accessory beanie: bad slot "head"`. The rest of the pack still loads.

## The pack file

```jsonc
{
  "format": 1,                     // always 1 for now
  "id": "spooky-extras",           // 2–40 chars: a-z, 0-9 and "-", starting with a letter or digit
  "name": "Spooky Extras",         // 1–60 chars
  "author": "someone",             // 1–60 chars
  "version": "1.0.0",              // major.minor.patch
  "description": "…",              // optional, up to 240 chars
  "homepage": "https://…",         // optional, must start with https://, up to 200 chars
  "accessories": [],               // up to 200
  "effects": [],                   // up to 50
  "skins": [],                     // up to 50
  "voices": [],                    // up to 20
  "scenes": [],                    // up to 60
  "decor": []                      // up to 100: things for his tank
}
```

- If `format`, `id`, `name`, `author` or `version` is wrong, **the whole pack is rejected**.
- A bad `description` or `homepage` is dropped with a warning.
- A bad item is **skipped** with a warning, and the rest of the pack still loads.
- If two items of the same kind share an id, the first one is kept.
- Fields Shellby doesn't recognise are ignored.
- The file must be **512 KB or smaller**.
- Your pack id must be unique. The built-in pack's id is reserved. Installing a pack with an id that's already installed replaces the old one, which is how you ship updates.

Inside Shellby, your items are known as `<pack id>/<item id>`, so `spooky-extras/witch-hat` can never clash with another pack's `witch-hat`.

### Pixels and palettes

Accessories and effect sprites are drawn the same way skins are:

- `palette` maps **one character** to one `#rrggbb` colour. It can have 1–16 entries. `.` can't be used as a key because it means "transparent".
- `pixels` is a list of rows. Any character that isn't in the palette is transparent. Use `.` for readability.
- Accessories can be up to **16×16**. Effect sprites can be up to **8×8**.

## Accessories

```jsonc
{
  "id": "witch-hat",               // 1–40 chars: a-z, 0-9, "-"
  "name": "Witch Hat",             // 1–40 chars
  "description": "…",              // optional, up to 160 chars
  "slot": "hat",                   // hat | face | neck | held | shell
  "anchor": "head",                // optional: where on the crab it attaches
  "follows": "stalks",             // optional: which body part it moves with
  "pivot": [4, 3],                 // the pixel of YOUR item that lands on the anchor
  "palette": { "K": "#2b193d", "P": "#7a4fb0" },
  "pixels": [
    "....K....",
    "...KPK...",
    "..KPPPK..",
    "KKKKKKKKK"
  ],
  "rarity": "rare",                // optional: common (default) | rare | epic | legendary
  "unlock": { "season": "halloween" }  // optional, see "Unlocking"
}
```

### Slots

Shellby wears **one item per slot**. Here is what each slot does when you leave out `anchor` and `follows`:

| `slot` | Meant for | Default `anchor` | Default `follows` |
|---|---|---|---|
| `hat` | hats, crowns, bandanas | `head` | `stalks` |
| `face` | glasses, masks, monocles | `face` | `stalks` |
| `neck` | scarves, bow ties, medals | `neck` | `body` |
| `held` | anything in the claw | `claw` | `claw` |
| `shell` | wings, flags, sprouts on the shell | `shellTop` | `shell` |

### Anchors and pivots

An **anchor** is a point on the crab. The **pivot** is a point on your item. Shellby draws your item so the two points line up.

Here are the anchors on the classic 22×13 crab. `x` is the column and `y` is the row, both counted from 0 at the top-left. The `head` anchor is on row −1, one row above the grid.

```
          x → 0         1         2
               0123456789012345678901
   y  -1       ...............H......     H head      [15, -1]
      0        ......S@SS...ewFew....     @ shellTop  [7, 0]
      1        ....SSsssSS..ee.ee....     F face      [15, 0]
      2        ...SsshhhssS..k..k....
      3        ..SshhSSSshsS.k..k....
      4        ..SshSsssSshSbbNbbb...     N neck      [15, 4]
      5        .SshSshhsSshSbbbbbbb..
      6        .SshSshSsSshSbbbbbB.cC     C claw      [21, 6]
      7        .SshSssSSshsSbbbbBcccC
      8        .SsshSSsshhsSbbbbBccc.
      9        ..SsshhhhhsSbbbbbBBC..
     10        ...SSsssssSBBBBBBB....
     11        ....SSSSSS..ll.ll.ll..
     12        ...........l..l..l....
```

(Each letter replaces the real pixel at that spot. For example, `@` sits on column 7 of row 0 and `C` on column 21 of row 6. The exact values are `DEFAULT_ANCHORS` in `src/main/wardrobe/catalog.js`.)

| anchor | `[x, y]` | where |
|---|---|---|
| `head` | `[15, -1]` | just above the gap between the eyes |
| `face` | `[15, 0]` | between the eyes |
| `neck` | `[15, 4]` | where the eye stalks meet the body |
| `claw` | `[21, 6]` | tip of the claw pinch; held items usually sit on top of it |
| `shellTop` | `[7, 0]` | top of the shell |

**Choosing a pivot.** Pick the pixel of your item that should touch the anchor:

- For a hat, use the middle of the brim, usually the bottom row. In the witch hat above that's `[4, 3]`, so the brim sits right on top of the eyes.
- For glasses, use the bridge between the lenses.
- For a held item, use the spot the claw grips, such as the bottom of a candy cane's handle.

`pivot` values can be −16 to 32, so the pivot can sit outside your grid if that's easier.

**Skins can move anchors.** A crab with a different shape can put anchors somewhere else, and every accessory still fits. See [Skins](#skins).

### Follows

`follows` sets which part of Shellby your item moves with:

| `follows` | Moves with |
|---|---|
| `stalks` | the eye stalks, including the bob while he works |
| `eyes` | the eyes, including the scan while he works |
| `body` | the body, which tucks into the shell when he sleeps |
| `claw` | the claw: snaps, raises and waves |
| `shell` | the shell, which rocks while he naps |
| `legs` | the legs, which scuttle |

## Effects

Effects are little sprites that animate around Shellby. Shellby shows one effect at a time.

```jsonc
{
  "id": "bats",
  "name": "Bats",
  "description": "…",              // optional, up to 160 chars
  "motion": "orbit",               // see below
  "count": 8,                      // how many at once, 1–24 (default 10)
  "speed": 1,                      // 0.25–3 (default 1)
  "sprites": [                     // 1–6 sprites, each up to 8×8; Shellby picks between them
    { "palette": { "b": "#1a1a22" }, "pixels": ["b...b", "bb.bb", ".bbb."] }
  ],
  "rarity": "epic",
  "unlock": { "season": "halloween" }
}
```

| `motion` | Looks like |
|---|---|
| `fall` | drifts down from above, like snow or leaves |
| `rise` | floats up from below, like bubbles or hearts |
| `float` | hovers and wanders gently nearby, like fireflies |
| `orbit` | circles around Shellby, like bats |
| `twinkle` | fades in and out in place, like sparkles |
| `burst` | pops outward from Shellby, then fades, like confetti |

Keep sprites small and simple. At 1–3 pixels wide they read best, and a handful of them look better than a crowd.

## Skins

Skins use the [SKINS.md](SKINS.md) format and add two optional fields:

```jsonc
{
  "id": "ghost-crab",              // 1–40 chars: a-z, 0-9, "-"
  "name": "Ghost Crab",
  "palette": { … }, "parts": { … }, "pixels": [ … ],
  "unlock": { "achievement": "centurion" },
  "anchors": {                      // optional; any you leave out use the classic values
    "head": [12, -1],
    "claw": [18, 5]
  }
}
```

Each anchor value is `[x, y]` with integers from −16 to 48. If your crab has the classic shape, leave out `anchors`.

## Voices

A voice changes what Shellby says in his speech bubble. He wears **one voice at a time**: pick it under **Wardrobe → Voice**, and pick **His own** to go back. The built-in [`voices.json`](../src/wardrobe/voices.json) pack has a Pirate, a Grumpy crab, a Robot, a Surfer, a Royal, a Cowboy, Español and Français to copy from.

```jsonc
{
  "id": "pirate",
  "name": "Pirate Crab",           // 1–40 chars
  "description": "…",              // optional, up to 160 chars
  "lang": "en",                    // optional: the language the lines are in ("es", "pt-BR", …)
  "fallback": "shellby",           // optional: shellby (default) | quiet, see below
  "lines": {                       // what he says, by occasion. At least one.
    "working": ["arr, on it", "hoist the code!", "aye aye"],
    "success": ["treasure secured!", "yo ho ho!"],
    "error": ["we've sprung a leak", "man overboard!"]
  },
  "flavor": {                      // optional: extra lines for one temperament
    "cocky": { "success": ["captain's orders"] }
  },
  "rarity": "rare",                // optional, like any item
  "unlock": { "season": "summer" } // optional, see "Unlocking"
}
```

**Lines.** Each line is plain text of **at most 24 characters**, so it fits his bubble. Emoji and any language are fine. Control characters aren't. Each occasion takes 1–20 lines. Give an occasion three or more lines and he won't repeat himself, because he uses every line before he says one again.

**Occasions.** Where the voice has lines for an occasion, he uses them instead of his own. That includes the lines Shellby makes up for milestones and memories, so a grumpy crab stays grumpy at his 100th day. For occasions you leave out, `fallback` decides what happens:

| `fallback` | Occasions you didn't write lines for |
|---|---|
| `shellby` | he uses his own (English) lines. Good for a character voice that only covers his favourite moments. |
| `quiet` | he says nothing. Right for **another language**, so English never slips in. His built-in scenes still play, but without words. |

These are the occasions, from `OCCASIONS` in [`src/main/voice.js`](../src/main/voice.js):

| Group | Occasions |
|---|---|
| His moods | `working`, `success`, `error`, `learned` (a new trick), `newTricks` (Claude Code can do new things), `unlocked` (a new item), `petted` |
| The work | `tests`, `passed`, `fixed` (red tests green again), `merged` (your pull request merged), `push`, `deploy`, `bigWrite`, `sameFile` (third visit to one file), `searching`*, `web`*, `crew` (helpers), `longTask`, `serverDown` |
| What Claude Code does by itself | `todoDone`, `todosAll` (its to-do list), `jobDone`, `jobFailed` (a command left running), `remembered` (a memory written down), `skillFirst`, `planning` |
| Your day | `morning`, `latenight`, `back` (you were away for days), `gameOver`, `callOver`, `sheetStretch`, `docStretch`, `slideStretch` (hours in a spreadsheet, document or deck), `friday`, `weekend`, `monday` |
| You and him | `found` (he dug something up), `memory`, `milestone`, `idle`, `oops` (a clumsy habit), `tank`, `tankNew` (a piece you just put in his tank) |
| You, typing, and the weather | `typingBurst`, `typingRecord`, `rainStart`, `snowStart`, `stormStart`, `rainStopped` |
| Up on your windows | `perch`, `ride`, `shaken`, `dropped`, `dizzy`, `pop`, `caught` |
| Up the edges of the screen | `climb`, `stuck`, `leap`, `letgo` |
| Mischief, if you turned it on | `pinched`, `yanked`, `shoved`, `noteOff`, `note`, `behave`, `noPrank` |
| His needs | `peckish`, `sandy`, `sleepy`, `mopey`, `fed`, `stuffed`, `pantryEmpty`, `snackEarned`, `tide`, `rinsed`, `tuckedIn`, `notSleepy`, `cheered` |

\* only when he's set to chatty.

**Temperament.** Every Shellby has a temperament: `chipper`, `fussy`, `cocky` or `sleepy`. Lines in `flavor.<temperament>` are added to the voice's lines for crabs with that temperament. They count as lines for that occasion, so with `fallback: "quiet"` a flavor line alone is enough to make him speak.

His cooldowns and chattiness setting still apply in any voice, and a voice never speaks while he's guarding your focus or you're on a call.

## Scenes

A scene is a few **beats** strung together: he squints at something, creeps up, pounces, misses. Shellby picks one now and then when he's idle. Pack scenes join his own.

```jsonc
{
  "id": "spyglass",
  "name": "Keeps a lookout",       // 1–40 chars
  "description": "…",              // optional, up to 160 chars
  "voice": "pirate",               // optional: a voice in THIS pack. The scene only plays while he talks in it.
  "who": ["cocky", "chipper"],     // optional: temperaments it suits (they get it 3× as often). Everyone can get it.
  "when": { "night": true },       // optional: conditions that must all hold
  "beats": [                       // 1–8 beats, adding up to at most 12 seconds
    { "bit": "gaze", "ms": 2200, "say": "land ho?" },
    { "bit": "squint", "ms": 1400, "say": "…nope", "prop": "fly" },
    { "bit": "gaze", "ms": 1800, "say": { "any": "keep lookin'", "sleepy": "wake me at land" } }
  ]
}
```

Each beat is:

| Field | What |
|---|---|
| `bit` | the animation (required): `dig`, `polish`, `peek`, `stretch`, `flop`, `squint`, `creep`, `pounce`, `nose`, `sneeze`, `sniff`, `hic`, `hold`, `blow`, `nod`, `jolt`, `curl`, `admire`, `rock`, `bow`, `swat`, `jab`, `gaze`, `juggle`, `bonk`, `present`, `lean`, `sip`, `boogie`, `hide`, `boo`, `shiver`, `wave`, `count` |
| `ms` | how long it lasts (required): a whole number from 500 to 5000 |
| `say` | optional. A line, a list he picks one from (1–6), or lines by temperament: `{ "any": "…", "fussy": "…" }`. Same rules as voice lines. |
| `prop` | optional, something beside him: `castle`, `castle-fall`, `bubbles`, `fly`, `shooting-star`, `juggle`, `heart`, `achoo`, `zz`, `notes`, `sweat` |
| `hold` | optional, something in his claw: `find` (his favourite find), `coffee`, `pebble`, `mic` |
| `wear` | optional, on his face: `shades` |

A scene can only use the animations and props Shellby already draws, which is why it can't do anything else.

`when` conditions:

| Condition | Holds when |
|---|---|
| `"night": true` / `"day": true` | it's 9pm–5am / any other time |
| `"weekend": true`, `"friday": true`, `"monday": true` | it's that day |
| `"music": true` | something is playing |
| `"cursor": true` | your pointer is near him |
| `"find": true` | he has a favourite find |
| `"bond": 2` | you've reached that friendship level (1 Pals … 5 Inseparable) |
| `"season": "winter"` | that season is on (see [Unlocking](#unlocking)) |

**Scenes and voices.** A scene with `voice` only comes up while he talks in that voice, so it can be written in the voice's language. A scene without `voice` can come up for anyone, but while he wears a voice with `fallback: "quiet"`, it plays without words.

Pack scenes don't count toward his Storyteller trophy or the scene count on the Us page. Those are for his own scenes.

## Decor

Decor goes in his tank (Shellby's screen → **Tank**, see [TANK.md](TANK.md)): castles, plants, rocks, treasures and lights, plus the floor and the back glass. Decor unlocks, gets a "new" dot and syncs like any other item.

```jsonc
{
  "id": "lighthouse",
  "name": "Lighthouse",
  "description": "…",              // optional, up to 160 chars
  "category": "structure",         // structure, plant, rock, treasure, bubbler, substrate or backdrop
  "layer": "floor",                // optional: floor (default), back or float
  "palette": { "w": "#f3e6cc", "r": "#e63946", "y": "#ffd23f", "Y": "#fff2b8" },
  "pixels": ["..r..", ".yyy.", ".www.", ".rrr.", "wwwww"],   // up to 32×32
  "frames": [["..r..", ".YYY.", ".www.", ".rrr.", "wwwww"]], // optional: 1–3 more pictures, the same size
  "fps": 1,                        // with frames: 1–8 (default 2)
  "spots": [{ "kind": "hide", "at": [2, 4] }],              // optional, up to 4
  "rarity": "rare",
  "unlock": { "achievement": "green-light" }
}
```

- **`layer`:** `floor` pieces stand in one of three rows, and he walks between the back row and the front one. `back` pieces stand against the back glass, behind everything. `float` pieces hang in the water.
- **`frames`** play in a loop after `pixels`: a plant swaying, a lamp flickering. Keep them gentle. With reduced motion on, only `pixels` is shown.
- **`bubbler`** pieces on the floor get a column of bubbles rising from them. After dark, floating bubblers keep their glow.
- **`spots`** are places on the piece he can use: `hide`, `sit`, `climb`, `sleep`, `nibble`, `open` or `peek`. `at` is `[x, y]` inside the piece, and `y` may go above it (up to −32) for something he sits on top of. He uses them in his tank, except on `float` pieces, which he can't reach.
- **`substrate` and `backdrop`** are tiles the tank repeats: across the floor, or over the whole back glass. They have no `layer`, `frames` or `spots`. Keep them small (8×4 is plenty for a floor) and quiet, because everything else stands in front of them.
- Decor ids share their keys with the rest of the pack, so a piece can't have the same id as one of your accessories, effects, voices or skins.
- **Decor from packs stays on your PC.** It's in his tank and on the crab card you share yourself, and it syncs between your PCs, but it never goes on the public calling card or profile card: friends who peek at his tank see the built-in decor and his finds only.
- **In the gallery,** decor is its own category, next to accessories, effects and skins: the gallery's catalog lists each piece under `decor`, so Shellby can tell which pack a piece comes from.

## Unlocking

Items are available right away unless you add `unlock`. You can use one of these:

| `unlock` | Meaning |
|---|---|
| *(missing)* or `{ "default": true }` | always available |
| `{ "achievement": "<id>" }` | unlocked when the player earns that achievement |
| `{ "season": "<id>" }` | can be unlocked while that season is running |

If an achievement or season id doesn't exist, the item is skipped with a warning. The ids you can use are listed below. They're defined in `src/main/wardrobe/achievements.js` and `src/main/wardrobe/seasons.js`.

**Achievements:** `first-task` (1 task), `ten-tasks`, `quarter-century` (25), `centurion` (100), `crew-boss` (first helper), `all-hands` (3 helpers at once), `fleet` (25 helpers), `toolmaker` (first new trick), `inventor` (5 tricks), `tinkerer`, `clockwork`, `night-owl` (secret), `early-bird` (secret), `multitasker`, `careful`, `planner`, `special-delivery`, `loyal` (7 days), `check-up` (open the Health view), `keep-your-cool` (secret: cool down after a heat warning), `spring-cleaning` (free up space after a low-disk warning), `show-off` (share your crab card), `good-crab` (secret: pet him 25 times), `frequent-flyer` (secret: throw him), `deep-focus` (5 focus sessions), `green-light` (fix a failing build on a pull request), `tagged` (ship a project and earn its sticker), `sticker-bomb` (10 projects shipped), `shiny` (a sticker goes holo), `liftoff` (release a 1.0), `well-traveled` (stickers on 3 shells), `swap-meet` (a visiting friend leaves you a sticker), `beachcomber` (his first dug-up gift), `magpie` (25 gifts), `curator` (complete a set of finds), `x-marks` (secret: a legendary find), `best-friends` (reach Best friends), `peekaboo` (find him in hide and seek), `good-arm` (10 games of fetch), `player-two` (secret: he watches you finish 5 games), `on-air` (secret: he keeps quiet through 5 calls), `storyteller` (10 different little scenes), `gossip` (5 chats with visiting crabs), `moving-in` (the first piece in his tank), `interior-designer` (15 pieces in his tank at once), `house-guest` (a friend's crab drops by while his tank is on your cards), `open-house` (a friend's crab drops by), `pen-pals` (5 waves), `window-sill` (he climbs onto a window), `hang-on` (drag a window 2,000 px with him riding it), `rodeo` (secret: shake him off 10 times), `leap-of-faith` (secret: off one window onto another), `trapeze` (secret: thrown, he catches a title bar), `spider-crab` (he climbs the side of the screen 10 times), `sticky-feet` (secret: thrown, he sticks to the edge), `little-gremlin` (secret: 10 bits of mischief), `snack-time` (his first snack), `well-fed` (100 snacks), `squeaky-clean` (25 rinses), `night-night` (tuck him in 10 times), `golden-tummy` (secret: share a golden plankton), `launch-day` (deploy or publish), `back-to-green` (failing tests green 10 times), `ghostbuster` (secret: fix a flaky test), `critical-hit` (secret: one turn takes a red suite to green), `natural-twenty` (secret: 20 critical hits), `clean-landing` (secret: a copy comes home green first try), `issue-to-ship` (an issue to a pull request), `clean-bill` (a clean dependency audit), `tidy-shell` (turn off an idle plugin or MCP server), `fresh-start` (start a crowded conversation fresh), `on-a-roll` (7-day streak), `unstoppable` (secret: 30-day streak), `double-digits` (level 10), `aquascaper` (5 plants in his tank), `on-display` (3 sets of finds on display), `upsized` (the 30 gallon tank), `night-light` (secret: watch him fall asleep in his tank), `gotcha` (your first Bugdex bug), `field-notes` (10 kinds of bug), `naturalist` (every bug in one habitat), `fix-em-all` (40 kinds of bug), `exterminator` (100 bugs), `golden-touch` (secret: a golden bug), `ghost-whisperer` (3 ghosts from the wreck), `heisenberg` (secret: a legendary bug), `harvest-home`, `the-haunted`, `snowed-in`, `pen-pals-forever`, `spick-and-span`, `beachcombed` (finish each tide event while it's on), `tide-turner` (6 tide event medals), `glimmer` (your first sparkly one), `shiny-hunter` (5 sparkly ones), `dazzled` (secret: a sparkly legendary), `proud-parent` (a friend hatches your egg), `big-clutch` (5 friends hatch your eggs), `hatchling` (hatch a friend's egg), `fair-trade` (swap a find), `missing-piece` (finish a set with a swap), `top-crab` (top the friends' board for a month).

**Seasons** (local dates, both ends included; `spring`, `summer` and `autumn` move six months south of the equator, going by the town picked for the weather):

| id | window |
|---|---|
| `valentine` | Feb 7 – Feb 15 |
| `spring` | Mar 20 – May 31 |
| `summer` | Jun 21 – Aug 31 |
| `autumn` | Sep 15 – Nov 30 |
| `halloween` | Oct 1 – Nov 2 |
| `winter` | Dec 1 – Jan 7 |

Use `rarity` to say how special an item is. It changes how the item is shown in the Wardrobe, not how it's unlocked.

## Installing, testing and removing

- **Install:** use **Wardrobe → Install pack…** (**Shellby** in the bar at the bottom of the panel, or tray → Wardrobe), or copy the file into `%APPDATA%\Shellby\wardrobe\` yourself. Installed packs are saved as `<pack id>.json`.
- **Test:** edit the installed file and hit **Reload**. Warnings show up next to the pack in the Wardrobe.
- **Check before sharing:** run your file against [`addon.schema.json`](addon.schema.json) with any JSON Schema (draft 2020-12) validator. The community site uses the same schema, which is stricter than the app: it rejects unknown fields and bad items instead of skipping them. A few rules can't be written as a schema, so also install the pack and check that the Wardrobe shows no warnings for it. Those rules are: a scene's beats add up to at most 12 seconds, a scene's `voice` is a voice in the same pack, a scene can't need both `night` and `day`, an item id can't be shared by a voice and an accessory, effect or skin in the same pack, and for decor: `fps` only with `frames`, every frame the same size as `pixels`, each spot's `at` inside the piece, no `layer`, `frames` or `spots` on a substrate or backdrop, and no decor id shared with an accessory, effect, voice or skin.
- **Remove:** use the pack's **Remove** button in the Wardrobe, or delete the file.

## Publishing to the community gallery

Want other people to find your pack? Submit it to the community gallery:

1. Open a pull request to [x-salmon/shellby-packs](https://github.com/x-salmon/shellby-packs) that adds your pack file. Its [CONTRIBUTING.md](https://github.com/x-salmon/shellby-packs/blob/main/CONTRIBUTING.md) explains where the file goes and what reviewers look for.
2. Your pack must pass the same validation as the app (and the stricter [`addon.schema.json`](addon.schema.json) check), and follow the [rules for shared packs](#rules-for-shared-packs) below.
3. Once it's merged, your pack appears at [x-salmon.github.io/shellby-packs](https://x-salmon.github.io/shellby-packs/) with an **Add to Shellby** button. Anyone running Shellby 0.4.0 or later can install it in one click (they still see Shellby's confirmation dialog first).

To ship an update, bump `version` and open another pull request. Keep the same `id` so it replaces the old copy.

## Rules for shared packs

- **Original art only.** Don't include copyrighted characters, logos, brand marks or other people's sprites. Inspired-by is fine, but traced or copied isn't.
- **Original lines too.** Write your own voice lines and scenes. Don't paste song lyrics, film quotes or a character's catchphrases. A pirate crab is fine, a famous pirate isn't.
- **Data only.** Packs can't include code, scripts, HTML, or anything that loads from the internet. Shellby ignores everything it doesn't recognise. `homepage` is only shown as a link.
- **Keep it friendly.** Shellby sits on people's desktops, including at work. Anything hateful, sexual or gory will be removed, in pixels or in words. A grumpy crab can grumble, but he can't insult people.
- **Credit yourself.** Put your name in `author`, bump `version` when you update, and keep the same `id` so updates replace the old copy.

## Repo stickers

Every project Shellby sees you ship earns a sticker on his shell. Normally it's drawn for you from the repo (a shape, a pattern and its first letter, in the colour of its main language). A repo can ship its own official sticker instead, so everyone who works on it gets the same one: commit a file called `.shellby/sticker.json` at the root of the repository.

```json
{
  "palette": { "w": "#fffaf0", "k": "#1d3557", "o": "#ff7a5c", "y": "#ffd166" },
  "pixels": [
    "..wwwwwwww..",
    ".wkkkkkkkkw.",
    "wkooooooookw",
    "wkoyyyyyyokw",
    "wkoyookyyokw",
    "wkoyyyyyyokw",
    "wkooooooookw",
    ".wkkkkkkkkw.",
    "..wwwwwwww.."
  ],
  "micro": ["kok", "oyo", "kok"]
}
```

- `palette` and `pixels` work as they do in packs (see [Pixels and palettes](#pixels-and-palettes)): up to 16 colours and up to **16×16**, except that every character other than `.` must be in the palette. This is the sticker in the Sticker Book and on the crab card. A white border around the shape makes it read as a sticker.
- `micro` is optional: the **3×3** version that sits on his shell, using the same palette, with no transparent pixels. Without it, Shellby shrinks the big one.
- Shellby reads the file when the project ships, at most once a day per project, and only if it's under 16 KB. Anything that doesn't check out is ignored and the generated sticker is used instead. Like packs, it's data only.
