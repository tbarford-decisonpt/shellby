// The end-to-end checks that CI can run: no Claude account, no GitHub sign-in,
// no network. Each one drives the real app over CDP with the fake Claude CLI,
// so this is the only automated coverage the renderer and main's wiring get.
//
//   node scripts/e2e-ci.js              all of them
//   node scripts/e2e-ci.js queue voice  just the ones whose name contains these
//
// They run one at a time on purpose: each launches its own Electron and some
// share hook ports. Everything else in scripts/ needs a real Claude account, a
// real GitHub or the live registry, and stays a manual check (see
// docs/DEVELOPMENT.md).
const { spawnSync } = require('child_process');
const path = require('path');

const SUITE = [
  'e2e-queue',        // queued messages: queue, edit, drain, stop, error pauses
  'e2e-feed-scroll',  // your prompt stays visible as the Working bar appears
  'e2e-feed-cap',     // a very long conversation stops growing the DOM
  'e2e-questions',    // Claude's multiple-choice questions
  'e2e-xp',           // XP, levels, the desktop float and the level-up
  'e2e-voice',        // what he says, his idle habits, and what outranks him
  'e2e-health',       // every health mood, with scripted sensors
  'e2e-crab-only',    // "just the crab": Health as home, Claude features hidden
  'ui-regressions',   // closing the last tab, themed tooltips, no native titles
  'titlebar-fit',     // the title bar fits at every width in every mode
];

const TIMEOUT_MS = 5 * 60 * 1000;

const wanted = process.argv.slice(2).filter(a => !a.startsWith('-'));
const suite = wanted.length ? SUITE.filter(s => wanted.some(w => s.includes(w))) : SUITE;
if (!suite.length) {
  console.error(`No checks match ${wanted.join(', ')}. Known: ${SUITE.join(', ')}`);
  process.exit(2);
}

const results = [];
for (const name of suite) {
  const script = path.join(__dirname, `${name}.js`);
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
  const started = Date.now();
  const r = spawnSync(process.execPath, [script], { stdio: 'inherit', timeout: TIMEOUT_MS });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const ok = !r.error && r.status === 0;
  results.push({ name, ok, secs, why: r.error ? r.error.message : r.status === null ? `killed (${r.signal})` : `exit ${r.status}` });
  console.log(`\n--- ${name}: ${ok ? 'PASS' : 'FAIL'} in ${secs}s`);
}

console.log(`\n${'='.repeat(70)}`);
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(18)} ${r.secs}s${r.ok ? '' : `  (${r.why})`}`);
const failed = results.filter(r => !r.ok);
console.log(`${'='.repeat(70)}\n${failed.length ? `${failed.length} of ${results.length} FAILED: ${failed.map(f => f.name).join(', ')}` : `all ${results.length} passed`}`);
process.exit(failed.length ? 1 : 0);
