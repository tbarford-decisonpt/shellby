/* Shellby panel — the usage forecast and "after the reset": the banner above
   the box, held messages alongside the queued ones, and Ctrl+Shift+Enter to
   hold what you've typed. Main works out the forecast and does the holding
   and sending (src/main/forecast.js, held.js); this only shows it. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const input = $('input');
  let dismissed = null; // the reset whose warning you closed: it stays closed for that window

  SB.applyOutlook = o => {
    state.outlook = o || null;
    SB.refreshUsage?.();
    SB.renderQueue?.(); // held chips, and the banner with them
    if (state.view === 'routines') SB.views.routines?.render();
  };

  const heldFor = tab => (state.outlook?.held || []).filter(x => x.kind === 'message' && x.tabId === tab.id);
  const describe = m => m.text || `${m.attachments.length} attached file${m.attachments.length === 1 ? '' : 's'}`;

  // ------------------------------------------------------------ banner

  function renderOutlook() {
    const box = $('outlook');
    const o = state.outlook;
    const tab = SB.activeTab();
    const note = o?.limit
      ? { text: `You're at your ${o.limit.name} limit until ${o.limit.at}.`, key: o.limit.resetsAt, cls: 'limit' }
      : o?.warning ? { text: o.warning.text, key: o.warning.resetsAt, cls: 'warning' } : null;
    const show = !!note && !!tab && dismissed !== note.key && !SB.isCrabOnly?.();
    box.hidden = !show;
    if (!show) { box.replaceChildren(); return; }
    box.className = `outlook ${note.cls}`;
    const typed = !!input.value.trim() || tab.attachments.length > 0;
    const queued = tab.queue.length;
    const actions = !o.resetAt ? [] : [
      typed ? h('button', { class: 'btn slim-btn', type: 'button', title: 'Ctrl+Shift+Enter', onclick: holdTyped }, 'Send after the reset') : null,
      queued ? h('button', { class: `btn slim-btn${typed ? ' ghost' : ''}`, type: 'button', onclick: () => holdQueue(tab) }, `Hold ${queued} queued`) : null,
      !typed && !queued ? h('span', { class: 'outlook-hint' }, h('kbd', { text: 'Ctrl+Shift+Enter' }), ' in the box holds a message for then') : null,
    ].filter(Boolean);
    box.replaceChildren(...[
      SB.icon(SB.ICONS.clock, { width: 1.4 }),
      h('span', { class: 'outlook-text', text: note.text }),
      h('button', { class: 'queue-x icon-btn', type: 'button', 'aria-label': 'Hide until the reset', title: 'Hide until the reset', onclick: () => { dismissed = note.key; renderOutlook(); } },
        SB.icon('M4.5 4.5l7 7M11.5 4.5l-7 7', { width: 1.5 })),
      actions.length ? h('div', { class: 'outlook-actions' }, actions) : null,
    ].filter(Boolean));
  }
  SB.renderOutlook = renderOutlook;
  // Whether there's anything to send after the reset changes as you type.
  input.addEventListener('input', () => { if (state.outlook?.warning || state.outlook?.limit) renderOutlook(); });

  // ------------------------------------------------------------ holding

  async function hold(tab, text, attachments) {
    const r = await api.holdForReset({ kind: 'message', tabId: tab.id, text, attachments });
    if (!r.ok) SB.toast(r.error, { ms: 5000 });
    return r;
  }

  // What's in the box, held until the reset. The box empties at once (so a
  // second press, or switching tabs, can't hold or wipe the wrong thing) and
  // gets it back if it can't be held.
  let holding = false;
  async function holdTyped() {
    const tab = SB.activeTab();
    if (!tab || holding) return;
    const text = input.value.trim();
    const attachments = [...tab.attachments];
    if (!text && !attachments.length) return;
    if (!state.outlook?.resetAt) return SB.toast("Shellby doesn't know when your window resets yet. He finds out with your next message.", { ms: 5000 });
    // A command you run yourself happens here and now, never later (composer.js).
    if (text.startsWith('!') && !text.startsWith('!!')) return SB.toast('Commands you run with ! can\'t wait for the reset.');
    holding = true;
    SB.clearComposer(tab);
    try {
      const r = await hold(tab, text, attachments);
      if (r.ok) SB.toast(`Held. It goes at ${r.atText}, once your usage resets.`, { ms: 4000 });
      else SB.handBack(tab, text, attachments);
    } finally {
      holding = false;
    }
  }

  // Everything queued in a tab, held instead (oldest first, so they go in order).
  async function holdQueue(tab) {
    // Taken out first: a turn ending meanwhile would otherwise send them too.
    // Not what Claude is reading already (main's 'steering').
    const taken = tab.queue.filter(m => !m.taken);
    tab.queue = tab.queue.filter(m => m.taken);
    SB.syncSteers(tab); // nor steer them into the turn that's running
    let n = 0, at = null;
    for (const m of taken) {
      const r = await hold(tab, m.text, m.attachments);
      if (!r.ok) { tab.queue.unshift(...taken.slice(n)); break; }
      n++;
      at = r.atText;
    }
    if (!tab.queue.length) tab.queuePaused = false;
    if (tab.isActive) SB.syncBusyUi();
    if (n) SB.toast(`${n === 1 ? 'Your queued message goes' : `${n} queued messages go`} at ${at}, once your usage resets.`, { ms: 4000 });
  }
  SB.holdQueue = holdQueue;

  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !e.ctrlKey || !e.shiftKey || e.altKey || e.isComposing) return;
    e.preventDefault();
    holdTyped();
  });

  // ------------------------------------------------------------ held messages, with the queue

  // Chips for the queue strip (tabs.js renderQueue): click to edit (it comes
  // back to the box and is no longer held), ✕ to drop it.
  SB.heldChips = tab => heldFor(tab).map(m => h('div', { class: 'queue-item held' },
    h('span', { class: 'queue-tag', title: `Held until your usage resets: goes at ${m.atText}`, text: m.atText }),
    h('button', { class: 'queue-text', type: 'button', title: 'Edit (puts it back in the box; it won\'t wait for the reset)', onclick: () => unhold(tab, m.id, true) }, describe(m)),
    h('button', { class: 'queue-x icon-btn', type: 'button', 'aria-label': 'Don\'t send after the reset', onclick: () => unhold(tab, m.id, false) },
      SB.icon('M4.5 4.5l7 7M11.5 4.5l-7 7', { width: 1.5 }))));

  async function unhold(tab, id, edit) {
    const r = await api.cancelHeld(id);
    if (!r.ok) return; // already sent, or already gone
    if (edit && SB.handBack(tab, r.item.text, r.item.attachments) && tab.isActive) input.focus();
  }

  // ------------------------------------------------------------ from main

  api.onOutlook(SB.applyOutlook);
  // A held message went out after the reset.
  api.onTabSent(({ tabId, item }) => {
    const tab = state.tabs.get(tabId);
    if (tab && item) SB.markSent(tab, item.text, item.attachments || [], item.turnId);
  });
  // One that couldn't go: back in its box, never lost.
  api.onHeldReturned(({ tabId, text, attachments, error }) => {
    const tab = state.tabs.get(tabId);
    if (!tab) return;
    SB.handBack(tab, text, attachments || []);
    SB.toast(`A held message couldn't be sent${error ? ` (${error})` : ''}. It's back in its box.`, { ms: 6000 });
  });
})();
