// The tab strip's decisions (tabs.js and the files beside it draw them): the
// order after a drag or a nudge, where the arrow keys go, the icon and name a
// tab shows, what's steered into a running turn, and the slash menu's ranking.
// Pure, no DOM. Works in the browser and in Node (for tests).
(function (root) {
  const NEW_TITLE = 'New task';
  const TITLE_MAX = 70;
  const SLASH_MAX = 8;
  const NO_MATCH = 9;

  // The strip's ids with tabId moved in front of beforeId (null = the end), or
  // null when that's no move at all: an unknown neighbour, itself, or already there.
  function reorder(ids, tabId, beforeId = null) {
    const rest = ids.filter(id => id !== tabId);
    const at = beforeId === null ? rest.length : rest.indexOf(beforeId);
    if (at < 0) return null;
    rest.splice(at, 0, tabId);
    if (rest.every((id, i) => id === ids[i])) return null;
    return rest;
  }

  // One place left or right: the id to land in front of (null = the end), or
  // undefined when it's already at that end.
  function nudgeBefore(ids, tabId, step) {
    const to = ids.indexOf(tabId) + step;
    if (to < 0 || to >= ids.length) return undefined;
    return ids.filter(id => id !== tabId)[to] ?? null;
  }

  // Where an arrow key, Home or End on a tab goes, wrapping round; null for any other key.
  function keyTarget(ids, id, key) {
    const i = ids.indexOf(id);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: ids.length - 1 }[key];
    if (next === undefined) return null;
    return ids[(next + ids.length) % ids.length];
  }

  // One step along the strip from the open tab, wrapping round at the ends.
  function stepTarget(ids, activeId, step) {
    if (!ids.length) return undefined;
    const i = ids.indexOf(activeId);
    return ids[(i + step + ids.length) % ids.length];
  }

  // A blank tab nobody has named reads "New task", whatever it was called before.
  const shownTitle = t => (t.isEmpty && !t.saved && !t.named ? NEW_TITLE : t.title);

  // A conversation's first name, from the first thing sent in it.
  function firstTitle(text, attachments) {
    if (text.length > TITLE_MAX) return text.slice(0, TITLE_MAX - 3) + '…';
    return text || (attachments.every(f => /\.(png|jpe?g|gif|webp)$/i.test(f)) ? 'Screenshot' : 'Attached files');
  }

  const several = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

  // The strip's icon for a tab: { kind, title, text } or null for none. doing is
  // tab-sort.js's activity(): 'turn', 'background' or null.
  function icon(t, doing) {
    if (t.pending) return { kind: 'ask', title: 'Needs your OK', text: '?' };
    if (t.inTerminal) return { kind: 'term', title: 'Carrying on in a terminal', text: '›_' };
    if (doing === 'turn') return { kind: 'busy', title: t.crew ? `${several(t.crew, 'helper')} working` : 'Working' };
    // Not done, so not the finished tick; not the working spinner either, which
    // would say Claude is still replying.
    if (doing === 'background') return { kind: 'bg', title: `Turn finished · ${several(t.crew, 'background task')} still running` };
    if (t.outcome === 'error') return { kind: 'err', title: 'Ended with an error', text: '!' };
    if (t.outcome === 'ok' && t.unread) return { kind: 'ok', title: 'Finished', text: '✓' };
    if (t.routineId) return { kind: 'routine', title: 'Routine', text: '⟳' };
    return null;
  }

  // The classes on a tab in the strip.
  function tabClass(t, { active, clash, dragging }) {
    return `tab${active ? ' active' : ''}${t.unread && !active ? ' unread' : ''}${t.pending ? ' asking' : ''}${clash ? ' clashing' : ''}${dragging ? ' dragging' : ''}`;
  }

  // What's queued behind a running turn and can go to Claude at his next step:
  // everything up to the first /command, which can only start a turn of its own.
  // key changes whenever main needs telling; live is false once no turn is running.
  function steerPlan(tab) {
    const live = !!(tab.busy && tab.turnId);
    const upTo = tab.queue.findIndex(m => m.text.startsWith('/'));
    const items = live ? tab.queue.slice(0, upTo < 0 ? tab.queue.length : upTo) : [];
    const key = live ? `${tab.turnId}|${items.map(m => m.id).join(',')}` : '';
    return { live, items, key };
  }

  // A queue handed back after Stop: its words as one block, and every file.
  function queueBack(queue) {
    return {
      text: queue.map(m => m.text).filter(Boolean).join('\n\n'),
      files: queue.flatMap(m => m.attachments),
    };
  }

  // A queued message's tag and its words (or what's attached, when there are none).
  const queueTag = (m, i) => (m.taken ? 'Sending' : i === 0 ? 'Next' : `#${i + 1}`);
  const queueText = m => m.text || `${m.attachments.length} attached file${m.attachments.length === 1 ? '' : 's'}`;

  // The slash menu for what's typed after "/" (lower case). Shellby's own
  // commands come first, so a skill with the same name can't hide them; then
  // your snippets, which run instead of a skill or command they share a name
  // with. Pinned ones lead while they still match; at most eight.
  function slashCandidates(q, { local = [], snippets = [], skills = [], commands = [], pinned = [] } = {}) {
    const snips = snippets.map(s => ({ name: s.name, kind: 'snippet', description: s.summary, hint: s.hint }));
    const all = [...local, ...snips, ...skills.map(t => ({ ...t, kind: 'skill' })), ...commands.map(t => ({ ...t, kind: 'command' }))];
    const seen = new Set();
    const pins = new Set(pinned.map(p => `${p.kind}:${p.name}`));
    return all
      .filter(t => { const k = t.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
      .map(t => {
        const n = t.name.toLowerCase();
        const score = pins.has(`${t.kind}:${t.name}`) ? -1 : n.startsWith(q) ? 0 : n.includes(q) ? 1 : (t.description || '').toLowerCase().includes(q) ? 2 : NO_MATCH;
        return { t, score };
      })
      .filter(x => x.score < NO_MATCH && (x.score >= 0 || !q || x.t.name.toLowerCase().includes(q)))
      .sort((a, b) => a.score - b.score || a.t.name.localeCompare(b.t.name))
      .slice(0, SLASH_MAX)
      .map(x => x.t);
  }

  const api = { NEW_TITLE, reorder, nudgeBefore, keyTarget, stepTarget, shownTitle, firstTitle, icon, tabClass, steerPlan, queueBack, queueTag, queueText, slashCandidates };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbyTabLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
