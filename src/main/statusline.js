// Shellby's face in Claude Code's status line. Shellby keeps one ready-made line
// in a temp file; Claude Code's statusLine command just prints it (no network,
// no Node, ~10 ms). When Shellby quits the file goes away and the line is empty.
//
// formatStatus() is pure (test/statusline.test.js); the rest is small file I/O.
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATUS_FILE = path.join(os.tmpdir(), 'shellby-status.txt');
// The statusLine command: print the file if it's there, else nothing. Pure bash
// (Claude Code runs it through Git Bash on Windows), no other dependencies.
const COMMAND = 'bash -c \'f="${TEMP:-${TMPDIR:-/tmp}}/shellby-status.txt"; [ -f "$f" ] && cat "$f"; exit 0\'';
const MARK = 'shellby-status.txt'; // how we recognise our own statusLine

const C = { reset: '\x1b[0m', dim: '\x1b[2m', gold: '\x1b[38;5;221m', coral: '\x1b[38;5;209m', glass: '\x1b[38;5;116m', amber: '\x1b[38;5;214m', red: '\x1b[38;5;203m' };

const FACE = {
  idle: '🦀', working: '🦀💨', asking: '🦀✋', success: '🦀🎉', error: '🦀😵',
  learned: '🦀✨', unlocked: '🦀🏆', levelup: '🦀⭐', sleeping: '🦀💤',
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
 *   s: { state, busy, crew, health: { mood, text, id }|null, xp: { level, title, progress }|null,
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
  if (s.lastXp && s.now - s.lastXp.at < 15000) parts.push(`${C.gold}+${s.lastXp.amount} XP${C.reset}`);
  return parts.join(` ${C.dim}·${C.reset} `);
}

function healthLabel(h) {
  const id = String(h.id || '');
  if (id.startsWith('gpu-temp')) return `GPU ${h.text}C`;
  if (id === 'cpu-temp') return `CPU ${h.text}C`;
  if (id === 'ram') return `RAM ${h.text}`;
  return h.text; // disks already read "C: 8.4 GB"
}

// ------------------------------------------------------------------ the file

let lastWritten = null;
function writeStatus(line, file = STATUS_FILE) {
  if (line === lastWritten) return;
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, line);
    fs.renameSync(tmp, file); // never let the status line read a half-written file
    lastWritten = line;
  } catch { /* best effort */ }
}
function clearStatus(file = STATUS_FILE) {
  lastWritten = null;
  try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
}

// ------------------------------------------------------------------ Claude Code settings

const settingsPath = (home = os.homedir()) => path.join(home, '.claude', 'settings.json');

/** { state: 'none' | 'ours' | 'other' | 'unreadable', command? } */
function inspectSettings(file = settingsPath()) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { state: 'none' } : { state: 'unreadable' }; }
  let s;
  try { s = JSON.parse(raw.replace(/^﻿/, '') || '{}'); } catch { return { state: 'unreadable' }; }
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { state: 'unreadable' };
  const cmd = s.statusLine && typeof s.statusLine === 'object' ? String(s.statusLine.command || '') : '';
  if (!cmd) return { state: 'none' };
  return cmd.includes(MARK) ? { state: 'ours', command: cmd } : { state: 'other', command: cmd };
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

module.exports = { formatStatus, writeStatus, clearStatus, inspectSettings, installStatusLine, removeStatusLine, settingsPath, STATUS_FILE, COMMAND };
