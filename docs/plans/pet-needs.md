# Plan: Snacks and naps (his needs)

Shellby gets peckish, a bit sandy, sleepy, and a little mopey when you ignore
him. You keep him happy with plankton snacks you earn by getting things done,
a rinse, a tuck-in, and plain attention. It is built for just-the-crab users
first and works the same in Claude mode.

> **Status: built.** Where the build differs from the plan below:
> - The runtime lives in `src/main/care.js` (life.js stays glue), not inside life.js.
> - The daily hello snack comes from `life.newDay()` (source `new-day`), not the
>   `active` stat: that one fires once at launch, before life exists.
> - Snack pixel art lives in `needs.js SNACKS`, so the Us page and his claw draw the same plankton.
> - Shine's icon is 🧼, not 🫧: Windows 10's emoji font has no bubbles.
> - The Español voice (it falls quiet where it has no lines) got Spanish lines for every new occasion.
> - Tests: `test/needs.test.js`, `test/care.test.js`, and `scripts/e2e-needs.js` (in `e2e-ci`).
> - CHANGELOG and the version bump are left for merge time on main.

## 1. Rules that don't bend

These are the product's existing promises (`bond.js` header, the Us page's "It
never goes back down: he doesn't sulk"). Every one gets a test.

1. **Floors.** No need ever drops below its floor (see §3). He never gets sick,
   never runs away, never dies and never looks sad enough to make you feel bad.
   At worst he's peckish and a bit mopey.
2. **No penalties anywhere else.** Needs never change bond points, XP, levels,
   finds, trophies, streaks or stickers. Caring for him can *add* small amounts
   (§6); neglecting him takes nothing away.
3. **Nothing is blocked.** Low needs never refuse a task, a game, a dig, a perch
   or a focus session. Claude-mode work is never slowed or gated.
4. **No nagging.** Needs never raise a toast, Windows notification, phone or
   channel ping, sound, or panel badge. He only shows it on the desktop: body
   language, plus at most one needy line every 45 minutes. In `quiet` chatter,
   during focus, on a call or while you're working, it's body language only.
5. **Time away is free.** Decay only runs while you're at the PC (the same
   `systemIdleSeconds < 90` test `life.js hereCheck` uses). A week's holiday
   costs nothing, and you come back to a happy "you're back!".
6. **One click fixes it.** Any single kind act (a pet, a snack, a game) lifts
   him out of mopey straight away. Recovery is fast; decay is slow.
7. **Off means off.** A setting turns the whole thing off: meters hidden, menu
   items gone, all needs read as full.

## 2. What exists today (what this builds on)

| Piece | Where | Used for |
|---|---|---|
| Life loop (15 s watch, naps, idle bits, scenes, `onStat`, `onPet`, `played`) | `src/main/life.js` (554 lines) | Ticks, hooks and actions all live here |
| Every event (`stat(event)`) already reaches `life.onStat` | `src/main/main.js:2121` | The single place snacks are earned |
| Task finished OK → `stat('task-completed')` | `main.js:2188`, `:2349` | Claude-mode snacks |
| Focus finished → `stat('focus-completed')` | `main.js:4042` | Snacks in both modes |
| Pure, tested rules modules with `normalize/earn/view` and `perDay` caps | `bond.js`, `gifts.js`, `focus.js`, `xp.js` + `test/*.test.js` (`node --test`) | The pattern `needs.js` copies |
| Settings persisted to `%APPDATA%/Shellby/settings.json`, sync write | `src/main/config.js` | New keys `needs`, `needsOn` |
| Critter status push (`critter:state`) and body classes | `main.js:1005`, `critter.js paintBody()` (`:370`) | His look when peckish or mopey |
| Props / held items / worn items drawn from pixel art | `src/renderer/critter/life.js` `ART`/`HOLD`/`DRAW` | Plankton in his claw, crumbs, suds |
| Existing bits that fit: `bit-polish`, `bit-sit`, `bit-stretch`, `bit-flop`, `nodoff` scene, `bubbles`/`zz`/`sparkle` props | `critter.css`, `scenes.js` | Rinse, mopey, sleepy, tuck-in |
| Right-click menu, `playMenu()` | `main.js:6493`, `:6636` | Feed / Rinse / Tuck in |
| Us page (bond, games, unlocks, story) | `panel.html:729`, `src/renderer/panel/together.js` | The "How he's doing" card |
| Crab-only mode has no tasks (`claude &&` menu items) | `main.js:6495`, `panel/crabonly.js` | Why snacks can't come from tasks alone |

## 3. The model

### Four meters, 0–100, each with a floor

| Meter | Shown as | Goes down | Comes back | Floor | "Low" below |
|---|---|---|---|---|---|
| **Fullness** | 🦐 Tummy | −7/h while you're here | Snacks (+25 plankton, +45 krill, +60 golden) | 25 | 45 |
| **Tidiness** | 🧼 Shine | −1.5/h, plus events: dig −6, thrown −4, window ride −3, shaken off −3 | Rinse (+100, 1 h cooldown); a little from rain scenes | 30 | 45 |
| **Energy** | 💤 Pep | Task done −2, focus session −8, game −5, thrown −3; −2/h awake | Naps +30/h, sleeping state +20/h, idle +4/h, Tuck in (starts a nap) | 30 | 40 |
| **Cheer** (company) | 💛 Cheer | −9/h only while you're **at the PC and not interacting** | Pet +20, snack +25, game +30, rinse +10, tuck-in +10, panel opened on Us +5, back after ≥1 h away → 100 | 35 | 45 |

All rates live in one frozen `RATES` table in `needs.js` so tuning is a one-line
change. Worst case from full, at the PC all day: Tummy reaches its floor after
about 11 h, Cheer gets mopey after about 6 h of being ignored while you're there.

### Mood (derived, never stored)

First match wins:

1. `mopey`: Cheer below 45 (he's been ignored while you were right there)
2. `peckish`: Tummy below 45
3. `sleepy`: Pep below 40
4. `sandy`: Shine below 45
5. `happy`: every meter at 70 or above
6. `content`: everything else

`low` is the list of every meter below its "low" line, so the look can stack:
a peckish crab can also be a bit sandy.

### Plankton snacks (the pantry)

- Three kinds: **plankton** (everyday), **krill** (uncommon, fills more, extra
  hearts), **golden plankton** (rare, sparkles, from milestones and legendary
  finds).
- The pantry holds at most **12**. Past that, he says "pantry's full!" and keeps
  nothing, so there's no pressure to hoard and nothing to lose.
- **Full tummy:** feeding at Tummy 95 or above doesn't use a snack. He pats his
  belly: "stuffed. saving it."
- **The tide:** if the pantry is empty and Tummy is at its floor, one plankton
  washes up every 3 h you're at the PC ("the tide brought snacks!"). Nobody is
  ever stuck with a hungry crab and no way to feed him, even someone who only
  keeps him on the desktop.

### Where snacks come from

Every source has a daily cap (`perDay`, as in `bond.EARN`). Mapped from existing
`stat()` events, so nothing new fires in `main.js`:

| Source (`stat` event) | Mode | Snack | Per day |
|---|---|---|---|
| `task-completed` | Claude | plankton | 8 |
| `focus-completed` | both | plankton ×2 | 3 sessions |
| `active` (first visit of the day) | both | plankton ×2 | 1 |
| `health-cooled`, `health-space-freed` (you fixed something in Health) | both | plankton | 3 |
| `hide-found`, `fetched` (a game) | both | plankton | 3 |
| `find-made` | both | 1 in 4 finds: krill | 2 |
| `legendary-find`, `set-completed` | both | golden | 1 |
| `ci-fixed`, `routine-run` | Claude | plankton | 3 |
| bond level-up, day milestone (`life.grow`) | both | golden | uncapped (rare anyway) |

Crab-only users get about 6–10 snacks on a normal day from focus, the first
visit, Health and games. Claude users get the same plus tasks. Both are far
more than the 2–3 snacks a day he needs.

### State on disk (`config.needs`, local only, never synced)

```js
{
  v: 1,
  meters: { fullness, tidiness, energy, cheer },   // floats, clamped [floor, 100]
  updatedAt,                                        // last tick
  pantry: { plankton, krill, golden },
  today: { date: 'YYYY-MM-DD', earned: { [source]: n } },
  lastFedAt, lastRinseAt, lastTuckAt, lastNeedyLineAt, lastHereAt,
  totals: { fed, rinsed, tucked, earned },          // for trophies and the Us page
  introduced: false,                                 // the one-time "new!" card
}
```

It isn't synced through the gist (`github/sync.js`): two PCs would fight over
meters. Totals feed trophies, and trophies already sync.

## 4. New pure module: `src/main/needs.js` (~260 lines)

No I/O, no timers, no randomness of its own (same contract as `bond.js`).

```text
RATES, FLOORS, LOW, SNACKS, SOURCES, PANTRY_MAX     frozen tables
normalize(raw)                     tolerate anything from disk; fills from defaults; full meters for a new state
tick(state, now, { present, napping, sleeping, interacting })
                                   apply decay/recovery for elapsed time; elapsed clamped to 10 min per tick
                                   (a suspended PC can't cause a jump); only decays when present
wear(state, event, now)            dig/thrown/ride/shaken/task/focus/game → tidiness/energy costs
earn(state, source, now, rand)     → { state, snack|null, reason: 'capped'|'pantry-full'|null }
tide(state, now)                   → { state, snack|null }: the empty-pantry safety net
attend(state, kind, now)           pet/play/panel/back → cheer up
feed(state, now, kind?)            → { state, ok, reason: 'empty'|'stuffed'|null, ate, moodBefore, moodAfter }
                                   picks the plainest snack you have unless `kind` is given
rinse(state, now)                  → { state, ok, reason: 'cooldown'|'clean'|null }
tuckIn(state, now)                 → { state, ok }: marks a nap wanted; energy recovers via tick(napping)
mood(state)                        → { mood, low: [...] }
needyLine(state, now)              → occasion name or null (45-min gap, low need only)
napChance(state)                   → multiplier for life.js maybeNap (1 … 2.5 as Pep falls)
view(state, now)                   → everything the Us card shows (meters as 0–100 ints + labels)
menuLabel(state)                   → "Feed him (🦐 5)" / "Feed him (stuffed)" / "Feed him (no snacks yet)"
```

Labels are words, not numbers, in the UI: Tummy "full / satisfied / peckish",
never "starving". Numbers only in a tooltip.

## 5. Wiring in the main process

### `config.js`

Add `needs: null` (state) and `needsOn: true` (setting) to `DEFAULTS`, with
comments in the house style.

### `life.js` (+~90 lines, stays under 650)

- `getNeeds()` keeps the state **in memory**. `saveNeeds()` writes it only when a
  rounded meter moves by 5 or more, on any action (feed/rinse/earn), every 5
  minutes, and in `stop()`. This avoids a sync `settings.json` write every 15 s.
- `watch()` (every 15 s): `needs.tick(...)` with `present` from
  `systemIdleSeconds() < HERE_IDLE_S`, `napping()` and `d.sleeping?.()`. Then
  `tide()`, then push the look to the crab if `mood` changed.
- "Back after ≥1 h away" (the first present tick after a long idle) →
  `attend('back')` plus a happy `back` line, never a guilt line.
- `onStat(event, payload)`: one new line, `earnFrom(event, payload)`, which calls
  `needs.wear` and `needs.earn` from the `SOURCES` table. When a snack is earned
  and he's free: a tiny catch (a plankton prop drops, he grabs it, "snack!")
  that's skipped if busy. Only the panel count updates.
- `onPet()` → `attend('pet')`. `played()` → `attend('play')` + `wear('game')`.
- `grow()` level-up / milestone → golden snack.
- `maybeNap()`: multiply the chance by `needs.napChance()`.
- `idleBit()`: when `mood.low` is non-empty, about 35% of habit picks become a
  need bit (tummy rub, scratch sand off, big yawn, sigh-and-sit) instead of a
  generic one. Needy lines go through `needs.needyLine()` and the existing
  `d.speak()` gates (quiet / focus / call / working).
- New actions, each calling `cancel()` first like `digNow()`:
  - `feed()`: `needs.feed` → beats: `plankton-drop` prop → `held: plankton` →
    `bit-munch` → `crumbs` prop + hearts → line (`fed` / `stuffed` / `empty`).
    Then `grow('feed')`, `d.awardXp('feed')`, first time `remember('first-snack')`.
  - `rinse()`: `suds` prop + `bit-polish` → `sparkle` → "squeaky clean!". Then
    `grow('care')`, first time `remember('first-bath')`.
  - `tuckIn()`: `zz` prop, `nodoff` beats, then starts a normal nap (reuses
    `napUntil`), so the sleeping state and Pep recovery come for free.
- `needsMenu()` → the menu items (§7). `needsLook()` → `{ mood, low }` for
  `critter:state`. `view()` gains `needs: needs.view(...)`.
- dev/e2e: `needsForTest(patch)` and `tickForTest(ms)`.

### `main.js` (small, surgical)

- `deps` for `createLife`: add `sleeping: () => lastStatus.state === 'sleeping'`.
- `critter:state` payload (`:1005`): add
  `needs: config.get('needsOn') && ['idle','sleeping'].includes(state) ? life.needsLook() : null`.
  While he's working, asking or showing CI/health/focus/call signs, needs are
  invisible.
- `buildMenu()`: add `needsMenu()` after `playMenu()` (§7).
- IPC (with the existing `ipc-guard` pattern): `needs:feed`, `needs:rinse`,
  `needs:tuck`, `needs:seen-intro`. Each returns `life.view()`.
- `CAPTURE` mode (screenshots): needs pinned at full so screenshots stay stable.
- Settings change `needsOn` → `refresh()` and `toPanel('life', view())`.

### Small additions elsewhere

- `xp.js AWARDS`: `feed: { xp: 3, perHour: 3, label: 'Fed Shellby', way: 'Feed him a snack' }`
  and `care: { xp: 3, perHour: 2, label: 'Looked after Shellby', way: 'Rinse him or tuck him in' }`.
- `bond.js EARN`: `feed: { points: 1, perDay: 3 }`, `care: { points: 1, perDay: 2 }`.
  `MEMORIES`: `first-snack` 🦐, `first-bath` 🧼, `golden-snack` ✨.
  `RECALL`: `first-snack` → "remember my first snack?". Leave the header promise
  as is: still true.
- `wardrobe/achievements.js` trophies: **First snack**, **Well fed** (100
  snacks), **Squeaky clean** (25 rinses), **Night night** (10 tuck-ins),
  **Golden tummy** (a golden snack). Recorded with `stat('fed')`,
  `stat('rinsed')`, `stat('tucked')`, `stat('golden-snack')`.
- `voice.js` occasions with bubble-sized lines (≤ 24 chars) per temperament:
  `peckish` ("tummy's rumbling…", "is that plankton?"), `fed` ("nom nom nom",
  "best. snack. ever."), `stuffed`, `pantryEmpty` ("no snacks… later?"),
  `snackEarned`, `tide`, `sandy` ("bit sandy here"), `rinsed`, `sleepy`
  ("*yawn*"), `mopey` ("…", "hey… you there?"), `cheered` ("you're back!"),
  `back`. Wardrobe dialogue packs can override them like any other occasion.

## 6. Rewards for caring (positive only)

- Feeding him while he's peckish: hearts, +1 bond (3/day), small XP.
- A snack when he's mopey: a "perk up" bit (jump, hearts) and an extra-warm line.
- Golden snack: sparkle burst and a journal entry.
- Us page "Care" stats: snacks shared, baths, tuck-ins. Counts only, no streaks:
  streaks turn into guilt, and rule 4 forbids guilt.

## 7. Interactions

### Right-click menu (both modes)

```
Feed him (🦐 5)              ← top level, right under Play
Care ▸  Give him a rinse     (or "Rinse (in 40m)", disabled)
        Tuck him in
        How he's doing…      → panel Us page, scrolled to the card
```

When the pantry is empty, the item is disabled with a hint that fits the mode:
crab-only "Feed him (finish a focus session for snacks)", Claude "Feed him
(snacks come from finished tasks)". The whole block is hidden when `needsOn` is
false.

### Desktop body language (`critter.css` + `critter/life.js`, plus `needs.css` ~150 lines)

`critter.js paintBody()` adds `needs-<mood>` and `low-<meter>` classes from the
`critter:state.needs` payload.

| Mood / low | Look | Reduced motion |
|---|---|---|
| peckish | Every ~20 s a tummy-rub wiggle; now and then a thought bubble with a pixel plankton | Static thought bubble only |
| sandy | 3–5 sand-speck pixels on his shell (a `::after` overlay), more as Shine drops | Same (static) |
| sleepy | Eyelids half down, slower idle bob, more yawns (`nodoff` weight up) | Lids only |
| mopey | Eyes a little lower, uses `bit-sit`, wanders less (`motion.js` wander chance ×0.4), soft "…" | Lids + sit pose |
| happy | Slightly bouncier idle; the occasional sparkle | No sparkle |

New art in `critter/life.js`: `HOLD.plankton` / `HOLD.krill` / `HOLD.golden`
pixel art, plus `DRAW['plankton-drop']`, `DRAW.crumbs` and `DRAW.suds` props.
New CSS bit `body.bit-munch`. Everything respects `prefers-reduced-motion` the
way `api.onProp` already does.

### Panel: Us page "How he's doing" card (`panel.html` + new `panel/needs.js` ~150 lines + `together.css`)

- Sits under the hero. Four soft meters with icons and word labels, no reds:
  warm amber at the low end, never a warning colour. `role="meter"` with
  `aria-valuenow` and a text label.
- Pantry row: 🦐 5 · 🦐 1 krill · ✨ 0, plus "Where snacks come from", with only
  the sources for the current mode.
- Buttons: **Feed** · **Rinse** · **Tuck in**. Disabled states explain why
  ("He's stuffed", "Rinse again in 40m").
- The `usCrab` in the hero munches too when you feed from the panel.
- One-time intro card (`introduced`): "New: he gets peckish now. Snacks come from
  focus sessions, Health fixes and games (and finished tasks with Claude). He
  never gets more than a little mopey, and nothing you've earned ever goes
  away." [Got it] [Turn this off].
- Update the unlocks meta line "It never goes back down: he doesn't sulk" to
  "Your bond never goes back down", since he can now be a *little* mopey.

### Settings (`panel/settings.js`)

Under the crab section: **Snacks and naps**, `[On | Off]`, with the hint "He gets
peckish and a little mopey if you ignore him, never worse. Off keeps him
content all the time." `needsOn: false` keeps the state on disk, so turning it
back on resumes where it was, but the meters reset to full so he doesn't come
back hungry.

### Crab-only onboarding and copy

- `crabonly.js` toast after choosing crab-only: "…click him any time. Feed him
  snacks from focus sessions and games."
- Upsell copy stays as it is. Snacks never become a reason to need Claude:
  crab-only users get plenty.

### Work mode

Work mode (`workmode.js`) doesn't switch needs off; it rests them. `care.js`
skips the tick and the wear while it's on, so nothing drops and he never shows
a need or mopes, but snacks are still earned and Feed / Rinse / Tuck in still
work. Going in or out starts the clock from then (`restSwitched`), so the time
spent resting costs him nothing. The Us page says "Resting while you work".

## 8. How it stays in its lane (state precedence)

The order the critter shows things, highest first. Needs only take the last slot:

`working/asking` > `flash` (success/error/petted) > health critical > limit nap >
focus helmet > call "shh" > CI/server signs > **needs look (idle/sleeping only)**

Needy lines additionally skip when: chatter is `quiet`, `life.free()` is false,
a visit is in progress, or the screen is locked (`calm()`).

## 9. Build order (each phase ships green)

**Phase 1: Model (pure, test-first)**
1. `test/needs.test.js` written first, then `src/main/needs.js`.
2. Tests (Arrange-Act-Assert, `node:test`):
   - meters never go below their floor, even after 1 year of ticks
   - no decay when not present; a week away leaves meters unchanged
   - a tick's elapsed time is clamped (suspend/resume can't jump)
   - feeding while stuffed keeps the snack; feeding with an empty pantry says `empty`
   - pantry never exceeds 12; earning past it reports `pantry-full`
   - every source respects `perDay` and resets on a new local day
   - the tide only gives a snack when empty and at the floor, at most once per 3 h present
   - a single pet / snack / game lifts `mopey`
   - mood priority order; the `low` list is complete
   - `normalize` survives garbage (strings, NaN, negative, missing keys) and keeps the old state unmutated
   - `needyLine` respects the 45-minute gap
   - **no-penalty guard:** `needs.js` exports nothing that touches bond, xp or finds
     (a static check that it doesn't `require` them)

**Phase 2: Main wiring**
3. `config.js` defaults, `life.js` wiring (batched saves), `xp.js` / `bond.js`
   additions with their existing tests extended.
4. `main.js`: `critter:state.needs`, menu, IPC, `CAPTURE` pin.
5. `test/life-needs.test.js`: drive `createLife` with fake `deps` (fake clock,
   `config` stub) to check that `stat('task-completed')` and
   `stat('focus-completed')` earn snacks, that `feed()` calls `awardXp('feed')`
   and `grow('feed')`, that saves are batched (no `config.set` on a quiet tick),
   and that bond points never drop across a simulated neglected week.

**Phase 3: Desktop look**
6. Pixel art, props, `bit-munch`, `needs.css`, `paintBody` classes, reduced-motion
   variants, `voice.js` lines (and `npm run packs` so pack validation still passes).

**Phase 4: Panel and settings**
7. Us page card, intro card, settings toggle, crab-only copy, the unlocks-line
   wording.
8. `test/panel-a11y.test.js`: meters have roles and labels; buttons have names.

**Phase 5: Trophies, docs, release**
9. Trophies and memories; `docs/DESKTOP.md` "Snacks and naps" section (the rules
   from §1 in plain words); README feature bullet.
10. CHANGELOG entry and version bump **at merge time on main only** (the
    project's release rule); `npm run release:ready` before tagging.

## 10. Verifying it for real

- `npm test` and `npm run lint` green.
- Run the app (`/run`) with the dev hook `needsForTest({ fullness: 30, cheer: 40 })`:
  check the mopey look, then feed from the menu (munch plays, look clears), then
  rinse cooldown in the menu, then tuck in (he naps and Pep climbs).
- Crab-only mode: finish a 15-minute focus session → +2 plankton; play fetch →
  +1; Health fix → +1.
- Claude mode: finish a task → +1 plankton; the 9th task of the day earns nothing.
- Reduced motion on (Windows setting): every state still reads, nothing moves.
- Leave it alone with the PC locked for an hour: meters unchanged, happy greeting.
- `needsOn` off: menu items gone, card gone, look gone; on again: meters full.
- Close every process the run launched (the project's clean-up rule).

## 11. Files

| New | ~Lines |
|---|---|
| `src/main/needs.js` | 260 |
| `src/renderer/critter/needs.css` | 150 |
| `src/renderer/panel/needs.js` | 150 |
| `test/needs.test.js` | 250 |
| `test/life-needs.test.js` | 150 |

| Changed | What |
|---|---|
| `src/main/config.js` | 2 defaults |
| `src/main/life.js` | ticks, earning, actions, view (+~90) |
| `src/main/main.js` | deps, state payload, menu, IPC, capture pin (+~40) |
| `src/main/xp.js`, `src/main/bond.js` | award kinds, earn kinds, memories |
| `src/main/voice.js` | need occasions and lines |
| `src/main/wardrobe/achievements.js` | 5 trophies |
| `src/preload/preload.js` | `needs.feed/rinse/tuck/seenIntro` |
| `src/renderer/critter/critter.js`, `critter.css`, `critter.html`, `critter/life.js` | classes, art, props, `bit-munch`, stylesheet link |
| `src/renderer/panel/panel.html`, `together.js`, `together.css`, `settings.js`, `crabonly.js` | card, toggle, copy |
| `docs/DESKTOP.md`, `README.md`, `CHANGELOG.md` | docs (CHANGELOG at merge) |

`main.js` is already 6,463 lines. This adds only glue there; all logic stays in
`needs.js` / `life.js`.

## 12. Open choices (defaults chosen; change any before building)

1. **Cheer decay while you're present but busy in other apps:** default yes, at
   −9/h. That's what "ignore him" means. Alternative: only count time when the
   panel is closed *and* you haven't clicked him.
2. **Snacks in the friends/crab card:** default no (YAGNI). Could later show
   "well fed" on visits.
3. **Stream overlay / RGB lighting reacting to munching:** default no (later).
4. **Snack kinds:** default three (plankton, krill, golden). A smaller first cut
   could ship plankton only and add krill/golden in phase 5.
