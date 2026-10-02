/* Shellby panel — "While you were away". When you come back after an hour or
   more, main sends a digest (src/main/recap.js): what finished, what failed,
   what's waiting on you and where the 5-hour window went. It waits above the
   composer until you dismiss it; a newer one replaces it. */
'use strict';
(function () {
  const { h } = SB;

  const host = h('div', { class: 'recap-host' });
  document.body.append(host);

  const WAITING = { question: 'has a question', plan: 'has a plan for you to approve', approval: 'needs your OK' };

  function awayFor(ms) {
    const m = Math.max(0, Math.round(ms / 60000));
    if (m >= 48 * 60) return `${Math.floor(m / (24 * 60))} days`;
    const hrs = Math.floor(m / 60), r = m % 60;
    return hrs ? (r ? `${hrs}h ${String(r).padStart(2, '0')}m` : `${hrs}h`) : `${m}m`;
  }
  const clock = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  // A row opens its conversation when there is one to open (a closed tab comes back from History).
  function row(r, sub, cls) {
    const body = [h('b', { text: r.title }), sub ? h('small', { text: sub }) : null];
    if (!r.tabId) return h('li', { class: `recap-row ${cls}` }, h('span', { class: 'recap-row-body' }, ...body));
    return h('li', { class: `recap-row ${cls}` },
      h('button', { type: 'button', class: 'recap-row-body', title: 'Open this conversation', onclick: () => { dismiss(); SB.openHistory(r.tabId); } }, ...body));
  }

  function section(icon, label, list, render) {
    const n = list.items.length + list.more;
    if (!n) return null;
    return h('section', { class: 'recap-sec' },
      h('h4', {}, h('span', { class: 'recap-ico', 'aria-hidden': 'true', text: icon }), `${label} `, h('span', { class: 'recap-n', text: String(n) })),
      h('ul', { class: 'recap-list' }, list.items.map(render),
        list.more ? h('li', { class: 'recap-more', text: `and ${list.more} more in History` }) : null));
  }

  function runSub(r) {
    const bits = [];
    if (r.routine) bits.push('Routine');
    if (r.runs > 1) bits.push(`${r.runs} runs`);
    bits.push(clock(r.at));
    return bits.join(' · ');
  }

  function usageBlock(u, limit) {
    if (!u && !limit) return null;
    const parts = [];
    if (u) {
      const line = u.spent
        ? `About ${u.spent}% of your 5-hour window went while you were out${u.rolledOver ? ' (it reset in between)' : ` (${u.from}% → ${u.to}%)`}.`
        : 'The 5-hour window reset while you were out.';
      parts.push(h('p', { class: 'recap-text', text: line }));
      if (u.by.length) {
        parts.push(h('div', { class: 'recap-bar', 'aria-hidden': 'true' },
          u.by.map((b, i) => h('i', { class: `seg-${i % 4}`, style: `flex-grow: ${b.pct}` }))));
        parts.push(h('ul', { class: 'recap-usage' }, u.by.map((b, i) =>
          h('li', {}, h('span', { class: `recap-key seg-${i % 4}`, 'aria-hidden': 'true' }), h('span', { class: 'recap-uname', text: b.title }), h('span', { class: 'recap-pct', text: `${b.pct}%` })))));
      }
    }
    if (limit) {
      parts.push(h('p', { class: 'recap-text recap-limit', text: `You're at your ${limit.window === 'sevenDay' ? 'weekly' : '5-hour'} limit. It resets at ${clock(limit.resetsAt)}.` }));
    } else if (u?.resetsAt && u.spent) {
      parts.push(h('p', { class: 'recap-text muted', text: `It resets at ${clock(u.resetsAt)}. Figures are approximate: Claude Code used elsewhere fills the same window.` }));
    }
    return h('section', { class: 'recap-sec' },
      h('h4', {}, h('span', { class: 'recap-ico', 'aria-hidden': 'true', text: '◔' }), 'Usage'), ...parts);
  }

  function card(d) {
    return h('section', { class: 'recap', role: 'region', 'aria-label': 'While you were away' },
      h('p', { class: 'cel-eyebrow', text: `While you were away · ${awayFor(d.awayMs)}` }),
      h('h3', { class: 'recap-title', text: `Since ${clock(d.since)}` }),
      h('div', { class: 'recap-body' },
        section('?', 'Waiting on you', d.waiting, w => row(w, w.external ? `${WAITING[w.what] || WAITING.approval} (outside Shellby)` : WAITING[w.what] || WAITING.approval, 'wait')),
        section('✕', 'Failed', d.failed, r => row(r, r.error ? `${r.error}` : runSub(r), 'fail')),
        section('✓', 'Finished', d.finished, r => row(r, runSub(r), 'ok')),
        usageBlock(d.usage, d.limit)),
      h('div', { class: 'cel-actions' },
        h('button', { class: 'btn primary slim-btn', type: 'button', onclick: dismiss }, 'Got it')),
      h('button', { class: 'cel-close icon-btn', type: 'button', 'aria-label': 'Dismiss', onclick: dismiss },
        SB.icon('M4.5 4.5l7 7M11.5 4.5l-7 7', { width: 1.5 })));
  }

  function dismiss() {
    const el = host.firstElementChild;
    if (!el) return;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  }

  /** d: a digest from recap.build(). */
  SB.showRecap = d => host.replaceChildren(card(d));
  SB.dismissRecap = dismiss;
})();
