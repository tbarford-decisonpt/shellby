// Quests (quests/index.js): the features worth finding, a chapter at a time. Each
// quest is done the first time the real thing succeeds: some call
// d.questDone(id) where they succeed, the rest are read here off the stats and
// XP awards every system already reports (d.onStat, d.onAward), so a chapter
// can teach a screen without that screen knowing about quests. Chapters open
// on level-ups, on a panel look, and by a tide event. Registers the `quests`
// game view (game-hub.js). Kept out of main.js, which only wires it up.
const featureUse = require('../feature-use');
const quests = require('../quests');

// Stats (wardrobe/achievements.js events) that finish a quest. A function
// decides from the payload; a string always does.
const STAT_QUESTS = Object.freeze({
  'routine-run': 'routine',
  'swap-made': 'friend',
  'egg-hatched': 'friend',
  'hatched-from-egg': 'friend',
  'find-made': p => (p?.event ? 'friend' : null),
  'bug-caught': 'first-catch',
  'clean-fix': 'proof',
  'rematch-won': 'rematch',
  'nest-cleared': 'nest',
  'review-caught': 'caught',
  'reef-best': 'reef-best',
  'review-tier': p => (Number(p?.n) >= 2 ? 'tier2' : null),
  'quiz-streak': p => (Number(p?.n) >= 3 ? 'quiz3' : null),
  'reef-thriving': p => (Number(p?.n) >= 1 ? 'thriving' : null),
  'bugs-caught-total': p => (Number(p?.n) >= 50 ? 'species50' : null),
  'ever-level': p => (Number(p?.n) >= 99 ? 'ninety-nine' : null),
  level: p => (Number(p?.n) >= 99 ? 'ninety-nine' : null),
  molted: 'molt-or-stay',
});

// XP awards (progression/xp.js AWARDS kinds) that finish a quest.
const AWARD_QUESTS = Object.freeze({ quiz: 'quiz', helped: 'helped', medal: 'medal', cifix: 'cifix' });

const questFor = (map, key, payload) => {
  const q = Object.hasOwn(map, key) ? map[key] : null;
  return typeof q === 'function' ? q(payload) : q;
};

const DAY = 86400000;
const DORMANT_AFTER_DAYS = 7;
const SCREEN_NAMES =Object.fromEntries(featureUse.SCREENS.map(s => [s.id, s.name]));

/** d: what main shares (main.js `shared`); needs d.awardXp from progress.js. */
function wireQuestLine(d) {
  // What decides which chapters are open: the highest level ever reached, the
  // screens never opened, and whether a tide event is on.
  function ctx() {
    let dormant = new Set();
    try {
      const now = Date.now();
      const r = featureUse.report(d.config.get('featureUse'), now);
      // A screen counts as never tried only after a week of counting: on day one they all are.
      if (r.since && now - r.since >= DORMANT_AFTER_DAYS * DAY) dormant = new Set(r.never.map(s => s.id));
    } catch (e) { d.log?.warn?.('quests: feature use unreadable', e?.message); }
    let eventActive = false;
    try { eventActive = !!d.activeEvent?.(); } catch { /* events not wired yet */ }
    let everLevel = 1;
    try { everLevel = Number(d.everLevel?.()) || 1; } catch { /* no XP yet */ }
    return { everLevel, dormant, eventActive };
  }

  // The scripted screenshots show a fresh line.
  function questsPanelView() {
    return quests.questsView(d.CAPTURE ? null : d.config.get('quests'), d.CAPTURE ? null : ctx(), SCREEN_NAMES);
  }

  function push(extra = {}) {
    const v = questsPanelView();
    d.send(d.panel, 'quests', { view: v, ...extra });
    d.gameHub?.push('quests', v);
    return v;
  }

  function setQuests(next) {
    if (next && !d.CAPTURE) d.config.set({ quests: next });
    return push();
  }

  const pick = q => q && { id: q.id, icon: q.icon, title: q.title, why: q.why, go: q.go };
  const pickChapter = c => c && { id: c.id, n: c.n, icon: c.icon, title: c.title, blurb: c.blurb, teaches: c.teaches };

  // Chapters ctx allows now: saved, and the panel told (a card for each).
  function unlockQuestChapters() {
    if (d.CAPTURE || !d.config) return [];
    const r = quests.unlockChapters(d.config.get('quests'), ctx(), Date.now());
    if (!r.opened.length) return [];
    d.config.set({ quests: r.state });
    push({ opened: r.opened.map(pickChapter) });
    return r.opened;
  }

  // Called where each feature succeeds. Only the first time counts, and only
  // once its chapter is open.
  function questDone(id) {
    if (d.CAPTURE || !d.config || typeof id !== 'string') return;
    const r = quests.completeQuest(d.config.get('quests'), id, Date.now(), ctx());
    if (!r.quest && !r.opened.length) return;
    d.config.set({ quests: r.state });
    if (!r.quest) { push({ opened: r.opened.map(pickChapter) }); return; }
    // The card first, so a level-up the XP brings lands after it.
    push({
      done: pick(r.quest), next: pick(r.next), finished: r.finished,
      chapter: pickChapter(r.chapter), chapterDone: r.chapterDone, opened: r.opened.map(pickChapter),
    });
    d.awardXp('quest', { label: r.quest.title });
    if (!r.chapterDone) return;
    d.awardXp('chapter', { label: `Chapter ${r.chapter.n}: ${r.chapter.title}` });
    // The old line was Chapter 1: finishing it still pays what it always did.
    if (r.chapter.id === quests.FIRST.id) d.awardXp('questline');
    const n = Object.values(r.state.chapters).filter(c => c.doneAt).length;
    d.stat('chapter-done', { n });
  }

  // Quests the rest of Shellby already reports, without a line in each screen.
  d.onStat?.((event, payload) => { const q = questFor(STAT_QUESTS, event, payload); if (q) questDone(q); });
  d.onAward?.(a => { const q = questFor(AWARD_QUESTS, a?.kind, a?.meta); if (q) questDone(q); });
  d.onLevelUp?.(() => unlockQuestChapters());

  d.gameHub?.register('quests', {
    get: () => { unlockQuestChapters(); return questsPanelView(); },
    act: (action, payload) => {
      if (action === 'hide') return setQuests(quests.setHidden(d.config.get('quests'), payload === true));
      if (action === 'seen' && typeof payload === 'string') return setQuests(quests.markSeen(d.config.get('quests'), payload));
      return null;
    },
  });

  return { questDone, questsPanelView, setQuests, unlockQuestChapters };
}

module.exports = { wireQuestLine, STAT_QUESTS, AWARD_QUESTS };
