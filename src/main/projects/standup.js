// A project's standup ("Yesterday / Today / Blockers") and its weekly report,
// ready to paste into Slack or an email. The work-focused sibling of the
// weekly crab card (weekly.js): built from your own commits, the Claude
// conversations you had in the project, the time tracked on it and the notes
// you wrote for the day, with blockers from what the Projects page already
// flags (failing checks, a crashed dev server, serious vulnerabilities, flaky
// tests). Projects.report() gathers the sources; this words them.
//
// Pure: no I/O, no clock (callers pass `now`). See test/projects-standup.test.js.
const { caseKey } = require('./merge');
const tt = require('../timetrack');

const KINDS = Object.freeze(['standup', 'week', 'last-week']);
const LOOKBACK_DAYS = 7;   // "yesterday" is the last day with work in it, up to a week back
const OPEN_DAYS = 3;       // an unfinished conversation this recent is still on today's list
const MAX_ITEMS = 8;       // per section; the rest become "and N more"
const MAX_TITLE = 100;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayKey = t => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const startOfDay = t => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
// Calendar days, not 24-hour steps, so a DST change can't skip or repeat one.
const addDays = (t, n) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime(); };
const dayStart = key => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
// Commit messages come from git and titles from History: no control, bidi or zero-width characters.
const clip = (s, n) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n) : '');
const inRange = (t, w) => Number.isFinite(t) && t >= w.from && t < w.to;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const shortDay = key => new Date(dayStart(key)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const monthDay = t => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/**
 * The days a report reads, [from, to) in ms. A standup looks back a week for
 * the last day with work; a week runs Monday to today (or all of last week),
 * the way the Time page's weeks do.
 */
function windowOf(kind, now) {
  const today = startOfDay(now);
  if (kind === 'standup') return { from: addDays(today, -LOOKBACK_DAYS), to: addDays(today, 1) };
  const monday = addDays(today, -((new Date(today).getDay() + 6) % 7));
  if (kind === 'last-week') return { from: addDays(monday, -7), to: monday };
  return { from: monday, to: addDays(today, 1) };
}

// ------------------------------------------------------------------ commits

// Conventional-commit types, as the report groups them. Anything else is "other".
const TYPES = { feat: 'built', feature: 'built', fix: 'fixed', bugfix: 'fixed', hotfix: 'fixed', perf: 'other', refactor: 'other', docs: 'other', test: 'other', tests: 'other', ci: 'other', build: 'other', style: 'other', chore: 'chore', revert: 'other' };
const CONVENTIONAL = /^([a-z]+)(?:\([^)]{0,40}\))?!?:\s*(.+)$/i;
const RELEASE = /^v?\d+\.\d+\.\d+(?:[-+][\w.]+)?\b[:\s-]*(.*)$/i;
const NOISE = /^(?:merge (?:branch|pull request|remote-tracking)|wip$|fixup!|squash!)/i;

const capital = s => s.charAt(0).toUpperCase() + s.slice(1);

/** A commit subject -> { kind, text } for the report, or null for merge and WIP noise. */
function readCommit(subject) {
  const s = clip(subject, 200);
  if (!s || NOISE.test(s)) return null;
  const rel = RELEASE.exec(s);
  if (rel) {
    const version = s.match(/^v?\d+\.\d+\.\d+(?:[-+][\w.]+)?/)[0].replace(/^v/i, '');
    return { kind: 'release', text: rel[1] ? `Released ${version}: ${rel[1]}` : `Released ${version}` };
  }
  const conv = CONVENTIONAL.exec(s);
  if (conv && TYPES[conv[1].toLowerCase()]) return { kind: TYPES[conv[1].toLowerCase()], text: capital(conv[2].trim()) };
  return { kind: 'other', text: capital(s) };
}

// ------------------------------------------------------------------ the sources, by day

/**
 * Tracked time and the day's notes for a project's clones:
 * { 'YYYY-MM-DD': { seconds, notes: [text] } }. timeState: config.timeTracking.
 */
function timeByDay(timeState, roots, w) {
  const out = {};
  if (!timeState) return out;
  const range = { from: dayKey(w.from), to: dayKey(w.to - 1) };
  const keys = [...new Set((roots || []).map(caseKey))];
  for (const key of keys) {
    for (const p of tt.summarize(timeState, range, { only: { key } }).projects) {
      for (const r of p.days) {
        const d = out[r.day] || { seconds: 0, notes: [] };
        out[r.day] = { seconds: d.seconds + r.total, notes: r.note && !d.notes.includes(r.note) ? [...d.notes, r.note] : d.notes };
      }
    }
  }
  return out;
}

/** Tasks Claude finished in the project each day (weekly.js keeps them by repo name). */
function tasksByDay(weeklyState, names) {
  const out = {};
  const days = weeklyState?.days && typeof weeklyState.days === 'object' ? weeklyState.days : {};
  const wanted = new Set((names || []).map(n => String(n).toLowerCase()));
  for (const [day, d] of Object.entries(days)) {
    if (!DAY_RE.test(day)) continue;
    let n = 0;
    for (const [name, count] of Object.entries(d?.work || {})) if (wanted.has(name.toLowerCase()) && Number.isFinite(count)) n += count;
    if (n > 0) out[day] = n;
  }
  return out;
}

/**
 * What the report needs to know about a project, from its page (Projects.detail)
 * and the sources around it.
 *   detail:   { name, local: [{ root, servers }], insights: { prs, deps, flaky } }
 *   commits:  [{ at, subject }] your commits in the window, from every clone
 *   sessions: [{ title, createdAt, updatedAt, done, routineId }] conversations in it
 *   time:     timeByDay(); tasks: tasksByDay()
 */
function inputFrom(detail, { commits = [], sessions = [], time = {}, tasks = {} } = {}) {
  const seen = new Set();
  const own = [];
  for (const c of commits) {
    if (!Number.isFinite(c?.at)) continue;
    const id = `${c.at}|${c.subject}`;
    if (seen.has(id)) continue; // the same commit, seen from two clones
    seen.add(id);
    own.push({ at: c.at, subject: clip(c.subject, 200) });
  }
  return {
    name: clip(detail?.name, 80) || 'project',
    commits: own.sort((a, b) => a.at - b.at),
    // Routines ran by themselves: that's not something you did.
    sessions: (sessions || []).filter(s => s && !s.routineId).map(s => ({
      title: clip(s.title, MAX_TITLE) || 'Conversation',
      createdAt: Number(s.createdAt) || 0, updatedAt: Number(s.updatedAt || s.createdAt) || 0, done: !!s.done,
    })),
    time: time || {},
    tasks: tasks || {},
    blockers: blockersOf(detail),
    reviews: reviewsOf(detail),
    openPrs: openPrsOf(detail),
  };
}

const prName = pr => `${pr.forge === 'gitlab' ? '!' : '#'}${pr.number} ${clip(pr.title, MAX_TITLE)}`;

/** What's in your way, from what the Projects page flags. */
function blockersOf(detail) {
  const i = detail?.insights || {};
  const out = [];
  for (const pr of i.prs || []) {
    if (pr.state !== 'failing') continue;
    const checks = (pr.failing || []).map(c => clip(c, 40)).filter(Boolean).slice(0, 3);
    out.push(`${prName(pr)}: checks failing${checks.length ? ` (${checks.join(', ')})` : ''}`);
  }
  for (const c of detail?.local || []) {
    for (const s of c.servers || []) {
      if (s.status === 'crashed' && !s.missed) out.push(`Dev server${s.script ? ` "${clip(s.script, 40)}"` : ''} ${s.neverUp ? "won't start" : 'crashed'}`);
      if (s.status === 'failed') out.push('Installing dependencies failed');
    }
  }
  const v = i.deps?.ok ? i.deps.vulns || {} : {};
  const serious = (v.critical || 0) + (v.high || 0);
  if (serious) out.push(`${plural(serious, 'high or critical vulnerability', 'high or critical vulnerabilities')} in dependencies`);
  for (const f of i.flaky || []) {
    if (f.status === 'watching' && f.week > 0) out.push(`Flaky test: ${clip(f.label, 80)} (${plural(f.week, 'flake')} this week)`);
  }
  return out;
}

/** Pull requests with review comments to answer: today's work. */
function reviewsOf(detail) {
  return (detail?.insights?.prs || []).filter(pr => pr.reviewComments > 0).map(pr => `Address the review on ${prName(pr)}`);
}

/** Pull requests still open, for the week's "still open". */
function openPrsOf(detail) {
  return (detail?.insights?.prs || []).map(pr => `${prName(pr)}${pr.state === 'failing' ? ' (checks failing)' : pr.state === 'passing' ? ' (checks green)' : ''}`);
}

// One day's work (or a range's): commits read, conversations, time, notes.
function workIn(input, w) {
  const commits = input.commits.filter(c => inRange(c.at, w)).map(c => readCommit(c.subject)).filter(Boolean);
  const sessions = input.sessions.filter(s => inRange(s.createdAt, w) || inRange(s.updatedAt, w));
  let seconds = 0, tasks = 0;
  const notes = [];
  for (let t = w.from; t < w.to; t = addDays(t, 1)) {
    const day = dayKey(t);
    const d = input.time[day];
    if (d) { seconds += d.seconds || 0; for (const n of d.notes || []) if (!notes.includes(n)) notes.push(n); }
    tasks += input.tasks[day] || 0;
  }
  return { commits, sessions, seconds, tasks, notes };
}

const hasWork = x => !!(x.commits.length || x.sessions.length || x.seconds >= 60 || x.notes.length);
const uniq = list => [...new Set(list)];

// A day's bullets: what you wrote down first, then what you committed, then the conversations.
function dayItems(x) {
  return uniq([
    ...x.notes,
    ...x.commits.map(c => c.text),
    ...x.sessions.map(s => `Worked with Claude on "${s.title}"${s.done ? ' (done)' : ''}`),
  ]);
}

// ------------------------------------------------------------------ the reports

/**
 * The standup: { kind, title, sections: [{ id, title, meta, items, empty }] }.
 * Yesterday is the last day before today with any work in it (Friday's, on a
 * Monday); Today is what's done so far, unfinished conversations and reviews
 * to answer; Blockers is what's failing.
 */
function standup(input, now) {
  const today = startOfDay(now);
  const day = t => ({ from: t, to: addDays(t, 1) });
  let prev = null;
  for (let back = 1; back <= LOOKBACK_DAYS && !prev; back++) {
    const t = addDays(today, -back);
    if (hasWork(workIn(input, day(t)))) prev = t;
  }
  const yesterday = addDays(today, -1);
  const prevDay = prev ?? yesterday;
  const before = workIn(input, day(prevDay));
  const now_ = workIn(input, day(today));

  // Unfinished conversations from the last few days that today hasn't already touched.
  const recent = { from: addDays(today, -OPEN_DAYS), to: today };
  const touchedToday = new Set(now_.sessions.map(s => s.title));
  const carryOn = uniq(input.sessions
    .filter(s => !s.done && inRange(s.updatedAt, recent) && !touchedToday.has(s.title))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(s => `Carry on with "${s.title}"`));

  return {
    kind: 'standup',
    title: `${input.name} standup, ${shortDay(dayKey(today))}`,
    sections: [
      { id: 'yesterday', title: 'Yesterday', meta: [prev !== null && prev !== yesterday ? shortDay(dayKey(prev)) : '', timeMeta(before.seconds)].filter(Boolean).join(' · '), items: dayItems(before), empty: 'Nothing logged' },
      { id: 'today', title: 'Today', meta: timeMeta(now_.seconds), items: uniq([...dayItems(now_), ...input.reviews, ...carryOn]), empty: 'Nothing logged yet' },
      { id: 'blockers', title: 'Blockers', meta: '', items: input.blockers, empty: 'None' },
    ],
  };
}

const timeMeta = seconds => (seconds >= 60 ? `${tt.duration(seconds)} tracked` : '');

/**
 * The week: a line of totals, what shipped / was built / was fixed, the
 * conversations, your notes, what's still open, and blockers.
 * kind: 'week' (Monday to today) | 'last-week'.
 */
function weekly(input, now, kind = 'week') {
  const w = windowOf(kind, now);
  const x = workIn(input, w);
  const by = k => uniq(x.commits.filter(c => c.kind === k).map(c => c.text));
  const activeDays = [];
  for (let t = w.from; t < w.to; t = addDays(t, 1)) if (hasWork(workIn(input, { from: t, to: addDays(t, 1) }))) activeDays.push(t);

  const totals = [
    x.seconds >= 60 && `${tt.duration(x.seconds)} tracked`,
    activeDays.length && `${plural(activeDays.length, 'day')} active`,
    x.commits.length && plural(x.commits.length, 'commit'),
    x.sessions.length && plural(x.sessions.length, 'conversation') + ' with Claude',
    x.tasks && `${plural(x.tasks, 'task')} Claude finished`,
  ].filter(Boolean);
  // Hours a day, when time was tracked: "Mon 2h 10m · Tue 45m".
  const perDay = [];
  for (let t = w.from; t < w.to; t = addDays(t, 1)) {
    const s = input.time[dayKey(t)]?.seconds || 0;
    if (s >= 60) perDay.push(`${new Date(t).toLocaleDateString('en-US', { weekday: 'short' })} ${tt.duration(s)}`);
  }

  const openTalks = input.sessions.filter(s => !s.done && inRange(s.updatedAt, w)).sort((a, b) => b.updatedAt - a.updatedAt).map(s => `"${s.title}"`);
  const sections = [
    { id: 'shipped', title: 'Shipped', items: by('release') },
    { id: 'built', title: 'Built', items: by('built') },
    { id: 'fixed', title: 'Fixed', items: by('fixed') },
    { id: 'other', title: 'Also', items: uniq([...by('other'), ...by('chore')]) },
    { id: 'notes', title: 'Notes', items: x.notes },
    { id: 'claude', title: 'With Claude', items: uniq([...x.sessions].sort((a, b) => a.createdAt - b.createdAt).map(s => `${s.title}${s.done ? ' (done)' : ''}`)) },
    { id: 'open', title: 'Still open', items: uniq([...input.openPrs, ...input.reviews, ...openTalks.map(t => `Conversation ${t}`)]) },
    { id: 'blockers', title: 'Blockers', items: input.blockers, empty: 'None' },
  ].filter(s => s.items.length || s.empty).map(s => ({ meta: '', empty: '', ...s }));

  const last = addDays(w.to, -1);
  return {
    kind,
    title: `${input.name}, week of ${monthDay(w.from)}${last > w.from ? ` – ${monthDay(last)}` : ''}`,
    summary: totals.length ? totals.join(' · ') : 'A quiet week: nothing logged',
    perDay: perDay.join(' · '),
    quiet: !hasWork(x),
    sections,
  };
}

/** kind: 'standup' | 'week' | 'last-week' -> the report. */
function build(kind, input, now) {
  return kind === 'standup' ? standup(input, now) : weekly(input, now, kind === 'last-week' ? 'last-week' : 'week');
}

// ------------------------------------------------------------------ words for Slack and email

// Pasted into Slack's composer, "@here" in a commit message would ping the
// whole channel: in code it's only text.
const quietMentions = s => s.replace(/(^|[^\w`])@(channel|here|everyone)\b/gi, '$1`@$2`');

function listOf(items, bullet, fmt) {
  const shown = items.slice(0, MAX_ITEMS).map(i => `${bullet}${fmt(i)}`);
  if (items.length > MAX_ITEMS) shown.push(`${bullet}and ${items.length - MAX_ITEMS} more`);
  return shown;
}

/** Slack's mrkdwn: bold headings, bullets, nothing that pings anyone. */
function toSlack(r) {
  const lines = [`*${quietMentions(r.title)}*`];
  if (r.summary) lines.push(`_${r.summary}_`);
  if (r.perDay) lines.push(r.perDay);
  for (const s of r.sections) {
    lines.push('', `*${s.title}*${s.meta ? ` (${s.meta})` : ''}`);
    lines.push(...(s.items.length ? listOf(s.items, '• ', quietMentions) : [`• _${s.empty}_`]));
  }
  return lines.join('\n');
}

/** Plain text for an email: headings and dashes, nothing to render. */
function toText(r) {
  const lines = [r.title];
  if (r.summary) lines.push(r.summary);
  if (r.perDay) lines.push(r.perDay);
  for (const s of r.sections) {
    lines.push('', `${s.title}${s.meta ? ` (${s.meta})` : ''}`);
    lines.push(...(s.items.length ? listOf(s.items, '- ', i => i) : [`- ${s.empty}`]));
  }
  return lines.join('\n');
}

module.exports = {
  KINDS, LOOKBACK_DAYS, MAX_ITEMS,
  windowOf, readCommit, timeByDay, tasksByDay, inputFrom, blockersOf,
  standup, weekly, build, toSlack, toText,
};
