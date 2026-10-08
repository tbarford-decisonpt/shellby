const { test } = require('node:test');
const assert = require('node:assert/strict');
const s = require('../src/main/surroundings');

const T0 = new Date(2026, 9, 2, 15, 0, 0).getTime(); // a Friday afternoon
const SECOND = 1000;

// Feeds a run of readings, one every `every` ms, and collects every event.
function run(state, samples, { from = T0, every = 15 * SECOND } = {}) {
  let st = state, t = from;
  const events = [];
  let last = null;
  for (const sample of samples) {
    last = s.track(st, sample, t);
    st = last.state;
    events.push(...last.events);
    t += every;
  }
  return { state: st, events, last, t };
}
const times = (n, sample) => Array.from({ length: n }, () => sample);

test('apps are known by name and by where they are installed', () => {
  assert.equal(s.kindOfApp({ exe: 'EXCEL.EXE' }), 'sheet');
  assert.equal(s.kindOfApp({ exe: 'winword.exe' }), 'doc');
  assert.equal(s.kindOfApp({ exe: 'POWERPNT.EXE' }), 'slides');
  assert.equal(s.kindOfApp({ exe: 'Teams.exe' }), 'call');
  assert.equal(s.kindOfApp({ exe: 'zoom.exe' }), 'call');
  assert.equal(s.kindOfApp({ exe: 'cs2.exe' }), 'game');
  assert.equal(s.kindOfApp({ exe: 'whatever.exe', path: 'D:\\SteamLibrary\\steamapps\\common\\Hades II\\Hades2.exe' }), 'game');
  assert.equal(s.kindOfApp({ exe: 'javaw.exe', path: 'C:\\Users\\a\\AppData\\Roaming\\.minecraft\\runtime\\bin\\javaw.exe' }), 'game');
  assert.equal(s.kindOfApp({ exe: 'javaw.exe', path: 'C:\\Program Files\\Java\\bin\\javaw.exe' }), null, 'any other Java app is not a game');
});

test('full screen makes an unknown app a game, but never a browser or a video player', () => {
  assert.equal(s.kindOfApp({ exe: 'indiegame.exe', fullscreen: true }), 'game');
  assert.equal(s.kindOfApp({ exe: 'indiegame.exe' }), null);
  assert.equal(s.kindOfApp({ exe: 'chrome.exe', fullscreen: true }), null);
  assert.equal(s.kindOfApp({ exe: 'vlc.exe', fullscreen: true }), null);
  assert.equal(s.kindOfApp({ exe: 'POWERPNT.EXE', fullscreen: true }), 'slides');
  assert.equal(s.kindOfApp({}), null);
});

test('a game played for a while gets a "gg" once it has been gone a moment', () => {
  const play = run(s.emptyState(), times(4 * 8, { kind: 'game', exe: 'cs2.exe' })); // 8 minutes
  assert.equal(play.events.length, 0);
  assert.ok(play.last.playing);
  // Alt-tab out for under the grace period: still the same game.
  const tabbed = run(play.state, times(4, { kind: null, exe: 'chrome.exe' }), { from: play.t });
  assert.equal(tabbed.events.length, 0);
  const back = run(tabbed.state, times(2, { kind: 'game', exe: 'cs2.exe' }), { from: tabbed.t });
  const done = run(back.state, times(8, { kind: null, exe: 'explorer.exe' }), { from: back.t });
  const over = done.events.filter(e => e.type === 'gameOver');
  assert.equal(over.length, 1);
  assert.equal(over[0].exe, 'cs2.exe');
  assert.ok(over[0].minutes >= 8);
  assert.equal(s.occasionFor(over[0]), 'gameOver');
});

test('a quick look at a game is not a game night', () => {
  const peek = run(s.emptyState(), times(8, { kind: 'game', exe: 'cs2.exe' })); // 2 minutes
  const after = run(peek.state, times(10, { kind: null }), { from: peek.t });
  assert.deepEqual(after.events, []);
  assert.equal(after.state.game, null);
});

test('the microphone in use is a call: he hushes at once and asks how it went after', () => {
  const start = s.track(s.emptyState(), { micBusy: true }, T0);
  assert.ok(start.onCall);
  assert.deepEqual(start.events, [{ type: 'callStart' }]);
  const talk = run(start.state, times(4 * 10, { micBusy: true }), { from: T0 + 15 * SECOND });
  assert.ok(talk.last.onCall);
  assert.ok(!talk.events.some(e => e.type === 'callStart'), 'the start is told once');
  const hangUp = run(talk.state, times(5, { micBusy: false }), { from: talk.t });
  const over = hangUp.events.find(e => e.type === 'callOver');
  assert.ok(over && over.minutes >= 10);
  assert.ok(!hangUp.last.onCall);
});

test('a voice note is not a call worth asking about', () => {
  const blip = run(s.emptyState(), times(3, { micBusy: true }));
  const after = run(blip.state, times(5, { micBusy: false }), { from: blip.t });
  assert.ok(!after.events.some(e => e.type === 'callOver'));
});

test('most of an hour in Excel earns one remark, short breaks forgiven', () => {
  const morning = run(s.emptyState(), times(4 * 30, { kind: 'sheet', exe: 'excel.exe' }));
  const coffee = run(morning.state, times(12, { kind: null, exe: 'chrome.exe' }), { from: morning.t }); // 3 min away
  const more = run(coffee.state, times(4 * 25, { kind: 'sheet', exe: 'excel.exe' }), { from: coffee.t });
  const all = [...morning.events, ...coffee.events, ...more.events].filter(e => e.type === 'stretch');
  assert.equal(all.length, 1);
  assert.equal(all[0].kind, 'sheet');
  assert.equal(s.occasionFor(all[0]), 'sheetStretch');
  // ...and staying on doesn't say it again.
  const evenMore = run(more.state, times(4 * 30, { kind: 'sheet', exe: 'excel.exe' }), { from: more.t });
  assert.ok(!evenMore.events.some(e => e.type === 'stretch'));
});

test('a long break resets the stretch', () => {
  const a = run(s.emptyState(), times(4 * 30, { kind: 'doc', exe: 'winword.exe' }));
  const lunch = run(a.state, times(4 * 20, { kind: null }), { from: a.t });
  assert.equal(lunch.state.stretch, null);
});

test('Friday afternoon, the weekend and Monday morning', () => {
  assert.equal(s.dayOccasion(new Date(2026, 9, 2, 15)), 'friday');
  assert.equal(s.dayOccasion(new Date(2026, 9, 2, 10)), null, 'Friday morning is just a morning');
  assert.equal(s.dayOccasion(new Date(2026, 9, 3, 11)), 'weekend');
  assert.equal(s.dayOccasion(new Date(2026, 9, 4, 3)), null, 'nobody wants "lazy day?" at 3am');
  assert.equal(s.dayOccasion(new Date(2026, 9, 5, 8)), 'monday');
  assert.equal(s.dayOccasion(new Date(2026, 9, 6, 8)), null);
  assert.equal(s.dayOccasion('nope'), null);
});

test('reads who has the microphone from the registry, leaving Shellby out', () => {
  const out = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\MicrosoftTeams_8wekyb3d8bbwe',
    '    Value    REG_SZ    Allow',
    '    LastUsedTimeStart    REG_QWORD    0x1db0f1a2b3c4d5e',
    '    LastUsedTimeStop    REG_QWORD    0x0',
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C:#Users#a#AppData#Local#Discord#app-1.0#Discord.exe',
    '    LastUsedTimeStart    REG_QWORD    0x1db0f1a2b3c4d5e',
    '    LastUsedTimeStop    REG_QWORD    0x1db0f1a2b3c4e00',
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C:#Users#a#AppData#Local#Programs#Shellby#Shellby.exe',
    '    LastUsedTimeStart    REG_QWORD    0x1db0f1a2b3c4d5e',
    '    LastUsedTimeStop    REG_QWORD    0x0',
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C:#Program Files#Zoom#bin#Zoom.exe',
    '    LastUsedTimeStart    REG_QWORD    0x1db0f1a2b3c4d5e',
    '    LastUsedTimeStop    REG_QWORD    0x0',
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NeverUsed',
    '    LastUsedTimeStop    REG_QWORD    0x0',
  ].join('\r\n');
  const own = ['C:\\Users\\a\\AppData\\Local\\Programs\\Shellby\\Shellby.exe'];
  assert.deepEqual(s.micUsers(out, { own }).sort(), ['microsoftteams_8wekyb3d8bbwe', 'zoom.exe']);
  assert.deepEqual(s.micUsers(''), []);
  assert.deepEqual(s.micUsers(null), []);
});

test('stale and always-on microphone entries are not calls', () => {
  // FILETIME (100 ns since 1601) for a moment in ms since 1970.
  const ft = ms => `0x${(BigInt(ms) * 10000n + 116444736000000000n).toString(16)}`;
  const bootAt = T0 - 3 * 60 * 60 * 1000;
  const key = leaf => `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\${leaf}`;
  const entry = (leaf, startMs) => [key(leaf), `    LastUsedTimeStart    REG_QWORD    ${ft(startMs)}`, '    LastUsedTimeStop    REG_QWORD    0x0', ''];
  const out = [
    // An old Discord that crashed years ago: Windows still says "in use".
    ...entry('C:#Users#a#AppData#Local#Discord#app-1.0.9007#Discord.exe', new Date(2022, 11, 9).getTime()),
    // A clip recorder that has held the mic since login.
    ...entry('C:#Users#a#AppData#Local#Medal#recorder-3.1128.0#MedalEncoder.exe', bootAt + 60 * 1000),
    // Something open for most of a day: no call is that long.
    ...entry('C:#Tools#mystery-recorder.exe', T0 - 2 * 60 * 60 * 1000 - 4 * 60 * 60 * 1000),
    // ...and an actual call, started ten minutes ago.
    ...entry('C:#Program Files#Zoom#bin#Zoom.exe', T0 - 10 * 60 * 1000),
  ].join('\r\n');
  assert.deepEqual(s.micUsers(out, { now: T0, bootAt }), ['zoom.exe']);
});

test('app names only go in his bubble when they read well', () => {
  assert.equal(s.niceName('minecraft.exe'), 'Minecraft');
  assert.equal(s.niceName('RocketLeague.exe'), 'Rocketleague');
  assert.equal(s.niceName('valorant-win64-shipping.exe'), 'Valorant', 'build suffixes come off');
  assert.equal(s.niceName('microsoftflightsimulator.exe'), null, 'too long');
  assert.equal(s.niceName('javaw.exe'), null);
  assert.equal(s.niceName('chrome.exe'), 'Chrome');
  assert.equal(s.niceName(''), null);
});
