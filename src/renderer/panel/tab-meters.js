/* Shellby panel — how full each conversation's context is (the tab's hairline,
   the context chip, the crowded note) and the usage meter. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const { syncBusyUi } = SB; // tabs.js

  // ------------------------------------------------------------ how full each conversation is

  // Past CROWDED (src/main/context.js) he says so, and the composer offers to
  // make room; a little before, when the last few turns say it'll be crowded
  // within a couple more, it offers the same, worded for that (src/main/turncost.js
  // nudge). Dismissing it holds until it's worded differently or goes away.
  const CROWDED = 80;
  const contextLevel = c => (c.pct >= 95 ? 'hot' : c.pct >= CROWDED ? 'warn' : '');
  const contextText = c => `Context ${c.pct}% full · ${SB.compact(c.tokens)} of ${SB.compact(c.window)} tokens`;

  // The prompt cache, as efficiency.js cacheState() reads it: warm, cooling in
  // its last fifth, or cold. Only ever shown, never acted on: a cold cache just
  // means the next reply re-reads the conversation at full price once.
  const CACHE_TTL = 5 * 60 * 1000;
  const COOLING_SHARE = 0.2;
  function cacheNow(cache) {
    if (!cache || !Number.isFinite(cache.at)) return null;
    const ttl = cache.ttlMs > 0 ? cache.ttlMs : CACHE_TTL;
    const left = cache.at + ttl - Date.now();
    return { state: left <= 0 ? 'cold' : left <= ttl * COOLING_SHARE ? 'cooling' : 'warm', mins: Math.max(1, Math.ceil(left / 60000)) };
  }
  function cacheText(k, c) {
    const whole = c ? `the whole conversation (${SB.compact(c.tokens)} tokens)` : 'the whole conversation';
    if (k.state === 'warm') return `Prompt cache warm for about ${k.mins} more min: each reply re-reads the conversation at a tenth of the price.`;
    if (k.state === 'cooling') return `Prompt cache cools in about ${k.mins} min. After that, the next message re-reads ${whole} at full price, once.`;
    return `Prompt cache has cooled: the next message re-reads ${whole} at full price, once, and then it's warm again.`;
  }

  function syncContextUi() {
    const tab = SB.activeTab();
    const c = tab?.context;
    const chip = $('ctxChip');
    chip.hidden = !c;
    if (c) {
      chip.className = `ctx-chip ${contextLevel(c)}`;
      chip.querySelector('.meter-fill').style.transform = `scaleX(${c.pct / 100})`;
      $('ctxLabel').textContent = `${c.pct}%`;
      const k = cacheNow(tab.cache);
      chip.dataset.cache = k ? k.state : '';
      chip.title = k ? `${contextText(c)}\n${cacheText(k, c)}` : contextText(c);
      chip.setAttribute('aria-label', `${contextText(c)}${k ? `, prompt cache ${k.state}` : ''}: make room`);
    }
    const nudge = c ? tab.nudge : null;
    if (tab && !nudge) tab.crowdDismissed = null;
    const box = $('crowded');
    // A dismissed "filling up" still lets "getting crowded" through.
    const show = !!nudge && tab.crowdDismissed !== nudge.level;
    box.hidden = !show;
    if (!show) { box.replaceChildren(); return; }
    box.className = `crowded ${nudge.level}`;
    box.replaceChildren(
      h('span', { class: 'crowded-text', text: nudge.text }),
      h('button', { class: 'btn slim-btn', type: 'button', onclick: () => compact(tab) }, 'Compact'),
      h('button', { class: 'btn ghost slim-btn', type: 'button', onclick: () => startFresh(tab) }, 'Start fresh with a summary'),
      h('button', { class: 'queue-x icon-btn', type: 'button', 'aria-label': 'Not now', title: 'Not now', onclick: () => { tab.crowdDismissed = nudge.level; syncContextUi(); } },
        SB.icon('M4.5 4.5l7 7M11.5 4.5l-7 7', { width: 1.5 })));
  }
  SB.syncContextUi = syncContextUi;
  SB.contextText = contextText;   // the tab's tooltip (tabs.js)
  SB.contextLevel = contextLevel; // and its hairline's colour
  // The cache dot cools on its own between replies.
  setInterval(() => { if (SB.activeTab()?.cache && !document.hidden) syncContextUi(); }, 20000);

  // Claude Code's own /compact: it sums the conversation up in place and carries on.
  function compact(tab) {
    if (tab.busy) return SB.toast('Let him finish first.');
    SB.activate(tab.id);
    SB.send('/compact');
  }

  // Claude writes a handoff summary, then the tab starts a new conversation with it.
  async function startFresh(tab) {
    if (tab.busy) return SB.toast('Let him finish first.');
    const r = await api.freshTab(tab.id);
    if (!r?.ok) return SB.toast(r?.error || "Couldn't start fresh.");
    tab.render({ kind: 'user', text: r.text });
    tab.busy = true;
    tab.busySince = Date.now();
    tab.statusText = 'Writing a summary…';
    if (tab.isActive) syncBusyUi();
    SB.renderTabStrip();
  }
  SB.compactTab = compact;
  SB.startFresh = startFresh;

  // What this conversation has cost so far (src/main/turncost.js): tokens, its
  // share of the 5-hour window, and its costliest turns, each a way back to it.
  function costRows(tab, cost) {
    if (!cost?.turns) return [];
    const turns = `${cost.turns} turn${cost.turns === 1 ? '' : 's'}`;
    const share = cost.shareText ? ` · ${cost.shareText} of your 5-hour window` : '';
    const rows = [h('div', { class: 'menu-label cache-note', text: `So far: ${cost.tokensText} tokens over ${turns}${share}.` })];
    if (cost.top.length < 2) return rows;
    rows.push(h('div', { class: 'menu-label', text: 'Costliest turns' }),
      ...cost.top.map(t => h('button', {
        class: 'menu-item cost-turn', disabled: !t.turnId, title: t.turnId ? 'Show this turn' : null,
        onclick: () => { SB.closeMenus(); showTurn(tab, t.turnId); },
      },
      h('span', { class: 'usage-name', text: t.prompt || 'A turn' }),
      h('span', { class: 'usage-share', text: [t.tokensText, t.shareText].filter(Boolean).join(' · ') }))));
    return rows;
  }

  function showTurn(tab, turnId) {
    const el = turnId && [...tab.el.querySelectorAll('.turn-cost')].find(c => c.dataset.turn === turnId);
    if (!el) return SB.toast("That turn is further back than this tab keeps. It's in History.");
    el.scrollIntoView({ block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1600);
  }

  let costLoading = false;
  $('ctxChip').addEventListener('click', async () => {
    const tab = SB.activeTab();
    const c = tab?.context;
    if (!c) return;
    if (!$('ctxMenu').hidden) return SB.closeMenus();
    if (costLoading) return; // a second click while it loads would open and shut it at once
    costLoading = true;
    const cost = await api.tabCost(tab.id).catch(() => null);
    costLoading = false;
    const k = cacheNow(tab.cache);
    SB.openMenu($('ctxMenu'), $('ctxChip'), () => [
      h('div', { class: 'menu-label', text: contextText(c) }),
      k ? h('div', { class: `menu-label cache-note c-${k.state}`, text: cacheText(k, c) }) : null,
      ...costRows(tab, cost),
      h('div', { class: 'menu-sep' }),
      h('button', { class: 'menu-item', onclick: () => { SB.closeMenus(); compact(tab); } },
        h('span', { class: 'mi-check', text: '⇣' }),
        h('span', {}, h('div', { class: 'mi-title', text: 'Compact' }), h('div', { class: 'mi-sub', text: 'Claude sums up the conversation so far and carries on in the room it frees' }))),
      h('button', { class: 'menu-item', onclick: () => { SB.closeMenus(); startFresh(tab); } },
        h('span', { class: 'mi-check', text: '↻' }),
        h('span', {}, h('div', { class: 'mi-title', text: 'Start fresh with a summary' }), h('div', { class: 'mi-sub', text: 'Claude writes a handoff note, then a new conversation picks it up in this tab' }))),
    ]);
  });

  // ------------------------------------------------------------ usage meter

  let lastUsage = null;
  SB.applyUsage = (u) => {
    if (!u || (!u.fiveHour && !u.sevenDay)) return;
    lastUsage = u;
    $('usage').hidden = false;
    const set = (el, win, name, pace = null) => {
      if (!win) { el.hidden = true; return; }
      el.hidden = false;
      el.querySelector('.meter-fill').style.transform = `scaleX(${Math.min(100, win.pct) / 100})`;
      // On pace to fill before it resets is as worth a glance as nearly full (forecast.js).
      el.classList.toggle('warn', (win.pct >= 70 || !!pace?.warn) && win.pct < 90);
      el.classList.toggle('hot', win.pct >= 90);
      const reset = win.resetsAt ? ` · resets ${new Date(win.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : '';
      const fills = pace && pace.hitAt < pace.resetsAt ? ` · at this pace, full around ${pace.hitText}` : '';
      el.title = `${name} usage: ${win.pct}%${reset}${fills}`;
    };
    set($('meter5h'), u.fiveHour, '5-hour', state.outlook?.pace);
    set($('meter7d'), u.sevenDay, 'Weekly');
  };
  // A new forecast changes what the 5-hour meter says.
  SB.refreshUsage = () => SB.applyUsage(lastUsage);

  // Who used it: each window's split by tab and routine, or by project (src/main/spend.js).
  let usageBy = 'task';
  const pctText = share => (share >= 0.995 ? '100%' : share < 0.01 ? '<1%' : `${Math.round(share * 100)}%`);

  function usageRows(windows) {
    const toggle = h('div', { class: 'usage-by', role: 'group', 'aria-label': 'Group by' },
      ...[['task', 'Tabs & routines'], ['project', 'Projects']].map(([by, text]) => h('button', {
        type: 'button', class: `usage-by-btn${usageBy === by ? ' on' : ''}`, 'aria-pressed': String(usageBy === by), text,
        onclick: () => { usageBy = by; $('usageMenu').replaceChildren(...usageRows(windows)); $('usageMenu').querySelector('.usage-by-btn.on')?.focus(); },
      })));
    const sections = windows.map(w => {
      const rows = usageBy === 'project' ? w.projects : w.tasks;
      const head = h('div', { class: 'menu-label', text: `${w.name}${w.pct != null ? ` · ${w.pct}% used` : ''}` });
      if (!rows.length) return [head, h('div', { class: 'usage-empty', text: 'Nothing Shellby ran in this window yet.' })];
      return [head, ...rows.map(r => h('div', { class: `usage-row kind-${r.kind}`, title: r.detail ? SB.tildify(r.detail) : r.label },
        h('span', { class: 'usage-name', text: r.kind === 'routine' ? `⟳ ${r.label}` : r.label }),
        h('span', { class: 'usage-bar' }, h('span', { class: 'usage-bar-fill', style: `transform: scaleX(${r.share})` })),
        h('span', { class: 'usage-share', text: pctText(r.share) })))];
    });
    return [toggle, ...sections.flat(), h('div', { class: 'menu-sep' }),
      h('div', { class: 'usage-empty', text: 'Shares of what Shellby ran. Claude used elsewhere fills the meters too.' })];
  }

  let usageLoading = false;
  $('usage').addEventListener('click', async () => {
    const menu = $('usageMenu');
    if (!menu.hidden) return SB.closeMenus();
    if (usageLoading) return; // a second click while it loads would open and shut it at once
    usageLoading = true;
    const windows = await api.usageBreakdown().catch(() => []);
    usageLoading = false;
    SB.openMenu(menu, $('usage'), () => usageRows(windows));
  });

  // The plan's usage limit: Shellby naps until it resets, then says so (src/main/limits.js).
  api.onLimit(e => {
    if (e.phase === 'hit') SB.toast(`Your ${e.name} Claude limit is reached. Shellby will tap you when it resets, ${e.at}.`, { ms: 8000 });
    if (e.phase === 'reset') SB.toast(`Your ${e.name} limit just reset. Go ahead!`, { ms: 6000 });
  });
})();
