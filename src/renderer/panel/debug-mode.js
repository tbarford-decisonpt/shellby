/* Shellby panel — Debug mode (src/main/wiring/debug-mode.js).
 *
 * /debug <what goes wrong>: Claude lists hypotheses and adds logging, you
 * reproduce the bug while Shellby records what the logging sends, Claude
 * fixes it from that, and once you say it's fixed takes the logging out while
 * Shellby checks none is left.
 *
 * The card arrives as a transcript item each time the step changes, and moves
 * to the end of the conversation; lines arriving while you reproduce it update
 * it in place. Every message to Claude goes from a button here. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const cards = tab => [...tab.el.querySelectorAll('.debug-card')];
  const LIVE = new Set(['instrumenting', 'recording', 'fixing', 'cleaning', 'leftovers']);

  // /debug the cart total is wrong after a refresh
  SB.startDebug = async (tab, arg) => {
    if (!tab) return;
    if (!arg) return SB.toast('Say what goes wrong: /debug the cart total is off by one after a refresh', { ms: 6000 });
    const r = await api.debug.start(tab.id, arg);
    if (r?.ok) return;
    SB.toast(r?.error || "Couldn't start debug mode.", { ms: 7000 });
    // It's out of the box by now: back in, to fix and try again.
    if (SB.activeTab() === tab && !$('input').value.trim()) SB.prefill(`/debug ${arg}`);
  };

  function says(v) {
    const left = v.leftovers.length + (v.leftoversMore || 0);
    switch (v.phase) {
      case 'instrumenting': return 'Claude is reading the code, listing what could cause it, and adding logging. Nothing gets fixed yet.';
      case 'recording': return v.round
        ? 'Reproduce it again to check the fix. What the logging sends shows up here.'
        : 'Now reproduce the bug in your app. What the logging sends shows up here.';
      case 'fixing': return 'Claude is working out the cause from what was logged.';
      case 'cleaning': return 'Claude is taking the logging out. Shellby checks nothing is left behind.';
      case 'leftovers': return `${plural(left, 'line')} marked SHELLBY-DEBUG ${left === 1 ? 'is' : 'are'} still in the code:`;
      case 'done': return v.checked
        ? 'Done. The logging is gone and the fix stays.'
        : "Done. Shellby couldn't check for leftover logging here (it isn't a git repository): search the code for SHELLBY-DEBUG.";
      case 'stale': return 'Shellby closed during debug mode. Search the code for SHELLBY-DEBUG to find any logging left in.';
      default: return left
        ? `Stopped. ${plural(left, 'line')} marked SHELLBY-DEBUG ${left === 1 ? 'is' : 'are'} still in the code:`
        : 'Stopped.';
    }
  }

  async function act(v, what, button) {
    button.disabled = true;
    const r = await api.debug.act(v.id, what);
    if (!r?.ok) { button.disabled = false; SB.toast(r?.error || "Couldn't do that."); }
  }

  function cardEl(v) {
    const btn = (label, what, primary = false) => h('button', { type: 'button', class: `btn ${primary ? '' : 'ghost '}slim-btn`, onclick: e => act(v, what, e.currentTarget) }, label);
    const lines = `${plural(v.count, 'line')} logged`;
    const actions = [];
    if (v.phase === 'recording' && !v.round) actions.push(btn(`Send what was logged (${v.count})`, 'send', true));
    if (v.phase === 'recording' && v.round) actions.push(btn("It's fixed: take the logging out", 'fixed', true), btn(`Still broken: send the logs (${v.count})`, 'send'));
    if (v.phase === 'leftovers') actions.push(btn('Ask Claude to take them out', 'again', true), btn('Leave them', 'stop'));
    else if (LIVE.has(v.phase)) actions.push(btn('Stop debugging', 'stop'));
    const left = v.leftovers.length ? h('ul', { class: 'debug-left' }, v.leftovers.map(l => h('li', {},
      SB.fileLink(l.file, { line: l.line, text: `${l.file}:${l.line}` }),
      h('code', { text: l.text }))), v.leftoversMore ? h('li', { class: 'muted', text: `and ${v.leftoversMore} more` }) : null) : null;
    return h('section', { class: `debug-card phase-${v.phase}`, 'data-debug': v.id, 'aria-label': `Debug mode: ${v.bug}` },
      h('div', { class: 'debug-head' },
        h('span', { class: 'chg-icon', 'aria-hidden': 'true', text: '🐞' }),
        h('span', { class: 'debug-title', text: `Debug mode: ${v.bug}` }),
        v.round && v.phase === 'recording' ? h('span', { class: 'kind-pill', text: `try ${v.round + 1}` }) : null),
      h('p', { class: 'debug-says', text: says(v) }),
      v.phase === 'recording' ? h('div', { class: 'debug-rec' },
        h('div', { class: 'small', 'aria-live': 'polite' }, h('span', { class: 'debug-dot', 'aria-hidden': 'true' }), ` Listening · ${lines}`),
        v.preview.length ? h('ol', { class: 'debug-lines' }, v.preview.map(t => h('li', { text: t }))) : null) : null,
      left,
      v.phase === 'recording' && !v.count ? h('p', { class: 'small muted', text: 'Nothing yet? Make sure the app is running the code Claude changed (a refresh, or a rebuild).' }) : null,
      actions.length ? h('div', { class: 'debug-actions' }, actions) : null);
  }

  // A newer card for the same debug session goes to the end, where you'll see it.
  SB.renderDebug = (tab, item, replay = false) => {
    for (const was of cards(tab)) if (was.dataset.debug === item.id) was.remove();
    const el = cardEl(item);
    tab.append(el);
    // Replayed mid-way: ask whether it's still going (Shellby may have closed since).
    if (replay && LIVE.has(item.phase)) {
      api.debug.status(item.id).then(live => {
        if (!el.isConnected) return;
        el.replaceWith(cardEl(live || { ...item, phase: 'stale', leftovers: [] }));
      }).catch(() => {});
    }
    return el;
  };

  api.debug.onLines(({ tabId, view }) => {
    const tab = state.tabs.get(tabId);
    const was = tab && cards(tab).find(el => el.dataset.debug === view.id);
    if (was) was.replaceWith(cardEl(view));
  });
})();
