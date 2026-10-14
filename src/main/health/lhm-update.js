// Keeping LibreHardwareMonitor up to date. Shellby (or a Claude task it
// started) installs LHM for the CPU temperature, but LHM has no updater of its
// own, so a copy installed once stays on that version for good.
//
// When the Health view opens with LHM installed, Shellby reads the version of
// its exe and, at most once a day, asks GitHub for LHM's latest release (one
// small GET with nothing about you in it). The Sensors fold says when a newer
// one is out; updating it is a Claude task you read before sending, because it
// stops an elevated program and runs winget. The parsers are pure
// (test/lhm-update.test.js); fetching and the PowerShell read are passed in.
const path = require('path');
const { execFile } = require('child_process');
const { newer } = require('../claude/update');

const LATEST_URL = 'https://api.github.com/repos/LibreHardwareMonitor/LibreHardwareMonitor/releases/latest';
const RELEASES_URL = 'https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases/latest';
const WINGET_ID = 'LibreHardwareMonitor.LibreHardwareMonitor';

const HOUR = 60 * 60 * 1000;
const EVERY = 24 * HOUR;           // how often GitHub is asked without a button press
const RETRY_MS = 6 * HOUR;         // after a check that got nothing back
const FETCH_TIMEOUT_MS = 15000;
const READ_TIMEOUT_MS = 10000;
const MAX_BYTES = 512 * 1024;      // a release is a few KB of JSON
const EXE_MAX = 260;

const VERSION_RE = /^v?(\d{1,9}\.\d{1,9}\.\d{1,9})(?:\.\d{1,9})?$/;
const version = v => (typeof v === 'string' && /^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(v) ? v : null);
const time = t => (Number.isFinite(t) && t > 0 ? t : null);

/** "v0.9.6", "0.9.6" or a FileVersion "0.9.6.0" -> "0.9.6"; anything else -> null. */
function plainVersion(s) {
  const m = VERSION_RE.exec(String(s ?? '').trim());
  return m ? m[1] : null;
}

/** GitHub's releases/latest answer -> its version, or null for a pre-release, a draft or anything else. */
function parseRelease(text) {
  let data;
  try { data = JSON.parse(String(text || '').trim() || 'null'); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.draft || data.prerelease) return null;
  return plainVersion(data.tag_name);
}

// The path goes into a Claude prompt, and a scheduled task or a process name
// can point anywhere: a plain drive path to LibreHardwareMonitor.exe, with no
// quotes, backticks, $, %, ;, &, | or line breaks.
const EXE_RE = /^[A-Za-z]:\\(?:[\p{L}\p{N} ._()\-+,'@#~[\]{}]+\\)*LibreHardwareMonitor\.exe$/iu;
const WINGET_RE = /\\Microsoft\\WinGet\\Packages\\LibreHardwareMonitor\.LibreHardwareMonitor_[^\\]+\\LibreHardwareMonitor\.exe$/i;

/** The reader's JSON ({ exe, version }) -> { exe, version, winget } or null when LHM wasn't found. */
function parseInstalled(text) {
  let data;
  try { data = JSON.parse(String(text || '').trim() || 'null'); } catch { return null; }
  const exe = typeof data?.exe === 'string' && data.exe.length <= EXE_MAX && EXE_RE.test(data.exe) ? data.exe : null;
  if (!exe) return null;
  return { exe, version: plainVersion(data.version), winget: WINGET_RE.test(exe) };
}

/** Tolerate anything read from disk. */
function normalizeState(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return { latest: version(s.latest), lastCheckAt: time(s.lastCheckAt), lastAttemptAt: time(s.lastAttemptAt) };
}

/**
 * The Claude task that updates it: filled into a new tab's box, not sent, so
 * you see the winget run and the elevated restart before agreeing to them.
 */
function updatePrompt({ installed, latest, port }) {
  const how = installed?.winget
    ? `It was installed with winget, so update it with \`winget upgrade --id ${WINGET_ID} -e --accept-source-agreements --accept-package-agreements\`.`
    : `Update it the way it was installed. If winget doesn't list it (\`winget list --id ${WINGET_ID} -e\`), download LibreHardwareMonitor.zip from ${RELEASES_URL} and unpack it over the old files.`;
  return [
    `Update LibreHardwareMonitor${installed?.version ? ` from ${installed.version}` : ''}${latest ? ` to ${latest}` : ''}. Shellby reads my CPU temperature from it.`,
    installed?.exe ? `It's at \`${installed.exe}\`.` :'Find where LibreHardwareMonitor.exe is first.',
    '1. Copy LibreHardwareMonitor.config (next to the exe) somewhere safe, if it\'s there: it holds the web server settings.',
    '2. Close LHM. It runs as administrator, so stopping it may need the Windows prompt; I\'ll accept it.',
    `3. ${how}`,
    '4. Put the config back if the update removed or reset it.',
    '5. Start it again as administrator (`Start-Process -Verb RunAs`), the way it started before.',
    `6. Check that http://127.0.0.1:${port}/data.json answers, and tell me the version it's on now.`,
    "Don't change its startup task or any other setting.",
  ].join('\n') + '\n';
}

// Where LHM can be, cheapest first: the running process, winget's package
// folder, a scheduled task that starts it (LHM's own "Run on Windows startup"
// makes one), then Program Files. A process running as administrator hides its
// path from Shellby, hence the rest.
const READ_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue"',
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  '$found = $null',
  'function Try-Exe($p) { if ($p) { $p = [Environment]::ExpandEnvironmentVariables($p.Trim(\'"\')); if (Test-Path -LiteralPath $p -PathType Leaf) { return $p } }; $null }',
  'foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name=\'LibreHardwareMonitor.exe\'" | ForEach-Object ExecutablePath)) { if (-not $found) { $found = Try-Exe $p } }',
  'if (-not $found) { $found = @(Get-ChildItem "$env:LOCALAPPDATA\\Microsoft\\WinGet\\Packages\\LibreHardwareMonitor.LibreHardwareMonitor_*\\LibreHardwareMonitor.exe" | ForEach-Object FullName)[0] }',
  'if (-not $found) { foreach ($p in @(Get-ScheduledTask | ForEach-Object { $_.Actions.Execute } | Where-Object { $_ -match \'LibreHardwareMonitor\\.exe"?$\' })) { if (-not $found) { $found = Try-Exe $p } } }',
  'if (-not $found) { $found = Try-Exe "$env:ProgramFiles\\LibreHardwareMonitor\\LibreHardwareMonitor.exe" }',
  'if ($found) { @{ exe = $found; version = (Get-Item -LiteralPath $found).VersionInfo.FileVersion } | ConvertTo-Json -Compress } else { "null" }',
].join('\n');

/** The installed copy: { exe, version, winget } or null. Never throws. */
function readInstalled({ platform = process.platform } = {}) {
  if (platform !== 'win32') return Promise.resolve(null);
  // Absolute path: never pick up a powershell.exe from PATH or the working dir.
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise(resolve => {
    execFile(ps, ['-NoProfile', '-NonInteractive', '-Command', READ_SCRIPT], { timeout: READ_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 },
      (err, stdout) => resolve(err ? null : parseInstalled(stdout)));
  });
}

/** LHM's newest release on GitHub. Throws on anything but a clean answer. */
async function fetchLatest({ fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS, url = LATEST_URL } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('No fetch available');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetchImpl(url, { signal: ctrl.signal, cache: 'no-store', headers: { accept: 'application/vnd.github+json' } });
    } catch {
      throw new Error(ctrl.signal.aborted ? 'GitHub took too long to answer.' : "Couldn't reach GitHub.");
    }
    if (!res.ok) throw new Error(`GitHub answered with HTTP ${res.status}.`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error("GitHub's answer was too big to be a release.");
    const latest = parseRelease(text);
    if (!latest) throw new Error("GitHub's answer wasn't a LibreHardwareMonitor release.");
    return latest;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * check({ force }) -> { installed: { exe, version, winget } | null, latest, available, lastCheckAt, error }.
 * Reads the installed copy each time; asks GitHub daily, or now when forced.
 * Nothing installed: GitHub isn't asked at all.
 */
class LhmUpdates {
  /** deps: { config, readInstalled?, fetchLatest?, now? } */
  constructor(deps) {
    this.deps = { readInstalled, fetchLatest, now: () => Date.now(), ...deps };
    this.installed = null;
    this.error = null;
    this.pending = null;
    this.pendingForced = false;
  }

  get state() { return normalizeState(this.deps.config.get('lhmUpdate')); }

  view() {
    const s = this.state;
    const installed = this.installed;
    return {
      installed,
      latest: s.latest,
      available: !!installed?.version && newer(installed.version, s.latest),
      lastCheckAt: s.lastCheckAt,
      error: this.error,
    };
  }

  due(now) {
    const s = this.state;
    if (s.lastAttemptAt && now - s.lastAttemptAt < RETRY_MS) return false;
    return !s.lastCheckAt || now - s.lastCheckAt >= EVERY;
  }

  // One read at a time. A button press during the view's own unforced check
  // waits for it, then asks GitHub itself.
  check({ force = false } = {}) {
    if (this.pending && (this.pendingForced || !force)) return this.pending;
    const after = this.pending ? this.pending.catch(() => {}) : Promise.resolve();
    const run = after.then(() => this.run(force));
    this.pending = run;
    this.pendingForced = force;
    run.finally(() => { if (this.pending === run) this.pending = null; }).catch(() => {});
    return run;
  }

  async run(force) {
    this.installed = await this.deps.readInstalled().catch(() => null);
    const now = this.deps.now();
    if (!this.installed || (!force && !this.due(now))) return this.view();
    const s = this.state;
    this.deps.config.set({ lhmUpdate: { ...s, lastAttemptAt: now } });
    try {
      const latest = await this.deps.fetchLatest();
      this.deps.config.set({ lhmUpdate: { latest, lastCheckAt: now, lastAttemptAt: null } });
      this.error = null;
    } catch (e) {
      this.error = String(e?.message || e).slice(0, 200);
    }
    return this.view();
  }
}

module.exports = { LhmUpdates, parseRelease, parseInstalled, plainVersion, normalizeState, updatePrompt, fetchLatest, readInstalled, EVERY, RETRY_MS, LATEST_URL, RELEASES_URL };
