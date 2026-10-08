// The world around him: desk lighting (rgb.js), music (media.js),
// push-to-talk, his life between tasks (life.js, playtime.js), typing along
// and the weather.
// Kept out of main.js, which only wires it up.
const { BrowserWindow, app, net, powerMonitor, screen } = require('electron');
const os = require('os');
const path = require('path');
const confirm = require('../confirm');
const { pin: pinToDesktop } = require('../desktop-layer');
const { Dictation, PushToTalk, holdKeyOf } = require('../dictation');
const focus = require('../focus');
const { watchesDesktop } = require('../test-desktop');
const gifts = require('../gifts');
const keystrokes = require('../keystrokes');
const { createLife } = require('../life');
const { MediaWatcher, trackRemark } = require('../media');
const native = require('../native-windows');
const openRgbSetup = require('../openrgb-setup');
const { createPlaytime } = require('../playtime');
const { OpenRgbClient, colorFor } = require('../rgb');
const { createTyping } = require('../typing');
const voice = require('../voice');
const { activeSeasons } = require('../wardrobe/seasons');
const { publicItem } = require('../wardrobe/service');
const weatherRules = require('../weather');
const { createWeatherService } = require('../weather-service');

/** d: what main shares (main.js `shared`). */
function wireSurroundings(d) {
  // ---- the desk lighting

  function rgbSettings() {
    const raw = d.config.get('rgb');
    const port = Number(raw?.port);
    return { enabled: !!raw?.enabled, port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 6742 };
  }

  function createRgb() {
    d.rgbClient = new OpenRgbClient({ port: rgbSettings().port });
  }

  function paintLights() {
    if (!d.rgbClient || !rgbSettings().enabled) return;
    const color = colorFor({ state: d.lastStatus.state, mood: d.healthMood?.mood, ciFailing: d.ci?.view().failing || 0 });
    if (!color) return;
    const key = `${color.r},${color.g},${color.b}`;
    if (key === d.lastRgbColor) return;      // the crab refreshes many times a second
    d.lastRgbColor = key;
    d.rgbClient.setAll(color).then(r => {
      if (!r.ok) { d.log.info(`rgb: ${r.error}`); return; }
      // The first paint since switching on: remember how each device was, so
      // switching off can hand the user's own lighting back.
      if (!d.config.get('rgbSaved')) d.config.set({ rgbSaved: r.devices.map(({ id, name, saved }) => ({ id, name, saved })) });
    }).catch(() => {});
  }

  /** Switching off: put every device back the way the first paint found it. */
  function restoreLights(client) {
    const saved = d.config.get('rgbSaved');
    if (!saved) return Promise.resolve({ ok: true });
    return client.restore(saved).then(r => {
      if (r.ok) d.config.set({ rgbSaved: null });
      else d.log.info(`rgb restore: ${r.error}`);
      return r;
    });
  }

  let rgbSetup = null; // 'installing' | 'starting' while Shellby gets OpenRGB going

  const rgbView = () => ({
    ...rgbSettings(),
    devices: d.rgbClient?.devices || null,
    error: d.rgbClient?.lastError || null,
    installed: !!openRgbSetup.findOpenRgb(),
    setup: rgbSetup,
  });

  /**
   * Probe OpenRGB, starting it first if it's installed but not running; then
   * paint. One attempt at a time: startup, the switch and the button can all ask
   * at once, and each launching its own OpenRGB would fight over the port.
   */
  let ensuring = null;
  function ensureOpenRgb() {
    if (rgbSetup === 'installing') return Promise.resolve({ ok: false, error: 'Installing OpenRGB…' }); // not a half-installed exe
    if (ensuring) return ensuring;
    rgbSetup = 'starting';
    ensuring = openRgbSetup.ensureRunning({ probe: () => d.rgbClient.probe(), port: rgbSettings().port })
      .then(r => { if (r.ok) { d.lastRgbColor = ''; paintLights(); } return r; })
      .catch(e => ({ ok: false, error: e?.message || "Couldn't reach OpenRGB." }))
      .finally(() => { ensuring = null; if (rgbSetup === 'starting') rgbSetup = null; });
    return ensuring;
  }

  /** Install OpenRGB (after asking in the isolated confirm window), then start it. */
  let rgbInstallAsking = false;
  async function confirmAndInstallOpenRgb() {
    // Main decides, not the panel's disabled button: one question, one install.
    if (rgbInstallAsking || rgbSetup === 'installing') return rgbView();
    if (openRgbSetup.findOpenRgb()) return { ...rgbView(), ...(await ensureOpenRgb()) };
    rgbInstallAsking = true;
    let response;
    try {
      response = await confirm.ask(d.panel, {
        ...d.dialogLook(), icon: '💡',
        title: 'Install OpenRGB?',
        message: 'Shellby installs OpenRGB with winget, then starts it in the tray with its SDK server on.',
        detail: `OpenRGB is free and open source (GPL-2.0). winget downloads the official installer (${openRgbSetup.WINGET_ID}) from OpenRGB's GitHub release, and Windows asks for permission to install it.`,
        note: 'The first time it runs, OpenRGB may ask for admin access too, so it can reach your motherboard and RAM lighting.',
        buttons: [{ label: 'Install it', style: 'primary' }, { label: 'Cancel' }], defaultId: 0, cancelId: 1,
      });
    } finally {
      rgbInstallAsking = false;
    }
    if (response !== 0) return rgbView();
    rgbSetup = 'installing';
    let installed;
    try { installed = await openRgbSetup.installOpenRgb(); } finally { rgbSetup = null; }
    if (!installed.ok) return { ...rgbView(), ok: false, error: installed.error, noWinget: !!installed.noWinget };
    return { ...rgbView(), ...(await ensureOpenRgb()) };
  }

  // ---- listening along

  function mediaSettings() {
    const raw = d.config.get('nowPlaying');
    return {
      enabled: !!raw?.enabled,
      headphones: raw?.headphones !== false,   // on by default once the feature is
      remarks: raw?.remarks !== false,
    };
  }

  function createMedia() {
    d.media = new MediaWatcher();
    d.media.on('track', track => {
      d.nowPlaying = track;
      // The headphones go on and come off with the music, like the focus helmet.
      d.broadcastSkin();
      d.refreshCritter();
      d.send(d.panel, 'nowplaying', mediaView());
      if (track?.playing && mediaSettings().remarks) {
        const remark = trackRemark(track);
        if (remark) d.sayText(remark.text, 'music');
      }
    });
    d.media.on('status', () => d.send(d.panel, 'nowplaying', mediaView()));
    if (mediaSettings().enabled) d.media.start();
  }

  // ---- push-to-talk

  // Tap the hotkey: the panel, as ever. Hold it (with push-to-talk on): he
  // listens, and what you said is in the box when you let go. See dictation.js.
  // ---- his life between tasks

  // Free to play: not working or asking (a trophy's celebration or a nap doesn't count), nobody else beside him.
  const playerFree = () => !['working', 'asking'].includes(d.lastStatus.state) && !d.crewShown && !d.guestShown && !d.dragging
    && !d.perching?.isAway() && !focus.guarding(d.config.get('focus'), Date.now());

  // Who has the microphone, from Windows' own list (surroundings.js reads it).
  // Read in place (native-windows.js regQwords, a few ms); reg.exe only if that
  // can't, since it costs ~300 ms of CPU a time, every 20 seconds.
  const readMic = key => {
    const text = native.regQwords(key, ['LastUsedTimeStart', 'LastUsedTimeStop']);
    return text != null ? Promise.resolve(text) : readMicWithReg(key);
  };
  const readMicWithReg = key => new Promise((resolve, reject) => {
    require('child_process').execFile('reg', ['query', key, '/s'], { windowsHide: true, timeout: 5000, maxBuffer: 2 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(String(out))));
  });

  function createLifeAndPlay() {
    const sendCritter = (channel, payload) => d.send(d.critter, channel, payload);
    const burst = () => d.send(d.critter, 'critter:burst', d.outfit().confetti);
    d.life = createLife({
      config: d.config, native,
      enabled: () => !d.CAPTURE && !!d.critter && !d.critter.isDestroyed(),
      temperament: () => voice.temperamentOf(voice.normalize(d.config.get('voice')).seed),
      speak: (occasion, opts) => d.speak(occasion, opts),
      say: (text, ms, occasion) => d.sayText(text, occasion, ms),
      tankRemark: () => d.tankRemark?.() || null, // a word about his tank (ipc/tank.js)
      dialogue: () => (d.wardrobe ? d.wardrobe.dialogue() : null),
      toCrab: sendCritter,
      toPanel: (channel, payload) => d.send(d.panel, channel, payload),
      // You're at your PC: he stays up (refreshCritter puts him to sleep SLEEP_AFTER_MS after this).
      touch: () => { d.lastActivity = Date.now(); if (d.lastStatus.state === 'sleeping') d.refreshCritter(); },
      refresh: () => d.refreshCritter(),
      stat: d.stat, awardXp: d.awardXp, burst,
      systemIdleSeconds: () => { try { return powerMonitor.getSystemIdleTime(); } catch { return null; } },
      isIdle: () => d.lastStatus.state === 'idle' && !d.dragging && !d.perching?.isUp() && !d.climbing?.busy() && !d.pranks?.busy(),
      working: () => ['working', 'asking'].includes(d.lastStatus.state),
      playing: () => !!d.playtime?.busy(),
      guarding: () => focus.guarding(d.config.get('focus'), Date.now()),
      music: () => !!d.nowPlaying?.playing,
      seasons: () => activeSeasons(new Date(), d.seasonsWhere()).map(x => x.id),
      calm: () => !!d.crabCalm?.().calm, // covered, under a game, away or locked (wiring/windows.js)
      locked: () => d.calmReason === 'locked',
      // Where his eyes are on screen: 4 cells right of centre and about 12 up from his feet.
      eyePoint: () => {
        if (!d.critter || d.critter.isDestroyed()) return null;
        const b = d.critter.getBounds();
        const self = 22 * d.px() + 72;
        return { x: b.x + b.width - self / 2 + 4 * d.px(), y: b.y + b.height - 18 - 12 * d.px() };
      },
      cursor: () => screen.getCursorScreenPoint(),
      throws: () => d.wardrobe?.stats.timesThrown || 0,
      firstDay: () => { const days = d.wardrobe?.stats.activeDays || []; return days.length ? new Date(`${days[0]}T12:00:00`).getTime() : null; },
      readMic: watchesDesktop(process.env, app.isPackaged) ? readMic : null, // a test run ignores whoever has the mic (test-desktop.js)
      ownExes: () => [process.execPath],
      bootAt: () => Date.now() - os.uptime() * 1000, // mic sessions older than this are stale (surroundings.js)
      ownPids: () => [process.pid],
      leavePerch: () => { if (d.perching?.isUp()) d.perching.leave('call'); },
      playView: () => d.playtime?.view() || null,
      log: msg => d.log.warn(msg),
    });
    d.playtime = createPlaytime({
      config: d.config, native, screen,
      ownPids: () => [process.pid],
      isFree: playerFree,
      prepare: () => { d.life.cancel(); d.life.wake(); d.motion?.stop(); d.wake(); },
      getPos: () => { const [x, y] = d.critter.getPosition(); return { x, y }; },
      bounds: () => d.critter.getBounds(),
      place: (x, y) => d.placeCritter(x, y),
      pin: () => { pinToDesktop(d.critter); d.syncLayer(); }, // hiding, he's back under your apps (onTopNow)
      float: () => native.float(native.hwndOf(d.critter)),
      say: (text, ms, occasion) => d.sayText(text, occasion, ms),
      toCrab: sendCritter,
      burst, stat: d.stat,
      chirp: () => d.chirp('play'),
      onPlayed: (kind, data) => d.life.played(kind, data),
      changed: () => d.send(d.panel, 'life', d.life.view()),
      refresh: () => d.refreshCritter(),
      motion: () => d.motion,
      motionBox: d.motionBox,
      px: d.px,
      makeWindow: ({ width, height }) => {
        const w = new BrowserWindow({
          width, height, frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false,
          alwaysOnTop: false, skipTaskbar: true, focusable: false, hasShadow: false, show: false,
          title: 'Shellby’s pebble', icon: d.ICON, webPreferences: { ...d.webPreferences, preload: d.TOY_PRELOAD },
        });
        d.secureWindow(w);
        w.loadFile(path.join(d.RENDERER, 'toy', 'toy.html'));
        return w;
      },
      pinWindow: w => pinToDesktop(w),
      favouriteFind: () => gifts.favourite(d.config.get('finds')),
    });
    d.life.start();
  }

  function createDictation() {
    // SHELLBY_DICTATION_WAV: a recording in place of the microphone (scripts/e2e-push-to-talk.js).
    d.dictation = new Dictation({ wav: process.env.SHELLBY_DICTATION_WAV || null });
    // This press got the mic, so its result (or "didn't catch that") will follow.
    // A press that didn't (the last one is still finishing) leaves that one alone:
    // tapping to open the panel straight after speaking mustn't throw the words away.
    let heard = false;
    d.dictation.on('result', ({ text, error }) => onDictated(text, error));
    d.dictation.on('error', message => d.log.warn('Dictation', message));
    d.dictation.on('log', line => d.log.info(`dictation: ${line}`));
    d.ptt = new PushToTalk({
      isDown: () => native.keyDown(holdKeyOf(d.config.get('hotkey'))),
      onPress: () => { heard = d.dictation.begin(); },
      onTap: () => { if (heard) d.dictation.cancel(); d.togglePanel(); },
      onHold: () => showListening(true),
      onRelease: () => {
        showListening(false);
        if (heard) d.dictation.finish();
        else if (!d.dictation.busy) onDictated('', d.dictation.lastError);
      },
    });
    if (pushToTalkOn()) d.dictation.warm();
  }

  const pushToTalkOn = () => !!d.config.get('pushToTalk') && !d.config.get('crabOnly');

  function onHotkey() {
    // A key we can't watch for the release (or no koffi) can still be tapped.
    if (!pushToTalkOn() || !d.ptt || holdKeyOf(d.config.get('hotkey')) == null || !native.available()) return d.togglePanel();
    d.ptt.press();
  }

  // His bubble says he's listening for as long as the key is down. Not held back
  // by focus guard like his own remarks: you asked, so you get the answer.
  const LISTENING = 'listening…';
  function showListening(on) {
    if (on) d.said = { text: LISTENING, occasion: 'listening', until: Date.now() + 10 * 60 * 1000 };
    else if (d.said?.occasion === 'listening') d.said = null;
    d.refreshCritter();
  }

  function onDictated(text, error = null) {
    if (!text) {
      // The why is in the log and on the Settings switch; the bubble only has room for the gist.
      d.sayText(error ? "can't hear you" : "didn't catch that", 'listening', 4000);
      return;
    }
    // Not sent: it goes in the box, after anything already typed there, to read first.
    d.showPanel({ focusInput: false });
    d.send(d.panel, 'panel:dictated', text);
  }

  const mediaView = () => ({ ...mediaSettings(), ...(d.media ? d.media.view() : { status: 'off', available: process.platform === 'win32', track: null }) });

  /** The headphones he puts on by himself while something is playing. */
  function musicHeadphones() {
    if (!d.nowPlaying?.playing || !mediaSettings().enabled || !mediaSettings().headphones) return null;
    const item = d.wardrobe?.item('headphones');
    return item ? publicItem(item) : null;
  }

  // ---- typing along

  function typingSettings() {
    const raw = d.config.get('typing');
    // Off until you turn it on: it hears every key on the PC (never which one).
    return { enabled: raw?.enabled === true, remarks: raw?.remarks !== false };
  }

  function createTypingAlong() {
    d.typing = createTyping({
      watch: onKey => keystrokes.watch(onKey),
      settings: typingSettings,
      // Awake, idle and on the ground, with nothing else in his claws: work, a
      // nap, a game, a scene, a call (his shh sign is up), a ride on your
      // window, a wall to cling to or a prank all come first.
      eligible: () => !!d.critter && !d.critter.isDestroyed() && d.lastStatus.state === 'idle' && !(d.flash?.until > Date.now()) && !d.dragging
        && !d.perching?.isUp() && !d.climbing?.busy() && !d.pranks?.busy() && d.calmReason !== 'locked'
        && !d.life?.busy() && !d.life?.onCall() && !d.playtime?.busy() && !d.visitor,
      toCrab: (channel, payload) => d.send(d.critter, channel, payload),
      speak: (occasion, opts) => d.speak(occasion, opts),
      best: () => d.config.get('typingBest'),
      setBest: wpm => d.config.set({ typingBest: wpm }),
    });
    if (!d.CAPTURE) d.typing.start();
  }

  // ---- the weather outside

  // Countries that read the thermometer in Fahrenheit.
  const FAHRENHEIT = new Set(['US', 'LR', 'MM', 'BS', 'BZ', 'KY', 'PW']);
  const weatherUnit = () => (FAHRENHEIT.has(app.getLocaleCountryCode()) ? 'f' : 'c');

  function weatherView() {
    const v = d.weatherSvc.view();
    return { ...v, label: weatherRules.placeLabel(v.place), summary: weatherRules.describe(v.reading, weatherUnit()), unit: weatherUnit(), south: weatherRules.isSouth(v.place) };
  }

  function createWeather() {
    d.weatherSvc = createWeatherService({
      config: d.config,
      fetch: (url, opts) => net.fetch(url, opts),
      onReading: (prev, next) => {
        d.broadcastWardrobe(); // the sou'wester goes on, or comes off
        d.send(d.panel, 'weather', weatherView());
        const occasion = weatherRules.remarkFor(prev, next);
        if (occasion && d.weatherSvc.settings().remarks) d.speak(occasion);
      },
      // A reading too old to trust takes the umbrella off (weather.js dress).
      onFail: () => d.broadcastWardrobe(),
      log: msg => d.log.warn(msg),
    });
    if (d.CAPTURE) return;
    d.weatherSvc.start();
    // Asleep for hours: the last reading is stale, so ask again on waking.
    powerMonitor.on('resume', () => d.weatherSvc.start());
  }

  return {
    confirmAndInstallOpenRgb, createDictation, createLifeAndPlay, createMedia, createRgb,
    createTypingAlong, createWeather, ensureOpenRgb, mediaSettings, mediaView, musicHeadphones,
    onHotkey, paintLights, restoreLights, rgbSettings, rgbView, showListening, typingSettings,
    weatherView,
  };
}

module.exports = { wireSurroundings };
