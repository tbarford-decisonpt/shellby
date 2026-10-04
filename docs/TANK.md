# His tank

Shellby has a home, and you decorate it. Put in a sandcastle, a rock cave, kelp, a treasure chest, the pebble he dug up last Tuesday. He wanders about among it all. Open it from **Shellby → Tank**, or press **Ctrl+K** and type *tank*.

Stickers decorate his shell, and the Beach shows what you've shipped. The tank is the part you arrange yourself.

## Decorating

Press **Decorate**. While you decorate, he steps to one side and goes see-through, so nothing hides behind him.

- **Put something in:** drag it from the tray into the tank, or click it, or press **Enter** on it. It goes in at the first good spot.
- **Move it:** drag it, or use the arrow keys. **Shift** moves it further. **Up** and **Down** move it a row back or forward.
- **Flip it** with **F**. Use **[** and **]** to send it back or bring it forward among the pieces in its row.
- **Put it away** with **Delete**. It goes back in the tray.
- **Undo and redo** with **Ctrl+Z** and **Ctrl+Y**, as far back as when you pressed Decorate.
- **Done** keeps it. **Cancel** puts everything back as it was.

The floor has three rows, the back, the middle and the front, and he walks in the middle one. So a castle in the back row stands behind him, and a rock in the front row hides his feet. Plants like kelp stand against the back glass, and the jellyfish lamp floats.

Under the tray you choose the **floor** (sand, gravel, pebbles), the **back glass** (clear water, a rock wall, stars), the **tank size** and the **light**. By default the light follows your clock, so the water darkens at night and lamps and bubblers keep their glow.

Every piece in the tank is a button you can tab to, with its name and where it stands. Screen readers hear what changes as you decorate.

## Where decor comes from

There's no shop and nothing to buy. Each piece comes from something specific, and a locked piece says what:

| | How | For example |
|---|---|---|
| **From the start** | Yours from day one | Sandcastle Keep, Rock Cave, Driftwood Arch, kelp, java fern, sea grass, a moss ball, rocks, an air stone, an amphora, two floors and two back walls |
| **Trophies** | Comes with a trophy | Sunken Chest (*Moving In*), Coral Fan (*Interior Designer*), Lighthouse (*Green Light*), Deep-Sea Diver (*Deep Focus*), Pebble Floor (*Beachcomber*), Jellyfish Lamp (*Best Friends*), Sunken Ship (*Double Digits*), Starry Night (secret) |
| **Seasons** | Turns up while its season is on, and stays | Carved Pumpkin (Halloween), Snow Globe (winter) |
| **His finds** | Anything he's dug up for you | Put in as many as he's found |

Wardrobe packs can add decor too: see [ADDONS.md](ADDONS.md#decor).

## Tank sizes

He grows into bigger tanks as he levels up. Each one holds more:

| Tank | Holds | When |
|---|---|---|
| Nano tank | 10 pieces | from the start |
| 10 gallon | 18 | level 5 |
| 30 gallon | 28 | level 15 |
| Reef tank | 40 | level 30, with 10 projects shipped |
| Grand aquarium | 56 | level 50 |

Smaller tanks stay available. If you move to one that holds fewer pieces than you have in, the newest go back in the tray.

## Trophies

| Trophy | How | Reward |
|---|---|---|
| 🪴 Moving In | Put the first piece in his tank | Sunken Chest |
| 🏰 Interior Designer | Have 15 pieces in his tank at once | Coral Fan |

## On the Health view

Once there's something in his tank, the picture of him on the **Health** view is a window into it: his floor, his back glass and whatever stands nearest. His moods (sweating, dizzy, stuffed) show on top as before.

## If a piece goes missing

Pieces from a pack you've removed, or that are locked again because you switched off **Unlock everything**, can't be shown. They keep their place, and the tank says how many there are. Put the pack back and they reappear where they were.

## For developers

- `src/main/tank.js`: sizes, rows, the stored tank (`config.tank`), `library` (decor from the wardrobe, plus his finds), `sanitize` and `view`. Pure, and covered in `test/tank.test.js`. It's called `tank`, never `home`: `config.home` is the shell he wears.
- `src/main/ipc/tank.js`: `tank:get`, `tank:save` and `tank:seen`. The editor sends the whole draft on Done, and `tank.sanitize` decides what of it he can really have: unlocked, within his finds, within the tank's room, a size he's grown into.
- `src/main/wardrobe/catalog.js`: the `decor` kind. `src/wardrobe/tank-decor.json` is the built-in pack.
- `src/renderer/panel/tank-paint.js`: paints a tank in art pixels at a whole-number scale, for the Tank tab and the Health porthole. `resolve` lays out a draft the same way `tank.view` does.
- `src/renderer/panel/tank.js` and `tank.css`: the Tank tab and the editor. It draws at 10 frames a second only while the tab is showing, and a single still frame when motion is turned down.
- **End-to-end check:** `node scripts/e2e-tank.js` decorates with the keyboard, checks what main refuses, looks through the Health porthole and restarts to see it all kept.
- The plan, and what comes next (him hiding in the castle, sets on display, decor that shows your PC's state): [plans/tank-decor.md](plans/tank-decor.md).
