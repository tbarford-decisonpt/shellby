/* Shellby panel — First steps: the short path for someone new, on the chat's
   start screen (main/first-run.js decides what's done). Each step finishes when
   the real thing happens (a folder chosen, a task sent, his changes opened, a
   pet), so the buttons only help you get there; Skip moves past one, and ×
   puts the card away with its progress kept (Settings → General → Screens
   brings it back). The quest card waits until First steps are out of the
   way, so the start screen holds one card at a time. Just-the-crab mode has no
   chat, so no card. Settings' "Show everything now" lives here too. */
'use strict';
(function () {
  const { api, h, $ } = SB;

  let view = null; // main's firstRunView(); null until it arrives (no card)

  const off = () => !view || SB.isCrabOnly?.();
  SB.firstRunCardShows = () => !off() && view.shows;
  SB.firstRunWants = id => !off() && !view.complete && view.steps.some(s => s.id === id && s.state === 'todo');
  SB.firstRunCoreLevel = () => view?.coreLevel || null;

  // The card lives on an empty conversation; inside one, a step that's next
  // gets one quiet nudge instead (once each per run of the panel).
  const NUDGES = {
    result: { text: 'First steps: open “files changed” under his reply to see exactly what he did.', action: 'Show me' },
    crab: { text: 'Last of the First steps: rub the mouse over him on the desktop to say hi, or try on an outfit.', action: 'Open Outfits', run: () => SB.setView('wardrobe') },
  };
  const nudged = new Set();
  SB.firstRunNudge = (id, run) => {
    const n = NUDGES[id];
    if (!n || nudged.has(id) || !SB.firstRunWants(id) || !SB.firstRunCardShows()) return;
    nudged.add(id);
    SB.toast(n.text, { action: n.action, onAction: run || n.run, ms: 8000 });
  };

  // What each step's button does. None of them finish the step by themselves.
  const ACTIONS = {
    project: async () => SB.folderChanged(await api.pickFolder()),
    message: () => {
      const box = $('input');
      if (!box) return;
      if (!box.value.trim()) {
        box.value = 'Explain this project to me: what it does, how to run it and where to start.';
        box.dispatchEvent(new Event('input'));
      }
      box.focus();
    },
    result: () => {
      const tab = SB.activeTab?.();
      if (SB.hasChanges?.(tab)) return SB.showChanges(tab);
      SB.toast('Nothing has changed yet. Ask Claude for a small edit, and his changes show up right under the reply.', { ms: 5000 });
    },
    crab: () => SB.setView('wardrobe'),
  };

  function stepRow(s) {
    const now = s.id === view.current;
    const mark = s.state === 'done' ? '✓' : s.state === 'skipped' ? '–' : s.icon;
    return h('li', { class: `fr-step ${s.state}${now ? ' now' : ''}`, 'aria-current': now ? 'step' : null, dataset: { step: s.id } },
      h('span', { class: 'fr-mark', 'aria-hidden': 'true', text: mark }),
      h('div', { class: 'fr-body' },
        h('b', { text: s.title }),
        h('span', { class: 'sr-only', text: s.state === 'done' ? 'done' : s.state === 'skipped' ? 'skipped' : now ? 'next up' : 'not done yet' }),
        now ? h('p', { class: 'fr-text', text: s.text }) : null,
        now ? h('div', { class: 'fr-actions' },
          ACTIONS[s.id] && s.action ? h('button', { class: 'btn slim-btn fr-go', type: 'button', text: s.action, onclick: ACTIONS[s.id] }) : null,
          h('button', { class: 'btn ghost slim-btn fr-skip', type: 'button', text: 'Skip', 'aria-label': `Skip ${s.title}`, onclick: () => skip(s.id) })) : null));
  }

  function renderCard(el) {
    if (!el) return;
    el.hidden = !SB.firstRunCardShows();
    if (el.hidden) return el.replaceChildren();
    el.replaceChildren(
      h('div', { class: 'quest-top' },
        h('span', { class: 'quest-step fr-eyebrow', text: `First steps · ${view.doneCount} of ${view.total}` }),
        h('span', { class: 'quest-pips', 'aria-hidden': 'true' }, ...view.steps.map(s => h('i', { class: s.state !== 'todo' ? 'done' : s.id === view.current ? 'now' : '' }))),
        h('button', { class: 'quest-x', type: 'button', title: 'Put First steps away (Settings brings them back)', 'aria-label': 'Hide First steps', text: '×', onclick: () => hide(true) })),
      h('ol', { class: 'fr-steps' }, ...view.steps.map(stepRow)));
  }
  SB.renderFirstRun = renderCard;
  const renderCards = () => document.querySelectorAll('.empty .first-run-card').forEach(renderCard);

  async function skip(id) { received(await api.skipFirstStep(id)); }
  async function hide(hidden) {
    received(await api.hideFirstRun(hidden));
    if (hidden) SB.toast('First steps are put away. Settings → General → Screens brings them back.', { action: 'Undo', onAction: () => hide(false), ms: 5000 });
  }

  // Settings → General → Screens: the way round rooms, and First steps back.
  function renderSettings() {
    const all = !SB.hasLockedRooms?.();
    const btn = $('showEverythingBtn');
    btn.disabled = all;
    btn.textContent = all ? 'Every screen is showing' : 'Show everything now';
    $('screensLede').textContent = all
      ? 'Every screen is on the bar. Ctrl+K jumps to any of them.'
      : 'Some of his screens join the bar as you two work together, so there’s less to take in on day one.';
    $('firstRunAgainBtn').hidden = !view || view.complete || !view.hidden;
  }
  SB.renderScreensSetting = renderSettings;
  $('showEverythingBtn').addEventListener('click', async () => { await SB.openAllRooms(); renderSettings(); });
  $('firstRunAgainBtn').addEventListener('click', async () => { await hide(false); renderSettings(); SB.toast('First steps are back on the chat’s start screen.'); });

  function received(v) {
    if (!v) return;
    const was = view;
    view = v;
    document.body.classList.toggle('newcomer', !v.complete);
    renderSettings();
    // The quest card and the suggestions share the start screen with this one.
    if (SB.refreshEmptyStates) SB.refreshEmptyStates(); else renderCards();
    if (was && was.current !== 'crab' && v.current === 'crab') SB.firstRunNudge('crab');
    if (was && !was.complete && v.complete && !SB.isCrabOnly?.()) {
      SB.celebrate({
        eyebrow: 'First steps done', icon: '🦀', title: 'You two are off',
        text: 'That’s the whole loop: a project, a task, his changes, and the crab himself. More of his world opens from here as you work.',
        action: { label: 'Open the Logbook', run: () => SB.setView('logbook') },
      });
    }
  }

  api.onFirstRun(received);
  api.onRooms(() => requestAnimationFrame(renderSettings));
  // Switching in or out of just the crab hides or shows it.
  const applyCrabOnly = SB.applyCrabOnly;
  SB.applyCrabOnly = () => { applyCrabOnly(); renderCards(); };
  api.getFirstRun().then(received).catch(() => {}); // no card is a fine way to fail
})();
