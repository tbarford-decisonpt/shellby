// The Projects page's decisions and words (src/renderer/panel/projects-logic.js):
// a server's status, the list's filter and order, a clone's facts, the play
// button, and the scan.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/renderer/panel/projects-logic');

const relTime = t => `at ${t}`;

test('statusText says starting, installing or up, with the port', () => {
  assert.equal(L.statusText({ status: 'starting' }, relTime), 'Starting…');
  assert.equal(L.statusText({ status: 'starting', kind: 'install' }, relTime), 'Installing…');
  assert.equal(L.statusText({ status: 'up', port: 5173 }, relTime), 'Up on :5173');
  assert.equal(L.statusText({ status: 'up' }, relTime), 'Up');
});

test('statusText tells a crash from a server that never started, with its exit code', () => {
  assert.equal(L.statusText({ status: 'crashed', endedAt: 5, exitCode: 1 }, relTime), 'Crashed at 5 · exit code 1');
  assert.equal(L.statusText({ status: 'crashed', endedAt: 5, neverUp: true }, relTime), "Didn't start at 5");
  assert.equal(L.statusText({ status: 'crashed', endedAt: 5, exitCode: 0, missed: true }, relTime), 'Crashed at 5 · exit code 0 · while Shellby was closed');
  assert.equal(L.statusText({ status: 'failed', endedAt: 5, exitCode: 2 }, relTime), 'Install failed at 5 · exit code 2');
});

test('statusText does not call a server that ended unseen and without a code a crash', () => {
  assert.equal(L.statusText({ status: 'crashed', endedAt: 9, missed: true }, relTime), 'Stopped while Shellby was closed · at 9');
  assert.equal(L.statusText({ status: 'crashed', missed: true }, relTime), 'Stopped while Shellby was closed · ');
});

test('statusText passes an unknown status through', () => {
  assert.equal(L.statusText({ status: 'paused' }, relTime), 'paused');
});

test('isLive is true while starting or up', () => {
  assert.deepEqual(['starting', 'up', 'crashed', 'failed'].map(status => L.isLive({ status })), [true, true, false, false]);
});

const clone = (o = {}) => ({ root: 'C:\\code\\app', scripts: [{ name: 'dev', likely: true }, { name: 'build' }], lastScript: null, ...o });
const none = () => [];

test('devChoice opens a server that is up with a URL', () => {
  const up = { status: 'up', url: 'http://localhost:3000', kind: 'server', port: 3000 };
  assert.deepEqual(L.devChoice(clone(), () => [up]), { open: up });
});

test('devChoice offers nothing while a server is still starting', () => {
  assert.equal(L.devChoice(clone(), () => [{ status: 'starting', kind: 'server' }]), null);
});

test('devChoice starts the script you ran last, else the likeliest', () => {
  assert.equal(L.devChoice(clone({ lastScript: 'build' }), none).start.name, 'build');
  assert.equal(L.devChoice(clone(), none).start.name, 'dev');
});

test('devChoice needs a clone, a script, and dependencies installed', () => {
  assert.equal(L.devChoice(undefined, none), null);
  assert.equal(L.devChoice(clone({ scripts: [{ name: 'lint' }] }), none), null);
  assert.equal(L.devChoice(clone({ installed: false }), none), null);
});

const project = (name, o = {}) => ({ name, local: [{ root: `C:\\${name}` }], github: null, insights: {}, ...o });
const PROJECTS = [
  project('zeta', { insights: { attention: 1 } }),
  project('alpha', { github: { repo: 'me/alpha-web' } }),
  project('remote', { local: [], github: { repo: 'me/remote' } }),
  project('old', { local: [], github: { repo: 'me/old', archived: true } }),
  project('Beta', { insights: { attention: 3 } }),
];
const names = list => list.map(p => p.name);
const notRunning = () => false;

test('visible keeps main\'s order for recent and leaves archived repos out', () => {
  assert.deepEqual(names(L.visible(PROJECTS, { q: '', scope: 'all', sort: 'recent', running: notRunning })), ['zeta', 'alpha', 'remote', 'Beta']);
});

test('visible finds archived repos when searched for, by name or GitHub repo', () => {
  assert.deepEqual(names(L.visible(PROJECTS, { q: 'old', scope: 'all', sort: 'recent', running: notRunning })), ['old']);
  assert.deepEqual(names(L.visible(PROJECTS, { q: 'alpha-web', scope: 'all', sort: 'recent', running: notRunning })), ['alpha']);
});

test('visible sorts by name without minding case', () => {
  assert.deepEqual(names(L.visible(PROJECTS, { q: '', scope: 'all', sort: 'name', running: notRunning })), ['alpha', 'Beta', 'remote', 'zeta']);
});

test('visible shows only what needs you, most first, and running ones too', () => {
  const running = p => p.name === 'alpha';
  assert.deepEqual(names(L.visible(PROJECTS, { q: '', scope: 'all', sort: 'attention', running })), ['Beta', 'zeta', 'alpha']);
});

test('visible scopes to this PC, GitHub only, or running', () => {
  assert.deepEqual(names(L.visible(PROJECTS, { q: '', scope: 'local', sort: 'recent', running: notRunning })), ['zeta', 'alpha', 'Beta']);
  assert.deepEqual(names(L.visible(PROJECTS, { q: '', scope: 'github', sort: 'recent', running: notRunning })), ['remote', 'old']);
  assert.deepEqual(names(L.visible(PROJECTS, { q: '', scope: 'running', sort: 'recent', running: p => p.name === 'zeta' })), ['zeta']);
});

test('emptyText explains an empty list by why it is empty', () => {
  assert.match(L.emptyText({ none: true, scope: 'running' }), /^No projects yet/);
  assert.equal(L.emptyText({ none: false, scope: 'running' }), 'Nothing running right now.');
  assert.match(L.emptyText({ none: false, scope: 'all', sort: 'attention', q: '' }), /^Nothing needs you/);
  assert.equal(L.emptyText({ none: false, scope: 'all', sort: 'attention', q: 'x' }), 'Nothing matches.');
});

test('cloneFacts sums up the branch and git, and flags work only on this PC', () => {
  assert.deepEqual(L.cloneFacts({ branch: 'main', git: { dirty: 2, unpushed: 1, stashes: 1 } }), { text: 'on main · 2 uncommitted changes · 1 unpushed · 1 stash', atRisk: true });
  assert.deepEqual(L.cloneFacts({ branch: 'dev', git: { dirty: 0, stashes: 3 } }), { text: 'on dev · nothing uncommitted · 3 stashes', atRisk: false });
  assert.deepEqual(L.cloneFacts({}), { text: '', atRisk: false });
});

test('tidyPrompt names the project and keeps secrets out', () => {
  const p = L.tidyPrompt('shop');
  assert.ok(p.startsWith('In shop: commit any uncommitted work'));
  assert.match(p, /Never commit or push a \.env file/);
});

test('copiesSummary counts Shellby\'s copies and those with changes', () => {
  assert.equal(L.copiesSummary([{ changed: 0 }]), '1 copy Shellby made');
  assert.equal(L.copiesSummary([{ changed: 2 }, { changed: 0 }, { changed: 1 }]), '3 copies Shellby made · 2 with changes');
});

test('scanLede and addedLine count repositories properly', () => {
  const short = p => p.toLowerCase();
  assert.equal(L.scanLede({ candidates: [{}], parent: 'C:\\Code' }, short), 'Found 1 repository in c:\\code. Tick the ones to add; nothing is added until you do.');
  assert.equal(L.scanLede({ candidates: [{}, {}], parent: 'C:\\Code', truncated: true }, short), 'Found 2 repositories in c:\\code (stopped looking after the first 200). Tick the ones to add; nothing is added until you do.');
  assert.equal(L.scanLede({ candidates: [], parent: 'C:\\Code' }, short), 'No git repositories in c:\\code, two folders deep.');
  assert.equal(L.addedLine(3), 'Added 3 repositories');
  assert.equal(L.addedLine(1), 'Added 1 repository');
  assert.equal(L.addedLine(0), 'Nothing added.');
  assert.equal(L.addedLine(undefined), 'Nothing added.');
});
