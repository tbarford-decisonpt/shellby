// The tab strip's decisions (src/renderer/panel/tab-logic.js): reordering,
// keyboard moves, a tab's icon and name, steering the queue into a running
// turn, and the slash menu's ranking.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/renderer/panel/tab-logic');

const IDS = ['a', 'b', 'c', 'd'];

test('reorder moves a tab in front of another, or to the end with null', () => {
  assert.deepEqual(L.reorder(IDS, 'd', 'b'), ['a', 'd', 'b', 'c']);
  assert.deepEqual(L.reorder(IDS, 'a', null), ['b', 'c', 'd', 'a']);
  assert.deepEqual(L.reorder(IDS, 'a'), ['b', 'c', 'd', 'a']);
});

test('reorder refuses no-op moves: already there, itself, or an unknown neighbour', () => {
  assert.equal(L.reorder(IDS, 'b', 'c'), null);
  assert.equal(L.reorder(IDS, 'd', null), null);
  assert.equal(L.reorder(IDS, 'b', 'b'), null);
  assert.equal(L.reorder(IDS, 'b', 'zz'), null);
});

test('reorder leaves the list it was given alone', () => {
  const ids = [...IDS];
  L.reorder(ids, 'd', 'a');
  assert.deepEqual(ids, IDS);
});

test('nudgeBefore steps one place and says undefined at either end', () => {
  assert.equal(L.nudgeBefore(IDS, 'b', -1), 'a');
  assert.equal(L.nudgeBefore(IDS, 'b', 1), 'd');
  assert.equal(L.nudgeBefore(IDS, 'c', 1), null);
  assert.equal(L.nudgeBefore(IDS, 'a', -1), undefined);
  assert.equal(L.nudgeBefore(IDS, 'd', 1), undefined);
});

test('nudgeBefore lands where reorder puts the tab one place over', () => {
  assert.deepEqual(L.reorder(IDS, 'b', L.nudgeBefore(IDS, 'b', 1)), ['a', 'c', 'b', 'd']);
  assert.deepEqual(L.reorder(IDS, 'c', L.nudgeBefore(IDS, 'c', -1)), ['a', 'c', 'b', 'd']);
});

test('keyTarget walks with the arrows, wraps round, and jumps with Home and End', () => {
  assert.equal(L.keyTarget(IDS, 'b', 'ArrowRight'), 'c');
  assert.equal(L.keyTarget(IDS, 'b', 'ArrowLeft'), 'a');
  assert.equal(L.keyTarget(IDS, 'd', 'ArrowRight'), 'a');
  assert.equal(L.keyTarget(IDS, 'a', 'ArrowLeft'), 'd');
  assert.equal(L.keyTarget(IDS, 'c', 'Home'), 'a');
  assert.equal(L.keyTarget(IDS, 'a', 'End'), 'd');
});

test('keyTarget ignores every other key', () => {
  assert.equal(L.keyTarget(IDS, 'b', 'ArrowUp'), null);
  assert.equal(L.keyTarget(IDS, 'b', 'x'), null);
});

test('stepTarget wraps round at both ends and needs at least one tab', () => {
  assert.equal(L.stepTarget(IDS, 'd', 1), 'a');
  assert.equal(L.stepTarget(IDS, 'a', -1), 'd');
  assert.equal(L.stepTarget(IDS, 'b', 1), 'c');
  assert.equal(L.stepTarget([], 'a', 1), undefined);
});

test('shownTitle calls a blank, unnamed, unsaved tab a new task', () => {
  assert.equal(L.shownTitle({ isEmpty: true, title: 'Old name' }), 'New task');
  assert.equal(L.shownTitle({ isEmpty: true, named: true, title: 'Mine' }), 'Mine');
  assert.equal(L.shownTitle({ isEmpty: true, saved: true, title: 'Saved' }), 'Saved');
  assert.equal(L.shownTitle({ isEmpty: false, title: 'Fix login' }), 'Fix login');
});

test('firstTitle keeps short prompts whole and cuts long ones to seventy characters', () => {
  assert.equal(L.firstTitle('Fix the login', []), 'Fix the login');
  const long = 'x'.repeat(71);
  const cut = L.firstTitle(long, []);
  assert.equal(cut.length, 68);
  assert.ok(cut.endsWith('…'));
  assert.equal(L.firstTitle('y'.repeat(70), []), 'y'.repeat(70));
});

test('firstTitle names a wordless message after what is attached', () => {
  assert.equal(L.firstTitle('', ['C:\\shot.PNG', 'b.jpeg']), 'Screenshot');
  assert.equal(L.firstTitle('', ['a.png', 'notes.txt']), 'Attached files');
});

test('icon puts a question over a terminal over work, and work over outcomes', () => {
  assert.equal(L.icon({ pending: 1, inTerminal: 1 }, 'turn').kind, 'ask');
  assert.equal(L.icon({ inTerminal: 1, outcome: 'error' }, 'turn').kind, 'term');
  assert.equal(L.icon({ outcome: 'error' }, 'turn').kind, 'busy');
  assert.equal(L.icon({ outcome: 'error' }, null).kind, 'err');
  assert.equal(L.icon({ outcome: 'ok', unread: true }, null).kind, 'ok');
  assert.equal(L.icon({ outcome: 'ok', routineId: 'r' }, null).kind, 'routine');
  assert.equal(L.icon({ outcome: 'ok' }, null), null);
});

test('icon counts helpers and background tasks in its title', () => {
  assert.equal(L.icon({}, 'turn').title, 'Working');
  assert.equal(L.icon({ crew: 1 }, 'turn').title, '1 helper working');
  assert.equal(L.icon({ crew: 3 }, 'turn').title, '3 helpers working');
  assert.equal(L.icon({ crew: 1 }, 'background').title, 'Turn finished · 1 background task still running');
  assert.equal(L.icon({ crew: 2 }, 'background').title, 'Turn finished · 2 background tasks still running');
});

test('tabClass marks unread only on a tab that is not open', () => {
  assert.equal(L.tabClass({ unread: true }, { active: true }), 'tab active');
  assert.equal(L.tabClass({ unread: true, pending: 1 }, { active: false, clash: 'x', dragging: true }), 'tab unread asking clashing dragging');
  assert.equal(L.tabClass({}, {}), 'tab');
});

test('steerPlan sends everything queued up to the first /command', () => {
  const tab = { busy: true, turnId: 't1', queue: [{ id: 'q1', text: 'a' }, { id: 'q2', text: 'b' }, { id: 'q3', text: '/review' }, { id: 'q4', text: 'c' }] };
  const plan = L.steerPlan(tab);
  assert.equal(plan.live, true);
  assert.deepEqual(plan.items.map(m => m.id), ['q1', 'q2']);
  assert.equal(plan.key, 't1|q1,q2');
});

test('steerPlan sends nothing once no turn is running', () => {
  assert.deepEqual(L.steerPlan({ busy: false, turnId: 't1', queue: [{ id: 'q1', text: 'a' }] }), { live: false, items: [], key: '' });
  assert.deepEqual(L.steerPlan({ busy: true, turnId: null, queue: [{ id: 'q1', text: 'a' }] }), { live: false, items: [], key: '' });
});

test('queueBack joins the words with blank lines and keeps every file', () => {
  const back = L.queueBack([{ text: 'one', attachments: ['a.png'] }, { text: '', attachments: ['b.txt'] }, { text: 'two', attachments: [] }]);
  assert.deepEqual(back, { text: 'one\n\ntwo', files: ['a.png', 'b.txt'] });
});

test('queueTag and queueText label each queued message', () => {
  assert.equal(L.queueTag({ taken: true }, 0), 'Sending');
  assert.equal(L.queueTag({}, 0), 'Next');
  assert.equal(L.queueTag({}, 2), '#3');
  assert.equal(L.queueText({ text: 'hi', attachments: [] }), 'hi');
  assert.equal(L.queueText({ text: '', attachments: ['a'] }), '1 attached file');
  assert.equal(L.queueText({ text: '', attachments: ['a', 'b'] }), '2 attached files');
});

const SOURCES = {
  local: [{ name: 'export', kind: 'local', description: 'Save the conversation' }],
  snippets: [{ name: 'review', summary: 'Review my changes', hint: 'focus' }],
  skills: [{ name: 'Review', description: 'A skill hidden by the snippet' }, { name: 'pdf', description: 'Make a PDF' }, { name: 'reexport', description: 'x' }],
  commands: [{ name: 'compact', description: 'Shrink the context' }],
  pinned: [],
};

test('slashCandidates ranks name starts over name contains over description matches', () => {
  // "compact" is only found through its description ("Shrink the context").
  const names = L.slashCandidates('ex', SOURCES).map(t => t.name);
  assert.deepEqual(names, ['export', 'reexport', 'compact']);
  assert.deepEqual(L.slashCandidates('pdf', SOURCES).map(t => t.name), ['pdf']);
  assert.deepEqual(L.slashCandidates('shrink', SOURCES).map(t => t.name), ['compact']);
});

test('slashCandidates lets the first of a name win, so snippets hide skills', () => {
  const hits = L.slashCandidates('review', SOURCES);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0], { name: 'review', kind: 'snippet', description: 'Review my changes', hint: 'focus' });
});

test('slashCandidates puts pinned ones first while they still match the name', () => {
  const pinned = { ...SOURCES, pinned: [{ kind: 'skill', name: 'pdf' }] };
  assert.equal(L.slashCandidates('', pinned)[0].name, 'pdf');
  assert.equal(L.slashCandidates('p', pinned)[0].name, 'pdf');
  assert.deepEqual(L.slashCandidates('comp', pinned).map(t => t.name), ['compact']);
});

test('slashCandidates shows at most eight', () => {
  const skills = Array.from({ length: 12 }, (_, i) => ({ name: `s${String(i).padStart(2, '0')}` }));
  const hits = L.slashCandidates('s', { skills });
  assert.equal(hits.length, 8);
  assert.equal(hits[0].name, 's00');
});
