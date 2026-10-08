// Your day, as a crab on your wallpaper sees it: a game you just finished, a
// call you're on, a long afternoon in a spreadsheet, Friday afternoon. Only ever
// the *kind* of app in front (from its file name and where it's installed),
// never a window title or anything inside it, and nothing leaves your PC.
//
// Pure: no I/O, no clock (callers pass `now`), so it's testable without
// Windows. src/main/life.js samples the foreground window and the microphone
// and feeds the readings in here. See test/surroundings.test.js.

const SECOND = 1000;
const MINUTE = 60 * SECOND;

// Long stretches worth a remark: Office and its look-alikes. A browser or an
// editor is too general to say anything about.
const STRETCH_APPS = Object.freeze({
  sheet: ['excel.exe', 'scalc.exe', 'et.exe', 'numbers.exe'],
  doc: ['winword.exe', 'swriter.exe', 'wps.exe', 'wordpad.exe'],
  slides: ['powerpnt.exe', 'simpress.exe', 'wpp.exe'],
});

// Apps that are for calls. Foreground alone doesn't mean a call (Teams is open
// all day), so these only count together with the microphone being in use.
const CALL_APPS = new Set([
  'teams.exe', 'ms-teams.exe', 'zoom.exe', 'cpthost.exe', 'webex.exe', 'ciscocollabhost.exe', 'atmgr.exe',
  'skype.exe', 'slack.exe', 'discord.exe', 'gotomeeting.exe', 'g2mcomm.exe', 'whatsapp.exe', 'signal.exe',
  'facetime.exe', 'ringcentral.exe', 'bluejeans.exe', 'lync.exe',
]);

// Where games live. A path is the most reliable sign there is: launchers keep
// every game they install under their own folder.
const GAME_DIRS = [
  /\\steamapps\\common\\/i, /\\epic games\\/i, /\\riot games\\/i, /\\gog galaxy\\games\\/i, /\\gog games\\/i,
  /\\xboxgames\\/i, /\\windowsapps\\microsoft\.(minecraft|halo|forza|seaofthieves)/i, /\\ubisoft game launcher\\games\\/i,
  /\\ea games\\/i, /\\origin games\\/i, /\\battle\.net\\/i, /\\blizzard\\/i, /\\rockstar games\\/i,
  /\\itch\\apps\\/i, /\\heroic\\/i, /\\minecraft launcher\\/i, /\\\.minecraft\\/i,
];
// ...and a few big ones by name, wherever they ended up.
const GAME_EXES = new Set([
  'minecraft.exe', 'robloxplayerbeta.exe', 'fortniteclient-win64-shipping.exe', 'valorant-win64-shipping.exe',
  'leagueoflegends.exe', 'league of legends.exe', 'cs2.exe', 'dota2.exe', 'overwatch.exe', 'r5apex.exe', 'eldenring.exe',
  'gta5.exe', 'rocketleague.exe', 'destiny2.exe', 'wow.exe', 'hearthstone.exe', 'genshinimpact.exe', 'starrail.exe',
  'stardew valley.exe', 'terraria.exe', 'factorio.exe', 'cyberpunk2077.exe', 'bg3.exe', 'bg3_dx11.exe', 'hades2.exe',
]);
// Never a game, even full screen: video, browsers, slideshows.
const NOT_GAMES = new Set([
  'chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'vivaldi.exe', 'arc.exe', 'vlc.exe', 'mpc-hc64.exe',
  'mpc-hc.exe', 'potplayermini64.exe', 'wmplayer.exe', 'video.ui.exe', 'microsoft.media.player.exe', 'netflix.exe',
  'powerpnt.exe', 'obs64.exe', 'explorer.exe', 'shellby.exe', 'electron.exe', 'code.exe', 'spotify.exe',
]);

const GAME_COUNTS_AFTER = 5 * MINUTE;   // a quick look at a launcher isn't a game night
const GAME_GONE_AFTER = 90 * SECOND;    // alt-tabbed out for a moment is still playing
const CALL_COUNTS_AFTER = 2 * MINUTE;   // "can I talk now?" after a 20-second voice note would be odd
const CALL_GONE_AFTER = 45 * SECOND;
const STRETCH_AFTER = 50 * MINUTE;      // most of an hour in one kind of app
const STRETCH_BREAK = 6 * MINUTE;       // a short look elsewhere doesn't reset the stretch

const base = s => String(s || '').split(/[\\/]/).pop().toLowerCase();

/**
 * What kind of app this is, from its file name and full path:
 * 'game' | 'call' | 'sheet' | 'doc' | 'slides' | null.
 *   fullscreen: Windows says a Direct3D app has the screen (QUNS_RUNNING_D3D_FULL_SCREEN)
 */
function kindOfApp({ exe = '', path = '', fullscreen = false } = {}) {
  const name = base(exe || path);
  if (!name) return null;
  for (const [kind, list] of Object.entries(STRETCH_APPS)) if (list.includes(name)) return kind;
  if (CALL_APPS.has(name)) return 'call';
  if (NOT_GAMES.has(name)) return null;
  if (GAME_EXES.has(name)) return 'game';
  if (path && GAME_DIRS.some(re => re.test(path))) return 'game';
  if (fullscreen) return 'game';
  return null;
}

// Apps that keep the microphone open all session without anyone talking:
// clip recorders, streaming tools, voice effects and mixers. Never a call.
const ALWAYS_ON_MIC = new Set([
  'medal.exe', 'medalencoder.exe', 'obs64.exe', 'obs32.exe', 'streamlabs obs.exe', 'xsplit.core.exe', 'nvcontainer.exe',
  'nvidia share.exe', 'nvidia broadcast.exe', 'nvidia broadcast ui.exe', 'voicemeeter.exe', 'voicemeeterpro.exe', 'voicemeeter8x64.exe',
  'steelseriesgg.exe', 'steelseriessonar.exe', 'wavelink.exe', 'krisp.exe', 'nahimicsvc64.exe', 'outplayed.exe', 'insights capture.exe',
]);
const FILETIME_EPOCH = 116444736000000000n; // 1601 to 1970, in 100 ns
const MAX_CALL = 5 * 60 * MINUTE;            // the mic open longer than this is an always-on app, not a call
const fileTimeMs = v => Number((v - FILETIME_EPOCH) / 10000n);

/**
 * Who has the microphone right now, from `reg query` of Windows' own
 * "recently used your microphone" list (CapabilityAccessManager). An app is on
 * the mic while its LastUsedTimeStop is 0 and its LastUsedTimeStart isn't.
 * Returns the app names (exe for desktop apps, package name for store apps).
 * Left out: anything in `own` (Shellby's own push-to-talk); apps that hold the
 * mic all day (ALWAYS_ON_MIC); and, given `now` and `bootAt`, sessions that
 * started before this boot (Windows never closes them when an app crashes or
 * updates, so they say "in use" forever) or have run longer than any call.
 */
function micUsers(regOutput, { own = [], now = null, bootAt = null } = {}) {
  if (typeof regOutput !== 'string' || !regOutput) return [];
  const mine = own.map(o => String(o).toLowerCase()).filter(Boolean);
  const users = [];
  let key = null, start = 0n, stop = null;
  const current = startMs => (!Number.isFinite(bootAt) || startMs >= bootAt - 60 * SECOND)
    && (!Number.isFinite(now) || now - startMs <= MAX_CALL);
  const flush = () => {
    if (key && stop === 0n && start > FILETIME_EPOCH && current(fileTimeMs(start))) {
      const leaf = key.split('\\').pop();
      // Desktop apps are stored by path with '#' for '\'.
      const name = /#/.test(leaf) ? base(leaf.replace(/#/g, '\\')) : leaf.toLowerCase();
      const lower = key.toLowerCase();
      if (name && !ALWAYS_ON_MIC.has(name) && !mine.some(m => lower.includes(m.replace(/\\/g, '#')) || name === base(m))) users.push(name);
    }
    key = null; start = 0n; stop = null;
  };
  for (const raw of regOutput.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^HKEY_/i.test(line)) { flush(); key = line.trim(); continue; }
    const m = /^\s+(LastUsedTimeStart|LastUsedTimeStop)\s+REG_QWORD\s+0x([0-9a-f]+)/i.exec(line);
    if (!m || !key) continue;
    const v = BigInt(`0x${m[2]}`);
    if (/start/i.test(m[1])) start = v; else stop = v;
  }
  flush();
  return [...new Set(users)];
}

/** A fresh state for track(). */
const emptyState = () => ({ game: null, call: null, stretch: null });

/**
 * One reading of what's going on. Returns { state, events, onCall, playing }.
 *   sample: { kind, exe, micBusy } — the foreground app's kind and file name,
 *     and whether anything (not Shellby) has the microphone
 *   events: [{ type: 'gameOver', exe, minutes } | { type: 'callStart' } |
 *            { type: 'callOver', minutes } | { type: 'stretch', kind, minutes }]
 * A call is the microphone in use: most calls hold it the whole time, and a
 * call app in front with the mic quiet is just Teams being open.
 */
function track(stateIn, sample, now) {
  const s = { ...emptyState(), ...(stateIn && typeof stateIn === 'object' ? stateIn : {}) };
  const t = Number(now);
  const events = [];
  if (!Number.isFinite(t)) return { state: s, events, onCall: !!s.call?.live, playing: !!s.game };
  const kind = sample?.kind || null;
  const exe = base(sample?.exe);

  // ---- games: counted from first sight; over once it hasn't been in front for a while
  let game = s.game;
  if (kind === 'game' && exe) {
    game = game && game.exe === exe ? { ...game, seen: t } : { exe, since: t, seen: t };
  } else if (game && t - game.seen >= GAME_GONE_AFTER) {
    const played = game.seen - game.since;
    if (played >= GAME_COUNTS_AFTER) events.push({ type: 'gameOver', exe: game.exe, minutes: Math.round(played / MINUTE) });
    game = null;
  }

  // ---- calls: the microphone in use
  let call = s.call;
  if (sample?.micBusy) {
    if (!call) call = { since: t, seen: t, live: false };
    else call = { ...call, seen: t };
    if (!call.live) { call = { ...call, live: true }; events.push({ type: 'callStart' }); }
  } else if (call && t - call.seen >= CALL_GONE_AFTER) {
    const lasted = call.seen - call.since;
    if (lasted >= CALL_COUNTS_AFTER) events.push({ type: 'callOver', minutes: Math.round(lasted / MINUTE) });
    call = null;
  }

  // ---- a long stretch in one kind of app: total time in front, short breaks forgiven
  let stretch = s.stretch;
  const stretchy = kind === 'sheet' || kind === 'doc' || kind === 'slides';
  if (stretchy) {
    if (!stretch || stretch.kind !== kind || t - stretch.seen > STRETCH_BREAK) stretch = { kind, since: t, seen: t, told: false };
    else stretch = { ...stretch, seen: t };
    if (!stretch.told && stretch.seen - stretch.since >= STRETCH_AFTER) {
      events.push({ type: 'stretch', kind, minutes: Math.round((stretch.seen - stretch.since) / MINUTE) });
      stretch = { ...stretch, told: true };
    }
  } else if (stretch && t - stretch.seen > STRETCH_BREAK) {
    stretch = null;
  }

  return { state: { game, call, stretch }, events, onCall: !!call?.live, playing: !!game };
}

/** The voice occasion for a track() event, or null. */
function occasionFor(event) {
  if (!event) return null;
  if (event.type === 'gameOver') return 'gameOver';
  if (event.type === 'callOver') return 'callOver';
  if (event.type === 'stretch') return { sheet: 'sheetStretch', doc: 'docStretch', slides: 'slideStretch' }[event.kind] || null;
  return null;
}

/**
 * What kind of day it is: 'friday' on a Friday afternoon, 'weekend' on Saturday
 * and Sunday daytime, 'monday' first thing on a Monday, else null.
 */
function dayOccasion(date) {
  const d = date instanceof Date ? date : new Date(Number(date));
  if (Number.isNaN(d.getTime())) return null;
  const day = d.getDay(), h = d.getHours();
  if (day === 5 && h >= 14 && h < 20) return 'friday';
  if ((day === 6 || day === 0) && h >= 9 && h < 20) return 'weekend';
  if (day === 1 && h >= 7 && h < 12) return 'monday';
  return null;
}

/** "Minecraft" from "minecraft.exe", or null when the name wouldn't read well in a bubble. */
function niceName(exe, max = 14) {
  const b = base(exe).replace(/\.exe$/, '').replace(/[-_](win64|win32|shipping|x64|dx11|dx12)\b/g, '').replace(/[-_]+/g, ' ').trim();
  if (!b || b.length > max || !/^[a-z][a-z0-9 ]*$/i.test(b) || /^(javaw|java|launcher|game|client|app)$/i.test(b)) return null;
  return b.replace(/\b\w/g, c => c.toUpperCase());
}

module.exports = {
  kindOfApp, micUsers, track, emptyState, occasionFor, dayOccasion, niceName,
  STRETCH_APPS, CALL_APPS, GAME_COUNTS_AFTER, GAME_GONE_AFTER, CALL_COUNTS_AFTER, CALL_GONE_AFTER, STRETCH_AFTER, STRETCH_BREAK,
};
