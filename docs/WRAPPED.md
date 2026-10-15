# Shellby Wrapped

Every January 2nd, Shellby shows you the year before: what you shipped, the bugs Claude caught, the days you spent together, the trophies and tank pieces you earned. It's a short run of slides that ends on a card you can share.

## When it opens

- **On January 2nd**, local time, or the first time you use Shellby after it. New Year's Day is left to the year itself.
- **Once a year.** After you've seen it, it doesn't open by itself again.
- **A year needs at least 3 days together** to get a Wrapped. A year you barely used him is skipped.
- **Missed a year?** The newest one you haven't seen opens first. The others wait behind the 🎁 button next to 📸 on **Trophies**, and in the year buttons at the top of the sheet. A gold dot means one hasn't been opened yet. You can open any year again from there.

If the panel is shut on January 2nd, Wrapped is waiting when you open it. Shellby checks when it starts and every hour after, so a PC left on over New Year still gets it.

## The slides

Each slide shows up only if there's something to say, so a quiet year is a short Wrapped, never a row of zeros.

1. **Your year in one number:** the XP, levels gained and any Molts
2. **Days together:** active days, your longest run in a row, tide-out days used, tasks finished
3. **When you worked:** your busiest hour and day of the week, with a heatmap, and your biggest day
4. **What you shipped:** your top 3 projects by pushes, deploys and pull requests merged
5. **The Bugdex:** bugs caught, new kinds, your nemesis (the bug you caught most) with its picture, and sparkly ones
6. **Fixes that stuck:** fixes that held for 2+ weeks, bug nests cleared, clean fixes, rematches won
7. **The reef:** projects thriving and new bests
8. **Reviewer:** quizzes passed, things caught in review before they merged, the tier you reached
9. **Tides:** medals won and perfect tides
10. **New for his tank:** the pieces and trophies you earned, with their pictures
11. **Deep cuts**, from level 88 (the *wrapped-extra* perk): your first task of the year, focus sessions, gifts he dug up, where the rest of the XP came from
12. **The card**

The slides move on by themselves every few seconds. With motion turned down (Windows' animation setting) they wait for you. **Next**, **Back**, the arrow keys and **Esc** always work, and clicking anywhere stops the slideshow.

## The card

**📸 Make the card** on the last slide draws a 1200 × 630 picture: Shellby as he's dressed now, in his tank, with the year, six tiles of its biggest numbers (XP and days together first, then the biggest of the rest), the year's nemesis and a badge for each Molt. From level 77 (the *card-foil* perk) it gets a gold foil edge.

It's saved to **Pictures → Shellby** and copied to your clipboard, the same as the crab card, with buttons to post it to X or Bluesky. Making one counts for the **Show-Off** trophy.

## Trophies and tank pieces

Opening a Wrapped counts towards the **Year One**, **Year Two**, **Year Three** and **Year Five** trophies, each with a rare piece for his tank: three snowglobes (the snow falls) and a Time Capsule. See [TANK.md](TANK.md#milestones).

## The first year

Shellby started keeping a yearbook in this version. For the year it arrived in, he fills in what he already had, once: the days you used him (from streaks and trophies), the last 30 days of XP, and the Bugdex's catches and first sightings. That year's Wrapped says **"Counted since Aug 5"** (or whenever the earliest of those was), because tasks, pushes and the rest before then weren't recorded.

## Privacy

The yearbook stays on this PC. It never syncs and nothing in it goes on your calling card or profile card. It keeps counts, not details: project names (for the top 3), bug species, trophy and piece ids, and per-day XP. Ten years are kept. The card shows numbers and a bug, never a project name.

## For developers

- `src/main/yearbook.js` (pure, `config.yearbook`): `note(state, event, payload, now)` records one moment (`xp` from `d.onAward`, `stat` from `d.onStat`, `trophy` from the wardrobe's `unlocked` event, `tideout`), `available` and `wrappedDue` decide what opens (Jan 2 local, 3+ active days, newest unseen first), `markShown`, `backfill` (once, marks the year `partial` with its `since` day) and `summary` (streaks, busiest day, hour and weekday, nemesis, top projects). Levels, medals and molts arrive as running totals, so `last` carries the previous total and a year counts only the rise; a Molt's drop back to level 1 is a new start, not a loss. Covered in `test/yearbook.test.js`.
- `src/main/yearbook-slides.js` (pure): `slides(summary, ctx)` and `cardTiles(summary)`.
- `src/main/wiring/yearbook.js`: listens on the game hooks (`wiring/game-hooks.js`), backfills on the first note, checks 20 s after launch and hourly, and pushes `game` `{ what: 'wrapped', view, event: 'due' }`. Game views: `wrapped` (`get()` is `{ due, available }`, `get(year)` the slides and card; `act('shown', { year })` marks it and emits `wrapped-seen` with the number of years seen; `act('share')`) and `yearbook` (for the Logbook: `{ due, available, current }`). In a test run (`SHELLBY_E2E=1` and the like, `src/main/test-desktop.js`), `act('dev-clock', { at })` moves its clock and `act('dev-seed', { year })` fills a year; both are refused otherwise.
- Perk levels are constants in the wiring (`DEEP_CUTS_LEVEL = 88`, `FOIL_LEVEL = 77`), read against `d.everLevel()`.
- Renderer: `html/wrapped.html` (a card-sheet), `wrapped.js` (slides, the 🎁 on Trophies, opening on `onGame` and once on load), `wrapped-card.js` (`SB.wrappedCard.draw` / `share`, through `SB.cardKit`), `wrapped.css`.
- Not yet: the reef slide's "biggest improvement" (`ctx.reef`) waits for `reef.js` to keep a history of readings, and tide-out days need `streaks.js` to report them (`note('tideout')`).
- **End-to-end check:** `node scripts/e2e-wrapped.js` seeds a year, sets the clock to January 1st (nothing) and 2nd (the sheet opens), steps through every slide, makes the card PNG, checks the year is shown and Year One's snowglobe is earned, and that the tank's Milestones shelf has every piece.
