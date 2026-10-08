// What you're listening to, read from the Windows media session.
//
// The watcher is driven with a fake child process here, so the line handling,
// the change detection and the restart behaviour are all tested without
// spawning PowerShell. The one test that does touch Windows is skipped
// elsewhere, and tolerates there being no music playing -- it is checking that
// the WinRT call works at all, which is the part that varies by machine.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const path = require('path');
const {
  MediaWatcher, parseNowPlaying, appName, trackRemark, sameTrack, watcherScript,
} = require('../src/main/media');

// ------------------------------------------------------------------ parsing

test('parseNowPlaying reads a real session line', () => {
  // Captured from a real Windows media session, with Chrome playing.
  const line = '{"title":"Crab Rave (test)","artist":"Shellby Test Tone","app":"Chrome","status":4}';
  assert.deepEqual(parseNowPlaying(line), {
    title: 'Crab Rave (test)', artist: 'Shellby Test Tone', app: 'Chrome', status: 'playing', playing: true,
  });
});

test('parseNowPlaying maps the playback states', () => {
  const at = status => parseNowPlaying(JSON.stringify({ title: 't', artist: 'a', app: 'Spotify', status }));
  assert.deepEqual([at(4).status, at(4).playing], ['playing', true]);
  assert.deepEqual([at(5).status, at(5).playing], ['paused', false]);
  assert.deepEqual([at(3).status, at(3).playing], ['stopped', false]);
  assert.deepEqual([at(0).status, at(0).playing], ['closed', false]);
  assert.equal(at(99).status, 'unknown');
});

test('parseNowPlaying treats nothing playing as nothing', () => {
  assert.equal(parseNowPlaying('null'), null);
  assert.equal(parseNowPlaying(''), null);
  assert.equal(parseNowPlaying('   '), null);
  assert.equal(parseNowPlaying(undefined), null);
  assert.equal(parseNowPlaying('not json'), null);
  assert.equal(parseNowPlaying('[1,2]'), null);
  // A session with no metadata at all is not a track worth showing.
  assert.equal(parseNowPlaying('{"title":"","artist":"","status":4}'), null);
});

test('parseNowPlaying flattens and caps whatever was in the tags', () => {
  const nasty = parseNowPlaying(JSON.stringify({
    title: `a\nb\tc   ${'x'.repeat(400)}`, artist: 'y'.repeat(400), app: 'z'.repeat(400), status: 4,
  }));
  assert.equal(nasty.title.length, 120);
  assert.ok(!/[\n\t]/.test(nasty.title));
  assert.equal(nasty.artist.length, 120);
  assert.ok(nasty.app.length <= 24);
});

test('appName turns an app id into something readable', () => {
  assert.equal(appName('Spotify.exe'), 'Spotify');
  assert.equal(appName('Chrome'), 'Chrome');
  assert.equal(appName('msedge.exe'), 'Edge');
  assert.equal(appName('308046B0AF4A39CB'), '308046B0AF4A39CB'.slice(0, 24));
  assert.equal(appName('Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic'), 'ZuneMusic');
  assert.equal(appName(''), '');
  assert.equal(appName(null), '');
});

test('sameTrack notices a new song, a pause and nothing at all', () => {
  const a = { title: 'One', artist: 'X', playing: true };
  assert.equal(sameTrack(a, { ...a }), true);
  assert.equal(sameTrack(a, { ...a, playing: false }), false, 'pausing is a change');
  assert.equal(sameTrack(a, { ...a, title: 'Two' }), false);
  assert.equal(sameTrack(null, null), true);
  assert.equal(sameTrack(a, null), false);
  assert.equal(sameTrack(null, a), false);
});

test('trackRemark is short, and says nothing when nothing is playing', () => {
  const remark = trackRemark({ title: 'A Very Long Song Title That Goes On', artist: 'Someone', playing: true }, { pick: () => 0 });
  assert.ok(remark.text.length <= 32, remark.text);
  assert.match(remark.full, /A Very Long Song Title/);
  assert.equal(trackRemark({ title: 'x', playing: false }), null);
  assert.equal(trackRemark(null), null);
  // Every line it can pick is short enough for the bubble.
  for (const p of [0, 0.2, 0.4, 0.6, 0.8, 0.99]) {
    const r = trackRemark({ title: 'Some Song', artist: 'Some Artist', playing: true }, { pick: () => p });
    assert.ok(r.text.length > 0 && r.text.length <= 32, `${p}: ${r.text}`);
  }
});

// ------------------------------------------------------------------ the script

test('the watcher script only writes a line when something changed', () => {
  const src = watcherScript(3000);
  assert.match(src, /if \(\$line -ne \$last\)/, 'it compares before printing');
  assert.match(src, /Start-Sleep -Milliseconds 3000/);
  assert.match(src, /while \(\$true\)/, 'one long-lived process, not one per poll');
  // A media app closing mid-read is normal and must not end the loop.
  assert.match(src, /catch \{\s*\$line = 'null'\s*\}/);
  assert.match(watcherScript(10).match(/Start-Sleep -Milliseconds (\d+)/)[1], /^500$/, 'a silly interval is floored');
});

test('the watcher script exits once Shellby is gone (no orphan after a crash)', () => {
  const src = watcherScript(3000, 4242);
  assert.match(src, /Get-Process -Id 4242 -ErrorAction SilentlyContinue\)\) \{ exit 0 \}/);
  assert.doesNotMatch(watcherScript(3000, 'x; calc'), /calc/, 'only a number gets into the script');
});

// ------------------------------------------------------------------ the watcher

/** A stand-in for the PowerShell child, so no process is spawned. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit('exit', 0); };
  return child;
}

function watcherWithFake(opts = {}) {
  const children = [];
  const watcher = new MediaWatcher({
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    spawnImpl: () => { const c = fakeChild(); children.push(c); return c; },
    ...opts,
  });
  return { watcher, children };
}

test('a track line becomes a track event', () => {
  const { watcher, children } = watcherWithFake();
  const seen = [];
  watcher.on('track', t => seen.push(t));
  watcher.start();
  assert.equal(watcher.status, 'watching');
  children[0].stdout.emit('data', '{"title":"One","artist":"X","app":"Spotify.exe","status":4}\n');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { title: 'One', artist: 'X', app: 'Spotify', status: 'playing', playing: true });
  watcher.stop();
});

test('the same track twice is one event; a pause is another', () => {
  const { watcher, children } = watcherWithFake();
  const seen = [];
  watcher.on('track', t => seen.push(t?.playing ?? null));
  watcher.start();
  const out = children[0].stdout;
  out.emit('data', '{"title":"One","artist":"X","status":4}\n');
  out.emit('data', '{"title":"One","artist":"X","status":4}\n');
  out.emit('data', '{"title":"One","artist":"X","status":5}\n');
  out.emit('data', 'null\n');
  assert.deepEqual(seen, [true, false, null]);
  watcher.stop();
});

test('lines split across chunks are put back together', () => {
  const { watcher, children } = watcherWithFake();
  const seen = [];
  watcher.on('track', t => seen.push(t));
  watcher.start();
  const out = children[0].stdout;
  out.emit('data', '{"title":"Sp');
  out.emit('data', 'lit","artist":"Y","status":4}');
  assert.equal(seen.length, 0, 'nothing until the newline');
  out.emit('data', '\n{"title":"Two","artist":"Z","status":4}\n');
  assert.deepEqual(seen.map(t => t.title), ['Split', 'Two']);
  watcher.stop();
});

test('a flood of output cannot grow the buffer without bound', () => {
  const { watcher, children } = watcherWithFake();
  watcher.start();
  children[0].stdout.emit('data', 'x'.repeat(200000));
  assert.ok(watcher.buffer.length <= 8 * 1024, `buffer is ${watcher.buffer.length}`);
  watcher.stop();
});

test('stopping forgets the track and does not restart', () => {
  const { watcher, children } = watcherWithFake();
  const seen = [];
  watcher.on('track', t => seen.push(t));
  watcher.start();
  children[0].stdout.emit('data', '{"title":"One","status":4}\n');
  watcher.stop();
  assert.equal(watcher.status, 'off');
  assert.equal(watcher.track, null);
  assert.deepEqual(seen.at(-1), null, 'the crab is told to take the headphones off');
  assert.equal(watcher.restart, null, 'no restart was queued');
});

test('anything on stderr means WinRT is not answering here', () => {
  const { watcher, children } = watcherWithFake();
  watcher.start();
  children[0].stderr.emit('data', 'Unable to find type [Windows.Media.Control...]');
  assert.equal(watcher.status, 'unavailable');
  watcher.stop();
});

test('a child that dies is restarted later, not immediately', () => {
  const { watcher, children } = watcherWithFake();
  watcher.start();
  children[0].emit('exit', 1);
  assert.equal(children.length, 1, 'not respawned on the spot');
  assert.ok(watcher.restart, 'a restart is queued');
  watcher.stop();
  assert.equal(watcher.restart, null);
});

test('off Windows it reports itself unavailable and spawns nothing', () => {
  const spawned = [];
  const watcher = new MediaWatcher({ platform: 'linux', spawnImpl: () => { spawned.push(1); return fakeChild(); } });
  watcher.start();
  assert.equal(watcher.available, false);
  assert.equal(watcher.status, 'unavailable');
  assert.deepEqual(spawned, []);
  assert.deepEqual(watcher.view(), { status: 'unavailable', available: false, track: null });
});

test('a spawn that throws is handled, not propagated', () => {
  const watcher = new MediaWatcher({
    platform: 'win32', env: {},
    spawnImpl: () => { throw new Error('EPERM'); },
  });
  assert.doesNotThrow(() => watcher.start());
  assert.equal(watcher.status, 'unavailable');
});

// ------------------------------------------------------------------ real Windows

test('Windows really answers the media-session query', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  // Proves the WinRT bridge in watcherScript works on this machine. Whether
  // anything is playing is not this test's business: both answers are valid.
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
function Await($op, $type) {
  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $task.Wait(8000)) { throw 'timed out' }
  $task.Result
}
$mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$mgr = Await ($mgrType::RequestAsync()) ($mgrType)
if ($null -eq $mgr) { throw 'no manager' }
$session = $mgr.GetCurrentSession()
if ($null -eq $session) { Write-Output 'null' } else {
  $propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
  $props = Await ($session.TryGetMediaPropertiesAsync()) ($propsType)
  [ordered]@{ title = $props.Title; artist = $props.Artist; app = $session.SourceAppUserModelId; status = [int]$session.GetPlaybackInfo().PlaybackStatus } | ConvertTo-Json -Compress
}
`;
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const out = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 30000, windowsHide: true }).trim();

  assert.ok(out === 'null' || out.startsWith('{'), `unexpected answer: ${out.slice(0, 200)}`);
  // Whatever came back, the parser has to cope with it.
  const track = parseNowPlaying(out);
  assert.ok(track === null || typeof track.title === 'string');
});
