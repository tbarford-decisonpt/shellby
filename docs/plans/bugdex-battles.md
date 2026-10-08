# Bug battles, badges and the league

> Status: **built.** Follows [bugdex.md](bugdex.md), whose rules for seeing and
> catching are unchanged: a battle only shows them, it never decides a catch.

## The battle (`src/main/bugdex/battle.js`)

Every open encounter has a battle, kept **in memory only** (`wiring/bugdex.js`
`battles`). A restart starts each one afresh at full HP. Pure: no clock, no randomness.

- **HP** by rarity (common 40, uncommon 60, rare 90, legendary 140), ×1.5 for a
  habitat boss or the league. **Level** by rarity, +10 for a boss, +2 per stage
  you hold of it.
- **Floor.** Nothing but a catch takes HP below 12% of max. The knock-out is
  always the proven fix (lifecycle.js and cheats.js, as before).
- **Moves**, from what Claude does in that project:

  | What happened | Move | Effect |
  |---|---|---|
  | Read, Grep, Glob, LS, WebFetch, WebSearch | Scout | 3% each, 15% in all |
  | Edit, Write, MultiEdit, NotebookEdit (not a helper's own) | Patch | 8% |
  | A remedy command (cache clear, kill, install...) | Remedy | 10% |
  | A helper Claude sent out finished, in that tab | Assist | 10%, ×2 on its specialty |
  | The failing command re-run, the same bug in it | that command's kind | see below |
  | A fix the Bugdex refused (cheats.js) | Patch, *resist* | gives 20% back, says why |
  | The catch | faint, then the jar | 0 HP |
  | Closed without a catch | *fled* | |

- **A re-run** with a failing-test count (`detect.failedCount`) sets HP in
  proportion to failures left over failures at the start. Clearing half of them
  in one run is **a big one**. Fewer failures with the right tool for the bug's type
  (`SUPER`, the type chart) is **the right tool for the job** and counts double. More failures **heals** it, and the
  same number **misses**. With no count to go on, a re-run that still fails is a miss.
- Runs of the same Scout or Patch within 20 s are one move done ×N.
- The view gives every move its line ("Claude tries Test Run! Right tool for
  the job!"). The panel only draws.

## The screen (`src/renderer/panel/bugdex-battle.js`, `.css`)

An overlay with a handheld bezel. Each habitat paints its own water and decor
(kelp, the lighthouse beam, the trench's motes...). The scene has the HUDs, a
typed text box and a battle log for screen readers. Each move announces itself,
then animates (lens, slashes, beams, dodge, heal, shield, a crew member hopping
in), then says how it landed. The catch: it goes belly-up, a specimen jar is
lowered on a line, it drifts up in, the cork goes on and the line sets the jar
on the rock. (Nothing is thrown at it, and there's no wobble count: see
"Someone else's games" below.) Then a card: the Bugdex entry, a badge, or the Hall of Fame.

- Opened mid-fight, it catches up quietly and replays the latest move. Opened
  after a catch, it replays the finish.
- Sounds are asked of the crab (`bugdex:cue` → `critter:sound`), so they follow
  your sound settings. Each species' **cry** is synthesized from its dex number:
  its type picks the wave, its rarity the pitch.
- Reduced motion: no tide wipe, shakes or particles, and the lines show at once.
- A **chip under the tabs** shows the battle in that conversation, and
  `Watch` on the Bugdex page opens any of them. Switch: `bugBattles`.

## The crew

`crew-roster.js` keeps `beat: { [bugType]: n }` per member, credited at the catch
for each member in the battle's party (`recordBeat`), at `XP.beat` = 8. The type
with at least 3 is its **specialty**, which makes its assists count double.

## Badges and the league (`bugdex/species.js`)

Each habitat has a `boss` (never a league member) and a 7×7 `badge`. A boss's
first catch earns the badge. The league is the Deep Four (Segfault Squid,
Leaky Clam, Flaky Phantom, The Kraken) and the champion (Heisenbug). The
**Hall of Fame** is every boss and the whole league caught (`hallOf`). All of
it is worked out from the book, so sync needed nothing new.

## Friends

`shareBugdex` (off by default) puts `bugdex.shared()` on the public calling card:
the ids of the kinds caught, a badge count and whether you've made the Hall of
Fame. No counts, times or projects. A friend's report shows a species you've
never met as `reported` (a silhouette with its name). A visiting friend who
shares brings a **gift jar** (one a day each, preferring one you lack). It's
kept locally, never synced, never a catch, and can go in the tank.

## The rest

- **Lore** (`bugdex/lore.js`): a field note at stage II (5 catches) and a tip
  at stage III (15), for every species.
- **Follower**: the favourite catch's art (`critter:buddy`) walks a step behind
  him, and waits on the ground while he climbs or rides a window. Switch: `bugFollower`.

## Someone else's games

The Bugdex is a nod to the creature-collecting handhelds, and nothing more:

- **No names of theirs**: not the series, its book, its ball, its "Elite Four" (ours
  are the Deep Four), its creatures or its slogan.
- **No lines of theirs.** Battle text is Shellby's own ("Nullfish surfaced!", "Claude
  tries Test Run! Right tool for the job!", "Nullfish is out cold!", "Nullfish is in
  the jar!").
- **Not their screen.** Both creatures face each other on one seabed with both HUDs
  in a strip at the top (not one top-right and one bottom-left with a HUD each),
  and the screen opens with a tide wipe (not striped blinds).
- **Not their patented mechanics.** Nintendo holds and enforces patents on catching a
  creature by throwing an item at it and on showing the odds of a catch. Here nothing
  is thrown (the jar is lowered on a line, or he scoops it on the desk), there is no
  wobble count, and nothing shows a chance of catching. A catch is never a chance
  anyway: it's the fix being proven.

## Not doing

- Battles between friends' bugs (it would rank people by how many bugs they had).
- Outbreaks or bonus days for a kind of bug (rewarding bugs, not fixes).
