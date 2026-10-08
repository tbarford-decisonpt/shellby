// Push-to-talk: hold the Shellby hotkey and say the task. A tap still opens the
// panel; a hold opens the microphone, and what you said lands in the box when
// you let go (not sent: you read it first, the same as anything typed).
//
// The listening is done by Windows itself, with the desktop speech recognizer
// that ships with it (System.Speech, the engine behind Windows Speech
// Recognition). It runs on this PC: no account, no API key, no service, and
// the audio never leaves the machine.
//
// Node can't reach it, so one PowerShell holds the engine, warm, and takes
// "start"/"stop" lines on stdin. Kept warm because starting it costs ~0.5 s,
// which is the first few words of whatever you say. A small C# class does the
// listening: PowerShell's own event handlers only run while its main thread is
// idle, and that thread is blocked reading stdin.
//
// Two pieces here are pure and tested on their own: which key to watch for the
// release (holdKeyOf), and the tap-or-hold decision (PushToTalk), which gets its
// clock and its key reader handed in.
const { spawn } = require('child_process');
const path = require('path');
const { EventEmitter } = require('events');

const HOLD_MS = 300;            // held this long, it's dictation rather than a tap
const POLL_MS = 30;             // how often the held key is checked
const MAX_HOLD_MS = 2 * 60 * 1000; // a key that never comes up (a lost key-up) stops here
const FINISH_MS = 8000;         // after letting go, how long to wait for the last words
const READY_MS = 15000;         // first start: Add-Type compiles the helper
const MAX_LINE = 64 * 1024;
const MAX_TEXT = 4000;

// The keys the hotkey recorder accepts (settings.js): a letter, a digit, an
// F-key or Space. Windows virtual-key codes, for GetAsyncKeyState.
const VK_SPACE = 0x20, VK_0 = 0x30, VK_A = 0x41, VK_F1 = 0x70;

/**
 * The key to watch for the release: the non-modifier part of an Electron
 * accelerator ("Control+Alt+Space" -> 0x20), or null when it isn't one we can
 * read (then the hotkey only toggles, as it always did).
 */
function holdKeyOf(accel) {
  if (typeof accel !== 'string' || !accel) return null;
  const key = accel.split('+').pop().trim();
  if (/^space$/i.test(key)) return VK_SPACE;
  if (/^[a-z]$/i.test(key)) return VK_A + key.toUpperCase().charCodeAt(0) - 65;
  if (/^\d$/.test(key)) return VK_0 + Number(key);
  const f = /^f(\d{1,2})$/i.exec(key);
  if (f && Number(f[1]) >= 1 && Number(f[1]) <= 24) return VK_F1 + Number(f[1]) - 1;
  return null;
}

/** Recognised phrases -> one tidy line of text. */
function joinHeard(parts) {
  return (Array.isArray(parts) ? parts : [])
    .map(p => String(p ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, MAX_TEXT);
}

/** One line from the helper -> { type, id, text } or null. */
function parseLine(line) {
  let raw;
  try { raw = JSON.parse(String(line ?? '').trim()); } catch { return null; }
  if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') return null;
  return {
    type: raw.type,
    id: typeof raw.id === 'string' ? raw.id : null,
    text: typeof raw.text === 'string' ? raw.text.slice(0, MAX_TEXT) : null,
  };
}

/** What the helper's failures mean to a person. */
function friendlyError(code) {
  const c = String(code ?? '');
  if (c === 'no-recognizer') return 'Windows has no speech recognizer installed. Add a speech language in Windows Settings › Time & Language › Speech.';
  if (/audio input|audio device|microphone/i.test(c)) return 'No microphone found, or Windows is keeping desktop apps off it (Windows Settings › Privacy › Microphone).';
  if (c === 'unavailable') return 'Windows speech recognition isn\'t available on this PC.';
  return 'Windows speech recognition stopped working. Try again in a moment.';
}

/**
 * The PowerShell that holds the recognizer. Reads "start <id>", "stop",
 * "cancel" and "quit" lines; writes one JSON line per event:
 *   {"type":"ready","text":"en-US"}        the engine is loaded
 *   {"type":"heard","id":…,"text":…}       a phrase, as soon as it's recognised
 *   {"type":"done","id":…}                 that session is over
 *   {"type":"error","id":…,"text":…}       something went wrong (then "done")
 * `wav` reads a recording instead of the microphone: the tests use it.
 */
function helperScript({ wav = null } = {}) {
  const input = wav
    ? `engine.SetInputToWaveFile(@"${String(wav).replace(/"/g, '""')}");`
    : 'engine.SetInputToDefaultAudioDevice();';
  return `
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Speech
$speech = [System.Speech.Recognition.SpeechRecognitionEngine].Assembly.Location
Add-Type -ReferencedAssemblies $speech -TypeDefinition @'
using System;
using System.Globalization;
using System.Speech.Recognition;
using System.Text;

public static class ShellbyEar {
  static SpeechRecognitionEngine engine;
  static readonly object gate = new object();
  static volatile string session;
  static volatile bool busy;
  static volatile string pending; // a start that came while the last one was still winding down

  static string Esc(string s) {
    var b = new StringBuilder();
    foreach (char c in s) {
      if (c == '"' || c == '\\\\') b.Append('\\\\').Append(c);
      else if (c < ' ') b.AppendFormat("\\\\u{0:x4}", (int)c);
      else b.Append(c);
    }
    return b.ToString();
  }

  public static void Emit(string type, string id, string text) {
    var b = new StringBuilder("{\\"type\\":\\"").Append(type).Append('"');
    if (id != null) b.Append(",\\"id\\":\\"").Append(Esc(id)).Append('"');
    if (text != null) b.Append(",\\"text\\":\\"").Append(Esc(text)).Append('"');
    b.Append('}');
    lock (gate) { Console.Out.WriteLine(b.ToString()); Console.Out.Flush(); }
  }

  // The recognizer for the language Windows is shown in, else the first one.
  public static string Init() {
    RecognizerInfo pick = null;
    var ui = CultureInfo.CurrentUICulture;
    foreach (var r in SpeechRecognitionEngine.InstalledRecognizers()) {
      if (r.Culture.Equals(ui)) { pick = r; break; }
      if (pick == null) pick = r;
    }
    if (pick == null) return null;
    engine = new SpeechRecognitionEngine(pick);
    engine.LoadGrammar(new DictationGrammar());
    engine.SpeechRecognized += (s, e) => {
      var id = session;
      if (id != null && e.Result != null && e.Result.Text.Length > 0) Emit("heard", id, e.Result.Text);
    };
    engine.RecognizeCompleted += (s, e) => {
      var id = session;
      var next = pending;
      session = null;
      pending = null;
      busy = false;
      if (e.Error != null) Emit("error", id, e.Error.Message);
      if (id != null) Emit("done", id, null);
      if (next != null) Start(next);
    };
    return pick.Culture.Name;
  }

  // Can it reach a microphone? Checked once at load, so the switch can say so.
  public static string Probe() {
    try { ${input} return null; } catch (Exception ex) { return ex.Message; }
  }

  public static void Start(string id) {
    // Node only starts a new one once it's done with the last, so whatever is
    // still running is unwanted: drop it, and start this as soon as it's gone.
    if (busy) { pending = id; session = null; engine.RecognizeAsyncCancel(); return; }
    try {
      ${input}
      session = id;
      busy = true;
      engine.RecognizeAsync(RecognizeMode.Multiple);
    } catch (Exception ex) {
      session = null;
      busy = false;
      Emit("error", id, ex.Message);
      Emit("done", id, null);
    }
  }

  // Finishes the phrase being spoken, then "done".
  public static void Stop() { if (busy) engine.RecognizeAsyncStop(); }
  // Drops it: nothing more is reported for that session.
  public static void Cancel() { if (busy) { session = null; engine.RecognizeAsyncCancel(); } }
}
'@
$culture = [ShellbyEar]::Init()
if (-not $culture) { [ShellbyEar]::Emit('error', $null, 'no-recognizer'); exit 2 }
$problem = [ShellbyEar]::Probe()
if ($problem) { [ShellbyEar]::Emit('error', $null, $problem); exit 3 }
[ShellbyEar]::Emit('ready', $null, $culture)
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $parts = $line.Trim() -split ' ', 2
  switch ($parts[0]) {
    'start'  { if ($parts.Count -eq 2) { [ShellbyEar]::Start($parts[1]) } }
    'stop'   { [ShellbyEar]::Stop() }
    'cancel' { [ShellbyEar]::Cancel() }
    'quit'   { exit 0 }
  }
}
`;
}

/**
 * The recognizer process. One session at a time:
 *   begin()  -> true if it's listening (the mic is open)
 *   finish() -> stops; 'result' ({ text, error }) follows once the last words are in
 *   cancel() -> drops it; no 'result'
 * Also emits 'error' (a friendly message) and 'status'
 * ('off' | 'starting' | 'ready' | 'unavailable').
 */
class Dictation extends EventEmitter {
  constructor({ platform = process.platform, env = process.env, spawnImpl = spawn, wav = null,
    finishMs = FINISH_MS, readyMs = READY_MS } = {}) {
    super();
    Object.assign(this, { platform, env, spawnImpl, wav, finishMs, readyMs });
    this.child = null;
    this.status = 'off';
    this.culture = null;
    this.lastError = null;
    this.buffer = '';
    this.session = null;   // { id, heard: [], stopping, timer }
    this.seq = 0;
    this.waiters = [];
  }

  get available() { return this.platform === 'win32'; }
  get listening() { return !!this.session && !this.session.stopping; }
  /** A session is open: listening, or waiting for its last words. */
  get busy() { return !!this.session; }

  /**
   * Start the engine if it isn't running, and resolve once it's loaded:
   * { ok: true, culture } or { ok: false, error }.
   */
  warm() {
    if (this.status === 'unavailable' && !this.child && this.available) this.setStatus('off'); // a fresh try
    if (this.status === 'ready') return Promise.resolve({ ok: true, culture: this.culture });
    if (this.status === 'unavailable') return Promise.resolve({ ok: false, error: friendlyError('unavailable') });
    const p = new Promise(resolve => {
      const timer = setTimeout(() => this.fail('unavailable'), this.readyMs);
      this.waiters.push(r => { clearTimeout(timer); resolve(r); });
    });
    this.spawnChild();
    return p;
  }

  settle(result) {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w(result);
  }

  spawnChild() {
    if (this.child) return;
    if (!this.available) return this.fail('unavailable');
    const ps = path.join(this.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // -EncodedCommand: never on disk, so no execution policy and no quoting (as in media.js).
    const encoded = Buffer.from(helperScript({ wav: this.wav }), 'utf16le').toString('base64');
    let child;
    try {
      child = this.spawnImpl(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      return this.fail('unavailable');
    }
    this.child = child;
    this.buffer = '';
    this.setStatus('starting');
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', chunk => this.onData(chunk));
    let stderr = '';
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.stdin?.on?.('error', () => { /* it exited; 'exit' tidies up */ });
    child.on('error', () => { if (this.child === child) { this.child = null; this.fail('unavailable'); } });
    child.on('exit', () => {
      if (this.child !== child) return;
      this.child = null;
      if (stderr.trim()) this.emit('log', stderr.trim().split('\n').slice(-3).join(' '));
      this.endSession();
      if (this.status === 'unavailable') return;
      // It died after loading (or was stopped): it starts again on the next press.
      if (this.status === 'starting') this.fail('unavailable');
      else this.setStatus('off');
    });
  }

  fail(code) {
    this.lastError = friendlyError(code);
    if (this.session) this.session.error = this.lastError;
    this.endSession();
    const child = this.child;
    this.child = null;
    child?.kill();
    this.setStatus('unavailable');
    this.settle({ ok: false, error: this.lastError });
    this.emit('error', this.lastError);
  }

  write(line) {
    try { this.child?.stdin?.write(`${line}\n`); return !!this.child; } catch { return false; }
  }

  begin() {
    if (this.session || !this.available) return false;
    // Failed before? Try again: a microphone may have been plugged in since.
    if (this.status === 'unavailable' && !this.child) this.setStatus('off');
    this.spawnChild();
    if (!this.child) return false;
    const id = `d${++this.seq}`;
    this.session = { id, heard: [], stopping: false, timer: null, error: null };
    // Written straight away even while the engine is still loading: stdin
    // holds it until the helper gets there.
    return this.write(`start ${id}`) || (this.session = null, false);
  }

  finish() {
    const s = this.session;
    if (!s || s.stopping) return false;
    s.stopping = true;
    this.write('stop');
    // The last words come with "done"; don't wait for ever if it never does.
    s.timer = setTimeout(() => { if (this.session === s) { this.write('cancel'); this.endSession(); } }, this.finishMs);
    return true;
  }

  cancel() {
    const s = this.session;
    if (!s) return false;
    clearTimeout(s.timer);
    this.session = null;
    this.write('cancel');
    return true;
  }

  /** The session is over: report what was heard (unless it was cancelled). */
  endSession() {
    const s = this.session;
    if (!s) return;
    clearTimeout(s.timer);
    this.session = null;
    this.emit('result', { text: joinHeard(s.heard), error: s.error });
  }

  onData(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE) this.buffer = this.buffer.slice(-MAX_LINE);
    let cut;
    while ((cut = this.buffer.indexOf('\n')) !== -1) {
      const msg = parseLine(this.buffer.slice(0, cut));
      this.buffer = this.buffer.slice(cut + 1);
      if (msg) this.onMessage(msg);
    }
  }

  onMessage({ type, id, text }) {
    const mine = !!this.session && id === this.session.id;
    if (type === 'ready') {
      this.culture = text;
      this.setStatus('ready');
      this.settle({ ok: true, culture: text });
    } else if (type === 'heard' && mine && text) {
      this.session.heard.push(text);
    } else if (type === 'done' && mine) {
      this.endSession();
    } else if (type === 'error') {
      if (id == null) return this.fail(text);   // the engine itself couldn't start
      if (mine) { this.lastError = this.session.error = friendlyError(text); this.emit('error', this.lastError); }
    }
  }

  stop() {
    this.cancel();
    const child = this.child;
    if (child) {
      this.write('quit');
      this.child = null; // first, so its 'exit' reads as stopped rather than crashed
      child.kill();
    }
    this.settle({ ok: false, error: friendlyError('unavailable') });
    // Turned off on purpose: a later warm() gets a fresh try.
    this.lastError = null;
    this.setStatus('off');
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }
}

/**
 * Tap or hold. The hotkey only reports going down, so after a press the key is
 * watched (isDown) until it comes back up:
 *   up within holdMs     -> onTap()       (open/close the panel, as before)
 *   still down at holdMs -> onHold(), then onRelease() when it comes up
 * onPress() runs at once on every press, so listening can start before it's
 * known to be a hold and the first word isn't lost; a tap cancels it.
 * Presses while one is being watched are ignored: a held key repeats.
 */
class PushToTalk {
  constructor({ isDown, onPress = () => {}, onTap = () => {}, onHold = () => {}, onRelease = () => {},
    holdMs = HOLD_MS, pollMs = POLL_MS, maxMs = MAX_HOLD_MS,
    now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    Object.assign(this, { isDown, onPress, onTap, onHold, onRelease, holdMs, pollMs, maxMs, now, setTimer, clearTimer });
    this.pressedAt = null;
    this.held = false;
    this.timer = null;
  }

  get active() { return this.pressedAt != null; }

  press() {
    if (this.active) return false;
    this.pressedAt = this.now();
    this.held = false;
    this.onPress();
    this.tick();
    return true;
  }

  tick() {
    this.timer = null;
    if (!this.active) return;
    const elapsed = this.now() - this.pressedAt;
    let down;
    try { down = !!this.isDown(); } catch { down = false; }
    if (!down || elapsed >= this.maxMs) return this.release();
    if (!this.held && elapsed >= this.holdMs) { this.held = true; this.onHold(); }
    this.timer = this.setTimer(() => this.tick(), this.pollMs);
  }

  release() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    const held = this.held;
    this.pressedAt = null;
    this.held = false;
    if (held) this.onRelease(); else this.onTap();
  }

  /** Drop a press in progress without calling anything (the setting went off). */
  reset() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.pressedAt = null;
    this.held = false;
  }
}

module.exports = {
  Dictation, PushToTalk, holdKeyOf, joinHeard, parseLine, friendlyError, helperScript,
  HOLD_MS, POLL_MS, MAX_HOLD_MS,
};
