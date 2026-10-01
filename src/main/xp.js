// XP and levels. Shellby earns XP when tasks finish, tests pass, code ships or
// deploys, and most of all when he writes himself a new skill or agent; enough
// XP and he levels up. Pure: no I/O, no clock (callers pass `now`). See test/xp.test.js.

const AWARDS = Object.freeze({
  task: { xp: 10, perHour: 60, label: 'Finished a task' },
  tests: { xp: 25, perHour: 6, label: 'Tests passed' },
  ship: { xp: 40, perHour: 4, label: 'Pushed code' },
  deploy: { xp: 50, perHour: 4, label: 'Deployed' },
  trick: { xp: 150, perHour: 3, label: 'Wrote himself a new trick' },
  trophy: { xp: 20, perHour: 30, label: 'Earned a trophy' },
  day: { xp: 5, perHour: 1, label: 'Another day together' },
});

const TITLES = [
  [1, 'Hatchling'], [2, 'Tide-pooler'], [3, 'Shell Seeker'], [4, 'Reef Runner'], [5, 'Claw Coder'],
  [6, 'Kelp Hacker'], [7, 'Shell Engineer'], [8, 'Reef Architect'], [9, 'Deep Diver'], [10, 'Coral Commander'],
  [12, 'Abyssal Admin'], [15, 'Leviathan'], [20, 'Legend of the Tides'],
];
const MAX_LEVEL = 99;
const LOG_MAX = 40;
const HOUR = 60 * 60 * 1000;

/** Total XP needed to reach `level` (level 1 = 0, 2 = 100, 3 = 250, 5 = 700, 10 = 2,700). */
function xpForLevel(level) {
  const l = Math.max(1, Math.min(MAX_LEVEL, Math.floor(level)));
  return 25 * (l - 1) * (l + 2);
}

function titleFor(level) {
  let t = TITLES[0][1];
  for (const [l, name] of TITLES) if (level >= l) t = name;
  return t;
}

/** { level, title, xp, floor, next, into, needed, progress (0..1) } for a total. */
function levelFor(total) {
  const xp = Math.max(0, Math.floor(Number(total) || 0));
  let level = 1;
  while (level < MAX_LEVEL && xp >= xpForLevel(level + 1)) level++;
  const floor = xpForLevel(level);
  const next = level < MAX_LEVEL ? xpForLevel(level + 1) : floor;
  return {
    level, title: titleFor(level), xp, floor, next,
    into: xp - floor, needed: next - floor,
    progress: next > floor ? (xp - floor) / (next - floor) : 1,
  };
}

/** Tolerate anything read from disk. */
function normalizeXp(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const total = Number.isFinite(src.total) && src.total > 0 ? Math.floor(src.total) : 0;
  const recent = {};
  for (const k of Object.keys(AWARDS)) {
    const list = Array.isArray(src.recent?.[k]) ? src.recent[k].filter(Number.isFinite) : [];
    recent[k] = list.slice(-AWARDS[k].perHour);
  }
  const log = (Array.isArray(src.log) ? src.log : []).filter(e => e && AWARDS[e.kind] && Number.isFinite(e.at)).slice(0, LOG_MAX);
  const lastDay = typeof src.lastDay === 'string' ? src.lastDay : null;
  return { total, recent, log, lastDay };
}

const dayKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Award XP for one event. Returns { state, gained, before, after, levelUp }
 * (state is a new object; the old one is never mutated). Over the hourly cap
 * (or a second 'day' on the same day) gains nothing.
 *   meta: { label?, project? } shown in the XP log
 */
function award(stateIn, kind, now, meta = {}) {
  const state = normalizeXp(stateIn);
  const rule = AWARDS[kind];
  const before = levelFor(state.total);
  const none = { state, gained: 0, before, after: before, levelUp: false };
  if (!rule) return none;
  const t = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(t)) return none;
  if (kind === 'day') {
    const day = dayKey(new Date(t));
    if (state.lastDay === day) return none;
    state.lastDay = day;
  }
  const recent = state.recent[kind].filter(at => t - at < HOUR);
  if (recent.length >= rule.perHour) return none;
  const next = {
    ...state,
    total: state.total + rule.xp,
    recent: { ...state.recent, [kind]: [...recent, t] },
    log: [{ at: t, kind, xp: rule.xp, label: clip(meta.label) || rule.label, project: clip(meta.project) || null }, ...state.log].slice(0, LOG_MAX),
  };
  const after = levelFor(next.total);
  return { state: next, gained: rule.xp, before, after, levelUp: after.level > before.level };
}

const clip = s => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 80) : '');

// ------------------------------------------------------------------ commands

// What a successful shell command means. Checked against the command text only
// (the caller already knows it succeeded); the most rewarding match wins.
const DEPLOY_RE = /\b(vercel(\s+deploy)?\s+--prod|vercel\s+deploy|netlify\s+deploy|fly(ctl)?\s+deploy|firebase\s+deploy|wrangler\s+(deploy|publish|pages\s+deploy)|railway\s+up|heroku\s+(container:release|releases?)|gh\s+release\s+create|npm\s+publish|pnpm\s+publish|yarn\s+npm\s+publish|cargo\s+publish|twine\s+upload|docker\s+push|kubectl\s+(apply|rollout)|helm\s+(upgrade|install)|terraform\s+apply|pulumi\s+up|serverless\s+deploy|sls\s+deploy|cdk\s+deploy|eb\s+deploy|az\s+webapp\s+deploy|gcloud\s+(app|run|functions)\s+deploy)\b/i;
const SHIP_RE = /\bgit\s+push\b/i;
const TEST_RE = /\b((npm|pnpm|yarn|bun)\s+(run\s+)?test(:\w+)?|node\s+--test|pytest|python\d*\s+-m\s+(pytest|unittest)|jest|vitest|mocha|ava|tap|go\s+test|cargo\s+(test|nextest)|dotnet\s+test|mvn\s+(-\S+\s+)*(test|verify)|gradlew?\s+(test|check)|phpunit|rspec|rake\s+test|mix\s+test|deno\s+test|playwright\s+test|cypress\s+run|ctest|tox|nox|swift\s+test|flutter\s+test|bats)\b/i;

/** 'deploy' | 'ship' | 'tests' | null for a command that succeeded. */
function classifyCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return null;
  const c = cmd.slice(0, 2000);
  if (/--dry-run|\s-n\s|--whatif|-WhatIf/i.test(c)) return null; // rehearsals don't count
  if (DEPLOY_RE.test(c)) return 'deploy';
  if (SHIP_RE.test(c)) return 'ship';
  if (TEST_RE.test(c)) return 'tests';
  return null;
}

module.exports = { AWARDS, TITLES, xpForLevel, titleFor, levelFor, normalizeXp, award, classifyCommand, MAX_LEVEL };
