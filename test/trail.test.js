const { test } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/renderer/shared/trail');

const CWD = 'C:\\work\\proj';
let n = 0;
const tool = (name, extra = {}) => ({ kind: 'tool', id: `t${++n}`, name, ...extra });
const read = (path, extra) => tool('Read', { target: { path }, ...extra });
const edit = (path, extra) => tool('Edit', { filePath: path, edits: [{ old: 'a', new: 'b' }], ...extra });
const ok = (t, text = 'ok') => ({ kind: 'tool_result', id: t.id, isError: false, text });
const bad = (t, text = 'String to replace not found in file.') => ({ kind: 'tool_result', id: t.id, isError: true, text });
const user = turnId => ({ kind: 'user', text: 'go', turnId });

function trail(...items) {
  const s = T.create(CWD);
  for (const i of items) T.apply(s, i);
  return s;
}
const fileIn = (v, rel) => {
  let hit = null;
  const walk = node => { if (node.kind === 'file' && node.info.rel === rel) hit = node.info; (node.kids || []).forEach(walk); };
  walk(v.tree);
  return hit;
};
const names = v => T.rows(v.tree).map(r => `${'  '.repeat(r.depth)}${r.node.name}`);

test('paths: slashes, case, dots and what is inside the project', () => {
  assert.equal(T.norm('C:\\a\\.\\b\\..\\c\\'), 'C:/a/c');
  assert.equal(T.norm('\\\\server\\share\\x'), '//server/share/x');
  assert.equal(T.relTo('c:/WORK/proj/src/A.js', CWD), 'src/A.js');
  assert.equal(T.relTo('C:/work/project/x.js', CWD), null, 'a folder that only starts the same is somewhere else');
  assert.equal(T.relTo(CWD, CWD), '');
});

test('the map holds only what he touched, folders first, single folders merged', () => {
  const r1 = read(`${CWD}\\src\\panel\\feed.js`);
  const r2 = read('src/panel/core.js'); // relative to the project
  const r3 = read(`${CWD}\\README.md`);
  const v = T.view(trail(user('u1'), r1, ok(r1), r2, ok(r2), r3, ok(r3)));
  assert.deepEqual(names(v), ['proj', '  src/panel', '    core.js', '    feed.js', '  README.md']);
  assert.equal(v.counts.read, 3);
  assert.equal(fileIn(v, 'src/panel/feed.js').reads, 1);
});

test('reads remember the lines they asked for; a file read twice counts twice', () => {
  const a = read(`${CWD}\\big.js`, { target: { path: `${CWD}\\big.js`, lines: [120, 159] } });
  const b = read(`${CWD}\\big.js`);
  const f = fileIn(T.view(trail(user('u1'), a, ok(a), b, ok(b))), 'big.js');
  assert.equal(f.reads, 2);
  assert.deepEqual(f.lines, [[120, 159]]);
});

test('an item saved before targets existed still places a Read by its detail', () => {
  const old = { kind: 'tool', id: 'old1', name: 'Read', detail: `${CWD}\\old.js` };
  assert.equal(fileIn(T.view(trail(user('u1'), old)), 'old.js').reads, 1);
});

test('a search lights up what it found without counting it as read', () => {
  const g = tool('Grep', { target: { pattern: 'fence', path: 'src' } });
  const text = `Found 2 files\n${CWD}\\src\\a.js\nsrc/b.js`;
  const v = T.view(trail(user('u1'), g, ok(g, text)));
  assert.equal(fileIn(v, 'src/a.js').hits, 1);
  assert.equal(fileIn(v, 'src/b.js').hits, 1);
  assert.equal(fileIn(v, 'src/a.js').reads, 0);
  assert.equal(v.counts.seen, 2);
  assert.deepEqual(v.crab.key, T.keyOf(`${CWD}/src`), 'he stands on the folder he searched');
  assert.equal(v.crab.pose, 'search');
});

test('search results: content lines, drive letters, notes and duplicates', () => {
  const hits = T.hitsOf('C:\\p\\a.js:12:const x\nC:\\p\\a.js:14:const y\nlib/b.ts:3\n--\nNo files found\n(Results are truncated. Consider a narrower path.)', 'C:/p');
  assert.deepEqual(hits, ['C:/p/a.js', 'C:/p/lib/b.ts']);
  assert.equal(T.hitsOf(Array.from({ length: 80 }, (_, i) => `f${i}.js`).join('\n'), 'C:/p').length, T.MAX_HITS);
});

test('commands put him at the top of the project', () => {
  const b = tool('Bash', { detail: 'npm test' });
  const v = T.view(trail(user('u1'), b));
  assert.equal(v.crab.key, '');
  assert.equal(v.crab.pose, 'run');
  assert.equal(v.tree.info.runs, 1);
});

test('changed files take the diff, and a file only a command changed still shows', () => {
  const e = edit(`${CWD}\\src\\app.js`);
  const s = trail(user('u1'), e, ok(e), { kind: 'result', ok: true },
    { kind: 'changes', turnId: 'u1', root: CWD, files: [{ path: 'src/app.js', status: 'M', added: 12, removed: 3 }, { path: 'gen/out.js', status: 'A', added: 40, removed: 0 }] });
  const v = T.view(s);
  assert.deepEqual(fileIn(v, 'src/app.js').diff, { status: 'M', added: 12, removed: 3, turn: 1 });
  assert.equal(fileIn(v, 'gen/out.js').diff.status, 'A');
  assert.equal(v.counts.changed, 2);
  assert.equal(v.crab.working, false);
});

test('a file made in one turn and changed in the next stays new, with both turns counted', () => {
  const s = trail(user('u1'), { kind: 'changes', turnId: 'u1', root: CWD, files: [{ path: 'n.js', status: 'A', added: 5, removed: 0 }] },
    user('u2'), { kind: 'changes', turnId: 'u2', root: CWD, files: [{ path: 'n.js', status: 'M', added: 2, removed: 1 }] });
  assert.deepEqual(fileIn(T.view(s), 'n.js').diff, { status: 'A', added: 7, removed: 1, turn: 2 });
});

test('an undone turn takes its changes off the map', () => {
  const s = trail(user('u1'), { kind: 'changes', turnId: 'u1', root: CWD, files: [{ path: 'n.js', status: 'M', added: 5, removed: 0 }] }, { kind: 'undone', turnId: 'u1' });
  assert.equal(fileIn(T.view(s), 'n.js'), null);
});

test('going in circles: the same file edited three times in a turn, or two failed edits', () => {
  const steps = [];
  for (let i = 0; i < 3; i++) { const e = edit(`${CWD}\\loop.js`); steps.push(e, ok(e)); }
  const f1 = edit(`${CWD}\\miss.js`), f2 = edit(`${CWD}\\miss.js`);
  const v = T.view(trail(user('u1'), ...steps, f1, bad(f1), f2, bad(f2)));
  assert.deepEqual(v.circles.map(f => [f.rel, f.circles]), [['loop.js', 3], ['miss.js', 2]]);
  // A new turn starts the count again.
  const e = edit(`${CWD}\\loop.js`);
  const s2 = trail(user('u1'), ...steps, user('u2'), e, ok(e));
  assert.deepEqual(T.view(s2).circles, []);
});

test('a refused edit is not a failed one', () => {
  const a = edit(`${CWD}\\x.js`), b = edit(`${CWD}\\x.js`);
  const v = T.view(trail(user('u1'), a, bad(a, 'The user declined this.'), b, bad(b, 'The user declined this.')));
  assert.deepEqual(v.circles, []);
  assert.equal(fileIn(v, 'x.js').denied, 2);
});

test('secrets and anything outside the project are called out', () => {
  const a = read(`${CWD}\\.env`), b = read(`${CWD}\\.env.example`), c = read('C:\\Users\\me\\.ssh\\id_ed25519');
  const v = T.view(trail(user('u1'), a, b, c));
  assert.deepEqual(v.secrets.map(f => f.name), ['.env', 'id_ed25519']);
  assert.deepEqual(v.outside.map(f => f.path), ['C:/Users/me/.ssh/id_ed25519']);
  assert.equal(v.counts.outside, 1);
  // A turn later, the secret is still marked on its row, but no longer news.
  const later = trail(user('u1'), a, user('u2'), read(`${CWD}\\x.js`));
  assert.deepEqual(T.view(later).secrets, []);
  assert.equal(fileIn(T.view(later), '.env').secret, true);
  assert.ok(T.isSecret('keys/server.pem') && T.isSecret('.env.local') && !T.isSecret('.env.sample') && !T.isSecret('env.js'));
});

test('this turn only, or the whole conversation with earlier turns marked earlier', () => {
  const a = read(`${CWD}\\old.js`), b = read(`${CWD}\\new.js`);
  const s = trail(user('u1'), a, { kind: 'result', ok: true }, user('u2'), b);
  const all = T.view(s);
  assert.equal(fileIn(all, 'old.js').fresh, false);
  assert.equal(fileIn(all, 'new.js').fresh, true);
  const now = T.view(s, { scope: 'turn' });
  assert.equal(fileIn(now, 'old.js'), null);
  assert.ok(fileIn(now, 'new.js'));
});

test('the replay: the map as it was at an earlier step', () => {
  const a = read(`${CWD}\\a.js`), b = edit(`${CWD}\\b.js`), c = read(`${CWD}\\c.js`);
  const s = trail(user('u1'), a, ok(a), b, ok(b), c, ok(c));
  const then = T.view(s, { upTo: 2 });
  assert.equal(then.live, false);
  assert.equal(then.at, 2);
  assert.equal(then.steps, 3);
  assert.equal(fileIn(then, 'c.js'), null, 'what came later is not there yet');
  assert.equal(then.crab.key, T.keyOf(`${CWD}/b.js`));
  assert.equal(then.crab.pose, 'write');
  assert.equal(T.view(s).crab.key, T.keyOf(`${CWD}/c.js`));
});

test('helpers walk their own trail, and go once their lane is done', () => {
  const agent = tool('Agent', { agent: { type: 'Explore', description: 'map the docs' } });
  const sub = read(`${CWD}\\docs\\guide.md`, { sub: true, parent: agent.id });
  const main = read(`${CWD}\\src\\x.js`);
  const s = trail(user('u1'), agent, sub, main);
  const v = T.view(s);
  assert.deepEqual(v.helpers.map(h => [h.index, h.label, h.key]), [[0, 'map the docs', T.keyOf(`${CWD}/docs/guide.md`)]]);
  assert.equal(v.crab.key, T.keyOf(`${CWD}/src/x.js`), 'his own spot is the main thread\'s last step');
  T.apply(s, { kind: 'task', phase: 'done', toolUseId: agent.id });
  assert.deepEqual(T.view(s).helpers, []);
});

test('a file waiting for your OK is marked until it is answered', () => {
  const e = edit(`${CWD}\\a.js`);
  const s = trail(user('u1'), e, { kind: 'permission', requestId: 'r1', toolName: 'Edit', toolUseId: e.id, filePath: `${CWD}\\a.js` });
  assert.equal(fileIn(T.view(s), 'a.js').ask, true);
  assert.equal(fileIn(T.view(s), 'a.js').writes, 0, 'not changed until it has been');
  T.apply(s, { kind: 'decision', requestId: 'r1', decision: 'allow' });
  T.apply(s, ok(e));
  assert.equal(fileIn(T.view(s), 'a.js').ask, false);
  assert.equal(fileIn(T.view(s), 'a.js').writes, 1);
});

test('/clear starts the trail over', () => {
  const s = trail(user('u1'), read(`${CWD}\\a.js`), { kind: 'cleared' });
  assert.equal(T.view(s).tree.kids.length, 0);
  assert.equal(s.seq, 0);
});

test('a closed folder hides what is in it', () => {
  const v = T.view(trail(user('u1'), read(`${CWD}\\src\\a.js`), read(`${CWD}\\src\\b.js`), read(`${CWD}\\top.js`)));
  const src = v.tree.kids.find(k => k.kind === 'dir');
  assert.equal(T.rows(v.tree).length, 5);
  assert.equal(T.rows(v.tree, new Set([src.key])).length, 3);
});

test('tests for a change: named after it, nearest first, never for a test itself', () => {
  const files = ['src/app.js', 'test/app.test.js', 'src/app.spec.js', 'other/app.test.js', 'test/apple.test.js', 'tests/test_app.py', 'test/'];
  assert.deepEqual(T.testsFor('src/app.js', files), ['src/app.spec.js', 'test/app.test.js', 'other/app.test.js']);
  assert.deepEqual(T.testsFor('test/app.test.js', files), []);
  assert.deepEqual(T.testsFor('lib/app.py', ['tests/test_app.py', 'pkg/app_test.py']), ['pkg/app_test.py', 'tests/test_app.py']);
  assert.deepEqual(T.testsFor('src/Cart.java', ['src/CartTest.java']), ['src/CartTest.java']);
  assert.ok(T.isTest('src/__tests__/x.js') && T.isTest('a_test.go') && !T.isTest('src/contest.js'));
});

test('review fixes: a searched path that is a file, content lines, roots, odd names', () => {
  // Grep pointed at one file, then that file edited: a file, changed, not a folder.
  const g = tool('Grep', { target: { pattern: 'x', path: 'src/a.js' } });
  const e = edit(`${CWD}\\src\\a.js`);
  const v = T.view(trail(user('u1'), g, ok(g, ''), e, ok(e)));
  assert.equal(fileIn(v, 'src/a.js').dir, false);
  assert.equal(v.counts.changed, 1);
  assert.deepEqual(v.changedNow, ['src/a.js']);
  // Content from one file has no paths, and context lines are not files.
  assert.deepEqual(T.hitsOf('const a = b.c;\nfoo-12-x\nsrc/a.js:3:const a', 'C:/p', 'content'), ['C:/p/src/a.js']);
  // Never above the root.
  assert.equal(T.norm('/..'), '/');
  assert.equal(T.norm('C:\\..\\x'), 'C:/x');
  assert.equal(T.norm('//srv/share/../x'), '//srv/share/x');
  assert.equal(T.norm('a/../../b'), '../b');
  // A changed file whose name is an Object property is just a name.
  const c = edit(`${CWD}\\constructor`);
  assert.deepEqual(T.untested(T.view(trail(user('u1'), c, ok(c))), {}), []);
  assert.deepEqual(T.testsFor('src/con.js', ['src/contest.js']), [], 'contest.js is nobody\'s test');
});

test('a turn cut off leaves him resting, not working for ever', () => {
  const e = edit(`${CWD}\\a.js`);
  const s = trail(user('u1'), e); // no result: Shellby was closed mid-turn
  assert.equal(T.view(s).crab.working, true);
  const v = T.view(s, { busy: false });
  assert.equal(v.crab.working, false);
  assert.equal(fileIn(v, 'a.js').writes, 1, 'its edit counts as done as it will be');
});

test('moved into a copy: what came before the note is found in the copy, replayed too', () => {
  const COPY = 'C:\\copies\\ab\\proj';
  const s = T.create(COPY); // a reopened conversation starts where it is now
  T.apply(s, user('u1'));
  T.apply(s, read(`${CWD}\\src\\a.js`));
  assert.equal(T.view(s).outside.length, 1, 'before the note, it looks like somewhere else');
  T.apply(s, { kind: 'moved', branch: 'b', base: 'main', from: CWD, cwd: COPY });
  const v = T.view(s);
  assert.equal(v.outside.length, 0);
  assert.equal(fileIn(v, 'src/a.js').reads, 1);
});

test('untested: a changed file whose test nobody read, changed or ran this turn', () => {
  const e = edit(`${CWD}\\src\\app.js`);
  const tests = { 'src/app.js': ['test/app.test.js'] };
  const v = T.view(trail(user('u1'), e, ok(e)));
  assert.deepEqual(T.untested(v, tests), [{ file: 'src/app.js', tests: ['test/app.test.js'] }]);
  // Read the test: fine.
  const r = read(`${CWD}\\test\\app.test.js`);
  assert.deepEqual(T.untested(T.view(trail(user('u1'), e, ok(e), r, ok(r))), tests), []);
  // Ran the suite, or the test by name: fine.
  assert.deepEqual(T.untested(T.view(trail(user('u1'), e, ok(e), tool('Bash', { detail: 'npm test' }))), tests), []);
  assert.deepEqual(T.untested(T.view(trail(user('u1'), e, ok(e), tool('Bash', { detail: 'node test/app.test.js' }))), tests), []);
  // A command that has nothing to do with tests: still untested.
  assert.equal(T.untested(T.view(trail(user('u1'), e, ok(e), tool('Bash', { detail: 'git status' }))), tests).length, 1);
  assert.ok(T.ranTest(['pytest -q'], 'tests/test_x.py') && T.ranTest(['go test ./...'], 'a_test.go') && !T.ranTest(['npm run lint'], 'x.test.js'));
});

test('a conversation moved into its own copy keeps its trail, in the copy', () => {
  const g = tool('Grep', { target: { pattern: 'x' } });
  const s = trail(user('u1'), read(`${CWD}\\src\\a.js`), g, ok(g, `${CWD}\\src\\b.js`), read('C:\\elsewhere\\c.js'));
  const COPY = 'C:\\Users\\me\\AppData\\Roaming\\Shellby\\worktrees\\ab12\\proj';
  assert.equal(T.rebase(s, COPY), true);
  const v = T.view(s);
  assert.equal(fileIn(v, 'src/a.js').reads, 1);
  assert.equal(fileIn(v, 'src/b.js').hits, 1);
  assert.deepEqual(v.outside.map(f => f.path), ['C:/elsewhere/c.js'], 'what was outside stays outside');
  assert.equal(T.rebase(s, COPY), false, 'already there');
});

test('the step at a number, for the replay', () => {
  const a = read(`${CWD}\\a.js`);
  const s = trail(user('u1'), a);
  assert.equal(T.stepAt(s, 1).toolId, a.id);
  assert.equal(T.stepAt(s, 2), null);
});

test('a very long conversation keeps its newest steps', () => {
  const s = T.create(CWD);
  T.apply(s, user('u1'));
  for (let i = 0; i < T.MAX_EVENTS + 10; i++) T.apply(s, read(`${CWD}\\f${i % 7}.js`));
  assert.equal(s.events.length, T.MAX_EVENTS);
  assert.equal(s.byTool.size, T.MAX_EVENTS);
});
