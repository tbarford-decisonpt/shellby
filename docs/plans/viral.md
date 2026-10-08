# Shinies, eggs, swaps, the monthly board, the PR line and tide events

> Status: **built** on `shellby/viral-feature-ideas`. Six features meant to
> be shown to someone else: a screenshot, a link, a line in a pull request.
> Each one only ever celebrates something that really happened: a fix Claude
> proved, a find he dug, a friend who installed him. Nothing here can be bought,
> and nothing is ever taken away.

The order below is the build order. Each part stands alone, so it can ship
alone.

## Where it ended up (differences from the first draft below)

- **Modules.** Pure: `events.js`, `board.js`, `swaps.js`, `eggs.js`, `crab-line.js`,
  `today.js`, and sparkles in `gifts.js` / `bugdex.js`. Wiring: `wiring/events.js`,
  `wiring/social.js` (swaps and eggs), and the board in `wiring/bugdex.js`. Panel:
  `tide.js`, `sparkle.js`, `social.js`, `moment-card.js` (one 1200×630 card for
  every moment), `tide.css`. Rewards: `src/wardrobe/tide-chest.json`.
- **Egg ids are 16 characters** of [a-z0-9] (about 82 bits), and the card carries a
  hash of each, never the id: an 8-character id could be walked back from the
  public hash. Codes are `EGG-<login>-<16 chars>`.
- **A `shellby://hatch` link never hatches by itself.** It opens the Us page with
  the code in the box; hatching adds a friend and writes on their card as you,
  so it waits for **Hatch it**.
- **Letters.** Swap letters are read from friends only (like waves); hatch
  letters from anyone, uncapped, and checked against the eggs you laid. A cap
  let a stranger's junk crowd a real one out.
- **Tide events don't add a new unlock type.** Each event has a trophy
  (wardrobe/achievements.js) that unlocks its piece; the year's medal is the
  events' own (`config.events.medals`), synced and on the card.
- **The swap and want lists** are worked out from your shelf (gifts.swapLists),
  not picked by hand.
- **No change to Claude Code's attribution.** The badge already reaches the
  pull requests Claude opens; the commit trailer names the model, which
  Shellby can't know. The trailer is only on Shellby's own bring-home commits.
- **Testing:** `SHELLBY_TODAY=YYYY-MM-DD` (dev and test runs) sets the day every
  season and event reads. `scripts/e2e-tides.js` runs inside The Haunting.

## 1. Tide events (`src/main/events.js`)

Seasons (wardrobe/seasons.js) are long and come back every year with the same
things. A **tide event** is short, has a name and a year, and sits inside a
season: ten days or so, a banner with a countdown, its own bugs and finds, a few
goals, and a medal stamped with the year that you only get by finishing it
while it's on.

| Event | When (north) | Inside | Its bug | Its finds | The twist |
|---|---|---|---|---|---|
| 🎃 **The Haunting** | Oct 24 – Nov 1 | halloween | **Will-o'-Wisp** (a fix after 9 pm) | Ghost Lantern, Cursed Doubloon | ghosts in the Wreck twice as likely to sparkle |
| ❄️ **Frostbite** | Dec 18 – Jan 1 | winter | **Frost Mite** (a fix on a day you shipped twice) | Ice Crystal, Frozen Bug | his breath shows; snow piles up a little with every catch |
| 💌 **Pen Pal Week** | Feb 9 – Feb 15 | valentine | **Lovebug** (two fixes in one turn) | Love Letter, Paired Shells | waves send a heart; a swap counts double |
| 🌸 **Spring Clean** | Mar 22 – Apr 2 | spring (moves south) | **Dust Bunny** (a fix that deletes more lines than it adds) | Feather Duster, Pressed Flower | the goals are housekeeping: stale branches, TODOs, dependencies |
| 🌊 **Low Tide** | Jul 10 – Jul 21 | summer (moves south) | **Tide-Pool Nudibranch** (any catch in the Shallows) | Stranded Jellyfish, Pearl Oyster | digs come twice as often, and sparkles are twice as likely |
| 🌾 **Harvest Moon** | Oct 1 – Oct 9 | autumn (moves south) | **Harvest Mouse** (a fix in a project you shipped this week) | Golden Wheat, Lantern Gourd | every catch pays 1.5× XP |

Each event has:

- **A window** (`start`, `end`, local midnight to 23:59:59), `nature` when it
  follows its season south, and a `season` it belongs to.
- **Its bug**: one species in the Bugdex with `event: '<id>'`. It is only
  detected while the event is on, by a **condition on a real catch** (the catch
  still has to be proven the usual way). An event bug you never caught shows
  as "Back next October" when the event's over. Ones you caught stay forever.
- **Its finds**: two finds with `event: '<id>'`, only dug up while it's on.
- **Goals** (`goals`, 4 each): counted from the stats Shellby already keeps
  (`bug-caught`, `find-made`, `wave-sent`, `task-completed`, `pushed`...),
  each `{ id, text, stat, goal, filter? }`, counted only inside the window.
  Progress is stored per event and year: `events: { '<id>@2026': { started,
  goals: { id: n }, done, medal, lastCall } }`.
- **The medal**: finishing all goals while it's on gives the `<id>@<year>`
  medal (shown on the Us page, the calling card and the profile card), an XP
  bonus, and the event's reward item. The **item** comes back next year (finish
  it again); the **medal** for a year never does.
- **Voice**: an `event-start` line on its first day ("🎃 the Haunting is
  here!"), occasional lines while it's on, a `last-call` line on its last day
  with goals left.
- **The banner**: across the top of the Us page, the Bugdex and the Wardrobe:
  emoji, name, a countdown ("3 days left", then "ends tonight"), the four goals
  with bars, and the medal greyed until done.
- **The card**: "I finished The Haunting 2026" (1200×630), medal, the bug, the
  finds, the days it took.

Testing: `SHELLBY_TODAY=2026-10-28` (dev builds and tests only, refused when
packaged) sets the date every season and event reads, through one
`d.today()`. The pure module never reads the clock.

## 2. Shinies (finds and bugs)

**Finds.** Every find dug up has a 1 in 128 chance of being **sparkly** (1 in 64
during Low Tide and for ghosts in The Haunting). A sparkly find is the same
find with its colours turned (bugdex/art.js `shiny`, moved to
`src/main/sparkle.js`) and a glint. The shelf keeps a count of each:
`items[id] = { n, first, last, shiny, shinyFirst }`.

**Bugs.** The Bugdex already rolls 1 in 64 (`SHINY_CHANCE`). It's been a chip
and a line. Now it gets the same moment as a sparkly find. A shiny that's also
golden or spectral shows both (golden or spectral colours, with the glint on
top).

**The reveal** (the moment people screenshot):

1. On the desktop he holds it up, the glint flashes three times, a rising chime
   plays (sound.js `sparkle`, held longer), and he says "✨ a SPARKLY one!!".
2. In the panel, a full-width **reveal card** replaces the usual toast: a dark
   card that flips over to the sparkly art at 8×, the odds ("1 in 128"), how
   many he's dug before it ("after 312 finds"), the date, and **📸 Share this**.
3. **Share** draws a 1200×630 moment card (`card.js` kit, kind `shiny`): the art
   huge on a starfield, the name, "✨ Sparkly", the odds, his level and title.
4. The first sparkly ever goes in the journal (bond.js `first-shiny`).

**Trophies**: ✨ *Glimmer* (your first sparkly, find or bug, for a Glitter Jar
in the tank), 🌟 *Shiny Hunter* (5 sparklies, for a Sparkle Trail effect), and
a secret one for a sparkly legendary.

**On the shelf and in the tank**: a ✨ filter on the shelf, sparkly copies drawn
in their own colours, and a sparkly find can go in the tank (`find:<id>` with
`shiny: true`, validated on cards too).

## 3. Crab eggs (invites)

Your crab can lay an egg for someone who doesn't have Shellby yet. The egg is a
**code** (`EGG-crabfan-7KQ2MX`) and a **link** (`shellby://hatch?egg=...`) to
send them, with the download link.

- **Laying**: needs Visiting crabs on (it's on your calling card) and level 5.
  One egg a week, at most three waiting. Each egg has an 8-character id from
  `crypto.randomBytes` and a look: a shell pattern from your crab's colours.
  Open eggs go on your public calling card: `eggs: [{ id, laidAt }]` (ids
  only).
- **Hatching** (the friend, after installing): paste the code in onboarding or
  Settings → GitHub → **Hatch an egg**, or open the link. Shellby reads the
  parent's public card (no sign-in needed), checks the egg is listed and
  unhatched, and it hatches: a crack, a wobble, a little crab. The friend gets:
  - **a hatchling** (see below), and the parent added as a friend once they
    turn on Visiting crabs,
  - the parent's favourite find as their first find,
  - the 🐣 *Hatchling* trophy, for a Baby Bib.
- **Claiming**: with Visiting crabs on, the hatcher's Shellby leaves a comment on
  the parent's card gist: `<!-- shellby-hatch:EGGID -->`. The parent's mail
  check (mail.js, next to waves) accepts it from anyone, but only once per open
  egg, and only for an id it laid. The egg is marked hatched, the hatcher is
  added as a friend, and the parent gets the 🥚 *Proud Parent* trophy (first),
  then 🐣🐣 *Big Clutch* (5).
- **The hatchling**: both crabs get the same baby, its palette mixed from both
  crabs' skins (deterministic from the egg id), with a name drawn from the egg
  id ("Pip", "Barnacle"...). It's in **the Clutch** on the Us page, and it can
  be the one that follows him around the desk instead of your favourite catch.

Nothing about an egg is secret except its id: a guessed id would need the
parent to have laid it.

## 4. Swaps (trading finds)

Friends can swap **finds** (never bugs: catches come from real fixes). Two
lists go on your calling card, each up to six: **Up for swaps** (finds you have
two or more of, sparklies too) and **Looking for** (filled in for you from the
sets you're closest to finishing, changeable).

- **Propose**: on a friend's row, **Swap…** shows what they offer and what
  they're looking for, with "finishes your Pirate's hoard" on anything that
  would. Pick one of theirs and one of yours. Shellby comments on their card
  gist: `<!-- shellby-swap:offer:SID:give=<find>[*]:get=<find>[*] -->` (`*` =
  sparkly). Your copy is set aside (it shows as "in a swap").
- **Accept or decline**: the offer shows in their inbox (friends only, as
  waves are), with both finds drawn. Accept checks they still have theirs, makes
  the swap on their side and comments `<!-- shellby-swap:accept:SID -->` on
  your card. When your Shellby sees it, your side completes.
- **Expire**: an offer no one answers in 7 days is cancelled and your copy
  comes back. Cancel any time before it's accepted.
- Swaps are between friends, at most 3 open at once, and 10 a week.
- Trophies: 🤝 *Fair Trade* (first swap), 🧩 *Missing Piece* (a swap that
  finishes a set).

## 5. The board (friends' Bugdex this month)

The calling card's Bugdex share (opt-in, `shareBugdex`) gains this month's
numbers: `month: { key: '2026-10', jars, byHabitat: { wreck: 3 }, shinies }`.
The Bugdex page gets **This month** above the friends list:

- You and your friends, ranked by jars this month, 🥇🥈🥉 for the top three,
  your own row marked, ties by who got there first.
- Tabs: **All bugs**, then any habitat someone caught in this month ("Most
  merge-conflict crabs" lives under Tangled Nets), and **Sparklies**.
- A card that's from last month counts as 0 (no stale scores).
- **📸 Share the board**: a 1200×630 card of the podium.
- At the end of the month, the first time you open the Bugdex in the new one,
  last month's result is a line in the journal ("2nd of 5 in October").

Per-month counts are kept for the last three months, per PC, synced as a max
like the rest of the book.

## 6. The PR line and commit trailer

The **Built with Shellby** badge (github/pr-badge.js) already goes on your pull
requests. Its line grows from `Built with Shellby · Lv 12` to
`🦀 Built with Shellby · Lv 12 Abyssal Admin · Tester · 3 bugs jarred this week`
(the class only once you have one, bugs only if there were any, and the event
emoji while one is on).

The badge already reaches pull requests Claude opens from a tab (`badgePr`
spots `gh pr create`), so Claude Code's own `attribution` is left alone: its
commit trailer names the model that made the commit, and Shellby can't know
which one that was.

One more switch under it, off to start: **Sign my bring-home commits**.
Shellby's own commits (bringing a copy home) get a trailer:
`Shipped-with: Shellby (Lv 12 Abyssal Admin)`.
