// A conversation feed's words and decisions (src/renderer/panel/feed-logic.js):
// marks, the result line, verdicts, diffs, branch notes and helper lanes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/renderer/panel/feed-logic');

const compact = n => `${Math.round(n / 1000)}k`;

test('markFor words the notes Shellby leaves in a feed, with their glyphs', () => {
  assert.deepEqual(F.markFor({ kind: 'moved', branch: 'shellby/x', base: 'main' }, compact),
    { icon: '⑂', text: 'Moved into its own copy before changing anything: branch shellby/x (from main)' });
  assert.equal(F.markFor({ kind: 'home', commits: 1, base: 'main' }, compact).text, 'Brought home: 1 commit merged into main');
  assert.equal(F.markFor({ kind: 'home', commits: 3, base: 'dev' }, compact).text, 'Brought home: 3 commits merged into dev');
  assert.equal(F.markFor({ kind: 'phone' }, compact).icon, '📱');
  assert.equal(F.markFor({ kind: 'fresh' }, compact).icon, '↻');
});

test('markFor says what a push took in from the remote first', () => {
  assert.equal(F.markFor({ kind: 'pushed', branch: 'main', remote: 'origin', commits: 2 }, compact).text, 'Pushed main to origin: 2 commits');
  assert.equal(F.markFor({ kind: 'pushed', branch: 'main', remote: 'origin', commits: 1, pulled: 4 }, compact).text, 'Pushed main to origin: 1 commit, after taking in 4 from origin');
});

test('markFor tells an automatic compaction from yours, with the size it was', () => {
  assert.equal(F.markFor({ kind: 'compacted', trigger: 'auto', preTokens: 150000 }, compact).text, 'Claude Code compacted the conversation to make room (it was 150k tokens)');
  assert.equal(F.markFor({ kind: 'compacted', trigger: 'manual' }, compact).text, 'Compacted the conversation');
});

test('markFor counts the files a rewind put back', () => {
  assert.equal(F.markFor({ kind: 'rewound', conversation: false, restored: 1 }, compact).text, 'Rewound the code: put 1 file back');
  assert.equal(F.markFor({ kind: 'rewound', conversation: false }, compact).text, 'Rewound the code: put 0 files back');
  assert.equal(F.markFor({ kind: 'rewound', code: true, restored: 2 }, compact).text, 'Rewound to an earlier message, and put 2 files back');
  assert.equal(F.markFor({ kind: 'rewound' }, compact).text, 'Rewound to an earlier message');
});

test('markFor has nothing for kinds it does not draw', () => {
  assert.equal(F.markFor({ kind: 'text' }, compact), null);
});

test('trimmedLine counts the hidden steps', () => {
  assert.equal(F.trimmedLine(1), '1 earlier step hidden — the full conversation is in History.');
  assert.match(F.trimmedLine(2400), /^2[,.  ]?400 earlier steps hidden/);
});

test('shellName names the terminal it carried on in', () => {
  assert.equal(F.shellName('wt'), 'Windows Terminal');
  assert.equal(F.shellName('pwsh7'), 'a terminal');
});

test('branchedFrom says where a branch split off and what its files are', () => {
  assert.deepEqual(F.branchedFrom({ at: 'after', text: 'Hi', shared: true }), { where: 'after its reply to "Hi"', files: "It shares the original's folder, so changes either makes, the other sees." });
  assert.equal(F.branchedFrom({ at: 'before', text: 'Hi', branch: 'b', filesNow: true }).files, 'Its own copy on b, with the files as they were in the original when it branched.');
  assert.equal(F.branchedFrom({ text: 'Hi', branch: 'b', approx: true }).files, 'Its own copy on b, with the files exactly as they were then (as near as Shellby can tell).');
  assert.deepEqual(F.branchedFrom({ text: 'Hi' }), { where: 'just before "Hi"', files: '' });
  assert.equal(F.branchedOffWhere({ at: 'after', text: 'Go' }), 'from after the reply to "Go"');
  assert.equal(F.branchedOffWhere({ text: 'Go' }), 'from just before "Go"');
});

test('compareHead counts the differing files, including those not listed', () => {
  assert.equal(F.compareHead('Other', { same: true }), 'Same files as "Other"');
  assert.equal(F.compareHead('Other', { files: [{}], more: 0 }), '1 file differ from "Other"');
  assert.equal(F.compareHead('Other', { files: [{}, {}], more: 3 }), '5 files differ from "Other"');
});

test('suggestionLabel names the always button after the rule it saves', () => {
  assert.equal(F.suggestionLabel({ type: 'setMode', mode: 'acceptEdits' }), 'Allow all edits');
  assert.equal(F.suggestionLabel({ type: 'setMode', mode: 'plan' }), 'Switch to plan');
  assert.equal(F.suggestionLabel({ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }] }), 'Always allow Bash(npm test:*)');
  assert.equal(F.suggestionLabel({ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'x'.repeat(30) }] }), `Always allow Bash(${'x'.repeat(22)}…)`);
  assert.equal(F.suggestionLabel({ type: 'addRules', rules: [{ toolName: 'WebFetch' }] }), 'Always allow WebFetch');
  assert.equal(F.suggestionLabel({ type: 'addDirectories' }), 'Always allow this folder');
  assert.equal(F.suggestionLabel(undefined), 'Always allow');
});

test('modeAfterPlan follows Claude Code into edits, never into autonomous, else ask', () => {
  assert.equal(F.modeAfterPlan([{ type: 'setMode', mode: 'acceptEdits' }]), 'acceptEdits');
  assert.equal(F.modeAfterPlan([{ type: 'setMode', mode: 'bypassPermissions' }]), null);
  assert.equal(F.modeAfterPlan([{ type: 'addRules' }]), 'ask');
  assert.equal(F.modeAfterPlan(undefined), 'ask');
});

test('decisionVerdict words the decision and colours a cancel as a deny', () => {
  assert.deepEqual(F.decisionVerdict('always'), { text: '→ Always allowed', tone: 'allow' });
  assert.deepEqual(F.decisionVerdict('allow', 'phone'), { text: '→ Allowed from your phone', tone: 'allow' });
  assert.deepEqual(F.decisionVerdict('deny', 'deck'), { text: '→ Denied from the Stream Deck', tone: 'deny' });
  assert.deepEqual(F.decisionVerdict('cancelled'), { text: '→ Cancelled', tone: 'deny' });
  assert.deepEqual(F.decisionVerdict('later'), { text: '→ later', tone: 'allow' });
});

test('questionVerdict shows the answers given, or why there are none', () => {
  assert.deepEqual(F.questionVerdict('allow', { a: 'Yes', b: 'Blue' }), { text: '→ Yes · Blue', tone: 'allow' });
  assert.deepEqual(F.questionVerdict('deny', null), { text: '→ Skipped', tone: 'deny' });
  assert.deepEqual(F.questionVerdict('cancelled', { a: 'Yes' }), { text: '→ Not answered', tone: 'allow' });
  assert.deepEqual(F.questionVerdict('allow', undefined), { text: '→ Answered', tone: 'deny' });
});

test('resultLabel says done, stopped, an error, or what a turn left running', () => {
  assert.deepEqual(F.resultLabel({ ok: true }), { label: 'done', waiting: null });
  assert.deepEqual(F.resultLabel({ ok: false }), { label: 'ended with an error', waiting: null });
  assert.deepEqual(F.resultLabel({ ok: true, interrupted: true, waiting: ['x'] }), { label: 'stopped', waiting: null });
  assert.equal(F.resultLabel({ ok: true, waiting: ['npm run dev'] }).label, 'waiting on npm run dev');
  assert.equal(F.resultLabel({ ok: true, waiting: ['a', 'b'] }).label, 'waiting on 2 background tasks');
});

test('diffRows drops file headers and classes each line', () => {
  const patch = [
    'diff --git a/x.js b/x.js', 'index 1..2 100644', '--- a/x.js', '+++ b/x.js',
    '@@ -1,2 +1,2 @@', ' same', '-old', '+new', '\\ No newline at end of file', '',
  ].join('\n');
  assert.deepEqual(F.diffRows(patch), [
    { cls: 'hunk', text: '@@ -1,2 +1,2 @@' }, { cls: 'ctx', text: ' same' }, { cls: 'del', text: '-old' },
    { cls: 'add', text: '+new' }, { cls: 'meta', text: '\\ No newline at end of file' },
  ]);
});

test('diffRows keeps a removed line that looks like a header inside a hunk', () => {
  const rows = F.diffRows('@@ -1 +1 @@\n--- a note\n+++ another');
  assert.deepEqual(rows.map(r => r.cls), ['hunk', 'del', 'add']);
});

test('diffRows gives an empty line a space and stops at four thousand lines', () => {
  assert.deepEqual(F.diffRows('@@ x @@\n\nctx'), [{ cls: 'hunk', text: '@@ x @@' }, { cls: 'ctx', text: ' ' }, { cls: 'ctx', text: 'ctx' }]);
  assert.equal(F.diffRows(`@@ x @@\n${'+a\n'.repeat(5000)}`).length, 4000);
  assert.deepEqual(F.diffRows(''), [{ cls: 'ctx', text: ' ' }]);
});

test('laneMeta lists tools, tokens and time, leaving out what is not known', () => {
  const fmt = { compact, duration: ms => `${ms / 1000}s` };
  assert.equal(F.laneMeta({ toolUses: 1, tokens: 12000 }, 3000, fmt), '1 tool · 12k tok · 3s');
  assert.equal(F.laneMeta({ toolUses: 4 }, 1000, fmt), '4 tools · 1s');
  assert.equal(F.laneMeta(null, 2000, fmt), '2s');
});

test('laneFirstLine is the first line with words, without markdown, at most 120 characters', () => {
  assert.equal(F.laneFirstLine('\n\n## **Found** it\nmore'), 'Found it');
  assert.equal(F.laneFirstLine(`${'x'.repeat(200)}`).length, 120);
  assert.equal(F.laneFirstLine('\n#\n'), null);
});

test('notes on a plan go back as one message: each quoted line, its note, anything else, and what to do', () => {
  const m = F.planNotesMessage([{ quote: '2. Add a   cache\nlayer', note: ' Skip the cache. ' }, { quote: '', note: 'Name the branch fix/parser' }, { quote: 'x', note: '   ' }], ' Keep it small ');
  assert.equal(m, [
    'The user read your plan and wants it revised before anything changes.',
    'Their notes on it:',
    '> 2. Add a cache layer\nSkip the cache.',
    'Name the branch fix/parser',
    'And overall: Keep it small',
    'Revise the plan with these in mind and present it again for approval.',
  ].join('\n\n'));
  assert.equal(F.planNotesMessage([], '  '), null, 'nothing to say: nothing sent');
  assert.match(F.planNotesMessage(null, 'Smaller, please'), /What they said: Smaller, please/);
  const long = F.planNotesMessage([{ quote: 'q'.repeat(500), note: 'n'.repeat(5000) }]);
  assert.ok(long.length <= 3800 && long.endsWith('…'));
  assert.ok(long.includes(`> ${'q'.repeat(159)}…`), 'a long line is quoted short');
});

test('quizWorthy: a quiz is offered on turns of a real size, the same mark main checks', () => {
  assert.equal(F.QUIZ_MIN_LINES, require('../src/main/quiz').MIN_LINES);
  assert.equal(F.quizWorthy({ added: 20, removed: 10 }), true);
  assert.equal(F.quizWorthy({ added: 3, removed: 1 }), false);
  assert.equal(F.quizWorthy({}), false);
});

test('quizResult: all right, a pass, and a nudge to read the diff', () => {
  assert.match(F.quizResult(3, 3), /^All 3 right/);
  assert.match(F.quizResult(2, 3), /^2 of 3 right\. Worth a look/);
  assert.match(F.quizResult(0, 3), /read through the diff/);
});

test("a helper's lane shows its share of the window once known, and says what it spent", () => {
  const fmt = { compact: n => `${Math.round(n / 1000)}k`, duration: ms => `${ms / 1000}s` };
  assert.equal(F.laneMeta({ toolUses: 2, tokens: 12000, share: '~2%' }, 3000, fmt), '2 tools · 12k tok · ~2% · 3s');
  assert.equal(F.laneCostTitle({ tokens: 9000, read: 40000, shareText: '~2%' }, fmt.compact), 'This helper sent and wrote 9k new tokens, and re-read 40k from the prompt cache.\nAbout 2% of your 5-hour window (an estimate).');
  assert.equal(F.laneCostTitle({ tokens: 9000, read: 0, shareText: '<1%' }, fmt.compact), 'This helper sent and wrote 9k new tokens.\nUnder 1% of your 5-hour window (an estimate).');
  assert.equal(F.laneCostTitle(null, fmt.compact), '');
});
