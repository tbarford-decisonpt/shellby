# Making a Shellby wardrobe pack

A wardrobe pack is **one JSON file** that adds things Shellby can wear or show:

- **Accessories**: hats, glasses, scarves, things to hold, things on his shell.
- **Effects**: little sprites that drift around him, like snow, bats or sparkles.
- **Skins**: whole new crabs. They use the same format as [SKINS.md](SKINS.md).

Packs hold **data only**: pixels, colours and a few settings. There is no code, scripting, HTML or links that run. Shellby checks every pack when it loads, so a broken pack can't break the app. The strict rules are in [`addon.schema.json`](addon.schema.json), and editors like VS Code can use that file to check your pack as you type.

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

2. Open **Wardrobe → Install pack…** (click the crab logo in Shellby's title bar, or tray → Wardrobe) and pick the file. Shellby copies it to `%APPDATA%\Shellby\wardrobe\my-first-pack.json`.
3. Open the Wardrobe and put the beanie on. To try a change, edit the file in `%APPDATA%\Shellby\wardrobe\` and hit **Reload** in the Wardrobe's packs section. You can also just drop the `.json` file onto the Wardrobe.

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
  "skins": []                      // up to 50
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
  "pivot": [4, 5],                 // the pixel of YOUR item that lands on the anchor
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

## Unlocking

Items are available right away unless you add `unlock`. You can use one of these:

| `unlock` | Meaning |
|---|---|
| *(missing)* or `{ "default": true }` | always available |
| `{ "achievement": "<id>" }` | unlocked when the player earns that achievement |
| `{ "season": "<id>" }` | can be unlocked while that season is running |

If an achievement or season id doesn't exist, the item is skipped with a warning. The ids you can use are listed below. They're defined in `src/main/wardrobe/achievements.js` and `src/main/wardrobe/seasons.js`.

**Achievements:** `first-task` (1 task), `ten-tasks`, `quarter-century` (25), `centurion` (100), `crew-boss` (first helper), `all-hands` (3 helpers at once), `fleet` (25 helpers), `toolmaker` (first new trick), `inventor` (5 tricks), `tinkerer`, `clockwork`, `night-owl` (secret), `early-bird` (secret), `multitasker`, `careful`, `planner`, `special-delivery`, `loyal` (7 days), `check-up` (open the Health view), `keep-your-cool` (secret: cool down after a heat warning), `spring-cleaning` (free up space after a low-disk warning).

**Seasons** (local dates, both ends included):

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

- **Install:** use **Wardrobe → Install pack…** (click the crab logo in Shellby's title bar, or tray → Wardrobe), or copy the file into `%APPDATA%\Shellby\wardrobe\` yourself. Installed packs are saved as `<pack id>.json`.
- **Test:** edit the installed file and hit **Reload**. Warnings show up next to the pack in the Wardrobe.
- **Check before sharing:** run your file against [`addon.schema.json`](addon.schema.json) with any JSON Schema (draft 2020-12) validator. The community site uses the same schema, which is stricter than the app: it rejects unknown fields and bad items instead of skipping them.
- **Remove:** use the pack's **Remove** button in the Wardrobe, or delete the file.

## Publishing to the community gallery

Want other people to find your pack? Submit it to the community gallery:

1. Open a pull request to [x-salmon/shellby-packs](https://github.com/x-salmon/shellby-packs) that adds your pack file. Its [CONTRIBUTING.md](https://github.com/x-salmon/shellby-packs/blob/main/CONTRIBUTING.md) explains where the file goes and what reviewers look for.
2. Your pack must pass the same validation as the app (and the stricter [`addon.schema.json`](addon.schema.json) check), and follow the [rules for shared packs](#rules-for-shared-packs) below.
3. Once it's merged, your pack appears at [x-salmon.github.io/shellby-packs](https://x-salmon.github.io/shellby-packs/) with an **Add to Shellby** button. Anyone running Shellby 0.4.0 or later can install it in one click (they still see Shellby's confirmation dialog first).

To ship an update, bump `version` and open another pull request. Keep the same `id` so it replaces the old copy.

## Rules for shared packs

- **Original art only.** Don't include copyrighted characters, logos, brand marks or other people's sprites. Inspired-by is fine, but traced or copied isn't.
- **Data only.** Packs can't include code, scripts, HTML, or anything that loads from the internet. Shellby ignores everything it doesn't recognise. `homepage` is only shown as a link.
- **Keep it friendly.** Shellby sits on people's desktops, including at work. Anything hateful, sexual or gory will be removed.
- **Credit yourself.** Put your name in `author`, bump `version` when you update, and keep the same `id` so updates replace the old copy.
