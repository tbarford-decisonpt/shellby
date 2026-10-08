// His life when there's no task: the part of Shellby that doesn't need Claude.
// Keeps him awake while you're at your PC (and lets him nap now and then), notices
// your day (a game you just finished, a call, a long afternoon in Excel, Friday),
// plays his little scenes, turns his digging into gifts, remembers the two of
// you, follows your cursor with his eyes, and does the talking when a friend's
// crab visits.
//
// The rules all live in pure modules (surroundings, scenes, gifts, bond, banter);
// this wires them to the clock, the screen and his window through `deps`, which
// main.js provides, so it holds no Electron objects of its own.

const surroundings = require('./surroundings');
const scenes = require('./scenes');
const gifts = require('./gifts');
const bond = require('./bond');
const banter = require('./banter');
const voice = require('./voice');
const { createCare } = require('./care');

const SECOND = 1000;
const MINUTE = 60 * SECOND;

const WATCH_MS = 15 * SECOND;       // what's in front, the day, the special days
const TANK_REMARK_GAP = 47 * 60 * SECOND; // how often he even thinks of mentioning his tank
const MIC_MS = 20 * SECOND;         // who has the microphone (a `reg query`)
const LOOK_MS = 280;                // where your cursor is, for his eyes
const HERE_IDLE_S = 90;             // input within this long: you're at your PC, so he's awake
const SCENE_EVERY = { normal: 6 * MINUTE, chatty: 2.5 * MINUTE };
const SCENE_CHANCE = 0.45;          // of an idle habit, once a scene is due, being a scene instead
const RECALL_CHANCE = 0.12;         // of an idle habit bringing up a memory
const NAP_CHECK_MS = 12 * MINUTE;
const NAP_MS = [3 * MINUTE, 6 * MINUTE];
const PRESENT_MS = 2800;            // holding up a find
const DIG_MS = 2600;                // voice.js BITS run this long (critter.js BIT_MS)
const CLUMSY_MS = 1700;             // a trip or a stuck claw, before he owns up to it
const NEAR_PX = 380;                // the cursor counts as "near him" within this
const MIC_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';

// What his claw holds for a scene that isn't a find. The renderer draws these
// from its own art (src/renderer/critter/life.js), so only the name goes over.
const BOND_LINES = Object.freeze(['', "we're pals now!", "we're buddies now!", "we're close friends now!", "we're best friends now!", "we're inseparable now!"]);

function createLife(d) {
  const now = () => d.now?.() ?? Date.now();
  let watchTimer = null, micTimer = null, lookTimer = null;
  let track = surroundings.emptyState();
  let micBusy = false;
  let onCall = false;
  let forcedCall = null;          // dev/e2e: pretend you're on a call (or aren't)
  let playing = false;
  let scene = null;              // { id, timers } while a scene plays
  let presenting = null;         // a find being held up
  let presentDone = null;        // ...and what happens when he puts it down
  let lastSceneAt = now();
  const recent = [];             // scene ids, newest last
  let napUntil = 0;
  let lastNapCheck = now();
  let lastPetAt = 0;             // no nodding off straight after a fuss
  let look = { x: 0, y: 0, near: false };
  let lookSent = '';
  let lastDay = null;
  let visitTimers = [];
  // One-off moments queued for a little later (a find after a dig, a keepsake,
  // a line once the desktop is back). cancel() and stop() drop them all.
  const pending = new Set();
  const later = (ms, fn) => { const t = setTimeout(() => { pending.delete(t); fn(); }, ms); pending.add(t); return t; };
  const dropPending = () => { pending.forEach(clearTimeout); pending.clear(); };
  // Free for something of his own: not busy, not in a game, not in your hand.
  const free = () => d.isIdle() && !onCall && !scene && !presenting && !d.playing?.();
  let visitUsed = [];

  // ---------------------------------------------------------------- state on disk
  const getBond = () => bond.normalize(d.config.get('bond'));
  const setBond = s => d.config.set({ bond: s });
  const getFinds = () => gifts.normalize(d.config.get('finds'));
  const setFinds = s => d.config.set({ finds: s });
  const getSeen = () => {
    const v = d.config.get('scenesSeen');
    return Array.isArray(v) ? v.filter(id => scenes.SCENES.some(s => s.id === id)) : [];
  };
  const temperament = () => d.temperament();
  // His scenes plus any from wardrobe packs, in the voice he's wearing (scenes.inVoice).
  const repertoire = () => { const g = d.dialogue?.() || {}; return scenes.inVoice(g.scenes, g.voice); };
  const chatter = () => voice.chatterOf(d.config.get('chatter'));
  const app = exe => surroundings.niceName(exe) || null;
  const changed = () => d.toPanel('life', view());

  // His needs (care.js, needs.js), played through the same scene slot as
  // everything else, so a drag or a task cuts a munch short like any scene.
  function perform(id, ms, steps) {
    cancel();
    const timers = steps.map(s => setTimeout(s.run, s.at));
    timers.push(setTimeout(() => { scene = null; clearProps(); }, ms + 150));
    scene = { id, timers };
  }
  function napFor(ms) {
    if (!free() || napUntil >= now() + ms) return; // busy, or already down for longer
    cancel();
    napUntil = now() + ms;
    d.refresh();
    later(ms + 100, () => { if (!napping()) d.touch(); d.refresh(); });
  }
  const care = createCare(d, {
    now, later, free, perform, napFor, napping: () => napping(), wake: () => wake(),
    grow: kind => grow(kind), remember: (kind, data) => remember(kind, data), changed: () => changed(),
  });

  // ---------------------------------------------------------------- the bond grows
  function grow(kind) {
    const r = bond.earn(getBond(), kind, now());
    if (!r.gained && !r.milestone) { if (r.state) setBond(r.state); return r; }
    setBond(r.state);
    if (r.levelUp) {
      d.stat('bond-level', { n: r.levelUp.index });
      d.awardXp('bond', { label: `You and Shellby: ${r.levelUp.name}` });
      celebrate(BOND_LINES[r.levelUp.index], { eyebrow: 'Closer', icon: r.levelUp.icon, title: r.levelUp.name, text: bond.UNLOCKS.find(u => u.level === r.levelUp.index)?.text || '' });
      care.earn('bond-up'); // a golden plankton to mark it
    }
    if (r.milestone) celebrate(bond.celebrationLine('days', { days: r.milestone }), { eyebrow: 'Together', icon: '🗓️', title: `${r.milestone} days together`, text: 'He counts. Every one of them.' });
    changed();
    return r;
  }

  function remember(kind, data) {
    const r = bond.remember(getBond(), kind, now(), data);
    if (r.added) { setBond(r.state); changed(); }
    return r.added;
  }

  // A moment worth a fuss: his line, confetti, and the panel's celebration card.
  function celebrate(line, card) {
    if (line) d.speak('milestone', { force: true, text: line.length <= voice.MAX_LINE ? line : null });
    d.burst();
    if (card) d.toPanel('life:moment', card);
  }

  // ---------------------------------------------------------------- awake while you're here
  // He used to nod off three minutes after the last task, even with you right
  // there. Now your own keyboard and mouse keep him up, and he still naps when
  // you step away (or, now and then, because he felt like it).
  function hereCheck() {
    const idleS = d.systemIdleSeconds();
    if (idleS == null) return;
    if (idleS < HERE_IDLE_S && !napping()) d.touch();
  }

  function napping() { return napUntil > now(); }

  function maybeNap() {
    const t = now();
    if (t - lastNapCheck < NAP_CHECK_MS || t - lastPetAt < 5 * MINUTE || napping() || !free()) return;
    lastNapCheck = t;
    const h = new Date(t).getHours();
    const sleepy = temperament() === 'sleepy' ? 2.2 : 1;
    const drowsy = (h >= 13 && h < 16) || h >= 23 || h < 5 ? 1.6 : 1;
    if (Math.random() > 0.1 * sleepy * drowsy * care.napChance()) return;
    napUntil = t + NAP_MS[0] + Math.random() * (NAP_MS[1] - NAP_MS[0]);
    cancel();
    d.refresh();
    // Up again: as if you'd just moved the mouse, so he doesn't drift straight back off.
    later(napUntil - t + 100, () => { if (!napping()) d.touch(); d.refresh(); });
  }

  // Something needs him (a click, a drag, a task, a pet): the nap's over.
  function wake() {
    if (!napping()) return;
    napUntil = 0;
    d.touch();
    d.refresh();
  }

  // ---------------------------------------------------------------- your day
  function sample() {
    if (!d.native?.available?.()) return { kind: null, exe: '', micBusy };
    const info = d.native.describe(d.native.foreground());
    if (!info) return { kind: null, exe: '', micBusy };
    const own = (d.ownPids?.() || []).includes(info.pid);
    const fullscreen = d.native.notificationState() === d.native.QUNS.D3D_FULL_SCREEN;
    return { kind: own ? null : surroundings.kindOfApp({ exe: info.exe, path: info.path, fullscreen }), exe: info.exe, micBusy };
  }

  function watch() {
    if (!d.enabled()) return;
    hereCheck();
    care.tick();
    const r = surroundings.track(track, sample(), now());
    track = r.state;
    playing = r.playing;
    setCall(forcedCall ?? r.onCall);
    for (const e of r.events) onEvent(e);
    // What kind of day it is: Friday afternoon, the weekend, Monday morning.
    const day = surroundings.dayOccasion(new Date(now()));
    if (day && d.isIdle() && !onCall) d.speak(day);
    else if (d.tankRemark && d.isIdle() && !onCall) tankRemark();
    newDay();
    maybeNap();
    jarIfFree();
  }

  // Now and then a word about his tank (tank-life.js remark). The voice's own
  // cooldown for 'tank' keeps it rare and the chatter setting applies; the
  // check here is only a time stamp until that cooldown could be over.
  let tankAfter = 0;
  function tankRemark() {
    const t = now();
    if (t < tankAfter) return;
    tankAfter = t + TANK_REMARK_GAP;
    const text = d.tankRemark();
    if (text) d.speak('tank', { text });
  }

  function setCall(on) {
    if (on === onCall) return;
    onCall = on;
    if (onCall) { cancel(); d.leavePerch?.(); }
    d.refresh();
  }

  function onEvent(e) {
    if (e.type === 'gameOver') {
      d.stat('game-watched');
      const name = app(e.exe);
      if (!getBond().journal.some(j => j.kind === 'game' && j.data.app === name)) remember('game', name ? { app: name } : {});
      // Once per game, so it gets past the gap after his last line (quiet, focus and calls still win).
      later(3000, () => d.speak('gameOver', { force: true })); // let the desktop come back first
    }
    if (e.type === 'callOver') {
      d.stat('call-hushed');
      remember('first-call');
      later(2500, () => d.speak('callOver', { force: true }));
    }
    if (e.type === 'stretch') d.speak(surroundings.occasionFor(e), { force: true }); // once per stretch
  }

  async function micCheck() {
    if (!d.enabled() || !d.readMic || d.calm()) return; // locked: nobody's on a call at this desk
    try {
      const out = await d.readMic(MIC_KEY);
      micBusy = surroundings.micUsers(out, { own: d.ownExes?.() || [], now: now(), bootAt: d.bootAt?.() ?? null }).length > 0;
    } catch { micBusy = false; }
  }

  // Once a day: count it, and see whether it's a day worth marking.
  function newDay() {
    const t = now();
    const key = new Date(t).toDateString();
    if (key === lastDay || !d.isIdle() || onCall || d.guarding()) return;
    lastDay = key;
    grow('day');
    care.earn('new-day'); // a couple of plankton to say good morning
    const special = bond.specialDay(getBond(), t);
    if (!special) return;
    const years = special === 'hatchday' ? new Date(t).getFullYear() - new Date(getBond().hatchedAt).getFullYear() : 0;
    setBond(bond.celebrate(getBond(), special, t));
    const kept = gifts.keepsake(getFinds(), special, t);
    if (kept.find) setFinds(kept.state);
    celebrate(bond.celebrationLine(special, { years }), special === 'birthday'
      ? { eyebrow: 'Happy birthday', icon: '🎂', title: 'Happy birthday!', text: 'He dug you up something special. It\'s on the shelf.', find: kept.find && findCard(kept.find) }
      : { eyebrow: 'Hatch day', icon: '🕯️', title: years > 1 ? `${years} years together` : 'One year together', text: 'A year ago today he moved onto your desktop.', find: kept.find && findCard(kept.find) });
    if (kept.find) later(3500, () => { if (free()) present(kept.find, null); });
    changed();
  }

  // ---------------------------------------------------------------- his eyes on your cursor
  function lookTick() {
    if (!d.enabled() || d.calm()) return;
    const eye = d.eyePoint();
    if (!eye) return;
    const p = d.cursor();
    const dx = p.x - eye.x, dy = p.y - eye.y;
    const dist = Math.hypot(dx, dy);
    look = {
      x: Math.abs(dx) < 30 ? 0 : Math.sign(dx),
      y: dy < -70 ? -1 : dy > 50 ? 1 : 0,
      near: dist < NEAR_PX,
    };
    const key = `${look.x},${look.y},${look.near}`;
    if (key === lookSent) return;
    lookSent = key;
    d.toCrab('critter:look', look);
  }

  // ---------------------------------------------------------------- scenes and habits
  function context() {
    const t = new Date(now());
    return {
      temperament: temperament(), hour: t.getHours(), weekday: t.getDay(),
      dayOccasion: surroundings.dayOccasion(t), music: !!d.music(), cursorNear: look.near,
      hasFind: !!gifts.favourite(getFinds()), bond: bond.levelFor(getBond().points).index, seasons: d.seasons(),
    };
  }

  /**
   * An idle moment (main.js's idle loop decided he's free and it's habit time).
   * Plays a scene if one is due, else one of his everyday habits; a dig might
   * turn up a gift, and now and then he brings up a memory.
   */
  function idleBit() {
    if (scene || presenting || onCall || napping()) return true;
    const level = chatter();
    if (!voice.hasHabits(level)) return false; // quiet, or just about work
    const t = now();
    if (t - lastSceneAt >= (SCENE_EVERY[level] || SCENE_EVERY.normal) && Math.random() < SCENE_CHANCE) {
      const s = scenes.pickScene(context(), recent, Math.random, repertoire().list);
      if (s) { play(s); return true; }
    }
    if (care.idleBit()) return true; // peckish, sandy, sleepy or mopey: it shows
    const bit = voice.pickBit(voice.normalize(d.config.get('voice')).seed);
    d.toCrab('critter:bit', { bit });
    if (bit === 'dig') later(DIG_MS, () => dug());
    // A trip or a stuck claw gets a sheepish word once he's picked himself up.
    if (voice.CLUMSY_BITS.includes(bit)) { later(CLUMSY_MS, () => d.speak('oops')); return true; }
    if (Math.random() < RECALL_CHANCE && recallMemory()) return true;
    d.speak('idle');
    return true;
  }

  function recallMemory() {
    const r = bond.recall(getBond(), now(), Math.random, { throws: d.throws() });
    if (!r) return false;
    const spoken = d.speak('memory', { text: r.text });
    // Only told if he actually said it (a voice in another language says its own line).
    if (spoken?.text === r.text) setBond(r.state);
    return !!spoken;
  }

  function play(s, { force = false } = {}) {
    cancel();
    const beats = scenes.resolve(s, temperament(), Math.random, { silent: repertoire().silent(s) });
    const timers = [];
    let at = 0;
    for (const b of beats) {
      timers.push(setTimeout(() => {
        if (!force && (!d.isIdle() || onCall)) return cancel();
        d.toCrab('critter:bit', { bit: b.bit, ms: b.ms + 120, dir: look.x || null });
        d.toCrab('critter:prop', { prop: b.prop, ms: b.ms });
        d.toCrab('critter:hold', holdFor(b.hold));
        d.toCrab('critter:wear', { item: b.wear });
        if (b.say) d.say(b.say, b.ms + 400, 'scene');
      }, at));
      at += b.ms;
    }
    timers.push(setTimeout(() => { scene = null; clearProps(); }, at + 150));
    scene = { id: s.id, timers };
    lastSceneAt = now();
    recent.push(s.id);
    while (recent.length > 4) recent.shift();
    const seen = getSeen();
    // Only his own scenes count toward the Us page and Storyteller: a pack can't hand those out.
    if (scenes.SCENES.includes(s) && !seen.includes(s.id)) {
      d.config.set({ scenesSeen: [...seen, s.id] });
      d.stat('scenes-seen', { n: seen.length + 1 });
      changed();
    }
    return s.id;
  }

  function holdFor(hold) {
    if (hold === 'find') {
      const f = gifts.favourite(getFinds());
      return f ? { pixels: f.pixels, palette: f.palette } : null;
    }
    return hold ? { item: hold } : null;
  }

  function clearProps() {
    d.toCrab('critter:prop', { prop: null });
    d.toCrab('critter:hold', null);
    d.toCrab('critter:wear', { item: null });
  }

  /** Something else needs him (a task, a drag, a throw, a perch): drop what he's doing. */
  function cancel() {
    dropPending();
    if (presentDone) {
      presentDone();
      d.toCrab('critter:bit', { bit: 'none', ms: 800 });
    }
    if (scene) {
      scene.timers.forEach(clearTimeout);
      scene = null;
      d.toCrab('critter:bit', { bit: 'none', ms: 800 });
    }
    clearProps();
  }

  // ---------------------------------------------------------------- gifts
  function dug({ manual = false } = {}) {
    if (!manual && !free()) return null;
    care.wear('dig'); // sand in places sand shouldn't be
    const t = now();
    const tide = d.tide?.() || {};
    const r = gifts.dig(getFinds(), { seasons: d.seasons(), night: isNight(t), manual, event: tide.event || null, digBoost: tide.digBoost, shinyBoost: tide.shinyBoost }, t);
    if (r.shiny) r.odds = Math.round(1 / (gifts.SPARKLE_CHANCE * Math.max(1, Math.min(4, tide.shinyBoost || 1))));
    setFinds(r.state);
    if (!r.find) { if (manual) changed(); return null; }
    present(r.find, r);
    return r.find;
  }

  const isNight = t => { const h = new Date(t).getHours(); return h >= 20 || h < 6; };

  // A bug Claude fixed, in a jar (bugdex.js): he lunges, corks it and holds it
  // up. Catches land while he's working, so one waits until he's free; a newer
  // one replaces it, and it goes stale after JAR_WAIT_MS.
  let jarWaiting = null;
  const JAR_MS = 2600;
  const JAR_WAIT_MS = 10 * MINUTE;
  function presentJar(card) {
    if (!card?.pixels || !card.palette) return;
    jarWaiting = { ...card, at: now() };
    jarIfFree();
  }
  let jarRetry = null;
  const JAR_RETRY_MS = 3000;
  function jarIfFree() {
    clearTimeout(jarRetry);
    if (!jarWaiting) return;
    if (now() - jarWaiting.at > JAR_WAIT_MS) { jarWaiting = null; return; }
    // Busy (a scene, a dig, a task): look again shortly, rather than at the next idle tick.
    if (!free() || napping()) { jarRetry = setTimeout(jarIfFree, JAR_RETRY_MS); return; }
    const j = jarWaiting;
    jarWaiting = null;
    presenting = `jar:${j.species}`;
    d.toCrab('critter:bit', { bit: 'catch', ms: JAR_MS });
    d.toCrab('critter:prop', { prop: 'jar', ms: JAR_MS, ghost: !!j.ghost });
    later(700, () => d.toCrab('critter:hold', { pixels: j.pixels, palette: j.palette }));
    if (j.line) d.speak('found', { force: true, text: j.line });
    // Its cry as the cork goes on (critter/sound.js CUES.cry).
    if (j.cry) later(900, () => d.toCrab('critter:sound', { cue: 'cry', ...j.cry }));
    presentDone = () => {
      presentDone = null;
      presenting = null;
      d.toCrab('critter:hold', null);
      d.toCrab('critter:prop', { prop: null });
    };
    later(PRESENT_MS + 700, () => presentDone?.());
  }

  function present(find, r) {
    presenting = find.id;
    const shiny = !!r?.shiny;
    // A sparkly one: held up in its own colours, a longer glint and a chime, and his loudest line.
    const look = shiny ? gifts.sparkly(find) : find;
    const ms = shiny ? PRESENT_MS + 1800 : PRESENT_MS;
    d.toCrab('critter:bit', { bit: 'present', ms });
    d.toCrab('critter:hold', { pixels: look.pixels, palette: look.palette, shiny });
    const rare = find.rarity === 'rare' || find.rarity === 'legendary';
    if (rare || shiny) d.toCrab('critter:prop', { prop: 'sparkle', ms, big: shiny });
    if (shiny) d.toCrab('critter:sound', { cue: 'sparkle' });
    d.speak('found', { force: true, text: shiny ? '✨ a SPARKLY one!!' : gifts.foundLine(find) });
    // A trophy it earns has a line of its own: after he's shown you the find, not over it.
    // Cut short (cancel()), it still counts, straight away.
    presentDone = () => {
      presentDone = null;
      presenting = null;
      d.toCrab('critter:hold', null);
      d.toCrab('critter:prop', { prop: null });
      if (r) credit(find, r);
    };
    later(ms, () => presentDone?.());
    if (r) d.toPanel('life:found', { ...findCard(find), isNew: r.isNew, shiny });
    if (r && shiny) {
      d.toPanel('sparkle:reveal', {
        kind: 'find', id: find.id, name: find.name, rarity: find.rarity, pixels: look.pixels, palette: look.palette,
        odds: r.odds || Math.round(1 / gifts.SPARKLE_CHANCE), after: Math.max(0, gifts.total(r.state) - 1), at: now(), level: d.level?.() || 1,
        first: !!r.firstShiny,
      });
    }
  }

  // The find counts: a stat (trophies), XP, the bond, the story, any set it finished.
  function credit(find, r) {
    const rare = find.rarity === 'rare' || find.rarity === 'legendary';
    // What the tide events' goals look at (events.js): which find, and whether it was the event's own.
    d.stat('find-made', { id: find.id, event: find.event });
    d.awardXp(rare ? 'treasure' : 'find', { label: `He found you a ${find.name.toLowerCase()}` });
    if (r.shiny) {
      d.stat('sparkle-found');
      if (find.rarity === 'legendary') d.stat('sparkle-legendary');
      d.awardXp('sparkle', { label: `A sparkly ${find.name.toLowerCase()}` });
      remember('first-shiny', { item: find.name });
    }
    grow('find');
    const bondNow = getBond();
    if (!bondNow.journal.some(e => e.kind === 'first-find')) remember('first-find', { item: find.name });
    else if (rare && r.isNew) remember('rare-find', { item: find.name });
    if (find.rarity === 'legendary') { d.stat('legendary-find'); d.burst(); }
    for (const setId of r.completed) {
      const set = gifts.SETS.find(s => s.id === setId);
      d.stat('set-completed');
      d.awardXp('treasure', { label: `Completed the ${set.name} set` });
      remember('set-done', { set: set.name });
      d.burst();
      d.toPanel('life:moment', { eyebrow: 'Set complete', icon: set.icon, title: set.name, text: 'Every one of them, on the shelf.' });
    }
    changed();
  }

  const findCard = f => ({ id: f.id, name: f.name, rarity: f.rarity, rarityLabel: gifts.RARITY[f.rarity].label, blurb: f.blurb, pixels: f.pixels, palette: f.palette });

  /** "Dig for treasure" from his menu: a proper dig, then whatever he finds. */
  function digNow() {
    if (!gifts.canDig(getFinds(), now()) || presenting) return false;
    cancel();
    d.toCrab('critter:bit', { bit: 'dig', ms: DIG_MS + 400 });
    d.say('digging…', DIG_MS, 'scene');
    later(DIG_MS + 200, () => { if (!onCall && !d.playing?.() && !d.working?.()) dug({ manual: true }); });
    return true;
  }

  function digMenuItem() {
    const s = getFinds();
    if (gifts.canDig(s, now())) return { label: 'Dig for treasure', click: digNow };
    const mins = Math.max(1, Math.ceil((gifts.nextDigAt(s) - now()) / MINUTE));
    return { label: `Dig for treasure (in ${mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`})`, enabled: false };
  }

  // ---------------------------------------------------------------- what happened elsewhere
  function onPet() {
    wake();
    lastPetAt = now();
    remember('first-pet');
    care.attend('pet');
    const r = grow('pet');
    if (r.gained) d.awardXp('pet');
  }

  function onStat(event, payload = {}) {
    care.onStat(event, payload); // wear and snacks (care.js)
    if (event === 'thrown') remember('first-throw');
    if (event === 'perched' && payload.exe) remember('first-perch', { app: app(payload.exe) || 'a window' });
    if (event === 'shaken') {
      const name = app(payload.exe);
      const week = now() - 7 * 24 * 60 * MINUTE;
      if (!getBond().journal.some(e => e.kind === 'shaken' && e.data.app === name && e.at > week)) remember('shaken', name ? { app: name } : {});
    }
    if (event === 'ride' && payload.n >= 300) {
      grow('ride');
      const best = Math.max(0, ...getBond().journal.filter(e => e.kind === 'big-ride').map(e => e.data.px || 0));
      if (payload.n >= 1500 && payload.n > best) remember('big-ride', { app: app(payload.exe) || 'a window', px: payload.n });
    }
  }

  /** A game ended (playtime.js). */
  function played(kind, data = {}) {
    care.attend('play');
    care.wear('game');
    const r = grow('play');
    if (r.gained || kind) d.awardXp('play', { label: { hide: 'Played hide and seek', fetch: 'Played fetch' }[kind] || 'Played a game' });
    if (kind === 'hide' && data.foundMs != null && data.best) remember('hide-found', { ms: data.foundMs });
    if (kind === 'hide' && data.foundMs == null) remember('hide-won');
    if (kind === 'fetch') remember('first-fetch');
    changed();
  }

  // ---------------------------------------------------------------- a friend's crab, talking
  /**
   * A visit started (v) or ended (null). The two of them say hello, chat between
   * the things they do together, and say goodbye before the visitor walks off.
   *   v: { login, card, until, signed }; ctx: what there is to talk about
   */
  function visit(v, { visitMs, togetherAt = [], myCard = {} } = {}) {
    visitTimers.forEach(clearTimeout);
    visitTimers = [];
    if (!v) return;
    visitUsed = [];
    const who = { me: temperament(), them: v.card?.temperament };
    const first = !getBond().journal.some(e => e.kind === 'visitor' && e.data.login === v.login);
    if (v.signed) {
      grow('visit');
      if (first) remember('visitor', { login: v.login });
    }
    const ctxFor = () => ({
      firstVisit: first, myStickers: myCard.stickers?.length || 0, theirStickers: v.card?.stickers?.length || 0,
      myLevel: myCard.level || 1, theirLevel: v.card?.level || 1,
      myFind: gifts.favourite(getFinds())?.name || null, theirFind: gifts.findById(v.card?.find)?.name || null,
      music: !!d.music(), hour: new Date(now()).getHours(), seasons: d.seasons(),
    });
    const talk = (at, phase) => visitTimers.push(setTimeout(() => {
      // Only work, a call or your focus stops them: a trophy going off mid-visit doesn't.
      if (d.working() || onCall || d.guarding() || chatter() === 'quiet') return;
      const lines = banter.conversation(phase, who, ctxFor(), Math.random, visitUsed);
      if (!lines.length) return;
      if (phase === 'chat') visitUsed.push(lines[0].text);
      let t = 0;
      for (const l of lines) {
        const ms = banter.lineMs(l.text);
        visitTimers.push(setTimeout(() => {
          if (l.who === 'me') d.say(l.text, ms, 'banter');
          else d.toCrab('critter:visitor-say', { text: l.text, ms });
        }, t));
        t += ms + 250;
      }
      if (phase === 'chat') { d.stat('banter'); grow('banter'); }
    }, at));
    talk(4500, 'hello'); // after his "@friend dropped by!"
    // Chat in the gaps between the things they do together.
    const gaps = togetherAt.map(t => t + 6500).filter(t => t < visitMs - 20000);
    for (const t of gaps.slice(0, 3)) talk(t, 'chat');
    talk(visitMs - 9000, 'bye');
  }

  // ---------------------------------------------------------------- the Us and Finds pages
  function view() {
    const t = temperament();
    const seen = getSeen();
    return {
      temperament: { id: t, ...voice.TEMPERAMENT_INFO[t] },
      bond: bond.view(getBond(), now()),
      finds: gifts.view(getFinds(), now(), { seasons: d.seasons(), ...(d.tideShelf?.() || {}) }),
      play: d.playView?.() || null,
      needs: care.view(),
      scenes: { seen: seen.length, of: scenes.SCENES.length, list: scenes.SCENES.map(s => ({ id: s.id, name: seen.includes(s.id) ? s.name : null })) },
      onCall, playing,
    };
  }

  function setBirthday(bd) { setBond(bond.setBirthday(getBond(), bd)); lastDay = null; changed(); return view(); }
  function setFavourite(id) { setFinds(gifts.setFavourite(getFinds(), id)); changed(); return view(); }
  function findsSeen() { setFinds(gifts.markSeen(getFinds())); changed(); }

  // ---------------------------------------------------------------- start and stop
  function start() {
    stop();
    // He moved in on your first day with Shellby, not the day this shipped.
    setBond(bond.hatch(getBond(), now(), { since: d.firstDay?.() || null }));
    watchTimer = setInterval(() => { try { watch(); } catch (e) { d.log?.(`life watch: ${e.message}`); } }, WATCH_MS);
    micTimer = setInterval(() => micCheck(), MIC_MS);
    lookTimer = setInterval(() => { try { lookTick(); } catch { /* the screen went away */ } }, LOOK_MS);
    later(5000, () => { try { watch(); } catch { /* next tick */ } });
    micCheck();
  }

  function stop() {
    clearInterval(watchTimer); clearInterval(micTimer); clearInterval(lookTimer);
    watchTimer = micTimer = lookTimer = null;
    clearTimeout(jarRetry);
    jarWaiting = null;
    cancel();
    care.flush();
  }

  return {
    start, stop, idleBit, cancel, onPet, onStat, played, visit, digNow, digMenuItem, view, setBirthday, setFavourite, findsSeen,
    presentJar, jarIfFree,
    remember: (kind, data) => remember(kind, data), // a moment for the journal (bond.js MEMORIES)
    hushed: () => onCall, onCall: () => onCall, playing: () => playing, napping, wake,
    busy: () => !!scene || !!presenting,
    lookNow: () => look,
    // His needs (care.js): what the crab shows, his menu, the Us page's buttons.
    needsLook: () => care.look(),
    needsMenu: () => care.menu(),
    mopey: () => care.mopey(),
    feed: kind => care.feed(kind),
    rinse: () => care.rinse(),
    tuckIn: () => care.tuckIn(),
    needsSwitched: isOn => care.switched(isOn),
    workModeSwitched: () => care.restSwitched(),
    needsIntroSeen: () => care.seenIntro(),
    needsForTest: patch => care.setForTest(patch),
    // The crab's page (re)loaded: send where he's looking on the next tick even if
    // it hasn't changed, since a still cursor would otherwise never send it again.
    resendLook: () => { lookSent = ''; },
    // dev/e2e
    playScene: id => { const s = repertoire().list.find(x => x.id === id); return s ? play(s, { force: true }) : null; },
    dig: dug,
    event: onEvent,
    newDayForTest: () => { lastDay = null; newDay(); },
    callForTest: on => { forcedCall = on == null ? null : !!on; setCall(!!on); },
  };
}

module.exports = { createLife, MIC_KEY };
