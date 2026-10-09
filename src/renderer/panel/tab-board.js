/* Shellby panel — running many conversations at once, on top of the Ctrl+Shift+A
   list (tab-overview.js). Each row gets its lane: tests red, how big its change
   is, who else changed the same files. Above the rows: identical permission
   prompts from several conversations as one ("3 want npm test", Allow all /
   Deny all), and, once two copies of a project are ready, the order to bring
   them home with "Line them up" (main asks before it rewrites anything).
   The deciding is main's (lanes.js, wiring/lanes.js). */
'use strict';
(function () {
  const { h, api, state, plural } = SB;

  const REFRESH_MS = 800;
  let lanes = new Map();      // tabId -> lane
  let view = { order: [], prompts: [], training: false };
  let timer = 0;
  let busy = false;           // an answer or a line-up on its way
  const box = h('div', { class: 'tb-board', hidden: true });

  /** A row's lane under its title: "red tests · 4 files +120 −8 · overlaps Fix login". */
  SB.laneLine = id => {
    const l = lanes.get(id);
    if (!l) return '';
    const bits = [];
    if (l.state === 'red') bits.push('tests red');
    else if (l.state === 'ready') bits.push('ready to merge');
    if (l.files) bits.push(`${plural(l.files, 'file', 'files')} +${l.added} −${l.removed}`);
    const others = l.overlaps.map(o => (o.checkout ? 'your checkout' : o.title));
    if (others.length) bits.push(`overlaps ${others.join(', ')}`);
    return bits.join(' · ');
  };

  const titleOf = id => (state.tabs.get(id) ? SB.shownTitle(state.tabs.get(id)) : lanes.get(id)?.title || 'a conversation');

  async function answer(g, decision) {
    if (busy) return;
    busy = true;
    try {
      const r = await api.answerPromptGroup(g.key, decision);
      if (!r?.ok) SB.toast(r?.error || "Those couldn't be answered.");
      else if (r.answered > 1) SB.toast(`${decision === 'allow' ? 'Allowed' : 'Denied'} ${r.answered} at once.`);
    } finally { busy = false; refresh(); }
  }

  async function lineUp(group) {
    if (busy) return;
    busy = true;
    try {
      const r = await api.lineUpCopies(group.lanes.map(l => l.tabId));
      if (r?.cancelled) return;
      SB.toast(r?.line || r?.error || 'Lining them up stopped.');
    } finally { busy = false; refresh(); }
  }

  function promptGroup(g) {
    const who = [...new Set(g.prompts.map(p => titleOf(p.tabId)))];
    const head = g.count > 1 ? `${g.count} want ${g.toolName}` : `${who[0]} wants ${g.toolName}`;
    return h('div', { class: 'tb-ask', title: who.join('\n') },
      h('span', { class: 'tb-ask-text' }, h('span', { text: head }), g.what ? h('code', { text: g.what }) : null),
      g.look
        ? h('button', { type: 'button', class: 'tb-btn', onclick: () => { SB.closeMenus(); SB.activate(g.prompts[0].tabId); } }, 'Look')
        : [h('button', { type: 'button', class: 'tb-btn', onclick: () => answer(g, 'allow') }, g.count > 1 ? 'Allow all' : 'Allow'),
          h('button', { type: 'button', class: 'tb-btn quiet', onclick: () => answer(g, 'deny') }, g.count > 1 ? 'Deny all' : 'Deny')]);
  }

  function orderGroup(g) {
    return h('div', { class: 'tb-order' },
      h('ol', { class: 'tb-order-list' }, ...g.lanes.map(l => h('li', {
        text: `${titleOf(l.tabId)} (${plural(l.files, 'file', 'files')}${l.overlaps.length ? `, ${plural(l.overlaps.length, 'overlap', 'overlaps')}` : ''})`,
      }))),
      h('button', {
        type: 'button', class: 'tb-btn', disabled: view.training,
        title: `Rebases each onto the one before it (the first onto ${g.base}) and runs the checks between. Asks first.`,
        onclick: () => lineUp(g),
      }, view.training ? 'Lining up…' : 'Line them up'));
  }

  function paint() {
    const asks = view.prompts.filter(g => g.count > 1 || view.prompts.length > 1);
    const orders = view.order.filter(g => g.lanes.length > 1);
    box.hidden = !asks.length && !orders.length;
    box.replaceChildren(
      ...(asks.length ? [h('div', { class: 'tl-group asking' }, h('span', { text: 'Waiting on you, all at once' }), h('span', { class: 'tl-n', text: String(asks.length) })), ...asks.map(promptGroup)] : []),
      ...(orders.length ? [h('div', { class: 'tl-group finished' }, h('span', { text: 'Merge order' })), ...orders.map(orderGroup)] : []));
  }

  async function refresh() {
    try {
      const v = await api.lanesView();
      lanes = new Map((v?.lanes || []).map(l => [l.tabId, l]));
      view = { order: v?.order || [], prompts: v?.prompts || [], training: !!v?.training };
      paint();
      SB.refreshTabList?.();
    } catch { /* the list still works without its lanes */ }
  }

  // Only while the list is open: it reads every copy's diff.
  function soon() {
    if (!SB.tabListOpen?.()) return;
    clearTimeout(timer);
    timer = setTimeout(refresh, REFRESH_MS);
  }

  SB.boardPart = () => { refresh(); return box; };
  api.onTabs(soon);
  api.onClashes(soon);
  api.onLaneTrain(soon);
})();
