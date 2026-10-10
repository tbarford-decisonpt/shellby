// Cut a release from a terminal, the same way the Releases card on a project's
// page does it (src/main/projects/release-git.js): the change notes in
// changes/ gathered into the CHANGELOG (or the commits since the last tag when
// there are none), package.json and the lock bumped, one "X.Y.Z: Title" commit
// and an annotated tag. All on this PC: nothing is pushed.
//
//   npm run release:cut -- [X.Y.Z] "Title"   cut it (the version defaults to the suggested one)
//   npm run release:cut -- --dry-run         say what it would write, change nothing
//   --wait      wait for CI on the pushed branch to finish (stops at the first red job)
//   --skip-ci   cut without CI's word (GitHub unreachable); the release runs every check itself
//
// It only cuts over code CI has passed: push main first, and it waits for CI
// there (--wait). The release commit only bumps the version and the CHANGELOG,
// so CI's pass on the commit before it counts for it: push main and the tag
// together, and the release builds without rerunning the checks. See CONTRIBUTING.md.
const path = require('path');
const rg = require('../src/main/projects/release-git');
const R = require('../src/main/projects/releases');
const { git } = require('../src/main/worktrees');
const guard = require('./release-guard');

const ROOT = path.join(__dirname, '..');

/** argv -> { version, title, dryRun, wait, skipCi }. Pure. */
function parseArgs(argv) {
  const dryRun = argv.includes('--dry-run');
  const words = argv.filter(a => !a.startsWith('--'));
  const version = R.isVersion(words[0]) ? words.shift() : null;
  return { version, title: words.join(' ').trim(), dryRun, wait: argv.includes('--wait'), skipCi: argv.includes('--skip-ci') };
}

/**
 * What stops a cut until CI has passed on everything it releases, or null.
 * 0.78.0 was cut over 49 merged commits CI had never run together, and took
 * three CI rounds to ship. state: readRelease's. ci: guard.waitForCi's. Pure.
 */
function ciGate(state, ci) {
  const up = state.upstream;
  if (!up) return 'This branch has no upstream, so CI has never run on it. Push it (git push -u origin <branch>), then cut once CI is green.';
  if (up.ahead) return `${up.ahead} commit${up.ahead === 1 ? '' : 's'} on this branch aren't pushed, so CI hasn't checked ${up.ahead === 1 ? 'it' : 'them'}. git push, then cut with --wait to wait for CI.`;
  if (ci?.state === 'green') return null;
  if (ci?.state === 'running' || ci?.state === 'missing') return `${ci.problem} Cut with --wait to wait for it.`;
  return ci?.problem || "Couldn't tell whether CI passed.";
}

async function main(argv) {
  const { version: asked, title, dryRun, wait, skipCi } = parseArgs(argv);
  const state = await rg.readRelease(ROOT, { git });
  if (!state.ok) throw new Error(state.error);
  const blocked = rg.blocker(state);
  if (blocked && !dryRun) throw new Error(blocked);
  if (!dryRun && !skipCi) {
    const ci = state.upstream && !state.upstream.ahead
      ? await guard.waitForCi(state.head, { wait }).catch(e => ({ state: 'unknown', problem: `${e.message} Cut with --skip-ci to go without it.` }))
      : null;
    const stop = ciGate(state, ci);
    if (stop) throw new Error(stop);
  }
  const version = asked || state.next.suggested;
  const from = state.notes.length ? `${state.notes.length} change note${state.notes.length === 1 ? '' : 's'}` : `${state.total} commit${state.total === 1 ? '' : 's'} (no change notes)`;
  console.log(`${version} (${state.next.bump}: ${state.next.why}), from ${from} since ${state.last?.tag || 'the start'}.\n`);
  if (state.changelog.hasEntry && version === state.next.suggested) console.log(`${state.changelog.name} already has an entry for ${version}; it goes in as it is.\n`);
  else console.log(`${R.entryText({ style: state.changelog.style, version, title, date: state.draft.date, notes: state.draft.notes })}`);
  if (dryRun) { if (blocked) console.log(`For real, it would stop here: ${blocked}`); return; }
  if (!title && state.changelog.style === 'titled') throw new Error('Give the release a title: npm run release:cut -- X.Y.Z "Title"');

  const r = await rg.cutRelease(ROOT, { version, title, notes: state.draft.notes, head: state.head, push: false }, { git });
  if (!r.ok) throw new Error(r.error);
  console.log(`Committed and tagged ${r.tag} at ${r.commit.slice(0, 7)}. Next, the branch and the tag together:`);
  console.log(`  git push --atomic origin ${state.branch} ${r.tag}`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(e => {
    console.error(`Not cut: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, ciGate };
