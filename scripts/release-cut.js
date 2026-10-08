// Cut a release from a terminal, the same way the Releases card on a project's
// page does it (src/main/projects/release-git.js): the change notes in
// changes/ gathered into the CHANGELOG (or the commits since the last tag when
// there are none), package.json and the lock bumped, one "X.Y.Z: Title" commit
// and an annotated tag. All on this PC: nothing is pushed.
//
//   npm run release:cut -- [X.Y.Z] "Title"   cut it (the version defaults to the suggested one)
//   npm run release:cut -- --dry-run         say what it would write, change nothing
//
// Then: push main, `npm run release:ready` (waits for CI on that commit to be
// green) and push the tag. See CONTRIBUTING.md.
const path = require('path');
const rg = require('../src/main/projects/release-git');
const R = require('../src/main/projects/releases');
const { git } = require('../src/main/worktrees');

const ROOT = path.join(__dirname, '..');

/** argv -> { version, title, dryRun }. Pure. */
function parseArgs(argv) {
  const dryRun = argv.includes('--dry-run');
  const words = argv.filter(a => !a.startsWith('--'));
  const version = R.isVersion(words[0]) ? words.shift() : null;
  return { version, title: words.join(' ').trim(), dryRun };
}

async function main(argv) {
  const { version: asked, title, dryRun } = parseArgs(argv);
  const state = await rg.readRelease(ROOT, { git });
  if (!state.ok) throw new Error(state.error);
  const blocked = rg.blocker(state);
  if (blocked && !dryRun) throw new Error(blocked);
  const version = asked || state.next.suggested;
  const from = state.notes.length ? `${state.notes.length} change note${state.notes.length === 1 ? '' : 's'}` : `${state.total} commit${state.total === 1 ? '' : 's'} (no change notes)`;
  console.log(`${version} (${state.next.bump}: ${state.next.why}), from ${from} since ${state.last?.tag || 'the start'}.\n`);
  if (state.changelog.hasEntry && version === state.next.suggested) console.log(`${state.changelog.name} already has an entry for ${version}; it goes in as it is.\n`);
  else console.log(`${R.entryText({ style: state.changelog.style, version, title, date: state.draft.date, notes: state.draft.notes })}`);
  if (dryRun) { if (blocked) console.log(`For real, it would stop here: ${blocked}`); return; }
  if (!title && state.changelog.style === 'titled') throw new Error('Give the release a title: npm run release:cut -- X.Y.Z "Title"');

  const r = await rg.cutRelease(ROOT, { version, title, notes: state.draft.notes, head: state.head, push: false }, { git });
  if (!r.ok) throw new Error(r.error);
  console.log(`Committed and tagged ${r.tag} at ${r.commit.slice(0, 7)}. Next:`);
  console.log(`  git push origin ${state.branch}`);
  console.log('  npm run release:ready -- --wait');
  console.log(`  git push origin ${r.tag}`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(e => {
    console.error(`Not cut: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs };
