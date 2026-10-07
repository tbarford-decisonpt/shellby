// One ranked list of what to work on in a project (docs/plans/next-up.md):
// your tasks (.shellby/tasks.md), the repository's open issues, and the loose
// ends in its code, in three tiers.
//
//   Now:      tasks under ## Now; issues in a milestone due within 3 days (or
//             overdue) or labelled urgent, that are yours or nobody's
//   Up next:  your other tasks; issues assigned to you, in the nearest
//             milestone or labelled shellby; FIXMEs
//   Later:    everything else
//
// In every tier your tasks come first, in the order you wrote them: ranking
// never reorders your file. The rest follow by score. Every item carries the
// reasons it's where it is, strongest first, so the list never looks arbitrary.
//
// A task that says "#42" stands in for issue 42 (the issue takes the task's
// place in your order), and a loose end that says TODO(#42) folds into it.
//
// Pure. test/backlog-rank.test.js.
const DAY = 24 * 60 * 60 * 1000;
const SOON_DAYS = 3;
const ACTIVE_DAYS = 14;
const STALE_DAYS = 180;
const TIERS = ['now', 'next', 'later'];

const PRIORITY = /^(?:priority[\s:/_-]*(?:high|urgent|critical)|p[01]|urgent|critical)$/i;
const BUG = /^(?:(?:type|kind)[\s:/_-]*)?bug$/i;
const TAG_POINTS = { FIXME: 2, HACK: 1, TODO: 0 };

const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "due in 6 days", "due today", "2 days overdue". */
function dueText(dueOn, now) {
  const days = Math.round((startOfDay(dueOn) - startOfDay(now)) / DAY);
  if (days === 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  return days > 0 ? `due in ${days} days` : `${plural(-days, 'day')} overdue`;
}

function startOfDay(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** The open milestone due soonest (overdue ones included), or null. */
function nearestMilestone(milestones) {
  return (Array.isArray(milestones) ? milestones : [])
    .filter(m => Number.isFinite(m?.dueOn))
    .sort((a, b) => a.dueOn - b.dueOn)[0] || null;
}

/**
 * An issue's score and reasons. -> { score, reasons: [text], urgent, soon }
 * reasons are strongest first.
 */
function scoreIssue(issue, { login, nearest, now }) {
  const signals = [];
  const add = (points, text) => signals.push({ points, text });
  const assignees = Array.isArray(issue.assignees) ? issue.assignees : [];
  const mine = !!login && assignees.some(a => same(a, login));
  const free = !assignees.length;
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  const m = issue.milestone;
  const inNearest = !!(m && nearest && m.number === nearest.number);
  const soon = inNearest && Number.isFinite(nearest.dueOn) && nearest.dueOn - now <= SOON_DAYS * DAY;
  const urgent = labels.some(l => PRIORITY.test(l));

  if (urgent) add(5, labels.find(l => PRIORITY.test(l)));
  if (mine) add(4, 'Assigned to you');
  if (inNearest) add(soon ? 5 : 3, `${m.title} · ${dueText(nearest.dueOn, now)}`);
  else if (m) add(1, Number.isFinite(m.dueOn) ? `${m.title} · ${dueText(m.dueOn, now)}` : `In ${m.title}`);
  if (labels.some(l => BUG.test(l))) add(2, 'Bug');
  if (labels.some(l => same(l, 'shellby'))) add(2, 'Labelled shellby');
  const thumbs = Number.isInteger(issue.thumbs) && issue.thumbs > 0 ? issue.thumbs : 0;
  if (thumbs) add(Math.log2(1 + thumbs), `${thumbs} 👍`);
  const age = Number.isFinite(issue.updatedAt) ? now - issue.updatedAt : null;
  if (age !== null && age <= ACTIVE_DAYS * DAY) add(1, 'Active lately');
  if (!mine && !free) add(-3, `@${assignees[0]} has it`);
  if (age !== null && age > STALE_DAYS * DAY) add(-1, '');

  const score = signals.reduce((s, x) => s + x.points, 0);
  // Strongest first; a penalty only shows when nothing speaks for it.
  const shown = [...signals].filter(s => s.text).sort((a, b) => b.points - a.points);
  const good = shown.filter(s => s.points > 0);
  const reasons = (good.length ? [...good, ...shown.filter(s => s.points <= 0)] : shown).map(s => s.text);
  return { score, reasons, mine, free, urgent, soon, inNearest };
}

function issueTier(s, issue) {
  const forUs = s.mine || s.free;
  if (forUs && (s.soon || s.urgent)) return 'now';
  if (s.mine || s.inNearest || (issue.labels || []).some(l => same(l, 'shellby'))) return 'next';
  return 'later';
}

const issueItem = (issue, s, tier) => ({
  id: `gh:${issue.key}`,
  kind: 'issue',
  tier,
  title: issue.title,
  reason: s.reasons[0] || `#${issue.number}`,
  reasons: s.reasons,
  score: s.score,
  issue,
  todos: [],
});

/**
 * Everything -> the ranked list.
 *   tasks: tasks.parse(...).items. issues: backlog/github.js items, or null when
 *   GitHub wasn't read (then a "#42" task stays a task). milestones: open ones.
 *   todos: loose ends ({ file, line, tag, text, ref }). repo: owner/name or null.
 *   complete: issues holds every open one (so a "#42" not in it has closed), not just the first page.
 * -> { items: [{ id, kind, tier, title, reason, reasons, ... }], milestone }
 */
function rank({ tasks = [], issues = null, complete = true, milestones = [], todos = [], repo = null, login = null, now = Date.now() } = {}) {
  const known = Array.isArray(issues);
  const nearest = nearestMilestone(milestones);
  const byNumber = new Map();
  for (const i of known ? issues : []) if (Number.isInteger(i?.number)) byNumber.set(i.number, i);
  const refersHere = ref => ref && (!ref.repo || same(ref.repo, repo));
  const claimed = new Set();
  const ordered = { now: [], next: [], later: [] };   // your order
  const scored = { now: [], next: [], later: [] };    // the rest, by score

  for (const t of tasks) {
    const tierOfTask = TIERS.includes(t.section) ? t.section : 'next';
    // The first task to name an issue claims it; a second one stays a task, or there'd be two of the same row.
    const issue = refersHere(t.ref) && !claimed.has(t.ref.number) ? byNumber.get(t.ref.number) : null;
    if (issue) {
      claimed.add(issue.number);
      const s = scoreIssue(issue, { login, nearest, now });
      // Your order, but Now still wins if the issue has become urgent.
      const tier = issueTier(s, issue) === 'now' ? 'now' : tierOfTask;
      const note = t.ref.note ? [t.ref.note, ...t.notes] : t.notes;
      ordered[tier].push({ ...issueItem(issue, s, tier), task: { id: t.id, line: t.line, notes: note }, reasons: ['On your list', ...s.reasons], reason: s.reasons[0] || 'On your list' });
      continue;
    }
    // A reference to an issue of this repository that GitHub no longer lists as open: closed.
    const closed = known && complete && refersHere(t.ref) && !byNumber.has(t.ref.number);
    const reason = closed ? `#${t.ref.number} is closed` : tierOfTask === 'now' ? 'Now, on your list' : tierOfTask === 'later' ? 'Later, on your list' : 'On your list';
    ordered[tierOfTask].push({
      id: t.id, kind: 'task', tier: tierOfTask, title: t.title, reason, reasons: [reason], score: 0,
      task: { id: t.id, line: t.line, notes: t.notes, ref: t.ref || null, closed },
    });
  }

  const unclaimed = known ? issues.filter(i => !claimed.has(i.number)) : [];
  const issueItems = new Map();
  for (const issue of unclaimed) {
    const s = scoreIssue(issue, { login, nearest, now });
    const item = issueItem(issue, s, issueTier(s, issue));
    issueItems.set(issue.number, item);
    scored[item.tier].push(item);
  }
  // Issues on your list can have loose ends too.
  for (const tier of TIERS) for (const it of ordered[tier]) if (it.kind === 'issue') issueItems.set(it.issue.number, it);

  for (const t of Array.isArray(todos) ? todos : []) {
    const into = t.ref && refersHere(t.ref) ? issueItems.get(t.ref.number) : null;
    if (into) {
      into.todos.push({ file: t.file, line: t.line, tag: t.tag, text: t.text });
      continue;
    }
    const where = `${t.tag} in ${t.file}`;
    const tier = t.tag === 'FIXME' ? 'next' : 'later';
    scored[tier].push({
      id: `todo:${t.file}:${t.line}`, kind: 'todo', tier, title: t.text || `${t.tag} with no note`,
      reason: where, reasons: [where], score: TAG_POINTS[t.tag] ?? 0, todo: t,
    });
  }
  for (const it of issueItems.values()) {
    if (it.todos.length) it.reasons = [...it.reasons, plural(it.todos.length, 'loose end') + ' in the code'];
  }

  const byScore = (a, b) => b.score - a.score
    || (b.issue?.updatedAt || 0) - (a.issue?.updatedAt || 0)
    || (a.issue?.number || Infinity) - (b.issue?.number || Infinity)
    || String(a.todo?.file || '').localeCompare(String(b.todo?.file || ''))
    || (a.todo?.line || 0) - (b.todo?.line || 0);
  const items = TIERS.flatMap(tier => [...ordered[tier], ...scored[tier].sort(byScore)]);

  return {
    items,
    milestone: nearest ? { ...nearest, due: dueText(nearest.dueOn, now) } : null,
  };
}

module.exports = { rank, scoreIssue, nearestMilestone, dueText, TIERS };
