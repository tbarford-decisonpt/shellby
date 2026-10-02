// What you're listening to, so Shellby can listen along: headphones on, a
// little bob in time with nothing in particular, and the odd music note.
//
// The reading comes from Windows itself -- the same media session that draws the
// volume flyout and the lock-screen controls -- so it covers Spotify, a browser
// tab, a media player, anything. No account, no API key, nothing leaves the PC,
// and nobody has to install a thing.
//
// Windows only exposes this through WinRT, which Node can't call, so one
// long-lived PowerShell does the asking and prints a line whenever the track
// changes. One process that sleeps, rather than one spawned every few seconds:
// a respawn costs ~150 ms of CPU each time, and a desktop pet has no business
// doing that all day.
const { spawn } = require('child_process');
const path = require('path');
const { EventEmitter } = require('events');

const POLL_MS = 3000;
const RESTART_MS = 30000;      // if PowerShell dies, don't respin it in a loop
const MAX_FIELD = 120;
const MAX_LINE = 8 * 1024;

// Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus
const STATUS = { 0: 'closed', 1: 'opened', 2: 'changing', 3: 'stopped', 4: 'playing', 5: 'paused' };

const clip = (s, n = MAX_FIELD) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * The PowerShell that watches the session. It prints one compact JSON line
 * whenever what's playing changes, and "null" when nothing is, then sleeps.
 *
 * It never throws out of the loop: a media app closing mid-read is normal, and
 * the answer to that is "nothing is playing", not a dead watcher.
 */
function watcherScript(pollMs = POLL_MS) {
  return `
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]

# WinRT's IAsyncOperation is not awaitable from PowerShell directly; this is the
# standard reflection bridge over to a .NET Task.
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]

function Await($op, $type) {
  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $task.Wait(4000)) { throw 'timed out' }
  $task.Result
}

$mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$mgr = Await ($mgrType::RequestAsync()) ($mgrType)
$last = ''

while ($true) {
  $line = 'null'
  try {
    $session = $mgr.GetCurrentSession()
    if ($null -ne $session) {
      $props = Await ($session.TryGetMediaPropertiesAsync()) ($propsType)
      $info = $session.GetPlaybackInfo()
      $line = [ordered]@{
        title  = $props.Title
        artist = $props.Artist
        app    = $session.SourceAppUserModelId
        status = [int]$info.PlaybackStatus
      } | ConvertTo-Json -Compress
    }
  } catch {
    $line = 'null'
  }
  if ($line -ne $last) { $last = $line; Write-Output $line }
  Start-Sleep -Milliseconds ${Math.max(500, pollMs | 0)}
}
`;
}

/**
 * One line from the watcher -> { title, artist, app, status, playing } or null.
 * Everything is clipped: a track title is whatever someone typed into an MP3 tag.
 */
function parseNowPlaying(line) {
  const text = String(line ?? '').trim();
  if (!text || text === 'null') return null;
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const title = clip(raw.title);
  const artist = clip(raw.artist);
  if (!title && !artist) return null;          // a session with no metadata is not a track
  const status = STATUS[raw.status] || 'unknown';
  return { title, artist, app: appName(raw.app), status, playing: status === 'playing' };
}

/**
 * The app's AUMID -> something readable. Windows gives "Chrome" for a browser
 * but "Spotify.exe" or a long Store id for others.
 */
function appName(raw) {
  const id = clip(raw, 80);
  if (!id) return '';
  const known = [
    [/spotify/i, 'Spotify'],
    [/chrome/i, 'Chrome'],
    [/firefox/i, 'Firefox'],
    [/msedge|edge/i, 'Edge'],
    [/zenmedia|vlc/i, 'VLC'],
    [/itunes|apple.*music/i, 'Apple Music'],
    [/foobar/i, 'foobar2000'],
    [/musicbee/i, 'MusicBee'],
    [/winamp/i, 'Winamp'],
    [/tidal/i, 'Tidal'],
    [/deezer/i, 'Deezer'],
    [/youtube/i, 'YouTube'],
  ];
  for (const [re, name] of known) if (re.test(id)) return name;
  // "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic" -> "ZuneMusic"
  const tail = id.split('!').pop().split('.').pop().replace(/\.exe$/i, '');
  return clip(tail, 24) || 'something';
}

/** Have we actually changed track (rather than just ticked)? */
const sameTrack = (a, b) => (!a && !b) || (!!a && !!b && a.title === b.title && a.artist === b.artist && a.playing === b.playing);

/**
 * What he says about it, once in a while. Short, and never the whole tag: the
 * bubble is about four words wide.
 */
function trackRemark(track, { pick = Math.random } = {}) {
  if (!track?.playing) return null;
  const name = track.artist ? `${track.title} — ${track.artist}` : track.title;
  const lines = [
    `♪ ${clip(track.title, 28)}`,
    'good one',
    '♫',
    track.artist ? `${clip(track.artist, 20)}?` : '♪',
    'bop',
  ];
  return { text: lines[Math.floor(pick() * lines.length)] || lines[0], full: clip(name, 90) };
}

/**
 * Watches the Windows media session. Emits:
 *   'track'  ({ title, artist, app, playing } | null) when it changes
 *   'status' ('off' | 'watching' | 'unavailable')
 */
class MediaWatcher extends EventEmitter {
  constructor({ platform = process.platform, env = process.env, pollMs = POLL_MS, spawnImpl = spawn } = {}) {
    super();
    Object.assign(this, { platform, env, pollMs, spawnImpl });
    this.child = null;
    this.track = null;
    this.status = 'off';
    this.restart = null;
    this.buffer = '';
  }

  get available() { return this.platform === 'win32'; }

  start() {
    if (this.child || !this.available) {
      if (!this.available) this.setStatus('unavailable');
      return;
    }
    const ps = path.join(this.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // -EncodedCommand: the script never touches the disk, so it is not subject
    // to the execution policy, and nothing has to be quoted for cmd.
    const encoded = Buffer.from(watcherScript(this.pollMs), 'utf16le').toString('base64');
    let child;
    try {
      child = this.spawnImpl(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      this.setStatus('unavailable');
      return;
    }
    this.child = child;
    this.buffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', chunk => this.onData(chunk));
    // Anything on stderr means WinRT is not answering (an old Windows, a locked
    // down box). One quiet note, then stop trying.
    child.stderr?.on('data', () => this.setStatus('unavailable'));
    child.on('error', () => { this.child = null; this.setStatus('unavailable'); });
    child.on('exit', () => {
      this.child = null;
      if (this.status === 'off') return;         // we stopped it on purpose
      this.scheduleRestart();
    });
    this.setStatus('watching');
  }

  stop() {
    clearTimeout(this.restart);
    this.restart = null;
    this.status = 'off';
    const child = this.child;
    this.child = null;
    child?.kill();
    if (this.track) { this.track = null; this.emit('track', null); }
    this.emit('status', this.status);
  }

  scheduleRestart() {
    if (this.restart || this.status === 'off') return;
    this.restart = setTimeout(() => { this.restart = null; if (this.status !== 'off') this.start(); }, RESTART_MS);
  }

  onData(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE) this.buffer = this.buffer.slice(-MAX_LINE);
    let cut;
    while ((cut = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut + 1);
      if (!line) continue;
      const track = parseNowPlaying(line);
      if (sameTrack(track, this.track)) continue;
      this.track = track;
      this.emit('track', track);
    }
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  view() {
    return { status: this.status, available: this.available, track: this.track };
  }
}

module.exports = { MediaWatcher, parseNowPlaying, appName, trackRemark, sameTrack, watcherScript, STATUS, POLL_MS };
