/* Shellby panel — clash warnings across copies. Main (wiring/clashes.js) says
   when two copies of a repository, or a copy and your checkout, have changed
   the same files; this marks those tabs in the strip and the Ctrl+Shift+A list,
   lists the files in the branch chip's menu, and toasts once when a clash is
   new. "Ask him to look" only fills the box: nothing is sent until you send it.
   The words are clash-text.js. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const T = window.ShellbyClashText;

  const MAX_COPIES = 4; // rows in the branch menu before "and N more"
  const MAX_FILES = 6;

  const on = () => state.settings?.clashWarnings !== false;
  const titleOf = id => {
    const t = state.tabs.get(id);
    return t ? SB.shownTitle(t) : null;
  };

  /** "Also changed in ⑂ new-nav: src/main/merge.js", or '' for a tab with no clash. */
  SB.clashLine = tabId => (on() ? T.line(state.clashes, tabId) : '');

  // The tab to go to from a toast: one of them, not the one you're already in.
  const goTarget = c => {
    const tabs = c.copies.filter(m => !m.checkout && state.tabs.has(m.tabId));
    return (tabs.find(m => m.tabId !== state.activeTab) || tabs[0])?.tabId || null;
  };

  /** Fill a tab's box with a note asking him to look (unsent). */
  SB.askAboutClash = tabId => {
    const text = T.prompt(state.clashes, tabId);
    if (!text || !state.tabs.has(tabId)) return;
    if (state.activeTab !== tabId) SB.activate(tabId);
    const typed = $('input').value.trim();
    SB.prefill(typed ? `${typed}\n\n${text}` : text);
  };

  /** Lines for the branch chip's menu: what clashes, where, and what to do. */
  SB.clashMenuItems = tab => {
    if (!on() || !tab) return [];
    const mine = T.byCopy(state.clashes, tab.id);
    if (!mine.length) return [];
    const items = [
      h('div', { class: 'menu-sep' }),
      h('div', { class: 'menu-label', text: 'Will clash when it comes home' }),
    ];
    // One row per other copy, every shared file under it; a tab's row takes you there.
    for (const { copy, files, more } of mine.slice(0, MAX_COPIES)) {
      const isTab = !copy.checkout && state.tabs.has(copy.tabId);
      const who = copy.checkout ? 'your checkout (not committed)' : `‘${titleOf(copy.tabId) || copy.title}’ on ⑂ ${T.shortBranch(copy.branch)}`;
      const body = [
        h('span', { class: 'mi-check', 'aria-hidden': 'true', text: '⚠' }),
        h('span', {},
          h('div', { class: 'mi-title', text: `Also changed in ${who}` }),
          h('div', { class: 'mi-sub clash-files', text: T.fileList(files, more, MAX_FILES) })),
      ];
      items.push(isTab
        ? h('button', { class: 'menu-item clash-info', title: 'Go to it', onclick: () => { SB.closeMenus(); SB.activate(copy.tabId); } }, ...body)
        : h('div', { class: 'menu-item branch-info clash-info' }, ...body));
    }
    if (mine.length > MAX_COPIES) {
      items.push(h('div', { class: 'menu-item branch-info' },
        h('span', { class: 'mi-check', 'aria-hidden': 'true' }),
        h('span', {}, h('div', { class: 'mi-sub', text: `And ${mine.length - MAX_COPIES} more: look for ⚠ on the tabs` }))));
    }
    items.push(h('button', { class: 'menu-item', onclick: () => { SB.closeMenus(); SB.askAboutClash(tab.id); } },
      h('span', { class: 'mi-check', text: '?' }),
      h('span', {}, h('div', { class: 'mi-title', text: 'Ask him to look' }), h('div', { class: 'mi-sub', text: "Puts a note in the box for you to send. Nothing goes until you do" }))));
    return items;
  };

  function apply({ clashes = [], fresh = [] } = {}) {
    state.clashes = Array.isArray(clashes) ? clashes : [];
    SB.renderTabStrip();
    if (!on() || !fresh?.length) return;
    const news = state.clashes.filter(c => fresh.includes(c.key));
    const first = news.find(goTarget);
    if (!first) return;
    const rest = news.length - 1;
    const text = T.toast(first, titleOf) + (rest > 0 ? ` (And ${rest} more: look for ⚠ on the tabs.)` : '');
    SB.toast(text, { ms: 9000, action: 'Go to it', onAction: () => { const id = goTarget(first); if (id) SB.activate(id); } });
  }

  api.onClashes(apply);
  api.listClashes().then(clashes => apply({ clashes })).catch(() => {});
})();
