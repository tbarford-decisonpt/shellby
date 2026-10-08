# The Bugdex: catch the bugs you've beaten

> Status: **built, all four phases, in one release.** The plan below is kept as
> written; where the build differs, it's listed here. The version is settled at
> merge time (the next minor after whatever is current then).

## What changed from the plan

- **One release, not four.** Every species is live (`LIVE_PHASE = 3`); `phase` stays on
  each entry as the record of which group it came in with.
- **Phase 4 shipped too.** The plugin (1.5.0) forwards `PostToolUseFailure` for Bash and
  PowerShell. `external.js bugsOf()` reads each command with `detect.read()` and only a
  *reading* leaves it (hashes, a species, yes/no flags), never the command or its output.
  Shellby's own tabs use the same reading, so both go through one catch pipeline
  (`wiring/bugdex.js handle`).
- **Sprites are at most 8×8** (like finds), so the jar (`art.jarArt`) is the art plus a
  glass rim and a cork, at most 12×11, with no scaling.
- **Portraits for the book.** Each species also has a portrait (`bugdex/portraits/`, one
  file per habitat): up to 22×22, shaded, inked round the edge by `art.inked`. The page,
  the catch card, the sparkly picture and the battle show the portrait; the jar, the tank,
  the tide pool and the battle chip keep the 8×8 sprite. `node scripts/bugdex-sheet.js`
  draws them all to a PNG.
- **Flaky ghosts and audits don't open encounters.** A flake is a Flaky Phantom *seen*; the
  detective's own "fixed for good" (20 clean runs over 3 new trees) is the proof, so it
  catches directly. A patched audit catches the Barnacled Anchor the same way.
- **Encounter lifetimes differ by source**: a day for commands and dev servers, three
  days for a secret stopped at the push, a week for CI and a copy that clashed.
- **Refusal order**: a deleted or skipped test is named before "that just put the code
  back how it was", because it says more.
- **The jar waits for him.** Catches land mid-turn, so the moment is queued
  (`life.presentJar`) until he's free (checked when a turn ends and on the idle tick);
  a newer catch replaces a waiting one, and it goes stale after 10 minutes.
- **The card count** went on the profile card (`renderer/panel/profile-card.js`), not the
  calling card, which promises "no stats".
- **Recap** gained a `bug` event (`recap.bugEvent`) and a Bugdex line in the
  while-you-were-away card.
- `bug-terrarium` (not `terrarium`, which `shell-cargo.json` already has) is the
  Naturalist reward.

The code: `src/main/bugdex.js` (state, pure), `src/main/bugdex/` (`species`, `detect`,
`lifecycle`, `cheats`, `art`), `src/main/wiring/bugdex.js`, and the panel's
`src/renderer/panel/bugdex.js`. Tests: `test/bugdex*.test.js`, `scripts/e2e-bugdex.js`
(fixtures in `test/fixtures/bugdex/`).

A collection book of the kinds of failure Claude has fixed for you. Every kind of failure is a pixel creature: a TypeError is a shapeshifting shrimp, ENOENT is a hermit crab that lost its shell, a merge conflict is a crab with two heads, and a flaky test is a ghost. **You don't catch one by seeing the error. You catch it by fixing it.** Shellby sees the failure (the creature turns up as a silhouette, "spotted"). Claude works on it. Then the same command passes on changed code, CI goes green, the server comes back up, or the conflict is committed cleanly, and the crab scoops the bug into a jar.

It sits next to the finds-and-sets system (`gifts.js`) and copies its shape: art as rows of characters plus a palette, rarities, sets (here called **habitats**), silhouettes with hints, `unseen` pills and set-complete moments. The difference is that finds come from idle digging, and Bugdex entries only come from results Claude produced.

The same strictness as `docs/plans/flaky-tests.md` applies: **a false catch teaches people the Bugdex is a slot machine.** Every rule below is tuned to miss some real fixes rather than ever reward a bug nobody fixed.

Everything stays on this PC except species counts, which sync like XP. No error text is stored, only a species id, a 12-character hash and a project id.

This file is the contract between the pure modules (`src/main/bugdex*.js`), main, the panel, the crab and the tests.

---

## 1. The lifecycle: spot, engage, catch

```
OBSERVE ──> ENGAGE ──> CATCH
   │           │          │
   │           │          └─ same command passes on a changed tree / CI red→green /
   │           │             server back up and stays up / conflict committed / push clean
   │           └─ Claude writes files in that project (Edit/Write/MultiEdit/NotebookEdit tool
   │              items carry item.filePath, stream.js toolItem) or runs a remedy command
   └─ a failing result whose output matches a species signature
      → an "encounter" { species, fp, project, cmdKey, failTree, tab, at, source }
```

- **Seen** means at least one encounter was ever opened. The panel shows the species as a dark silhouette with its name and a catch hint ("Spotted in shellby 12 min ago. Fix it to catch it."). Pokédex "seen" works the same way.
- **Caught** means an encounter closed with a catch. The species shows in colour with its stats.
- **Unknown** means never seen. The tile shows `???` and a habitat hint. The renderer gets no pixels for it (no spoilers, and nothing for the renderer to leak).
- **On the loose**: open encounters (24 h at most). The panel shows them as a strip above the grid. **Seeing earns nothing.** No XP, no stat and no crab reaction: a failure never pays.
- **Slipped away**: an encounter that hit its 24 h TTL without a catch. It closes quietly, the seen count stays, and there's no message.
- **Escape**: a caught fingerprint shows up again in the same project within `ESCAPE_MS = 3 days`. The species entry counts `escapes += 1`, and that catch loses its "for good" mark. A re-catch of that fingerprint inside the cooldown is recorded but pays nothing. Progress is never taken away (house rule: progress only grows, and sync merges only add). The only negative is a line in the panel: "Got away once."

### Where each step comes from (verified call sites)

| Source | Observe | Catch | Hook point |
|---|---|---|---|
| **Bash/PowerShell in a tab** | `tool_result` with `isError`, or a test run whose summary failed (`flaky.readRun`), and a signature in the output | same `cmdKey` (or a broader run) passes, tree changed, signature gone, diff passes the cheat checks | `src/main/wiring/sessions.js:103-142` (the `pendingCommands` pairing; `tail` arrives as the 4th arg of the `item` event) |
| **Flaky test** | `flaky.recordRun(...).flakes` (already counted there) | `r.fixed` (20 clean runs across 3 new trees, `progress.js:266`) | `src/main/wiring/progress.js` `noteTestRun` (line 246) |
| **CI** | `onCiEvent` `type === 'failed'` (`wiring/github.js` ~line 248; `pr.failing` = check names, `pr.sha`) | `type === 'fixed'` (`ci.js transitions()` line 49 emits it when `wasFailing` and now passing), **and** Shellby took part since the red (see §6.3) | `wiring/github.js onCiEvent`; `wiring/startfrom.js send()` |
| **Dev server** | `DevServers` `'crashed'` event (`service.js ended()` ~431), with log lines from `fixDraft(id).lines` (already redacted by `out.redactLines` and trimmed to the tail) | `sendFix` set `fixTabId` (service.js ~551) → that tab's turn ends OK (`onTabDone`, called from `wiring/timetrack.js:257`) → `'up'` (`poll()` ~427) within 30 min and **no `'crashed'` for 60 s** | `wiring/projects.js:53-55` (where `crashed` is already listened to), `timetrack.js onResult` |
| **Bring it home** | `worktrees.bringHome` returns `{ conflict: true }` (it runs `merge --abort` itself, worktrees.js ~352) | a later `bringTabHome` for the same tab/branch returns `merged: true`, after at least one turn in that tab | `src/main/ipc/repo.js bringTabHome` (lines 41-75) |
| **git in Bash** | `CONFLICT (...)`, `Automatic merge failed`, `could not apply <sha>` | a later successful `git commit` / `merge --continue` / `rebase --continue` / `cherry-pick --continue` in that project, `git ls-files -u` empty, no `^<<<<<<< ` in the conflicted files (`git grep`), and no `--abort` / `reset --hard` in between | sessions.js path plus a special catch check in the wiring |
| **Secret push gate** | `secretGate` finds secrets and you pick "Ask Claude to take them out" (`ipc/repo.js:111`, `response === 1`) | the next `pushHome` for that root passes the gate with no findings and pushes | `ipc/repo.js secretGate` / `pushHome` |
| **Dependency audit** | `checkedUp` records `status: 'issues'` | `recordCheckup(...).patched` (`progress.js:151`, checkup.js:247) | `wiring/progress.js checkedUp` |

### What a tool result gives us (verified)

- `tool` item: `{ id, name, label, detail (command, whitespace collapsed, max 400 chars), background?, filePath?, writeChars?, ...sub }` (stream.js `toolItem`). Main pairs it with its result through `d.pendingCommands` (`{ command, project: basename, dir, cwd, tree }`).
- `tool_result` item: `{ id, isError, text (first 8,000 chars + "… (N more characters)"), ...sub }`, plus `tail` (the last 8,000) passed separately. `progress.js testOutput(item, tail)` puts them back together; **reuse it** (move it to `src/main/flaky/text.js` or export it from the wiring).
- The tab gives `tab.session.cwd`, `tab.worktree` (`{ path, root, branch, base, originalCwd }`), `tab.turnId` and `tab.id`.
- Trees: `changes.snapshot(dir)` → `{ root, head, tree }`. In a worktree copy it writes into the shared object store, so trees from a copy and from the checkout can be diffed in the repo root. `changes.summarize(start, end)` and the internal `changedFiles(root, before, after)` → `[{ path, status: 'A'|'M'|'D', added, removed }]`. `changes.patchFor({ root, before, after, file })` → unified diff, capped at 400 KB.
- Project: `gitinfo.projectOf(dir)` → `{ id, root, name, remote }`. The id is the same for a repo and every worktree of it, which flaky already relies on.

**Small change needed:** add `tabId` to the object stored in `d.pendingCommands` (sessions.js:108). It is the only missing field.

---

## 2. Species catalogue

66 species in 12 habitats plus one hidden special. Dex numbers are **assigned once and never reused**. A test pins them.

Each entry in `src/main/bugdex/species.js`:

```js
{ no: 1, id: 'shapeshifter-shrimp', name: 'Shapeshifter Shrimp', habitat: 'shallows', type: 'runtime',
  rarity: 'common', phase: 1, blurb: 'Was a string a second ago. Swears it.',
  hint: 'Lives in the Shallows: a TypeError.', lang: ['js', 'py'],
  evolves: ['Morphing Prawn', 'Polymorph Lobster'],      // optional, stage II and III names
  remedies: null,                                         // see §4.3
  palette: {...}, pixels: [...] }
```

Rarity reflects **how hard or rare the fix is**:
- **common**: most developers see it weekly and one edit usually fixes it.
- **uncommon**: it needs some digging or an environment fix.
- **rare**: it needs a real diagnosis (memory, concurrency, security, a native crash).
- **legendary**: it needs proof over days and many runs.
- **special**: hidden easter egg.

Types (the "element") are `runtime`, `io`, `net`, `vcs`, `ci`, `build`, `types`, `py`, `sys`, `test`, `sec` and `ghost`. The renderer gives each a type colour chip.

### Habitats (sets)

| id | Name | Icon | Theme |
|---|---|---|---|
| `shallows` | The Shallows | 🌊 | JS/runtime errors |
| `burrows` | The Burrows | 🕳️ | filesystem |
| `currents` | The Currents | 🌀 | network and HTTP |
| `nets` | Tangled Nets | 🪢 | git |
| `lighthouse` | The Lighthouse | 🗼 | CI |
| `workshop` | The Reef Workshop | 🛠️ | tooling, builds, installs, servers |
| `kelp` | The Kelp Maze | 🌿 | type checkers |
| `pypool` | The Sea-Snake Pool | 🐍 | Python |
| `trench` | The Deep Trench | 🌑 | Rust, Go, native |
| `proving` | The Proving Pools | 🧪 | tests |
| `vault` | The Sunken Vault | 🔐 | security |
| `wreck` | The Haunted Wreck | 👻 | ghosts (Haunted Shell tie-in) |

### The full list

"P" is the phase in which the species goes live (§13). Sources: **B** = Bash/PowerShell result, **T** = test run, **S** = dev server log, **C** = CI, **G** = git/Bring it home, **P** = push gate, **A** = audit, **F** = flaky detective.

| No | id / Name | Habitat · type | Rarity | Art concept | Src | Catch condition (beyond §4 defaults) | Blurb | P |
|---|---|---|---|---|---|---|---|---|
| 001 | `shapeshifter-shrimp` Shapeshifter Shrimp | shallows · runtime | common | half-square, half-round blob, two colours | B T S | pass on changed tree | "Was a string a second ago. Swears it." | 1 |
| 002 | `nullfish` Nullfish | shallows · runtime | common | see-through fish outline with nothing inside; forms per language | B T S | — | "There's nothing there. That's the problem." | 1 |
| 003 | `nameless-nudibranch` Nameless Nudibranch | shallows · runtime | common | sea slug with a blank name tag | B T | — | "Nobody declared it. It came anyway." | 1 |
| 004 | `syntax-slug` Syntax Slug | shallows · runtime | common | slug shaped like `{` with a missing `}` | B T S | — | "Left a bracket open in 2019." | 1 |
| 005 | `off-by-one-octopus` Off-by-One Octopus | shallows · runtime | common | octopus with 7 arms | B T | — | "Counts its arms from zero. Gets seven." | 2 |
| 006 | `ouroboros-eel` Ouroboros Eel | shallows · runtime | uncommon | eel biting its own tail | B T S | — | "Calls itself. Calls itself. Calls itself." | 2 |
| 007 | `broken-promise-prawn` Broken Promise Prawn | shallows · runtime | uncommon | prawn with a cracked pinky-swear claw | B T S | — | "Said it would resolve. Didn't." | 2 |
| 008 | `heap-leviathan` Heap Leviathan | shallows · runtime | rare | whale too big for the frame, cropped | B T S | pass, and the diff isn't only `--max-old-space-size` / `NODE_OPTIONS` (§4.4) | "Ate every byte. Still hungry." | 2 |
| 009 | `shell-less-hermit` Shell-less Hermit | burrows · io | common | hermit crab, soft pink abdomen, no shell | B S | — | "Its file was right here a minute ago." | 1 |
| 010 | `locked-limpet` Locked Limpet | burrows · io | uncommon | limpet with a padlock | B S | — | "Clamped shut. Asks for permission it'll never get." | 2 |
| 011 | `clingy-barnacle` Clingy Barnacle | burrows · io | uncommon | barnacle gripping a file icon | B | remedy allowed (process kill) | "This file is being used by another process. Its." | 2 |
| 012 | `mixed-up-mussel` Mixed-up Mussel | burrows · io | uncommon | mussel half folder, half file | B | — | "Thought it was a folder. It was a file." | 2 |
| 013 | `overstuffed-pufferfish` Overstuffed Pufferfish | burrows · io | rare | puffed to bursting | B S | remedy allowed (cache cleanup) | "No space left. Not even for air." | 3 |
| 014 | `closed-clam` Closed Clam | currents · net | uncommon | clam firmly shut | B S T | remedy allowed (start a service) | "Knocked. Nobody home." | 2 |
| 015 | `port-squatter` Port Squatter | currents · net | uncommon | crab sitting in a porthole labelled `:3000` | B S | remedy allowed (kill / kill-port); if fixed by a kill, may be **revealed** as 066 Zombie Process (phase 3) | "Got there first. Won't move." | 1 |
| 016 | `slowpoke-snail` Dawdling Snail | currents · net | uncommon | snail with a stopwatch shell | B T S | pass, and the diff isn't only a bigger timeout number (§4.4) | "Still on its way." | 2 |
| 017 | `snapped-line` Snapped Line | currents · net | uncommon | fishing line cut mid-air | B S T | — | "Hung up on you. Rude." | 2 |
| 018 | `nameless-buoy` Nameless Buoy | currents · net | uncommon | buoy with a `?` flag | B S | — | "Can't find where it's going. Or where it is." | 3 |
| 019 | `border-crab` Border Crab | currents · net | uncommon | crab in a customs cap holding a stamp | B T S | the diff touches non-test code | "Your origin isn't on the list." | 3 |
| 020 | `lost-parcel-crab` Lost Parcel Crab | currents · net | common | crab holding a box stamped 404 | B | command failed (`curl -f` exit 22, fetch scripts) | "Delivered to an address that doesn't exist." | 3 |
| 021 | `meltdown-medusa` Meltdown Medusa | currents · net | uncommon | red jellyfish, steam | B S T | — | "Something went wrong. On their end. Probably." | 3 |
| 022 | `two-headed-crab` Two-Headed Crab | nets · vcs | uncommon | two heads, ours blue and theirs orange, `=======` belly | B G | conflict check (§6.4) | "Both heads are right. That's the problem." | 1 |
| 023 | `bounced-bottle` Bounced Bottle | nets · vcs | uncommon | message in a bottle washed back | B | a later `git push` in that project succeeds and isn't `--force` without `--force-with-lease` | "Sent it. The sea sent it back." | 2 |
| 024 | `gatekeeper-goby` Gatekeeper Goby | nets · vcs | uncommon | goby with a tiny gate | B | the next `git commit` succeeds **without** `--no-verify` / `-n` | "Checks every commit at the door." | 2 |
| 025 | `lockfile-lobster` Lockfile Lobster | nets · vcs | common | lobster sitting on `index.lock` | B | remedy allowed (removing the lock) | "Another git process seems to be running. It's this one." | 3 |
| 026 | `red-tide` Red Tide | lighthouse · ci | common | red wave over a lighthouse | C | §6.3 | "The whole bay went red. Then it didn't." | 1 |
| 027 | `matrix-hydra` Matrix Hydra | lighthouse · ci | rare | three heads tagged win/mac/linux, one red | C | only one OS's check in a matrix failed, then all green | "Fine on two systems. Bit the third." | 3 |
| 028 | `sunken-deploy` Sunken Deploy | lighthouse · ci | uncommon | little ship, bow down | C | a failing check named like a deploy (`vercel|netlify|deploy|pages`) | "Launched. Sank. Refloated." | 3 |
| 029 | `stalled-galleon` Stalled Galleon | lighthouse · ci | uncommon | becalmed galleon, slack sails | C | a check concluded `timed_out` (needs `verdict()` to keep conclusions) | "No wind. Six hours. Cancelled." | 3 |
| 030 | `the-kraken` The Kraken | lighthouse · ci | **legendary** | tentacles around a lighthouse | C | 3 or more distinct failing checks on one PR, all fixed by one Shellby-involved push | "Every check, red. Every one, green again." | 3 |
| 031 | `stray-module-minnow` Stray Module Minnow | workshop · build | common | minnow with a broken chain link | B S T | remedy allowed (`npm i`, `pip install`, `go get`, `cargo add`...) | "Swam off from node_modules and never came back." | 1 |
| 032 | `tangled-tree-crab` Tangled Tree Crab | workshop · build | uncommon | crab in a knot of dependency branches | B | the same install command passes, and the manifest changed (`package.json`, `pyproject.toml`, `Cargo.toml`...) | "Its peer dependencies have peer dependencies." | 2 |
| 033 | `collapsed-castle` Collapsed Castle | workshop · build | common | slumped sandcastle (beach art reused) | B | a build command passes | "Built it. Watched it fall. Built it again." | 2 |
| 034 | `lint-louse` Lint Louse | workshop · build | common | tiny louse holding a red squiggle | B C | a linter command passes; no new `eslint-disable` / `noqa` / `#[allow]` in the diff | "Small. Annoying. Everywhere." | 2 |
| 035 | `beached-whale` Beached Whale | workshop · build | uncommon | whale on sand | S | §6.2 | "Ran aground on `npm run dev`." | 1 |
| 036 | `old-salt` Old Salt | workshop · build | uncommon | bearded crab with a version tag | B S | — | "Only runs on the version it grew up with." | 3 |
| 037 | `mismatched-mantis` Mismatched Mantis Shrimp | kelp · types | common | mantis shrimp with mismatched claws | B | typecheck passes; no suppressions (§4.4) | "Punched a string into a number slot." | 2 |
| 038 | `missing-fin-pipefish` Missing-Fin Pipefish | kelp · types | common | pipefish with a dotted outline where a fin should be | B | as above | "Property 'fin' does not exist on type 'Pipefish'." | 2 |
| 039 | `undeclared-urchin` Undeclared Urchin | kelp · types | uncommon | urchin with no label | B | as above | "Could not find a declaration file. It is one." | 2 |
| 040 | `anything-anemone` Anything Anemone | kelp · types | common | anemone with `any` tentacles | B | as above, and no `as any` added | "Accepts anything. Trusts nothing." | 2 |
| 041 | `optional-oarfish` Optional Oarfish | kelp · types | uncommon | oarfish fading out at the tail | B | as above; no non-null `!` assertions added | "Possibly undefined. Definitely long." | 2 |
| 042 | `hinted-hermit` Hinted Hermit | kelp · types | uncommon | hermit with a type-hint sticky note | B | mypy/pyright passes; no `# type: ignore` added | "Its hints and its code disagree." | 2 |
| 043 | `type-tangle` Type Tangle | kelp · types | common | a knot of kelp | B | typecheck passes; no suppressions | "error TS-something. It all looks the same in the kelp." | 1 |
| 044 | `keyless-krill` Keyless Krill | pypool · py | common | krill holding an empty keyring | B T | — | "Looked up a key that was never in the dict." | 2 |
| 045 | `wonky-whelk` Wonky Whelk | pypool · py | common | whelk shell spiral off by one tab | B T | — | "Four spaces. No, a tab. No, four spaces." | 2 |
| 046 | `circular-sea-snake` Circular Sea Snake | pypool · py | uncommon | sea snake in a loop | B T | — | "Imports the module that imports it." | 2 |
| 047 | `attribute-anglerfish` Attribute Anglerfish | pypool · py | common | anglerfish whose lure is missing | B T | — | "Has no attribute. Has a lot of teeth." | 2 |
| 048 | `off-value-oyster` Off-Value Oyster | pypool · py | common | oyster with a square pearl | B T | — | "Right type. Wrong value." | 2 |
| 049 | `zero-dab` Divide-by-Zero Dab | pypool · py | uncommon | flatfish split into ∞ | B T | — | "Shared the pie with nobody." | 2 |
| 050 | `borrowing-hermit` Borrowing Hermit | trench · sys | uncommon | hermit crab trying to live in two shells at once | B | `cargo build/check/test` passes (a `.clone()` is a legitimate fix, so it isn't refused) | "Hermit crabs borrow shells. Not two at once." | 2 |
| 051 | `rusty-nautilus` Rusty Nautilus | trench · sys | common | nautilus with rust spots | B | cargo passes; no `#[allow(...)]` added | "Compiles eventually. Eventually." | 2 |
| 052 | `panicked-prawn` Panicked Prawn | trench · sys | uncommon | prawn with arms up and `!` | B T S | — | "Called unwrap() on None. Is now unwell." | 2 |
| 053 | `nil-gopherfish` Nil Gopherfish | trench · sys | uncommon | gopher-faced fish pointing at nothing | B T S | — | "Dereferenced the void. The void didn't like it." | 2 |
| 054 | `knotted-eels` Knotted Eels | trench · sys | rare | two eels in a knot, each holding the other's tail | B T S | — | "All goroutines are asleep. These two especially." | 2 |
| 055 | `segfault-squid` Segfault Squid | trench · sys | rare | squid with inky "139" | B T S | — | "Touched memory it doesn't own. Inked everywhere." | 2 |
| 056 | `red-snapper` Red Snapper | proving · test | common | red fish that turns green as it evolves | T | a test run that failed with no more specific species passes on a changed tree, with **no fewer passing tests** (§4.4) | "Red. Then green. Then snapped up." | 1 |
| 057 | `assertive-lobster` Assertive Lobster | proving · test | common | lobster pointing at a `≠` | T | as Red Snapper | "Expected one thing. Received another. Said so loudly." | 2 |
| 058 | `mirror-mullet` Mirror Mullet | proving · test | uncommon | mullet looking in a hand mirror | T | **not** caught when the pass ran with `-u` / `--update-snapshot` / `--snapshot-update` or the diff touches only `*.snap` / `__snapshots__` | "Doesn't look like it used to." | 2 |
| 059 | `leaky-clam` Leaky Clam | vault · sec | rare | clam with a key for a pearl | P | §6.5 | "Its pearl was an API key. Now it's in .env." | 2 |
| 060 | `barnacled-anchor` Barnacled Anchor | vault · sec | uncommon | anchor crusted with CVE barnacles | A | `recordCheckup(...).patched` | "Known vulnerabilities. Known, now fixed." | 2 |
| 061 | `cert-cuttlefish` Cert Cuttlefish | vault · sec | rare | cuttlefish with a wax-seal badge | B S | not caught if the diff adds `rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED`, `verify=False` or `-k`/`--insecure` | "Its certificate expired at sea." | 3 |
| 062 | `flaky-phantom` Flaky Phantom | wreck · ghost | rare | small ghost holding dice | F | `flaky.recordRun().fixed` (already 20 runs / 3 new trees) | "Fails when you look away. Not any more." | 1 |
| 063 | `heisenbug` Heisenbug | wreck · ghost | **legendary** | ghost half there, scanlines | F | flake fixed for good, and the test had **at least 5 flakes over at least 3 distinct days** | "Observed it. It changed. Caught it anyway." | 3 |
| 064 | `race-wraith` Race Wraith | wreck · ghost | rare | two ghosts racing through one door | B T | `WARNING: DATA RACE` gone from a `-race` run on a changed tree | "Arrives before itself." | 3 |
| 065 | `cache-ghoul` Cache Ghoul | wreck · ghost | uncommon | ghoul peeking out of a box | B T | **same tree**, fixed only by a cache-clearing remedy (§4.3) | "Lives in the cache. Rent-free." | 3 |
| 066 | `zombie-process` Zombie Process | wreck · ghost | uncommon | green ghost crab with a little gravestone | B S | revealed at catch: a Port Squatter or Clingy Barnacle fixed by killing a leftover process | "Its parent left. It didn't." | 3 |
| 099 | `missingno` UNDEFINED. | — (no habitat) | special | glitch-block sprite | B T | a JS `undefined is not a function` or an error whose message is `[object Object]` gets fixed | "This one isn't in any book." | 3 |

(099 is kept apart on purpose, like keepsakes in `gifts.js`: no set, hidden until caught, and never counted in "of N".)

---

## 3. Detection (`src/main/bugdex/detect.js`)

Pure. It is the **only** place output text is read, the same rule as `flaky.parse`.

### 3.1 Gates, before any regex

1. **Only failures.** For a Bash/PowerShell result, either `item.isError === true`, or the command is a test command (`xp.classifyCommand === 'tests'`) and `flaky.readRun(...)` says it failed. A **masked** command (`flaky/ids.js masked()`: a pipe, `|| true`, `; echo`) that isn't a test with a readable summary is skipped, because its exit code lies.
2. **Not background.** `item.background` (stream.js:118) is skipped, since its result only says the command started.
3. **Not a reader.** The first word of `normalizeCmd(cmd)` decides. These print other people's errors: `grep rg ag ack cat type less more head tail awk sed find ls dir tree echo printf Get-Content Select-String gc sls`, `git (log|show|diff|grep|blame|status)`, `gh (run view|pr view|issue view|api)`, `jq`, `bat`. A non-zero exit from these is no bug.
4. **Not a probe.** `test -[efd]`, `[ -f`, `which`, `where`, `command -v`, `Test-Path`, `Get-Command` and `ls <x> 2>/dev/null` fail on purpose (the answer is "not there"), so they are skipped.
5. **Bounds**, as in flaky: ANSI and control characters stripped (`ids.ANSI_RE`), lines clipped to 500 characters, output clipped to the **last 64 KB**, and only the last **200 lines** scanned. Patterns use `[ \t]`, never `\s` across lines. Target: under 5 ms on 64 KB. A fixture with 5,000 blank lines and one 1 MB line must stay under 20 ms.

### 3.2 Precedence

Every signature has a **tier**:
- **Tier 1**: specific (`nullfish`, `port-squatter`, a specific TS code).
- **Tier 2**: family generic (`shapeshifter-shrimp` for any TypeError, `type-tangle`, `rusty-nautilus`).
- **Tier 3**: umbrella (`collapsed-castle`, `lint-louse` by command, `red-snapper`, `beached-whale`).

Scan the window, collect `(tier, lineIndex, species)` hits, and pick the **lowest tier**. On a tie, pick the **last line**, because the last error printed is usually the cause; the summary lines below it never match. That is why "Build failed with 1 error" (tier 3) loses to the `Could not resolve "./x"` above it (tier 1, `stray-module-minnow`).

**Command-kind species.** `commandKind(cmd)` → `'tests' | 'lint' | 'typecheck' | 'build' | 'install' | 'git' | 'run'`:

```js
const LINT_CMD = /\b(eslint|(npm|pnpm|yarn|bun)[ \t]+(run[ \t]+)?lint\b|ruff([ \t]+check)?|flake8|pylint|golangci-lint|cargo[ \t]+clippy|stylelint|biome[ \t]+(check|lint)|rubocop|prettier[ \t]+--check)/i;
const TYPE_CMD = /\b(tsc|vue-tsc|(npm|pnpm|yarn|bun)[ \t]+(run[ \t]+)?(typecheck|type-check|tsc|check-types)|mypy|pyright|basedpyright)\b/i;
const BUILD_CMD = /\b((npm|pnpm|yarn|bun)[ \t]+(run[ \t]+)?build|vite[ \t]+build|next[ \t]+build|webpack|esbuild|rollup|cargo[ \t]+(build|check)|go[ \t]+build|dotnet[ \t]+build|msbuild|gradlew?[ \t]+(build|assemble)|mvn[ \t]+(package|compile|install)|make\b|cmake[ \t]+--build)/i;
const INSTALL_CMD = /\b((npm|pnpm|bun)[ \t]+(i|install|ci|add)|yarn([ \t]+(install|add))?$|pip3?[ \t]+install|uv[ \t]+(sync|add|pip[ \t]+install)|poetry[ \t]+(install|add|lock)|cargo[ \t]+(add|update|fetch)|go[ \t]+(get|mod[ \t]+(tidy|download))|bundle([ \t]+install)?|composer[ \t]+(install|require))\b/i;
```

A failing `lint` command with no tier-1/2 hit becomes `lint-louse`. A failing `typecheck` command with any `error TS\d{4}` but no tier-1 code becomes `type-tangle`. A failing `build` becomes `collapsed-castle`. A failing `tests` run becomes `red-snapper`.

### 3.3 Signatures (in table order inside each tier)

All are case-sensitive unless marked `/i`. `lang` sets the form recorded on a catch.

```js
// ---- tier 1: specific
['nullfish',        /\bTypeError:[ \t]+(Cannot read propert(y|ies) of (undefined|null)|Cannot set propert(y|ies) of (undefined|null)|(undefined|null) is not an object|Cannot destructure property)/, 'js'],
['nullfish',        /\bAttributeError:[ \t]+'NoneType' object has no attribute/, 'py'],
['nullfish',        /\bjava\.lang\.NullPointerException\b|\bSystem\.NullReferenceException\b|\bkotlin\.KotlinNullPointerException\b/, 'jvm'],
['missingno',       /\bTypeError:[ \t]+undefined is not a function\b|^(Uncaught[ \t]+)?(Error:[ \t]+)?\[object Object\][ \t]*$/, 'js'],
['wonky-whelk',     /\b(IndentationError|TabError):/, 'py'],
['ouroboros-eel',   /RangeError:[ \t]+Maximum call stack size exceeded|\bRecursionError:|thread '[^']*' has overflowed its stack|java\.lang\.StackOverflowError|fatal error: stack overflow|goroutine stack exceeds/, null],
['off-by-one-octopus', /\bIndexError:[ \t]+\w+ index out of range|index out of range \[\d+\]|index out of bounds: the len is|ArrayIndexOutOfBoundsException|IndexOutOfRangeException|RangeError:[ \t]+Invalid array length/, null],
['broken-promise-prawn', /UnhandledPromiseRejection|Unhandled promise rejection|unhandledRejection/, 'js'],
['heap-leviathan',  /JavaScript heap out of memory|FATAL ERROR:.*Allocation failed|\bMemoryError\b|java\.lang\.OutOfMemoryError|fatal error: runtime: out of memory|memory allocation of \d+ bytes failed/, null],
['segfault-squid',  /Segmentation fault|\bSIGSEGV\b|signal 11\b|exit (code|status) (139|-1073741819|3221225477)|0xC0000005|Access violation/, null],
['nil-gopherfish',  /panic: runtime error: invalid memory address or nil pointer dereference/, 'go'],
['knotted-eels',    /fatal error: all goroutines are asleep - deadlock!|deadlock detected|\bDeadlockError\b/, null],
['race-wraith',     /WARNING: DATA RACE|ThreadSanitizer: data race/, null],
['panicked-prawn',  /thread '[^']*' panicked at|called `(Option|Result)::unwrap\(\)` on an? `(None|Err)/, 'rust'],
['borrowing-hermit',/error\[E0(499|502|505|506|382|597|716|503|373)\]/, 'rust'],
['keyless-krill',   /^KeyError:[ \t]/, 'py'],
['circular-sea-snake', /ImportError:[ \t]+cannot import name .* \(most likely due to a circular import\)|partially initialized module/, 'py'],
['zero-dab',        /\bZeroDivisionError:|DivideByZeroException|attempt to divide by zero|integer divide by zero/, null],
['stray-module-minnow', /Cannot find module '|Module not found: (Error: )?Can't resolve|ERR_MODULE_NOT_FOUND|ModuleNotFoundError: No module named|ImportError: No module named|Could not resolve "[^"]+"|cannot find package|no required module provides package|unresolved import `|could not find `[\w-]+` in/, null],
['tangled-tree-crab', /\bERESOLVE\b|unable to resolve dependency tree|Could not resolve dependency|ResolutionImpossible|conflicting dependencies|failed to select a version for|version solving failed|No matching distribution found/, null],
['old-salt',        /Unsupported engine|The engine "node" is incompatible|requires (a )?(node|python)( version)? ?[>=]|go: go\.mod requires go >=|rustc [\d.]+ is not supported/i, null],
['port-squatter',   /\bEADDRINUSE\b|address already in use|Only one usage of each socket address|port \d+ is (already )?in use/i, null],
['closed-clam',     /\bECONNREFUSED\b|Connection refused|ConnectionRefusedError|actively refused it/, null],
['snapped-line',    /\bECONNRESET\b|socket hang up|Connection reset by peer|\bEPIPE\b/, null],
['nameless-buoy',   /\bENOTFOUND\b|getaddrinfo E|Name or service not known|Could not resolve host|No such host is known/, null],
['cert-cuttlefish', /UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|CERT_HAS_EXPIRED|certificate verify failed|x509: certificate/, null],
['border-crab',     /blocked by CORS policy|No 'Access-Control-Allow-Origin' header/, null],
['slowpoke-snail',  /\bE?TIMEDOUT\b|\bESOCKETTIMEDOUT\b|Exceeded timeout of \d+ ?ms|\bTimeoutError\b|context deadline exceeded|ReadTimeout(Error)?\b|504 Gateway Time-?out/, null],
['meltdown-medusa', /HTTP\/[\d.]+ 5\d\d|\b50[0234] (Internal Server Error|Bad Gateway|Service Unavailable)|Request failed with status code 5\d\d/, null],
['lost-parcel-crab',/HTTP\/[\d.]+ 404|\b404 Not Found\b|Request failed with status code 404|The requested URL returned error: 404/, null],
['clingy-barnacle', /\bEBUSY\b|being used by another process|resource busy or locked/, null],
['locked-limpet',   /\bE(ACCES|PERM)\b|Permission denied|PermissionError|Access is denied|UnauthorizedAccessException/, null],
['overstuffed-pufferfish', /\bENOSPC\b|No space left on device|\bEMFILE\b|[Tt]oo many open files/, null],
['mixed-up-mussel', /\bE(ISDIR|NOTDIR|EXIST)\b|IsADirectoryError|NotADirectoryError|FileExistsError/, null],
['shell-less-hermit', /\bENOENT\b|No such file or directory|FileNotFoundError|The system cannot find the (file|path) specified|Cannot find path '.*' because it does not exist/, null],
['two-headed-crab', /^CONFLICT \([\w\/ -]+\):|Automatic merge failed|^error: could not apply [0-9a-f]{7,}|Pulling is not possible because you have unmerged files/, 'git'],
['bounced-bottle',  /! \[rejected\]|\(non-fast-forward\)|Updates were rejected because/, 'git'],
['gatekeeper-goby', /husky - [\w-]+ hook exited with code|pre-commit hook .*fail|hook declined/i, 'git'],
['lockfile-lobster',/index\.lock': File exists|Another git process seems to be running/, 'git'],
['mirror-mullet',   /\d+ snapshots? failed|Snapshot `[^`]+` mismatched|toMatch(Inline)?Snapshot/, null],
['assertive-lobster', /\bAssertionError\b|expect\(received\)|assert(ion)? failed|assert_eq!|assertion `left == right` failed|^E[ \t]+assert /, null],
// TS specific codes
['mismatched-mantis',    /error TS(2322|2345|2741|2739|2740|2769):/, 'ts'],
['missing-fin-pipefish', /error TS(2339|2551|2353):/, 'ts'],
['undeclared-urchin',    /error TS(2307|7016|2305):/, 'ts'],
['anything-anemone',     /error TS(7006|7005|7031|7053|18046):/, 'ts'],
['optional-oarfish',     /error TS(2531|2532|2533|18047|18048|18049):/, 'ts'],
['hinted-hermit',        /: error: .* \[[a-z-]+\]$| - error: /, 'py'],   // only when TYPE_CMD matches
// ---- tier 2: family
['shapeshifter-shrimp',  /\bTypeError:[ \t]+\S/, null],
['nameless-nudibranch',  /\bReferenceError:[ \t]+\S+ is not defined|\bNameError:[ \t]+name '/, null],
['syntax-slug',          /\bSyntaxError:[ \t]|Unexpected token/, null],
['attribute-anglerfish', /\bAttributeError:[ \t]/, 'py'],
['off-value-oyster',     /^ValueError:[ \t]/, 'py'],
['type-tangle',          /error TS\d{4}:/, 'ts'],
['rusty-nautilus',       /^error(\[E\d{4}\])?:[ \t]/, 'rust'],   // only when the command is cargo/rustc
// ---- tier 3: umbrella (command kind or source)
['collapsed-castle', /Build failed with \d+ errors?|Failed to compile|error during build|compiled with \d+ errors?|error: could not compile `|BUILD FAILED|FAILURE: Build failed|make: \*\*\* .* Error \d/, null],
```

**Server logs.** The same table runs over `fixDraft(id).lines`. No hit means `beached-whale`.

**CI.** Phase 1 uses `red-tide` only. Phase 3 classifies by check names in `pr.failing`: `/lint|eslint|ruff|clippy|prettier|format/i` → `lint-louse` (form `ci`), `/type|tsc|mypy|pyright/i` → `type-tangle` (ci), `/deploy|vercel|netlify|pages/i` → `sunken-deploy`, and an OS matrix with exactly one OS failing → `matrix-hydra`. Three or more distinct failing checks, fixed together, means `the-kraken`. If the build-fix sheet already fetched a job log (`wiring/startfrom.js material()`), `detect.classify` may refine to a tier-1 species with form `ci`. Shellby never fetches logs just for the Bugdex.

### 3.4 Fingerprint

```js
fingerprint(species, line, output) =
  sha1(`${species}|${norm(messageOf(line))}|${fileBase(output)}`).slice(0, 12)

norm(s) = s.toLowerCase()
  .replace(/(?:[a-z]:)?[\\/][^\s:'"()]+/g, p => basename(p))  // paths → basename
  .replace(/0x[0-9a-f]+|\b[0-9a-f]{7,40}\b/g, '#')             // hex, shas
  .replace(/\d+/g, '#')                                         // line:col, counts, ports
  .replace(/(['"`])[^'"`]{40,}\1/g, '"…"')                      // long literals
  .replace(/\s+/g, ' ').trim().slice(0, 200)

fileBase(output) = basename of the first stack frame / tsc location / "File \"…\"" in the
  window that isn't under node_modules, site-packages, /rustc/, GOROOT, <anonymous> or node:internal
```

`npm test` failing on `auth.spec.ts` with `Cannot read properties of undefined (reading 'user')` therefore fingerprints the same way at any line number, on any port, from any folder or PC. **Only the hash is kept.**

---

## 4. Catch rules and anti-farming (`src/main/bugdex/lifecycle.js`, `cheats.js`)

### 4.1 The default catch, for B and T sources

An open encounter `E` in project `P` is caught by a later result `R` when **all** of these hold:

1. `R` ran in a Shellby tab whose `projectOf(cwd).id === E.project`. A copy and the checkout count as the same project.
2. **Same command, or broader.** `cmdKey(R) === E.cmdKey`, or `normalizeCmd(R)` equals `normalizeCmd(E)` with trailing arguments removed at a token boundary. So `npm test -- auth` failing and `npm test` passing counts. The reverse does not: a narrower run can't prove the rest.
3. **It passed.** `!R.isError` and not masked. A test command passes when `flaky.readRun` says ok. Masked non-tests never catch.
4. **The signature is gone.** `detect.classify(R output)` finds nothing, ignoring the success gate, and specifically nothing matching `E.fp`.
5. **Tree check.** Snapshot at `R`'s `tool` item and again at its result, as flaky does (`snapshotWithin`). If start ≠ end, the run is dropped. Then `R.tree !== E.failTree`, unless the species allows a remedy (§4.3).
6. **The diff passes `cheats.judge`** (§4.4).
7. `now - E.at <= ENCOUNTER_TTL` (24 h, the same as `xp.RED_FOR`).

**Snapshot cost.** A snapshot is taken only at the `tool` of a command whose cmdKey (or prefix) matches an open encounter, looked up in memory by lower-cased root, so most commands cost nothing. The encounter's `failTree` is snapshotted **at the failing result**, because Shellby doesn't snapshot every command at start. If an edit raced in, `failTree` already contains the fix, the pass then sees the same tree, and **no catch** happens. That is a safe miss, never a false catch. For test commands, `c.tree` from `flakyTree` is reused when present.

### 4.2 Engage

A `tool` item with `filePath` in a tab in the same project after `E.at` sets `E.engaged = true`. So does a Bash command that changes the tree (seen at pass time). In the UI this shows as "Claude's on it". The hard requirement is the tree change in §4.1.5. Engage is what allows a **remedy** catch.

### 4.3 Remedies (same-tree catches)

Some fixes are not code: `npm install`, killing a stray process, starting a database, clearing a cache. A species with `remedies` may be caught on **the same tree** if, between `E.at` and `R`, a **successful** remedy command ran in a tab in that project:

| Species | Remedy commands (regex over `normalizeCmd`) |
|---|---|
| stray-module-minnow | `INSTALL_CMD` |
| port-squatter, clingy-barnacle | `taskkill\b`, `kill( -9)? \d`, `Stop-Process`, `npx kill-port`, `fuser -k`, `lsof .* \| xargs kill` (the pipe is fine here) |
| closed-clam | `docker( compose)? (up|start)`, `(brew )?services? \w+ start`, `systemctl start`, `pg_ctl start`, `Start-Service`, `redis-server`, `mongod` |
| lockfile-lobster | `rm .*index\.lock`, `Remove-Item .*index\.lock`, `del .*index\.lock` |
| cache-ghoul (only source of it) | `rm -rf .*(node_modules/\.cache|\.next|\.turbo|\.parcel-cache|__pycache__|\.pytest_cache|target)`, `npm cache clean`, `cargo clean`, `go clean -cache`, `--no-cache` |
| overstuffed-pufferfish | the cache list above, plus `docker system prune` |

A same-tree catch through a remedy **never** counts as golden (§5).

**Reveal (phase 3).** A Port Squatter or Clingy Barnacle caught through a *kill* remedy is recorded as **066 Zombie Process** instead ("It was a Zombie Process all along!"). Any species caught through a cache remedy on the same tree is recorded as **065 Cache Ghoul**.

### 4.4 `cheats.judge({ files, patchOf, encounter, pass })` → `{ ok } | { ok: false, reason }`

Pure, over `changedFiles(root, failTree, passTree)` plus patches fetched **only for the files the rules need** (test files, files with suppressions). Patches are capped at 400 KB (`changes.patchFor`).

| reason | Rule |
|---|---|
| `no-change` | trees equal and no remedy applies |
| `revert` | `passTree` equals a tree seen in this project **before** `E.at`: the turn-start trees (`turnStarts`, wiring/sessions.js) and the flaky `runs[].tree`, kept in memory as a ring of 30 per project. Undo is not a fix, and this is what stops break-and-undo farming. |
| `deleted-tests` | any `D` status on a path matching `TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|test_[^/]+\.py$/i` |
| `skipped` | a `+` line in a test file adds `\.(skip|todo)\(|\bxit\(|\bxdescribe\(|\bit\.only|@pytest\.mark\.(skip|xfail)|t\.Skip\(|#\[ignore\]|\[(Fact|Test)\(Skip|@Disabled|@Ignore` |
| `suppressed` | a `+` line anywhere adds `@ts-ignore|@ts-expect-error|@ts-nocheck|as any\b|eslint-disable|# type: ignore|# noqa|#\[allow\(|//nolint|@SuppressWarnings|pragma warning disable` (for kelp, lint-louse, rusty-nautilus and hinted-hermit, and for every species when it's the only change) |
| `fewer-tests` | for test species: `pass.passed < fail.passed + fail.failed.length` when `flaky.parse` gave counts on both runs, i.e. tests vanished |
| `snapshots-only` | mirror-mullet: the pass command has `-u|--update-snapshot|--snapshot-update|--ci=false -u`, or every changed file is `*.snap` / `__snapshots__/` |
| `bigger-number` | slowpoke-snail and heap-leviathan: every changed `+`/`-` line pair differs only in a number (a timeout or memory limit raised), or only adds `--max-old-space-size` / `NODE_OPTIONS` |
| `insecure` | cert-cuttlefish: adds `rejectUnauthorized:\s*false|NODE_TLS_REJECT_UNAUTHORIZED|verify\s*=\s*False|--insecure|\s-k\s|InsecureSkipVerify:\s*true` |

A rejected candidate leaves the encounter **open**. Claude can still do it properly before the TTL. It is logged at info level (`bugdex: no catch (skipped)`), and the panel's "On the loose" row says "Not like that: tests were skipped", so the reason is never silent.

### 4.5 Limits

| Constant | Value | Why |
|---|---|---|
| `ENCOUNTER_TTL` | 24 h | matches `RED_FOR` |
| `MAX_OPEN` | 40 open encounters (oldest drop) | bounded state |
| One encounter per `(project, fp)` | a re-observation refreshes `at`, keeps `firstAt` | no duplicates |
| `CATCH_COOLDOWN` | same `(project, fp)` counted once per **12 h** | break and fix loops |
| `PAY_COOLDOWN` | same `(project, fp)` pays XP once per **7 days** | as above |
| `SPECIES_DAY_CAP` | 3 counted catches per species per day | more are "seen again" only |
| `DAY_CAP` | 12 counted catches per day overall | |
| XP falloff | `xp.award` perHour (§7) | already exists |
| `ESCAPE_MS` | 3 days | §1 |
| One catch per result | if a pass would close several encounters (one command, several fps), the highest-rarity one is the catch and the rest close as "caught along with" (counted, no XP, no moment) | no multi-pay |

---

## 5. Forms, evolution and per-entry stats

**Forms** are stored on the species entry as the set of forms ever earned. Each catch event gets one primary form for the moment.

| Form | When | Badge |
|---|---|---|
| **First try** | the first re-run after `engaged` passes (no failed reruns of `E.cmdKey` in between) | 🎯 |
| **Swift** | caught within 5 min of `E.firstAt` | ⚡ |
| **Golden** | First try **and** Swift, and not a remedy catch. Palette shifted to gold by `art.golden()`. | ✦ gold |
| **Nocturnal** | caught between 00:00 and 05:00 local | ☾ |
| **Spectral** | a `wreck` species caught while `seasons.isActive('halloween')`. Palette goes translucent green (Haunted Shell tie-in, §8.4). | 👻 |
| **Shiny** | `rand() < 1/64` (`rand` passed in, as `gifts.dig` does). Hue-rotated palette. | ✨ |
| **Language** | the `lang` of the signature or, failing that, the most-changed file extension in the diff (`js`, `ts`, `py`, `rust`, `go`, `jvm`, `cs`, `rb`, `php`, `git`, `ci`) | small chips: "Caught in JS · Python" |
| **For good** | no escape within `ESCAPE_MS` after the catch, settled lazily at view time | 🛡 |

**Evolution.** Stages come from `caught`: I at 1, II at 5, III at 15, and a Master crown at 40.
- Phase 2 gives all species `art.staged(art, stage)`: stage II adds a one-pixel outline in the rarity colour, stage III adds a sparkle crown row.
- Twelve starters get their own evolution names in `evolves`, for example:
  - Shapeshifter Shrimp → Morphing Prawn → Polymorph Lobster
  - Nullfish → Voidfish → Abyssal Nullshark
  - Shell-less Hermit → Squatter Hermit → Homeowner Hermit
  - Red Snapper → Ripening Snapper → Evergreen Snapper
  - Two-Headed Crab → Three-Way Crab → Octopus Merge
  - Syntax Slug → Grammar Sea Hare → Linguist Nudibranch
  - Stray Module Minnow → Module Mackerel → Monorepo Marlin
  - Type Tangle → Kelp Knot → Generic Grouper
  - Port Squatter → Port Warden → Harbour Master
  - Beached Whale → Refloated Whale → Humpback of Uptime
  - Flaky Phantom → Poltergeist → Banshee
  - Collapsed Castle → Rebuilt Keep → Citadel
- An evolution is a moment of its own: `life:moment` with eyebrow "Evolved".

**Per-entry stats:**
- `caught`: summed across PCs
- `seen`: encounters opened
- `first` / `last` catch times
- `fastest` fix in ms (`catchAt - E.firstAt`)
- `escapes`
- `forms` and `langs`
- `projects`: up to 12 project ids; names resolved locally for the detail view ("First caught in **shellby**")

---

## 6. Source-specific catches (wiring)

### 6.1 Bash and test path (`wiring/sessions.js` → `wiring/bugdex.js`)

- On `tool` (Bash/PowerShell, not background): `d.bugdex?.commandStart({ tabId, id: item.id, command: item.detail, dir })` returns a tree promise, or null when nothing is open for that root and command. Store it on the pending entry as `bugTree`.
- On `tool` with `item.filePath`: `d.bugdex?.wrote(tabId, item.filePath)` (engage).
- On a paired `tool_result`: `d.bugdex?.commandResult(c, item, tail)`. This is async, never awaited, and has its own try/catch, like `noteTestRun`. It runs **after** `noteTestRun` is kicked off, so both read the same `c.tree`.

### 6.2 Dev server

`wiring/projects.js`:
- `devServers.on('crashed', v => d.bugdex?.serverCrashed(v, d.devServers.fixDraft(v.id)?.lines || []))` opens an encounter with `source: 'server'`, `key: v.id`, the species from detect (falling back to `beached-whale`), and `project` from `projectOf(v.root)`.
- `devServers.on('up', v => d.bugdex?.serverUp(v))` arms a 60 s `stayUp` timer for that id, and only if the encounter was engaged.
- A `'crashed'` inside the timer cancels it, the encounter stays open, and `seen` goes up.

In `timetrack.js onResult`, next to `d.devServers?.onTabDone`: `d.bugdex?.turnEnded(tabId, item)`. If `item.ok && !item.interrupted` and a server in `d.devServers.view().servers` has `fixTabId === tabId`, the encounter for that server is marked `engaged`.

Important: `restart()` clears `fixTabId` (service.js ~291-294), so the Bugdex keeps **its own** `serverId → encounter` map rather than reading `fixTabId` at 'up' time.

Catch: `up` + 60 s quiet + engaged + within 30 min of the fix turn ending. A server that comes back up with no Claude turn (you just pressed Restart) is not a catch.

### 6.3 CI

`wiring/github.js onCiEvent`:
- `failed` → `d.bugdex?.ciFailed(pr)`: key `pr.key`, project resolved from the repo via `d.projects.localRepos()` (as `startfrom cloneOf` does), and the check names and sha kept in memory only.
- `fixed` → `d.bugdex?.ciFixed(pr)`.

**Shellby must have taken part** since the failure, through one of these:
- (a) `wiring/startfrom.js send()` returned ok for `kind === 'build'` and that key, which calls `d.bugdex?.ciEngaged(key)`; or
- (b) a successful `git push` in a Shellby tab (the `ship` path at sessions.js:127-128) or `pushHome` in a project whose `projectOf().remote` matches `pr.repo` (compare with `gitinfo.normalizeRemote`'s format), after `failedAt`.

Without that, a red to green that you or a colleague fixed is not a catch. `green-light` and `buildsFixed` still count as before.

### 6.4 Merge conflict

- **Bring it home**: in `ipc/repo.js bringTabHome`, after `worktrees.bringHome`, call `d.bugdex?.homeResult(tabId, w, merged)`. `merged.conflict` opens an encounter keyed `home:${w.root}|${w.branch}`. A later `merged.ok && merged.merged` for the same key, with at least one ended turn in that tab in between (`turnEnded`), catches it.
- **Bash**: the CONFLICT signature opens an encounter with `cmdKey: null` and `conflictFiles` (basenames, in memory only). The catch looks for a successful `git commit` / `git (merge|rebase|cherry-pick) --continue`, then runs `git ls-files -u` (must be empty) and `git grep -l -e '^<<<<<<< ' -e '^>>>>>>> ' -- <files>` (must find nothing). Both go through `worktrees.git` with `{ timeout: 5000 }`.
- An intervening `git (merge|rebase|cherry-pick) --abort`, `git reset --hard` or `git checkout -- .` **closes the encounter as fled**. No escape is counted, since you chose not to fight.

### 6.5 Secret push gate

`secretGate` with `response === 1` calls `d.bugdex?.secretSpotted(root, kinds)`. Only the finding kinds (`secretscan.describe` without the location) feed the fingerprint.

`pushHome` with `stopped === null` and `r.ok && r.pushed` calls `d.bugdex?.pushedClean(root)`, which catches `leaky-clam` if there's an open encounter for that root and at least one turn ran in a tab in that project in between. "Push anyway" (`response === 0`) closes the encounter as fled.

### 6.6 Flaky and audit

`noteTestRun` (progress.js:266): `for (const id of r.fixed)` → `d.bugdex?.flakyFixed(project, id, flaky.findTest(...))`. That catches `flaky-phantom`, or `heisenbug` if the row's flake history covers at least 5 flakes over at least 3 days. `r.flakes` on a test previously caught as a phantom counts as an escape.

`checkedUp` (progress.js:151): `r.patched` → `d.bugdex?.auditPatched(project)`. The encounter for `barnacled-anchor` was opened when a previous checkup recorded `status: 'issues'`.

---

## 7. Rewards

**XP** (`src/main/xp.js AWARDS`; `LOG_KINDS` picks them up automatically):

```js
catch:  { xp: 10, perHour: 6, label: 'Caught a bug', way: 'Fixes a bug and catches it for the Bugdex', claude: true },
newbug: { xp: 40, perHour: 3, label: 'A new bug for the Bugdex', way: 'Catches a kind of bug the Bugdex hasn\'t caught yet', claude: true },
```

- The first catch of a species pays `newbug`, labelled `Caught a Segfault Squid (rare)`. Later catches pay `catch`.
- A finished habitat pays `treasure` (as a finished finds set does in `life.js credit`).
- No pay inside `PAY_COOLDOWN`.
- `catch` is deliberately small because the same pass often also pays `fixed` (40) or `tests` (25).

**Achievement stats** (`wardrobe/achievements.js`):
- `INCREMENTS`: `'bug-caught': 'bugsCaught'`, `'habitat-done': 'habitatsDone'`, `'legendary-bug': 'legendaryBugs'`, `'golden-catch': 'goldenCatches'`
- `MAXIMA`: `'bug-species': 'bugSpecies'`, `'ghost-species': 'ghostSpecies'`
- Add all of them to `COUNTERS`.

| id | Name | Icon | Stat / goal | Rewards (new pack `src/wardrobe/bug-hunter.json`) |
|---|---|---|---|---|
| `gotcha` | Gotcha! | 🫙 | bugsCaught 1 | `bug-net` (held), `specimen-jar` (shell cargo) |
| `field-notes` | Field Notes | 📓 | bugSpecies 10 | `magnifier` (face) |
| `naturalist` | Naturalist | 🌿 | habitatsDone 1 | `terrarium` (tank decor) |
| `fix-em-all` | Field Researcher | 🧢 | bugSpecies 40 | `trainer-cap` (hat, "Field Researcher's Cap") |
| `exterminator` | Pest Control | 🧯 | bugsCaught 100 | `bug-sprayer-pack` (shell) |
| `golden-touch` | Golden Touch | ✦ | goldenCatches 1, hidden | `golden-net` (held) |
| `ghost-whisperer` | Ghost Whisperer | 🏮 | ghostSpecies 3 | `ghost-jar` (held) |
| `heisenberg` | Uncertainty Principle | 🥽 | legendaryBugs 1, hidden | `quantum-goggles` (face) |

Each item gets `"unlock": { "achievement": "<id>" }`. `test/packs.test.js` checks both directions, and `npm run packs` validates.

**Needs** (`src/main/needs.js`): add `'bug-caught': { group: 'work', snack: 'plankton', n: 1, perDay: 3, claude: true }` next to `'ci-fixed'` (needs.js:85).

**Week in review**:
- `weekly.js KINDS` gets `'caught'` and `'newbug'`.
- `weekSummary` passes `caught: t.caught, newBugs: t.newbug`.
- `week-card.js` gets `c.caught ? `🫙 ${plural(c.caught, 'bug')} caught${c.newBugs ? ` (${c.newBugs} new to the Bugdex)` : ''}` : null`, next to the flaky lines (week-card.js:46-47).
- Recorded through `noteWeek('caught')` / `noteWeek('newbug')` from the wiring. They are not in `WEEK_XP_KINDS`, so they aren't counted twice.

---

## 8. What you see

### 8.1 The catch moment (critter)

On brand: **he scoops it into a tide-pool jar.**

1. `d.life.presentJar(card, line)` is a new method in `life.js` that reuses the `present()` plumbing (`presenting`, `presentDone`, `later(PRESENT_MS)`). If he's mid-present (a dig), it queues **one** jar. It never interrupts.
2. `critter:bit { bit: 'catch', ms: 2600 }`: a new `body.bit-catch` in `critter/life.css` (claw lunge forward 3 px, then a hop back, built like `present-bounce`).
3. `critter:prop { prop: 'jar' }`: a new entry in `critter/life.js DRAW` and `ART.jar` (a glass jar with a cork). The bug sprite drops in, the cork pops on, and the jar **wobbles 1, 2 or 3 times** by rarity (`--wobbles`, set from `rarity`). Legendary adds the existing `sparkle` prop and `critter:burst`.
4. `critter:hold { pixels, palette }`: the jar with the creature inside, composed in main by `bugdex/art.jarArt(species, form)`. That's a pure function: a fixed 11×11 jar frame with the species art scaled into a 7×7 box (nearest neighbour), golden/shiny/spectral palette applied. He holds it up for `PRESENT_MS`.
5. Speech: `bugdex.catchLine(species, { isNew, form, rand })`, 24 characters or fewer, as in `gifts.foundLine`:
   - new: "new one for the dex!", "gotcha!!"
   - repeat: "in the jar!", "gotcha"
   - rare: "a rare one!!"
   - legendary: "LEGENDARY!!"
   - golden: "golden catch!"
6. Gates:
   - `sayText` keeps its focus and quiet-hours gates.
   - During a focus session: the jar only, no speech, no sound.
   - Repeat catches of a known species: at most one moment per 10 min, the rest silent (counted in the panel).
   - Reduced motion: no lunge or wobble, just the held jar.
   - Sound: existing `sparkle`, plus a new `clink` in `critter/sound.js` (`MIN_GAP_MS.clink = 1500`).

**Toasts** (`d.notify`) only fire when the panel isn't focused, and only for:
- a **new species**: "New to the Bugdex: Segfault Squid. Caught in shellby after 14 min. Rare!", tone `celebrate`
- a **legendary**
- an **evolution**
- a **finished habitat**

A click opens the panel on `bugdex` with the entry selected (`panel:view 'bugdex'` + `bugdex:focus { id }`). Repeat catches never toast.

### 8.2 The panel: a new **Bugdex** tab

**Decision: its own view (`bugdex`), a tab in the Shellby strip next to Finds, not a section inside Finds.**
- Finds needs no Claude and must stay whole in just-the-crab mode. The Bugdex is only Claude work, and is hidden in that mode.
- Its model (seen, caught, on the loose, stats, forms, stages) doesn't fit the shelf's owned-or-not tiles, and the Finds page is already full (hero, sets, detail, grid).
- It reuses the shelf's components (`fd-tile`, `rarity-*`, `fd-sets` dots, the `art()` / `fit()` helpers in `together.js`), so it looks like a sibling.

Files:
- `panel.html`: a new `<main class="view view-bugdex" id="bugdexView">`, plus a `<button data-goto="bugdex">Bugdex <span class="n bd-count"></span><i class="dot-badge bd-badge" hidden></i></button>` in **every** `.shellby-tabs` nav (there are seven copies, around panel.html:541, 719, 750, 848, 890...).
- `nav.js`: a palette entry next to line 257: `{ icon: '🫙', title: 'Shellby: Bugdex', sub: 'Every kind of bug Claude has fixed for you', keys: 'bugdex bugs errors caught collection pokedex', run: go('bugdex') }`.
- `crabonly.css` hides the tab and its buttons.
- `src/renderer/panel/bugdex.js` + `bugdex.css` hold the renderer. Move `art()` / `fit()` into `src/renderer/panel/pixel-art.js` (or `SB.Sprite`) so both pages share them.

Layout:
1. **Hero**: the favourite catch (the rarest by default, as `gifts.favourite`), "**14 of 66 caught · 22 seen · 57 jars filled**", and a sub-line: "Every kind of bug Claude fixes for you goes in a jar. Seeing one isn't enough: it has to be fixed."
2. **On the loose** (hidden when empty): up to 6 silhouettes with "TypeError spotted in shellby 12 min ago · Claude's on it". A refused catch shows its reason here ("Not like that: a test was skipped"). **Open the tab** (if the tab is still open, `tabId` in memory) is the only action. No "fix this" prompt, because no error text is kept (§9).
3. **Habitats**: `fd-sets`-style rows with icon, name, dots and ✓. A habitat shows "N new" if species were added after it was finished.
4. **Filter chips**: All · Caught · Seen · one per habitat.
5. **Grid**: dex number `#009`, art (colour, silhouette or `???`), name, rarity or "Seen", stage ring, form badges, ×count pill, `new` pill.
6. **Detail**:
   - big art at its current stage
   - `#009 · The Burrows · io`
   - name, plus the next evolution's name greyed with "3 more catches to evolve"
   - blurb, or the hint when not caught
   - "First caught 3 Oct in shellby · caught 7 times · fastest 1m 42s · got away once"
   - form badges and language chips
   - "Make this his favourite"

### 8.3 Beach and Tank (phase 3)

- **Tide pool** (`beach.js`): a rock pool at the far end of the sand, past the last castle, sized by caught species (4 to 12 art pixels of water). Up to 8 of the most recent species swim in it as 3×3 micro sprites (`art.micro(species)`, like sticker micros). `beach.view` takes `bugState`. `beach-paint.js` paints the pool and bobs the micros. `news` counts newly caught species.
- **Tank**: a `'jar'` category in `tank.js library()` (tank.js:38 lists categories). Every caught species can be placed as a specimen jar, as finds are placed.

### 8.4 Haunted Shell tie-in

- `wreck` species catch with the **Spectral** form during Spooky Season (`seasons.isActive('halloween')`, the same season gate `src/wardrobe/haunted-shell.json` uses).
- The jar moment adds the `wisps` effect for ghosts.
- If he's wearing **Ghost Buddy** (`ghost-buddy`, shell slot), it bobs (`critter:prop 'ghost-cheer'`).
- `ghost-whisperer` rewards the `ghost-jar`, in the Bug Hunter pack with an achievement gate, **not** season-gated, so `packs.test.js` stays simple.
- `ghostbuster` / `proton-pack` (flakesFixed) stay as they are.

---

## 9. Privacy and security

- **Kept**: species id, a 12-hex fingerprint, project id (and its name locally, for display), timestamps, durations, tree hashes for open encounters (local only), and the form flags.
- **Never kept or sent**: error text, file paths, commands (only `cmdKey`), check names, log lines. Server logs only pass through `fixDraft().lines`, which are already redacted (`out.redactLines`). Detection never logs what it matched; it logs only `bugdex: spotted <species>`.
- **Synced**: only the per-species table (§10.2). No fingerprints, no open encounters, no project ids or names, no tree hashes.
- **The renderer only ever gets `bugdexView()`**. It has no pixels for unknown species. IPC accepts only `{ id }` that's a known species id (`/^[a-z0-9-]{1,40}$/` and in `BY_ID`), the same rule as `flaky:act`.
- **No prompts.** The Bugdex never writes a Claude prompt, so it adds no prompt-injection surface. "Open the tab" only focuses an existing tab.
- **git calls** (`ls-files -u`, `git grep`, `changedFiles`, `patchFor`): execFile, fixed arguments, timeouts, literal pathspecs. All existing helpers.
- Object keys are species ids from the catalogue, validated. Fingerprints are hex. `__proto__` can never get in.

---

## 10. State, sync and the view

### 10.1 Config keys

- `bugdex: null`: the state below. Add to `config.js` next to `finds` (config.js:59).
- `catchBugs: true`: the switch, next to `flakyTests` (config.js:83). Add it to **both** lists in `ipc/settings.js` (lines 31 and 71).

```jsonc
{
  "v": 1,
  "species": {
    "shell-less-hermit": {
      "byDevice": { "a1b2c3d4": 5, "legacy": 0 },   // catches per PC; caught = sum
      "seen": 9,                                      // encounters opened (max across PCs)
      "first": 1759500000000, "last": 1759900000000,  // first/last catch
      "fastest": 102000,                              // ms, 0 = unknown
      "escapes": { "a1b2c3d4": 1 },                   // per PC, summed
      "forms": ["first-try", "swift", "golden", "nocturnal"],
      "langs": ["js", "py"],
      "projects": ["5b1c0de0a1f2", "9e3a7c21d4b8"],   // ids, max 12 (local only)
      "seenAt": 1759900000000                          // last observed, for "spotted" text
    }
  },
  "habitats": { "burrows": { "doneAt": 1759900000000, "of": 5 } }, // members when finished
  "open": [                                            // local only, max 40, TTL 24 h
    { "species": "shapeshifter-shrimp", "fp": "3fa9c01b77e2", "project": "5b1c0de0a1f2",
      "source": "bash", "key": "9d0e4c1a2b3f", "failTree": "8c1f…", "firstAt": 1759900000000,
      "at": 1759900300000, "engaged": true, "reruns": 1, "refused": "skipped", "lang": "js" }
  ],
  "recent": { "5b1c0de0a1f2|3fa9c01b77e2": { "caughtAt": 0, "paidAt": 0 } }, // local, max 200
  "day": "2026-10-06", "today": 4, "todayBySpecies": { "nullfish": 2 },
  "log": [ { "at": 1759900000000, "species": "nullfish", "form": "swift", "new": false } ], // last 30, local
  "favourite": null,
  "unseen": ["nullfish"],                              // caught since the page was last looked at
  "lastMomentAt": 0
}
```

Normalised on read like `gifts.normalize`: unknown species dropped, numbers clamped, lists bounded.

### 10.2 Sync (`src/main/github/sync.js`)

- `snapshot` adds `bugdex: bugdex.syncable(get('bugdex'))`, which is `{ species: { id: { byDevice, seen, first, last, fastest, escapes, forms, langs } }, habitats: { id: { doneAt, of } } }`. That's about 10 KB, well under `MAX_BYTES`.
- `clean` adds `bugdex: bugdex.normalizeSync(r.bugdex)`, with remote `local` device buckets dropped like `cleanByDevice(..., { keepLocal: false })`.
- `merge` adds `bugdex: bugdex.merge(a.bugdex, b.bugdex)`:
  - per device: `max` (each PC only grows its own count), and `caught = sum`
  - `seen = max`
  - `first = min` (non-zero), `last = max`, `fastest = min` (non-zero)
  - `escapes`: max per device
  - `forms` / `langs`: union
  - habitats: earliest `doneAt`, larger `of`
- `patchFor` adds `bugdex: bugdex.applySync(get('bugdex'), merged.bugdex)`, which keeps the local `open`, `recent`, `log`, `projects`, `unseen` and `favourite`.
- Device id comes from `normalizeXp(get('xp')).device` (the bucket `withDevice` sets), so one PC id is shared with XP.

### 10.3 View (`bugdex.view(state, now, { seasons, names })`)

```jsonc
{
  "caught": 14, "seen": 22, "of": 66, "jars": 57,
  "favourite": "segfault-squid",
  "unseen": ["nullfish"],
  "loose": [ { "species": "shapeshifter-shrimp", "name": "Shapeshifter Shrimp", "project": "shellby",
               "at": 1759900300000, "engaged": true, "refused": null,
               "pixels": [...], "palette": { "*": "#1d2333" }, "tabId": "t-12" } ],
  "habitats": [ { "id": "burrows", "name": "The Burrows", "icon": "🕳️", "have": 3, "of": 5,
                  "done": false, "added": 0, "members": ["shell-less-hermit", "..."] } ],
  "species": [
    { "no": 9, "id": "shell-less-hermit", "state": "caught" /* | "seen" | "unknown" */,
      "name": "Squatter Hermit", "baseName": "Shell-less Hermit", "nextName": "Homeowner Hermit",
      "habitat": "burrows", "type": "io", "rarity": "common", "rarityLabel": "Common",
      "blurb": "...", /* or the hint when not caught */
      "pixels": [...], "palette": {...},       /* staged art; silhouette for seen; omitted for unknown */
      "stage": 2, "toNext": 3,
      "caught": 7, "seenCount": 9, "first": 1759500000000, "fastest": 102000, "escapes": 1,
      "forms": ["swift", "golden"], "langs": ["js", "py"], "firstProject": "shellby",
      "isNew": false, "forGood": true }
  ]
}
```

Only `live` species (`phase <= LIVE_PHASE`) are in `species`, `of` and habitat members. A habitat finished earlier stays in `habitats.doneAt` and shows `added: n` when later phases add members, much as a new Pokémon generation does. Its achievement stat has already counted.

---

## 11. Sample sprites (the `gifts.js` row format)

```js
// #062 Flaky Phantom — the ghost holding a die (palette borrowed from haunted-shell.json ghost-buddy)
{ id: 'flaky-phantom', palette: { w: '#f4f1ea', g: '#c9c4d6', k: '#1a1a22', d: '#ff5d73' },
  pixels: [
    '..www...',
    '.wwwwg..',
    'wkwwkwg.',
    'wwwwwwgd',
    'wwwkwwdd',
    'wwwwwwg.',
    'w.w.w.g.',
  ] },

// #009 Shell-less Hermit — eyes on stalks, claws, a soft pink abdomen and no shell (ENOENT)
{ id: 'shell-less-hermit', palette: { k: '#2b2d42', r: '#ff6b4a', R: '#c2412d', p: '#ffc2b0', P: '#e89a86' },
  pixels: [
    '.k.k....',
    '.r.r....',
    'rrrrr...',
    'Rrrrrpp.',
    '.r.rppPp',
    '.....pp.',
  ] },

// #022 Two-Headed Crab — ours (blue) and theirs (orange) sharing a ======= belly
{ id: 'two-headed-crab', palette: { k: '#2b2d42', b: '#4ea8de', o: '#ff9f1c', m: '#9d4edd' },
  pixels: [
    'k.k...k.k',
    'bbb...ooo',
    'bbbb.oooo',
    '.bbbmooo.',
    '..bmmmo..',
    '.b.m.m.o.',
  ] },

// #001 Shapeshifter Shrimp — half square (an object), half round (a string): a TypeError
{ id: 'shapeshifter-shrimp', palette: { a: '#9d4edd', b: '#2a9d8f', k: '#fff4e4' },
  pixels: [
    'aaaabb.',
    'akaabkb',
    'aaaabbb',
    'aaaabbb',
    'aaaabb.',
    'a.a..b.',
  ] },

// The jar frame art.jarArt() composes around any species (j glass, c cork, h highlight); the
// creature is fitted into the 7×7 '.' box inside.
const JAR = [
  '...ccccc...',
  '..jjjjjjj..',
  '.j.......j.',
  'jh.......j.', 'j.........j', 'j.........j', 'j.........j', 'j.........j', 'j.........j',
  '.j.......j.',
  '..jjjjjjj..',
];
```

`test/bugdex-species.test.js` copies the `gifts.test.js` "every find is drawable" test: rows of equal width, every pixel character in the palette, width and height at most 12, names at most 24 characters, blurbs at most 80.

---

## 12. Module layout

| File | What |
|---|---|
| `src/main/bugdex.js` | **Pure** state: `normalize`, `recordSeen`, `recordCatch` (→ `{ state, isNew, counted, pays, evolved, completed, form }`), `escape`, `expire`, `view`, `markSeen`, `setFavourite`, `catchLine`, `hintFor`, `syncable`, `merge`, `applySync`. No I/O, no clock, `rand` passed in. |
| `src/main/bugdex/species.js` | `SPECIES`, `HABITATS`, `TYPES`, `STAGES`, `LIVE_PHASE`, `BY_ID`. Frozen, like `FINDS` / `SETS`. |
| `src/main/bugdex/detect.js` | **Pure**: `gate(cmd, item)`, `commandKind`, `classify(output, { source, cmd })` → `{ species, fp, lang, tier } | null`, `fingerprint`, `remedyOf(cmd)`, `isConflictResolve(cmd)`, `isFlee(cmd)`. |
| `src/main/bugdex/lifecycle.js` | **Pure**: `open(state, enc, now)`, `engage`, `candidates(state, { project, cmd })`, `settle(state, enc, pass, verdict, now)`, `prune`. |
| `src/main/bugdex/cheats.js` | **Pure**: `judge({ files, patches, species, fail, pass })` → `{ ok } | { ok: false, reason }`. |
| `src/main/bugdex/art.js` | **Pure**: `silhouette`, `staged`, `golden`, `shiny`, `spectral`, `jarArt`, `micro`. |
| `src/main/wiring/bugdex.js` | `wireBugdex(d)`: snapshots (shares `snapshotWithin` with progress.js, moved to a tiny `wiring/snapshot.js`), the memory maps (`byRoot`, `trees` ring, server map, CI engagement), git checks, `present`, XP / stat / week / needs, toasts, panel pushes, `bugdexOn = () => !d.CAPTURE && !!d.config && d.config.get('catchBugs') !== false && !d.config.get('crabOnly')`. |
| `src/main/main.js` | `wireBugdex(shared)`; getters on `shared` (`bugdex`, `bugdexView`), as `flakyTree` / `noteTestRun` are exposed (main.js:551, 610, 754). |
| `src/main/wiring/sessions.js` | `tabId` on pending entries; `commandStart` / `wrote` / `commandResult` calls. |
| `src/main/wiring/progress.js` | `flakyFixed`, escapes, `auditPatched`; `testOutput` exported. |
| `src/main/wiring/github.js`, `wiring/startfrom.js` | `ciFailed` / `ciFixed` / `ciEngaged`. |
| `src/main/wiring/projects.js`, `wiring/timetrack.js` | server crash / up / turn ended. |
| `src/main/ipc/repo.js` | `homeResult`, `secretSpotted`, `pushedClean`. |
| `src/main/ipc/progress.js` | `bugdex:get` (handle), `bugdex:seen` (on), `bugdex:favourite` (handle, `{ id }`), `bugdex:forget` (handle; confirms in main with `confirm.ask`), `bugdex:open-tab` (on, a `tabId` that is in the current view's `loose`). |
| `src/preload/preload.js` | `getBugdex`, `onBugdex`, `onBugdexCaught`, `onBugdexFocus`, `bugdexSeen`, `setFavouriteBug`, `forgetBugdex`, `openBugTab`. `test/ipc-surface.test.js` checks the pairing. |
| `src/main/life.js` | `presentJar(card, line)`. |
| `src/renderer/critter/life.js`, `life.css`, `sound.js` | `jar` prop, `bit-catch`, `clink`. |
| `src/renderer/panel/bugdex.js`, `bugdex.css`, `pixel-art.js`, `panel.html`, `nav.js`, `crabonly.css`, `settings.js` | Page, tab, palette, switch (`bugdexToggle` under Settings → System, next to `flakyToggle`, settings.js:84/377). |
| `src/main/xp.js`, `weekly.js`, `needs.js`, `wardrobe/achievements.js`, `src/wardrobe/bug-hunter.json`, `renderer/panel/week-card.js` | Rewards. |
| `src/main/github/sync.js` | Sync. |
| `src/main/capture-demo.js`, `capture.js`, `scripts/automate-shots.js` | `demoBugdex(now)`: 18 caught (one golden, one evolved to stage II, one habitat done: the Burrows), 6 seen, 2 on the loose. `capture.js` sets it next to `demoLife` (capture.js:346). Adds `docs/screenshot-bugdex.png`. |
| `test/fixtures/fake-claude.js` | `bash <fixture>`: a Bash tool call whose command and output come from `test/fixtures/bugdex/<fixture>.json` (`{ command, isError, output }`). Uses the existing `edit <file>` for real tree changes. |

---

## 13. Phases

### Phase 1: "First catch"

**Species (13)**: Red Snapper, Flaky Phantom, Red Tide, Beached Whale, Two-Headed Crab (Bring it home + Bash), Shapeshifter Shrimp, Nullfish, Nameless Nudibranch, Syntax Slug, Shell-less Hermit, Stray Module Minnow (with the install remedy), Port Squatter (with the kill remedy), Type Tangle.

**Scope**:
- `species.js` with the **whole** catalogue (`phase` on each entry, `LIVE_PHASE = 1`)
- `detect.js` (gates, tiers, only the phase-1 signatures enabled)
- `lifecycle.js`, `cheats.js` (no-change, revert, deleted-tests, skipped, suppressed, fewer-tests)
- `bugdex.js` (no forms beyond first-try/swift/golden, no stages yet)
- `art.js` (`silhouette`, `jarArt`)
- the wiring for B/T, F, C, S, G
- the panel page and tab, the jar moment, the `catch` / `newbug` XP, the `catchBugs` switch, the CAPTURE demo
- Not yet: sync, achievements, weekly.

**Unit tests**:
- `test/bugdex-detect.test.js`:
  - `gate skips readers, probes, background and masked commands`
  - `classify picks tier 1 over tier 3 (vite "Could not resolve" beats "Build failed")`
  - `classify prefers the last line on a tie`
  - `nullfish from a node stack, a jest failure and a python NoneType traceback`
  - `ENOENT on Windows wording`
  - `tsc output becomes type-tangle`
  - `git CONFLICT and rebase "could not apply"`
  - `a passing jest run that logs "Error:" sees nothing`
  - `grep output full of TypeError sees nothing`
  - `fingerprint ignores line numbers, ports, hex and folders`
  - `fingerprint differs by file basename`
  - `5,000 blank lines and a 1 MB line stay under 20 ms`
  - `hostile line with backticks and tags yields only a species id`
- `test/bugdex-lifecycle.test.js`:
  - `an observed failure opens one encounter per (project, fp)`
  - `a second observation refreshes it`
  - `same command passing on a changed tree catches`
  - `same tree does not, unless a remedy ran (npm i, taskkill)`
  - `a narrower re-run can't catch, a broader one can`
  - `a different project or command can't catch`
  - `24 h TTL expires quietly`
  - `MAX_OPEN drops the oldest`
  - `one pass closing two encounters pays once`
  - `merge --abort flees`
- `test/bugdex-cheats.test.js`: `revert to a pre-failure tree`, `deleted test file`, `added it.skip / @pytest.mark.skip / #[ignore]`, `added @ts-ignore / as any for kelp species`, `fewer passing tests`, `ok for a real edit`
- `test/bugdex.test.js`:
  - `normalize turns garbage into a valid empty state`
  - `recordCatch: first is new and pays newbug`
  - `same fp within 12 h not counted, within 7 d not paid`
  - `species and day caps`
  - `escape within 3 days counts and loses "for good"`
  - `view hides unknown pixels and silhouettes seen`
  - `only live species count toward "of"`
  - `catchLine fits in 24 chars`
- `test/bugdex-species.test.js`: `every species is drawable` (the gifts.js rule), `dex numbers are unique and pinned` (a snapshot of `no → id`), `every habitat has a live member by its phase`, `every signature names a real species`.
- Existing tests to extend: `xp.test.js` (new kinds), `ipc-surface.test.js` (automatic), `config.test.js` (defaults), `devservers-service.test.js` (`fixDraft` lines on crash are redacted).

**e2e (`scripts/e2e-bugdex.js`, added to `scripts/e2e-ci.js` and the `docs/DEVELOPMENT.md` table, line 70 style)**, with the fake CLI in a temp git repo (8.3 path resolved, reduced motion):
1. `bash enoent-fail` → Bugdex shows Shell-less Hermit **seen**, "On the loose" lists it, XP log has no `catch`, no `body.bit-catch` on the crab.
2. `edit app.js`, then `bash enoent-pass` → **caught**, XP log has `newbug`, the crab got `bit-catch` and a held jar, the `new` pill shows.
3. Fail, edit, pass again with the same fp → `caught` stays 1 ("seen again").
4. Fail, then pass with **no edit** → no catch.
5. `jest fail x`, delete the test file, `jest pass` → no catch, and the loose row says why.
6. `bash grep-typeerror` (a successful grep printing TypeError) → nothing seen.
7. Settings switch off → step 1 records nothing.
8. Just-the-crab mode → the tab is hidden.

**Acceptance**:
- No catch without a changed tree or a remedy.
- No observation from readers, probes or successes.
- A failure produces no reward of any kind.
- `bugdex*.js` pure modules at 90% coverage or more.
- `npm test`, `npm run lint`, `npm run typecheck` and `npm run e2e:ci` are green.
- The screenshot shows the page with demo data.

### Phase 2: "Habitats"

- **Live**: every species with `phase: 2`: the rest of the Shallows, Burrows, Currents and Kelp, Python, Trench, Proving Pools, Workshop (except Old Salt), Bounced Bottle, Gatekeeper Goby, Leaky Clam, Barnacled Anchor.
- **Cheats**: `snapshots-only`, `bigger-number`, plus the type-suppression and lint-suppression lists.
- **Forms**: nocturnal; stages and evolution names (`art.staged`); escapes for flaky.
- **Achievements**: the Bug Hunter pack and `packs.test.js` (both directions); `npm run packs`.
- **Rewards**: weekly line; needs snack; toasts for new, legendary, evolution and habitat.
- **Sync**: `test/bugdex-sync.test.js`: `merge is commutative and only grows`, `device counts take the max per device and sum`, `fastest takes the min`, `remote local bucket is dropped`, `open/recent/projects never leave the PC`, `old Shellby without bugdex key round-trips`.
- **e2e**: `e2e-bugdex.js` grows a tsc fail and pass with an `@ts-ignore` attempt (refused) and then a real fix (caught), and a Python traceback; `scripts/e2e-github.js` (mock GitHub) gets a "Fix this build" + push → CI fixed → Red Tide; `e2e-push.js` gets a secret found → "Ask Claude" → clean push → Leaky Clam.
- **Acceptance**: an `@ts-ignore`-only fix never catches; sync between two settings files merges without loss; packs validate.

### Phase 3: "Tide pool"

- **Live**: Lighthouse by check names (Matrix Hydra, Sunken Deploy, The Kraken; Stalled Galleon needs `verdict()` to return `conclusions` per check, a `ci.test.js` addition), the Haunted Wreck (Heisenbug, Race Wraith, Cache Ghoul, Zombie Process reveal), Spectral and Shiny forms, Old Salt, Lockfile Lobster, Overstuffed Pufferfish, the network extras (Nameless Buoy, Border Crab, 404/5xx, Cert Cuttlefish with `insecure`), UNDEFINED.
- **Beach tide pool**: `beach.test.js` (`the pool never overlaps a castle`, `at most 8 micros`).
- **Tank**: `jar` category (`tank.test.js`).
- **Elsewhere**: the Haunted Shell wisps and Ghost Buddy cheer; recap line ("Caught 2 bugs while you were away", `recap.js`); "Bugdex 23/66" on the crab card (`github/card.js`); a `bug-caught` workflow trigger (`workflows` event, like `d.workflows?.event('ci', …)`).
- **e2e**: `e2e-bugdex.js` with a server crash (`EADDRINUSE` log fixture in `test/fixtures/devservers/`), then "Send to Claude", the fake fix turn, up for 60 s, and Port Squatter; then a kill remedy → Zombie Process. `e2e-life.js` checks the tide pool on the Beach.

### Phase 4 (v2, behind a check): outside sessions

As flaky v2: if Claude Code sends `PostToolUseFailure`, register it in `claude-plugin/hooks/hooks.json`. `external.js` reduces it to `{ type: 'bug-seen', species, fp, cwd, cmdKey }` **inside the reducer** (no output leaves it). Passes come from `PostToolUse`. Trees are taken in Shellby at `PreToolUse` for commands with an open encounter. Until this ships, the panel says "Watches what Claude does in Shellby's tabs."

### Ship checklist (each phase)

`/code-review`, `/security-review` (the risks are output parsing, the git calls and IPC ids), `npm run release:ready`, then (on main, at merge time) bump the minor version, add a CHANGELOG entry ("**The Bugdex.** …"), update the `docs/DEVELOPMENT.md` e2e table, push, tag.

---

## 14. Risks

| Risk | Handling |
|---|---|
| **False catches**, which destroy trust | §3.1 gates, §4.1 same-or-broader command plus changed tree plus signature gone, §4.4 cheats. When in doubt, no catch. Every refusal is visible in "On the loose". |
| **Farming** by asking Claude to break and fix | the revert check (undo is not a fix), 12 h / 7 d per fingerprint, per-species and per-day caps, XP falloff, and `catch` paying only 10 XP |
| **Snapshot cost** on big repos | snapshots only for commands matching an open encounter, 10 s `SNAPSHOT_WAIT_MS`, at most 40 open, one in-flight snapshot per repo (the flaky pattern) |
| **Regex blow-ups** on huge output | 64 KB / 200 lines / 500 characters per line, `[ \t]` only, a timing test |
| **Moment spam** | one jar moment per 10 min for repeats, toasts only for new / legendary / evolution / habitat, the focus and quiet gates |
| **Overlapping critter moments** (a dig and a jar) | `presentJar` queues one behind `present()` |
| **Someone else's games** (their names, slogans, characters, screens and patented mechanics) | Nothing of theirs is used: no names (Pokémon, Pokédex, Poké Ball, Elite Four, any creature's name), no slogans, no copied battle lines, no copied screen layout. Mechanics that are the subject of patents are avoided: nothing is thrown at a bug to catch it (a jar is lowered on a line, or he scoops it), and no wobble count or other sign of the odds of a catch. Ids from the first build (`slowpoke-snail`, `fix-em-all`, `trainer-cap`) are kept as ids only, so saved books and earned hats don't break; what you see is renamed. See [bugdex-battles.md](bugdex-battles.md). |
| **Catalogue growth renumbering** | pinned `no` with a test; new species only append |
| **Sync size or abuse** | `normalizeSync` caps species to the catalogue ids, devices to 20, forms and langs to known values |

---

## 15. Decisions needing you (each has a default)

1. **Do bugs Claude introduced itself in the same task count?** Most fixes are "wrote code, it failed, fixed it". *Default: yes.* The revert rule and the caps stop deliberate farming.
2. **Own tab vs. inside Finds.** *Default: its own "Bugdex" tab* (§8.2). The Shellby tab strip gets an eighth button; if that's too wide, it could replace "Us" in the strip and move Us into the overflow.
3. **CI needs Shellby's involvement** ("Fix this build" or a push from a tab). *Default: yes.* Otherwise colleagues' fixes fill your book.
4. **XP size.** *Default: `catch` 10 and `newbug` 40,* stacking with `fixed` / `tests`. The alternative is no XP for repeats, only for new species.
5. **Shiny luck (1/64).** Everything else is earned, and randomness could feel off for a work tool. *Default: keep it, purely cosmetic.*
6. **Ship the whole catalogue as `???` from phase 1, or only the live species?** *Default: only live species,* with habitats growing over versions.

## 16. Not doing

- **Re-running anything to confirm a catch.** Shellby only learns from runs that happen anyway (the flaky rule).
- **Storing or showing error text**, or an "ask Claude to fix this spotted bug" button. That would need the text, and would make the Bugdex a prompt surface.
- **Penalties.** Escapes are a counter, never a loss.
- **Trading creatures between friends.** It may come later through the friends system; the gist sync is your own PCs only.

---

### Critical files for implementation

- `src/main/wiring/sessions.js` (the tool/tool_result pairing, lines 103-142, where most observing and catching hooks in)
- `src/main/wiring/progress.js` (`awardXp`, `noteTestRun`, `snapshotWithin`, `testOutput`, `checkedUp`: the pattern for the new `wiring/bugdex.js`)
- `src/main/gifts.js` (the state, view, silhouette and set model the pure `bugdex.js` copies)
- `src/main/flaky/ids.js` and `src/main/flaky/parsers.js` (`normalizeCmd`, `cmdKey`, `masked`, `readRun`, reused for command identity and test pass/fail)
- `src/main/ipc/repo.js` (`bringTabHome`, `secretGate`, `pushHome`: the conflict and secret catches)

Also central: `src/main/devservers/service.js` (`ended`, `sendFix`, `onTabDone`, `restart` clearing `fixTabId`), `src/main/wiring/github.js` (`onCiEvent`), `src/main/life.js` (`present`, for `presentJar`), `src/main/github/sync.js`, `src/main/wardrobe/achievements.js`, `src/renderer/panel/together.js` (the `renderFinds` pattern), and `test/fixtures/fake-claude.js`.
