// How long each e2e check takes on CI, so e2e-ci.js can split them into shards
// that finish together (by time, not by name). Reads the e2e jobs' logs of a
// CI run (the newest green one on main by default) and writes e2e-times.json.
//
//   GH_TOKEN=... node scripts/e2e-times.js [run-id]
//
// Job logs need a token, even on a public repo. Rerun it when shards drift
// apart; a check missing from the file counts as a typical one meanwhile.
const fs = require('fs');
const path = require('path');
const { repoSlug } = require('./release-guard');

const OUT = path.join(__dirname, 'e2e-times.json');
// A shard's closing summary: "  PASS  e2e-queue          15.5s"; FAIL and FLAKY lines have a time too.
const LINE = /^\s+(?:PASS|FAIL|FLAKY)\s+(\S+)\s+([\d.]+)s\b/;

/** A job log's summary lines -> { check: seconds }. Pure. */
function parseTimes(log) {
  const times = {};
  for (const raw of String(log || '').split('\n')) {
    const m = LINE.exec(raw.replace(/^\S+Z /, '')); // GitHub puts a timestamp before every line
    if (m) times[m[1]] = Math.round(Number(m[2]) * 10) / 10;
  }
  return times;
}

async function gh(route, { text = false } = {}) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('Set GH_TOKEN: GitHub only hands out job logs with a token.');
  const res = await fetch(`https://api.github.com/repos/${repoSlug()}/${route}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'shellby-e2e-times', authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${route}.`);
  return text ? res.text() : res.json();
}

async function main(runId) {
  const id = runId || (await gh('actions/workflows/ci.yml/runs?branch=main&status=success&per_page=1')).workflow_runs?.[0]?.id;
  if (!id) throw new Error('No green CI run on main to measure.');
  const jobs = (await gh(`actions/runs/${id}/jobs?per_page=100`)).jobs.filter(j => j.name.startsWith('e2e'));
  const times = {};
  for (const j of jobs) Object.assign(times, parseTimes(await gh(`actions/jobs/${j.id}/logs`, { text: true })));
  if (!Object.keys(times).length) throw new Error(`Run ${id} has no e2e timings in its logs.`);
  const sorted = Object.fromEntries(Object.entries(times).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(OUT, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`${Object.keys(sorted).length} checks from run ${id} -> ${path.relative(process.cwd(), OUT)}`);
}

if (require.main === module) {
  main(process.argv[2]).catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { parseTimes };
