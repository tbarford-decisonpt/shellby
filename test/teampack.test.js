// Team packs: a repo's committed .shellby/team.json, read, checked, compared with
// what you already have, and written from what you pick.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const tp = require('../src/main/teampack');

const ROOT = 'C:\\code\\acme';
const pack = (extra = {}) => JSON.stringify({ kind: tp.KIND, version: 1, name: 'Acme', ...extra });
const parsed = (extra) => { const r = tp.parse(pack(extra)); assert.ok(r.ok, r.error); return r; };

const WF = {
  name: 'Nightly tests', description: 'Runs the tests', cwd: ROOT, concurrency: 'skip', inputs: [],
  when: [{ type: 'webhook', token: 'a'.repeat(40) }],
  steps: [{ id: 'run', type: 'run', command: 'npm test', cwd: `${ROOT}\\web` }],
  id: 'wf-1', createdAt: 1, updatedAt: 2, enabled: true,
};

// ------------------------------------------------------------ locate

test('locate finds the pack at the repo root, from a folder inside it', () => {
  const files = new Set([path.join(ROOT, '.git'), path.join(ROOT, '.shellby', 'team.json')]);
  const r = tp.locate(path.join(ROOT, 'src', 'app'), { home: 'C:\\Users\\me', exists: f => files.has(f) });
  assert.deepEqual(r, { root: ROOT, file: path.join(ROOT, '.shellby', 'team.json'), hasPack: true });
});

test('locate looks for the pack at the repo root only', () => {
  const nested = new Set([path.join(ROOT, '.git'), path.join(ROOT, 'vendor', 'x', '.shellby', 'team.json')]);
  assert.equal(tp.locate(path.join(ROOT, 'vendor', 'x'), { home: 'C:\\Users\\me', exists: f => nested.has(f) }).hasPack, false);
});

test('locate stops at the repo: a pack above the .git is not this repo\'s', () => {
  const files = new Set([path.join(ROOT, '.git'), path.join('C:\\code', '.shellby', 'team.json')]);
  const r = tp.locate(ROOT, { home: 'C:\\Users\\me', exists: f => files.has(f) });
  assert.equal(r.hasPack, false);
  assert.equal(r.root, ROOT);
});

test('locate never treats the home folder or a drive root as a project', () => {
  const home = 'C:\\Users\\me';
  const files = new Set([path.join(home, '.shellby', 'team.json'), path.join(home, '.git')]);
  assert.equal(tp.locate(path.join(home, 'Downloads'), { home, exists: f => files.has(f) }), null);
  assert.equal(tp.locate('C:\\', { home, exists: () => true }), null);
  assert.equal(tp.locate('', { home, exists: () => true }), null);
});

// ------------------------------------------------------------ parse

test('parse refuses what is not a team pack', () => {
  assert.equal(tp.parse('{').ok, false);
  assert.equal(tp.parse('{"kind":"shellby-snippets"}').ok, false);
  assert.match(tp.parse(JSON.stringify({ kind: tp.KIND, version: 2 })).error, /newer Shellby/);
  assert.match(tp.parse(' '.repeat(tp.MAX_BYTES + 1)).error, /too big/);
});

test('parse keeps the good parts and says what it left out', () => {
  const r = parsed({
    snippets: [{ name: 'Ship', text: 'Ship $ARGUMENTS', hint: 'a branch' }, { name: 'export', text: 'x' }, { name: 'ship', text: 'again' }, { name: '', text: 'no name' }],
    workflows: [WF, { name: 'No steps', steps: [] }],
    hooks: [{ event: 'Stop', command: 'echo done', about: 'Says done' }, { event: 'Nope', command: 'x' }, { event: 'Stop', command: 'echo\nmore' }],
    rules: [{ list: 'deny', rule: 'Bash(rm -rf:*)' }, { list: 'maybe', rule: 'Bash' }, { list: 'deny', rule: 'Bash(rm -rf:*)' }],
  });
  assert.deepEqual(r.pack.snippets, [{ name: 'ship', text: 'Ship $ARGUMENTS', hint: 'a branch' }]);
  assert.deepEqual(r.pack.workflows.map(w => w.name), ['Nightly tests']);
  assert.equal(r.pack.workflows[0].id, undefined, 'ids are never taken from a pack');
  assert.deepEqual(r.pack.hooks, [{ event: 'Stop', matcher: '', command: 'echo done', about: 'Says done' }]);
  assert.deepEqual(r.pack.rules, [{ list: 'deny', rule: 'Bash(rm -rf:*)' }]);
  assert.equal(r.problems.length, 8, r.problems.join('\n'));
  assert.ok(r.problems.some(p => /Shellby's own commands/.test(p)));
  assert.ok(r.problems.some(p => /twice/.test(p)));
});

test('parse caps each list', () => {
  const many = Array.from({ length: tp.LIMITS.snippets + 5 }, (_, i) => ({ name: `s${i}`, text: `t${i}` }));
  const r = parsed({ snippets: many });
  assert.equal(r.pack.snippets.length, tp.LIMITS.snippets);
  assert.ok(r.problems.some(p => /Only the first/.test(p)));
});

// ------------------------------------------------------------ {repo}

test('portable writes the repo folder as {repo}, whatever the case or slashes', () => {
  const wf = { ...WF, steps: [{ id: 'run', type: 'run', command: 'node C:/CODE/acme/tools/x.js', cwd: `${ROOT}\\web` }] };
  const p = tp.portable(wf, ROOT);
  assert.equal(p.workflow.cwd, '{repo}');
  assert.equal(p.workflow.steps[0].cwd, '{repo}\\web');
  assert.equal(p.workflow.steps[0].command, 'node {repo}/tools/x.js');
  assert.deepEqual(p.outside, []);
  for (const k of ['id', 'createdAt', 'updatedAt', 'enabled']) assert.equal(p.workflow[k], undefined, k);
  assert.deepEqual(p.workflow.when, [{ type: 'webhook' }], 'web hook tokens stay on your PC');
});

test('portable leaves a lookalike folder alone and lists paths outside the repo', () => {
  const wf = { ...WF, cwd: 'C:\\code\\acme-old', steps: [{ id: 'r', type: 'run', command: 'type D:\\notes\\todo.txt' }] };
  const p = tp.portable(wf, ROOT);
  assert.equal(p.workflow.cwd, 'C:\\code\\acme-old');
  assert.deepEqual(p.outside.sort(), ['C:\\code\\acme-old', 'D:\\notes\\todo.txt']);
});

test('localize puts this clone\'s folder back', () => {
  const back = tp.localize(tp.portable(WF, ROOT).workflow, 'D:\\work\\acme');
  assert.equal(back.cwd, 'D:\\work\\acme');
  assert.equal(back.steps[0].cwd, 'D:\\work\\acme\\web');
});

// ------------------------------------------------------------ snippets and status

test('team snippets are on only for the exact list you said yes to, and yours win', () => {
  const { pack: p } = parsed({ snippets: [{ name: 'review', text: 'Team review' }, { name: 'ship', text: 'Ship it' }] });
  const own = [{ name: 'review', text: 'My review' }];
  assert.deepEqual(tp.liveSnippets(p, own, null), []);
  const yes = tp.hashOf(p.snippets);
  assert.deepEqual(tp.liveSnippets(p, own, yes), [{ name: 'ship', text: 'Ship it', team: true }]);
  const changed = parsed({ snippets: [{ name: 'ship', text: 'Ship it now' }] }).pack;
  assert.deepEqual(tp.liveSnippets(changed, own, yes), [], 'a change waits for another yes');
});

test('hashOf ignores key order, so reformatting the file is not a change', () => {
  assert.equal(tp.hashOf([{ name: 'a', text: 'b' }]), tp.hashOf([{ text: 'b', name: 'a' }]));
  assert.notEqual(tp.hashOf([{ name: 'a', text: 'b' }]), tp.hashOf([{ name: 'a', text: 'c' }]));
});

test('status says what you have and what is waiting', () => {
  const { pack: p } = parsed({
    snippets: [{ name: 'ship', text: 'Ship it' }],
    workflows: [WF, { ...WF, name: 'Deploy' }, { ...WF, name: 'Lint' }],
    hooks: [{ event: 'Stop', command: 'echo done' }, { event: 'PreToolUse', matcher: 'Bash', command: 'echo pre' }],
    rules: [{ list: 'deny', rule: 'Bash(rm -rf:*)' }, { list: 'allow', rule: 'Bash(npm test:*)' }],
  });
  const v = tp.status(p, {
    snippets: [], trusted: 'something older',
    workflows: [{ name: 'nightly tests', same: true }, { name: 'Deploy', same: false }],
    hooks: [{ event: 'Stop', matcher: '', command: 'echo done', source: 'user' }],
    rules: [{ scope: 'local', list: 'deny', rule: 'Bash(rm -rf:*)' }],
  });
  assert.equal(v.snippets.state, 'changed');
  assert.deepEqual(v.workflows.map(w => w.state), ['added', 'different', 'new']);
  assert.deepEqual(v.hooks.map(h => [h.state, h.where]), [['added', 'user'], ['new', null]]);
  assert.match(v.hooks[1].describe, /before Claude uses a tool \(matching Bash\)/);
  assert.deepEqual(v.rules.map(r => r.state), ['added', 'new']);
  assert.equal(v.waiting, 1 + 2 + 1 + 1);
});

test('contents reads naturally', () => {
  assert.equal(tp.contents(parsed({ snippets: [{ name: 'a', text: 'a' }, { name: 'b', text: 'b' }], hooks: [{ event: 'Stop', command: 'echo' }] }).pack), '2 snippets and a hook');
  assert.equal(tp.contents(parsed({}).pack), 'nothing yet');
});

// ------------------------------------------------------------ build

test('build writes a file parse reads back the same', () => {
  const r = tp.build({
    name: 'Acme', about: 'Our setup',
    snippets: [{ name: 'ship', text: 'Ship $ARGUMENTS', hint: 'a branch' }],
    workflows: [WF],
    hooks: [{ event: 'Stop', matcher: '', command: 'echo done' }],
    rules: [{ list: 'ask', rule: 'Bash(git push:*)' }],
  }, ROOT);
  assert.ok(r.ok, r.error);
  assert.ok(r.text.endsWith('\n'));
  assert.ok(!r.text.includes('acme\\\\web'), 'no full repo path in the file');
  assert.ok(r.notes.some(n => /web hook/.test(n)));
  const back = tp.parse(r.text);
  assert.ok(back.ok);
  assert.deepEqual(back.problems, []);
  assert.equal(back.pack.name, 'Acme');
  assert.equal(back.pack.workflows[0].cwd, '{repo}');
  assert.deepEqual(back.pack.rules, [{ list: 'ask', rule: 'Bash(git push:*)' }]);
});

test('build refuses an empty pack and anything carrying a secret', () => {
  assert.match(tp.build({}, ROOT).error, /at least one/);
  const token = `ghp_${'A1b2'.repeat(9)}`;
  assert.match(tp.build({ snippets: [{ name: 'gh', text: `Use the token\n${token} to call the API` }] }, ROOT).error, /\/gh looks like it has a secret/);
  assert.match(tp.build({ hooks: [{ event: 'Stop', command: `curl -H "Authorization: ${token}" x` }] }, ROOT).error, /A hook looks like/);
  assert.match(tp.build({ rules: [{ list: 'allow', rule: `Bash(curl -H ${token}:*)` }] }, ROOT).error, /The rule .* looks like/);
  assert.match(tp.build({ name: token, rules: [{ list: 'deny', rule: 'Bash' }] }, ROOT).error, /name or description/);
  const wf = { ...WF, steps: [{ id: 'r', type: 'run', command: `echo ${token}` }] };
  assert.match(tp.build({ workflows: [wf] }, ROOT).error, /"Nightly tests" looks like/);
});

test('build notes paths teammates will not have', () => {
  const r = tp.build({ workflows: [{ ...WF, when: [], cwd: 'C:\\Users\\me\\scratch' }] }, ROOT);
  assert.ok(r.ok);
  assert.ok(r.notes.some(n => /outside this repo/.test(n)), r.notes.join('\n'));
});
