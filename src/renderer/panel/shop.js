/* Shellby panel — Skill Shop: browse and install plugins from Claude Code's marketplaces. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const MAX_ROWS = 200;
  let filter = 'all';
  let loading = false;
  let error = '';
  let marketKey = '';
  const busy = new Set(); // ids with an install/remove in flight

  const fmtInstalls = n => (n == null ? '' : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k installs` : `${n} installs`);
  // Main always answers with a full view; keep whatever is newest.
  const takeView = v => { if (v) state.shop = { ...state.shop, ...v }; };

  async function load({ refresh = false } = {}) {
    if (loading) return;
    loading = true;
    error = '';
    render();
    try {
      const r = await api.shopList({ refresh });
      if (r.ok) takeView(r);
      else error = r.error || "Couldn't load the plugin list.";
    } catch {
      error = "Couldn't load the plugin list.";
    } finally {
      loading = false;
      render();
    }
  }

  function terminalToast(r) {
    SB.toast(r.error, { ms: 9000, action: 'Copy command', onAction: () => { api.copyText(r.command); SB.toast('Copied'); } });
  }

  function applyResult(r, verb, name) {
    takeView(r.view);
    if (r.canceled) {
      if (r.busy) SB.toast('Finish the open Shellby dialog first.');
      return;
    }
    if (!r.ok) {
      if (r.needsTerminal && r.command) terminalToast(r);
      else SB.toast(r.error || `Couldn't ${verb} that plugin.`, { ms: 6000 });
      return;
    }
    if (verb === 'remove') { SB.toast(`Removed ${name}`); return; }
    if (r.already) { SB.toast(`${name} is already installed`); return; }
    const d = r.details;
    const got = d ? [d.skills && `${d.skills} skill${d.skills > 1 ? 's' : ''}`, d.agents && `${d.agents} agent${d.agents > 1 ? 's' : ''}`].filter(Boolean).join(', ') : '';
    const extras = r.runsCode ? ' It also adds hooks or MCP servers, which run programs on your PC.' : '';
    SB.toast(`🧰 Installed ${name}${got ? ` (${got})` : ''}. Ready in new conversations.${extras}`, { ms: r.runsCode ? 9000 : 5000 });
  }

  async function act(p) {
    if (busy.has(p.id)) return;
    busy.add(p.id);
    render();
    const verb = p.installed ? 'remove' : 'install';
    try {
      const r = p.installed ? await api.shopUninstall(p.id) : await api.shopInstall(p.id);
      applyResult(r, verb, p.name);
    } catch {
      SB.toast(`Couldn't ${verb} that plugin.`, { ms: 6000 });
    } finally {
      busy.delete(p.id);
      render();
    }
  }

  function actionButton(p) {
    const isBusy = busy.has(p.id);
    // Project installs belong to a folder Shellby doesn't know: main explains the terminal route.
    const label = isBusy ? (p.installed ? 'Removing…' : 'Installing…') : p.installed ? 'Remove' : 'Install';
    return h('button', {
      class: `btn slim-btn${p.installed ? ' ghost' : ' primary'}`, type: 'button', disabled: isBusy,
      title: p.installed && p.scope !== 'user' ? `Installed for one project (${p.scope})` : null,
      onclick: () => act(p),
    }, label);
  }

  function row(p) {
    return h('li', { class: `tool-row shop-row${p.installed ? ' is-installed' : ''}${busy.has(p.id) ? ' is-busy' : ''}` },
      h('div', { class: 'tool-main' },
        h('div', { class: 'tool-name' },
          h('strong', { text: p.name }),
          p.installed ? h('span', { class: `installed-pill${p.enabled ? '' : ' off'}`, text: p.enabled ? 'installed' : 'disabled' }) : null,
          h('span', { class: 'src-pill', text: p.marketplace, title: p.marketplace })),
        p.description ? h('p', { class: 'tool-desc', text: p.description, title: p.description }) : null,
        h('div', { class: 'shop-meta' },
          p.installs != null ? h('span', { text: fmtInstalls(p.installs) }) : null,
          p.version ? h('span', { text: /^\d+\.\d+/.test(p.version) ? `v${p.version}` : p.version.slice(0, 7) }) : null,
          p.installed && p.scope && p.scope !== 'user' ? h('span', { text: `${p.scope} only` }) : null,
          p.url ? h('button', { class: 'link-btn', type: 'button', text: 'Source', title: p.url, onclick: () => api.shopOpen(p.id) }) : null)),
      h('div', { class: 'tool-actions' }, actionButton(p)));
  }

  function renderSuggest(sh) {
    const box = $('shopSuggest');
    const list = sh?.suggested || [];
    box.hidden = !list.length;
    box.replaceChildren(
      h('div', { class: 'row-label' }, sh?.marketplaces?.length ? 'More marketplaces' : 'Start with a marketplace'),
      ...list.map(m => h('div', { class: 'row' },
        h('span', {}, h('b', { text: m.label }), h('span', { class: 'muted small', text: ` by ${m.by}` })),
        h('button', { class: 'btn slim-btn', type: 'button', onclick: () => addMarketplace(m.source) }, 'Add'))));
  }

  function renderMarketSelect(sh) {
    const names = [...new Set((sh?.plugins || []).map(p => p.marketplace))].sort();
    const key = names.join('\n');
    if (key === marketKey) return;
    marketKey = key;
    const sel = $('shopMarket');
    const prev = sel.value;
    sel.hidden = names.length < 2;
    sel.replaceChildren(h('option', { value: '' }, 'All marketplaces'), ...names.map(n => h('option', { value: n }, n)));
    sel.value = names.includes(prev) ? prev : '';
  }

  function render() {
    if (state.view !== 'shop') return; // async results may land after you've left
    const list = $('shopList');
    const sh = state.shop;
    renderSuggest(sh);
    renderMarketSelect(sh);
    const all = sh?.plugins || [];
    const installed = all.filter(p => p.installed);
    document.querySelectorAll('#shopTabs [data-filter]').forEach(b => {
      b.querySelector('.n').textContent = sh ? (b.dataset.filter === 'installed' ? installed.length : all.length) : '';
      b.setAttribute('aria-selected', String(b.dataset.filter === filter));
    });
    $('shopRefresh').disabled = loading;
    $('shopRefresh').textContent = loading ? 'Refreshing…' : 'Refresh';

    if (error && !sh) { list.replaceChildren(h('li', { class: 'history-empty', text: error })); return; }
    if (!sh) { list.replaceChildren(h('li', { class: 'history-empty', text: 'Asking Claude Code for its plugin list…' })); return; }

    const q = $('shopSearch').value.trim().toLowerCase();
    const market = $('shopMarket').value;
    const items = (filter === 'installed' ? installed : all)
      .filter(p => !market || p.marketplace === market)
      .filter(p => !q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q))
      .sort((a, b) => (b.installs || 0) - (a.installs || 0) || a.name.localeCompare(b.name));
    const rows = items.slice(0, MAX_ROWS).map(row);
    if (error) rows.unshift(h('li', { class: 'history-empty', text: error }));
    if (!items.length) {
      rows.push(h('li', { class: 'history-empty', text: q ? 'No matches.'
        : filter === 'installed' ? 'No plugins installed yet.'
        : sh.marketplaces.length ? 'These marketplaces have no plugins listed.' : 'Add a marketplace above to see its plugins.' }));
    }
    if (items.length > MAX_ROWS) rows.push(h('li', { class: 'history-empty', text: `${items.length - MAX_ROWS} more. Search to narrow it down.` }));
    list.replaceChildren(...rows);
  }

  async function addMarketplace(source) {
    let r;
    try { r = await api.shopAddMarketplace(source); } catch { r = { ok: false }; }
    takeView(r.view);
    if (r.canceled) { if (r.busy) SB.toast('Finish the open Shellby dialog first.'); return; }
    if (!r.ok) { SB.toast(r.error || "Couldn't add that marketplace.", { ms: 6000 }); return; }
    $('shopAddInput').value = '';
    SB.toast(`Added ${r.source}`);
    render();
  }

  SB.openShop = () => {
    SB.setView('shop');
    load(); // cheap: main serves a cached list for 5 minutes
  };

  $('shopBtn').addEventListener('click', SB.openShop);
  $('shopBack').addEventListener('click', () => SB.setView('toolbox'));
  $('shopRefresh').addEventListener('click', () => load({ refresh: true }));
  $('shopSearch').addEventListener('input', render);
  $('shopMarket').addEventListener('change', render);
  document.querySelectorAll('#shopTabs [data-filter]').forEach(b => b.addEventListener('click', () => { filter = b.dataset.filter; render(); }));
  $('shopAddForm').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('shopAddInput').value.trim();
    if (v) addMarketplace(v);
  });

  SB.views.shop = {
    render, // SB.NAV_SECTION keeps the Toolbox lit while the shop is open
  };
})();
