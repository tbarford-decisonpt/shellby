// Tide events (events.js), wired up: every stat Shellby records also counts
// toward the event going on; the first look at a run says it's started; the
// last day with goals left says so once; finishing it is a medal, the event's
// trophy (and its reward item) and XP. The panel's banner reads eventsView().
// See docs/plans/viral.md §1.
const events = require('../events');
const gifts = require('../gifts');
const bugdex = require('../bugdex');
const art = require('../bugdex/art');
const { speciesById } = require('../bugdex/species');

const REMARK_CHANCE = 0.3; // per hourly look, while an event's on

/** d: what main shares (main.js `shared`). */
function wireEvents(d) {
  const on = () => !d.CAPTURE && !!d.config && !d.config.get('crabOnly') && d.config.get('tideEvents') !== false;
  const where = () => d.seasonsWhere?.() || {};
  const today = () => (d.today ? d.today() : new Date());
  const state = () => events.normalize(d.config.get('events'));
  const save = s => d.config.set({ events: s });

  /** What the event going on changes, or nothing when events are off. */
  function eventBoosts() {
    if (!on()) return events.boostsAt(new Date(0));
    return events.boostsAt(today(), where());
  }

  /** The tide event going on: { ev, run } or null. */
  const activeEvent = () => (on() ? events.activeEvent(today(), where()) : null);

  function extra() {
    const a = activeEvent();
    if (!a) return {};
    const book = bugdex.normalize(d.config.get('bugdex'));
    const shelf = gifts.normalize(d.config.get('finds'));
    return {
      bugCaught: bugdex.caughtOf(book.species[a.ev.bug]) > 0,
      findsFound: a.ev.finds.filter(id => shelf.items[id]),
    };
  }

  function eventsView() {
    const v = events.view(state(), today(), where(), extra());
    if (v.active) {
      // The banner draws its bug and finds: in colour once you have them, a silhouette until then.
      const sp = speciesById(v.active.bug.id);
      const look = (have, a) => (have ? { pixels: a.pixels, palette: a.palette } : art.silhouette(a));
      v.active.bug = { ...v.active.bug, name: sp.name, ...look(v.active.bug.caught, sp) };
      v.active.finds = v.active.finds.map(f => { const g = gifts.findById(f.id); return { ...f, name: g.name, ...look(f.found, g) }; });
    }
    return { ...v, on: on() };
  }
  const push = () => d.send(d.panel, 'events', eventsView());

  /** A stat came in (wiring/timetrack.js stat): count it toward the event's goals. */
  function eventsOnStat(statEvent, payload) {
    if (!on()) return;
    const r = events.record(state(), statEvent, payload, today(), where());
    if (!r.moved.length) return;
    save(r.state);
    push();
    if (r.finished) finished(r.event, r.key);
  }

  function finished(id, key) {
    const ev = events.eventById(id);
    const medal = events.medalOf(key);
    d.log.info(`events: finished ${key}`);
    d.stat(`event-done-${id}`); // its trophy, and the reward item with it (wardrobe/achievements.js)
    d.stat('event-medal', { n: state().medals.length });
    d.awardXp('medal', { label: `Finished ${medal.name}` });
    d.life?.remember?.('event-medal', { event: medal.name });
    d.speak('milestone', { force: true, text: `${ev.emoji} we did it!!` });
    d.send(d.critter, 'critter:burst', d.outfit().confetti);
    d.send(d.panel, 'events:finished', { ...medal, blurb: ev.blurb });
    if (!(d.panel?.isVisible() && d.panel.isFocused())) {
      d.notify(`${medal.name}: done!`, `Every goal, while it was on. The ${medal.name} medal is yours.`, () => openUs(), { tone: 'celebrate', pet: true });
    }
  }

  function openUs() {
    d.showPanel({ focusInput: false });
    d.send(d.panel, 'panel:view', 'us');
  }

  // Hourly and at boot: has one started, or is it the last day?
  function eventsTick() {
    if (!on()) return;
    const r = events.announce(state(), today(), where());
    if (!r.say) { remark(); return; }
    save(r.state);
    const ev = r.ev;
    if (r.say === 'start') {
      d.log.info(`events: ${ev.id} started`);
      d.speak('milestone', { force: true, text: `${ev.emoji} ${ev.name.toLowerCase()}!` });
      d.send(d.critter, 'critter:burst', d.outfit().confetti);
      d.notify(`${ev.emoji} ${ev.name} is on`, `${ev.blurb} ${events.timeLeft(events.runAt(ev, today(), where()).end.getTime(), today().getTime())}.`, () => openUs(), { tone: 'celebrate', pet: true });
    } else {
      d.speak('milestone', { force: true, text: `last day of ${ev.name.toLowerCase()}!`.slice(0, 24) });
      d.notify(`Last day of ${ev.name}`, 'Some goals are still open. The medal is only for this year\'s.', () => openUs(), { pet: true });
    }
    push();
  }

  // Now and then, while one's on, a word about it: not every hour, and the chatter setting decides (voice.js).
  function remark() {
    const a = activeEvent();
    if (!a || !a.ev.lines.length || Math.random() >= REMARK_CHANCE) return;
    d.speak('milestone', { text: a.ev.lines[Math.floor(Math.random() * a.ev.lines.length)] });
  }

  return { eventBoosts, activeEvent, eventsView, eventsOnStat, eventsTick, pushEvents: push };
}

module.exports = { wireEvents };
