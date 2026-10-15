# Shellby Gamification Overhaul: Design and Implementation Plan

This plan is meant to be saved as `docs/GAMIFICATION-PLAN.md`. I read these to write it: `xp.js`, `quests.js`, `streaks.js`, `bounties.js`, the bugdex modules (`battle.js`, `lifecycle.js`, `cheats.js`), `bugdex.js` exports, `shells.js`, `tank.js`, `wardrobe/catalog.js`, `wardrobe/achievements.js`, `rooms.js`, `feature-use.js`, `weekly.js`, the `events.js` header, `quiz.js`, `wiring/progress.js`, `wiring/bugdex-reward.js`, `ipc/progress.js`, the preload, `scripts/panel-html.js`, `shared/sprite.js` and `card.js`/`week-card.js`.

---

## 0. The diagnosis, and the one idea that fixes it

Today each system pays XP and then stops. Nothing it produces is used by anything else:

- Battles end at the catch.
- The tank only takes finds and jars.
- Trophies unlock hats.
- Quests stop after 4.
- Streaks punish a missed day.
- Weekly data is gone after 70 days (`weekly.KEEP_DAYS`).

**The fix is a shared bus that already exists: achievement stats.** `d.stat(event, payload)` goes to `wardrobe/achievements.js` `recordStat`, and that unlocks wardrobe items through `unlock: { achievement }`, including **tank decor** (`wardrobe/catalog.js validateDecor`), and pays the `trophy` XP award. Every new system:

1. **emits stats** on real outcomes (nest cleared, reef high-water mark, review tier, molt, Wrapped year),
2. **reads other systems' views** through one composer (`logbook.js`), so the Logbook and the quest chapters can say how each thing leads to the next,
3. **pays out in something another system uses**: tank pieces, coral growth, quest progress, level unlocks.

### Integration map (what feeds what)

```
                 ┌──────────── real work (tests, pushes, fixes, reviews) ────────────┐
                 ▼                         ▼                        ▼                  ▼
          BUG BATTLES ──fix report──▶ NESTS ──cleared──▶ REEF HEALTH ◀── signals (lint/any/CI/flaky/deps/coverage)
          (quality.js)   (rematch)   (nests.js)  (signal)  (reef.js)        │
             │  │                       │                     │ high-water marks
             │  └─ 'held' after 14d ────┘                     ▼
             │                                          CORAL in TANK (grows; fading = paler only)
             ▼                                                │
     XP (xp.js AWARDS) ◀── REVIEW MASTERY (review-mastery.js) ◀── quiz + line comments + caught-before-merge
             │                       │
             ▼                       ▼
     LEVELS 1–99 (levels.js UNLOCKS: titles, shells, decor, perks, chapters, tank sizes)
             │ 99
             ▼
     MOLTING (molting.js) ──tier shell (shells-molt.js / shell-gen.js) + badge
             │
   all of the above ──d.stat()──▶ ACHIEVEMENTS ──unlock──▶ RARE TANK PIECES (src/wardrobe/milestones.json)
             │
             ├──▶ QUEST CHAPTERS (quests.js): unlocked by level / never-used screens, each teaches the next link
             ├──▶ LOGBOOK (logbook.js): one screen, every card links to the screen it comes from
             └──▶ YEARBOOK (yearbook.js) ──Jan 2──▶ SHELLBY WRAPPED (wrapped slides + card)
     STREAKS (streaks.js, tide-outs + weekends) ──multiplier that ebbs, never drops──▶ XP
```

### Rules kept everywhere

- **Quality over volume.** Every new award has a `perHour` cap, and most also have per-project or per-day caps in their own module.
- **Anti-cheat.** Any fix-based reward reuses `bugdex/cheats.js judge()`. The new quality checks reuse `splitPatch`, `isTestFile`, `SUPPRESS_ADD` and `onlyBiggerNumbers`.
- **Nothing is ever taken away.**
  - Molting resets the level number only. Every unlock is gated on a new `everLevel` (section 3.1).
  - Coral fades in colour only. Growth is a count that only goes up.
  - Streak bonuses ebb by one step per missed day.
  - Nests are a to-do list, not a penalty.
- **Pure modules.** No I/O and no clock (callers pass `now`), each with a `test/<name>.test.js` on `node:test`, and every file under 800 lines.

### Files near the 800-line limit

These must not grow; new code goes in new files.

| File | Lines |
|---|---|
| `src/preload/preload.js` | 799 |
| `src/renderer/panel/bugdex-battle.js` | 775 |
| `src/main/wiring/bugdex.js` | 741 |
| `src/main/bugdex/index.js` | 693 |
| `src/main/bugdex/species.js` | 686 |

### Naming collision

`shells.js` and `wiring/progress.js molt()` already call the level-up shell change a "molt".

- The prestige feature is **Molting** in the UI, but the code module is `molting.js` and its state is `xp.molt`.
- The existing per-level animation keeps its name.
- Copy: the level-up animation is "moves into a new shell". The prestige is "Molt".

---

## 1. Shared contracts (Work Package 0, done first, about half a day, one agent)

Everything other agents would otherwise fight over is created up front as stubs, so WP1 to WP5 touch separate files.

### 1.1 One generic panel bridge (`src/preload/preload.js`, owned by WP0)

The preload is at 799 lines. Fold the existing `// quests:` and `// the Bugdex:` comment lines into the line above them so the file stays at 799 or less, then add:

```js
getGame: invoke('game:get'),   // (what, arg) -> view; what ∈ GAME_VIEWS
gameAct: invoke('game:act'),   // (what, action, payload) -> view
onGame: on('game'),            // ({ what, view, event? })
```

### 1.2 Main-side registry

- **`src/main/game-hub.js`** (new, not pure, about 60 lines). Holds `register(what, { get, act })`, `get(what, arg)`, `act(what, action, payload)` and `push(what, view, event)`. `push` calls `d.send(d.panel, 'game', …)`. An allowlist of names is fixed in the file: `logbook, quests, reef, review, nests, molt, wrapped, unlocks, yearbook`. Unknown names are refused.
- **`src/main/ipc/game.js`** (new). Registers `game:get` and `game:act` behind `ipc-guard.js` and validates strings. WP0 also registers it in `src/main/ipc/index.js`.

### 1.3 XP awards (all added to `xp.js AWARDS` by WP0, so the table is touched once)

| kind | xp | perHour | label / way | claude | paid by |
|---|---|---|---|---|---|
| `chapter` | 100 | 1 | Finished a quest chapter | true | WP4 |
| `nest` | 80 | 1 | Cleared a bug nest (14 days with no recurrence) | true | WP2 |
| `cleanfix` | 25 | 4 | A fix with a new test that proves it, at the root | true | WP2 |
| `held` | 20 | 3 | A fix held for 14 days | true | WP2 |
| `reef` | 30 | 1 | A project's reef reached a new best | true | WP3 |
| `caught` | 25 | 3 | Caught something in review before it merged | true | WP3 |
| `reviewtier` | 100 | 1 | Reached a new review mastery tier | true | WP3 |
| `tideout` | 0 | 1 | (log-only: "Tide-out day used", 0 XP, shown in the log) | false | WP1 |

Notes:

- `tideout` pays 0. `award()` returns `gained: 0`, so it is logged by WP1 directly in `streaks`, not through `award`. Leave it out of AWARDS if a 0-XP award breaks the `ways` list. **Decision: leave it out.**
- Every `kind` must match `/^[a-z]{1,12}$/` (the `byKind` regex). All of the above do.
- **Bounties** (`bounties.js`, WP1 adds): `review1` (kinds `['caught','quiz']`, goal 1, 50 XP) and `held1` (kinds `['held','cleanfix']`, goal 1, 60 XP). These tie the daily loop into the new systems.

### 1.4 New stat events (`wardrobe/achievements.js INCREMENTS`/`MAXIMA`, added by WP0)

| event | stat key | type | emitted by |
|---|---|---|---|
| `nest-cleared` | `nestsCleared` | inc | WP2 |
| `rematch-won` | `rematchesWon` | inc | WP2 |
| `clean-fix` | `cleanFixes` | inc | WP2 |
| `fix-held` | `fixesHeld` | inc | WP2 |
| `bugs-caught-total` | `bugsCaughtTotal` | max (n) | WP2 (from `bugdex.summary`) |
| `reef-best` | `reefBests` | inc | WP3 |
| `reef-thriving` | `reefThriving` | max (n projects at stage 5) | WP3 |
| `review-tier` | `reviewTier` | max | WP3 |
| `review-caught` | `reviewCaught` | inc | WP3 |
| `quiz-streak` | `quizStreak` | max | WP3 |
| `molted` | `molts` | max | WP1 |
| `ever-level` | `everLevel` | max | WP1 |
| `chapter-done` | `chaptersDone` | max | WP4 |
| `tide-perfect` | `tidePerfect` | inc | WP4 (medal with every goal done in the first half of the event) |
| `wrapped-seen` | `wrappedYears` | max | WP5 |
| `logbook-opened` | `logbookViews` | inc | WP4 |

### 1.5 Config keys (`src/main/config.js DEFAULTS`, WP0)

- `reef: null` (WP3)
- `reviewMastery: null` (WP3)
- `bugNests: null` (WP2)
- `yearbook: null` (WP5)
- `logbook: null` (WP4)
- `unlockSeen: null` (WP1)

Molting lives inside `xp` so it syncs with it (WP1).

### 1.6 Panel scaffolding (WP0)

Create empty stubs that each WP fills in:

- **html pieces:** `src/renderer/panel/html/logbook.html` (WP4), `wrapped.html` (WP5, a sheet), `reef.html` (WP3, included from `projects.html` and `tank.html`), `molt.html` (WP1, a sheet).
- **frame.html:** add `<!-- @include … -->` lines and `<script>` tags for:
  - `logbook.js`, `logbook.css` (WP4)
  - `reef.js`, `reef.css` (WP3)
  - `review-mastery.js` (WP3)
  - `molt.js`, `molt.css` (WP1)
  - `levels-ui.js` (WP1)
  - `wrapped.js`, `wrapped-card.js`, `wrapped.css` (WP5)
  - `bugdex-report.js`, `bugdex-nests.js` (WP2)
- **main.js:** require and call the wiring stubs `wireLevels`, `wireMolting`, `wireReef`, `wireReview`, `wireNests`, `wireQuestLine`, `wireLogbook` and `wireYearbook`. Each starts as `module.exports = d => ({})`.
- **Move the quest code** (`questsPanelView`, `setQuests`, `questDone`) out of `wiring/progress.js` into the new **`src/main/wiring/quest-line.js`**, unchanged. This leaves `progress.js` to WP1 and `quest-line.js` to WP4. Re-export through `d` as before.

### 1.7 Merge rule for the built panel

Each WP commits its rebuilt `panel.html`. On a merge conflict in `panel.html`, take either side, then run `npm run panel:html`. `test/panel-html.test.js` enforces this.

---

## 2. Feature designs

### 2.1 Quest line expansion (WP4)

**Module:** `src/main/quests/index.js` (currently 73 lines, grows to about 300). The quest copy goes in a new `src/main/quests/chapters.js` (data only) so the logic file stays small.

**Data model** (stored in config `quests`, merged by `sync/life.js` as today through `normalizeQuests().done`, so new ids sync without changes):

```js
{ done: { [questId]: at }, hidden, chapters: { [chapterId]: { unlockedAt, doneAt } }, seenChapter: id|null }
```

**Chapter schema:**

```js
{ id, n, title, icon, blurb, unlock: { level?: n, dormant?: screenId[], after?: chapterId, any?: true },
  quests: [{ id, icon, title, go, why, how, links: ['reef','tank'] }], reward: { decor?: key } }
```

How unlocking works:

- `unlock.level` uses **everLevel**.
- `unlock.dormant` comes from `feature-use.report()`'s never-opened screens. A chapter opens early when its screen has never been visited, because that chapter is the tutorial for it.
- `after` gives the chapter order.
- Quests inside a chapter can be done in any order, as now.

**Chapters (the existing 4 quest ids are kept as Chapter 1):**

| # | id | Unlock | Quests (id: real success hook) | Teaches the link |
|---|---|---|---|---|
| 1 | `first-tide` | always | `comment`, `branch`, `home`, `reset` (existing hooks) | Review leads to copies, copies to holding work |
| 2 | `reef-wakes` | level 5 or `projects` dormant | `checkup`: a dependency checkup is read (`progress.js checkedUp`). `reef-on`: turn on reef watch for a project (WP3 `reef:act enable`). `flaky-look`: fix or quarantine a flaky test (`flakyAct`). | Code health feeds the reef, and the reef feeds the tank |
| 3 | `bug-hunter` | level 8 or `bugdex` dormant | `first-catch`: any counted catch. `proof`: a catch whose fix report has `testsAdded`. `jar-in-tank`: save a tank layout holding a `jar:` ref. `rematch`: win a rematch. | Battles lead to the Bugdex, the tank and nests |
| 4 | `clockwork` | level 10 or `routines`/`workflows` dormant | `routine`: first routine run (stat `routinesRun`). `workflow`: a workflow run finishes ok. `away`: a routine runs while you're away (`noteAwayRun`). | Automation earns while you're away (the weekly card shows it) |
| 5 | `second-opinions` | level 15 or `council` dormant | `quiz`: pass a quiz (`ipc/tabs.js`, next to `awardXp('quiz')`). `council`: a council session concludes. `helped`: the `helped` award fires. `look-over`: `review:start` ok. | Review mastery (section 2.9) |
| 6 | `home-improvement` | level 20 or `tank` dormant | `decorate`: save a tank with 5 or more pieces. `bigger`: move into a bigger tank size. `milestone-piece`: place any milestone-pack piece. `tank-share`: share the tank card. | Rare pieces come from every system |
| 7 | `tides-and-friends` | level 25 or an active tide event | `goal`: finish one tide goal. `medal`: earn a medal. `friend`: a swap or a hatched egg (either one; solo players get an alternative: "dig up an event find"). | Events boost catches and finds |
| 8 | `keeper` | level 30 | `nest`: clear a nest. `reef-best`: two reef signals at a new best. `cifix`: CI back to green. `patched`: a deps checkup with `r.patched`. | Nests and the reef |
| 9 | `long-watch` | level 40 | `tier2`: review tier 2. `quiz3`: a quiz streak of 3. `caught`: a caught-before-merge. | Review leads to fewer nests |
| 10 | `the-deep` | level 60 | `nests3`: 3 nests cleared. `thriving`: one project's coral at stage 5. `species50`: 50 species. | Long-term mastery |
| 11 | `molting-season` | level 90 | `ninety-nine`: reach 99. `every-shell`: wear 10 shells. `molt-or-stay`: either molt, or earn ★1. Both paths finish it, so molting stays optional. | Prestige, with no pressure |

**API** (kept pure):

- `normalizeQuests(v)`
- `completeQuest(v, id, now, ctx)` returns `{ state, quest, chapter, chapterDone, next, finished }`. `ctx` = `{ everLevel, dormant: Set, eventActive }`, and quests in locked chapters can't complete.
- `unlockChapters(v, ctx, now)` returns `{ state, opened: [chapter] }`.
- `questsView(v, ctx)` keeps the current shape (`list`, `current`, …) so `chat.html`'s quest card keeps working, plus `chapters: [{ id, title, unlocked, done, quests, progress }]`.
- `CHAPTERS` and `QUESTS` (flattened, for backward compatibility).

**Wiring:** `wiring/quest-line.js`.

- `questDone(id)` builds `ctx` from `xp.everLevel` (WP1 exports it), `featureUse.report()` and `d.activeEvent()`.
- It pays `quest` per quest, `chapter` per chapter, and `questline` once for the old Chapter 1 completion (compatibility).
- It emits `d.stat('chapter-done', { n })`.
- `unlockChapters` runs on level-up (subscribe through `d.onLevelUp`, a hook WP1 exposes) and on panel open.

**Quest hook sites outside WP4's files.** Each owning WP adds a one-line `d.questDone?.('<id>')` call in its own files:

| Quest | File | Owner |
|---|---|---|
| `proof`, `rematch`, `first-catch`, `nest`, `nests3` | `wiring/bugdex-nests.js` | WP2 |
| `reef-on`, `reef-best`, `thriving`, `quiz`, `quiz3`, `tier2`, `caught` | `wiring/reef.js`, `wiring/review.js` | WP3 |
| `ninety-nine`, `molt-or-stay`, `every-shell` | `wiring/molting.js` | WP1 |
| `decorate`, `bigger`, `milestone-piece`, `tank-share`, `jar-in-tank` | `ipc/tank.js` | WP5 |
| `checkup`, `flaky-look`, `patched`, `away` | `wiring/progress.js` | WP4 has a written exception to add these four one-liners; WP1 is told |
| `cifix` | `wiring/github.js` | WP4 |
| `routine`, `workflow` | `wiring` routines/workflows | WP4 |
| `council` | `wiring` council | WP4 |
| `goal`, `medal`, `friend` | `wiring/events.js` | WP4 |

### 2.2 Streak fix (WP1)

**Module:** `src/main/progression/streaks.js`.

**New state fields:**

```js
{ days, projects, nudges, afterDays,
  restDays: [0, 6],          // weekdays that never break a streak (Settings; default Sat+Sun)
  tideOuts: ['YYYY-MM-DD'],  // auto-spent free days, at most 1 per ISO week, kept 400 days
  ebb: { mult: 1, day: null } }  // the bonus as last paid, for a gentle decline
```

**Rules** (in `streakOf(state, now)`, which returns `{ current, longest, today, tideOutsLeftThisWeek, restToday, mult }`):

- **Walk backwards** from yesterday (or today if worked). A day "holds" if it was worked, is a rest weekday, or is a tide-out.
- **Tide-outs are applied by the pure function, not spent ahead of time.** When the walk hits a missed working day and that ISO week has no tide-out yet, the day becomes a tide-out and the walk continues.
- **Persisting tide-outs:** `settleTideOuts(state, now)` writes which days were used, so the panel can show 🌊 on them. The wiring calls it once per day.
- **Rest days and tide-outs don't add to `current`.** Only worked days count, so a Mon to Fri worker still gets 5 per week. The multiplier counts **weeks with at least 3 worked days in the streak**, not days divided by 7, so a 5-day week counts as a full week.
- **The bonus never drops all at once.** `ebbMultiplier(state, now)` returns `max(fromStreak, ebb.mult − 0.05 × missedWorkingDaysSinceEbb.day)`, never below 1. The streak number can reset, but the bonus slides down 5% per missed working day. Starting again keeps that floor until the new streak catches up.
- **xp.js change** (WP1 owns xp.js beyond the AWARDS table): `award()` accepts `meta.mult` (already ebbed and clamped to at most 1.25) instead of computing `streakMultiplier(meta.streak)`. `streakMultiplier` stays for display and tests.
- **UI:** the streak chip on the XP card shows the flame, the days, 🌊 "1 tide-out left this week", and "weekends off" (`renderer/panel/xp.js`, WP1).

**Tests:**

- A Friday-to-Monday weekend keeps the streak.
- One missed Wednesday is a tide-out.
- Two missed days in one week break the streak, but the multiplier only ebbs by 0.05 per day.
- Changing `restDays` mid-streak gives a stable answer.
- DST boundaries work.

### 2.3 Levels 20 to 99 fully fleshed out (WP1)

**New module:** `src/main/progression/levels.js`. It is pure and holds the catalogue, so `xp.js` doesn't grow.

- `TITLES`, `RANKS`, `UNLOCKS` and `nextUnlock` move out of `xp.js`; `xp.js` re-exports them for compatibility.
- **Unlock kinds:** `title | rank | shell | decor | effect | perk | chapter | size | ceremony`.
- **Functions:**
  - `unlocksAt(level)`
  - `unlocksBetween(a, b)`
  - `nextUnlock(level)` returns `{ level, unlocks, xpToGo }`
  - `perksFor(everLevel)` returns a `Set`
  - `milestone(level)` returns null or `{ tier: 'minor'|'major'|'legend', fanfare }`
  - `everLevel(xpState)` = `molt.count > 0 ? 99 : levelFor(total).level`
- **Gate everything on `everLevel`:** `shells.unlockedAt`, `tank.sizeUnlocked`, perks, chapters and decor. The call sites are `wiring/progress.js molt()`, `homesView`, `ipc/tank.js` and `wardrobe/service.js`.

**Decor unlocked by level.** `wardrobe/catalog.js checkUnlock` gains `{ level: n }` (WP1 owns this edit). `wardrobe/service.js isUnlocked` reads `this.everLevel`, which the wiring sets on every XP change. The error message changes to "exactly one of default, achievement, season, level".

**Perks.** These are quality-of-life and cosmetic only. None of them buys XP faster from volume.

| Lvl | Perk id | Effect |
|---|---|---|
| 22 | `rested-plus` | `RESTED_POOL` 150 → 200 (passed in as `meta.restedPool`) |
| 28 | `bounty-reroll` | Reroll one daily bounty once a day (`bounties.js reroll(state, day, id)`) |
| 33 | `fourth-bounty` | 4 daily bounties instead of 3 |
| 38 | `battle-replay` | Replay any past battle from the Bugdex history |
| 44 | `tide-out-plus` | 2 tide-outs per week |
| 52 | `reef-forecast` | The reef shows a 4-week trend line |
| 58 | `golden-jar` | Jars in the tank can show their best form |
| 66 | `crew-cosmetics` | Helper crabs wear your title colour |
| 77 | `card-foil` | Crab card and Wrapped card get a foil border |
| 88 | `wrapped-extra` | Wrapped gets a bonus "deep cuts" slide |

**The level table, 20 to 99.** Kept titles and ranks are unchanged. New items fill the gaps so almost every level unlocks something.

| Lvl | Unlock |
|---|---|
| 20 | ceremony (major), title "Legend of the Tides", rank Lagoon, Ch6 |
| 21 | decor `lagoon-lantern` |
| 22 | perk rested-plus |
| 23 | effect `bubble-trail` |
| 24 | shell `sea-urchin-shell` (new hand-made) |
| 25 | title Tidecaller, Ch7 |
| 26 | decor `kelp-arch` |
| 27 | effect `ripple-step` |
| 28 | perk bounty-reroll |
| 29 | decor `tide-clock` (animated) |
| 30 | ceremony (major), title Reef Warden, rank Kelp, size Reef tank (exists), Ch8 |
| 31 | decor `brain-coral` |
| 32 | shell `ammonite` |
| 33 | perk fourth-bounty |
| 34 | effect `plankton-glow` |
| 35 | title Current Rider |
| 36 | decor `sunken-terminal` (animated cursor) |
| 37 | effect `ink-puff` on level-up |
| 38 | perk battle-replay |
| 39 | decor `sea-fan` |
| 40 | ceremony (major), title Trench Explorer, rank Deep, Ch9 |
| 41 | decor `anglerfish-lamp` (animated) |
| 42 | shell `conch-of-answers` |
| 43 | effect `deep-sparkle` |
| 44 | perk tide-out-plus |
| 45 | title Pearl Diver |
| 46 | decor `pearl-oyster` (animated) |
| 47 | effect `pressure-shimmer` |
| 48 | decor `diving-bell` |
| 49 | shell `glass-float` |
| 50 | ceremony (legend), title Kraken Tamer, rank Amethyst, size Grand aquarium (exists), decor `kraken-arm` |
| 51 | effect `amethyst-aura` |
| 52 | perk reef-forecast |
| 53 | decor `geode-cluster` |
| 54 | shell `storm-whelk` |
| 55 | title Storm Shell |
| 56 | decor `lightning-jar` (animated) |
| 57 | effect `rain-cloud` |
| 58 | perk golden-jar |
| 59 | decor `shipwreck-mast` |
| 60 | ceremony (major), title Lighthouse Keeper, rank Ruby, decor `lighthouse-beacon` (animated), Ch10 |
| 61 | effect `beam-sweep` |
| 62 | shell `ruby-murex` |
| 63 | decor `message-buoy` |
| 64 | effect `ember-float` |
| 65 | title Sunken Sage |
| 66 | perk crew-cosmetics |
| 67 | decor `sage-scroll` |
| 68 | shell `scholar-cowrie` |
| 69 | effect `rune-glow` |
| 70 | ceremony (major), title Maelstrom, rank Pearl, decor `whirlpool` (animated) |
| 71 | effect `vortex-idle` |
| 72 | shell `pearl-turban` |
| 73 | decor `moon-jelly` (animated) |
| 74 | effect `tidal-wake` |
| 75 | title Tsunami |
| 76 | decor `wave-crest` |
| 77 | perk card-foil |
| 78 | shell `tsunami-spire` |
| 79 | decor `drowned-bell` |
| 80 | ceremony (major), title Ocean Sovereign, rank Abyss, decor `sovereign-throne` |
| 81 | effect `abyss-eyes` |
| 82 | shell `abyssal-helmet` |
| 83 | decor `bioluminescent-garden` (animated) |
| 84 | effect `crown-glint` |
| 85 | title Mariana Monarch |
| 86 | decor `trench-vent` (animated) |
| 87 | shell `monarch-volute` |
| 88 | perk wrapped-extra |
| 89 | effect `deep-current` |
| 90 | ceremony (major), title Elder of the Deep, rank Prism, Ch11 |
| 91 | decor `prism-crystal` (animated) |
| 92 | effect `prism-trail` |
| 93 | shell `elder-nautilus` |
| 94 | decor `elder-statue` |
| 95 | title Mythic Mariner |
| 96 | effect `myth-halo` |
| 97 | decor `world-shell` (animated) |
| 98 | effect `countdown-sparks` |
| 99 | ceremony (legend), title Shellby Supreme, shell Rainbow Nautilus (exists), decor `supreme-pedestal`, the Molt option appears |

**Where the new items live:**

- New hand-made level shells: `src/main/progression/shells-extra.js`. `shells.js` concatenates them into `SHELLS`. Each must pass the mask test in `test/shells.test.js`.
- Level decor: `src/wardrobe/depths.json` (a new pack with `unlock: { level }`).
- Effects: the same pack, `effects` kind.
- Art budget: about 30 decor pieces, about 20 effects and 9 shells. WP1 can ship the table with the art landing in follow-ups. `levels.js` filters out unlocks whose item key isn't in the catalogue, so missing art never shows a broken unlock. `test/levels.test.js` lists what is missing as a warning, not a failure.

**Next-unlock progress on the XP bar** (`renderer/panel/levels-ui.js`, new):

- A second, thinner bar under the XP bar: "Next: 🐚 Ammonite at Lv 32, 1,240 XP to go", progress from the previous unlock level to the next.
- Hovering lists everything at that level.
- `xpSummary` gains `unlock.fromLevel` and `unlock.progress` (WP1, in xp.js).

**Ceremony** (`levels.js milestone()`, plus `wiring/progress.js` and renderer `celebrate.js`):

| Tier | Levels | What happens |
|---|---|---|
| minor | every level | as today |
| major | 20, 30, 40, 60, 70, 80, 90 | full-panel ceremony sheet: rank colour sweep, the new title written letter by letter, the unlock cards flip in one by one, "Wear it now" / "Put it in the tank" buttons, the critter does `levelup` plus a rank-coloured confetti burst |
| legend | 50, 99 | as major, plus a crab-card-style "Level 50" PNG to share (reuses `SB.cardKit`) and a journal entry (`d.life.remember`) |

Notes:

- With reduced motion on, the ceremony is a static card.
- `xp:levelup` payload gains `milestone` and `unlocks` (structured, not just `text`).

### 2.4 Logbook hub (WP4)

**Decision:** the Logbook is a **new room, opened from the start (`rooms.js` `{ id: 'logbook', tasks: 0 }`)**, and becomes the first tab of the Shellby screen.

- It **takes over** the XP card's bounties block and the Trophies page's quest list.
- Trophies keeps the character sheet, achievements and the XP log.
- The chat quest card stays, with a "Logbook" link.
- Nothing else is removed. Bugdex, Tank and Projects stay where they are, and the Logbook links to them.

**Module:** `src/main/logbook.js` (pure).

`logbookView(parts, now)`:

- `parts` = `{ xp, quests, event, battles, nests, reef, review, unlock, week, streak, bond, wrappedDue }`.
- It returns `{ cards: [...], links: [...] }`, ordered by `priority()`.

`cards` include:

- `today` (bounties)
- `quest` (current quest and chapter progress)
- `tide` (active event goals and countdown)
- `loose` (bugs on the loose with battle HP, nests marked 🪺)
- `next-unlock`
- `reef` (best and worst project coral stage and the next improvement worth making)
- `review` (tier progress)
- `week` (weekly picture mini-chart from `weekly.weekSummary`)
- `streak` (tide-outs left)
- `molt` (at 99 only)
- `wrapped` (on Jan 2 or later)

Each card has `go: { view, focus }` and **`feeds: [{ to, text }]`**, a cross-link line generated from rules in `logbook.js FEEDS`. For example:

- A `loose` bug in a nested repo: "Catch it with a test → nest clears in 14 days → 🪸 coral in *shellby* grows."
- A tide event with an event bug: "Harvest Mouse is this week's bug: catches pay ×1.5."
- `reef` with a flaky signal: "Fixing `auth.spec` pays Fixed a flaky test and lifts the reef."
- `next-unlock` that is decor: "Goes in your tank."
- `review` near a tier: "1 more caught-in-review → Line Hawk → the 🦅 Hawk Perch tank piece."

**Priority:** things that need action now come first. Order: loose bugs in the active project, then tide ends soonest, then bounties nearly done, then quest, then the rest.

**State:** config `logbook: { pinned: [cardIds], collapsed: [cardIds], lastOpenAt }`.

**Wiring:** `src/main/wiring/logbook.js`.

- Gathers the existing views: `xpView`, `questsPanelView`, `d.activeEvent`, the battle list, the reef view, the review view and `weekly.weekSummary`.
- Registers `game-hub` `logbook` `{ get, act: pin|collapse|open }`.
- Pushes a debounced (1 s) refresh on events: `xp`, `quests`, `bugdex:battles`, `game:reef`, `game:review`.
- Emits `d.stat('logbook-opened')`.

**Renderer:**

- `src/renderer/panel/logbook.js` and `logbook.css`.
- `html/logbook.html`, included from `wardrobe.html`'s tab strip. The Shellby screen's tabs live there; WP4 owns the edit to add the tab button.
- Cards follow the existing `h()` helper style.
- The `feeds` lines are links that call `SB.go(view, focus)`.

**Also by WP4:**

- `feature-use.js SCREENS` gains logbook.
- Ctrl+K entry in `find.js` (or wherever the commands list lives).

### 2.5 Bug battles rework (WP2)

The goal: **the battle is a replay of what really happened in the fix, and its result matters afterwards.**

#### a) Fix report: `src/main/bugdex/quality.js` (new, pure)

`fixReport({ files, patch, enc, judged, counts })` returns `{ qualities: { proof, firstTry, rootCause, wider }, score }`.

| Quality | Rule |
|---|---|
| `proof` | A test file has new test cases added. Count added lines matching `/\b(it\|test\|describe)\s*\(\|def test_\|#\[test\]\|func Test\w+\(\|@Test\b\|\[(Fact\|Test)\]/` (using `isTestFile`). Also the test count rose (`counts.after > counts.before`) **or** one of those test files is new (`status:'A'`). Changing an assertion doesn't count. |
| `firstTry` | `enc.reruns === 0`. This exists today as the `first-try` form. |
| `rootCause` | Non-test source changed, **no** `SUPPRESS_ADD` anywhere in the added lines, not `onlyBiggerNumbers`, not snapshot-only, and not only config/lockfile paths (`/\.(json\|ya?ml\|toml\|lock\|ini)$/` with no code files). |
| `wider` | Tests ran and passed across more than the failing file. `counts.after` covers more tests than the failing set. |

`judge()` must already have returned `ok` before any of this is computed, so no quality can come from a refused fix.

#### b) Battle moves come from the report (`battle.js` grows about 60 lines, stays under 320)

- `finish(b, { …, report })` replaces the single "finishing blow" with up to 3 named finishers, in this order:
  - **Proof Strike** (`proof`, fx `super`)
  - **Root Cut** (`rootCause`, fx `crit`)
  - **First Try** (`firstTry`, fx `crit` with a sparkle)
  - When the report has no qualities, the plain "It passes" blow.
- Each is a line in the text box ("Claude adds a test: Proof Strike! It's super effective!"). The renderer already animates `fx`.
- New FX: `'proof'`, `'root'`, `'first'`, `'sealed'`.
- `view()` adds `report` so the panel can show the fix report card.

#### c) History and rematches: `src/main/bugdex/history.js` (new, pure)

State, in config `bugNests.history` (local, not synced):

```js
{ [project+'|'+species]: { n, catches: [{ at, q: 'pfr' /* letters */, held: bool }], lastSeenAt, lastCaughtAt } }   // ≤ 200 keys, ≤ 10 catches each
```

Functions:

- `recordSeen(h, key, now)`
- `recordCatch(h, key, report, now)`
- `rematchOf(h, key, now)` returns `{ n, last: { at, q } }` or null.
- `heldDue(h, now)` returns the catches older than 14 days with no recurrence since, not yet marked held.
- `markHeld`

How rematches play:

- `battle.start(enc, { rematch })` adds `rematch: n` and level +2n.
- The appear line becomes "It's back! Ghost Moth, rematch #2. Last time: no test." The previous fix report shows as a ghost card.
- **Winning a rematch with `proof`** counts as **Sealed**: stat `rematch-won` and a big push toward clearing the nest.

#### d) Nests: `src/main/bugdex/nests.js` (new, pure)

```js
// config bugNests.nests
{ [key]: { project, species, since, count, lastSeenAt, lastCaughtAt, clearedAt|null, sealed: bool } }
```

- **Forms** when the same species is seen in the same project 3 or more times within 30 days. Every reappearance counts, caught or not.
- **Clears** when there is at least one catch and **14 days** pass since the last sighting with no recurrence. It clears in 7 days if the last catch was `sealed` (rematch won with a proof). That rewards writing the test.
- **A cleared nest is permanent history.** If it forms again later, it's a new nest with `generation+1`. The old clear stays credited.
- Functions: `observe(nests, enc, now)`, `onCatch(nests, key, report, now)`, `sweep(nests, now)` returns `{ nests, cleared: [] }`, `nestsView(nests, names, now)`, and `nestSignal(nests, project)` for the reef (open and cleared counts).

#### e) Wiring: `src/main/wiring/bugdex-nests.js` (new)

Called from `bugdex-reward.js reward()` (add one line, `nests.onCaught(e, r, report)`) and from wherever encounters open in `wiring/bugdex.js`, through a single `on('opened')` hook. If that hook doesn't exist, add one line there. Coordinate the line numbers; `wiring/bugdex.js` must stay under 800 lines.

- Computes `fixReport`. This needs the judged files and patch: `wiring/bugdex-checks.js` already reads them for `judge`, so pass them through `reward(e, r, { report })`. WP2 owns `bugdex-checks.js` and `bugdex-reward.js`.
- Pays:
  - `cleanfix` when `proof && rootCause`
  - `held` from the daily `sweep` (hourly timer, no clock in pure code)
  - `nest` on clear
- Emits stats: `clean-fix`, `fix-held`, `nest-cleared`, `rematch-won`, and `bugs-caught-total` with n = `bugdex.summary().caught`.
- Calls quest hooks: `first-catch`, `proof`, `rematch`, `nest`, `nests3`.
- Calls `d.reefNote?.(project, 'nest', nestSignal)`, a hook WP3 provides with a no-op default in `d`.
- Registers `game-hub` `nests`.

#### f) Renderer

- `bugdex-report.js` (new): the fix report card under the battle, plus the rematch banner.
- `bugdex-nests.js` (new): a Nests section at the top of the Bugdex with a 🪺 per nest, a 14-day ring of progress to clearing, and "Rematch history" per species with past report letters.
- `bugdex-battle.js` (775 lines) only gets three lines that call `SB.bugReport.render(view.report)`.

**What it feeds:** the tank (milestone pieces from nests and rematches), the reef (nest signal), levels (new XP kinds), quests (Ch3, Ch8, Ch10) and Wrapped (top nemesis species).

### 2.6 Reef health per project (WP3)

**Module:** `src/main/reef/index.js` (pure). Signal parsers go in `src/main/reef/signals.js` (pure).

**Opt-in.** It is off per project until you press "Watch this reef" on Projects. Quest `reef-on` points there.

**Signals.** No command runs anything in the project. Shellby only reads git and files that already exist, and the results of commands Claude already ran.

| Signal | Source | How, cheaply and safely | Better = |
|---|---|---|---|
| `escapes` (`any`/ts-ignore/eslint-disable/noqa count) | `git grep -c -I -E "<SUPPRESS_ADD source>" HEAD -- . ':!node_modules' ':!vendor' ':!dist' ':!*.min.*'` | Read-only. Runs at most once a day per project, on idle, with a 5 s timeout. Skipped when `git ls-files \| wc -l` > 20k. Reuses the `cheats.js` regex so the battle and the reef agree. | lower |
| `lint` (warnings and errors) | Lint runs Claude already did (`detect.js commandKind 'lint'`). Parse the count from the tail (eslint "✖ N problems", ruff "Found N errors", clippy "N warnings"). | Passive: newest reading per day. | lower |
| `coverage` | Existing artifacts only: `coverage/coverage-summary.json` (total.lines.pct), `lcov.info` (LH/LF), `coverage.xml` (line-rate), `.coverage` is skipped | Read only when the file's mtime is newer than the last reading. Size capped at 5 MB. Never generated by Shellby. | higher |
| `ci` (green rate over the last 20 runs) | `d.ci` (`ci-hub.js`) PR check results for the repo | Already polled. | higher |
| `flaky` (open flaky tests) | `flaky.js` ledger | Already kept. | lower |
| `deps` (vulnerabilities) | `checkup.js` ledger / `depwatch` | Already kept. | lower |
| `nests` (open nests) | `nests.nestSignal` (WP2 hook) | In memory. | lower |
| `tests` (test count) | Runner counts from test runs (`flaky/parsers`, `counts` from bugdex) | Passive. | higher |

**State** (config `reef`, local only, never synced; numbers only, no paths except the project key as `streaks.js` uses):

```js
{ projects: { [projectId]: { on: bool, name, signals: { [sig]: { best, bestAt, last, lastAt, series: [[dayKey, v]] /* ≤ 60 */ } },
                             polyps: n /* permanent growth count, only goes up */, lastPaidDay } } }
```

**Score model (it only rewards improvement):**

- **Baseline.** The first reading of a signal sets `best` and pays nothing. The reef starts at stage 2, "settling".
- **High-water mark.** A reading that beats `best` by the signal's minimum step is a **reef best**:

  | Signal | Minimum step |
  |---|---|
  | escapes | −1 |
  | lint | −1 |
  | coverage | +0.5 pt |
  | ci | +5 pt |
  | flaky | −1 |
  | deps | −1 |
  | nests | −1 |
  | tests | +1% and at least +3 tests |

- A reef best sets `best`, adds `polyps += 1`, emits stat `reef-best`, and pays `reef` XP at most once per project per day (`lastPaidDay`) and perHour 1.
- **Anti-cheat:**
  - `tests` only counts when `escapes` didn't rise in the same reading window.
  - `coverage` only counts when `tests` didn't fall.
  - `escapes` dropping because files were deleted: a drop with more than 30% of tracked lines deleted (`git diff --shortstat` from the baseline commit) doesn't count as a best.
  - `lint` only counts readings from the same lint command string as the baseline.
- **Worse readings never reduce anything.** They only lower the **health** stage.
- **Health stage, 0 to 5, visual only:** from the last 14 days of each signal compared with its best (the share of signals at or near best, plus a positive trend), plus a bonus for nests cleared. Stage 5 is "thriving" and emits `reef-thriving` with n = the number of projects at stage 5.
- **Polyps** set coral **size** (permanent). **Health** sets coral **colour** (vivid to pale). **Faded coral is never removed.**

**Functions:**

- `normalize(raw)`
- `enable(state, id, name, on)`
- `reading(state, id, sig, value, now, ctx)` returns `{ state, best: bool, paid: bool }`
- `healthOf(p, now)`
- `reefView(state, now)` returns per project `{ id, name, on, stage, polyps, signals: [{ id, last, best, trend, nextStep: 'remove 1 ts-ignore' }] }`
- `coralArt(stage, polyps, seed)` returns pixel art (procedural branching coral, deterministic per project, palette dims with stage)
- `nextImprovement(p)` for the Logbook

**Wiring:** `src/main/wiring/reef.js`.

- An idle scheduler, once a day per watched project, after 10 minutes of no input (use `away-service`/idle).
- Runs `git grep` through the existing git helper (`gitinfo`/`shellcmd`) with a timeout and `windowsHide`.
- Subscribes to lint/test command results from the same place `noteTestRun` gets them in `progress.js`. `progress.js` exposes `d.onCommandResult` (WP1 adds a one-line emitter), or WP3 listens on the existing bash event.
- Defines `d.reefNote(project, sig, value)` for WP2 and others.
- Registers `game-hub` `reef`.

**Tank integration:**

- Each watched project's coral becomes a library item `coral:<projectId>`. `tank.js REF_RE` gains `coral:`. WP3 owns this `tank.js` edit, and WP5 doesn't touch `tank.js library`.
- It is placeable like a jar, with art from `coralArt`, regenerated on each view.
- Coral uses the existing `frames` for a gentle sway.

**UI:**

- `html/reef.html` and `reef.js`: a section on Projects with per-project coral, signal rows with sparklines (`reef-forecast` perk shows trend lines), the "next step" text and the watch toggle.
- A "Reef" card in the Logbook.
- Privacy note in the UI: "Counts only, kept on this PC. Shellby reads git and coverage files that are already there; it never runs your code."

**Tests:** `test/reef.test.js`.

- Baseline pays nothing.
- A best pays once a day.
- A regression lowers the stage but never polyps.
- The deleted-file guard works.
- The coverage-needs-tests guard works.
- `coralArt` is deterministic.

`test/reef-signals.test.js`: the eslint, ruff and clippy count parsers, and the coverage file parsers.

### 2.7 Molting: optional prestige at 99 (WP1)

**Module:** `src/main/progression/molting.js` (pure).

**State**, inside the `xp` config so it syncs:

```js
xp.molt = { count: 0, base: 0 /* total XP at last molt */, at: [timestamps], worn: tier|null }
```

**Sync.** `mergeXpCounts` (WP1) also merges `molt`: take the side with the higher `count`, and for equal counts the lower `base`. `test/xp.test.js` gets cross-PC cases.

**Rules:**

- **Available** when `levelFor(total − base, count).level === 99`. Confirm with `confirm.js` ("He'll be level 1 again and keep everything").
- **What stays:**
  - total XP, byKind, marks history, every title, rank, shell, decor, effect and perk (all gated on `everLevel` = 99 after any molt)
  - Bugdex, tank, trophies, stickers, quests, reef, review, streak
- **What resets:** only the displayed level and progress.
- **XP curve for molt k:** `xpForLevel(l) × curveMult(k)`.

  | k | curveMult |
  |---|---|
  | 0 | 1.0 |
  | 1 | 0.8 (the replay is quicker) |
  | 2 | 0.9 |
  | 3 | 1.0 |
  | 4 and up | min(2.0, 1.0 + 0.1 × (k − 3)) |

  `levelFor(total, molt)` in `xp.js` becomes `levelFor(total − molt.base, molt.count)` (the second argument is optional, so old callers are unaffected). Marks only resume on reaching 99 again.
- **Badge:** `moltBadge(k)` returns `{ text: roman(k) for k ≤ 12, else String(k), color: tier palette }`. It's drawn as a ring around the level badge (renderer `xp.js`, `levels-ui.js`, crab card).
- **Functions:**
  - `canMolt(xp)`
  - `molt(xp, now)` returns `{ state, tier }`
  - `curveMult(k)`
  - `tierShell(k)` returns the shell definition (hand-made for k ≤ 12, else `shellGen(k)`)
  - `moltView(xp)`

**Ceremony** (`html/molt.html`, `molt.js`): a dark sheet, the crab shivers out of his shell (reuses the existing molt animation), the old shell rolls aside, the new tier shell drops in with its `aura`, then the badge stamp. Stats: `molted` with n = k. Quest: `molt-or-stay`. A journal entry.

#### Tier shells

Hand-made, one per molt tier: `src/main/progression/shells-molt.js` (data, about 12 × 25 lines).

Constraint: a shell must fit the same 13 × 12 grid inside the 22 × 13 sprite and only use cells that are shell or empty in every skin (`test/shells.test.js` mask check). The "insane" look therefore comes from new **render features**, not a bigger silhouette. Added to the shell format, all optional:

```js
{ frames: [pixels...] /* ≤ 4 alt grids, same size */, fps: 1–8,
  cycle: { keys: ['r','o','y'], fps } /* palette rotation */,
  aura: '#hex' /* CSS drop-shadow glow */, sparkle: 0–6 /* particle count */, molt: k }
```

| k | Name | Look |
|---|---|---|
| I | Ember Conch | Black basalt with lava cracks, `cycle` red, orange and yellow, ember sparkles |
| II | Glacier Geode | Split ice shell showing amethyst inside, frost-blue aura |
| III | Circuit Nautilus | Dark PCB spiral, LED traces running through `frames` |
| IV | Nebula Whorl | Deep violet, star pixels twinkle by `cycle` |
| V | Kraken's Eye | Barnacled shell with one huge eye that blinks (2 frames) |
| VI | Lava Lamp | Glass shell with blobs drifting (4 frames) |
| VII | Bone Cathedral | Ivory ribs and gothic arches, ghost-green aura |
| VIII | Prism Shard | Faceted crystal with a full-spectrum `cycle` across 7 keys |
| IX | Void Pearl | Pure black with an event-horizon ring `cycle`, white sparkles drawn inward |
| X | Clockwork Ammonite | Brass gears turning (4 frames) |
| XI | Aurora Spire | Tall spire, green to pink aurora `cycle` |
| XII | Leviathan Crown | Gold and rubies, flame `frames` on top, gold aura, 6 sparkles |

Procedural shells for k > 12: `src/main/progression/shell-gen.js` (pure, seeded `mulberry32(k)`).

- **silhouette:** one of the 12 hand-made masks (`k % 12`), so it always fits the skin mask.
- **pattern family**, from `floor(k / 12) % 6`: spiral, bands, scales, circuit, spots or cracks, filled into the mask procedurally.
- **palette:** hue = `(k × 137.508) % 360` (golden angle), with 4 shades from HSL and an accent at the complementary hue.
- **effect:** cycle, sparkle or aura, chosen by `rand`. At k ≥ 50, all three.
- **name:** `"${ADJ[rand]} ${NOUN[rand]}"` from about 40 × 40 sea and cosmic word lists, e.g. "Molt 37: Howling Volute".
- **Tests:** for k from 13 to 1000, the result passes the mask, uses only palette keys, and the same k always gives the same result.

**Renderer support** (WP1 owns `src/renderer/shared/sprite.js`; it is shared, but no other WP edits it):

- `shells.renderShell` passes `frames`, `cycle`, `aura` and `sparkle` through.
- `sprite.js` paints `frames[i]` and rotates the `cycle` palette on a timer.
- `aura` becomes a CSS `filter: drop-shadow` on the shell `<g>`.
- `sparkle` adds small absolutely positioned pixels.
- With reduced motion, only the static first frame is painted.

**How to make a new shell** (to add to `docs/WARDROBE.md`, WP1):

1. Copy a 13 × 12 template.
2. Use single-letter palette keys.
3. Run `npm test -- test/shells.test.js` to check the mask.
4. Preview with `node scripts/crab-sheet.js`.
5. Optionally add frames, a cycle or an aura.

### 2.8 Shellby Wrapped (WP5)

#### Record from now on: `src/main/yearbook.js` (pure)

**State** (config `yearbook`; per year, kept 10 years; synced later if wanted, local for now):

```js
{ years: { '2026': {
    since: 'YYYY-MM-DD', xp, tasks, activeDays: n, longestStreak, tideOuts,
    byKind: { kind: xp }, ships: { [projectName]: n }, deploys, merged,
    catches, newSpecies, shiny, bySpecies: { id: n }, nestsCleared, cleanFixes, held, rematchesWon,
    quizzes, reviewCaught, reviewTier, medals: [eventId], levelsGained, startLevel, endLevel, molts,
    reefBests, thrivingMax, piecesEarned: [key], trophies: [id], focusSessions, finds,
    firstTaskAt, busiestDay: { day, xp }, hours: [24 counts], weekdays: [7 counts] } },
  shown: ['2025'], dismissed: [] }
```

**Functions:**

- `note(state, event, payload, now)`. A single entry point. Events: `xp` (kind, gained), `task`, `ship`, `catch`, `stat`, `levelUp`, `molt`, `medal`, `piece`, `trophy`.
- `wrappedDue(state, now)` returns the year or null. True when local now ≥ Jan 2 of Y+1, Y is not in `shown`, and Y has at least 3 active days. "Shows on the first launch on or after Jan 2 if missed": it's checked at startup and hourly. Every year missed before the latest is still available from Trophies.
- `markShown(state, y)`
- `slides(yearData, ctx)` returns an ordered slide list with fact text.
- `backfill(state, { streaks, weekly, bugdexMonths, xp, achievements }, now)`. A one-time partial backfill of the current year: active days from `streaks.days` (400 days are kept), weekly ledger days from `weekly`, bugdex `months`, and `xp.daily` (30 days). It sets `since` to the earliest day available and `partial: true`, so the 2026 Wrapped on Jan 2 2027 says "since Aug 5".

**Wiring:** `src/main/wiring/yearbook.js`.

- Subscribes to a new `d.onAward(r, meta)` hook, which WP1 adds in `awardXp` (one line), plus `d.stat` passthrough. **WP0 wraps `d.stat` in main.js so a listener list can tap it.** That lets WP5 record every stat with no edits in other WPs' files.
- Registers `game-hub` `wrapped` `{ get(year), act: shown|share }`.
- On due, sends `game` `{ what: 'wrapped', event: 'due' }`, and the panel opens the sheet.

**Slides** (`html/wrapped.html`, `wrapped.js`; reduced motion means no auto-advance):

1. The year in one number: XP, levels gained, molts
2. Days together, longest streak, tide-outs used
3. Busiest hour and weekday (a heatmap)
4. What you shipped: top 3 projects, deploys, merges
5. The Bugdex: catches, new species, your nemesis (top species), shiny
6. Nests cleared and fixes that held ("23 fixes held for 2+ weeks")
7. The reef: biggest improvement ("escapes 41 → 12 in shellby"), thriving projects
8. Reviewer: quizzes, caught in review, tier reached
9. Tides: medals
10. New tank pieces and trophies (pixel grid)
11. Deep cuts (with the `wrapped-extra` perk)
12. The card

**Card:** `wrapped-card.js` uses `SB.cardKit` (W, H and C from `week-card.js`/`card.js`): a 1200 × 630 PNG. The crab is dressed as now, with the year, 6 stat tiles, the nemesis bug art (`bugdex.artFor`) and the molt badge. The save and copy path is the one `card.js` uses. Pays the existing `show-off` stat on share. Emits `wrapped-seen` with n = the number of years.

### 2.9 Review mastery track (WP3)

**Module:** `src/main/review-mastery.js` (pure).

**State** (config `reviewMastery`, synced through `sync-life`? no, local):

```js
{ points, tier, quiz: { streak, best, lastTurnIds: [≤20] }, comments: { turns: { [turnId]: { at, n, files: [..], lines: [[file,a,b]] } } /* ≤ 50 */ },
  caught: n, log: [≤ 30] }
```

**Sources:**

1. **Quiz pass.** Hook: `ipc/tabs.js` where `awardXp('quiz')` fires. +3 points. The quiz streak goes up on a pass on a **distinct turn** (turn id not in `lastTurnIds`) that is ≥ `quiz.MIN_LINES`. A fail doesn't reset the streak. It only stops the "streak today" count, so nothing is taken away. Only `best` is used for tiers.
2. **Line comments sent.** Hook: `ipc/corrections.js` where `questDone('comment')` fires. +1 point per turn reviewed, counted only if:
   - at least one comment is ≥ 12 non-space characters and isn't on a stoplist ("lgtm", "ok", "nice", "+1"),
   - the diff is ≥ 10 changed lines,
   - at most once per turn.

   The comment locations are stored.
3. **Caught before merge.** In the **next** Claude turn on that tab, if the edits touch a commented `[file, a..b]` range (±3 lines) **and** that work has not been pushed or merged yet (no `ship`/`merged` for the project since the comment), it counts as **caught**: +5 points, the `caught` XP award, stat `review-caught`, quest `caught`. The data comes from `changes.js` turn diffs, which `tries`/`changes` already compute.
   - Anti-cheat: the next turn must change non-whitespace lines. One caught per turn. Comments on Shellby's own synthetic diffs don't count.
4. **GitHub PR review comments** (optional, later): a review you submit on a PR authored from a Claude branch. Left out of v1.

**Tiers** (points / requirements):

| Tier | Requirement | Reward |
|---|---|---|
| 1 Tide-pool Reader | 10 points | — |
| 2 Diff Diver | 30 points, quiz best ≥ 3 | decor `diving-goggles-stand` |
| 3 Line Hawk | 75 points, caught ≥ 5 | decor `hawk-perch` (animated) |
| 4 Merge Guardian | 150 points, caught ≥ 15, quiz best ≥ 5 | title flair "Guardian" on the crab card |
| 5 Abyssal Auditor | 300 points, caught ≥ 40 | decor `auditor-lantern` (animated) and effect `scan-beam` |

A tier-up pays `reviewtier` and emits stat `review-tier` with n.

**Functions:**

- `onQuiz(s, { turnId, lines, passed }, now)`
- `onComments(s, { turnId, comments, diffLines }, now)`
- `onNextTurn(s, { tabTurnId, edits: [[file, a, b]], shipped }, now)` returns `{ state, caught }`
- `tierOf(s)`
- `masteryView(s)`

**Wiring:** `src/main/wiring/review.js`.

- Hooks are added as one-liners in `ipc/tabs.js` and `ipc/corrections.js` (WP3 owns those additions), plus a turn-end listener.
- Registers `game-hub` `review`.

**UI:** `review-mastery.js` renderer, a tier ladder card on Trophies (an `html/trophies.html` section; WP3 owns only that `<section>`, and WP4 doesn't touch `trophies.html`) and on the Logbook.

### 2.10 Rare tank pieces as milestone rewards (WP5)

**How they work:**

- They are a new built-in pack, **`src/wardrobe/milestones.json`**: decor items with `unlock: { achievement: id }`.
- Each has a matching new entry in `ACHIEVEMENTS` (`wardrobe/achievements.js`, WP5 owns the entries) with `rewards: [key]`.
- They get the trophy XP, toast, sync and "new" badge for free. `test/packs.test.js` already checks the link both ways.
- Animated pieces use `frames` (at most 3) and `fps`.

| Piece key | Name | Achievement (stat ≥ goal) | Animated |
|---|---|---|---|
| `first-nest-stone` | Cleared Nest Stone | `nest-cleared` (nestsCleared ≥ 1) | — |
| `nest-cairn` | Cairn of Ten Nests | nestsCleared ≥ 10 | — |
| `rematch-belt` | Rematch Belt on a hook | rematchesWon ≥ 3 | glint |
| `proof-tablet` | Tablet of Proof | cleanFixes ≥ 10 | — |
| `held-anchor` | The Anchor That Held | fixesHeld ≥ 25 | — |
| `jar-shelf-100` | Century Jar Shelf | bugsCaughtTotal ≥ 100 | jars bubble |
| `jar-tower-500` | Jar Tower | bugsCaughtTotal ≥ 500 | — |
| `perfect-tide-buoy` | Perfect Tide Buoy | tidePerfect ≥ 1 | light blinks |
| `medal-rack` | Medal Rack | an existing medal stat ≥ 4 (or a new `medals` max) | — |
| `molt-husk-1` | First Husk (your old shell, framed) | molts ≥ 1 | — |
| `molt-altar` | Molting Altar | molts ≥ 3 | aura flicker |
| `void-pearl-stand` | Void Pearl on a stand | molts ≥ 9 | swirl |
| `thriving-reef-arch` | Thriving Reef Arch | reefThriving ≥ 1 | sway |
| `great-barrier` | Great Barrier | reefThriving ≥ 3 | sway |
| `reef-bests-25` | Coral Record Board | reefBests ≥ 25 | — |
| `goggles-stand` | Diver's Goggles Stand | reviewTier ≥ 2 | — |
| `hawk-perch` | Hawk Perch | reviewTier ≥ 3 | head turn |
| `auditor-lantern` | Auditor's Lantern | reviewTier ≥ 5 | glow |
| `quiz-scroll` | Scroll of Five | quizStreak ≥ 5 | — |
| `wrapped-snowglobe-1` | Year One Snowglobe | wrappedYears ≥ 1 | snow |
| `wrapped-snowglobe-3` | Three-Year Globe | wrappedYears ≥ 3 | snow |
| `level-25-flag` … `level-99-pedestal` | Level flags at 25 / 50 / 75 / 99 | everLevel ≥ n | flag waves |
| `chapter-compass` | Quest Compass | chaptersDone ≥ 5 | needle |
| `chapter-map` | Complete Sea Chart | chaptersDone ≥ 11 | — |
| `logbook-lectern` | Logbook Lectern | logbookViews ≥ 30 | page flip |
| `streak-lighthouse` | Streak Lighthouse | existing `streak` stat ≥ 30 | beam |

Notes:

- Level pieces from the levels table (section 2.3) use `unlock: { level }`, not achievements, and live in `depths.json` (WP1).
- The milestone pack covers the cross-system ones.

**Earned versus locked in the tray** (`tank.js view` already returns `locked` and sorts locked items last):

- **`tank.js library`** (WP5 owns, apart from WP3's `coral:` addition; they edit different functions):
  - Add `hint` (the achievement description from the wardrobe service's `lockReason`) and `milestone: true` for pack `milestones`.
  - Add `progress: { current, goal }` from `achievements.progress`. It's passed into `library({ decor, …, progress })` by `ipc/tank.js`.
- **Renderer `tank-render.js`/`tank.js`** (WP5):
  - A locked milestone piece is painted as a **silhouette**: every pixel in the palette's darkest tone at 35% alpha, with a 🔒 and a progress ring.
  - The tooltip shows the hint and "7 / 10 nests".
  - Earned pieces get a gold corner and a "Milestone" shelf (`CATEGORIES` gains `['milestone', 'Milestones']`).
  - Animated pieces play their frames in the tray on hover only.
- **On earning:** the toast's "Put it in the tank" button opens the tank and highlights the piece. Placing one completes quest `milestone-piece`.

---

## 3. Cross-cutting decisions

1. **`everLevel` everywhere** (WP1 exports `levels.everLevel(xpState)`). Call sites:
   - `shells.unlockedAt` callers (`homesView`, `wornShell`)
   - `tank.sizeUnlocked` callers (`ipc/tank.js`)
   - `wardrobe/service.isUnlocked` for `{level}`
   - perks
   - quest chapters
   - `rooms` (unchanged)

   WP1 changes the shells and wardrobe call sites. WP5 changes the `ipc/tank.js` call site, through `d.everLevel()`, a function WP0 stubs in `d`.
2. **Event hooks on `d`** (WP0 stubs all of them as no-ops or listener lists):
   - `d.onAward(fn)` (fires in `awardXp` after the award)
   - `d.onLevelUp(fn)`
   - `d.onStat(fn)` (WP0 wraps `d.stat`)
   - `d.reefNote(project, sig, v)`
   - `d.onCommandResult(fn)`
   - `d.everLevel()`
   - `d.questDone(id)` (exists)
3. **Sync:**
   - Synced: XP and molt (WP1), quests done ids (as today), achievements (as today).
   - Local only: reef, review, nests/history, yearbook, logbook. Documented in each doc.
4. **Docs:**
   - WP1: `docs/WARDROBE.md` (shells, molting, levels)
   - WP2: `docs/BUGDEX.md` (fix reports, nests)
   - WP3: `docs/REEF.md` (new) and a review section in `docs/CLAUDE-CODE.md`
   - WP4: `docs/LOGBOOK.md` (new)
   - WP5: `docs/WRAPPED.md` (new) and a milestones section in `docs/TANK.md`
   - Each WP adds one `changes/<wp-name>.md`.

---

## 4. Work packages

| WP | Theme | Creates | Modifies (owner-exclusive) |
|---|---|---|---|
| **WP0** Foundation (first, short) | Contracts | `src/main/game-hub.js`, `src/main/ipc/game.js`, `src/main/wiring/quest-line.js` (moved code), stub wiring files, stub html/js/css pieces, `test/game-hub.test.js` | `xp.js` (AWARDS table only), `wardrobe/achievements.js` (INCREMENTS/MAXIMA and `emptyStats` keys only), `preload.js`, `config.js` DEFAULTS, `main.js`, `ipc/index.js`, `html/frame.html`, `wiring/progress.js` (quest code moved out), `panel.html` rebuild |
| **WP1** Progression | Streaks, levels, molting, shells | `src/main/progression/levels.js`, `src/main/progression/molting.js`, `src/main/progression/shells-extra.js`, `src/main/progression/shells-molt.js`, `src/main/progression/shell-gen.js`, `src/wardrobe/depths.json`, `src/main/wiring/levels.js`, `src/main/wiring/molting.js`, renderer `levels-ui.js`, `molt.js`, `molt.css`, `html/molt.html`; tests `levels`, `molting`, `shell-gen`, `streaks` (extended), `xp` (extended) | `xp.js` (except AWARDS), `streaks.js`, `bounties.js`, `shells.js`, `wardrobe/catalog.js` (checkUnlock level), `wardrobe/service.js` (everLevel), `shared/sprite.js`, `wiring/progress.js` (levelup, onAward and onCommandResult emitters; WP4's four questDone one-liners are the agreed exception), `wiring/streaks.js`, renderer `xp.js`, `celebrate.js`, `docs/WARDROBE.md` |
| **WP2** Bugs | Battles, fix reports, history, nests | `src/main/bugdex/quality.js`, `bugdex/history.js`, `bugdex/nests.js`, `src/main/wiring/bugdex-nests.js`, renderer `bugdex-report.js`, `bugdex-nests.js` (and css); tests `bugdex-quality`, `bugdex-history`, `bugdex-nests`, `bugdex-battle` (extended) | `bugdex/battle.js`, `wiring/bugdex-battles.js`, `wiring/bugdex-reward.js`, `wiring/bugdex-checks.js`, `wiring/bugdex.js` (at most 5 lines), renderer `bugdex-battle.js` (at most 5 lines), `html/bugdex.html`, `docs/BUGDEX.md`, `scripts/e2e-battle.js` |
| **WP3** Reef and Review | Reef health, coral, review mastery | `src/main/reef/index.js`, `src/main/reef/signals.js`, `src/main/review-mastery.js`, `src/main/wiring/reef.js`, `src/main/wiring/review.js`, renderer `reef.js`, `reef.css`, `review-mastery.js`, `html/reef.html`; tests `reef`, `reef-signals`, `review-mastery`, `docs/REEF.md` | `tank.js` (REF_RE plus the `coral:` branch in `library`), `html/projects.html` (include line), `html/trophies.html` (review section), `ipc/tabs.js` and `ipc/corrections.js` (one-liners), renderer `tank-paint.js` (coral sway, if needed) |
| **WP4** Logbook and Quests | Hub, chapters | `src/main/logbook.js`, `src/main/quests/chapters.js`, `src/main/wiring/logbook.js`, renderer `logbook.js`, `logbook.css`, `html/logbook.html`; tests `logbook`, `quests` (extended), `scripts/e2e-logbook.js`, `docs/LOGBOOK.md` | `quests.js`, `wiring/quest-line.js`, `rooms.js`, `feature-use.js`, `html/wardrobe.html` (tab button), `html/chat.html` (quest card link), `wiring/events.js` (perfect tide and quest hooks), `wiring/github.js` (cifix hook), routines/workflows/council wiring hook lines, the four one-liners in `wiring/progress.js` |
| **WP5** Yearbook and Milestones | Wrapped, rare pieces | `src/main/yearbook.js`, `src/main/wiring/yearbook.js`, `src/wardrobe/milestones.json`, renderer `wrapped.js`, `wrapped-card.js`, `wrapped.css`, `html/wrapped.html`; tests `yearbook`, `packs` (extended), `tank` (extended), `docs/WRAPPED.md` | `wardrobe/achievements.js` (ACHIEVEMENTS entries only), `tank.js` (`library` hint/progress fields, `CATEGORIES`; not REF_RE), `ipc/tank.js`, renderer `tank-render.js`, `tank.js`, `docs/TANK.md` |

### Shared touch points and who owns them

| Shared file | Owner | Others may |
|---|---|---|
| `xp.js` AWARDS table | WP0 (final in the foundation) | nothing; ask WP1 for anything else |
| `xp.js` everything else | WP1 | nothing |
| `wardrobe/achievements.js` stats maps | WP0 | nothing |
| `wardrobe/achievements.js` ACHIEVEMENTS list | WP5 | nothing |
| `preload.js` | WP0 | nothing (use `getGame`/`gameAct`/`onGame`) |
| `html/frame.html` and script tags | WP0 | nothing; fill your own stub files |
| `panel.html` (built) | everyone rebuilds | resolve conflicts by re-running `npm run panel:html` |
| `config.js` DEFAULTS | WP0 | nothing |
| `main.js` wiring calls | WP0 | nothing |
| `tank.js` | WP5 (`library` hint/progress, CATEGORIES) and WP3 (REF_RE, the `coral:` block) | WP3 and WP5 edit separate blocks; WP3 merges first |
| `wiring/progress.js` | WP1 | WP4: four `d.questDone` one-liners only |
| `bugdex.js` (693 lines) | nobody adds to it | read only |
| `sprite.js` | WP1 | nothing |

### Order

1. **WP0** lands on main first.
2. **WP1 to WP5** run in parallel off WP0.
3. Merge order to keep conflicts small: **WP1** (`everLevel`, hooks) → **WP2** → **WP3** → **WP5** → **WP4** (the Logbook reads every view, and its parts degrade to "not yet" when a view is missing).
4. After all merges, run the full `npm run e2e:ci` once, as CLAUDE.md requires.

### Coupling while running in parallel

Every cross-WP call goes through a `d.*` hook stubbed in WP0 or through `game-hub` names. The Logbook (WP4) tolerates `null` for any part, so it can be built against stubs. WP0 should also include fixture views in `test/fixtures/game-views.json`.

---

## 5. Test plan

**Unit tests** (`node:test`, pure modules, `now` passed in):

- **`levels.test.js`:**
  - Every level from 20 to 99 has at least one unlock, except at most 5 gaps.
  - `nextUnlock` and progress are right.
  - Perks are gated on `everLevel`.
  - Missing item keys are filtered out.
  - `milestone` tiers are right.
- **`streaks.test.js` (extended):** weekends, tide-outs per ISO week, `restDays` edits, the ebb never drops more than 0.05 per day, `settleTideOuts` is idempotent, DST.
- **`xp.test.js` (extended):** `meta.mult`, `levelFor(total, molt)`, the molt curve, marks after a molt, `mergeXpCounts` with molt.
- **`molting.test.js`:** `canMolt` only at 99, `molt` keeps total and byKind, the badge.
- **`shell-gen.test.js`:** k from 13 to 1000 is deterministic, passes the mask, and uses only palette keys. Plus `shells.test.js` (extended) for `shells-molt` and `shells-extra`.
- **`bugdex-quality.test.js`:** proof needs new test cases (an assertion edit isn't enough), rootCause is refused with a suppression or only bigger numbers, the report is never computed when `judge` fails.
- **`bugdex-history.test.js` / `bugdex-nests.test.js`:**
  - A nest forms at 3 sightings in 30 days.
  - It clears at 14 days, or 7 when sealed.
  - It reforms as a new generation, and the old clear is kept.
  - `heldDue`.
- **`bugdex-battle.test.js` (extended):** finisher order and FX per report, rematch level and text.
- **`reef.test.js` / `reef-signals.test.js`:** listed in section 2.6.
- **`review-mastery.test.js`:**
  - The stoplist and the 12-character rule.
  - One per turn.
  - Caught needs an overlapping range and no push in between.
  - The quiz streak needs distinct turns, and a fail never lowers `best`.
  - Tier thresholds.
- **`quests.test.js` (extended):**
  - The old 4 ids are still Chapter 1, and old saved state loads.
  - Chapter unlock by level, dormant screen or after.
  - A quest in a locked chapter can't complete.
  - `chapterDone`.
  - `sync-life` round trip.
- **`logbook.test.js`:** priority order, `feeds` rules, every part null still renders, card `go` targets are known views.
- **`yearbook.test.js`:**
  - `wrappedDue` across Jan 1 / Jan 2 local time, a missed year, multiple missed years, at least 3 active days.
  - Backfill sets `partial`.
  - `note` aggregates.
- **`packs.test.js` (extended):** milestone pack ↔ achievements both ways; `depths.json` level unlocks are valid.
- **`tank.test.js` (extended):** `coral:` refs, locked milestone hint and progress, the `everLevel` size gate.
- **`game-hub.test.js`:** allowlist, unknown names refused.
- **`panel-html.test.js`:** must pass after each WP.

**e2e** (CDP, counts taken from source, never hard-coded):

| Script | Owner | Checks |
|---|---|---|
| `e2e-logbook.js` | WP4 | the Logbook opens, cards render, a `feeds` link navigates |
| `e2e-battle.js` (extended) | WP2 | finishers render from a report, the nests section |
| `e2e-reef.js` | WP3 | opt-in toggle, fake readings, coral in the tray |
| `e2e-molt.js` | WP1 | dev hook `dev:xp-set` to 99, molt sheet, badge, shell kept, tank size still unlocked |
| `e2e-wrapped.js` | WP5 | dev clock hook at Jan 2, slides, card PNG through `savePng` |

All animation checks launch with `--force-prefers-no-reduced-motion`, as CI expects.

**Lint, typecheck and size checks:** `npm run lint`, `npm run typecheck`, and a check that no file goes over 800 lines. `test/size.test.js` already exists; if not, WP0 adds it.

---

The files that carry the most risk are below. Two things to double-check before starting:

- **Preload length.** The plan only works if WP0 can add three lines while keeping the preload at 799 or fewer by folding comment lines. A sandboxed preload can't load extra local files, so there's no other way to split it.
- **Molting gates.** Molting is safe only if every gate (shells, tank sizes, decor, perks) moves to `everLevel` in the same release that ships the molt button.

### Critical Files for Implementation
- C:\Users\jacob\AppData\Roaming\Shellby\worktrees\7041ed\shellby\src\main\xp.js
- C:\Users\jacob\AppData\Roaming\Shellby\worktrees\7041ed\shellby\src\main\wiring\progress.js
- C:\Users\jacob\AppData\Roaming\Shellby\worktrees\7041ed\shellby\src\main\bugdex\battle.js
- C:\Users\jacob\AppData\Roaming\Shellby\worktrees\7041ed\shellby\src\main\wardrobe\achievements.js
- C:\Users\jacob\AppData\Roaming\Shellby\worktrees\7041ed\shellby\src\main\tank.js