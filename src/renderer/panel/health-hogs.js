/* Shellby panel — Health: what's using the machine (and ending it), Shellby's
   own share, and what starts with Windows. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const L = window.ShellbyHealthLogic;
  const H = SB.health;
  const { setText } = H;

  const HOGS_REFRESH_MS = 30 * 1000; // the process list is a ~3 s read; don't add to the heat
  let hogs = null;                   // { ok, metric, procs, groups } from main
  let hogsAt = 0;
  let hogsLoading = false;
  let hogsAgain = false;             // a read was asked for while one was out: do one more
  let hogsOpen = false;              // opened by hand (it also opens itself while he sweats)
  let hogMetric = null;              // the user's pick; null follows the mood
  let hogMode = 'app';               // 'app' adds processes up by name, 'proc' lists each
  let drawnHogs = null;              // what the list shows, so 5 s samples don't rebuild it
  let startup = null;                // { ok, items } from main

  // ------------------------------------------------------------ what's using it

  // While he sweats or is dizzy the list opens itself: "why?" is the next question.
  function renderHogs() {
    const view = H.view();
    const enabled = !!view?.settings?.enabled;
    $('hlHogs').hidden = !enabled;
    const auto = enabled ? L.hogsAuto(view) : null;
    if (!auto && !hogsOpen) hogMetric = null;
    const open = enabled && (hogsOpen || !!auto);
    $('hlHogs').dataset.open = String(open);
    $('hlHogsOpen').hidden = open;
    for (const id of ['hlHogsSeg', 'hlHogsGroup', 'hlHogsRefresh', 'hlHogList', 'hlHogsAskRow', 'hlHogsFine']) $(id).hidden = !open;
    $('hlHogsClose').hidden = !open || !!auto;
    setText($('hlHogsTitle'), auto ? "What's hogging it" : "What's using it");
    if (!open) { drawnHogs = null; return; }

    const metric = hogMetric || auto || 'cpu';
    const noGpu = hogs?.procs?.length > 0 && hogs.procs.every(p => p.gpu == null);
    for (const b of $('hlHogsSeg').querySelectorAll('button')) {
      b.setAttribute('aria-selected', String(b.dataset.metric === metric));
      b.hidden = b.dataset.metric === 'gpu' && noGpu;
    }
    for (const b of $('hlHogsGroup').querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.group === hogMode));
    if (hogs?.metric !== metric || Date.now() - hogsAt > HOGS_REFRESH_MS) loadHogs(metric);
    const list = $('hlHogList');
    if (!hogs || hogs.metric !== metric) {
      drawnHogs = null;
      list.replaceChildren(h('li', { class: 'hl-empty', text: "Looking at what's running…" }));
      return;
    }
    if (drawnHogs?.hogs === hogs && drawnHogs.mode === hogMode) return;
    drawnHogs = { hogs, mode: hogMode };
    if (!hogs.ok) return list.replaceChildren(h('li', { class: 'hl-empty', text: hogs.error }));
    const rows = hogMode === 'app' ? hogs.groups || [] : hogs.procs;
    if (!rows.length) return list.replaceChildren(h('li', { class: 'hl-empty', text: `Nothing is using much ${L.METRIC_LABEL[metric]} right now.` }));
    const ramTotal = view?.sample?.ram?.total || 0;
    // The numbers change with every read, so the rows are rebuilt; a focused
    // button is found again on its row (same app, or same process) afterwards.
    const focused = list.contains(document.activeElement) ? document.activeElement.closest('.hl-hog')?.dataset.key : null;
    list.replaceChildren(...rows.map(p => hogRow(p, metric, ramTotal)));
    if (focused) [...list.querySelectorAll('.hl-hog')].find(li => li.dataset.key === focused)?.querySelector('button')?.focus();
  }

  // Shellby's own CPU and memory (health/footprint.js), owned up to above the
  // list, with a pointer to what makes him lighter when he's costing a lot.
  function renderSelf() {
    const view = H.view();
    const self = view?.settings?.enabled ? view.self : null;
    $('hlSelf').hidden = !self;
    if (!self) return;
    setText($('hlSelfLine'), self.line);
    $('hlSelfLine').title = self.detail;
    $('hlSelfHint').hidden = !self.hint;
    setText($('hlSelfHintText'), self.hint || '');
    $('hlSelfSettings').hidden = !self.jump;
  }

  function hogRow(p, metric, ramTotal) {
    const isGroup = hogMode === 'app';
    const w = L.hogWords(p, metric, isGroup, ramTotal);
    let action;
    if (p.locked) action = h('span', { class: 'hl-hog-locked', title: p.locked, text: 'protected' });
    else action = h('button', { class: 'hl-hog-end', type: 'button', 'aria-label': `End ${w.who}`, onclick: e => (isGroup ? endGroup(p, e.currentTarget) : endTask(p, e.currentTarget)) }, w.end);
    return h('li', { class: 'hl-hog', dataset: { key: w.key } },
      h('div', { class: 'hl-hog-top' },
        h('b', { class: 'hl-hog-name', text: p.name, title: w.title }),
        w.many ? h('span', { class: 'hl-hog-count', text: `×${p.count}` }) : null,
        w.owned ? h('span', { class: 'hl-hog-owned', title: "Started by one of Shellby's tasks. They end when that task closes.", text: w.ownedText }) : null,
        h('span', { class: 'hl-hog-rest', text: w.rest }),
        h('span', { class: 'hl-hog-val', text: w.value })),
      h('div', { class: 'hl-hog-bar', 'aria-hidden': 'true' }, h('span', { style: `transform: scaleX(${w.share.toFixed(4)})` })),
      action);
  }

  async function loadHogs(metric) {
    if (hogsLoading) { hogsAgain = true; return; }
    hogsLoading = true;
    try {
      hogs = await api.getHogs(metric);
      hogsAt = Date.now();
    } finally {
      hogsLoading = false;
    }
    // A read that began before an End task may still list what was ended.
    if (hogsAgain) { hogsAgain = false; hogsAt = 0; }
    if (state.view === 'health') renderHogs();
  }

  async function endTask(p, btn) {
    btn.disabled = true;
    let r;
    try { r = await api.endTask(p.pid); } finally { btn.disabled = false; }
    if (r?.cancelled) return;
    if (!r?.ok) return SB.toast(r?.error || "Couldn't end that one.");
    SB.toast(r.gone ? `${p.name} had already closed` : `Ended ${p.name}`);
    hogsAt = 0;
    renderHogs();
  }

  async function endGroup(g, btn) {
    btn.disabled = true;
    let r;
    try { r = await api.endTaskGroup(g.name); } finally { btn.disabled = false; }
    if (r?.cancelled) return;
    if (!r?.ok) return SB.toast(r?.error || "Couldn't end those.");
    SB.toast(L.endedLine(g.name, r));
    hogsAt = 0;
    renderHogs();
  }

  // ------------------------------------------------------------ starts with Windows

  function renderStartup() {
    const items = startup?.items || [];
    $('hlAskStartup').disabled = !startup?.ok;
    if (!startup?.ok) {
      $('hlStartupSum').textContent = startup ? startup.error : 'Reading the startup list…';
      $('hlStartup').replaceChildren();
      return;
    }
    $('hlStartupSum').textContent = L.startupSummary(items);
    $('hlStartup').replaceChildren(...items.map(i => h('li', { class: `hl-start${i.off ? ' off' : ''}`, title: i.command },
      h('span', { class: 'hl-start-name', text: i.name }),
      i.off ? h('span', { class: 'hl-start-off', text: 'off' }) : null,
      h('span', { class: 'hl-start-where', text: i.location }),
      i.locked
        ? h('span', { class: 'hl-start-locked', title: i.locked, text: 'locked' })
        : h('button', {
          class: 'hl-start-switch', type: 'button',
          'aria-label': `${i.off ? 'Switch on' : 'Switch off'} ${i.name} at sign-in`,
          onclick: e => switchStartup(i, e.currentTarget),
        }, i.off ? 'Switch on' : 'Switch off'))));
  }

  async function loadStartup() {
    startup = await api.getStartupApps();
    if (state.view === 'health') renderStartup();
  }

  async function switchStartup(item, btn) {
    btn.disabled = true;
    let r;
    try { r = await api.setStartupApp(item.id, !item.off); } finally { btn.disabled = false; }
    if (!r?.ok) return SB.toast(r?.error || "Couldn't switch that one.");
    SB.toast(r.off ? `${r.name} won't start with Windows now` : `${r.name} starts with Windows again`);
    if (r.list) startup = r.list;
    if (state.view === 'health') renderStartup();
  }

  async function askStartup() {
    const r = await api.askAboutStartup();
    if (r?.needsClaude) return SB.claudeUpsell('health');
    if (!r?.ok) return SB.toast(r?.error || "Couldn't start that.");
    SB.setView('chat');
    SB.toast('Shellby is going through your startup list');
  }

  async function askProcesses() {
    const r = await api.askAboutProcesses();
    if (r?.needsClaude) return SB.claudeUpsell('health');
    if (!r?.ok) return SB.toast(r?.error || "Couldn't start that.");
    SB.setView('chat');
    SB.toast("Shellby is going through what's running");
  }

  $('hlAskStartup').addEventListener('click', askStartup);
  $('hlAskProcesses').addEventListener('click', askProcesses);
  $('hlHogsSeg').addEventListener('click', e => {
    const b = e.target.closest('button[data-metric]');
    if (!b) return;
    hogMetric = b.dataset.metric;
    renderHogs();
  });
  $('hlHogsGroup').addEventListener('click', e => {
    const b = e.target.closest('button[data-group]');
    if (!b) return;
    hogMode = b.dataset.group;
    renderHogs();
  });
  $('hlHogsOpen').addEventListener('click', () => { hogsOpen = true; hogsAt = 0; renderHogs(); $('hlHogsSeg').querySelector('[aria-selected="true"]')?.focus(); });
  $('hlHogsClose').addEventListener('click', () => { hogsOpen = false; renderHogs(); $('hlHogsOpen').focus(); });
  $('hlHogsRefresh').addEventListener('click', () => { hogsAt = 0; renderHogs(); });
  $('hlSelfSettings').addEventListener('click', () => { const view = H.view(); if (view?.self?.jump) SB.jumpToSettingByName(view.self.jump); });

  Object.assign(H, { renderHogs, renderSelf, loadStartup });
})();
