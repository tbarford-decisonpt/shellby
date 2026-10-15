// The quest line's chapters (quests/index.js runs them): data only, so the logic
// stays small. Chapter 1 is the original four quests, ids unchanged, so a saved
// line still loads. Every later chapter teaches one screen and how it feeds the
// next one: the reef, the Bugdex, automation, review, the tank, tide events.
//
// unlock: any one of these opens a chapter (docs/GAMIFICATION-PLAN.md section 2.1):
//   level: n       the highest level ever reached (molting never closes one)
//   dormant: [ids] a screen (feature-use.js SCREENS) never opened: the chapter
//                  is its tutorial, so it opens early, one such chapter at a time
//   event: true    a tide event is on
//   always: true   Chapter 1
// quest.go: where the panel points. Chapter 1 keeps its own targets (diff,
// branch, home, reset); the rest are panel views. links: the views a quest
// feeds, for the Logbook's "this feeds that" lines.

const freeze = o => Object.freeze(o);

const CHAPTERS = freeze([
  {
    id: 'first-tide', n: 1, icon: '🌊', title: 'First Tide', unlock: { always: true },
    blurb: 'The tricks hiding in plain sight.',
    teaches: 'A review leads to a second take in its own copy, and a copy leads to work held for a fresh window.',
    quests: [
      {
        id: 'comment', icon: '💬', title: 'Comment on a diff line', go: 'diff', links: ['chat'],
        why: 'Point at the exact line instead of describing where it is. Your comments pile up and go back to him as one review.',
        how: 'When he changes a file, open the diff under his reply, click a line number (Shift+click for several), say what should change, then send the review.',
      },
      {
        id: 'branch', icon: '⑂', title: 'Try it another way', go: 'branch', links: ['chat'],
        why: 'Not quite right? He takes another run at your last message in a new tab with its own copy of the files. The first try stays as it was.',
        how: 'Hover your last message and choose ⑂ Try it another way, or press Ctrl+Shift+B.',
      },
      {
        id: 'home', icon: '↩', title: 'Bring a copy home', go: 'home', links: ['chat'],
        why: 'Work in a copy never touches your checkout until you say so. Happy with it? One click merges it back.',
        how: 'In a conversation with its own copy, open the branch chip and choose ↩ Bring it home, or press Ctrl+Shift+H.',
      },
      {
        id: 'reset', icon: '🌙', title: 'Queue a routine for the reset', go: 'reset', links: ['routines'],
        why: 'Near your usage limit? Queue the heavy work and it runs the moment your 5-hour window resets, overnight too.',
        how: 'In Automate → Routines, under "When your limit resets", write the task and press Queue it. A routine or a message can wait for the reset too.',
      },
    ],
  },
  {
    id: 'reef-wakes', n: 2, icon: '🪸', title: 'The Reef Wakes', unlock: { level: 5, dormant: ['projects'] },
    blurb: 'Every project has a reef. Healthy code makes it grow.',
    teaches: 'Code health feeds the reef, and the reef grows coral in his tank.',
    quests: [
      {
        id: 'checkup', icon: '🩺', title: 'Read a dependency checkup', go: 'projects', links: ['projects', 'bugdex'],
        why: 'Outdated or vulnerable packages are the quiet kind of bug. A checkup says which, and a clean one pays XP.',
        how: 'Open Projects, pick a repo and run its checkup, or ask Claude to run `npm audit` in it.',
      },
      {
        id: 'reef-on', icon: '🪸', title: 'Wake a project’s reef', go: 'projects', links: ['projects', 'tank'],
        why: 'The reef reads lint, types, CI and flaky tests for a project, and its coral grows as they improve.',
        how: 'On a project’s page, turn on reef watch.',
      },
      {
        id: 'flaky-look', icon: '🎲', title: 'Deal with a flaky test', go: 'projects', links: ['projects', 'bugdex'],
        why: 'A test that passes and fails on the same code teaches everyone to ignore red. Fix it or set it aside, and the reef breathes easier.',
        how: 'When Shellby flags a flaky test, choose Fix it or Quarantine on its card.',
      },
    ],
  },
  {
    id: 'bug-hunter', n: 3, icon: '🫙', title: 'Bug Hunter', unlock: { level: 8, dormant: ['bugdex'] },
    blurb: 'Every bug Claude fixes is a catch for the Bugdex.',
    teaches: 'Battles fill the Bugdex, catches go in jars for the tank, and bugs that come back form nests.',
    quests: [
      {
        id: 'first-catch', icon: '🪲', title: 'Catch a bug', go: 'bugdex', links: ['bugdex'],
        why: 'When a red test or a crash turns green, the bug behind it is caught. Each kind gets a page in the Bugdex.',
        how: 'Let Claude fix something that was failing. The battle plays out on its own; the catch is yours.',
      },
      {
        id: 'proof', icon: '🧪', title: 'Catch one with proof', go: 'bugdex', links: ['bugdex', 'projects'],
        why: 'A fix with a new test that proves it can’t come back quietly. Those are the ones that clear nests.',
        how: 'Ask Claude to add a test that fails before the fix and passes after it.',
      },
      {
        id: 'jar-in-tank', icon: '🫙', title: 'Put a jar in the tank', go: 'tank', links: ['tank', 'bugdex'],
        why: 'Your catches are decor too. A jar on the shelf of his tank is a bug that stays caught.',
        how: 'Open Tank, pick a jar from the Bugdex shelf, place it and save.',
      },
      {
        id: 'rematch', icon: '🥊', title: 'Win a rematch', go: 'bugdex', links: ['bugdex'],
        why: 'A bug that comes back is stronger the second time. Beating it again, properly, is how a nest starts to clear.',
        how: 'When a bug you caught before shows up again, fix it at the root.',
      },
    ],
  },
  {
    id: 'clockwork', n: 4, icon: '⏱️', title: 'Clockwork', unlock: { level: 10, dormant: ['routines', 'workflows'] },
    blurb: 'Work that happens while you’re away.',
    teaches: 'Automation earns while you’re away, and the week card shows what it did.',
    quests: [
      {
        id: 'routine', icon: '⏰', title: 'Run a routine', go: 'routines', links: ['routines', 'trophies'],
        why: 'A routine is a prompt on a schedule: a morning summary, a nightly test run, a weekly dependency check.',
        how: 'In Automate → Routines, make one and press Run now, or wait for its time.',
      },
      {
        id: 'workflow', icon: '🔀', title: 'Finish a workflow', go: 'workflows', links: ['workflows'],
        why: 'A workflow strings steps together and starts on its own: a red build, a file arriving, a schedule.',
        how: 'In Automate, pick a template, run it, and let it finish green.',
      },
      {
        id: 'away', icon: '🛋️', title: 'Let one run while you’re away', go: 'routines', links: ['routines', 'trophies'],
        why: 'The best routine is the one you never watch. The week card counts the hours it worked for you.',
        how: 'Leave a routine scheduled and step away from the PC while it runs.',
      },
    ],
  },
  {
    id: 'second-opinions', n: 5, icon: '🧐', title: 'Second Opinions', unlock: { level: 15, dormant: ['council'] },
    blurb: 'Reading Claude’s work closely is a skill. It grows.',
    teaches: 'Quizzes, helpers and the council all feed review mastery.',
    quests: [
      {
        id: 'quiz', icon: '❓', title: 'Pass a quiz', go: 'chat', links: ['trophies'],
        why: 'A three-question quiz on a change Claude just made: the fastest way to know you really read it.',
        how: 'Under a reply that changed files, choose Quiz me and answer.',
      },
      {
        id: 'council', icon: '🏛️', title: 'Hear the council out', go: 'council', links: ['council'],
        why: 'Advisor crabs argue a decision out and he rules on it. Good for the calls you keep putting off.',
        how: 'Open Council, ask a question and wait for the verdict.',
      },
      {
        id: 'helped', icon: '🦀', title: 'Use a helper’s find', go: 'crew', links: ['crew'],
        why: 'His helper agents dig things up. Acting on what they found is where the time saved shows.',
        how: 'When a helper reports back, act on what it found in your next message.',
      },
      {
        id: 'look-over', icon: '🛡️', title: 'Ask for a look over', go: 'projects', links: ['projects'],
        why: 'A read-only security review of what’s pending in a project, before it goes anywhere.',
        how: 'On a project, choose Look over my changes.',
      },
    ],
  },
  {
    id: 'home-improvement', n: 6, icon: '🏰', title: 'Home Improvement', unlock: { level: 20, dormant: ['tank'] },
    blurb: 'His tank shows everything you two have done.',
    teaches: 'Rare pieces for the tank come from every other system.',
    quests: [
      {
        id: 'decorate', icon: '🪴', title: 'Decorate the tank', go: 'tank', links: ['tank'],
        why: 'Castles, plants, your finds and your jars: his home, your call.',
        how: 'Open Tank, place five or more pieces and save.',
      },
      {
        id: 'bigger', icon: '📐', title: 'Move into a bigger tank', go: 'tank', links: ['tank', 'trophies'],
        why: 'Levels open bigger tanks, with room for more.',
        how: 'In Tank, pick a bigger size once your level opens one.',
      },
      {
        id: 'milestone-piece', icon: '💎', title: 'Place a rare piece', go: 'tank', links: ['tank', 'trophies'],
        why: 'Rare pieces come from trophies: nests cleared, reefs thriving, review tiers.',
        how: 'Earn a milestone trophy, then place its piece in the tank.',
      },
      {
        id: 'tank-share', icon: '📸', title: 'Share the tank', go: 'tank', links: ['tank'],
        why: 'Show it off.',
        how: 'In Tank, choose Share.',
      },
    ],
  },
  {
    id: 'tides-and-friends', n: 7, icon: '🌾', title: 'Tides and Friends', unlock: { level: 25, event: true },
    blurb: 'Tide events come with their own bug, finds and medal.',
    teaches: 'Events boost catches and finds, and friends trade what you dig up.',
    quests: [
      {
        id: 'goal', icon: '🎯', title: 'Finish a tide goal', go: 'us', links: ['us'],
        why: 'Each event has a handful of goals. Any one of them is a start.',
        how: 'While an event is on, check its goals on the Us page and do one.',
      },
      {
        id: 'medal', icon: '🏅', title: 'Earn a medal', go: 'us', links: ['us', 'trophies'],
        why: 'Every goal while the event is on: the medal, its trophy and its reward.',
        how: 'Finish every goal of a tide event before it ends.',
      },
      {
        id: 'friend', icon: '🥚', title: 'Swap, hatch or dig', go: 'us', links: ['finds', 'us'],
        why: 'Swap a find with a friend, hatch a crab egg, or, playing solo, dig up an event find.',
        how: 'Trade on the Us page, or keep working while an event is on until he digs up one of its finds.',
      },
    ],
  },
  {
    id: 'keeper', n: 8, icon: '🗝️', title: 'Keeper', unlock: { level: 30 },
    blurb: 'Keeping things healthy is its own game.',
    teaches: 'Cleared nests and green builds lift the reef.',
    quests: [
      {
        id: 'nest', icon: '🪺', title: 'Clear a nest', go: 'bugdex', links: ['bugdex', 'projects'],
        why: 'A nest is a bug that keeps coming back. Fourteen quiet days after a real fix clears it.',
        how: 'Fix a nested bug with a test that proves it, then let it hold.',
      },
      {
        id: 'reef-best', icon: '📈', title: 'Two new bests on a reef', go: 'projects', links: ['projects', 'tank'],
        why: 'Each signal on the reef keeps its best. Beat two and the coral grows.',
        how: 'Bring down lint warnings, `any` types or flaky tests on a watched project.',
      },
      {
        id: 'cifix', icon: '✅', title: 'Get CI back to green', go: 'projects', links: ['projects'],
        why: 'A red build on your pull request, turned green.',
        how: 'When CI fails on a pull request, send it to Claude from the red build card.',
      },
      {
        id: 'patched', icon: '🩹', title: 'Patch the dependencies', go: 'projects', links: ['projects', 'bugdex'],
        why: 'A checkup that found vulnerabilities, followed by one that found none.',
        how: 'Ask Claude to fix what a checkup found, then check up again.',
      },
    ],
  },
  {
    id: 'long-watch', n: 9, icon: '🦅', title: 'The Long Watch', unlock: { level: 40 },
    blurb: 'The best bug is one that never merged.',
    teaches: 'Review catches problems early, so fewer nests form.',
    quests: [
      {
        id: 'tier2', icon: '🎖️', title: 'Reach review tier 2', go: 'trophies', links: ['trophies'],
        why: 'Review mastery climbs with real catches and quizzes, never with clicks.',
        how: 'Keep commenting on lines that matter and passing quizzes.',
      },
      {
        id: 'quiz3', icon: '🧠', title: 'Three quizzes in a row', go: 'chat', links: ['trophies'],
        why: 'Three passes in a row on three different changes.',
        how: 'Take the quiz under the next few replies that change files.',
      },
      {
        id: 'caught', icon: '🔍', title: 'Catch one in review', go: 'chat', links: ['trophies', 'bugdex'],
        why: 'A line comment that changed the code before it was pushed.',
        how: 'Comment on a line that’s wrong, and let Claude fix it before you push.',
      },
    ],
  },
  {
    id: 'the-deep', n: 10, icon: '🐋', title: 'The Deep', unlock: { level: 60 },
    blurb: 'Long-term mastery.',
    teaches: 'Every system, kept up over months.',
    quests: [
      {
        id: 'nests3', icon: '🪺', title: 'Clear three nests', go: 'bugdex', links: ['bugdex'],
        why: 'Three bugs that kept coming back, gone for good.',
        how: 'Keep fixing nested bugs at the root.',
      },
      {
        id: 'thriving', icon: '🌺', title: 'A thriving reef', go: 'projects', links: ['projects', 'tank'],
        why: 'One project’s coral at its fullest stage.',
        how: 'Keep a watched project’s signals at their best.',
      },
      {
        id: 'species50', icon: '📖', title: 'Fifty species', go: 'bugdex', links: ['bugdex'],
        why: 'Half a hundred kinds of bug, each with its page.',
        how: 'Keep catching. New kinds show up in new kinds of work.',
      },
    ],
  },
  {
    id: 'molting-season', n: 11, icon: '🐚', title: 'Molting Season', unlock: { level: 90 },
    blurb: 'The top of the climb, and what comes after.',
    teaches: 'Molting is optional: both paths finish this chapter.',
    quests: [
      {
        id: 'ninety-nine', icon: '💯', title: 'Reach level 99', go: 'trophies', links: ['trophies'],
        why: 'The top of the climb.',
        how: 'Keep going.',
      },
      {
        id: 'every-shell', icon: '🐚', title: 'Wear ten shells', go: 'wardrobe', links: ['wardrobe'],
        why: 'He has lived in a lot of homes by now.',
        how: 'In Outfits → Homes, try ten different shells.',
      },
      {
        id: 'molt-or-stay', icon: '✨', title: 'Molt, or stay', go: 'wardrobe', links: ['wardrobe', 'trophies'],
        why: 'Molt for a new climb and a tier shell, or stay and earn your first star. Either one finishes it.',
        how: 'At 99, choose Molt, or keep earning XP past 99.',
      },
    ],
  },
]);

module.exports = { CHAPTERS };
