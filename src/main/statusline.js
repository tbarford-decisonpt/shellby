// Shellby's face in Claude Code's status line. Shellby keeps one ready-made line
// in a temp file; Claude Code's statusLine command just prints it (no network,
// no Node, ~10 ms). When Shellby quits the file goes away and the line is empty.
// A crash can't remove it, so Shellby touches it every minute while he runs and
// the command ignores one older than two: a frozen line goes blank instead.
//
// formatStatus() is pure (test/statusline.test.js); the rest is small file I/O.
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATUS_FILE = path.join(os.tmpdir(), 'shellby-status.txt');
// The classic Windows console (cmd.exe) can't draw emoji or ▰▱, so Shellby also
// writes an all-ASCII twin, and the command picks it there.
const plainFile = file => file.replace(/\.txt$/, '-plain.txt');
// The statusLine command: print the file if it's there and fresh, else nothing.
// Bash and find (Claude Code runs it through Git Bash on Windows), nothing else.
// Windows Terminal (WT_SESSION) and VS Code (TERM_PROGRAM) get the emoji line;
// the classic Windows console gets the plain one. A find that can't run at all
// (some other find.exe first on PATH) trusts the file, as before.
const COMMAND = 'bash -c \'d="${TEMP:-${TMPDIR:-/tmp}}"; f="$d/shellby-status.txt"; if [ "$OS" = Windows_NT ] && [ -z "$WT_SESSION$TERM_PROGRAM" ]; then f="$d/shellby-status-plain.txt"; fi; [ -f "$f" ] && [ -n "$(find "$f" -mmin -2 2>/dev/null || echo y)" ] && cat "$f"; exit 0\'';
const MARK = 'shellby-status.txt'; // how we recognise our own statusLine

const C = { reset: '\x1b[0m', dim: '\x1b[2m', gold: '\x1b[38;5;221m', coral: '\x1b[38;5;209m', glass: '\x1b[38;5;116m', amber: '\x1b[38;5;214m', red: '\x1b[38;5;203m' };

const FACE = {
  idle: '🦀', working: '🦀💨', asking: '🦀✋', success: '🦀🎉', error: '🦀😵',
  learned: '🦀✨', unlocked: '🦀🏆', levelup: '🦀⭐', sleeping: '🦀💤',
  molting: '🦀🐚', petted: '🦀💕', cheer: '🦀💃', refreshed: '🦀☀️',
};
const HEALTH = {
  hot: { icon: '🥵', color: C.amber }, scorching: { icon: '🔥', color: C.red },
  dizzy: { icon: '💫', color: C.amber }, stuffed: { icon: '📦', color: C.amber },
};

function bar(progress, n = 5) {
  const p = Math.max(0, Math.min(1, Number(progress) || 0));
  const full = Math.round(p * n);
  return `${C.gold}${'▰'.repeat(full)}${C.dim}${'▱'.repeat(n - full)}${C.reset}`;
}

/**
 * One status line.
 *   s: { state, busy, crew, background, health: { mood, text, id }|null, xp: { level, title, progress }|null,
 *        lastXp: { amount, at }|null, now }
 */
function formatStatus(s) {
  const state = FACE[s.state] ? s.state : 'idle';
  const parts = [];
  let head = `${FACE[state]} ${C.coral}Shellby${C.reset}`;
  if (state === 'working') head += ` ${C.dim}working${s.busy > 1 ? ` ×${s.busy}` : ''}${C.reset}`;
  else if (state === 'asking') head += ` ${C.amber}needs your OK${C.reset}`;
  else if (state === 'levelup' && s.xp) head += ` ${C.gold}LEVEL UP!${C.reset}`;
  else if (state === 'sleeping') head += ` ${C.dim}napping${C.reset}`;
  if (s.crew > 0) head += ` ${C.glass}+${s.crew} 🦀${C.reset}`;
  parts.push(head);
  if (s.xp) parts.push(`${C.gold}Lv ${s.xp.level}${C.reset} ${s.xp.title} ${bar(s.xp.progress)}`);
  if (s.streak >= 2) parts.push(`${C.coral}🔥 ${s.streak}d${C.reset}`);
  if (s.health && HEALTH[s.health.mood]) {
    const h = HEALTH[s.health.mood];
    parts.push(`${h.color}${h.icon} ${healthLabel(s.health)}${C.reset}`);
  }
  if (s.limit) parts.push(`${C.amber}⏳ limit · back in ${limitLeft(s)}${C.reset}`);
  if (s.focus?.phase) parts.push(`${C.glass}${s.focus.phase === 'focus' ? '⛑️ focus' : '☕ break'} ${focusLeft(s)}${C.reset}`);
  if (s.ci > 0) parts.push(`${C.red}❌ CI${s.ci > 1 ? ` ×${s.ci}` : ''}${C.reset}`);
  // Commands a turn backgrounded and never accounted for. Shellby is told when
  // they start, never when they finish, so this says 'left running', not 'running'.
  if (s.background > 0) parts.push(`${C.amber}⚙ ${s.background} left running${C.reset}`);
  if (s.lastXp && s.now - s.lastXp.at < 15000) parts.push(`${C.gold}+${s.lastXp.amount} XP${C.reset}`);
  return parts.join(` ${C.dim}·${C.reset} `);
}

const PLAIN_FACE = {
  idle: '', working: ' working', asking: ' needs your OK', success: ' done!', error: ' hit a snag',
  learned: ' learned a trick', unlocked: ' got a trophy!', levelup: ' LEVEL UP!', sleeping: ' napping',
  molting: ' moving shells', petted: ' happy', cheer: ' back to green!', refreshed: ' ready again!',
};
const PLAIN_HEALTH = { hot: 'hot', scorching: 'very hot', dizzy: 'memory full', stuffed: 'disk full' };

/** The same line in plain ASCII (for consoles without emoji): Shellby working | Lv 5 Claw Coder [###--] */
function formatPlain(s) {
  const state = PLAIN_FACE[s.state] !== undefined ? s.state : 'idle';
  let head = `${C.coral}Shellby${C.reset}${PLAIN_FACE[state]}`;
  if (state === 'working' && s.busy > 1) head += ` x${s.busy}`;
  if (s.crew > 0) head += ` +${s.crew} helpers`;
  const parts = [head];
  if (s.xp) {
    const full = Math.round(Math.max(0, Math.min(1, Number(s.xp.progress) || 0)) * 5);
    parts.push(`${C.gold}Lv ${s.xp.level}${C.reset} ${s.xp.title} [${'#'.repeat(full)}${'-'.repeat(5 - full)}]`);
  }
  if (s.streak >= 2) parts.push(`streak ${s.streak}d`);
  if (s.health && PLAIN_HEALTH[s.health.mood]) parts.push(`${C.amber}${healthLabel(s.health).replace(/°/g, '')} ${PLAIN_HEALTH[s.health.mood]}${C.reset}`);
  if (s.limit) parts.push(`${C.amber}limit, back in ${limitLeft(s)}${C.reset}`);
  if (s.focus?.phase) parts.push(`${C.glass}${s.focus.phase} ${focusLeft(s)}${C.reset}`);
  if (s.ci > 0) parts.push(`${C.red}CI failing${s.ci > 1 ? ` x${s.ci}` : ''}${C.reset}`);
  if (s.background > 0) parts.push(`${C.amber}${s.background} left running${C.reset}`);
  if (s.lastXp && s.now - s.lastXp.at < 15000) parts.push(`${C.gold}+${s.lastXp.amount} XP${C.reset}`);
  return parts.join(` ${C.dim}|${C.reset} `).replace(/[^\x00-\x7f]/g, '');
}

// Minutes left in a focus session or break ("18m"); the line refreshes every 30 s.
const focusLeft = s => `${Math.max(1, Math.ceil((s.focus.endsAt - s.now) / 60000))}m`;
const limitLeft = s => require('./limits').left(s.limit.resetsAt, s.now).replace(/ 0?(\d+m)$/, ' $1');

function healthLabel(h) {
  const id = String(h.id || '');
  if (id.startsWith('gpu-temp')) return `GPU ${h.text}C`;
  if (id === 'cpu-temp') return `CPU ${h.text}C`;
  if (id === 'ram') return `RAM ${h.text}`;
  return h.text; // disks already read "C: 8.4 GB"
}

// ------------------------------------------------------------------ the file

const FRESH_EVERY_MS = 60 * 1000; // the command ignores a file untouched for two minutes

let lastWritten = null;
let written = [];       // the files the last write made, which keepFresh touches
let freshTimer = null;
/** Write the emoji line, and the plain twin when given. */
function writeStatus(line, file = STATUS_FILE, plain = null) {
  const key = `${line}\n${plain}`;
  if (key === lastWritten) return;
  try {
    const files = [];
    for (const [f, text] of [[file, line], [plainFile(file), plain]]) {
      if (text == null) continue;
      const tmp = `${f}.tmp`;
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, f); // never let the status line read a half-written file
      files.push(f);
    }
    lastWritten = key;
    written = files;
    keepFresh();
  } catch { /* best effort */ }
}

// The line can sit unchanged for hours, and an unchanged line is never
// rewritten: touch it instead, so "old" only ever means Shellby isn't running.
function keepFresh() {
  if (freshTimer) return;
  freshTimer = setInterval(touchStatus, FRESH_EVERY_MS);
  freshTimer.unref?.(); // never what keeps Shellby (or a test) running
}

/** Mark the status files as current. */
function touchStatus(now = new Date()) {
  for (const f of written) { try { fs.utimesSync(f, now, now); } catch { /* gone: the next write puts it back */ } }
}

function clearStatus(file = STATUS_FILE) {
  lastWritten = null;
  written = [];
  clearInterval(freshTimer);
  freshTimer = null;
  for (const f of [file, plainFile(file)]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
}

// ------------------------------------------------------------------ Claude Code settings

const settingsPath = (home = os.homedir()) => path.join(home, '.claude', 'settings.json');

/** { state: 'none' | 'ours' | 'other' | 'unreadable', command?, outdated? } (outdated: ours, but an older command) */
function inspectSettings(file = settingsPath()) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { state: 'none' } : { state: 'unreadable' }; }
  let s;
  try { s = JSON.parse(raw.replace(/^﻿/, '') || '{}'); } catch { return { state: 'unreadable' }; }
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { state: 'unreadable' };
  const cmd = s.statusLine && typeof s.statusLine === 'object' ? String(s.statusLine.command || '') : '';
  if (!cmd) return { state: 'none' };
  return cmd.includes(MARK) ? { state: 'ours', command: cmd, outdated: cmd !== COMMAND } : { state: 'other', command: cmd };
}

/**
 * Point Claude Code's statusLine at Shellby. Keeps a one-time backup of the
 * whole settings file and returns the statusLine it replaced (to restore later).
 */
function installStatusLine(file = settingsPath()) {
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{}';
  const s = JSON.parse(raw.replace(/^﻿/, '') || '{}');
  const previous = s.statusLine && !String(s.statusLine.command || '').includes(MARK) ? s.statusLine : null;
  if (raw.trim() && !fs.existsSync(`${file}.shellby-backup`)) fs.writeFileSync(`${file}.shellby-backup`, raw);
  s.statusLine = { type: 'command', command: COMMAND, padding: 0 };
  writeJson(file, s);
  return { previous };
}

const PLUGIN_ID = 'shellby@shellby';
// The plugin this Shellby was made with (claude-plugin/.claude-plugin/plugin.json;
// test/statusline.test.js keeps them equal). Claude Code doesn't update plugins
// from other marketplaces by itself, so an install can sit on a version from
// before the features this app relies on, its MCP server among them.
const PLUGIN_VERSION = '1.6.2';
const PLUGIN_SOURCE = 'x-salmon/shellby';

const versionParts = v => (typeof v === 'string' && /^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(v) ? v.split('.').map(Number) : null);
/**
 * What Settings shows for the plugin: state from inspectPlugin, and outdated
 * when the shop lists a user install older than PLUGIN_VERSION, from the
 * x-salmon/shellby marketplace. A project install, or one the shop hasn't
 * listed, is never called outdated.
 */
function pluginStatus(state, listed, marketplace) {
  // Only ours: updating a plugin from someone else's "shellby" marketplace would run their code.
  const isOurs = String(marketplace?.repo || '').toLowerCase() === PLUGIN_SOURCE;
  const outdated = state === 'on' && isOurs && listed?.installed && listed.scope === 'user' && isOlderVersion(listed.version, PLUGIN_VERSION);
  return outdated ? { state, outdated: { from: listed.version, to: PLUGIN_VERSION } } : { state };
}

/** Is version a older than b? Anything that isn't major.minor.patch is never called older. */
function isOlderVersion(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  if (!x || !y) return false;
  const i = x.findIndex((n, k) => n !== y[k]);
  return i !== -1 && x[i] < y[i];
}

/** Is the Shellby plugin on in Claude Code here? 'on' | 'off' (installed, disabled) | 'none' | 'unreadable' */
function inspectPlugin(file = settingsPath()) {
  let s;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '') || '{}'); } catch (e) { return e.code === 'ENOENT' ? 'none' : 'unreadable'; }
  const v = s && typeof s.enabledPlugins === 'object' ? s.enabledPlugins?.[PLUGIN_ID] : undefined;
  return v === true ? 'on' : v === false ? 'off' : 'none';
}

/** Bring Shellby's own (older) statusLine entry up to date; anything else is left alone. */
function upgradeStatusLine(file = settingsPath()) {
  const now = inspectSettings(file);
  if (now.state !== 'ours' || !now.outdated) return false;
  const s = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '') || '{}');
  s.statusLine = { ...s.statusLine, type: 'command', command: COMMAND };
  writeJson(file, s);
  return true;
}

/** Take Shellby out again, putting back whatever statusLine was there before. */
function removeStatusLine(previous, file = settingsPath()) {
  if (!fs.existsSync(file)) return;
  const s = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '') || '{}');
  if (!s.statusLine || !String(s.statusLine.command || '').includes(MARK)) return; // someone changed it since: leave it alone
  if (previous && typeof previous === 'object') s.statusLine = previous; else delete s.statusLine;
  writeJson(file, s);
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.shellby-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

module.exports = { writeJson, PLUGIN_ID, PLUGIN_VERSION, PLUGIN_SOURCE, isOlderVersion, pluginStatus, inspectPlugin, formatStatus, formatPlain, upgradeStatusLine, plainFile, writeStatus, touchStatus, clearStatus, inspectSettings, installStatusLine, removeStatusLine, settingsPath, STATUS_FILE, COMMAND };
