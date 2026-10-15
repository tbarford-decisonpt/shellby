# The Logbook and the quest chapters

Shellby's game systems used to stop at their own edge: a battle ended at the
catch, a quest line ended after four tricks. The Logbook is the one page that
shows them together, and the quest chapters are the tutorial that walks from
one to the next. The plan behind both is in
[GAMIFICATION-PLAN.md](GAMIFICATION-PLAN.md) sections 2.1 and 2.4.

## The Logbook

The first tab of his screen (`rooms.js` room `logbook`, open from the start).
Ctrl+K finds it as "Shellby: Logbook".

For someone new, a card about a room that hasn't opened yet waits with it
(`loose` with the Bugdex, `tide` with Us, `reef` with the Reef, `review` with
Review mastery). Those are game rooms, which open once First steps are done or
he reaches level 3 (`first-run.js` `CORE_LOOP_LEVEL`); a room that opens names
the quest chapter that teaches it (`rooms.js` `chapter`).

| Card | From | Opens |
|---|---|---|
| `loose` bugs on the loose, nests marked 🪺 | `d.bugdex.battles()`, game view `nests` | Bugdex |
| `tide` the event's goals and time left | `d.eventsView()` | Us |
| `today` the day's bounties | `d.xpView().bounties` | Trophies |
| `quest` the chapter in progress | game view `quests` | the quest's screen |
| `next-unlock` | game view `unlocks`, else `d.xpView().unlock` | Trophies |
| `reef` best and worst project | game view `reef` | Projects |
| `review` tier progress | game view `review` | Trophies |
| `week` a mini chart of the week | `d.weekView()` | Trophies |
| `streak` | `d.streaksView()` | Trophies |
| `molt` at 99 only | game view `molt` | Outfits |
| `wrapped` when due only | game view `wrapped` | Trophies |

Each card has `go: { view, focus? }` and `feeds: [{ to, text }]`, the "this
feeds that" lines, each a link to its screen. They come from rules in
`src/main/logbook.js` (`LINK_TEXT`, `UNLOCK_FEEDS`, `SIGNAL_TEXT` and each card's
builder). A loose bug in a nest says catching it with a test clears the nest
and grows the project's coral; a tide event names its bug and twist; a decor
unlock says it goes in the tank.

**Order.** Pinned cards first, then urgency: a bug loose in the project you're
in, a tide event (sooner when it ends sooner), bounties one step from done, the
quest, then the rest in `CARD_IDS` order.

**Missing parts.** Every part may be `null`: a package not built yet, a system
turned off, or a view that threw. Its card says "not yet" in words
(`NOT_YET`) and nothing else breaks. `test/logbook.test.js` checks each part
missing on its own and all of them at once.

### What the Logbook expects from each game view

Read defensively (every field optional); these are the fields it uses.

| View | Fields |
|---|---|
| `nests` | `{ nests: [{ species, project }] }` |
| `reef` | `{ projects: [{ project, stage (0-5), fading, signals: { flaky, lint, any, ci, deps, coverage: n } }] }` |
| `review` | `{ tier, tierName, caught, quizStreak, next: { tier, need, name?, reward? } }` |
| `unlocks` | `{ next: { level, kind, name, xpToGo? } }`, kind one of decor, tank, shell, home, title, chapter, perk (anything else reads as something to wear) |
| `molt` | `{ canMolt, level }` |
| `wrapped` | `{ due, year }` |
| streak (`d.streaksView`) | `{ current, tideOutsLeft? }` |

### Files

- `src/main/logbook.js`: pure. `logbookView(parts, now)` returns
  `{ cards, links, missing, lastOpenAt }`; `normalizeLogbook`, `setPinned`,
  `setCollapsed`, `opened`, `priority`.
- `src/main/wiring/logbook.js`: gathers the parts, registers game view
  `logbook` (`get`, and `act`: `pin`, `collapse`, `open`), and pushes a refresh a
  second after an award, a level-up, a stat or another game view changes, while
  the panel is showing. `open` records the `logbook-opened` stat.
- `src/renderer/panel/logbook.js`, `logbook.css`, `html/logbook.html`. The tab
  button is in `wardrobe.html` and `logbook.html`; the other pages of his screen
  get it added at runtime, so their files stay their owners'.

**State:** config `logbook: { pinned, collapsed, lastOpenAt }`. Local only, never
synced.

## Quest chapters

`src/main/quests/index.js` (logic) and `src/main/quests/chapters.js` (copy). Eleven
chapters; Chapter 1 is the original four quests with their ids unchanged, so a
saved line loads as Chapter 1 progress.

A chapter opens when any of its rules holds, and then stays open:

- `level`: the highest level ever reached (`d.everLevel()`), so a molt never
  closes one.
- `event`: a tide event is on (Chapter 7).
- `dormant`: a screen never opened (`feature-use.js`). The chapter is that
  screen's tutorial. It counts only after a week of counting (everything is
  "never opened" on day one), and only one such chapter opens at a time, once
  every open chapter is done.

A quest in a chapter that isn't open can't complete. Quests inside a chapter go
in any order.

**State:** config `quests: { done: { id: at }, hidden, chapters: { id: { unlockedAt, doneAt } }, seenChapter }`.
`sync/life.js` merges `done` as before, so new quest ids sync without changes.

**Pay:** `quest` for each quest, `chapter` for each chapter, and `questline`
once more for Chapter 1 (what finishing the old line always paid). Each chapter
records the `chapter-done` stat with the count done.

### Where each quest is done

`wiring/quest-line.js` reads most of them off what Shellby already reports:
stats through `d.onStat` (`STAT_QUESTS`) and XP awards through `d.onAward`
(`AWARD_QUESTS`). The rest call `d.questDone(id)` where they succeed:

| Quest | Where |
|---|---|
| `comment`, `branch`, `home`, `reset` | as before |
| `checkup`, `patched`, `flaky-look`, `away` | `wiring/progress.js` |
| `cifix` | `wiring/github.js` |
| `council` | `ipc/council.js` |
| `look-over` | `ipc/progress.js` (`review:start`) |
| `workflow` | `wiring/projects.js` (a run that ends ok) |
| `goal`, `medal` | `wiring/events.js`, which also records `tide-perfect` for a medal with every goal done in the event's first half |
| `routine`, `friend`, `first-catch`, `proof`, `rematch`, `nest`, `caught`, `tier2`, `quiz3`, `thriving`, `species50`, `ninety-nine`, `molt-or-stay` | stats (`STAT_QUESTS`) |
| `quiz`, `helped`, `medal`, `cifix` | awards (`AWARD_QUESTS`) |
| `reef-on`, `reef-best`, `nests3`, `jar-in-tank`, `decorate`, `bigger`, `milestone-piece`, `tank-share`, `every-shell` | their owners' wiring, `d.questDone?.(id)` |

The game view `quests` (`get`, and `act`: `hide`, `seen`) carries
`questsView()`: the chat card's shape (`list`, `current`, `doneCount`, `total`,
`complete`, `hidden`) for the chapter in progress, plus `chapter`, `chapters`,
`chaptersDone`, `totalChapters` and `nextLocked`.

## Checks

- `test/quests.test.js`, `test/logbook.test.js`, `test/rooms.test.js`
- `node scripts/e2e-logbook.js`: the tab on every page of his screen, a card for
  each system, a feed link that lands on its screen, pinning and folding, and
  the chapter list.
