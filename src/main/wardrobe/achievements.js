// Achievements: small milestones that unlock wardrobe items. Stats are a flat,
// JSON-friendly object persisted by the caller; everything here is pure, so
// recordStat returns a new object instead of mutating.
// Rewards are item keys from the built-in packs in src/wardrobe/. They must match the
// item's own `unlock: { achievement }` gate — test/packs.test.js checks both directions.

const ACHIEVEMENTS = Object.freeze([
  { id: 'first-task', name: 'Hello, World', icon: '🐚', description: 'Finish your first task', stat: 'tasksCompleted', goal: 1, rewards: ['party-hat', 'confetti'] },
  { id: 'ten-tasks', name: 'Regular', icon: '🔨', description: 'Finish 10 tasks', stat: 'tasksCompleted', goal: 10, rewards: ['hard-hat', 'keycap'] },
  { id: 'quarter-century', name: 'Distinguished', icon: '🎩', description: 'Finish 25 tasks', stat: 'tasksCompleted', goal: 25, rewards: ['top-hat', 'dog-tag'] },
  { id: 'centurion', name: 'Crab Royalty', icon: '👑', description: 'Finish 100 tasks', stat: 'tasksCompleted', goal: 100, rewards: ['crown', 'medal'] },
  { id: 'crew-boss', name: 'Crew Boss', icon: '⚓', description: 'Send out your first helper agent', stat: 'helpersSpawned', goal: 1, rewards: ['captains-hat', 'whistle'] },
  { id: 'all-hands', name: 'All Hands', icon: '🏴‍☠️', description: 'Have 3 helpers working at once', stat: 'maxCrew', goal: 3, rewards: ['pirate-bandana', 'high-vis'] },
  { id: 'fleet', name: 'Fleet Admiral', icon: '⛵', description: 'Send out 25 helpers in total', stat: 'helpersSpawned', goal: 25, rewards: ['jolly-roger', 'tiny-sail'] },
  { id: 'toolmaker', name: 'Toolmaker', icon: '🎓', description: 'Shellby learns his first new trick', stat: 'tricksLearned', goal: 1, rewards: ['grad-cap', 'book-stack'] },
  { id: 'inventor', name: 'Inventor', icon: '🧙', description: 'Shellby learns 5 new tricks', stat: 'tricksLearned', goal: 5, rewards: ['wizard-hat', 'bonsai'] },
  { id: 'tinkerer', name: 'Tinkerer', icon: '🔧', description: 'Approve running a script Shellby wrote', stat: 'createdScriptsRun', goal: 1, rewards: ['wrench', 'rubber-duck'] },
  { id: 'clockwork', name: 'Clockwork', icon: '⏱️', description: 'Run your first routine', stat: 'routinesRun', goal: 1, rewards: ['pocket-watch', 'pager'] },
  { id: 'night-owl', name: 'Night Owl', icon: '🦉', description: 'Finish a task between midnight and 5 AM', stat: 'nightTasks', goal: 1, rewards: ['nightcap', 'sleep-mask'], hidden: true },
  { id: 'early-bird', name: 'Early Bird', icon: '☕', description: 'Finish a task between 5 and 8 AM', stat: 'earlyTasks', goal: 1, rewards: ['coffee-mug', 'eye-black'], hidden: true },
  { id: 'multitasker', name: 'Multitasker', icon: '🎧', description: 'Run 3 conversations at the same time', stat: 'maxParallel', goal: 3, rewards: ['headphones', 'cursors'] },
  { id: 'careful', name: 'Safety First', icon: '🥽', description: 'Answer 25 permission prompts', stat: 'permissionsAnswered', goal: 25, rewards: ['safety-goggles', 'face-shield'] },
  { id: 'planner', name: 'Master Planner', icon: '🧐', description: 'Approve a plan from Plan mode', stat: 'plansApproved', goal: 1, rewards: ['monocle', 'reading-glasses'] },
  { id: 'special-delivery', name: 'Special Delivery', icon: '✈️', description: 'Drop a file on Shellby', stat: 'filesDropped', goal: 1, rewards: ['paper-plane', 'backpack'] },
  { id: 'loyal', name: 'Old Friends', icon: '🌈', description: 'Use Shellby on 7 different days', stat: 'activeDays', goal: 7, rewards: ['rainbow-scarf', 'barnacles'] },
  { id: 'check-up', name: 'Check-Up', icon: '🩺', description: "Look at your PC's vitals in the Health view", stat: 'healthViews', goal: 1, rewards: ['stethoscope', 'scanner-visor'] },
  { id: 'keep-your-cool', name: 'Keep Your Cool', icon: '🧊', description: 'Shellby cools down after a heat warning', stat: 'heatCooled', goal: 1, rewards: ['sweatband', 'hand-fan', 'fire-extinguisher'], hidden: true },
  { id: 'show-off', name: 'Show-Off', icon: '📸', description: 'Share your crab card', stat: 'cardsShared', goal: 1, rewards: ['camera', 'pearls'] },
  { id: 'spring-cleaning', name: 'Spring Cleaning', icon: '🧹', description: 'Free up space after a low-disk warning', stat: 'spaceFreed', goal: 1, rewards: ['broom', 'toadstool'] },
  { id: 'good-crab', name: 'Good Crab', icon: '💕', description: 'Pet Shellby 25 times', stat: 'petsGiven', goal: 25, rewards: ['heart-shades', 'starfish'], hidden: true },
  { id: 'frequent-flyer', name: 'Frequent Flyer', icon: '🛩️', description: 'Throw Shellby across your screen', stat: 'timesThrown', goal: 1, rewards: ['aviator-cap', 'inner-tube'], hidden: true },
  { id: 'deep-focus', name: 'Deep Focus', icon: '⛑️', description: 'Finish 5 focus sessions', stat: 'focusSessions', goal: 5, rewards: ['guard-helmet', 'welding-mask'] },
  { id: 'open-house', name: 'Open House', icon: '🏡', description: "A friend's crab drops by", stat: 'visitorsHosted', goal: 1, rewards: ['sea-glass', 'friendship-bracelet'] },
  { id: 'pen-pals', name: 'Pen Pals', icon: '💌', description: 'Wave to friends 5 times', stat: 'wavesSent', goal: 5, rewards: ['message-bottle'] },
  { id: 'green-light', name: 'Green Light', icon: '🟢', description: 'Fix a failing build on one of your pull requests', stat: 'buildsFixed', goal: 1, rewards: ['green-flag'] },
  // Up on your windows (src/main/perch.js).
  { id: 'window-sill', name: 'Window Sill', icon: '🪟', description: 'Shellby climbs up onto one of your windows', stat: 'perchesMade', goal: 1, rewards: ['spyglass'] },
  { id: 'hang-on', name: 'Hang On!', icon: '🎢', description: 'Drag a window 2,000 px with Shellby riding it', stat: 'longestRide', goal: 2000, rewards: ['racing-goggles'] },
  { id: 'rodeo', name: 'Rodeo', icon: '🤠', description: 'Shake Shellby off a window 10 times', stat: 'timesShaken', goal: 10, rewards: ['cowboy-hat'], hidden: true },
  { id: 'leap-of-faith', name: 'Leap of Faith', icon: '🪂', description: 'Shellby falls off one window and lands on another', stat: 'windowLeaps', goal: 1, rewards: ['parachute'], hidden: true },
  { id: 'trapeze', name: 'Trapeze', icon: '🎪', description: 'Throw Shellby onto a window and he catches the title bar', stat: 'windowCatches', goal: 1, rewards: ['ringmaster-collar'], hidden: true },
  // Shell stickers (src/main/stickers.js).
  { id: 'tagged', name: 'Tagged', icon: '🏷️', description: 'Ship a project and earn its sticker', stat: 'stickersEarned', goal: 1, rewards: ['sticker-sheet'] },
  { id: 'sticker-bomb', name: 'Sticker Bomb', icon: '🎨', description: 'Ship 10 different projects', stat: 'stickersEarned', goal: 10, rewards: ['paint-can'] },
  { id: 'shiny', name: 'Shiny', icon: '✨', description: 'Ship one project often enough that its sticker goes holo', stat: 'holoStickers', goal: 1, rewards: ['holo-visor'] },
  { id: 'liftoff', name: 'Liftoff', icon: '🚀', description: 'Release version 1.0 of something', stat: 'majorReleases', goal: 1, rewards: ['rocket'] },
  { id: 'well-traveled', name: 'Well Traveled', icon: '🧳', description: 'Put stickers on 3 different shells', stat: 'stickeredShells', goal: 3, rewards: ['luggage-tag'] },
  { id: 'swap-meet', name: 'Swap Meet', icon: '🤝', description: "A visiting friend's crab leaves you one of their stickers", stat: 'friendStickers', goal: 1, rewards: ['trade-binder'] },
  // Just the two of you (src/main/life.js, gifts.js, bond.js, playtime.js). None of these need Claude.
  { id: 'beachcomber', name: 'Beachcomber', icon: '🐚', description: 'Shellby digs you up his first gift', stat: 'findsMade', goal: 1, rewards: ['sand-pail'] },
  { id: 'magpie', name: 'Magpie', icon: '🐦', description: 'Shellby digs you up 25 gifts', stat: 'findsMade', goal: 25, rewards: ['metal-detector'] },
  { id: 'curator', name: 'Curator', icon: '🏛️', description: 'Complete a set of finds on the shelf', stat: 'setsCompleted', goal: 1, rewards: ['treasure-chest'] },
  { id: 'x-marks', name: 'X Marks the Spot', icon: '🗺️', description: 'Shellby digs up something legendary', stat: 'legendaryFinds', goal: 1, rewards: ['doubloon-medal'], hidden: true },
  { id: 'best-friends', name: 'Best Friends', icon: '💞', description: 'Become best friends with Shellby', stat: 'bondLevel', goal: 4, rewards: ['friendship-locket'] },
  { id: 'peekaboo', name: 'Peekaboo', icon: '🙈', description: 'Find Shellby in hide and seek', stat: 'hidesFound', goal: 1, rewards: ['leafy-disguise'] },
  { id: 'good-arm', name: 'Good Arm', icon: '🎾', description: 'Play fetch with Shellby 10 times', stat: 'fetches', goal: 10, rewards: ['tennis-ball'] },
  { id: 'player-two', name: 'Player Two', icon: '🎮', description: 'Shellby watches you finish 5 games', stat: 'gamesWatched', goal: 5, rewards: ['game-controller'], hidden: true },
  { id: 'on-air', name: 'Quiet on Set', icon: '🤫', description: 'Shellby keeps quiet through 5 calls', stat: 'callsHushed', goal: 5, rewards: ['on-air-light'], hidden: true },
  { id: 'storyteller', name: 'Little Scenes', icon: '🎭', description: 'Catch Shellby in 10 different little scenes', stat: 'scenesSeen', goal: 10, rewards: ['bubble-pipe'] },
  { id: 'gossip', name: 'Gossip', icon: '💬', description: 'Your crab chats with visiting crabs 5 times', stat: 'banters', goal: 5, rewards: ['tin-can-phone'] },
  // The shipyard: the work XP already pays for (xp.js AWARDS), fed from awardXp in main.js.
  { id: 'launch-day', name: 'Launch Day', icon: '🛰️', description: 'Deploy or publish something', stat: 'deploys', goal: 1, rewards: ['mission-patch'] },
  { id: 'back-to-green', name: 'Back to Green', icon: '🧪', description: 'Turn failing tests green 10 times', stat: 'testsFixed', goal: 10, rewards: ['test-tube'] },
  { id: 'ghostbuster', name: 'Ghostbuster', icon: '👻', description: 'Fix a flaky test for good', stat: 'flakesFixed', goal: 1, rewards: ['proton-pack'], hidden: true },
  { id: 'issue-to-ship', name: 'Issue to Ship', icon: '🧭', description: 'Take an issue all the way to a pull request', stat: 'issuesShipped', goal: 1, rewards: ['ships-wheel'] },
  { id: 'clean-bill', name: 'Clean Bill', icon: '📋', description: 'Get a clean dependency audit', stat: 'cleanAudits', goal: 1, rewards: ['clipboard'] },
  { id: 'tidy-shell', name: 'Tidy Shell', icon: '🪶', description: 'Turn off a plugin or MCP server that sits idle', stat: 'toolsTidied', goal: 1, rewards: ['feather-duster'] },
  { id: 'fresh-start', name: 'Fresh Start', icon: '📝', description: 'Start a crowded conversation fresh with a summary', stat: 'freshStarts', goal: 1, rewards: ['fresh-page'] },
  { id: 'on-a-roll', name: 'On a Roll', icon: '🔥', description: 'Keep a 7-day streak going', stat: 'longestStreak', goal: 7, rewards: ['flame-scarf'] },
  { id: 'unstoppable', name: 'Unstoppable', icon: '☄️', description: 'Keep a 30-day streak going', stat: 'longestStreak', goal: 30, rewards: ['blazing-crest'], hidden: true },
  { id: 'double-digits', name: 'Double Digits', icon: '🪸', description: 'Reach level 10', stat: 'level', goal: 10, rewards: ['coral-laurel'] },
].map(a => Object.freeze({ hidden: false, ...a, rewards: Object.freeze(a.rewards) })));

const KNOWN_ACHIEVEMENTS = new Set(ACHIEVEMENTS.map(a => a.id));

const COUNTERS = [
  'tasksCompleted', 'helpersSpawned', 'maxCrew', 'tricksLearned', 'createdScriptsRun', 'routinesRun',
  'nightTasks', 'earlyTasks', 'maxParallel', 'permissionsAnswered', 'plansApproved', 'filesDropped',
  'healthViews', 'heatCooled', 'spaceFreed', 'cardsShared', 'petsGiven', 'timesThrown', 'focusSessions', 'buildsFixed', 'visitorsHosted', 'wavesSent',
  'perchesMade', 'timesShaken', 'windowLeaps', 'windowCatches', 'longestRide',
  'stickersEarned', 'holoStickers', 'majorReleases', 'stickeredShells', 'friendStickers',
  'findsMade', 'setsCompleted', 'legendaryFinds', 'bondLevel', 'hidesFound', 'fetches', 'gamesWatched', 'callsHushed', 'scenesSeen', 'banters',
  'deploys', 'testsFixed', 'flakesFixed', 'issuesShipped', 'cleanAudits', 'toolsTidied', 'freshStarts', 'longestStreak', 'level',
];
const MAX_DAYS = 400;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Simple "+1" events.
const INCREMENTS = {
  'helper-spawned': 'helpersSpawned',
  'trick-learned': 'tricksLearned',
  'created-script-approved': 'createdScriptsRun',
  'routine-run': 'routinesRun',
  'permission-answered': 'permissionsAnswered',
  'plan-approved': 'plansApproved',
  'files-dropped': 'filesDropped',
  'health-viewed': 'healthViews',
  'health-cooled': 'heatCooled',
  'health-space-freed': 'spaceFreed',
  'card-shared': 'cardsShared',
  petted: 'petsGiven',
  thrown: 'timesThrown',
  'focus-completed': 'focusSessions',
  'ci-fixed': 'buildsFixed',
  'visitor-hosted': 'visitorsHosted',
  'wave-sent': 'wavesSent',
  perched: 'perchesMade',
  shaken: 'timesShaken',
  'window-leap': 'windowLeaps',
  'caught-on-window': 'windowCatches',
  'find-made': 'findsMade',
  'set-completed': 'setsCompleted',
  'legendary-find': 'legendaryFinds',
  'hide-found': 'hidesFound',
  fetched: 'fetches',
  'game-watched': 'gamesWatched',
  'call-hushed': 'callsHushed',
  banter: 'banters',
  deployed: 'deploys',
  'tests-fixed': 'testsFixed',
  'flake-fixed': 'flakesFixed',
  'issue-shipped': 'issuesShipped',
  'deps-clean': 'cleanAudits',
  'toolbox-tidied': 'toolsTidied',
  'started-fresh': 'freshStarts',
};
// "Keep the high-water mark" events: payload { n }.
const MAXIMA = {
  'crew-size': 'maxCrew', parallel: 'maxParallel', ride: 'longestRide',
  // Shell stickers (src/main/stickers.js) report their totals.
  'stickers-earned': 'stickersEarned', 'holo-stickers': 'holoStickers', 'one-point-oh': 'majorReleases', 'stickered-shells': 'stickeredShells', 'friend-stickers': 'friendStickers',
  // Bond level and the number of different scenes seen (src/main/life.js) report their totals.
  'bond-level': 'bondLevel', 'scenes-seen': 'scenesSeen',
  // The longest streak (streaks.js) and the XP level (xp.js), reported by awardXp in main.js.
  streak: 'longestStreak', level: 'level',
};

function emptyStats() {
  const s = {};
  for (const k of COUNTERS) s[k] = 0;
  s.activeDays = [];
  return s;
}

const count = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

// Deduped, sorted oldest → newest, keeping only the most recent MAX_DAYS.
function cleanDays(days) {
  if (!Array.isArray(days)) return [];
  const set = new Set(days.filter(d => typeof d === 'string' && DAY_RE.test(d)));
  return [...set].sort().slice(-MAX_DAYS);
}

/** Tolerate anything read from disk: missing, negative, NaN, wrong types. */
function normalizeStats(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const s = emptyStats();
  for (const k of COUNTERS) s[k] = count(Object.prototype.hasOwnProperty.call(src, k) ? src[k] : 0);
  s.activeDays = cleanDays(src.activeDays);
  return s;
}

function localDay(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Apply one event. Returns a new Stats object; `stats` is never mutated. */
function recordStat(stats, event, payload = {}, now = new Date()) {
  const s = normalizeStats(stats);
  const when = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const markActive = () => { s.activeDays = cleanDays([...s.activeDays, localDay(when)]); };

  if (event === 'task-completed') {
    s.tasksCompleted += 1;
    const h = when.getHours();
    if (h < 5) s.nightTasks += 1;
    else if (h < 8) s.earlyTasks += 1;
    markActive();
  } else if (event === 'active') {
    markActive();
  } else if (Object.prototype.hasOwnProperty.call(INCREMENTS, event)) {
    s[INCREMENTS[event]] += 1;
  } else if (Object.prototype.hasOwnProperty.call(MAXIMA, event)) {
    const k = MAXIMA[event];
    s[k] = Math.max(s[k], count(payload && payload.n));
  }
  return s;
}

/** Numeric value of a stat (activeDays → number of days). */
function statValue(stats, stat) {
  if (stat === 'activeDays') return Array.isArray(stats && stats.activeDays) ? stats.activeDays.length : 0;
  return count(stats && stats[stat]);
}

/** Ids of achievements newly earned: goal met and not already in `unlocked`. */
function evaluate(stats, unlocked = new Set()) {
  return ACHIEVEMENTS.filter(a => !unlocked.has(a.id) && statValue(stats, a.stat) >= a.goal).map(a => a.id);
}

/** Display rows for the UI. Secret achievements stay secret until done. */
function progress(stats, unlocked = new Set()) {
  return ACHIEVEMENTS.map(a => {
    const value = statValue(stats, a.stat);
    const done = unlocked.has(a.id) || value >= a.goal;
    const secret = a.hidden && !done;
    return {
      id: a.id,
      name: secret ? '???' : a.name,
      description: secret ? 'A secret achievement' : a.description,
      icon: a.icon,
      current: done ? a.goal : Math.min(value, a.goal),
      goal: a.goal,
      done,
      rewards: [...a.rewards],
      hidden: a.hidden,
    };
  });
}

module.exports = {
  ACHIEVEMENTS, KNOWN_ACHIEVEMENTS, emptyStats, normalizeStats, recordStat, statValue, evaluate, progress,
};
