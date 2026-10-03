const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toMarkdown, fileName } = require('../src/main/exporter');

const entry = { title: 'Fix the login bug', cwd: 'C:\\code\\app', createdAt: Date.UTC(2026, 9, 2, 9, 30) };

test('toMarkdown: you, Claude, the tools it used and the marks along the way', () => {
  const md = toMarkdown(entry, [
    { kind: 'user', text: 'why does login fail?\nit says 500', t: Date.UTC(2026, 9, 2, 9, 31), attachments: ['C:\\shot.png'] },
    { kind: 'tool', label: 'Read', detail: 'src/login.js' },
    { kind: 'text', text: 'The session cookie is never set.' },
    { kind: 'text', text: 'helper chatter', sub: true },
    { kind: 'shell', command: 'npm test', output: 'ok 1' },
    { kind: 'changes', files: [{ path: 'src/login.js' }] },
    { kind: 'result', ok: true },
    { kind: 'compacted' },
    { kind: 'rewound' },
  ]);
  assert.match(md, /^# Fix the login bug\n/);
  assert.match(md, /Folder: `C:\\code\\app`/);
  assert.match(md, /\*\*You\*\* · 2026-10-02 09:31\n\n> why does login fail\?\n> it says 500/);
  assert.match(md, /- 📎 `C:\\shot.png`/);
  assert.match(md, /- \*Read\* `src\/login.js`/);
  assert.match(md, /\*\*Claude\*\*\n\nThe session cookie is never set\./);
  assert.ok(!md.includes('helper chatter'), "helpers' own lines stay out");
  assert.match(md, /```\n> npm test\nok 1\n```/);
  assert.match(md, /\*Changed 1 file:\* `src\/login.js`/);
  assert.match(md, /conversation compacted/);
  assert.match(md, /rewound to an earlier message/);
  assert.ok(!/\n{3,}/.test(md), 'no runs of blank lines');
});

test('toMarkdown: a fence never closes early on backticks in the text', () => {
  const md = toMarkdown(entry, [{ kind: 'shell', command: 'cat x.md', output: 'a\n```\nb' }]);
  assert.match(md, /````\n> cat x.md\na\n```\nb\n````/);
});

test('toMarkdown: errors and stops are noted', () => {
  const md = toMarkdown(entry, [{ kind: 'result', ok: false, error: 'Rate limited\nmore' }, { kind: 'result', ok: false, interrupted: true }]);
  assert.match(md, /> ⚠ Rate limited\n/);
  assert.match(md, /\*\(stopped\)\*/);
});

test('fileName: the title, minus what Windows will not take', () => {
  assert.equal(fileName({ title: 'Fix: a/b <c> "d"?' }), 'Fix ab c d.md');
  assert.equal(fileName({}), 'conversation.md');
  assert.equal(fileName({ title: '???' }), 'conversation.md');
});
