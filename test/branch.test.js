const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { plan, reroot, branchTitle, branchSlug, makeFence, fenceDenies, family, spellings } = require('../src/main/branch');

const T = c => c.repeat(40);
const user = (turnId, text, extra = {}) => ({ kind: 'user', turnId, text, t: 1000, ...extra });
const result = (anchor, sessionId = 'sess-1') => ({ kind: 'result', ok: true, ...(anchor ? { anchor, sessionId } : {}) });
const change = (turnId, before, after) => ({ kind: 'changes', root: 'C:\\repo', before, after, files: [{ path: 'a.js' }], turnId });
const point = (turnId, start, end, head = T('e'), endHead = head) => ({ kind: 'checkpoint', root: 'C:\\repo', start, end, head, endHead, turnId });

const convo = [
  user('t1', 'first'),
  { kind: 'text', text: 'one' },
  result('u-end-1'),
  change('t1', T('0'), T('1')),
  point('t1', T('0'), T('1')),
  user('t2', 'second', { attachments: ['C:/shot.png'] }),
  { kind: 'text', text: 'two' },
  result('u-end-2', 'sess-2'),
  point('t2', T('1'), T('1')),
  user('t3', 'third'),
  result('u-end-3', 'sess-2'),
  change('t3', T('1'), T('3')),
  point('t3', T('1'), T('3'), T('e'), T('c')),
];

test('before a message: the conversation up to the turn before, the files as they were when it was sent', () => {
  const p = plan(convo, { turnId: 't3', at: 'before' });
  assert.equal(p.ok, true);
  assert.equal(p.anchor, 'u-end-2');
  assert.equal(p.sessionId, 'sess-2', 'resumes the session that turn was written in');
  assert.equal(p.fresh, false);
  assert.equal(p.conversation, true);
  assert.deepEqual(p.files, { root: 'C:\\repo', tree: T('1'), head: T('e') });
  assert.equal(p.approx, false);
  assert.equal(p.text, 'third');
  assert.ok(!p.items.some(i => i.turnId === 't3'), 'nothing of the message itself, or of its diff');
  assert.equal(p.items.filter(i => i.kind === 'user').length, 2);
});

test('after a reply: everything up to the end of it, the files as the turn left them', () => {
  const p = plan(convo, { turnId: 't3', at: 'after' });
  assert.equal(p.anchor, 'u-end-3');
  assert.deepEqual(p.files, { root: 'C:\\repo', tree: T('3'), head: T('c') }, 'the commit checked out when it ended');
  assert.equal(p.text, '', 'nothing goes back in the box');
  assert.ok(p.items.some(i => i.kind === 'changes' && i.turnId === 't3'), "the turn's own diff came along, though it was noted after the result");
});

test('after a reply in the middle: later turns stay behind, even their late-noted diffs', () => {
  const p = plan(convo, { turnId: 't1', at: 'after' });
  assert.equal(p.anchor, 'u-end-1');
  assert.deepEqual(p.items.map(i => i.kind), ['user', 'text', 'result', 'changes', 'checkpoint']);
  assert.equal(p.files.tree, T('1'));
});

test('a message Claude read mid-turn (a steer) is part of that turn, not a turn of its own', () => {
  const steered = [
    user('t1', 'first'),
    result('u-end-1'),
    user('t2', 'second'),
    { kind: 'tool_result', id: 'tu1', text: 'ok' },
    { kind: 'user', text: 'use tabs', attachments: [], steerId: 'q1' },
    { kind: 'text', text: 'steered' },
    result('u-end-2'),
    change('t2', T('0'), T('2')),
    point('t2', T('0'), T('2')),
  ];
  const p = plan(steered, { turnId: 't2', at: 'after' });
  assert.equal(p.ok, true, 'the reply after the steer is the end of that turn');
  assert.equal(p.anchor, 'u-end-2');
  assert.deepEqual(p.files, { root: 'C:\\repo', tree: T('2'), head: T('e') });
  assert.ok(p.items.some(i => i.steerId === 'q1'), 'the steer comes along with its turn');
  const before = plan(steered, { turnId: 't2', at: 'before' });
  assert.ok(!before.items.some(i => i.steerId), 'and stays behind with it');
});

test('before the first message: a new conversation, files as they were', () => {
  const p = plan(convo, { turnId: 't1', at: 'before' });
  assert.equal(p.fresh, true);
  assert.equal(p.anchor, null);
  assert.equal(p.conversation, true);
  assert.equal(p.files.tree, T('0'));
  assert.deepEqual(p.items, []);
  assert.equal(p.text, 'first');
});

test('the message comes back with its attachments', () => {
  const p = plan(convo, { turnId: 't2', at: 'before' });
  assert.deepEqual(p.attachments, ['C:/shot.png']);
  assert.equal(p.anchor, 'u-end-1');
  assert.equal(p.sessionId, 'sess-1');
});

test('a reply still being written cannot be branched from yet', () => {
  const p = plan([user('t1', 'go'), { kind: 'text', text: '...' }], { turnId: 't1', at: 'after' });
  assert.equal(p.ok, false);
  assert.match(p.error, /hasn't finished/);
});

test('an unknown message, or an unknown place, says so', () => {
  assert.equal(plan(convo, { turnId: 'nope' }).ok, false);
  assert.equal(plan(convo, { turnId: 't1', at: 'sideways' }).ok, false);
  assert.equal(plan(null, { turnId: 't1' }).ok, false);
});

test('a fresh start counts as a beginning', () => {
  const items = [user('t1', 'a'), result('u1'), { kind: 'fresh' }, user('t2', 'b'), result('u2'), user('t3', 'c'), result('u3')];
  assert.equal(plan(items, { turnId: 't2', at: 'before' }).fresh, true);
  const p = plan(items, { turnId: 't3', at: 'before' });
  assert.equal(p.fresh, false);
  assert.equal(p.anchor, 'u2');
});

test('a turn from before anchors existed can only branch the files', () => {
  const old = [user('t1', 'a'), result(null), user('t2', 'b'), result('u2')];
  const p = plan(old, { turnId: 't2', at: 'before' });
  assert.equal(p.conversation, false);
  assert.equal(p.anchor, null);
});

test('a turn that moved into its own copy part way: the first checkpoint began it, the last ended it', () => {
  const items = [
    user('t1', 'fix it'), result('u1'),
    { ...point('t1', T('a'), T('a')), root: 'C:\\repo' },
    { kind: 'moved', branch: 'shellby/fix-it-abcdef', base: 'main' }, result('u1b'),
    { ...point('t1', T('a'), T('b')), root: 'C:\\copy' },
  ];
  assert.deepEqual(plan(items, { turnId: 't1', at: 'before' }).files, { root: 'C:\\repo', tree: T('a'), head: T('e') });
  const after = plan(items, { turnId: 't1', at: 'after' });
  assert.equal(after.files.root, 'C:\\copy');
  assert.equal(after.files.tree, T('b'));
  assert.equal(after.anchor, 'u1b', 'up to the last reply of the turn');
});

test('older transcripts: the files come from the turn\'s own diff, with no commit known', () => {
  const items = [user('t1', 'a'), result('u1'), change('t1', T('0'), T('1')), user('t2', 'b'), result('u2')];
  assert.deepEqual(plan(items, { turnId: 't1', at: 'before' }).files, { root: 'C:\\repo', tree: T('0'), head: null });
  assert.deepEqual(plan(items, { turnId: 't1', at: 'after' }).files, { root: 'C:\\repo', tree: T('1'), head: null });
});

test('older transcripts: a turn that changed nothing borrows from its neighbours, and says so', () => {
  const items = [user('t1', 'a'), result('u1'), change('t1', T('0'), T('1')), user('t2', 'b'), result('u2'), user('t3', 'c'), result('u3'), change('t3', T('2'), T('3'))];
  const mid = plan(items, { turnId: 't2', at: 'after' });
  assert.equal(mid.files.tree, T('1'));
  assert.equal(mid.approx, true);
  const first = plan([user('t1', 'a'), result('u1'), user('t2', 'b'), result('u2'), change('t2', T('5'), T('6'))], { turnId: 't1', at: 'before' });
  assert.equal(first.files.tree, T('5'), 'the next diff found the folder as it was');
  assert.equal(first.approx, true);
});

test('no snapshots at all: no files to branch, and no guess', () => {
  const p = plan([user('t1', 'a'), result('u1'), user('t2', 'b')], { turnId: 't2', at: 'before' });
  assert.equal(p.files, null);
  assert.equal(p.approx, false);
});

test('reroot points every diff and checkpoint at the copy, and nothing else', () => {
  const out = reroot(convo, 'C:\\copy');
  assert.ok(out.filter(i => i.kind === 'changes' || i.kind === 'checkpoint').every(i => i.root === 'C:\\copy'));
  assert.equal(convo[3].root, 'C:\\repo', 'the original transcript is not changed');
  assert.deepEqual(out.filter(i => i.kind === 'user'), convo.filter(i => i.kind === 'user'));
});

test('branchTitle marks it once', () => {
  assert.equal(branchTitle('Fix the login'), '⑂ Fix the login');
  assert.equal(branchTitle('⑂ Fix the login'), '⑂ Fix the login');
  assert.equal(branchTitle(''), '⑂ New task');
});

test("branchSlug keeps the original's branch name", () => {
  assert.equal(branchSlug({ worktree: { branch: 'shellby/fix-login-redirect-1a2b3c' }, title: 'x' }), 'fix-login-redirect');
  assert.equal(branchSlug({ title: '⑂ Fix the login' }), 'Fix the login');
});

// ------------------------------------------------------------ the fence

const ORIGINAL = 'C:\\Users\\me\\proj';
const COPY = 'C:\\Users\\me\\AppData\\Roaming\\Shellby\\worktrees\\abc123\\proj';
const fence = makeFence([ORIGINAL], COPY);

test("the fence keeps edits out of the original's folder", () => {
  assert.match(fenceDenies(fence, 'Edit', { file_path: path.join(ORIGINAL, 'src', 'a.js') }), /own copy at .*abc123/);
  assert.ok(fenceDenies(fence, 'Write', { file_path: 'c:/users/me/PROJ/new.txt' }), 'any case, any slash');
  assert.ok(fenceDenies(fence, 'NotebookEdit', { notebook_path: path.join(ORIGINAL, 'n.ipynb') }));
  assert.equal(fenceDenies(fence, 'Edit', { file_path: path.join(COPY, 'src', 'a.js') }), null, 'its own copy is fine');
  assert.equal(fenceDenies(fence, 'Edit', { file_path: 'C:\\Users\\me\\project\\a.js' }), null, 'a folder that only starts the same is not the original');
  assert.equal(fenceDenies(fence, 'Edit', { file_path: 'relative.js' }), null);
  assert.equal(fenceDenies(fence, 'Read', { file_path: path.join(ORIGINAL, 'a.js') }), null);
});

test('the fence stops commands that would change the original, however they spell it', () => {
  assert.ok(fenceDenies(fence, 'Bash', { command: 'cd C:\\Users\\me\\proj && npm install' }));
  assert.ok(fenceDenies(fence, 'Bash', { command: 'rm -rf /c/Users/me/proj/dist' }));
  assert.ok(fenceDenies(fence, 'PowerShell', { command: 'Remove-Item "C:/Users/me/proj/x.txt"' }));
  assert.ok(fenceDenies(fence, 'Bash', { command: 'cp a.txt C:\\Users\\me\\proj' }), 'the folder itself, at the end');
  assert.ok(fenceDenies(fence, 'PowerShell', { command: 'Set-Location C:\\Users\\me\\proj; git commit -am x' }), 'whatever runs after moving into it');
  assert.equal(fenceDenies(fence, 'Bash', { command: 'cd C:\\Users\\me\\proj && git status' }), null, 'looking there is still fine');
  assert.equal(fenceDenies(fence, 'Bash', { command: `cd C:\\Users\\me\\proj; cd ${COPY} && npm install` }), null, 'and moving back out ends it');
});

test('the fence lets commands only look at the original, and ignores lookalikes', () => {
  assert.equal(fenceDenies(fence, 'Bash', { command: 'cat C:\\Users\\me\\proj\\a.js' }), null, 'comparing with the original is fair');
  assert.equal(fenceDenies(fence, 'Bash', { command: 'git -C C:/Users/me/proj diff' }), null);
  assert.equal(fenceDenies(fence, 'Bash', { command: 'npm test --prefix C:\\Users\\me\\project' }), null);
  assert.equal(fenceDenies(fence, 'Bash', { command: 'npm test' }), null);
});

test('makeFence never fences a branch in with itself', () => {
  assert.equal(makeFence(['C:\\Users\\me\\AppData'], COPY), null, 'a folder that holds the copy');
  assert.equal(makeFence([COPY], COPY), null);
  assert.equal(makeFence([], COPY), null);
  assert.equal(makeFence([ORIGINAL], null), null);
  assert.deepEqual(makeFence([ORIGINAL, ORIGINAL.toLowerCase(), 'relative'], COPY).paths, [path.resolve(ORIGINAL)]);
  assert.equal(fenceDenies(null, 'Edit', { file_path: path.join(ORIGINAL, 'a') }), null);
});

// ------------------------------------------------------------ families

test('family: the original and every branch of it, branches of branches too', () => {
  const entries = [
    { id: 'c', branchOf: { id: 'b' }, createdAt: 3 },
    { id: 'a', createdAt: 1 },
    { id: 'b', branchOf: { id: 'a' }, createdAt: 2 },
    { id: 'd', branchOf: { id: 'a' }, createdAt: 4 },
    { id: 'x', createdAt: 5 },
  ];
  assert.deepEqual(family(entries, 'c').map(e => [e.id, e.depth]), [['a', 0], ['b', 1], ['d', 1], ['c', 2]]);
  assert.deepEqual(family(entries, 'x').map(e => e.id), ['x']);
  assert.deepEqual(family(entries, 'nope'), []);
});

test('family: a deleted original leaves its branches as their own family, and a loop ends', () => {
  const orphans = [{ id: 'b', branchOf: { id: 'gone' } }, { id: 'c', branchOf: { id: 'b' } }];
  assert.deepEqual(family(orphans, 'c').map(e => e.id), ['b', 'c']);
  const loop = [{ id: 'a', branchOf: { id: 'b' } }, { id: 'b', branchOf: { id: 'a' } }];
  assert.equal(family(loop, 'a').length, 2);
});

test("the fence lets files be copied from the original into the branch's copy, never the other way", () => {
  const orig = f => path.join(ORIGINAL, f);
  assert.equal(fenceDenies(fence, 'Bash', { command: `cp ${orig('.env.local')} .` }), null, 'a missing .env brought across');
  assert.equal(fenceDenies(fence, 'PowerShell', { command: `Copy-Item -Path "${orig('.env')}" -Destination "${path.join(COPY, '.env')}"` }), null);
  assert.equal(fenceDenies(fence, 'Bash', { command: `robocopy ${orig('node_modules')} node_modules /E /NFL` }), null);
  assert.ok(fenceDenies(fence, 'Bash', { command: `cp new.txt ${orig('new.txt')}` }), 'into the original is not');
  assert.ok(fenceDenies(fence, 'PowerShell', { command: `Copy-Item -Path a.txt -Destination ${ORIGINAL}` }));
  assert.ok(fenceDenies(fence, 'Bash', { command: `cp ${orig('.env')} . && rm -rf ${orig('dist')}` }), 'each part of a chain is judged on its own');
});

test('the fence knows the other ways a script spells the folder', () => {
  const home = path.join('C:\\', 'Users', 'me');
  const s = spellings(ORIGINAL, home);
  const forms = [String.raw`c:\users\me\proj`, 'c:/users/me/proj', '/c/users/me/proj', '/mnt/c/users/me/proj', String.raw`c:\\users\\me\\proj`,
    '~/proj', String.raw`~\proj`, '$home/proj', String.raw`%userprofile%\proj`, String.raw`$env:userprofile\proj`];
  for (const form of forms) assert.ok(s.includes(form), form);
  assert.ok(!spellings(path.join('D:\\', 'elsewhere'), home).some(x => x.startsWith('~')), 'only folders under home get ~ forms');
  const script = String.raw`node -e "require('fs').writeFileSync('C:\\Users\\me\\proj\\x', 1)"`;
  assert.ok(fenceDenies(fence, 'Bash', { command: script }), 'doubled backslashes in a script string');
});

test("the fence keeps the original's git branch from being moved or deleted, but lets it be merged in", () => {
  const f = makeFence([ORIGINAL], COPY, ['shellby/fix-login-1a2b3c', 'main', '--force']);
  assert.deepEqual(f.refs, ['shellby/fix-login-1a2b3c'], "only Shellby's own branches, never yours");
  assert.match(fenceDenies(f, 'Bash', { command: 'git branch -D shellby/fix-login-1a2b3c' }), /branch of the conversation/);
  assert.ok(fenceDenies(f, 'Bash', { command: 'git push origin --delete shellby/fix-login-1a2b3c' }));
  assert.ok(fenceDenies(f, 'Bash', { command: 'git update-ref refs/heads/shellby/fix-login-1a2b3c HEAD' }));
  assert.equal(fenceDenies(f, 'Bash', { command: 'git merge shellby/fix-login-1a2b3c' }), null, 'taking the other try\'s work in is fine');
  assert.equal(fenceDenies(f, 'Bash', { command: 'git log shellby/fix-login-1a2b3c' }), null);
  assert.equal(fenceDenies(f, 'Bash', { command: 'git branch -D shellby/my-own-try-9f9f9f' }), null);
});

test("a branch doesn't inherit the original's notes of its other branches", () => {
  const items = [user('t1', 'a'), result('u1'), { kind: 'branched-off', to: 'other' }, user('t2', 'b'), result('u2')];
  assert.ok(!plan(items, { turnId: 't2', at: 'after' }).items.some(i => i.kind === 'branched-off'));
});
