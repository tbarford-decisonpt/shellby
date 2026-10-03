# Built-in wardrobe packs

Everything in this directory ships inside the app. `loadCatalog` reads **every** `.json`
here as a built-in pack (`src/main/main.js` passes this directory as `builtinDir`), and
electron-builder packages it via the `src/**/*` glob — `.md` files are excluded, so this
one stays out of the installer.

Built-in items are keyed by **bare id** (`rubber-duck`), not the namespaced `pack/item`
key community packs get. Two packs in here must therefore never use the same item id;
`test/packs.test.js` fails the build if they do.

## What's here

| File | Contents | Why |
|---|---|---|
| `base.pack.json` | 41 accessories, 7 effects, 2 skins | The original wardrobe. Hand-maintained — the formatter deliberately skips it. |
| `shell-cargo.json` | 10 accessories | The `shell` slot had only 3 items. All ride the shell and rock when he naps. |
| `eyewear.json` | 9 accessories | The `face` slot had only 4. Two use `follows: eyes`, so they track his scan while he works. |
| `neckwear.json` | 7 accessories | The `neck` slot had 5, three of them scarves. |
| `dev-desk.json` | 5 accessories, 2 effects | One item per slot, so the set is wearable all at once. |
| `tide-pool.json` | 6 accessories, 2 effects | Where a hermit crab actually lives. |
| `on-call.json` | 5 accessories, 2 effects | Pager and extinguisher hang off `clockwork` and `keep-your-cool`. |
| `beach-day.json` | 6 accessories, 2 effects | Summer had 2 items. |
| `harvest.json` | 7 accessories, 1 effect | Autumn had 2 items. |
| `sweetheart.json` | 6 accessories, 1 effect | Valentine had 2 items. |
| `crab-species.json` | 4 skins | Reshaped crabs. Three move their `anchors` so accessories still land correctly. |
| `theme-crabs.json` | 6 skins | Recolours for themed desktops. |
| `sticker-shop.json` | 6 accessories | Rewards for the shell-sticker trophies (shipping projects, a 1.0, swaps). |

Totals: **114 accessories, 18 effects, 12 skins.**

## Unlocks

Of the 132 accessories and effects, **32 are available on day one, 61 come from trophies and
39 are seasonal** — so the wardrobe reads as a collection rather than a pile. The day-one set
exists to fill the slots that used to be empty (`face`, `neck` and `shell` had 4, 5 and 3
items, all of them locked); hats and held items stay mostly earned, the way the base pack
always had them.

Gating an item takes **two** edits that must agree:

1. `unlock: { achievement: 'x' }` on the item here — this hides it, and
2. the item's id in that achievement's `rewards` in [`achievements.js`](../main/wardrobe/achievements.js)
   — this announces it and tags it **new**.

The gate alone decides whether the item is wearable — `isUnlocked` reads the earned-achievement
list and never looks at `rewards` — so a mismatch is quiet rather than fatal. Set only the
first and the item unlocks with no notification and no **new** badge; set only the second and
the celebration claims you unlocked something you always had. `test/packs.test.js` checks both
directions.

## Working on them

```bash
npm run packs           # validate every pack: app loader + docs/addon.schema.json
npm run packs:format    # normalise formatting (skips base.pack.json)
npm run packs:sheet     # render docs/packs/<id>.png contact sheets
```

`npm run packs` is enforced by [`test/packs.test.js`](../../test/packs.test.js), which also
loads the whole directory and fails on any warning, key collision, or unlock that names an
achievement or season that doesn't exist.

**Render the sheets before and after changing art.** Items this small fail in ways the JSON
can't show: several here were redrawn after a first render put a dive mask above the eyes
and made a terrarium read as a first-aid kit.

## Format

Same data-only format as community packs — [docs/ADDONS.md](../../docs/ADDONS.md) and
[docs/addon.schema.json](../../docs/addon.schema.json). Validating against the gallery's
stricter upload schema is deliberate: it keeps every pack here publishable as-is, and keeps
the built-in content honest about the limits community authors work under.
