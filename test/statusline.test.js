const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { inspectPlugin, formatStatus, formatPlain, upgradeStatusLine, writeStatus, clearStatus, inspectSettings, installStatusLine, removeStatusLine, COMMAND } = require('../src/main/statusline');

const plain = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const xp = { level: 5, title: 'Claw Coder', progress: 0.6 };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-sl-'));

test('idle: face, name, level, title and XP bar', () => {
  assert.equal(plain(formatStatus({ state: 'idle', xp, now: 0 })), '🦀 Shellby · Lv 5 Claw Coder ▰▰▰▱▱');
});

test('working with helpers, asking, level up, napping', () => {
  assert.equal(plain(formatStatus({ state: 'working', busy: 2, crew: 3, xp, now: 0 })), '🦀💨 Shellby working ×2 +3 🦀 · Lv 5 Claw Coder ▰▰▰▱▱');
  assert.match(plain(formatStatus({ state: 'asking', xp, now: 0 })), /^🦀✋ Shellby needs your OK/);
  assert.match(plain(formatStatus({ state: 'levelup', xp, now: 0 })), /^🦀⭐ Shellby LEVEL UP!/);
  assert.match(plain(formatStatus({ state: 'sleeping', now: 0 })), /^🦀💤 Shellby napping$/);
});

test('health and a fresh XP gain are appended', () => {
  const line = plain(formatStatus({ state: 'idle', xp, health: { mood: 'hot', id: 'gpu-temp:0', text: '84°' }, lastXp: { amount: 25, at: 1000 }, now: 5000 }));
  assert.equal(line, '🦀 Shellby · Lv 5 Claw Coder ▰▰▰▱▱ · 🥵 GPU 84°C · +25 XP');
  assert.match(plain(formatStatus({ state: 'idle', health: { mood: 'stuffed', id: 'disk:C:', text: 'C: 8.4 GB' }, now: 0 })), /📦 C: 8.4 GB/);
  assert.doesNotMatch(plain(formatStatus({ state: 'idle', lastXp: { amount: 25, at: 0 }, now: 60000 })), /XP/, 'old XP gains fade out');
});

test('plain twin: ASCII only, for consoles without emoji (cmd.exe)', () => {
  const line = plain(formatPlain({ state: 'working', busy: 2, crew: 3, xp, streak: 4, health: { mood: 'hot', id: 'gpu-temp:0', text: '84°' }, lastXp: { amount: 25, at: 0 }, now: 1 }));
  assert.equal(line, 'Shellby working x2 +3 helpers | Lv 5 Claw Coder [###--] | streak 4d | GPU 84C hot | +25 XP');
  assert.match(line, /^[\x00-\x7f]+$/);
  assert.equal(plain(formatPlain({ state: 'idle', now: 0 })), 'Shellby');
});

test('the command picks the plain line in the classic Windows console, emoji elsewhere', () => {
  const bash = ['C:\\Program Files\\Git\\bin\\bash.exe'].find(b => fs.existsSync(b)) || 'bash';
  const dir = tmp();
  writeStatus('EMOJI', path.join(dir, 'shellby-status.txt'), 'PLAIN');
  const inner = COMMAND.slice(COMMAND.indexOf("'") + 1, COMMAND.lastIndexOf("'"));
  const runIn = extra => spawnSync(bash, ['-c', inner], { env: { ...process.env, TEMP: dir, TMPDIR: dir, OS: 'Windows_NT', WT_SESSION: '', TERM_PROGRAM: '', ...extra }, encoding: 'utf8' }).stdout;
  assert.equal(runIn({}), 'PLAIN', 'cmd.exe');
  assert.equal(runIn({ WT_SESSION: 'abc' }), 'EMOJI', 'Windows Terminal');
  assert.equal(runIn({ TERM_PROGRAM: 'vscode' }), 'EMOJI', 'VS Code');
  assert.equal(runIn({ OS: '' }), 'EMOJI', 'Linux / macOS');
  clearStatus(path.join(dir, 'shellby-status.txt'));
  assert.equal(fs.readdirSync(dir).length, 0, 'both files removed');
});

test('an older Shellby statusLine entry is upgraded in place; others are left alone', () => {
  const file = path.join(tmp(), 'settings.json');
  const old = "bash -c 'f=\"${TEMP:-${TMPDIR:-/tmp}}/shellby-status.txt\"; [ -f \"$f\" ] && cat \"$f\"; exit 0'";
  fs.writeFileSync(file, JSON.stringify({ theme: 'dark', statusLine: { type: 'command', command: old, padding: 0 } }));
  assert.equal(inspectSettings(file).outdated, true);
  assert.equal(upgradeStatusLine(file), true);
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([s.statusLine.command, s.statusLine.padding, s.theme], [COMMAND, 0, 'dark']);
  assert.equal(upgradeStatusLine(file), false, 'already current');
  fs.writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: 'mine' } }));
  assert.equal(upgradeStatusLine(file), false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).statusLine.command, 'mine');
});

test('whether the Shellby plugin is on, from enabledPlugins', () => {
  const file = path.join(tmp(), 'settings.json');
  assert.equal(inspectPlugin(file), 'none', 'no settings file');
  fs.writeFileSync(file, '{"enabledPlugins":{"other@x":true}}');
  assert.equal(inspectPlugin(file), 'none');
  fs.writeFileSync(file, '\uFEFF{"enabledPlugins":{"shellby@shellby":true}}');
  assert.equal(inspectPlugin(file), 'on');
  fs.writeFileSync(file, '{"enabledPlugins":{"shellby@shellby":false}}');
  assert.equal(inspectPlugin(file), 'off');
  fs.writeFileSync(file, '{ broken');
  assert.equal(inspectPlugin(file), 'unreadable');
});

test('a streak of 2+ days shows as a flame', () => {
  assert.equal(plain(formatStatus({ state: 'idle', xp, streak: 6, now: 0 })), '🦀 Shellby · Lv 5 Claw Coder ▰▰▰▱▱ · 🔥 6d');
  assert.doesNotMatch(plain(formatStatus({ state: 'idle', xp, streak: 1, now: 0 })), /🔥/);
});

test('unknown state falls back to idle; output is one line', () => {
  const line = formatStatus({ state: 'whatever', xp, now: 0 });
  assert.match(plain(line), /^🦀 Shellby/);
  assert.equal(line.includes('\n'), false);
});

test('the statusLine command prints the file, and nothing (exit 0) without it', () => {
  const bash = ['C:\\Program Files\\Git\\bin\\bash.exe'].find(b => fs.existsSync(b)) || 'bash';
  const dir = tmp();
  const env = { ...process.env, TEMP: dir, TMPDIR: dir, OS: '' };
  // COMMAND is `bash -c '...'`: run its inner script the same way Claude Code would.
  const inner = COMMAND.slice(COMMAND.indexOf("'") + 1, COMMAND.lastIndexOf("'"));
  let r = spawnSync(bash, ['-c', inner], { env, encoding: 'utf8' });
  assert.deepEqual([r.status, r.stdout], [0, '']);
  writeStatus('🦀 Shellby · Lv 2', path.join(dir, 'shellby-status.txt'));
  r = spawnSync(bash, ['-c', inner], { env, encoding: 'utf8' });
  assert.deepEqual([r.status, r.stdout], [0, '🦀 Shellby · Lv 2']);
  clearStatus(path.join(dir, 'shellby-status.txt'));
  assert.equal(fs.existsSync(path.join(dir, 'shellby-status.txt')), false);
});

test('settings: install into an empty config, recognise it, remove it cleanly', () => {
  const file = path.join(tmp(), 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ theme: 'dark', hooks: { Stop: [] } }, null, 2));
  assert.deepEqual(inspectSettings(file), { state: 'none' });
  const { previous } = installStatusLine(file);
  assert.equal(previous, null);
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(s.statusLine, { type: 'command', command: COMMAND, padding: 0 });
  assert.equal(s.theme, 'dark', 'everything else is kept');
  assert.equal(inspectSettings(file).state, 'ours');
  assert.ok(fs.existsSync(`${file}.shellby-backup`), 'a backup of the original is kept');
  removeStatusLine(previous, file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { theme: 'dark', hooks: { Stop: [] } });
});

test('settings: an existing status line is reported, replaced only on request, and restored on remove', () => {
  const file = path.join(tmp(), 'settings.json');
  const mine = { type: 'command', command: 'node ~/my-status.js' };
  fs.writeFileSync(file, JSON.stringify({ statusLine: mine }));
  assert.deepEqual(inspectSettings(file), { state: 'other', command: 'node ~/my-status.js' });
  const { previous } = installStatusLine(file);
  assert.deepEqual(previous, mine);
  removeStatusLine(previous, file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).statusLine, mine);
});

test("settings: never clobber what we can't read, or a statusLine changed since", () => {
  const file = path.join(tmp(), 'settings.json');
  fs.writeFileSync(file, '{ not json');
  assert.equal(inspectSettings(file).state, 'unreadable');
  assert.throws(() => installStatusLine(file));
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
  fs.writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: 'theirs-now' } }));
  removeStatusLine(null, file);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).statusLine.command, 'theirs-now');
  assert.deepEqual(inspectSettings(path.join(tmp(), 'missing.json')), { state: 'none' });
});
