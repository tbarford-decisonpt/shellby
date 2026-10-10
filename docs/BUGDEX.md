# The Bugdex and bug battles

Every kind of bug Claude fixes for you is a pixel creature, and Shellby keeps the ones you've beaten in jars. A TypeError is a Shapeshifter Shrimp, ENOENT is a hermit crab that lost its shell, a merge conflict is a crab with two heads, and a flaky test is a ghost. Open it from **Shellby → Bugdex**.

**You don't catch a bug by seeing it. You catch it by fixing it.** A failure only makes it turn up. It goes in a jar when the fix is proven.

## How a bug gets caught

1. **Spotted.** A command fails in one of Shellby's tabs (or in Claude Code anywhere on this PC, with the [Shellby plugin](CLAUDE-CODE.md)), and its output matches a kind of bug. The bug shows up **on the loose** at the top of the Bugdex page, and as a silhouette with its name in the grid. Seeing one earns nothing.
2. **Worked on.** Claude edits files in that project, or runs a fix like clearing a cache or freeing a port.
3. **Caught.** The same command passes on changed code. Then Shellby scoops it into a jar on your desktop, and it's in colour on the page with its stats.

The same goes for other places a bug turns up:

- **A red build** on one of your pull requests, caught when it goes green after Shellby worked on it.
- **A crashed dev server,** caught when **Send to Claude** fixed it and it comes back up and stays up.
- **A clash bringing a copy home,** caught when a later **Bring it home** merges cleanly.
- **A merge conflict in git,** caught when it's committed with no conflict markers left.
- **A secret stopped at a push,** caught when the next push goes through clean.
- **A flaky test,** caught when the [flaky test detective](PROJECTS.md#flaky-tests) proves it fixed for good.
- **A dependency audit with issues,** caught when the [weekly check](PROJECTS.md#dependencies) patches them.

A bug that isn't fixed in time (a day for most, longer for a red build) slips away quietly. It stays seen, and nothing is taken off you.

### It can't be fooled

A catch never comes from making the failure go away. Shellby refuses one, and says why, when:

- nothing changed, or the code went back to how it was before,
- a test was deleted or skipped, or fewer tests ran,
- a check was switched off instead (`@ts-ignore`, `as any`, `eslint-disable`, `# type: ignore`, `# noqa` and the like),
- only the snapshots were updated, a timeout was just made bigger, or a certificate check was skipped.

And it has to be the same command passing: a grep through a log that happens to come back clean is not a fix.

And a few limits keep it honest: the same bug in the same project counts once in 12 hours and pays XP once a week, at most 3 of one kind and 12 in all count in a day, and a bug back in the same project within 3 days **got away once**. That line is the only mark against it. Nothing you've caught is ever taken away.

## The book

- **83 kinds in twelve habitats:** the Shallows (JavaScript and runtime errors), the Burrows (files), the Currents (network), Tangled Nets (git), the Lighthouse (CI), the Reef Workshop (builds, installs and servers), the Kelp Maze (type checkers), the Sea-Snake Pool (Python), the Deep Trench (Rust, Go and native code), the Proving Pools (tests), the Sunken Vault (security) and the Haunted Wreck (ghosts). And one more that's hidden. Each one has its own portrait and field notes. Among them: broken JSON, React render loops, hydration mismatches, duplicate keys, missing database tables, rate limits, git without a repo, overwritten local changes, branches that aren't there, a sulking Docker daemon, garbled text encodings, unused Go variables, tests that time out or never run, 401s and 403s, missing env vars, and SSH keys git won't accept.
- **Rarity is how hard the fix is.** Common ones turn up weekly and one edit fixes them. Rare ones need a real diagnosis. Legendary ones need proof over days.
- **Unknown, seen, caught.** A kind you've never met is `???` with a hint about where it lives. A seen one is a silhouette with its name. A caught one is in colour.
- **They evolve.** Catch one kind 5 times and it reaches stage II, 15 times stage III (the starters take new names as they grow), and 40 times a master's crown.
- **Field notes and tips.** At 5 catches its entry gets a field note on where it lurks. At 15 you get a tip on how it's usually beaten.
- **Every bug has a cry,** a little chiptune call of its own as it goes in the jar. Press **♪ Its cry** on its card to hear it.
- **Special catches:** *first try* (the first fix worked), *swift* (within 5 minutes of the failure), *golden* (both), *nocturnal* (after midnight), *spectral* (a ghost at Halloween), and once in a long while (1 in 64) a sparkly one, which stops the panel for a look and a picture to share ([Sparklies](TIDES.md#sparklies)).
- **Tide event bugs:** six more, one for each [tide event](TIDES.md#tide-events), that only come along with a real fix while their event is on. They're under **🧭 Tide events**, in no habitat, and never in the "of 83".
- **The friends' board:** with **Share my Bugdex with friends** on, **This month** ranks you and your friends by bugs caught since the 1st ([more](TIDES.md#the-friends-board)).
- **Your favourite catch follows him round the desk,** a step behind, and waits on the ground while he climbs a window.

A new kind is worth 40 XP. The trophies: **Gotcha!** for your first catch, **Field Notes** for 10 kinds, **Naturalist** for a whole habitat, **Field Researcher** for 40 kinds, **Pest Control** for 100 catches, **Ghost Whisperer** for three ghosts, and two secret ones. Each comes with something to wear or put in the [tank](TANK.md). The week card on the Trophies page counts the bugs you caught that week and how many were new to the book ("🫙 5 bugs caught (2 new to the Bugdex)").

## Bug battles

While a bug is on the loose, Claude's work on it plays out as a battle on the seabed of its own habitat: the bug and Shellby face to face, their HP at the top, and a text box calling each move.

To watch one, click the chip under the tabs in the conversation where it's loose, or **Watch** beside it on the Bugdex page. Open it partway through and it replays its last few moves from the past 10 minutes. While Claude works on its next turn, the bug acts up in its own way (a ghost flickers out, a network bug buffers, a type bug glitches), Shellby fidgets, and the text box tells you when Claude is thinking. Open it after the catch and it replays the finish. **Esc** closes it, and the fight carries on without you.

### The moves

Each move is something Claude really did in that project:

- **Scout:** reading round (reading files, searching, fetching a page). A little each, and only so much in all.
- **Patch:** an edit.
- **Remedy:** a fix that isn't an edit, like clearing a cache, freeing a port or installing a package.
- **The failing command, run again:** that command's own move, named for it (*Test Run*, say). This is where the real damage is.
- **Assist:** a helper Claude sent out finishes its work in that tab, and joins in.

A run of the same move close together is one move done several times over. Reading round, edits and helpers only count while the bug is in play: within 20 minutes of it last showing itself.

### How the HP goes

The bug's HP follows the failing tests, or the error count of a type check, linter or build. Run the command again with fewer failures and it drops in proportion:

- **A big one:** half the failures cleared in one run.
- **The right tool for the job:** fewer failures, with the kind of tool that suits that kind of bug. It counts double.
- **It digs in:** more failures than before heals it.
- **A miss:** the same number of failures, or still failing with no count to go on. The bug strikes back, with a move of its own for each type.
- **It resists:** a "fix" the Bugdex won't take, like a skipped test, gives HP back, and the text box says why.

Nothing but the real fix takes it below its last sliver of HP. Only the proven fix knocks it out cold: it's a finishing blow you watch land. Then it goes belly-up, a specimen jar comes down on a line, it drifts up in, the cork goes on, and its card shows. If the conversation closes first, it **fled**.

Battles are kept only while Shellby runs, so a restart starts each one afresh at full HP. The catch itself never depends on the battle: it's the same proven fix either way.

### Your crew pitches in

A helper Claude sends out joins the battle as one of your crew. Each crew member keeps count of the bugs it helped beat, and becomes a specialist against the kind it beats most (once it has beaten 3), which makes its assists count double. You'll find it on **Shellby → Crew**.

### Sound, motion and screen readers

The battle's sounds follow your sound settings. With reduced motion on there's no tide wipe, shaking or particles, and the lines show at once. A battle log beside the scene reads every line out to screen readers, and the HP bar is a meter they can read.

## Badges and the league

Every habitat has a **boss**. Beat it for that habitat's badge, twelve in all:

- Tide Badge: the Heap Leviathan in the Shallows
- Burrow Badge: the Overstuffed Pufferfish in the Burrows
- Current Badge: the Meltdown Medusa in the Currents
- Knot Badge: the Two-Headed Crab in Tangled Nets
- Beacon Badge: the Matrix Hydra at the Lighthouse
- Wrench Badge: the Tangled Tree Crab in the Reef Workshop
- Kelp Badge: the Optional Oarfish in the Kelp Maze
- Coil Badge: the Circular Sea Snake in the Sea-Snake Pool
- Abyss Badge: the Knotted Eels in the Deep Trench
- Flask Badge: the Mirror Mullet in the Proving Pools
- Key Badge: the Cert Cuttlefish in the Sunken Vault
- Lantern Badge: the Race Wraith in the Haunted Wreck

Then come the **Deep Four**, the hardest bugs in the sea (the Segfault Squid, the Leaky Clam, the Flaky Phantom and the Kraken), and **the champion**, the Heisenbug. Bosses and the league fight with more HP and a higher level. Catch every boss and the whole league, in any order, and you're in the **Hall of Fame**.

The badge case, the league and the Hall of Fame are at the top of the Bugdex page. Each badge is a shaded medal with a shape of its own, so one you haven't earned still tells you which it is. They sit in sockets in a velvet-lined case with their names underneath, a bar fills as you earn them, and the rim turns gold once the case is full.

## Friends

Turn on **Share my Bugdex with friends** and your calling card says which kinds you've caught, how many badges you hold and whether you've made the Hall of Fame. Never counts, projects, times or errors. It needs **Visiting crabs** (see [Connections](CONNECTIONS.md)).

Friends who share theirs show up under **Friends' books**. A kind they've caught that you've never met shows as a silhouette with its name, reported by them. And when a friend who shares visits, they bring you a jar (one a day each, one you lack if they can), which can go in the tank. A gift jar is never a catch, and stays on this PC.

There are no battles between friends: that would rank people by how many bugs they had.

## Settings

All under **Settings → Shellby → Games**:

- **Catch bugs for the Bugdex** (on): the whole thing.
- **Bug battles: watch Claude take on each bug while it's loose** (on)
- **His favourite catch follows him round the desk** (on)
- **Share my Bugdex with friends** (off)

**Start the Bugdex over**, at the bottom of the page, empties the jars. In **Just the crab** mode there's no Claude to fix anything, so nothing is caught.

## What's kept

No error text, command or output is ever kept: for each catch, only which kind of bug it was, a short fingerprint and the project. Your catches sync between your PCs like XP, if you sync: each PC keeps its own count of every kind, so catches from two PCs add up and nothing is lost. Projects, fingerprints and open bugs stay on the PC that saw them. The battles live only in memory.
