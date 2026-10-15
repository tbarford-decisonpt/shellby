/* Shellby panel — Ultracode (src/main/ultracode.js, docs/ULTRACODE.md).
 *
 * The chip under the box turns it on for one conversation: what you send there
 * gets the word "ultracode" on the end, in plain sight, which is how Claude
 * Code lets a turn start a Workflow run of many agents. The first one in a
 * conversation asks in the confirm window, with a rough idea of the cost.
 *
 * A run is a card in the feed, updated in place: its phases, how many agents
 * are running and done, how long it's been going, what it has cost at the
 * least, Stop, and how it ended. Not Shellby's own workflows (Automate). */
'use strict';
(function () {
  const { h, api, $ } = SB;
  const U = window.ShellbyUltracode;

  const STATUS = { running: 'running', completed: 'done', failed: 'failed', stopped: 'stopped' };
  const AGENT_STATE = { start: 'running', progress: 'running', done: 'done', error: 'failed' };
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const cards = tab => [...tab.el.querySelectorAll('.ultra-card')];

  // ------------------------------------------------------------ the chip

  SB.renderUltraChip = tab => {
    const on = !!tab?.ultracode;
    $('ultraChip').classList.toggle('on', on);
    $('ultraChip').setAttribute('aria-pressed', String(on));
    $('ultraNote').hidden = !on;
  };

  $('ultraChip').addEventListener('click', () => {
    const tab = SB.activeTab();
    if (!tab) return;
    tab.ultracode = !tab.ultracode;
    SB.renderUltraChip(tab);
    $('input').focus();
  });

  // -> the words to send, or null when you said no in the confirm window.
  // The word typed with the chip off asks too: Claude Code acts on it all the same.
  SB.ultraWords = async (tab, text) => {
    // A /command or a ! command takes no word on the end: it would become its argument.
    if (/^[/!]/.test(text)) return text;
    if (!tab.ultracode && !U.hasKeyword(text)) return text;
    if (!tab.ultracodeOk) {
      // A second Enter while the confirm window is up would ask twice.
      if (tab.ultracodeAsking) return null;
      tab.ultracodeAsking = true;
      let r;
      try { r = await api.confirmUltracode(tab.id); } finally { tab.ultracodeAsking = false; }
      if (!r?.ok) {
        if (r?.error) SB.toast(r.error);
        return null;
      }
      tab.ultracodeOk = true;
    }
    return tab.ultracode ? U.withKeyword(text) : text;
  };

  // ------------------------------------------------------------ the card

  const elapsed = v => SB.clock((v.endedAt || Date.now()) - v.startedAt);

  function says(v) {
    if (v.status === 'running') return v.counts.total ? '' : 'Claude has started the run. Its agents show up here as they go.';
    if (v.closed) return 'This conversation closed while the run was going, so it stopped.';
    if (v.status === 'completed') return '';
    if (v.status === 'failed') return v.error || 'The run failed.';
    return 'Stopped. Claude can pick it up again from where it got to.';
  }

  async function stop(tab, v, button) {
    button.disabled = true;
    const r = await api.stopUltracode(tab.id, v.id).catch(() => null);
    if (!r?.ok) { button.disabled = false; SB.toast(r?.error || "Couldn't stop the run."); }
  }

  function countsLine(v) {
    const c = v.counts;
    const parts = [`${c.running} running`, `${c.done} done`];
    if (c.failed) parts.push(`${c.failed} failed`);
    return parts.join(' · ');
  }

  function cardEl(tab, v) {
    const live = v.status === 'running';
    const phases = v.phases.length ? h('ol', { class: 'ultra-phases' }, v.phases.map(p => h('li', { class: p.running ? 'now' : p.total && p.done + p.failed === p.total ? 'done' : '' },
      h('span', { class: 'ultra-phase-title', text: p.title }),
      p.total ? h('span', { class: 'muted', text: ` ${p.done}/${p.total}` }) : null))) : null;
    const agents = v.agents.length ? h('ul', { class: 'ultra-agents' },
      v.agents.map(a => h('li', { class: `ultra-agent ${AGENT_STATE[a.state] || ''}` },
        h('span', { class: 'ultra-agent-state', text: AGENT_STATE[a.state] || a.state }),
        h('span', { class: 'ultra-agent-label', text: a.label, title: a.error || a.label }))),
      v.moreAgents ? h('li', { class: 'muted', text: `and ${v.moreAgents} more` }) : null) : null;
    const crabs = live && v.crabsOut ? h('p', { class: 'small muted ultra-crabs', text: `${plural(v.crabsOut, 'helper crab')} out on your desktop${v.crabsMore ? `, +${v.crabsMore} more` : ''}` }) : null;
    const said = says(v);
    return h('section', { class: `ultra-card status-${v.status}`, dataset: { run: v.id, started: String(v.startedAt), ...(v.endedAt ? { ended: String(v.endedAt) } : {}) }, 'aria-label': `Ultracode run: ${v.name}` },
      h('div', { class: 'ultra-head' },
        h('span', { class: 'chg-icon', 'aria-hidden': 'true', text: '⚡' }),
        h('span', { class: 'ultra-title', text: `Ultracode run: ${v.name}` }),
        h('span', { class: 'kind-pill ultra-status', text: STATUS[v.status] || v.status })),
      v.description ? h('p', { class: 'ultra-desc', text: v.description }) : null,
      h('p', { class: 'ultra-stats small' },
        h('span', { class: 'ultra-counts', text: countsLine(v) }), ' · ',
        h('span', { class: 'ultra-elapsed', text: elapsed(v) }),
        v.tokens ? ` · ${SB.compact(v.tokens)} tokens` : '', ' · ',
        h('span', { class: 'ultra-cost', title: "Claude Code reports a run's tokens but not their price, so this is what they cost at the least", text: v.costText })),
      phases, crabs, agents,
      said ? h('p', { class: 'ultra-says', text: said }) : null,
      !live && v.summary ? h('p', { class: 'ultra-summary', text: v.summary }) : null,
      live ? h('div', { class: 'ultra-actions' }, h('button', { type: 'button', class: 'btn ghost slim-btn ultra-stop', onclick: e => stop(tab, v, e.currentTarget) }, 'Stop the run')) : null);
  }

  // A newer card for the same run takes the old one's place, where it was.
  SB.renderUltracode = (tab, item, replay = false) => {
    const el = cardEl(tab, item);
    const was = cards(tab).find(c => c.dataset.run === item.id);
    if (was) was.replaceWith(el); else tab.append(el);
    // Replayed still running: ask whether it is (the conversation may have closed since).
    if (replay && item.status === 'running') {
      api.ultracodeStatus(tab.id, item.id).then(now => {
        if (!el.isConnected) return;
        // When it was last saved is as near as anyone knows to when it stopped.
        el.replaceWith(cardEl(tab, now || { ...item, status: 'stopped', closed: true, endedAt: item.t || item.startedAt }));
      }).catch(() => {});
    }
    tick();
    return el;
  };

  // The clock on running cards: one timer, alive only while one is on screen.
  let timer = null;
  function tick() {
    const running = [...document.querySelectorAll('.ultra-card.status-running')];
    for (const c of running) {
      const t = c.querySelector('.ultra-elapsed');
      if (t) t.textContent = SB.clock(Date.now() - Number(c.dataset.started));
    }
    if (running.length && !timer) timer = setInterval(tick, 1000);
    if (!running.length && timer) { clearInterval(timer); timer = null; }
  }
})();
