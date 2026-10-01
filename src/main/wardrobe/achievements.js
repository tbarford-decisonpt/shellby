// Achievements: small milestones that unlock wardrobe items. Stats are a flat,
// JSON-friendly object persisted by the caller; everything here is pure, so
// recordStat returns a new object instead of mutating.
// Rewards are item keys in the built-in pack (src/wardrobe/base.pack.json).

const ACHIEVEMENTS = Object.freeze([
  { id: 'first-task', name: 'Hello, World', icon: '🐚', description: 'Finish your first task', stat: 'tasksCompleted', goal: 1, rewards: ['party-hat', 'confetti'] },
  { id: 'ten-tasks', name: 'Regular', icon: '🔨', description: 'Finish 10 tasks', stat: 'tasksCompleted', goal: 10, rewards: ['hard-hat'] },
  { id: 'quarter-century', name: 'Distinguished', icon: '🎩', description: 'Finish 25 tasks', stat: 'tasksCompleted', goal: 25, rewards: ['top-hat'] },
  { id: 'centurion', name: 'Crab Royalty', icon: '👑', description: 'Finish 100 tasks', stat: 'tasksCompleted', goal: 100, rewards: ['crown'] },
  { id: 'crew-boss', name: 'Crew Boss', icon: '⚓', description: 'Send out your first helper agent', stat: 'helpersSpawned', goal: 1, rewards: ['captains-hat'] },
  { id: 'all-hands', name: 'All Hands', icon: '🏴‍☠️', description: 'Have 3 helpers working at once', stat: 'maxCrew', goal: 3, rewards: ['pirate-bandana'] },
  { id: 'fleet', name: 'Fleet Admiral', icon: '⛵', description: 'Send out 25 helpers in total', stat: 'helpersSpawned', goal: 25, rewards: ['jolly-roger'] },
  { id: 'toolmaker', name: 'Toolmaker', icon: '🎓', description: 'Shellby learns his first new trick', stat: 'tricksLearned', goal: 1, rewards: ['grad-cap'] },
  { id: 'inventor', name: 'Inventor', icon: '🧙', description: 'Shellby learns 5 new tricks', stat: 'tricksLearned', goal: 5, rewards: ['wizard-hat'] },
  { id: 'tinkerer', name: 'Tinkerer', icon: '🔧', description: 'Approve running a script Shellby wrote', stat: 'createdScriptsRun', goal: 1, rewards: ['wrench'] },
  { id: 'clockwork', name: 'Clockwork', icon: '⏱️', description: 'Run your first routine', stat: 'routinesRun', goal: 1, rewards: ['pocket-watch'] },
  { id: 'night-owl', name: 'Night Owl', icon: '🦉', description: 'Finish a task between midnight and 5 AM', stat: 'nightTasks', goal: 1, rewards: ['nightcap'], hidden: true },
  { id: 'early-bird', name: 'Early Bird', icon: '☕', description: 'Finish a task between 5 and 8 AM', stat: 'earlyTasks', goal: 1, rewards: ['coffee-mug'], hidden: true },
  { id: 'multitasker', name: 'Multitasker', icon: '🎧', description: 'Run 3 conversations at the same time', stat: 'maxParallel', goal: 3, rewards: ['headphones'] },
  { id: 'careful', name: 'Safety First', icon: '🥽', description: 'Answer 25 permission prompts', stat: 'permissionsAnswered', goal: 25, rewards: ['safety-goggles'] },
  { id: 'planner', name: 'Master Planner', icon: '🧐', description: 'Approve a plan from Plan mode', stat: 'plansApproved', goal: 1, rewards: ['monocle'] },
  { id: 'special-delivery', name: 'Special Delivery', icon: '✈️', description: 'Drop a file on Shellby', stat: 'filesDropped', goal: 1, rewards: ['paper-plane'] },
  { id: 'loyal', name: 'Old Friends', icon: '🌈', description: 'Use Shellby on 7 different days', stat: 'activeDays', goal: 7, rewards: ['rainbow-scarf'] },
  { id: 'check-up', name: 'Check-Up', icon: '🩺', description: "Look at your PC's vitals in the Health view", stat: 'healthViews', goal: 1, rewards: ['stethoscope'] },
  { id: 'keep-your-cool', name: 'Keep Your Cool', icon: '🧊', description: 'Shellby cools down after a heat warning', stat: 'heatCooled', goal: 1, rewards: ['sweatband', 'hand-fan'], hidden: true },
  { id: 'spring-cleaning', name: 'Spring Cleaning', icon: '🧹', description: 'Free up space after a low-disk warning', stat: 'spaceFreed', goal: 1, rewards: ['broom'] },
].map(a => Object.freeze({ hidden: false, ...a, rewards: Object.freeze(a.rewards) })));

const KNOWN_ACHIEVEMENTS = new Set(ACHIEVEMENTS.map(a => a.id));

const COUNTERS = [
  'tasksCompleted', 'helpersSpawned', 'maxCrew', 'tricksLearned', 'createdScriptsRun', 'routinesRun',
  'nightTasks', 'earlyTasks', 'maxParallel', 'permissionsAnswered', 'plansApproved', 'filesDropped',
  'healthViews', 'heatCooled', 'spaceFreed',
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
};
// "Keep the high-water mark" events: payload { n }.
const MAXIMA = { 'crew-size': 'maxCrew', parallel: 'maxParallel' };

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
