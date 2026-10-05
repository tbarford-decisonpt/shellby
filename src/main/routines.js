// Routines: recurring Claude Code tasks the app runs on a schedule
// ("every Friday at 17:00, tidy my Downloads"). Pure schedule maths plus a small
// ticking Scheduler; persistence and actually running the task live elsewhere.
const path = require('path');
const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const { MODES } = require('./config');
const { isModel } = require('./models');

const HOUR = 3600000;
const ID_RE = /^[\w-]{1,64}$/;
const TIME_RE = /^(\d{1,2}):(\d{2})$/;
const STATUSES = ['ok', 'error', 'stopped'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// 'HH:MM' -> { h, m }, or null if not a real 00:00-23:59 time.
function parseTime(t) {
  const m = TIME_RE.exec(typeof t === 'string' ? t.trim() : '');
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  return h <= 23 && min <= 59 ? { h, m: min } : null;
}

// Checks a schedule's shape; returns an error string or null. Used by both the
// maths (so bad data never throws) and validateRoutine.
function scheduleError(s) {
  if (!s || typeof s !== 'object') return 'Schedule is required';
  if (s.type === 'daily' || s.type === 'weekly') {
    if (!parseTime(s.time)) return 'Time must be between 00:00 and 23:59';
    if (s.type === 'weekly') {
      const d = s.days;
      if (!Array.isArray(d) || d.length < 1 || d.length > 7) return 'Pick at least one day';
      if (!d.every(x => Number.isInteger(x) && x >= 0 && x <= 6)) return 'Days must be 0 (Sun) to 6 (Sat)';
      if (new Set(d).size !== d.length) return 'Days must not repeat';
    }
    return null;
  }
  if (s.type === 'interval') {
    const n = s.everyHours;
    return Number.isInteger(n) && n >= 1 && n <= 168 ? null : 'Interval must be 1-168 whole hours';
  }
  return 'Unknown schedule type';
}

function usable(r) {
  return !!r && r.enabled === true && !scheduleError(r.schedule);
}

// Interval slots are anchored on createdAt: createdAt + k*step for integer k >= 1.
function intervalParts(r) {
  const created = Number.isFinite(r.createdAt) ? r.createdAt : null;
  return created === null ? null : { created, step: r.schedule.everyHours * HOUR };
}

// Local wall-clock slot for the day offset `i` from `base`. Building via the Date
// constructor lets it resolve DST gaps/overlaps for us.
function slotOn(base, i, t) {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, t.h, t.m).getTime();
}

function dayMatches(s, ms) {
  return s.type === 'daily' || s.days.includes(new Date(ms).getDay());
}

// Next scheduled time strictly after fromMs, or null.
function nextRun(routine, fromMs) {
  if (!usable(routine) || !Number.isFinite(fromMs)) return null;
  const s = routine.schedule;
  if (s.type === 'interval') {
    const p = intervalParts(routine);
    if (!p) return null;
    const k = Math.max(1, Math.floor((fromMs - p.created) / p.step) + 1);
    return p.created + k * p.step;
  }
  const t = parseTime(s.time);
  const base = new Date(fromMs);
  for (let i = 0; i <= 8; i++) {
    const at = slotOn(base, i, t);
    if (at > fromMs && dayMatches(s, at)) return at;
  }
  return null;
}

// Most recent scheduled time <= beforeMs, or null.
function previousRun(routine, beforeMs) {
  if (!usable(routine) || !Number.isFinite(beforeMs)) return null;
  const s = routine.schedule;
  if (s.type === 'interval') {
    const p = intervalParts(routine);
    if (!p) return null;
    const k = Math.floor((beforeMs - p.created) / p.step);
    return k >= 1 ? p.created + k * p.step : null;
  }
  const t = parseTime(s.time);
  const base = new Date(beforeMs);
  for (let i = 0; i >= -8; i--) {
    const at = slotOn(base, i, t);
    if (at <= beforeMs && dayMatches(s, at)) return at;
  }
  return null;
}

// Enabled routines with a slot in (sinceMs, nowMs].
function dueRoutines(routines, sinceMs, nowMs) {
  if (!Array.isArray(routines)) return [];
  return routines.filter(r => {
    const at = nextRun(r, sinceMs);
    return at !== null && at <= nowMs;
  });
}

// Should this routine get one catch-up run at startup? Only if a slot was missed
// since it last ran, and recently enough that running it now still makes sense.
function missedOnStartup(routine, nowMs, windowMs = 12 * HOUR) {
  if (!usable(routine) || routine.catchUp !== true) return false;
  const prev = previousRun(routine, nowMs);
  if (prev === null) return false;
  const last = Number.isFinite(routine.lastRunAt) ? routine.lastRunAt
    : Number.isFinite(routine.createdAt) ? routine.createdAt : -Infinity;
  return prev > last && nowMs - prev <= windowMs;
}

// Normalises + validates untrusted routine input from the renderer.
function validateRoutine(input, { allowAutonomous = false } = {}) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { routine: null, errors: ['Routine must be an object'] };
  }

  let id = input.id;
  if (id === undefined || id === null || id === '') id = randomUUID();
  else if (typeof id !== 'string' || !ID_RE.test(id)) errors.push('Invalid id');

  const name = typeof input.name === 'string' ? input.name.replace(/\s+/g, ' ').trim() : '';
  if (name.length < 1 || name.length > 60) errors.push('Name must be 1-60 characters');

  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (prompt.length < 1 || prompt.length > 8000) errors.push('Prompt must be 1-8000 characters');

  let cwd = null;
  if (input.cwd !== undefined && input.cwd !== null && input.cwd !== '') {
    cwd = typeof input.cwd === 'string' ? input.cwd.trim() : '';
    if (!cwd || cwd.length > 1024 || cwd.includes('\0') || !path.isAbsolute(cwd)) errors.push('Folder must be an absolute path');
  }

  const mode = input.mode === undefined || input.mode === null ? 'smart' : input.mode;
  if (!MODES.includes(mode)) errors.push('Unknown mode');
  else if (mode === 'autonomous' && !allowAutonomous) errors.push('Autonomous mode is not allowed for routines');

  // '' (or none) runs on whatever model Settings picks; anything else must be one Shellby offers.
  const model = input.model === undefined || input.model === null ? '' : input.model;
  if (typeof model !== 'string' || !isModel(model)) errors.push('Unknown model');

  const schedule = normaliseSchedule(input.schedule);
  const sErr = scheduleError(schedule);
  if (sErr) errors.push(sErr);

  const bool = (key, dflt) => {
    const v = input[key];
    if (v === undefined || v === null) return dflt;
    if (typeof v !== 'boolean') errors.push(`${key} must be true or false`);
    return v;
  };
  const enabled = bool('enabled', true);
  const catchUp = bool('catchUp', true);

  const createdAt = Number.isFinite(input.createdAt) && input.createdAt > 0 ? input.createdAt : Date.now();
  const lastRunAt = Number.isFinite(input.lastRunAt) && input.lastRunAt >= 0 ? input.lastRunAt : null;
  const lastStatus = STATUSES.includes(input.lastStatus) ? input.lastStatus : null;

  if (errors.length) return { routine: null, errors };
  return {
    routine: { id, name, prompt, cwd, mode, model, schedule, enabled, catchUp, createdAt, lastRunAt, lastStatus },
    errors: [],
  };
}

// Copies only known schedule fields; pads 'H:MM' to 'HH:MM' and sorts days.
function normaliseSchedule(s) {
  if (!s || typeof s !== 'object') return null;
  if (s.type === 'daily' || s.type === 'weekly') {
    const t = parseTime(s.time);
    const time = t ? `${String(t.h).padStart(2, '0')}:${String(t.m).padStart(2, '0')}` : s.time;
    if (s.type === 'daily') return { type: 'daily', time };
    const days = Array.isArray(s.days) ? [...s.days].sort((a, b) => a - b) : s.days;
    return { type: 'weekly', time, days };
  }
  if (s.type === 'interval') return { type: 'interval', everyHours: s.everyHours };
  return { type: s.type };
}

function formatTime(time) {
  const t = parseTime(time);
  if (!t) return String(time);
  const h12 = t.h % 12 === 0 ? 12 : t.h % 12;
  return `${h12}:${String(t.m).padStart(2, '0')} ${t.h < 12 ? 'AM' : 'PM'}`;
}

// Human-readable schedule, e.g. 'Weekdays at 6:30 PM'.
function describeSchedule(schedule) {
  if (scheduleError(schedule)) return 'Invalid schedule';
  const s = schedule;
  if (s.type === 'interval') return s.everyHours === 1 ? 'Every hour' : `Every ${s.everyHours} hours`;
  const at = formatTime(s.time);
  if (s.type === 'daily') return `Every day at ${at}`;
  const days = [...s.days].sort((a, b) => a - b);
  const key = days.join(',');
  if (key === '0,1,2,3,4,5,6') return `Every day at ${at}`;
  if (key === '1,2,3,4,5') return `Weekdays at ${at}`;
  if (key === '0,6') return `Weekends at ${at}`;
  return `${days.map(d => DAY_NAMES[d]).join(', ')} at ${at}`;
}

// Polls routines and emits 'due' (routine) once per routine per slot.
class Scheduler extends EventEmitter {
  constructor({ getRoutines, tickMs = 30000, now = () => Date.now() } = {}) {
    super();
    if (typeof getRoutines !== 'function') throw new Error('getRoutines is required');
    this.getRoutines = getRoutines;
    this.tickMs = tickMs;
    this.now = now;
    this.lastTick = null;   // null -> next tick only sets the baseline
    this.fired = new Map(); // routine id -> last slot emitted
    this.timer = null;
    this.immediate = null;
  }

  start() {
    if (this.timer) return;
    this.lastTick = null; // past slots are the caller's job (missedOnStartup)
    this.immediate = setImmediate(() => { this.immediate = null; this.tick(); });
    this.immediate.unref?.();
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.immediate) clearImmediate(this.immediate);
    if (this.timer) clearInterval(this.timer);
    this.immediate = null;
    this.timer = null;
  }

  tick() {
    const now = this.now();
    const since = this.lastTick;
    this.lastTick = now;
    if (since === null || !Number.isFinite(now)) return;

    let routines;
    try { routines = this.getRoutines(); } catch { return; }
    if (!Array.isArray(routines)) return;

    for (const r of routines) {
      // Only the latest slot in (since, now] is considered, so a long sleep or
      // hibernate yields one 'due' per routine rather than a burst of them.
      const slot = previousRun(r, now);
      if (slot === null || slot <= since) continue;
      const last = this.fired.get(r.id);
      if (last !== undefined && slot <= last) continue; // already fired (clock went back)
      this.fired.set(r.id, slot);
      try { this.emit('due', r); } catch { /* a bad listener must not stop the others */ }
    }
  }
}

module.exports = { nextRun, previousRun, dueRoutines, missedOnStartup, validateRoutine, describeSchedule, scheduleError, normaliseSchedule, Scheduler };
