/* Shellby panel — new tricks. When Claude Code updates, main reads its
   changelog (src/main/claude/tricks.js) and sends a few highlights. They wait
   above the composer, like the recap, until dismissed. "Try it" puts a question
   about the feature in a new tab's box: nothing is sent until you send it. */
'use strict';
(function () {
  const { h, api, state } = SB;
  const PAGE = 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md';

  const host = h('div', { class: 'recap-host tricks-host' });
  document.body.append(host);

  // `code` in a changelog line, drawn as code; the rest as text.
  const words = text => String(text).split('`').map((part, i) => (i % 2 ? h('code', { text: part }) : part));

  function tryIt(t) {
    if (SB.isCrabOnly()) return SB.claudeUpsell();
    dismiss();
    SB.prefillNew(t.tryIt);
  }

  function card(d) {
    const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
    const title = d.added ? `${plural(d.added, 'new thing')} Claude can do` : "What's new in Claude Code";
    return h('section', { class: 'recap tricks', role: 'region', 'aria-label': 'New in Claude Code' },
      h('p', { class: 'cel-eyebrow', text: `New in Claude Code · ${d.to}` }),
      h('h3', { class: 'recap-title', text: title }),
      h('div', { class: 'recap-body' },
        h('p', { class: 'recap-text', text: `Since ${d.from}: ${plural(d.releases, 'release')}, ${plural(d.total, 'change')}. The highlights:` }),
        h('ul', { class: 'recap-list' }, d.highlights.map(t => h('li', { class: `tricks-row ${t.kind}` },
          h('span', { class: 'tricks-text' }, ...words(t.text)),
          t.tryIt ? h('button', { type: 'button', class: 'btn slim-btn tricks-try', title: 'Ask Claude about it in a new tab (nothing is sent until you send it)', onclick: () => tryIt(t) }, 'Try it') : null)))),
      h('div', { class: 'cel-actions' },
        h('button', { class: 'btn slim-btn', type: 'button', onclick: () => api.openExternal(PAGE) }, 'See everything'),
        h('button', { class: 'btn primary slim-btn', type: 'button', onclick: dismiss }, 'Got it')),
      h('button', { class: 'cel-close icon-btn', type: 'button', 'aria-label': 'Dismiss', onclick: dismiss },
        SB.icon('M4.5 4.5l7 7M11.5 4.5l-7 7', { width: 1.5 })));
  }

  function dismiss() {
    const el = host.firstElementChild;
    if (!el) return;
    api.dismissClaudeTricks();
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  }

  /** d: a digest from claude-tricks.digest(), or null. */
  SB.showClaudeTricks = d => {
    if (!d?.highlights?.length || state.settings.claudeTricks === false) return;
    host.replaceChildren(card(d));
  };
  api.onClaudeTricks(SB.showClaudeTricks);
})();
