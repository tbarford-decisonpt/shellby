// Looking after him: snacks, a rinse, a tuck-in, and how his needs show on the
// desktop. The rules are in needs.js (pure, tested); this keeps the state, ticks
// it with life.js's watch loop, turns the things you do into snacks, and plays
// the little feeding, rinsing and bedtime moments.
//
// It never nags: no toasts, no notifications. He shows it in how he looks, and
// says a needy word at most every 45 minutes (needs.js NEEDY_GAP), through the
// same voice gates as everything else he says (quiet, focus, calls).
//
// life.js creates it and hands it `h`, the bits of his life it needs: the scene
// slot (so a drag or a task cuts a munch short like any scene), the bond and
// the journal, and naps.

const needs = require('./needs');

const MINUTE = 60 * 1000;
const SAVE_EVERY = 5 * MINUTE;        // settings.json is written synchronously; not every 15 s tick
const HERE_IDLE_S = 90;               // life.js HERE_IDLE_S: input this recent means you're at the PC
const NEED_BIT_CHANCE = 0.35;         // of an idle habit being his need showing instead
const TUCK_NAP_MS = 4 * MINUTE;
// What he does with himself when a need shows (critter.css body.bit-*).
const NEED_BITS = Object.freeze({ peckish: 'rub', sandy: 'scratch', sleepy: 'yawn', mopey: 'mope' });
// Stat events (main.js stat()) that take something out of him.
const STAT_WEAR = Object.freeze({ thrown: 'thrown', shaken: 'shaken', 'task-completed': 'task', 'focus-completed': 'focus' });
const RIDE_PX = 300;                  // a ride shorter than this is just a nudge

function createCare(d, h) {
  let state = null;
  let savedAt = 0;
  let lookSent = '';

  const on = () => d.config.get('needsOn') !== false;
  const crabOnly = () => !!d.config.get('crabOnly');
  const get = () => (state ??= needs.normalize(d.config.get('needs')));
  function set(next, { save = false } = {}) {
    state = next;
    if (save || h.now() - savedAt >= SAVE_EVERY) flush();
  }
  function flush() {
    if (!state) return;
    d.config.set({ needs: state });
    savedAt = h.now();
  }

  /** { mood, low } for critter:state, or null when needs are off. */
  const look = () => (on() ? needs.mood(get()) : null);
  // His look only changes the critter when the mood or a low meter does.
  function lookChanged() {
    const key = JSON.stringify(look());
    if (key === lookSent) return;
    lookSent = key;
    d.refresh();
  }

  // ---------------------------------------------------------------- time passing
  // You're at the PC: recent input, and the screen isn't locked.
  const present = () => { const idleS = d.systemIdleSeconds(); return idleS != null && idleS < HERE_IDLE_S && !d.calm(); };

  /** life.js watch(), every 15 s. */
  function tick() {
    if (!on()) return;
    const here = present();
    const r = needs.tick(get(), h.now(), { present: here, napping: h.napping() });
    let next = r.state;
    if (r.back) h.later(3000, () => d.speak('cheered'));
    if (here) {
      const t = needs.tide(next, h.now());
      if (t.snack) { next = t.state; set(next, { save: true }); h.changed(); return void moment('tide'); }
    }
    set(next);
    lookChanged();
  }

  // ---------------------------------------------------------------- snacks earned
  /** Something happened (main.js stat()): maybe it wore him out, maybe it earned a snack. */
  function onStat(event, payload = {}) {
    if (!on()) return;
    const w = event === 'ride' ? (payload.n >= RIDE_PX ? 'ride' : null) : STAT_WEAR[event];
    if (w && present()) set(needs.wear(get(), w)); // work done while you're away costs him nothing
    if (needs.SOURCES[event]) earn(event);
    lookChanged();
  }

  function earn(source) {
    if (!on()) return null;
    const r = needs.earn(get(), source, h.now(), Math.random);
    set(r.state, { save: !!r.snack });
    if (!r.snack) return null;
    moment(r.snack === 'golden' ? 'golden' : 'snack');
    h.changed();
    return r.snack;
  }

  // A snack turning up: a plankton drifts down and he grabs it, if he's free to.
  function moment(kind) {
    if (!h.free()) return;
    d.toCrab('critter:prop', { prop: kind === 'golden' ? 'sparkle' : 'plankton-drop', ms: 1400 });
    if (kind === 'tide') d.speak('tide', { force: true });
    else d.speak('snackEarned', kind === 'golden' ? { force: true } : {});
  }

  // ---------------------------------------------------------------- the day wears on
  // Only while you're here: nothing goes down while you're away (needs.js).
  const wear = kind => { if (on() && present()) { set(needs.wear(get(), kind)); lookChanged(); } };

  function attend(kind) {
    if (!on()) return;
    const was = needs.mood(get()).mood;
    set(needs.attend(get(), kind));
    if (was === 'mopey' && needs.mood(get()).mood !== 'mopey') h.later(1400, () => d.speak('cheered'));
    lookChanged();
  }

  /** How much likelier he is to nod off (life.js maybeNap). */
  const napChance = () => (on() ? needs.napChance(get()) : 1);
  /** He mopes about a bit less far. */
  const mopey = () => on() && needs.mood(get()).mood === 'mopey';

  /** life.js idleBit(): now and then a habit is his need showing, and maybe a word about it. */
  function idleBit() {
    if (!on()) return false;
    const m = needs.mood(get()).mood;
    if (!NEED_BITS[m] || Math.random() >= NEED_BIT_CHANCE) return false;
    d.toCrab('critter:bit', { bit: NEED_BITS[m] });
    const line = needs.needyLine(get(), h.now());
    if (line && d.speak(line)) set(needs.markNeedy(get(), h.now()), { save: true });
    return true;
  }

  // ---------------------------------------------------------------- feeding him
  const off = { ok: false, error: 'Snacks and naps is off. Turn it on in Settings.' };

  function feed(kind = null) {
    if (!on()) return off;
    const r = needs.feed(get(), h.now(), typeof kind === 'string' ? kind : null);
    if (!r.ok) {
      if (r.reason === 'stuffed') d.speak('stuffed', { force: true });
      if (r.reason === 'empty') d.speak('pantryEmpty', { force: true });
      return { ok: false, reason: r.reason, error: r.reason === 'stuffed' ? 'He\'s stuffed. He\'ll save it for later.' : 'No snacks yet. They come from getting things done.' };
    }
    set(r.state, { save: true });
    h.wake();
    munch(r.ate);
    d.stat('fed');
    if (r.ate === 'golden') { d.stat('golden-snack'); h.remember('golden-snack'); }
    h.remember('first-snack');
    h.grow('feed');
    d.awardXp('feed');
    h.changed();
    lookChanged();
    return { ok: true, ate: r.ate };
  }

  // Down it comes, he catches it, munches, crumbs and a heart. Only when he's free
  // to; mid-task he just says thanks.
  function munch(ate) {
    if (!h.free()) { d.speak('fed', { force: true }); return; } // mid-game or mid-find: no cutting in
    h.perform('feed', 4400, [
      { at: 0, run: () => d.toCrab('critter:prop', { prop: 'plankton-drop', ms: 900 }) },
      { at: 900, run: () => { d.toCrab('critter:hold', { pixels: needs.SNACKS[ate].pixels, palette: needs.SNACKS[ate].palette }); d.toCrab('critter:bit', { bit: 'munch', ms: 1900 }); d.toCrab('critter:prop', { prop: 'crumbs', ms: 1900 }); } },
      { at: 2800, run: () => { d.toCrab('critter:hold', null); d.toCrab('critter:prop', { prop: ate === 'golden' ? 'sparkle' : 'hearts', ms: 1600 }); d.speak('fed', { force: true }); } },
    ]);
  }

  function rinse() {
    if (!on()) return off;
    const r = needs.rinse(get(), h.now());
    if (!r.ok) {
      const mins = Math.max(1, Math.ceil((needs.nextRinseAt(get()) - h.now()) / MINUTE));
      return { ok: false, reason: r.reason, error: r.reason === 'clean' ? 'He\'s already shiny.' : `He had a rinse not long ago. Again in ${mins}m.` };
    }
    set(r.state, { save: true });
    h.wake();
    if (h.free()) {
      h.perform('rinse', 3800, [
        { at: 0, run: () => { d.toCrab('critter:prop', { prop: 'suds', ms: 2400 }); d.toCrab('critter:bit', { bit: 'polish', ms: 2400 }); } },
        { at: 2400, run: () => { d.toCrab('critter:prop', { prop: 'sparkle', ms: 1400 }); d.speak('rinsed', { force: true }); } },
      ]);
    } else d.speak('rinsed', { force: true });
    d.stat('rinsed');
    h.remember('first-bath');
    h.grow('care');
    d.awardXp('care');
    h.changed();
    lookChanged();
    return { ok: true };
  }

  function tuckIn() {
    if (!on()) return off;
    // Decided before anything counts: a tuck-in that can't become a nap isn't one.
    if (!h.free()) return { ok: false, reason: 'busy', error: 'He\'s busy right now. Try again in a moment.' };
    const r = needs.tuckIn(get(), h.now());
    if (!r.ok) {
      if (r.reason === 'rested') d.speak('notSleepy', { force: true });
      const mins = Math.max(1, Math.ceil((needs.nextTuckAt(get()) - h.now()) / MINUTE));
      return { ok: false, reason: r.reason, error: r.reason === 'rested' ? 'He\'s wide awake. Maybe later.' : `He had a nap not long ago. Again in ${mins}m.` };
    }
    set(r.state, { save: true });
    d.speak('tuckedIn', { force: true });
    d.stat('tucked');
    h.grow('care');
    d.awardXp('care');
    h.later(1800, () => h.napFor(TUCK_NAP_MS)); // after his "night night"
    h.changed();
    return { ok: true };
  }

  // ---------------------------------------------------------------- his menu and the Us page
  /** The Feed item and the Care submenu's own items (main.js adds "How he's doing…"). */
  function menu() {
    if (!on()) return null;
    const s = get();
    const v = needs.view(s, h.now());
    const rinseLabel = v.clean ? 'Give him a rinse (he\'s shiny)'
      : v.nextRinseAt ? `Give him a rinse (in ${Math.max(1, Math.ceil((v.nextRinseAt - h.now()) / MINUTE))}m)` : 'Give him a rinse';
    return {
      feed: { label: needs.feedLabel(s, { crabOnly: crabOnly() }), enabled: v.pantry.total > 0 && !v.stuffed, click: () => feed() },
      care: [
        { label: rinseLabel, enabled: !v.clean && !v.nextRinseAt, click: () => rinse() },
        { label: v.rested ? 'Tuck him in (not sleepy)' : v.nextTuckAt ? `Tuck him in (in ${Math.max(1, Math.ceil((v.nextTuckAt - h.now()) / MINUTE))}m)` : 'Tuck him in', enabled: !v.rested && !v.nextTuckAt, click: () => tuckIn() },
      ],
    };
  }

  const view = () => (on() ? { on: true, ...needs.view(get(), h.now(), { crabOnly: crabOnly() }) } : { on: false });

  /** Settings: switched on again, he comes back full rather than hungry. */
  function switched(isOn) {
    if (isOn) set(needs.refill(get(), h.now()), { save: true });
    lookChanged();
    h.changed();
  }

  function seenIntro() {
    set({ ...get(), introduced: true }, { save: true });
    h.changed();
  }

  /** dev/e2e: set meters and the pantry directly. */
  function setForTest({ meters = {}, pantry = {} } = {}) {
    const s = get();
    set(needs.normalize({ ...s, meters: { ...s.meters, ...meters }, pantry: { ...s.pantry, ...pantry }, updatedAt: h.now() }), { save: true });
    lookChanged();
    h.changed();
    return view();
  }

  return { tick, onStat, earn, wear, attend, napChance, mopey, idleBit, feed, rinse, tuckIn, menu, view, look, switched, seenIntro, flush, setForTest };
}

module.exports = { createCare, NEED_BITS };
