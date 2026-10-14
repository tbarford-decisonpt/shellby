// Review mastery (review-mastery.js, docs/CLAUDE-CODE.md#review-mastery): the
// quiz, line comments, and catching something before it merges, turned into
// points, tiers and XP. Kept out of main.js, which only wires it up.
//
// ipc/tabs.js calls d.reviewQuiz when a quiz finishes and ipc/corrections.js
// calls d.reviewComments when a review goes back to Claude. The next turn on
// that tab (a 'changes' item in its transcript) shows whether a comment caught
// something: its diff is read with changes.patchFor, the same diff the panel shows.
const path = require('path');
const mastery = require('../review-mastery');
const changes = require('../changes');

const SHIP_RE = /\bgit[ \t]+push\b|\bgh[ \t]+pr[ \t]+merge\b|\bglab[ \t]+mr[ \t]+merge\b/i;
const MAX_HISTORY_LOOK = 400; // items back through a transcript to find a turn

/** d: what main shares (main.js `shared`). */
function wireReview(d) {
  const now = () => Date.now();
  const state = () => mastery.normalize(d.config?.get('reviewMastery'));
  const view = () => mastery.masteryView(d.config?.get('reviewMastery'), now());
  const turnKey = (tabId, after) => `${tabId}:${after}`;

  // ---------------------------------------------------------------- what a change pays

  function apply(r, event) {
    if (!d.config || d.CAPTURE) return;
    d.config.set({ reviewMastery: r.state });
    if (r.tierUp) {
      d.awardXp('reviewtier', { label: `Review mastery: ${r.tierUp.name}` });
      d.stat('review-tier', { n: r.tierUp.n });
    }
    const tierEvent = r.tierUp && { kind: 'tier', tier: r.tierUp.n, name: r.tierUp.name, reward: r.tierUp.reward };
    d.gameHub.push('review', view(), tierEvent || event);
  }

  // ---------------------------------------------------------------- pushed or merged since

  const shippedAt = new Map(); // caseKey(dir) -> ms
  let anyShipAt = 0;
  d.onCommandResult?.(r => {
    if (!r?.ok || typeof r.command !== 'string' || !SHIP_RE.test(r.command)) return;
    const dir = r.dir || r.cwd;
    if (dir) shippedAt.set(path.resolve(dir).toLowerCase(), now());
    anyShipAt = now();
  });
  d.onAward?.(a => { if (a?.kind === 'ship' || a?.kind === 'merged') anyShipAt = now(); });
  const shippedSince = (root, at) => anyShipAt > at || (root && (shippedAt.get(path.resolve(root).toLowerCase()) || 0) > at);

  // ---------------------------------------------------------------- the quiz

  /** A quiz on a turn's changes finished (ipc/tabs.js). */
  function reviewQuiz({ tabId, after, lines, passed } = {}) {
    if (typeof tabId !== 'string' || typeof after !== 'string') return;
    const r = mastery.onQuiz(d.config?.get('reviewMastery'), { turnId: turnKey(tabId, after), lines, passed: !!passed }, now());
    if (r.reason === 'no-turn') return;
    apply(r, r.points ? { kind: 'quiz', points: r.points } : undefined);
    d.stat('quiz-streak', { n: r.state.quiz.best });
  }

  // ---------------------------------------------------------------- line comments

  // A turn's 'changes' item from the tab's transcript: only a real turn (one
  // Shellby worked out from git) counts, never a diff made up for something else.
  function changesItem(tabId, after) {
    const items = d.history?.load(tabId) || [];
    for (let i = items.length - 1, n = 0; i >= 0 && n < MAX_HISTORY_LOOK; i--, n++) {
      const it = items[i];
      if (it?.kind === 'changes' && it.after === after && typeof it.root === 'string' && it.before) return it;
    }
    return null;
  }

  /** A review went back to Claude (ipc/corrections.js): comments: [{ file, body, start, end, side, after }]. */
  function reviewComments(tabId, comments) {
    if (typeof tabId !== 'string' || !Array.isArray(comments) || !d.config) return;
    const byTurn = new Map();
    for (const c of comments) {
      if (!c || typeof c.after !== 'string' || !/^[0-9a-f]{40}$/.test(c.after)) continue;
      if (!byTurn.has(c.after)) byTurn.set(c.after, []);
      byTurn.get(c.after).push(c);
    }
    for (const [after, list] of byTurn) {
      const item = changesItem(tabId, after);
      if (!item) continue; // not a turn of this conversation
      const diffLines = (Number(item.added) || 0) + (Number(item.removed) || 0);
      const r = mastery.onComments(d.config.get('reviewMastery'), { turnId: turnKey(tabId, after), tabId, comments: list, diffLines }, now());
      if (r.points) apply(r, { kind: 'comment', points: r.points });
    }
    if (byTurn.size) watchTurns();
  }

  // ---------------------------------------------------------------- the next turn

  let watching = false;
  function watchTurns() {
    if (watching || !d.manager?.on) return;
    watching = true;
    d.manager.on('item', (tabId, item) => {
      if (item?.kind !== 'changes' || typeof item.after !== 'string') return;
      nextTurn(tabId, item).catch(e => d.log.warn('review: next turn', e?.message || String(e)));
    });
  }

  async function nextTurn(tabId, item) {
    const open = mastery.openTurns(d.config?.get('reviewMastery'), tabId, now()).filter(t => t.turnId !== turnKey(tabId, item.after));
    if (!open.length) return;
    const files = [...new Set(open.flatMap(t => t.files))].slice(0, 50);
    // Only the files commented on: the rest of the turn can't catch anything.
    const p = files.length ? await changes.patchFor({ root: item.root, before: item.before, after: item.after, paths: files }) : { patch: '' };
    const edits = p.error ? [] : mastery.editsOf(p.patch);
    for (const t of open) {
      const entry = state().comments.turns[t.turnId];
      const shipped = shippedSince(item.root, entry?.at || 0);
      const r = mastery.onNextTurn(d.config.get('reviewMastery'), { forTurn: t.turnId, turnId: turnKey(tabId, item.after), edits, shipped }, now());
      if (r.reason === 'nothing-open' || r.reason === 'same-turn') continue;
      if (r.caught) {
        d.awardXp('caught', { label: `Caught in review: ${r.file}` });
        d.stat('review-caught');
        d.questDone?.('caught');
        apply(r, { kind: 'caught', file: r.file, points: r.points });
        break; // one catch per turn
      }
      d.config.set({ reviewMastery: r.state });
    }
  }

  d.gameHub.register('review', { get: () => view() });

  return { reviewQuiz, reviewComments };
}

module.exports = { wireReview };
