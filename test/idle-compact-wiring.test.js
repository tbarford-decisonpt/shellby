const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { compactIdleTabs } = require('../src/main/wiring/idle-compact');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const AT = new Date(2026, 9, 14, 12, 0).getTime();
const NOW = AT + 55 * MIN;
const HOME = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-idle-home-'))); // not this PC's own ~/.claude
const at = now => ({ now, home: HOME });

function project(settings = null) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-idle-')));
  if (settings) {
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify(settings));
  }
  return dir;
}

function world({ on = true, cwd = project(), tokens = 250000, sendThrows = false } = {}) {
  const tab = {
    id: 't1', saved: true, inTerminal: null,
    session: { cwd, busy: false, pending: new Map(), runningCrew: () => [], cache: { at: AT, ttlMs: HOUR }, context: { tokens } },
  };
  const sent = [];
  const told = [];
  const d = {
    config: { get: k => ({ idleCompact: on, crabOnly: false })[k] },
    claudeStatus: { loggedIn: true },
    manager: {
      tabs: new Map([[tab.id, tab]]),
      send: (id, prompt, item) => { if (sendThrows) throw new Error('busy'); sent.push({ id, prompt, item }); return 'turn-1'; },
    },
    panel: 'panel',
    send: (win, channel, payload) => told.push({ win, channel, payload }),
    log: { warn: () => {} },
  };
  return { d, tab, sent, told };
}

test('sends /compact to a due tab, tells the panel, and marks the turn as idle compaction', () => {
  const { d, tab, sent, told } = world();
  assert.deepEqual(compactIdleTabs(d, at(NOW)), ['t1']);
  assert.deepEqual(sent, [{ id: 't1', prompt: '/compact', item: { kind: 'user', text: '/compact' } }]);
  assert.equal(told[0].channel, 'tab:sent');
  assert.equal(told[0].payload.item.turnId, 'turn-1');
  assert.equal(tab.idleCompacting, true);
  assert.equal(tab.idleCompactFor, AT);
});

test('does nothing with the setting off', () => {
  const { d, sent } = world({ on: false });
  assert.deepEqual(compactIdleTabs(d, at(NOW)), []);
  assert.equal(sent.length, 0);
});

test('a project whose settings say idleCompaction: false is left alone', () => {
  const { d, sent } = world({ cwd: project({ idleCompaction: false }) });
  assert.deepEqual(compactIdleTabs(d, at(NOW)), []);
  assert.equal(sent.length, 0);
});

test("a project's env block can raise the token floor", () => {
  const { d, sent } = world({ cwd: project({ env: { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '300000' } }) });
  assert.deepEqual(compactIdleTabs(d, at(NOW)), []);
  assert.equal(sent.length, 0);
});

test("a project's env block wins over this PC's environment, as in Claude Code", () => {
  const { d } = world({ cwd: project({ env: { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '200000' } }) });
  process.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS = '900000';
  try { assert.deepEqual(compactIdleTabs(d, at(NOW)), ['t1']); } finally { delete process.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS; }
});

test("a tab in its own copy also reads the original checkout's settings (its settings.local.json isn't copied)", () => {
  const original = project();
  fs.mkdirSync(path.join(original, '.claude'));
  fs.writeFileSync(path.join(original, '.claude', 'settings.local.json'), JSON.stringify({ idleCompaction: false }));
  const { d, tab, sent } = world();
  tab.worktree = { originalCwd: original };
  assert.deepEqual(compactIdleTabs(d, at(NOW)), []);
  assert.equal(sent.length, 0);
});

test('only once per cache, even when the send fails', () => {
  const { d, tab, sent } = world({ sendThrows: true });
  assert.deepEqual(compactIdleTabs(d, at(NOW)), []);
  assert.equal(tab.idleCompactFor, AT);
  assert.equal(tab.idleCompacting, undefined);
  assert.deepEqual(compactIdleTabs(d, at(NOW + MIN)), []);
  assert.equal(sent.length, 0);
});
