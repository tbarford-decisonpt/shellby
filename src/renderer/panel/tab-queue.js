/* Shellby panel — messages queued behind a running turn: steered into it at
   Claude's next step, edited, removed, sent one by one as turns end, or handed
   back to the box after Stop. tab-send.js puts them in the queue. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const L = window.ShellbyTabLogic;
  const input = $('input');
  // Theirs (tab-send.js, loaded before this).
  const syncBusyUi = () => SB.syncBusyUi();
  const sendNow = (tab, text, attachments) => SB.sendNow(tab, text, attachments);
  const autosize = () => SB.autosize();
  const renderAttachments = () => SB.renderAttachments();

  // ------------------------------------------------------------ steering

  // What's queued behind a running turn goes to Claude at his next step, the
  // way Claude Code's queue does (main's session.js steer), so main hears of
  // every change to it. A /command can only start a turn: it, and everything
  // after it, wait for this one to end.
  function syncSteers(tab) {
    const { live, items, key } = L.steerPlan(tab);
    if (key === tab.steerKey) return;
    tab.steerKey = key;
    if (live) api.steerTask(tab.id, tab.turnId, items);
  }
  SB.syncSteers = syncSteers;

  // Handed to Claude mid-turn: too late to edit or take back. If the turn ends
  // before he reads them, they're queued as before (onTurnEnded).
  SB.onSteering = (tab, ids) => {
    tab.queue = tab.queue.map(m => (ids.includes(m.id) ? { ...m, taken: true } : m));
    if (tab.isActive) renderQueue();
  };

  // Claude has read a queued message mid-turn: its chip is now a message in the feed.
  SB.onSteered = (tab, id) => {
    const i = tab.queue.findIndex(m => m.id === id);
    if (i >= 0) tab.queue.splice(i, 1);
    if (tab.isActive) syncBusyUi(); else syncSteers(tab);
  };

  // Each queued message has an id of its own, for main to say which went in.
  // Each window numbers its own apart, since a queue can move between them
  // with its conversation (tab-panes.js).
  const QUEUE_PREFIX = `q${Math.random().toString(36).slice(2, 7)}-`;
  let queued = 0;
  const queueItem = (text, attachments) => ({ id: `${QUEUE_PREFIX}${++queued}`, text, attachments });
  SB.queueItem = queueItem;

  // ------------------------------------------------------------ queued messages

  function renderQueue() {
    const tab = SB.activeTab();
    const q = tab?.queue || [];
    // Messages held for after the usage reset come last: they go after these (outlook.js).
    const later = tab ? SB.heldChips?.(tab) || [] : [];
    const box = $('queued');
    box.hidden = !q.length && !later.length;
    SB.renderOutlook?.();
    SB.renderReview?.();
    if (box.hidden) { box.replaceChildren(); return; }
    const limited = !!state.outlook?.limit;
    box.replaceChildren(...[
      tab.queuePaused && q.length ? h('div', { class: 'queue-paused' },
        h('span', { text: limited ? "Paused: you're at your usage limit." : 'Paused: the last turn ended with an error.' }),
        limited ? h('button', { class: 'btn slim-btn', type: 'button', onclick: () => SB.holdQueue(tab) }, 'Send after the reset') : null,
        h('button', { class: `btn slim-btn${limited ? ' ghost' : ''}`, type: 'button', onclick: () => { tab.queuePaused = false; drain(tab); } }, 'Send next now')) : null,
      ...q.map((m, i) => h('div', { class: `queue-item${m.taken ? ' taken' : ''}` },
        h('span', { class: 'queue-tag', text: L.queueTag(m, i) }),
        h('button', { class: 'queue-text', type: 'button', disabled: !!m.taken, title: m.taken ? 'Claude is reading this now' : 'Edit (puts it back in the box)', onclick: () => editQueued(tab, i) },
          L.queueText(m)),
        m.taken ? null : h('button', { class: 'queue-x icon-btn', type: 'button', 'aria-label': 'Remove from queue', onclick: () => removeQueued(tab, m.id) },
          SB.icon('M4.5 4.5l7 7M11.5 4.5l-7 7', { width: 1.5 })))),
      ...later,
    ].filter(Boolean));
  }
  SB.renderQueue = renderQueue;

  // × on a chip. While a turn runs, main may have handed it to Claude a moment
  // ago (sessions.js takeSteers), so main takes it off by id and says if it's
  // too late. Focus goes to the chip now in its place, or back to the box.
  async function removeQueued(tab, id) {
    const at = tab.queue.findIndex(m => m.id === id);
    if (at < 0 || tab.queue[at].taken) return;
    const r = tab.busy ? await api.unsteerTask(tab.id, id).catch(() => ({ ok: true })) : { ok: true };
    if (r?.taken) {
      SB.toast('Too late: Claude already has that one.', { ms: 3500 });
      return;
    }
    const i = tab.queue.findIndex(m => m.id === id);
    if (i >= 0) tab.queue.splice(i, 1);
    if (!tab.isActive) return syncSteers(tab); // you've moved to another tab meanwhile
    syncBusyUi();
    const chips = $('queued').querySelectorAll('.queue-item');
    const next = chips[Math.min(at, chips.length - 1)];
    (next?.querySelector('.queue-x') || next?.querySelector('.queue-text:not([disabled])') || input).focus();
  }
  SB.removeQueued = removeQueued;

  // Pull a queued message back into the box to edit (whatever was typed there is queued in its place).
  function editQueued(tab, i) {
    if (!tab.queue[i] || tab.queue[i].taken) return; // Claude is reading it already
    const [m] = tab.queue.splice(i, 1);
    if (input.value.trim() || tab.attachments.length) tab.queue.splice(i, 0, queueItem(input.value.trim(), [...tab.attachments]));
    input.value = m.text;
    tab.attachments = [...m.attachments];
    renderAttachments();
    autosize();
    syncBusyUi();
    input.focus();
  }
  SB.editQueued = editQueued;

  async function drain(tab) {
    if (tab.busy || tab.queuePaused || !tab.queue.length) return;
    const next = tab.queue.shift();
    if (!(await sendNow(tab, next.text, next.attachments))) tab.queue.unshift(next);
    if (tab.isActive) syncBusyUi();
  }

  // A turn ended: send the next queued message, or hand the queue back after Stop.
  SB.onTurnEnded = (tab, result) => {
    // Handed over but never read (main let that process go): ordinary queued messages again.
    tab.queue = tab.queue.map(m => (m.taken ? { ...m, taken: false } : m));
    if (!tab.queue.length) return;
    if (result.interrupted) {
      const back = L.queueBack(tab.queue);
      tab.queue = [];
      if (handBack(tab, back.text, back.files)) SB.toast('Stopped. Your queued messages are back in the box.');
      return;
    }
    if (!result.ok) { tab.queuePaused = true; if (tab.isActive) syncBusyUi(); return; }
    drain(tab);
  };

  // Text going back into a tab's box, after whatever's there: at once for the
  // tab on screen (true), into its draft for one in the background.
  function handBack(tab, text, files = []) {
    for (const f of files) if (!tab.attachments.includes(f)) tab.attachments.push(f);
    if (!tab.isActive) {
      tab.draft = [tab.draft, text].filter(Boolean).join('\n\n');
      return false;
    }
    input.value = [input.value.trim(), text].filter(Boolean).join('\n\n');
    renderAttachments();
    autosize();
    syncBusyUi();
    return true;
  }
  SB.handBack = handBack;
})();
