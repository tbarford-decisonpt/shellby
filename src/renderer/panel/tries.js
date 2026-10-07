/* Shellby panel — Try it N ways (src/main/wiring/tries.js).
 *
 * The same message in 2-4 new tabs, each in its own copy of the project. Two
 * ways in, both explicit: /tries 3 <message>, or right-click the send button.
 * Main always asks first in the isolated confirmation window, with what it
 * usually costs; nothing here can start one without that.
 *
 * Once they're done, a card in the first try's tab ranks them, with Open,
 * Compare (with the one on top) and Keep this one on each. The card arrives
 * as a transcript item every time it changes, and is swapped in place. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const input = $('input');
  const WAYS = [2, 3, 4];

  // ------------------------------------------------------------ starting

  // /tries has already emptied the box: what was attached goes back if they don't start.
  function giveBack(tab, files) {
    if (!files.length || tab.attachments?.length) return;
    tab.attachments = [...files];
    if (SB.activeTab() === tab) SB.renderAttachments?.();
  }
  SB.giveBackAttachments = giveBack;

  // { n, text } from the box (fromBox), or { arg } as typed after /tries.
  // attachments: what /tries carried (fromBox takes the box's own). Every try gets them all.
  // -> true once they've started.
  SB.startTries = async (tab, { n = null, text = '', arg = null, fromBox = false, attachments = [] } = {}) => {
    if (!tab) return false;
    const msg = String(text || '').trim();
    if (arg == null && !msg) { SB.toast('Type what he should try first, then pick how many ways.'); return false; }
    if (tab.triesStarting) return false;
    tab.triesStarting = true;
    const files = fromBox ? [...(tab.attachments || [])] : [...attachments];
    let r;
    try {
      r = await api.startTries(tab.id, arg != null ? { arg, attachments: files } : { n, text: msg, attachments: files });
    } finally { tab.triesStarting = false; }
    if (!r?.ok && !fromBox) giveBack(tab, files);
    if (r?.cancelled) { SB.toast('Not tried. Nothing was sent.'); return false; }
    if (!r?.ok) { SB.toast(r?.error || "Couldn't start the tries.", { ms: 9000 }); return false; }
    // The message has gone (n times): out of the box it came from.
    if (fromBox) {
      if (SB.activeTab() === tab && input.value.trim() === msg) SB.clearComposer(tab);
      else if ((tab.draft || '').trim() === msg) tab.draft = '';
    }
    if (state.tabs.has(r.firstId)) SB.activate(r.firstId);
    const said = r.error || `Trying it ${r.started} ways. He'll rank them here once they're all done.`;
    SB.toast(r.note ? `${said} ${r.note}` : said, { ms: r.error || r.note ? 9000 : 6000 });
    return true;
  };

  // The send button's menu (right-click, or the context-menu key).
  $('sendBtn').addEventListener('contextmenu', e => {
    e.preventDefault();
    const tab = SB.activeTab();
    if (!tab) return;
    const text = input.value.trim();
    const menu = $('rewindMenu');
    SB.openMenu(menu, $('form'), () => [
      h('div', { class: 'menu-label', text: 'Send it several ways' }),
      ...WAYS.map(n => h('button', { class: 'menu-item', disabled: !text, onclick: () => { SB.closeMenus(); SB.startTries(tab, { n, text: input.value, fromBox: true }); } },
        h('span', { class: 'mi-check', text: '⑂' }),
        h('span', {},
          h('div', { class: 'mi-title', text: `Try it ${n} ways…` }),
          h('div', { class: 'mi-sub', text: text ? `The same message in ${n} new tabs, each in its own copy. Asks first, with what it usually costs` : 'Type a message first' })))),
      h('div', { class: 'small muted menu-note', text: 'Each try is a full task. He ranks them when they finish; you pick which to keep.' }),
    ]);
    if (menu.hidden) return;
    const r = $('form').getBoundingClientRect();
    menu.style.top = `${Math.max(8, r.top - menu.offsetHeight - 8)}px`;
    menu.style.left = `${Math.max(8, r.right - menu.offsetWidth)}px`;
  });

  // ------------------------------------------------------------ the card

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const cards = tab => [...tab.el.querySelectorAll('.tries-card')];

  function verdict(row) {
    if (row.state === 'running') return { icon: '…', text: 'working', tone: 'busy' };
    if (row.state === 'checking') return { icon: '…', text: 'running its tests', tone: 'busy' };
    if (row.state === 'stopped') return { icon: '■', text: 'stopped', tone: 'warn' };
    if (row.state === 'failed') return { icon: '⚠', text: 'went wrong', tone: 'fail' };
    if (row.state === 'gone') return { icon: '✕', text: 'closed', tone: 'warn' };
    if (!row.files) return { icon: '·', text: 'changed nothing', tone: 'warn' };
    if (row.checks === 'pass') return { icon: '✅', text: 'checks pass', tone: 'pass' };
    if (row.checks === 'fail') return { icon: '❌', text: row.failing ? `${row.failing} failing` : 'checks fail', tone: 'fail' };
    if (row.checks === 'timeout') return { icon: '❌', text: 'tests ran out of time', tone: 'fail' };
    if (row.checks === 'none') return { icon: '·', text: 'no tests found', tone: 'muted' };
    if (row.checks === 'declined') return { icon: '·', text: 'tests not run', tone: 'muted' };
    return { icon: '·', text: 'not checked', tone: 'muted' };
  }

  function open(row) {
    if (state.tabs.has(row.tabId)) SB.activate(row.tabId);
    else SB.openHistory?.(row.tabId);
  }

  function compare(row, lead) {
    const tab = state.tabs.get(row.tabId);
    if (!tab) return SB.toast('Open it first, then compare.');
    SB.activate(row.tabId);
    SB.compareWith?.(tab, { id: lead.tabId, title: lead.title });
  }

  function keep(row) {
    const tab = state.tabs.get(row.tabId);
    if (!tab) return SB.toast('Open it first, then keep it.');
    SB.activate(row.tabId);
    SB.keepThisOne?.(tab);
  }

  function rowEl(row, item, lead) {
    const v = verdict(row);
    const size = row.files ? `${plural(row.files, 'file')} · +${row.added || 0} −${row.removed || 0}` : '';
    const btn = (label, onclick, extra = {}) => h('button', { type: 'button', class: 'btn ghost slim-btn', onclick, ...extra }, label);
    return h('li', { class: `tries-row ${v.tone}` },
      item.final ? h('span', { class: 'tries-place', 'aria-label': `Place ${row.place}`, text: String(row.place) }) : null,
      h('div', { class: 'tries-main' },
        h('div', { class: 'tries-title', text: row.title }),
        h('div', { class: 'tries-facts small' },
          h('span', { class: `tries-verdict ${v.tone}` }, h('span', { 'aria-hidden': 'true', text: v.icon }), ` ${v.text}`),
          size ? h('span', { class: 'muted', text: size }) : null,
          row.durationMs != null ? h('span', { class: 'muted', text: SB.duration(row.durationMs) }) : null)),
      item.final ? h('div', { class: 'tries-actions' },
        btn('Open', () => open(row)),
        row.tabId !== lead?.tabId ? btn('Compare', () => compare(row, lead), { title: `What it has that "${lead.title}" doesn't` }) : null,
        btn('Keep this one', () => keep(row), { title: 'Bring it home and throw the other tries away (asks first)' })) : null);
  }

  function cardEl(item, { stale = false } = {}) {
    const rows = item.rows || [];
    const lead = item.final ? rows[0] : null;
    const working = !item.final && !stale;
    const head = item.final
      ? `Tried it ${item.n} ways: "${item.title}"`
      : stale ? `Tried it ${item.n} ways: "${item.title}" (Shellby closed before they all finished)` : `Trying it ${item.n} ways: "${item.title}"…`;
    return h('section', { class: `tries-card${item.final ? ' final' : ''}`, 'data-run': item.runId, 'aria-label': head },
      h('div', { class: 'tries-head' }, h('span', { class: 'chg-icon', 'aria-hidden': 'true', text: '⑂' }), h('span', { text: head })),
      h('ol', { class: 'tries-rows' }, rows.map(r => rowEl(r, item, lead))),
      item.final
        ? h('p', { class: 'small muted tries-note', text: 'Best first: checks passing, then fewer failing, then the smaller change, then the quicker. Nothing is kept or thrown away until you pick.' })
        : working ? h('div', { class: 'tries-foot' },
          h('span', { class: 'small muted', text: "He'll run each one's tests as it finishes, then rank them." }),
          h('button', { type: 'button', class: 'btn ghost slim-btn', onclick: e => stopAll(item.runId, e.currentTarget) }, 'Stop all tries')) : null);
  }

  async function stopAll(runId, button) {
    button.disabled = true;
    const r = await api.stopTries(runId);
    if (!r?.ok) { button.disabled = false; return SB.toast(r?.error || "Couldn't stop them."); }
    SB.toast(r.stopped ? `Stopping ${plural(r.stopped, 'try')}.` : 'Nothing left to stop.');
  }

  // A newer card for the same run replaces the old one; the finished one goes
  // to the end of the conversation, where you'll see it.
  SB.renderTries = (tab, item, replay = false) => {
    const was = cards(tab).find(el => el.dataset.run === item.runId);
    const el = cardEl(item);
    if (was && !item.final) { was.replaceWith(el); return el; }
    was?.remove();
    tab.append(el);
    // Replayed mid-run: ask whether it's still going (Shellby may have closed since).
    if (replay && !item.final) {
      api.triesStatus(item.runId).then(live => {
        if (!el.isConnected) return;
        el.replaceWith(live ? cardEl(live) : cardEl(item, { stale: true }));
      }).catch(() => {});
    }
    return el;
  };

  api.onTriesDone?.(({ firstId, text }) => {
    SB.toast(text, { ms: 10000, action: 'Show me', onAction: () => { if (state.tabs.has(firstId)) SB.activate(firstId); else SB.openHistory?.(firstId); } });
  });
})();
