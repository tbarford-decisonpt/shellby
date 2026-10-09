// Saying no to the same thing five times: counting the nos (one per turn),
// the permission rule they become, which settings file it goes in, and the
// diff the card shows before anything is written.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const c = require('../src/main/corrections');
const dr = require('../src/main/deny-rules');

const ROOT = 'C:\\code\\shellby';
const OTHER = 'C:\\code\\other';
const T0 = Date.UTC(2026, 9, 1, 12);
const MIN = 60e3;

const deny = (cmd, batch, root = ROOT) => ({ kind: 'deny', root, project: path.win32.basename(root), batch, ...c.denySubject('Bash', { command: cmd }, root) });

function run(events) {
  let s = null;
  const offers = [];
  events.forEach((e, i) => {
    const r = c.record(s, e, { now: T0 + i * MIN, id: `o${i}` });
    s = r.store;
    offers.push(r.offer);
  });
  return { store: s, offers };
}

test('the rule for a denied command, folder, file, site and tool', () => {
  assert.equal(dr.ruleFor({ tool: 'Bash', what: 'command', label: 'git push' }), 'Bash(git push:*)');
  assert.equal(dr.ruleFor({ tool: 'Edit', what: 'folder', label: 'src/generated/' }), 'Edit(src/generated/**)');
  assert.equal(dr.ruleFor({ tool: 'Write', what: 'file', label: 'package.json' }), 'Write(package.json)');
  assert.equal(dr.ruleFor({ tool: 'WebFetch', what: 'site', label: 'example.com' }), 'WebFetch(domain:example.com)');
  assert.equal(dr.ruleFor({ tool: 'mcp__github__create_issue', what: 'tool', label: 'mcp__github__create_issue' }), 'mcp__github__create_issue');
  // Blocking all of Bash or Edit is never what five nos to one thing meant.
  assert.equal(dr.ruleFor({ tool: 'Bash', what: 'tool', label: 'Bash' }), '');
});

test('nos are counted once per turn, and only reach the threshold at five', () => {
  const events = ['t1', 't1', 't2', 't3', 't4'].map((b, i) => ({ ...deny('git push', b), at: T0 + i }));
  assert.equal(dr.denials(events, events[4], T0).count, 4);
  assert.equal(dr.detect(events, events[4], T0), null);
  const five = [...events, { ...deny('git push --force', 't5'), at: T0 + 9 }];
  const p = dr.detect(five, five[5], T0);
  assert.equal(p.type, 'deny-rule');
  assert.equal(p.perm, 'Bash(git push:*)');
  assert.equal(p.count, 5);
  assert.equal(p.scope, 'local');
});

test('nos given in two projects go in the user settings', () => {
  const events = [1, 2, 3, 4, 5].map(i => ({ ...deny('git push', `t${i}`, i % 2 ? ROOT : OTHER), at: T0 + i }));
  assert.equal(dr.detect(events, events[4], T0).scope, 'user');
  assert.equal(dr.fileFor('user', ROOT, 'C:\\Users\\me'), path.join('C:\\Users\\me', '.claude', 'settings.json'));
  assert.equal(dr.fileFor('local', ROOT), path.join(ROOT, '.claude', 'settings.local.json'));
});

test('the fifth no in different turns offers a deny rule, once', () => {
  const { store, offers } = run([1, 2, 3, 4, 5, 6].map(i => deny('git push', `tab:t${i}`)));
  assert.equal(offers[1].type, 'deny'); // the CLAUDE.md card still comes at two
  assert.equal(offers[4].type, 'deny-rule');
  assert.equal(offers[4].rule, 'Bash(git push:*)');
  assert.match(offers[4].headline, /5 times/);
  assert.equal(offers[5], null);
  const after = c.resolve(store, offers[4].id, 'dismissed');
  assert.equal(c.blocked(after.offers, OTHER, { type: 'deny-rule', key: 'deny-rule:Bash(git push:*)' }), true);
  assert.deepEqual(c.learnedRoots(c.resolve(store, offers[4].id, 'added')), []);
});

test('the diff marks only what changes in the permissions block', () => {
  const p = dr.plan({ model: 'x', permissions: { deny: ['Read(.env)'] } }, 'Bash(git push:*)');
  assert.equal(p.ok, true);
  assert.deepEqual(p.next.permissions.deny, ['Read(.env)', 'Bash(git push:*)']);
  assert.match(p.diff, /^- {7}"Read\(\.env\)"$/m);
  assert.match(p.diff, /^\+ {7}"Read\(\.env\)",$/m);
  assert.match(p.diff, /^\+ {7}"Bash\(git push:\*\)"$/m);
  assert.doesNotMatch(p.diff, /model/);
  assert.equal(dr.plan({ permissions: { deny: ['Bash(x:*)'] } }, 'Bash(x:*)').ok, false);
  assert.equal(dr.plan({}, 'not a rule!').ok, false);
});

test('add writes only what was shown, and keeps the rest of the file', () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-deny-')));
  try {
    const file = path.join(dir, '.claude', 'settings.local.json');
    const shown = dr.preview(file, 'Bash(git push:*)');
    assert.equal(shown.ok, true);
    assert.equal(shown.exists, false);
    assert.equal(dr.add(file, 'Bash(git push:*)', 'something else').changed, true);
    assert.equal(fs.existsSync(file), false);
    assert.equal(dr.add(file, 'Bash(git push:*)', shown.added).ok, true);
    fs.writeFileSync(file, JSON.stringify({ env: { A: '1' }, permissions: { deny: ['Bash(git push:*)'] } }));
    const next = dr.preview(file, 'WebFetch(domain:example.com)');
    assert.equal(dr.add(file, 'WebFetch(domain:example.com)', next.added).ok, true);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(data.env, { A: '1' });
    assert.deepEqual(data.permissions.deny, ['Bash(git push:*)', 'WebFetch(domain:example.com)']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
