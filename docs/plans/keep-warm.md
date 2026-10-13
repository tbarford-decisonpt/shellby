# Keep warm: the cache still warm when you're back from lunch

A **Keep warm** button in the tab strip, beside New conversation and Files.
Press it before you walk away. While you're gone, Shellby sends each open
conversation with a warm cache one tiny message shortly before that cache would
expire. When you come back, your next message reads the conversation from the
cache instead of writing it all again.

Why: on a Claude plan, Claude Code caches each conversation for an hour. Past
the hour, the next message writes the whole conversation back into the cache,
a few hundred thousand tokens on a long one. A one-hour cache write is priced
at 2x the input rate and a cache read at 0.1x or less, so the cold message
costs at least twenty times what the same tokens cost warm. How either weighs
against a plan's limits isn't published, but the write is the expensive one.
The idea comes from Cache Tax's `/keepwarm` (karanb192/cache-tax). Here it is
a button that covers every conversation at once and stops by itself when
you're back.

This file is the contract between `src/main/keepwarm.js`,
`src/main/keepwarm-service.js`, `src/renderer/panel/keepwarm.js`, the
tab manager (`src/main/sessions.js`) and the tests.

## What it does

- **One ping at a time.** Due tabs are pinged in turn, never together, and a
  tab whose cache a ping just read isn't pinged again within 5 minutes.
- **One press covers every conversation big enough to be worth it.** While
  it's on, Shellby looks at every open tab every 30 seconds. A tab gets pinged
  when its conversation is 200k tokens or more (`MIN_KEEP_TOKENS`), its cache
  is warm and lasts an hour, and it is due within 5 minutes. A tab you're
  actively using is never due, because your own messages keep its cache warm.
  A tab that warms up, or grows past 200k, after you press the button is
  included from then on.
- **The ping goes 5 minutes before expiry.** It is due at
  `cache.at + cache.ttlMs - LEAD_MS`, with `LEAD_MS = 5 min`, from the stamp
  `session-accounting.js` already keeps. A read resets the cache's timer, and
  the hour counts from the start of the request. So each ping restamps
  `cache.at`, and the next one is due about 55 minutes later. Five minutes
  covers the 30-second tick, a slow start and a reply that thinks for a while.
  It also covers the stamp being late: `cache.at` is set on a call's first
  event, a little after the request starts, which is when the cache's hour
  really began. Don't shorten the lead without allowing for that.
- **It stops on its own:**
  - **You're back.** The first idle reading under 2 minutes, after at least
    one reading of 2 minutes or more since you pressed the button. These are
    the same readings and threshold that "While you were away" uses
    (`recap.js` `IDLE_MS`).
  - **You send a message from the panel, in any tab.** A routine, a workflow,
    the reset queue or your phone sending one doesn't count: you aren't back
    at the PC. Nor does a message you queued before leaving going out by
    itself when the turn ahead of it ends.
  - **3 hours** after you pressed it (`MAX_MS`). A button you forgot can't ping
    all night.
  - **You press it again**, or Shellby quits. Nothing is saved across a
    restart: a restart ends every process, and a resumed process rebuilds its
    prompt, so the cache would not survive it anyway.
  - **Nothing is left to keep warm**: every tab it kept has been dropped or
    closed, and no tab is working that could warm up again.
- **It won't arm with nothing to do.** If no conversation of 200k or more has
  a warm one-hour cache when you press it, it doesn't turn on. A toast says why
  and names the floor.

### What a ping is

One fixed message, sent through the tab's own running Claude process:

> Keep-warm ping from Shellby. Reply with the single word: warm. Use no tools.

- **Through the running process, never a new one.** Claude Code rebuilds its
  prompt at each start (git status, date, memory). A resumed or forked process
  can ask about a different prefix and pay a full write.
- **Not through `manager.send`.** A ping skips History, the effort picker,
  the note preamble, `decorate`, `prepareTurn`, steering and
  `history.markTurn`, so a power cut mid-ping doesn't mark the conversation
  unfinished. It goes through a new `manager.ping(tabId, text)` that calls
  `session.send` directly. Effort matters most here: a change in effort or
  thinking settings breaks the messages cache, so a ping must never change
  either. While a ping runs, `takeSteers` hands over nothing: a message you
  queue then waits for the ping to end and goes as a turn of its own.
- **Out of the conversation feed.** While a tab has a ping in flight
  (`tab.pinging`), the manager drops what that tab's process says (the
  replayed user message, the text and the result) before it reaches `onItem`.
  Notes Shellby adds itself, such as a check's verdict, still go through. They are neither saved nor sent to the panel, and they don't
  set `unread`, `outcome`, the crab or the Ready rail. In their place the
  service adds one `keepwarm` item to the tab's History and feed, drawn as a
  dim line:
  - `Kept warm 12:55 · read 214k from cache`
  - `Stopped keeping warm: <reason>`

  The panel learns a turn has ended only from its `result` item (`boot.js`
  `onTabItem` clears `tab.busy`). So the `keepwarm` item also ends the turn
  there: it clears `busy`, sends anything you queued meanwhile
  (`onTurnEnded`, which only drains the queue) and calls `syncBusyUi`, but
  leaves `unread` alone. The swallowed items go nowhere else either, so the
  crab and the recap's turn lines never hear about a ping. Its `usage`
  readings do pass through, so what it spent reaches spend, the recap's usage
  figures and Lean.
- **Its cost shows.** The ping's calls go into spend (usage by project) and
  Lean's cache figures like any call's, and its receipt line says what it
  read. It has no row in the per-turn ledger, which counts only turns that go
  through `prepareTurn`.
- **Claude still sees it.** Each ping and its one-word reply add about 30
  tokens to Claude Code's own transcript, because they go through the real
  conversation.

### When a tab is skipped or dropped

Each tab carries its state and the reason it is in that state. The button's
tooltip lists them.

| Tab | What happens | Reason shown |
|---|---|---|
| Cache warm, lasts 1 hour, due | ping | - |
| Working (`busy`), waiting on you (`pending`), or crew running | skip this tick; its own turn restamps the cache | "working" |
| Cache lasts 5 minutes (an API key without `promptCacheTtl: "1h"`) | not pinged | "its cache only lasts 5 minutes" |
| Conversation under 200k tokens (`MIN_KEEP_TOKENS`), as its context meter reads | not pinged; a kept tab that falls under it, after a compact say, is dropped | "too small to be worth it (40k)" |
| Cache already cold, for example the PC slept past it | dropped, no ping (it would pay the full write) | "it went cold at 13:02" |
| No process, terminal mode, or nothing sent yet | not pinged | "nothing to keep warm" |
| Ping read nothing, or wrote at least a tenth of what it read and at least 10k | kept the first time, since the ping wrote the cache back and the next one should read it; dropped if the next ping finds it cold too | "the ping found it cold (read 0, wrote 212k)" |
| Ping ended in an error (window used up, API error) | dropped | the error, first line |
| Ping asked for a permission | denied at once, dropped | "the ping tried to use a tool" |
| Ping got no reply within 5 minutes (`LEAD_MS`) | dropped, and the next tab's ping can go | "the ping got no reply" |
| Tab closed, or its process died | dropped | - |

The read and write rule is Cache Tax's. Either reading means the cache had
gone. One cold ping still leaves the cache warm, because it wrote it back, so
Shellby gives the tab one more ping. Task 0's spike found that a process's
second turn always rewrites part of its first message (it read 21k and wrote
16k), so a ping that is a tab's second turn looks cold once and then reads
normally. Two cold pings in a row mean pings aren't holding this tab's cache,
and pinging on would pay a write every 55 minutes. Its receipt line then says
what it wrote: `Kept warm 12:55 · read 21k from cache, wrote 16k`. The 10k floor
is Shellby's: every warm ping writes about 2.6k of its own (its message, the
reply and what Claude Code attaches to each turn), which on a small
conversation can pass a tenth of what it read.

The 200k floor is Shellby's too. What a ping saves grows with the
conversation; what it costs mostly doesn't: about 2.6k written per ping, and
about 16k more when the ping is a process's second turn. On a 200k
conversation a cold return writes 200k at twice the input rate, about 400k
input-equivalent, against about 25k for a ping. Below 200k the saving isn't
worth the pings and a PC kept awake. A conversation on a 200k context window
can't reach the floor, so in practice only 1M-window conversations are kept
warm.

### What else changes while it's on

- **Idle stop leaves warm tabs alone.** `stopIdle` stops the process of any tab
  quiet for 30 minutes, which is long before the first ping. While Keep warm is
  on, a tab it is still keeping is skipped.
  `stopIdle(idleMs, now, keep = () => false)` takes the service's
  `isKept(tabId)`. A dropped tab goes back to the normal rule. When Keep warm
  stops, each tab it was still keeping counts as just used, so idle stop
  doesn't end those processes in the minute after you come back.
- **The PC stays awake.** A laptop asleep at lunch pings nothing. While it's
  on, Windows is asked not to sleep (`powerSaveBlocker`
  `'prevent-app-suspension'`, as the reset queue does), and that ends when it
  stops.
- **The spending guard isn't asked.** A ping uses far less of the 5-hour window
  than the write it saves, so the guard's reserve doesn't hold it. A window
  that is really used up shows up as the ping's error, which drops the tab and
  says so.

## The button

`#keepWarmBtn` in `html/frame.html`, after `#filesBtn`. It is styled with
`.tab-add, .tab-files` (`components.css`), and its icon is an inline 16x16
SVG of a mug with steam.

- **Off:** the icon, titled "Keep warm while you're away".
- **On:** lit, with the time left: `Warm · 2h41m`. `aria-pressed="true"`.
- **Tooltip while on:** one line per tab, such as
  `Labatt fix · next ping 13:55`,
  `Design step · its cache only lasts 5 minutes`, or
  `Docs · stopped: the ping found it cold`.
- **Always visible.** It covers every tab, so unlike Files it stays when
  there's more than one pane. Split, the top strip hides, and the mug moves
  to the bar under it with the review and list buttons (`tab-overview.js`).

## Pieces

| File | What |
|---|---|
| `src/main/keepwarm.js` | Pure. `plan(tabs, kept, now, lead)`: which tabs to ping, wait, skip or drop, and why. `receipt(result)`: warm, or the reason to drop. `watchBack(left, reading)`: has the user returned. Constants `LEAD_MS`, `MAX_MS`, `TICK_MS`, `COLD_SHARE`, `COLD_MIN_WRITE`, `MIN_KEEP_TOKENS`. No Electron. |
| `src/main/keepwarm-service.js` | Arms and disarms, runs the 30-second tick, calls `manager.ping`, reads each ping's result, adds the receipt items, holds the power blocker, and pushes `keepwarm` state to the panel. Takes its dependencies as `d`, as `away-service.js` does. |
| `src/main/sessions.js` | `ping(tabId, text)`, the `tab.pinging` branch where the session's items arrive, `keep` in `stopIdle`, and `touch(id)` for when Keep warm stops. A pinging tab's busy state is left out of `aggregate`, so the crab, the tray and the Multitasker trophy never count a ping; its helpers and jobs still count. `wiring/timetrack.js` `claudeAt` leaves it out too. The summary still says `busy`, so a message typed during a ping queues. |
| `src/main/history.js` | `'keepwarm'` joins `PERSISTED`, so receipts come back when a conversation is reopened or synced. |
| Disarming | `ipc/tabs.js` `task:send` calls `userSent()`, and `away-service` `checkAway` hands each idle reading to `reading()`. |
| `src/main/ipc/*.js`, `src/preload/preload.js` | `keepwarm:set(on)` (handle) and the `keepwarm` push. The preload is at 800 lines, so it has to give up a line first. |
| `src/renderer/panel/keepwarm.js` | The button, its countdown, its tooltip, and drawing `keepwarm` items. |
| `changes/keep-warm.md` | The change note. |

`session.js` is also at 800 lines and doesn't change: a ping uses its
existing `send`.

## Tests

- **`test/keepwarm.test.js`** (pure, mock clock):
  - due times
  - every row of the skip table
  - the read and write rule
  - back detection, including staying put after pressing
  - a tick that wakes past expiry and drops the tab instead of pinging
- **`test/keepwarm-service.test.js`** (fake clock and tab manager): the
  3-hour cap, one ping at a time, a ping that never answers, closed and dead
  tabs.
- **A fake-CLI session test.** The fake replies with `cache_creation` carrying
  `ephemeral_1h_input_tokens`, so the hour path runs. The fixture currently has
  no `cache_creation`, so it falls back to 5 minutes. The test checks four
  things:
  - a ping goes through the live process
  - it leaves History, `unread` and the feed alone
  - it adds one `keepwarm` item
  - `stopIdle` spares the kept tab
- **`scripts/e2e-keepwarm.js`** (`// ci:`): press the button with a cache
  backdated past due, as `e2e-lean.js` backdates `cache.at`, then check the
  dim line, the countdown, and that a simulated return turns it off.
  `SHELLBY_KEEPWARM_LEAD_MS` sets the lead for this test.
- **Before the PR:** one live check on a real plan session. Set the lead so a
  ping is due a minute after the last turn, then check that the receipt reads
  the conversation's size from cache and that `cache.at` moves. The fake CLI
  can't show that a real ping holds a real cache, but that receipt's read count
  does.

## Not in this

- Arming by itself when you leave, or "Tell me when I'm away" turning it on.
  Press it yourself, so pings never surprise anyone.
- Choosing which tabs, or a length per press. Every warm tab is kept, for up
  to 3 hours.
- Warning before a cold send, the other half of Cache Tax.
- Caches that last 5 minutes. Pinging every 4 minutes for an hour costs more
  than it saves on most conversations.
