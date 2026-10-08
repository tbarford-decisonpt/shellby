/* Shellby panel — the Projects page's inbox: what's waiting on you across every
   repository. Pull requests you've been asked to review, your own with
   something new said on them, branches gone stale and copies Shellby made that
   nobody went back to. Main works it all out (src/main/projects/inbox.js);
   this draws it and sends back what you click. Deleting anything that exists
   nowhere else is asked in main's own dialog, not here. */
'use strict';
(function () {
  const { h, api, state, $, plural } = SB;
  const ago = t => (t ? SB.relTime(t) : '');
  const SHOWN = 3; // rows per group before "N more"

  let view = null;
  let loading = 0;
  const opened = new Set(); // groups whose "more" is open

  async function load({ refresh = false } = {}) {
    const seq = ++loading;
    const v = await api.getInbox({ refresh });
    if (seq !== loading || !v) return;
    view = v;
    render();
  }

  const act = (text, onclick, cls = 'btn ghost slim-btn', keep = null) => h('button', { type: 'button', class: cls, text, onclick, dataset: keep ? { keep } : {} });

  // One press, then wait: a second press mid-way would do it twice.
  function busyButton(text, run, cls, keep) {
    const btn = act(text, async () => {
      btn.disabled = true;
      const r = await Promise.resolve().then(run).catch(() => null);
      btn.disabled = false;
      if (r?.cancelled) return;
      if (!r?.ok) return SB.toast(r?.error || "Couldn't do that just now.", { ms: 5000 });
      if (r.done) SB.toast(r.done);
      load();
    }, cls, keep);
    return btn;
  }

  function newHere(cwd, draft) {
    SB.setView('chat');
    SB.newTabIn({ cwd, draft });
  }

  const row = (tone, title, sub, acts, tags = []) => h('li', { class: 'pj-h-row' },
    h('span', { class: `pj-dot ${tone}`, 'aria-hidden': 'true' }),
    h('span', { class: 'pj-h-text' },
      h('b', { text: title }),
      h('span', { class: 'muted small' }, sub, ...tags.filter(Boolean).map(t => h('span', { class: `pj-chip ${t.tone}`, text: t.text, title: t.title || '' })))),
    h('span', { class: 'pj-h-acts' }, acts));

  // A group: its heading, the first few rows, the rest behind "N more".
  function group(id, title, rows, foot = null) {
    if (!rows.length) return null;
    const shown = opened.has(id) ? rows : rows.slice(0, SHOWN);
    const more = rows.length - shown.length;
    return h('div', { class: 'pj-inbox-group', 'aria-label': title, role: 'group' },
      h('p', { class: 'pj-inbox-head' }, h('span', { text: title }), h('span', { class: 'pj-inbox-n', text: String(rows.length) })),
      h('ul', { class: 'pj-h-list' }, shown),
      more > 0 && act(`Show ${more} more`, () => { opened.add(id); render(); }, 'link-btn small', `more:${id}`),
      foot);
  }

  // ------------------------------------------------------------------ the four kinds

  function reviewRow(r) {
    return row('wait', `${r.repo}#${r.number} ${r.title}`,
      [r.author && `@${r.author}`, r.updatedAt && `updated ${ago(r.updatedAt)}`].filter(Boolean).join(' · '),
      [
        busyButton('Read it with Claude', async () => {
          if (SB.isCrabOnly()) { SB.claudeUpsell('review'); return { cancelled: true }; }
          const res = await api.reviewWithClaude(r.key);
          return res?.ok ? { ok: true, done: "Started. It's in a new conversation." } : res;
        }, 'btn slim-btn', `rv:${r.key}`),
        act('Open', () => api.openPr(r.key), undefined, `open:${r.key}`),
      ],
      [r.draft && { tone: 'info', text: 'draft' }]);
  }

  function talkRow(t) {
    const who = t.people.length ? t.people.map(p => `@${p}`).join(', ') : 'someone';
    return row(t.verdict === 'changes' ? 'crashed' : 'wait', `${t.repo}#${t.number} ${t.title}`,
      `${plural(t.unread, 'new comment')} from ${who}${t.lastAt ? ` · ${ago(t.lastAt)}` : ''}`,
      [
        t.verdict === 'changes' && act('Address the review', () => SB.startFrom.open('review', t.key), 'btn slim-btn', `fix:${t.key}`),
        act('Open', () => api.openPr(t.key), undefined, `open:${t.key}`),
        busyButton('Mark read', async () => ({ ok: !!(await api.markPrSeen(t.key)) }), undefined, `seen:${t.key}`),
      ],
      [
        t.verdict === 'changes' && { tone: 'bad', text: 'changes requested' },
        t.verdict === 'approved' && { tone: 'info', text: 'approved' },
        t.state === 'failing' && { tone: 'bad', text: 'CI failing' },
      ]);
  }

  // The ask "What's on it?" puts in the box, for you to read and send.
  const branchPrompt = b => `In ${b.project}, the local branch ${JSON.stringify(b.name)} hasn't had a commit since ${new Date(b.at).toLocaleDateString()}`
    + `${b.only ? ` and has ${plural(b.only, 'commit')} no other branch or remote has` : ''}. `
    + 'Without changing anything, tell me what is on it compared with the main branch, whether it looks finished, and whether it is worth keeping, finishing or deleting.';

  function branchRow(b) {
    const safe = b.merged || b.only === 0;
    const what = b.merged ? 'merged' : b.only === 0 ? 'its commits are on other branches too' : `${plural(b.only, 'commit')} only here`;
    return row(safe ? 'up' : 'wait', b.name,
      `${b.project} · ${what}${b.at ? ` · last commit ${ago(b.at)}` : ''}`,
      [
        !safe && act("What's on it?", () => newHere(b.root, branchPrompt(b)), 'btn slim-btn', `ask:${b.id}`),
        busyButton(safe ? 'Delete' : 'Delete…', async () => {
          const r = await api.deleteBranch({ root: b.root, name: b.name });
          return r?.ok ? { ok: true, done: `Deleted ${b.name}.` } : r;
        }, safe ? 'btn slim-btn' : undefined, `del:${b.id}`),
        busyButton('Keep', () => api.dismissInboxItem(b.id), undefined, `keep:${b.id}`),
      ],
      [b.gone && { tone: 'info', text: 'deleted on GitHub', title: 'Its branch on the remote is gone' }]);
  }

  function copyRow(c) {
    const facts = c.empty ? ['no work of its own'] : [
      c.changed && `${c.changed} uncommitted`,
      c.only && `${plural(c.only, 'commit')} only here`,
      c.changed === null && 'not read yet',
    ].filter(Boolean);
    return row(c.empty ? 'up' : 'wait', c.title || c.branch,
      [c.project, ...facts, `quiet since ${ago(c.lastAt)}`].join(' · '),
      [
        c.sessionId && act('Open conversation', () => { SB.setView('chat'); SB.openHistory(c.sessionId); }, c.empty ? undefined : 'btn slim-btn', `conv:${c.id}`),
        busyButton(c.empty ? 'Remove' : 'Throw away…', async () => {
          const r = await api.removeCopy(c.path);
          return r?.ok ? { ok: true, done: 'Copy removed.' } : r;
        }, c.empty ? 'btn slim-btn' : undefined, `rm:${c.id}`),
        busyButton('Keep', () => api.dismissInboxItem(c.id), undefined, `keep:${c.id}`),
      ],
      [{ tone: 'info', text: c.branch.replace(/^shellby\//, ''), title: c.path }]);
  }

  // ------------------------------------------------------------------ the section

  function render() {
    const box = $('pjInbox');
    if (!view) { box.hidden = true; return; }
    const v = view;
    const groups = [
      group('reviews', 'Waiting on your review', v.reviews.map(reviewRow),
        v.reviewsMore > 0 && h('p', { class: 'muted small', text: `And ${v.reviewsMore} more on GitHub.` })),
      group('talk', 'New on your pull requests', v.talk.map(talkRow)),
      group('branches', 'Stale branches', v.branches.map(branchRow),
        v.branchesMore > 0 && h('p', { class: 'muted small', text: `And ${v.branchesMore} more.` })),
      group('copies', 'Copies left behind', v.copies.map(copyRow)),
    ].filter(Boolean);
    const note = !v.github.enabled
      ? h('p', { class: 'muted small pj-inbox-note' }, 'Pull requests show up here once ',
        h('button', { type: 'button', class: 'link-btn', text: 'Watch CI on my pull requests', onclick: () => SB.showSetting('ghCi') }), ' is on in GitHub settings.')
      : v.github.error && h('p', { class: 'muted small pj-inbox-note bad', text: v.github.error });
    const body = groups.length ? groups : [h('p', { class: 'muted small pj-calm', text: 'Nothing waiting on you. No reviews, no new comments, no branches or copies left lying about. 🐚' })];
    SB.keepFocus(box, () => box.replaceChildren(
      h('p', { class: 'row-label pj-inbox-title' }, 'Inbox', v.total ? h('span', { class: 'pj-inbox-n', text: String(v.total) }) : null),
      ...body, note || null));
    box.hidden = false;
  }

  // New comments and review requests arrive with each CI poll.
  api.onCi(() => { if (state.view === 'projects') load(); });

  SB.pjInbox = { load };
})();
