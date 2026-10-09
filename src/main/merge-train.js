// Lining finished copies up to go home one after another: each copy's branch
// is rebased onto the one before it (the first onto the branch they all go
// home to), and the project's checks run in it before the next. So the last
// copy ends up holding everyone's work, each step checked on top of the last.
//
// It rewrites branches, so wiring/lanes.js asks first. It stops at the first
// thing that goes wrong and leaves nothing half done: a conflict is aborted
// (`git rebase --abort`, the copy is back where it was), red checks stop the
// line there, and a copy with uncommitted work is never touched (a rebase
// would refuse, and stashing would put it in the stash every worktree shares).
//
// git and check are passed in, so it's testable without a repository.

const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];
const REBASE_TIMEOUT_MS = 120000;
const PASSING = new Set(['pass', 'none']);

/**
 * steps: [{ tabId, title, path, branch, base }] in merge order (lanes.mergeOrder).
 * git(cwd, args, opts) -> { ok, out, error } (worktrees.git)
 * check(step) -> { status: 'pass' | 'fail' | 'error' | 'timeout' | 'none' | 'declined' | 'cancelled' }
 * onStep({ index, step, phase: 'rebasing' | 'checking' | 'done' }) to show progress.
 * -> { ok: true, done: [tabId] }
 *  | { ok: false, done, at: tabId, reason: 'dirty' | 'conflict' | 'red' | 'stopped' | 'git', detail }
 */
async function runTrain(steps, { git, check, onStep = () => {} }) {
  const done = [];
  if (!Array.isArray(steps) || !steps.length) return { ok: true, done };
  let onto = steps[0].base;
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    const fail = (reason, detail = '') => ({ ok: false, done, at: step.tabId, reason, detail });
    const st = await git(step.path, ['status', '--porcelain', '--untracked-files=no']);
    if (!st.ok) return fail('git', st.error);
    if (st.out.trim()) return fail('dirty', 'It has uncommitted changes.');
    // A ref git could read as an option is never passed on (rebase has no `--` for it).
    if (typeof onto !== 'string' || !onto || onto.startsWith('-')) return fail('git', `"${onto}" isn't a branch Shellby can line up onto.`);
    onStep({ index, step, phase: 'rebasing' });
    const r = await git(step.path, [...NO_HOOKS, 'rebase', '--no-autostash', onto], { timeout: REBASE_TIMEOUT_MS, env: { LC_ALL: 'C' } });
    if (!r.ok) {
      const abort = await git(step.path, ['rebase', '--abort']);
      const conflict = /conflict/i.test(`${r.out}\n${r.error}`);
      const detail = String(r.error || r.out).trim().split('\n').slice(-6).join('\n');
      return fail(conflict ? 'conflict' : 'git', abort.ok || !conflict ? detail : `${detail}\n(git rebase --abort said: ${abort.error})`);
    }
    onStep({ index, step, phase: 'checking' });
    const c = await check(step);
    const status = c?.status || 'error';
    if (status === 'declined' || status === 'cancelled') return fail('stopped', status);
    if (!PASSING.has(status)) return fail('red', status);
    done.push(step.tabId);
    onStep({ index, step, phase: 'done' });
    onto = step.branch;
  }
  return { ok: true, done };
}

/** What happened, in a sentence for a toast. titleOf: tabId -> title. Pure. */
function trainLine(result, titleOf = id => id) {
  if (result.ok) return `All ${result.done.length} lined up and checked. The last one holds everyone's work.`;
  const who = `"${titleOf(result.at)}"`;
  const kept = result.done.length ? ` ${result.done.length} before it went through.` : '';
  switch (result.reason) {
    case 'dirty': return `Stopped at ${who}: it has uncommitted changes, so it was left alone.${kept}`;
    case 'conflict': return `Stopped at ${who}: it conflicts with the one before it. The rebase was undone, nothing changed there.${kept}`;
    case 'red': return `Stopped at ${who}: its checks went red after the rebase.${kept}`;
    case 'stopped': return `Stopped at ${who}: its checks didn't run.${kept}`;
    default: return `Stopped at ${who}: git said no.${kept}`;
  }
}

module.exports = { runTrain, trainLine, REBASE_TIMEOUT_MS };
