const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const {
  checkupOf, readCheckup, commandDir, normalizeCheckups, recordCheckup, isFresh, checkupsView, FRESH_FOR, MAX_PROJECTS,
} = require('../src/main/checkup');

const DAY = 24 * 60 * 60 * 1000;
const T = new Date(2026, 9, 3, 10, 0).getTime();
const read = (command, text, isError = false) => readCheckup(checkupOf(command), { text, isError, command });

test('recognises each ecosystem\'s audit and outdated checks', () => {
  const cases = [
    ['npm audit', 'npm', 'audit'], ['npm audit --omit=dev', 'npm', 'audit'], ['npm outdated', 'npm', 'outdated'],
    ['pnpm audit --prod', 'pnpm', 'audit'], ['pnpm outdated -r', 'pnpm', 'outdated'],
    ['yarn audit', 'yarn', 'audit'], ['yarn npm audit --all', 'yarn', 'audit'], ['yarn outdated', 'yarn', 'outdated'],
    ['bun outdated', 'bun', 'outdated'],
    ['pip-audit', 'pip', 'audit'], ['python -m pip_audit -r requirements.txt', 'pip', 'audit'],
    ['pip list --outdated', 'pip', 'outdated'], ['python3 -m pip list -o', 'pip', 'outdated'], ['poetry show --outdated', 'pip', 'outdated'],
    ['cargo audit', 'cargo', 'audit'], ['cargo outdated -R', 'cargo', 'outdated'],
    ['govulncheck ./...', 'go', 'audit'], ['go list -u -m all', 'go', 'outdated'],
    ['bundle audit check --update', 'ruby', 'audit'], ['bundle outdated', 'ruby', 'outdated'],
    ['composer audit', 'php', 'audit'], ['composer outdated --direct', 'php', 'outdated'],
    ['dotnet list package --vulnerable', 'dotnet', 'audit'], ['dotnet list MyApp.csproj package --outdated', 'dotnet', 'outdated'],
    ['osv-scanner -r .', 'osv', 'audit'],
    ['cd "C:\\code\\app" && npm audit', 'npm', 'audit'],
  ];
  for (const [cmd, ecosystem, check] of cases) assert.deepEqual(checkupOf(cmd), { ecosystem, check }, cmd);
});

test('fixing, installing and unrelated commands are not checkups', () => {
  for (const cmd of ['npm audit fix', 'npm audit fix --force', 'npm audit signatures', 'cargo audit fix', 'npm install', 'pip list', 'pip install -U requests', 'go list ./...', 'git push', '', null, 42]) {
    assert.equal(checkupOf(cmd), null, String(cmd));
  }
});

test('npm audit: clean and vulnerable, old and new summaries', () => {
  assert.deepEqual(read('npm audit', 'up to date, audited 412 packages in 2s\n\nfound 0 vulnerabilities\n'), { status: 'clean', count: 0 });
  const v7 = '# npm audit report\n\nsemver  <5.7.2\nSeverity: moderate\nfix available via `npm audit fix`\n\n3 vulnerabilities (1 low, 2 high)\n';
  assert.deepEqual(read('npm audit', v7, true), { status: 'issues', count: 3 });
  assert.deepEqual(read('npm audit', 'found 2 high severity vulnerabilities in 900 scanned packages', true), { status: 'issues', count: 2 });
  // The summary was cut off, but the detail says enough.
  assert.equal(read('npm audit', '# npm audit report\n\nlodash  <4.17.21\nSeverity: critical\n…', true).status, 'issues');
});

test('every ecosystem\'s clean and dirty wording', () => {
  assert.equal(read('pnpm audit', 'No known vulnerabilities found').status, 'clean');
  assert.deepEqual(read('pnpm audit', '┌──\n│ high │ ...\n5 vulnerabilities found\nSeverity: 2 low | 3 high', true), { status: 'issues', count: 5 });
  assert.equal(read('yarn audit', '0 vulnerabilities found - Packages audited: 120').status, 'clean');
  assert.equal(read('yarn npm audit', '➤ YN0001: No audit suggestions').status, 'clean');
  assert.equal(read('pip-audit', 'No known vulnerabilities found').status, 'clean');
  assert.deepEqual(read('pip-audit', 'Found 2 known vulnerabilities in 1 package\nName Version ID', true), { status: 'issues', count: 2 });
  assert.equal(read('govulncheck ./...', 'No vulnerabilities found.').status, 'clean');
  assert.deepEqual(read('govulncheck ./...', 'Your code is affected by 1 vulnerability from the Go standard library.', true), { status: 'issues', count: 1 });
  assert.equal(read('bundle audit', 'No vulnerabilities found').status, 'clean');
  assert.equal(read('bundle audit', 'Name: rack\nVersion: 2.0\n\nVulnerabilities found!', true).status, 'issues');
  assert.equal(read('composer audit', 'No security vulnerability advisories found.').status, 'clean');
  assert.deepEqual(read('composer audit', 'Found 4 security vulnerability advisories affecting 2 packages:', true), { status: 'issues', count: 4 });
  assert.equal(read('cargo audit', '    Scanning Cargo.lock for vulnerabilities (210 crate dependencies)\n').status, 'clean');
  assert.deepEqual(read('cargo audit', 'error: 2 vulnerabilities found!', true), { status: 'issues', count: 2 });
  assert.equal(read('dotnet list package --vulnerable', "The given project `App` has no vulnerable packages given the current sources.").status, 'clean');
  assert.equal(read('dotnet list package --vulnerable', 'Project `App` has the following vulnerable packages\n   > System.Text.Json 6.0.0 High').status, 'issues');
});

test('outdated listings are counted, and an empty one is up to date', () => {
  const npm = 'Package   Current  Wanted  Latest  Location\nexpress   4.17.1   4.21.0  5.0.1   node_modules/express\nlodash    4.17.20  4.17.21 4.17.21 node_modules/lodash\n';
  assert.deepEqual(read('npm outdated', npm, true), { status: 'issues', count: 2 });
  assert.deepEqual(read('npm outdated', ''), { status: 'clean', count: 0 });
  const pip = 'Package    Version Latest Type\n---------- ------- ------ -----\nrequests   2.28.0  2.32.3 wheel\n';
  assert.deepEqual(read('pip list --outdated', pip), { status: 'issues', count: 1 });
  // pip exits 0 either way, and its upgrade notice isn't a listing.
  assert.deepEqual(read('pip list --outdated', '\n[notice] A new release of pip is available: 24.0 -> 24.2\n'), { status: 'clean', count: 0 });
  assert.deepEqual(read('cargo outdated', 'All dependencies are up to date, yay!'), { status: 'clean', count: 0 });
  assert.deepEqual(read('go list -u -m all', 'example.com/app\ngolang.org/x/net v0.10.0 [v0.30.0]\ngolang.org/x/text v0.14.0\n'), { status: 'issues', count: 1 });
  assert.deepEqual(read('go list -u -m all', 'example.com/app\ngolang.org/x/text v0.14.0\n'), { status: 'clean', count: 0 });
  assert.equal(read('bundle outdated', 'Bundle up to date!').status, 'clean');
  assert.equal(read('dotnet list package --outdated', 'Project `App` has the following updates to its packages\n   > Newtonsoft.Json 12.0.1 13.0.3').status, 'issues');
});

test('a hidden exit code is never trusted; a visible one is', () => {
  // Nothing recognisable printed, piped or `|| true`: can't tell.
  assert.equal(read('cargo audit | tail -3', 'done', false).status, 'unknown');
  assert.equal(read('cargo audit || true', 'done', false).status, 'unknown');
  assert.equal(read('cargo audit; echo ok', 'ok', false).status, 'unknown');
  // A plain run, or one with only && and redirects around it: the exit code counts.
  assert.equal(read('cargo audit', 'done', false).status, 'clean');
  assert.equal(read('cd app && cargo audit 2>&1', 'done', true).status, 'issues');
  // The output still decides when it's there, piped or not.
  assert.equal(read('npm audit 2>&1 | tail -5', 'found 0 vulnerabilities').status, 'clean');
  // npm outdated exits 1 when something is behind; pip doesn't tell either way.
  assert.equal(read('npm outdated', 'garbled', true).status, 'issues');
  assert.equal(read('pip list --outdated | head', 'garbled', false).status, 'unknown');
});

test('a tool that isn\'t there, or couldn\'t reach its database, checked nothing', () => {
  assert.equal(read('pip-audit', 'bash: pip-audit: command not found', true).status, 'unknown');
  assert.equal(read('cargo audit', "error: no such command: `audit`", true).status, 'unknown');
  assert.equal(read('govulncheck ./...', "'govulncheck' is not recognized as an internal or external command", true).status, 'unknown');
  assert.equal(read('npm audit', 'npm ERR! code ENOLOCK\nnpm ERR! audit This command requires an existing lockfile.', true).status, 'unknown');
  assert.equal(read('npm audit', 'npm ERR! request to https://registry.npmjs.org failed, reason: getaddrinfo ENOTFOUND', true).status, 'unknown');
  assert.deepEqual(readCheckup(null, { text: 'found 0 vulnerabilities' }), { status: 'unknown', count: null });
});

test('the folder a command really runs in', () => {
  const base = path.resolve('/work');
  assert.equal(commandDir('npm audit', base), base);
  assert.equal(commandDir('cd app && npm audit', base), path.join(base, 'app'));
  assert.equal(commandDir('cd "my app" && npm audit', base), path.join(base, 'my app'));
  assert.equal(commandDir("Set-Location -Path 'svc'; npm audit", base), path.join(base, 'svc'));
  assert.equal(commandDir('npm --prefix web audit', base), path.join(base, 'web'));
  assert.equal(commandDir('cargo audit --manifest-path crates/core/Cargo.toml', base), path.join(base, 'crates', 'core'));
  assert.equal(commandDir('cd ~/proj && npm audit', base), path.join(os.homedir(), 'proj'));
  // A variable can't be resolved here: the tab's own folder.
  assert.equal(commandDir('cd $DIR && npm audit', base), base);
  assert.equal(commandDir('npm audit', null), null);
});

test('recording: a clean audit pays once a day, and a patched project pays again', () => {
  const audit = { ecosystem: 'npm', check: 'audit' };
  let r = recordCheckup(null, '/work/app', 'app', audit, { status: 'clean', count: 0 }, T);
  assert.equal(r.clean, true);
  assert.equal(r.pays, true);
  assert.equal(r.entry.cleanAt, T);
  r = recordCheckup(r.state, '/work/app', 'app', audit, { status: 'clean', count: 0 }, T + 60000);
  assert.equal(r.pays, false, 'a rerun the same day pays nothing');
  r = recordCheckup(r.state, '/work/app', 'app', audit, { status: 'issues', count: 3 }, T + 2 * 60000);
  assert.equal(r.clean, false);
  assert.equal(r.state.projects['/work/app'].audit.count, 3);
  r = recordCheckup(r.state, '/work/app', 'app', audit, { status: 'clean', count: 0 }, T + 3 * 60000);
  assert.equal(r.patched, true);
  assert.equal(r.pays, true, 'fixing them is worth it even on the same day');
  r = recordCheckup(r.state, '/work/app', 'app', audit, { status: 'clean', count: 0 }, T + DAY);
  assert.equal(r.pays, true, 'and again the next day');
});

test('recording: an unreadable result never replaces a real one; outdated never pays', () => {
  const audit = { ecosystem: 'npm', check: 'audit' };
  const outdated = { ecosystem: 'npm', check: 'outdated' };
  let r = recordCheckup(null, '/work/app', 'app', audit, { status: 'issues', count: 2 }, T);
  r = recordCheckup(r.state, '/work/app', 'app', audit, { status: 'unknown', count: null }, T + 1000);
  assert.equal(r.state.projects['/work/app'].audit.status, 'issues');
  r = recordCheckup(r.state, '/work/app', 'app', outdated, { status: 'clean', count: 0 }, T + 2000);
  assert.equal(r.clean, false);
  assert.equal(r.pays, false);
  assert.equal(r.state.projects['/work/app'].outdated.status, 'clean');
  // Junk in, nothing recorded.
  for (const args of [[null, 'x', audit], ['', 'x', audit], ['/a', 'x', null], ['/a', 'x', { check: 'lint' }]]) {
    assert.equal(recordCheckup(null, args[0], args[1], args[2], { status: 'clean' }, T).entry, null);
  }
  assert.equal(recordCheckup(null, '/a', 'a', audit, { status: 'great' }, T).entry, null);
});

test('fresh for thirty days after a clean audit', () => {
  const r = recordCheckup(null, '/w/a', 'a', { ecosystem: 'pip', check: 'audit' }, { status: 'clean', count: 0 }, T);
  const p = r.state.projects['/w/a'];
  assert.equal(isFresh(p, T + FRESH_FOR - 1), true);
  assert.equal(isFresh(p, T + FRESH_FOR), false);
  const v = checkupsView(r.state, T + DAY);
  assert.equal(v.length, 1);
  assert.equal(v[0].fresh, true);
  assert.equal(v[0].ecosystem, 'pip');
});

test('the ledger tolerates junk and keeps only the most recent projects', () => {
  assert.deepEqual(normalizeCheckups(null), { projects: {} });
  assert.deepEqual(normalizeCheckups({ projects: { '/a': { audit: { status: 'nope', at: 1 } }, '': {}, '/b': 'x' } }), { projects: {} });
  const projects = {};
  for (let i = 0; i < MAX_PROJECTS + 10; i++) projects[`/p${i}`] = { name: `p${i}`, audit: { at: T + i, status: 'clean', count: 0, ecosystem: 'npm' } };
  const s = normalizeCheckups({ projects });
  assert.equal(Object.keys(s.projects).length, MAX_PROJECTS);
  assert.ok(s.projects[`/p${MAX_PROJECTS + 9}`], 'the newest is kept');
  assert.equal(s.projects['/p0'], undefined, 'the oldest is dropped');
});
