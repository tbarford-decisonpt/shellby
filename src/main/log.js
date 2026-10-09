// A small log, so a crash leaves something behind.
//
// Shellby runs all day with no console attached: before this, a throw in main
// made the crab vanish with nothing written down, and an unhandled rejection
// did nothing visible at all. Everything here is best-effort and must never
// throw — the crash handler depends on it.
//
// What's written is meant to be readable by the person pasting it into an issue,
// so it's scrubbed first: the home directory becomes ~, and anything shaped like
// a GitHub token or a bearer header is replaced. No Electron imports; main.js
// passes the folder in, which is also how test/log.test.js drives it.
const fs = require('fs');
const path = require('path');

const LINES_KEPT = 300;             // in memory, for "Report a problem"
const MAX_BYTES = 512 * 1024;       // the file is rotated once past this
const MAX_DETAIL = 2000;            // one entry can't run away with the file

// GitHub's token prefixes, plus Authorization headers. Deliberately narrow:
// scrubbing anything that merely looks random would eat the text that makes a
// report useful.
const SECRETS = [
  [/\b(gh[pousr]_[A-Za-z0-9]{6})[A-Za-z0-9]+/g, '$1…'],
  [/\b(github_pat_[A-Za-z0-9]{6})[A-Za-z0-9_]+/g, '$1…'],
  [/\b(glpat-[A-Za-z0-9]{4})[A-Za-z0-9_-]+/g, '$1…'],
  [/(https:\/\/(?:discord(?:app)?\.com\/api\/webhooks|hooks\.slack\.com\/services))\/\S+/gi, '$1/…'],
  [/\b(Bearer|token)\s+\S+/gi, '$1 …'],
];

class Log {
  constructor(dir, { home = null, max = LINES_KEPT, maxBytes = MAX_BYTES, now = () => new Date() } = {}) {
    this.dir = dir;
    this.file = dir ? path.join(dir, 'shellby.log') : null;
    this.home = home;
    this.max = max;
    this.maxBytes = maxBytes;
    this.now = now;
    this.lines = [];
    try { if (dir) fs.mkdirSync(dir, { recursive: true }); } catch { this.file = null; }
  }

  /** Strip the things a public issue shouldn't carry. */
  scrub(text) {
    let s = String(text ?? '');
    if (this.home) {
      // Either separator matches either, case-insensitively: Windows paths
      // arrive both ways, sometimes in the same stack trace.
      const esc = this.home
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // regex specials (a backslash becomes \\)
        .replace(/\\\\|\//g, '[\\\\/]');
      try { s = s.replace(new RegExp(esc, 'gi'), '~'); } catch { /* odd home; leave it */ }
    }
    for (const [re, to] of SECRETS) s = s.replace(re, to);
    return s;
  }

  write(level, what, detail) {
    const stamp = this.now().toISOString().replace('T', ' ').slice(0, 19);
    const extra = detail === undefined ? '' : ` — ${detail instanceof Error ? `${detail.message}\n${detail.stack || ''}` : typeof detail === 'string' ? detail : safeJson(detail)}`;
    const line = this.scrub(`${stamp} ${level.padEnd(5)} ${what}${extra}`).slice(0, MAX_DETAIL);
    this.lines.push(line);
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
    this.append(line);
    return line;
  }

  info(what, detail) { return this.write('info', what, detail); }
  warn(what, detail) { return this.write('warn', what, detail); }
  error(what, detail) { return this.write('ERROR', what, detail); }

  append(line) {
    if (!this.file) return;
    try {
      // One previous file is kept, so a crash loop can't bury the first failure.
      const size = statSize(this.file);
      if (size > this.maxBytes) {
        try { fs.rmSync(`${this.file}.1`, { force: true }); } catch { /* fine */ }
        fs.renameSync(this.file, `${this.file}.1`);
      }
      fs.appendFileSync(this.file, `${line}\n`);
    } catch {
      // A log that can't be written is not worth an error of its own.
      this.file = null;
    }
  }

  /** The newest `n` lines, oldest first — what goes in a problem report. */
  recent(n = 60) { return this.lines.slice(-n); }
}

function statSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

module.exports = { Log, LINES_KEPT };
