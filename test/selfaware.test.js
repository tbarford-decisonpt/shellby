const { test } = require('node:test');
const assert = require('node:assert/strict');
const selfaware = require('../src/main/selfaware');
const { toolsFor } = require('../src/main/crabmcp');

const { systemNote, usageNote, withUsageNote, parseSchedule, checkSuggestion, suggestReply, FEATURE_IDS } = selfaware;

const NOW = new Date(2026, 9, 7, 12, 0).getTime();
const HOUR = 3600000;

// ------------------------------------------------------------------ the note

test('the note is the same bytes every time, so Claude Code can cache it', () => {
  assert.equal(systemNote(), systemNote());
  assert.equal(systemNote({ suggestions: false }), systemNote({ suggestions: false }));
});

test('the note stays small: it rides along on every turn', () => {
  // Raise these deliberately, not by accident: every character is paid for on
  // every turn of every conversation (cached, but still paid).
  assert.ok(systemNote().length <= 1600, `note is ${systemNote().length} chars`);
  assert.ok(JSON.stringify(toolsFor()).length <= 2600, `tools are ${JSON.stringify(toolsFor()).length} chars`);
});

test('the note names every feature it can offer, and only offers with suggestions on', () => {
  const on = systemNote();
  for (const id of FEATURE_IDS) assert.ok(on.includes(selfaware.FEATURES[id].name), id);
  assert.match(on, /mcp__shellby__suggest/);
  const off = systemNote({ suggestions: false });
  assert.doesNotMatch(off, /suggest/);
  assert.match(off, /running inside Shellby/);
});

test('the note tells Claude where [Shellby: lines come from', () => {
  assert.match(systemNote(), /"\[Shellby:" was added by the app/);
});

// ------------------------------------------------------------------ usage

const usage = (five, seven = 10, resetIn = 2 * HOUR) => ({
  fiveHour: { pct: five, resetsAt: NOW + resetIn },
  sevenDay: { pct: seven, resetsAt: NOW + 4 * 24 * HOUR },
});

test('says nothing below 80%', () => {
  assert.deepEqual(usageNote(usage(79), 0, NOW), { told: 0, text: null });
  assert.deepEqual(usageNote(null, 0, NOW), { told: 0, text: null });
});

test('speaks up once at 80%, then not again until 95%', () => {
  const first = usageNote(usage(82), 0, NOW);
  assert.equal(first.told, 80);
  assert.match(first.text, /^\[Shellby: the user's 5-hour Claude usage is at 82% \(resets 14:00\)\. Keep this lean/);
  assert.deepEqual(usageNote(usage(90), first.told, NOW), { told: 80, text: null });
  const second = usageNote(usage(96), 80, NOW);
  assert.equal(second.told, 95);
  assert.match(second.text, /96%.*Do only what is essential/);
  assert.deepEqual(usageNote(usage(99), 95, NOW), { told: 95, text: null });
});

test('reports the fuller window, weekly included', () => {
  const r = usageNote(usage(20, 88), 0, NOW);
  assert.match(r.text, /weekly Claude usage is at 88% \(resets Sun 12:00\)/);
});

test('a window that has reset is ignored, and lowers what was told', () => {
  const stale = { fiveHour: { pct: 97, resetsAt: NOW - 1000 }, sevenDay: { pct: 30, resetsAt: NOW + 3 * 24 * HOUR } };
  assert.deepEqual(usageNote(stale, 95, NOW), { told: 0, text: null });
  // ...so the next climb is reported again.
  assert.equal(usageNote(usage(85), 0, NOW).told, 80);
});

test('the note goes after the user\'s own words', () => {
  assert.equal(withUsageNote('fix it', null), 'fix it');
  assert.equal(withUsageNote('fix it', '[Shellby: x]'), 'fix it\n\n[Shellby: x]');
  const pic = [{ type: 'image', source: {} }, { type: 'text', text: 'what is this' }];
  assert.deepEqual(withUsageNote(pic, '[Shellby: x]'), [...pic, { type: 'text', text: '[Shellby: x]' }]);
});

test('slash commands are left as typed', () => {
  assert.equal(selfaware.isSlashCommand('/compact'), true);
  assert.equal(selfaware.isSlashCommand('  /review now'), true);
  assert.equal(selfaware.isSlashCommand('fix /etc/hosts'), false);
  assert.equal(selfaware.isSlashCommand([{ type: 'text', text: '/x' }]), false);
});

// ------------------------------------------------------------------ schedules

test('parses the compact schedules the tool accepts', () => {
  assert.deepEqual(parseSchedule('daily 8:30'), { type: 'daily', time: '08:30' });
  assert.deepEqual(parseSchedule('Weekly Fri,Mon 17:00'), { type: 'weekly', time: '17:00', days: [1, 5] });
  assert.deepEqual(parseSchedule('weekly mon, wed 09:15'), { type: 'weekly', time: '09:15', days: [1, 3] });
  assert.deepEqual(parseSchedule('every 4h'), { type: 'interval', everyHours: 4 });
  assert.deepEqual(parseSchedule('every 12 hours'), { type: 'interval', everyHours: 12 });
});

test('rejects schedules routines would reject', () => {
  for (const bad of ['daily 25:00', 'weekly someday 10:00', 'every 0h', 'every 500h', 'tomorrow', '', null, 42]) {
    assert.equal(parseSchedule(bad), null, String(bad));
  }
});

// ------------------------------------------------------------------ suggest

const open = (over = {}) => ({ enabled: true, muted: [], offered: new Set(), focusOn: false, notifyOn: false, inRepo: true, ...over });

test('a routine card carries a draft the editor can open', () => {
  const r = checkSuggestion({ feature: 'routine', why: 'You do this every Friday', name: 'Tidy Downloads', prompt: 'Sort Downloads by type', schedule: 'weekly fri 17:00' }, open());
  assert.equal(r.ok, true);
  assert.deepEqual(r.card.draft, { name: 'Tidy Downloads', prompt: 'Sort Downloads by type', schedule: { type: 'weekly', time: '17:00', days: [5] }, when: r.card.draft.when });
  assert.match(r.card.draft.when, /^Fri at /);
  assert.equal(r.card.title, 'Make this a routine?');
});

test('a routine needs a prompt and a schedule it can read', () => {
  assert.match(checkSuggestion({ feature: 'routine', why: 'x', schedule: 'daily 09:00' }, open()).reason, /needs the `prompt`/);
  assert.match(checkSuggestion({ feature: 'routine', why: 'x', prompt: 'p', schedule: 'often' }, open()).reason, /must look like/);
});

test('focus defaults to 25 minutes and is skipped while one is running', () => {
  assert.equal(checkSuggestion({ feature: 'focus', why: 'Long build' }, open()).card.minutes, 25);
  assert.equal(checkSuggestion({ feature: 'focus', why: 'x', minutes: 50 }, open()).card.minutes, 50);
  assert.equal(checkSuggestion({ feature: 'focus', why: 'x', minutes: 7 }, open()).card.minutes, 25);
  assert.match(checkSuggestion({ feature: 'focus', why: 'x' }, open({ focusOn: true })).reason, /already running/);
});

test('review needs a git repo; notify is skipped once set up', () => {
  assert.match(checkSuggestion({ feature: 'review', why: 'x' }, open({ inRepo: false })).reason, /not a git repository/);
  assert.equal(checkSuggestion({ feature: 'review', why: 'x' }, open()).ok, true);
  assert.match(checkSuggestion({ feature: 'notify', why: 'x' }, open({ notifyOn: true })).reason, /already set up/);
});

test('the limits live in code: off, muted, once each, two per conversation', () => {
  const ask = (args, state) => checkSuggestion({ why: 'because', ...args }, state);
  assert.match(ask({ feature: 'focus' }, open({ enabled: false })).reason, /turned suggestions off/);
  assert.match(ask({ feature: 'focus' }, open({ muted: ['focus'] })).reason, /asked not to be offered Guard my focus/);
  assert.match(ask({ feature: 'focus' }, open({ offered: new Set(['focus']) })).reason, /already offered/);
  assert.match(ask({ feature: 'notify' }, open({ offered: new Set(['focus', 'review']) })).reason, /had enough suggestions/);
  assert.match(ask({ feature: 'teleport' }, open()).reason, /no Shellby feature called "teleport"/);
  assert.match(checkSuggestion({ feature: 'focus' }, open()).reason, /why it helps/);
  for (const r of [ask({ feature: 'focus' }, open({ enabled: false })), ask({ feature: 'x' }, open())]) assert.match(r.reason, /^Not shown: .*Carry on without it\.$/);
});

test('text from the model is flattened and capped before it reaches a card', () => {
  const r = checkSuggestion({ feature: 'review', why: `line one\nline two\u0007${'x'.repeat(300)}` }, open());
  assert.ok(!/[\n\u0007]/.test(r.card.why));
  assert.equal(r.card.why.length, 120);
  assert.equal(checkSuggestion(null, open()).ok, false);
  assert.equal(checkSuggestion(['focus'], open()).ok, false);
});

test('the reply tells Claude the card is the user\'s to tap', () => {
  const { card } = checkSuggestion({ feature: 'focus', why: 'x' }, open());
  assert.match(suggestReply(card), /only happens if they tap it/);
});
