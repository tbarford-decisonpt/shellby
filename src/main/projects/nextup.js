// "What's next on this repo?", as Shellby answers it: one project's insights
// (insights.js), its dev servers and its to-do list (todo.js) -> an ordered
// list of things to do, each already worded. next_up and `shellby next` read
// it out; the project's page shows the to-dos from the same list. Pure.
//
// The order: what is broken now (a crashed server, a red build, a serious
// vulnerability), then the to-dos you wrote down, then the housekeeping
// (review comments, unpushed and uncommitted work, flaky tests, the rest of the
// dependency report). Your own list beats housekeeping but not a fire.
const { oneLine } = require('./todo');

// Every broken thing and every to-do is listed (a to-do you can't see is one
// you can't tick off by its number); housekeeping stops here, with a count.
const MAX_CHORES = 10;
const MAX_TITLE = 100;

const cap = (s, n) => { const t = oneLine(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** A server's command as you'd type it: "npm run dev". */
const commandOf = s => (s.command ? oneLine(s.command) : `${s.manager || 'npm'} run ${oneLine(s.script) || 'dev'}`);

/**
 * p: a project with insights (insights.withInsights) and its clones' servers.
 * todo: its to-do list (todo.listFor).
 * -> [{ kind, tier, text, id?, number?, from?, untrusted? }], first thing first.
 *    untrusted: the text quotes something someone else wrote (a PR title, a test name).
 */
function nextUp(p, todo = []) {
  const i = p?.insights || {};
  const broken = [];
  const chores = [];

  for (const c of p?.local || []) {
    for (const s of c.servers || []) {
      if (s.kind === 'install' || (s.status !== 'crashed' && s.status !== 'failed')) continue;
      const how = s.neverUp ? "didn't start" : 'crashed';
      const code = Number.isInteger(s.exitCode) ? ` (exit code ${s.exitCode})` : '';
      broken.push({ kind: 'server', text: `The dev server \`${commandOf(s)}\` ${how}${code}.`, script: s.script || null });
    }
  }

  for (const pr of i.prs || []) {
    const title = `#${pr.number} ${cap(pr.title, MAX_TITLE)}`;
    if (pr.state === 'failing') {
      const which = (pr.failing || []).map(oneLine).filter(Boolean).slice(0, 5).join(', ');
      broken.push({ kind: 'ci', text: `${title}: CI is failing${which ? ` (${which})` : ''}.`, untrusted: true });
    }
    if (pr.reviewComments > 0) chores.push({ kind: 'review', text: `${title}: ${plural(pr.reviewComments, 'review comment')} to address.`, untrusted: true });
  }

  const d = i.deps;
  const serious = d?.ok ? (d.vulns?.critical || 0) + (d.vulns?.high || 0) : 0;
  if (serious) broken.push({ kind: 'vuln', text: `${plural(serious, 'high or critical vulnerability', 'high or critical vulnerabilities')} in its dependencies (${oneLine(d.summary)}).` });

  if (i.git?.unpushed) chores.push({ kind: 'unpushed', text: `${plural(i.git.unpushed, 'commit')} not pushed yet: that work is only on this PC.` });
  if (i.git?.dirty) chores.push({ kind: 'dirty', text: `${plural(i.git.dirty, 'uncommitted change')}.` });
  for (const f of i.flaky || []) {
    if (f.status !== 'watching' || !(f.week > 0)) continue;
    chores.push({ kind: 'flaky', text: `Flaky test: ${cap(f.label, MAX_TITLE)} (flaked ${plural(f.week, 'time')} this week).`, untrusted: true });
  }
  if (d?.ok && d.vulnTotal > serious) chores.push({ kind: 'vuln', text: `${plural(d.vulnTotal - serious, 'lower-severity vulnerability', 'lower-severity vulnerabilities')} in its dependencies.` });
  if (d?.ok && d.outdatedTotal) chores.push({ kind: 'outdated', text: `${plural(d.outdatedTotal, 'outdated package')}.` });

  const mine = (todo || []).map((t, n) => ({ kind: 'todo', text: oneLine(t.text), id: t.id, number: n + 1, from: t.from }));
  const shown = chores.slice(0, MAX_CHORES);
  const more = chores.length - shown.length;

  return [
    ...broken.map(x => ({ ...x, tier: 'broken' })),
    ...mine.map(x => ({ ...x, tier: 'todo' })),
    ...shown.map(x => ({ ...x, tier: 'chore' })),
    ...(more > 0 ? [{ kind: 'more', tier: 'chore', text: `…and ${plural(more, 'more housekeeping item')}. The project's page in Shellby has them all.` }] : []),
  ];
}

/**
 * The context around the list, for the reply: where you left off and how long
 * it has been quiet. -> { leftOff: { title, at, done } | null, quietDays: number | null }
 */
function context(p) {
  const last = (p?.sessions || [])[0];
  return {
    leftOff: last ? { title: cap(last.title, MAX_TITLE), at: last.updatedAt || 0, done: !!last.done } : null,
    quietDays: p?.insights?.quiet ? p.insights.quietDays : null,
  };
}

module.exports = { nextUp, context, commandOf, MAX_CHORES };
