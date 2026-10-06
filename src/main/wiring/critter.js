// What the crab window shows: his skin, outfit and homes, the state he's in,
// and what he says (voice.js) and when.
// Kept out of main.js, which only wires it up.
const focus = require('../focus');
const workmode = require('../workmode');
const shells = require('../shells');
const sounds = require('../sounds');
const statusLine = require('../statusline');
const streaks = require('../streaks');
const voice = require('../voice');
const { publicItem } = require('../wardrobe/service');
const weatherRules = require('../weather');
const { levelFor } = require('../xp');

/** d: what main shares (main.js `shared`). */
function wireCritter(d) {
  // ---- critter state

  // Built-in/user skins plus wardrobe pack skins (which can be locked).
  function allSkins() {
    const packSkins = d.wardrobe ? d.wardrobe.catalog.skins.map(s => ({ ...s, id: s.key, locked: d.wardrobe.lockInfo(s) })) : [];
    return [...d.skins, ...packSkins];
  }

  function activeSkin() {
    const list = allSkins();
    const chosen = list.find(s => s.id === d.config.get('skin'));
    return (chosen && !chosen.locked ? chosen : null) || list.find(s => s.id === 'classic') || list[0];
  }

  function outfit() {
    const o = d.wardrobe ? d.wardrobe.render() : { accessories: [], effect: null, confetti: null, crewAccessories: [] };
    const helmet = d.wardrobe?.item('guard-helmet'); // worn while he guards your focus
    const worn = shells.wornShell(d.config?.get('home'), currentLevel());
    return {
      ...o,
      home: shells.renderShell(worn),
      stickers: d.config ? d.shellStickers(activeSkin(), worn) : [],
      focusHelmet: helmet ? publicItem(helmet) : null,
      musicHeadphones: d.musicHeadphones(),
      weather: weatherWear(),
    };
  }

  /**
   * What he puts on by himself for the weather outside (weather.js dress): items
   * by slot over his own outfit, an effect instead of his own, and a mood for the
   * renderer. Like the headphones, they don't need unlocking. Null on a plain day.
   */
  function weatherWear() {
    if (!d.weatherSvc?.settings().enabled) return null;
    const w = weatherRules.dress(d.weatherSvc.reading(), Date.now());
    if (!w) return null;
    const pick = id => (id ? publicItem(d.wardrobe?.item(id)) : null);
    return {
      condition: w.condition, mood: w.mood,
      accessories: ['hat', 'neck', 'face', 'held'].map(slot => pick(w[slot])).filter(Boolean),
      effect: pick(w.effect),
    };
  }

  // South of the equator, spring comes in September (wardrobe/seasons.js). Known
  // from the town picked for the weather, which is kept with the weather switched
  // off (no network needed for that); north otherwise, as it always was.
  const seasonsWhere = () => ({ south: weatherRules.isSouth(weatherRules.normalizePlace(d.config?.get('weather')?.place)) });

  const currentLevel = () => levelFor(d.config?.get('xp')?.total || 0).level;
  const homesView = () => shells.homesView(d.config.get('home'), currentLevel());

  function broadcastSkin() {
    const skin = activeSkin();
    const o = outfit();
    d.send(d.critter, 'critter:skin', { skin, px: d.px(), helperWidth: d.helperWidth(), outfit: o });
    d.send(d.panel, 'skin', { skin, outfit: o });
    d.floor?.reskin(); // his pals are his colours, his size
  }

  function dialogLook() {
    const o = outfit();
    return { skin: activeSkin(), accessories: o.accessories, shell: o.home };
  }

  function broadcastWardrobe() {
    broadcastSkin();
    if (d.wardrobe) d.send(d.panel, 'wardrobe', d.wardrobe.view());
  }

  function flashState(state, ms = 7000) {
    d.flash = { state, until: Date.now() + ms };
    // Every mood he already had, now with something to say. A trick he taught
    // himself and a new trophy are rare enough to jump the cooldowns; 'levelup'
    // and the molt have no lines at all, because the bubble is already busy
    // showing the level and the new shell.
    // A level-up has no line to chirp with, so its cheer goes on its own.
    if (!speak(state, { force: state === 'learned' || state === 'unlocked' })) chirp(state, { blip: false });
    if (state === 'success' || state === 'error') d.floor?.event(state); // his pals cheer, or wince
    refreshCritter();
    setTimeout(refreshCritter, ms + 50);
  }

  // ---- his voice

  // He reacts to what the work actually is, not just that work is happening: a
  // test run, a big write, the third visit to one file. The file tally is kept
  // here so voice.js stays pure.
  function onToolSpoken(item) {
    if (d.CAPTURE || !d.config) return;
    let touches = 0;
    if (item.filePath) {
      touches = (d.fileTouches.get(item.filePath) || 0) + 1;
      d.fileTouches.set(item.filePath, touches);
      if (d.fileTouches.size > 400) d.fileTouches.delete(d.fileTouches.keys().next().value);
    }
    const occasion = voice.occasionForTool(item.name, { command: item.detail, chars: item.writeChars || 0, touches });
    if (occasion) speak(occasion);
  }

  // Shellby says something, if he has something to say and this is the moment for
  // it (see voice.js for the cooldowns). Held back while he guards your focus,
  // exactly like a notification that can wait, and never during screenshots.
  function speak(occasion, { force = false, text = null } = {}) {
    if (d.CAPTURE || !d.config || !d.critter) return null;
    if (focus.guarding(d.config.get('focus'), Date.now())) return null;
    if (d.life?.hushed()) return null; // you're on a call: not a peep
    const now = Date.now();
    const worn = d.wardrobe ? d.wardrobe.dialogue().voice : null; // a pack voice (wardrobe/dialogue.js)
    const r = voice.say(d.config.get('voice'), occasion, now, { chatter: d.config.get('chatter'), force, text, voice: worn });
    if (!r) return null;
    d.config.set({ voice: r.state });
    d.said = { text: r.text, occasion: r.occasion, until: r.until };
    chirp(r.occasion);
    refreshCritter();
    setTimeout(refreshCritter, r.until - now + 50); // clear the bubble when it runs out
    return d.said;
  }

  // What he may sound like right now (see sounds.js): nothing at all while he's
  // on guard, on a call, or posing for screenshots.
  function soundMix() {
    if (d.CAPTURE || !d.config) return sounds.mix();
    const quiet = focus.guarding(d.config.get('focus'), Date.now()) || !!d.life?.hushed();
    return sounds.mix({
      sounds: d.config.get('sounds'), soundFx: d.config.get('soundFx'),
      ambient: d.config.get('ambient'), soundVolume: d.config.get('soundVolume'),
    }, { quiet });
  }

  // A little blip when he speaks, or a ta-da for a big moment, synthesized in the
  // renderer (no audio files). Both off by default. blip: false plays only a cheer.
  function chirp(occasion, { blip = true } = {}) {
    const m = soundMix();
    if (!sounds.anyOn(m)) return;
    const r = sounds.forOccasion(occasion, m);
    if (r.cue) d.send(d.critter, 'critter:sound', { cue: r.cue });
    else if (r.chirp && blip) d.send(d.critter, 'critter:chirp', { occasion });
  }

  // His seed (which decides his temperament) is made once, on first run. The gap
  // since he last ran is what tells him you've been away.
  function wakeVoice() {
    if (d.CAPTURE || !d.config) return;
    const now = Date.now();
    const state = voice.normalize(d.config.get('voice'));
    const seed = state.seed || d.randomUUID();
    d.config.set({ voice: { ...state, seed, lastRunAt: now } });
    const occasion = voice.absenceOccasion(state.lastRunAt, now) || voice.timeOccasion(now);
    if (occasion) setTimeout(() => speak(occasion, { force: true }), 2500); // let him settle onto the desktop first
    if (occasion === 'back') setTimeout(() => d.awayService.greet(now - state.lastRunAt), 2500);
  }

  const dressCrew = crew => (crew.length && d.crewRoster ? d.crewRoster.dress(crew) : crew);

  // Rolls every tab up into one mood: asking > working > flash > idle/sleeping.
  function refreshCritter() {
    if (!d.manager || !d.critter) return;
    const own = d.manager.aggregate;
    const ext = d.external?.summary || { state: 'idle', busy: 0, crew: [], background: [] };
    // Shellby's own tabs plus Claude Code sessions elsewhere: asking > working > idle.
    const agg = {
      state: own.state === 'asking' || ext.state === 'asking' ? 'asking' : own.state === 'working' || ext.state === 'working' ? 'working' : own.state,
      busy: own.busy + ext.busy,
      crew: [...own.crew, ...ext.crew],
      // Commands a turn backgrounded and walked away from (src/main/external.js).
      background: ext.background || [],
    };
    let state = agg.state;
    const limited = d.usageService.limitWait();
    if (state !== 'idle') d.lastActivity = Date.now();
    else if (d.flash && d.flash.until > Date.now()) state = d.flash.state;
    else if (limited && d.healthMood?.level !== 'critical') state = 'sleeping'; // naps until the limit resets
    else if (d.life?.napping() && d.healthMood?.level !== 'critical') state = 'sleeping'; // a nap of his own (life.js)
    else if (Date.now() - d.lastActivity > d.SLEEP_AFTER_MS && d.healthMood?.level !== 'critical') state = 'sleeping';

    if (d.said && d.said.until <= Date.now()) d.said = null;
    d.send(d.critter, 'critter:state', {
      state,
      busy: agg.busy,
      // Each helper as its crew member: name, level, colour and hat (wiring/crew.js).
      crew: dressCrew(agg.crew.slice(0, d.MAX_CREW_SHOWN)),
      moreCrew: Math.max(0, agg.crew.length - d.MAX_CREW_SHOWN),
      health: d.healthMood,
      level: d.levelUpAt,
      ci: { failing: d.ci?.view().failing || 0 },
      background: agg.background.length,
      // Dev servers: the "up :5173" pill and the sign when one crashed (devservers/service.js).
      servers: d.devServers && !d.config.get('crabOnly') ? d.devServers.summary() : null,
      focus: d.focusState(),
      limit: limited ? { resetsAt: limited.resetsAt } : null,
      say: d.said,
      call: !!d.life?.onCall(), // you're on a call: he holds up his "shh" sign
      sound: soundMix(), // footsteps, bumps and the background play off this (src/renderer/critter/sound.js)
      // Work mode: a celebration is his little hop, no confetti (workmode.js).
      confetti: workmode.behaviourOf(d.config).confetti,
      // Peckish, sandy, sleepy, mopey (needs.js): only ever while he has nothing better to show.
      needs: ['idle', 'sleeping'].includes(state) && !d.CAPTURE ? d.life?.needsLook() || null : null,
    });
    d.setCrewSlots(Math.min(agg.crew.length, d.MAX_CREW_SHOWN));
    const was = d.lastStatus;
    d.lastStatus = { state, busy: agg.busy, crew: agg.crew.length, background: agg.background.length };
    refreshStatusLine();
    // Whatever the crab is doing, the stream and the desk lighting follow it.
    d.obsServer?.broadcast(d.obsState());
    d.paintLights();

    // Remarks that belong to a change, not a state. lastStatus is already updated,
    // so the refresh that speaking triggers can't fire these a second time.
    if (agg.crew.length >= d.CREW_WORTH_MENTIONING) speak('crew');
    // Work (or a question) takes him off whatever he was doing on his own.
    if ((state === 'working' || state === 'asking') && was.state !== state) {
      d.life?.cancel();
      d.life?.wake();
      if (d.playtime?.busy()) d.playtime.stop('work time!');
    }
    if (state === 'working' && was.state !== 'working') {
      speak('working');
      // Armed when the task starts, never re-armed: a busy task refreshes this
      // many times a second, and resetting the clock here would mean the one
      // remark meant for a long task could only ever fire for a silent one.
      clearTimeout(d.longTaskTimer);
      d.longTaskTimer = setTimeout(() => { if (d.lastStatus.state === 'working') speak('longTask'); }, d.LONG_TASK_MS);
    } else if (state !== 'working' && was.state === 'working') {
      clearTimeout(d.longTaskTimer);
    }

    clearTimeout(d.sleepTimer);
    if (state === 'idle') d.sleepTimer = setTimeout(refreshCritter, d.SLEEP_AFTER_MS - (Date.now() - d.lastActivity) + 100);
    const tip = agg.busy ? `Shellby: ${agg.busy} task${agg.busy > 1 ? 's' : ''} running` : 'Shellby';
    d.tray?.setToolTip(d.healthMood ? `${tip} · ${HEALTH_TIP[d.healthMood.mood]} (${d.healthMood.text})` : tip);
  }

  const HEALTH_TIP = { hot: 'running hot', scorching: 'overheating', dizzy: 'memory nearly full', stuffed: 'drive nearly full' };

  // Shellby's face in Claude Code's status line (see statusline.js).
  function refreshStatusLine() {
    if (d.CAPTURE || !d.config) return;
    const v = d.xpView();
    const s = {
      ...d.lastStatus, health: d.healthMood, xp: { level: v.level, title: v.title, progress: v.progress }, lastXp: d.lastXp, now: Date.now(),
      streak: streaks.streakOf(d.config.get('streaks'), Date.now()).current,
      ci: d.ci?.view().failing || 0,
      focus: d.focusState(),
      limit: d.usageService.limitWait(),
    };
    statusLine.writeStatus(statusLine.formatStatus(s), d.statusFile(), statusLine.formatPlain(s));
  }

  function wake() {
    d.lastActivity = Date.now();
    d.life?.wake(); // ends a nap of his own too (life.js)
    refreshCritter();
  }

  return {
    HEALTH_TIP, activeSkin, allSkins, broadcastSkin, broadcastWardrobe, chirp, currentLevel,
    dialogLook, flashState, homesView, onToolSpoken, outfit, refreshCritter, refreshStatusLine,
    seasonsWhere, soundMix, speak, wake, wakeVoice,
  };
}

module.exports = { wireCritter };
