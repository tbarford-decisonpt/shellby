/* Shellby panel — Next up, the first card on a project's page
   (src/main/wiring/backlog.js, docs/plans/next-up.md): your tasks from
   .shellby/tasks.md, the repository's open issues and the loose ends in its
   code, ranked into one list, each with "Do this".

   Do this makes a copy on its own branch and opens a conversation there with
   the prompt in the box: nothing goes to Claude until you send it.

   Someone with a Linear or Jira MCP server gets one quiet link under the
   list to add those issues too (backlog/trackers.js); nobody else sees it. The panel
   only names things (a project's root or repository, an item's id, a task's
   line); main looks each one up. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;

  const SHOWN = 7;
  const FILTERS = [['all', 'All'], ['issue', 'Issues'], ['task', 'Tasks'], ['todo', 'Loose ends']];
  const FROM_TAG = { claude: 'from Claude Code', terminal: 'from the terminal' };
  const TIER_TAG = { now: 'Now', next: 'Task', later: 'Later' };

  const views = new Map();     // project key -> last view, so a redraw doesn't flicker
  const expanded = new Set();  // project keys showing everything
  const filters = new Map();   // project key -> kind shown
  // What you were typing in a project's add box, so a redraw (Claude adding a to-do from a terminal) keeps it.
  const drafts = new Map();
  const trackerForms = new Set(); // project keys with the Linear or Jira form open
  const live = new Map();         // project key -> its card's load(), for a read that lands later

  // The Issues chip shows Linear and Jira issues too.
  const isKind = (it, k) => k === 'all' || it.kind === k || (k === 'issue' && it.kind === 'ticket');

  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const keyOf = t => (t.root ? `root:${t.root.toLowerCase()}` : `repo:${String(t.repo).toLowerCase()}`);

  function openTab(tabId) {
    SB.setView('chat');
    if (state.tabs.has(tabId)) SB.activate(tabId); else SB.openHistory(tabId);
  }

  /**
   * The Next up card. project: { root (the main clone, or null), repo (owner/name, or null), name }.
   * onClone(repo): the page's Clone… for a project only on GitHub.
   */
  function card({ root = null, repo = null, name = '' }, { onClone } = {}) {
    const target = root ? { root } : { repo };
    const key = keyOf(target);
    const box = h('section', { class: 'pj-panel bl-card', 'aria-label': 'Next up' });
    const seg = h('div', { class: 'seg bl-filter', role: 'tablist', 'aria-label': 'Show which', 'data-roving': '' });
    const body = h('div', { class: 'bl-body' });
    box.append(h('div', { class: 'bl-head' }, h('p', { class: 'row-label', text: 'Next up' }), seg), body);

    let seq = 0;
    const load = async fresh => {
      const mine = ++seq;
      const r = await api.backlogView({ ...target, fresh }).catch(() => null);
      if (mine !== seq) return;
      if (r?.ok) views.set(key, r);
      draw(r);
    };
    live.set(key, { box, load });
    // Made once, so what you're typing and the focus survive a redraw.
    const adder = addBox();
    let formEl = null;

    function drawFilter(v) {
      const kind = filters.get(key) || 'all';
      const has = k => k === 'all' || v.items.some(i => isKind(i, k));
      seg.replaceChildren(...FILTERS.filter(([k]) => has(k)).map(([k, label]) => h('button', {
        type: 'button', role: 'tab', 'aria-selected': String(kind === k), text: label,
        onclick: () => { filters.set(key, k); draw(v); },
      })));
      seg.hidden = seg.children.length < 3;
    }

    function draw(v) {
      if (!v?.ok) return body.replaceChildren(h('p', { class: 'muted small pj-calm', text: v?.error || 'Couldn\'t put the list together.' }));
      // A filter left on a kind that's run out would hide everything with no chips to get back.
      if (filters.has(key) && !v.items.some(i => isKind(i, filters.get(key)))) filters.delete(key);
      drawFilter(v);
      const kind = filters.get(key) || 'all';
      const items = v.items.filter(i => isKind(i, kind));
      const all = expanded.has(key);
      const list = all ? items : items.slice(0, SHOWN);
      body.replaceChildren(...[
        milestoneStrip(v),
        v.cloned || v.key ? adder : null,
        items.length
          ? h('ul', { class: 'pj-h-list bl-list' }, list.map(it => row(it, v)))
          : h('p', { class: 'muted small pj-calm bl-empty', text: kind === 'all' ? 'Nothing waiting. Add a task, or enjoy it. 🐚' : 'None of those right now.' }),
        footer(v, items, list),
        // Made once while it's open, so a list that lands meanwhile doesn't clear what you typed.
        trackerForms.has(key) ? (formEl ||= trackerForm(v)) : (formEl = null),
        ...notes(v),
      ].filter(Boolean));
    }

    function milestoneStrip(v) {
      const m = v.milestone;
      if (!m) return null;
      const total = (m.open || 0) + (m.closed || 0);
      return h('p', { class: 'bl-milestone small' },
        h('b', { text: m.title }), ` · ${m.due}`, total ? ` · ${m.closed} of ${total} closed` : '');
    }

    function addBox() {
      const input = h('input', { type: 'text', class: 'field slim bl-add', placeholder: 'Add a task…', 'aria-label': 'Add a task to .shellby/tasks.md', maxlength: '200' });
      input.value = drafts.get(key) || '';
      input.addEventListener('input', () => drafts.set(key, input.value));
      input.addEventListener('keydown', async e => {
        if (e.key !== 'Enter' || e.isComposing) return;
        e.preventDefault();
        const title = input.value.trim();
        if (!title) return;
        input.disabled = true;
        const r = await (root ? api.backlogEdit({ root, op: 'add', title }) : api.addProjectTodo({ key: views.get(key)?.key, text: title })).catch(() => null);
        input.disabled = false;
        if (!r?.ok) return SB.toast(r?.error || 'Couldn\'t add it.');
        input.value = '';
        drafts.delete(key);
        await load(false);
        input.focus();
      });
      return input;
    }

    function tagOf(it) {
      if (it.kind === 'issue') return h('span', { class: `bl-tag issue${it.tier === 'now' ? ' now' : ''}`, text: `#${it.issue.number}` });
      if (it.kind === 'ticket') return h('span', { class: `bl-tag issue ticket${it.tier === 'now' ? ' now' : ''}`, text: it.ticket.key, title: it.ticket.key });
      if (it.kind === 'todo') return h('span', { class: `sf-tag ${it.todo.tag.toLowerCase()}`, text: it.todo.tag });
      return h('span', { class: `bl-tag task${it.tier === 'now' ? ' now' : ''}`, text: TIER_TAG[it.tier] });
    }

    function row(it, v) {
      const where = it.kind === 'todo' ? `${it.todo.file}:${it.todo.line}` : '';
      const more = h('button', {
        type: 'button', class: 'icon-btn bl-more', title: 'More', 'aria-label': `More for ${it.title}`, 'aria-haspopup': 'menu',
        onclick: e => openMenu(it, v, e.currentTarget),
      }, h('span', { text: '⋯' }));
      const act = it.doing
        ? h('button', { type: 'button', class: 'btn slim-btn', text: 'Open conversation', title: it.doing.branch ? `Working on ${it.doing.branch}` : '', onclick: () => openTab(it.doing.tabId) })
        : h('button', { type: 'button', class: 'btn slim-btn', text: 'Do this', 'aria-label': `Do this: ${it.title}`, onclick: e => doThis(it, e.currentTarget) });
      const li = h('li', { class: `pj-h-row bl-row tier-${it.tier}`, dataset: { id: it.id } },
        tagOf(it),
        h('span', { class: 'pj-h-text' },
          h('span', { class: 'bl-title' },
            h('b', { text: it.title, title: it.title }),
            FROM_TAG[it.task?.from || it.note?.from] && h('span', { class: 'pj-tag bl-from', text: FROM_TAG[it.task?.from || it.note?.from] })),
          h('span', { class: 'muted small', title: it.reasons.join(' · ') },
            it.doing?.pr ? `Draft pull request #${it.doing.pr.number} · ` : it.doing ? 'In progress · ' : '',
            ...subline(it, where))),
        h('span', { class: 'pj-h-acts' }, act, more));
      li.addEventListener('contextmenu', e => { e.preventDefault(); openMenu(it, v, more); });
      return li;
    }

    /** Under the title: where a loose end is, a task's first note, or the strongest reason. */
    function subline(it, where) {
      if (where) return [h('code', { class: 'bl-where', text: where })];
      const note = it.kind === 'task' ? (it.task.notes || []).find(n => n.trim()) : null;
      return [note ? note.trim() : it.reason];
    }

    function footer(v, items, list) {
      const hiddenHere = items.length - list.length;
      return h('div', { class: 'row wrap bl-foot' },
        hiddenHere > 0 && h('button', { type: 'button', class: 'link-btn small', text: `Show all ${items.length}`, onclick: () => { expanded.add(key); draw(v); } }),
        expanded.has(key) && items.length > SHOWN && h('button', { type: 'button', class: 'link-btn small', text: 'Show fewer', onclick: () => { expanded.delete(key); draw(v); } }),
        v.done > 0 && h('span', { class: 'muted small', text: `${v.done} done` }),
        v.hidden > 0 && h('button', { type: 'button', class: 'link-btn small', text: `Show ${plural(v.hidden, 'hidden one')}`, onclick: () => act(api.backlogHide({ ...target, show: true })) }),
        h('button', { type: 'button', class: 'link-btn small', text: 'Look again', onclick: () => load(true) }),
        trackerLink(v));
    }

    /** "Linear or Jira…" for someone who has that server, or what's set: one quiet link, last. */
    function trackerLink(v) {
      const t = v.tracker;
      if (!t || trackerForms.has(key)) return null;
      const text = t.state === 'none' ? `${t.offer}…` : `${t.label}: ${t.scope.length > 24 ? `${t.scope.slice(0, 23)}…` : t.scope}`;
      const tip = t.state === 'none' ? `List this project's ${t.offer} issues here too, through your MCP server` : `Read through ${t.server}. Change or stop`;
      return h('button', { type: 'button', class: 'link-btn small bl-tracker-link', text, title: tip, onclick: () => { trackerForms.add(key); draw(v); } });
    }

    /** Which server, Linear or Jira, and which issues. Saved for this project, on this PC. */
    function trackerForm(v) {
      const form = h('form', { class: 'bl-tracker', 'aria-label': 'Linear or Jira issues' });
      const server = h('select', { class: 'field slim', 'aria-label': 'MCP server' });
      const kind = h('select', { class: 'field slim', 'aria-label': 'Linear or Jira' },
        h('option', { value: 'linear', text: 'Linear' }), h('option', { value: 'jira', text: 'Jira' }));
      const scope = h('input', { type: 'text', class: 'field slim bl-tracker-scope', 'aria-label': 'Which issues', maxlength: '200', required: '' });
      const save = h('button', { type: 'submit', class: 'btn slim-btn', text: 'Show them' });
      const close = () => { trackerForms.delete(key); draw(views.get(key) || v); };
      const stop = h('button', { type: 'button', class: 'link-btn small', text: 'Stop showing them', hidden: true, onclick: async () => {
        trackerForms.delete(key);
        await act(api.backlogTrackerSet({ ...target, off: true }));
      } });
      const hint = h('p', { class: 'muted small bl-note' });
      let hints = {};
      const placeholder = () => { scope.placeholder = hints[kind.value] || ''; };
      kind.addEventListener('change', placeholder);
      // Picking a server that looks like one or the other says which.
      server.addEventListener('change', () => {
        const k = server.selectedOptions[0]?.dataset.kind;
        if (k) { kind.value = k; placeholder(); }
      });
      form.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
      form.addEventListener('submit', async e => {
        e.preventDefault();
        save.disabled = true;
        const r = await api.backlogTrackerSet({ ...target, server: server.value, kind: kind.value, scope: scope.value }).catch(() => null);
        save.disabled = false;
        if (!r?.ok) return SB.toast(r?.error || 'Couldn\'t save that.');
        trackerForms.delete(key);
        SB.toast(`Reading them through ${server.value}. They join the list in a minute or so.`, { ms: 7000 });
        load(false);
      });
      form.append(
        h('div', { class: 'row wrap bl-tracker-row' }, server, kind, scope),
        h('div', { class: 'row wrap bl-tracker-row' }, save, h('button', { type: 'button', class: 'link-btn small', text: 'Cancel', onclick: close }), stop),
        hint);
      api.backlogTrackerChoices(target).then(c => {
        if (!c?.ok) { hint.textContent = c?.error || 'Couldn\'t read your MCP servers.'; save.disabled = true; return; }
        hints = c.hints || {};
        server.replaceChildren(...c.servers.map(s => h('option', { value: s.name, text: s.name, dataset: { kind: s.kind || '' } })));
        const now = c.setup || {};
        if (now.server) server.value = now.server;
        kind.value = now.kind || server.selectedOptions[0]?.dataset.kind || 'linear';
        scope.value = now.scope || '';
        stop.hidden = !c.setup;
        placeholder();
        hint.textContent = 'Claude reads them through that server, only reading, and only when this list is opened (every half hour at most). Do this works on them like an issue.';
        scope.focus();
      }).catch(() => { hint.textContent = 'Couldn\'t read your MCP servers.'; });
      return form;
    }

    /** What the card should say about where the list came from. */
    function notes(v) {
      const out = [];
      const g = v.github;
      if (v.repo && g.state === 'signedOut') out.push('Sign in to GitHub in Settings to see its issues here.');
      if (v.repo && g.state === 'off') out.push('Turn on Show my repositories in Settings → GitHub to see its issues here.');
      if (g.state === 'error') out.push(g.error);
      if (g.stale) out.push(`These issues are from a few minutes ago: ${g.error}`);
      const tr = v.tracker;
      if (tr && tr.state !== 'none') {
        if (tr.state === 'off') out.push(`${tr.label} issues need Claude Code: Shellby reads them through it.`);
        else if (tr.loading && tr.state !== 'ok') out.push(`Reading ${tr.scope} from ${tr.label}…`);
        else if (tr.state === 'error') out.push(tr.error);
        else if (tr.stale) out.push(`These ${tr.label} issues are from earlier: ${tr.error}`);
      }
      if (v.looseEnds?.error) out.push(v.looseEnds.error);
      if (!v.cloned) out.push('Not on this PC: clone it for your tasks and loose ends, and for Do this.');
      const t = v.tasks;
      if (t?.error) out.push(t.error);
      const lines = out.map(text => h('p', { class: 'muted small bl-note', text }));
      if (t?.exists && t.ignored) lines.push(h('p', { class: 'muted small bl-note', text: '.shellby is in .gitignore here, so this list isn\'t version-controlled.' }));
      else if (t?.exists && t.uncommitted) {
        lines.push(h('p', { class: 'muted small bl-note' }, '.shellby/tasks.md has changes no commit has · ',
          h('button', { type: 'button', class: 'link-btn small', text: 'Commit it', title: 'Commits only that file, and doesn\'t push', onclick: commit })));
      }
      return lines;
    }

    async function commit() {
      const r = await api.backlogCommit({ root }).catch(() => null);
      SB.toast(r?.ok ? 'Committed .shellby/tasks.md (and nothing else). Not pushed.' : r?.error || 'Couldn\'t commit it.');
      load(false);
    }

    /** Run an edit, say what went wrong if it did, and redraw. */
    async function act(p, ok) {
      const r = await p.catch(() => null);
      if (!r?.ok) SB.toast(r?.error || 'Couldn\'t do that.');
      else if (ok) SB.toast(ok);
      await load(!!r?.stale);
      return r;
    }

    const taskRef = it => ({ root, id: it.task.id, line: it.task.line });

    function openMenu(it, v, anchor) {
      const m = SB.menuItem;
      // A to-do kept in Shellby (a project with no clone) only has Done; tasks.md tasks have the rest.
      const isNote = !!it.note;
      const isTask = !isNote && (it.kind === 'task' || ((it.kind === 'issue' || it.kind === 'ticket') && it.task));
      const helpers = it.kind === 'issue' && !it.doing ? v.helpers : [];
      const tracker = it.ticket ? (it.ticket.tracker === 'jira' ? 'Jira' : 'Linear') : '';
      SB.openMenu($('blMenu'), anchor, () => [
        it.kind === 'issue' && m('Open on GitHub', () => act(api.backlogOpenIssue({ ...target, id: it.id }))),
        it.kind === 'ticket' && it.ticket.url && m(`Open in ${tracker}`, () => api.openExternal(it.ticket.url)),
        it.kind === 'issue' && !it.task && v.cloned && m('Add to my tasks', () => act(api.backlogAddIssue({ root, id: it.id }), `#${it.issue.number} is on your list. Move it in .shellby/tasks.md to put it where you want it.`)),
        it.kind === 'ticket' && !it.task && v.cloned && m('Add to my tasks', () => act(api.backlogAddIssue({ root, id: it.id }), `${it.ticket.key} is on your list. Move it in .shellby/tasks.md to put it where you want it.`)),
        it.kind === 'todo' && m('Open file', () => act(api.backlogOpenTodo({ root, id: it.id }))),
        isNote && m('Done', () => act(api.finishProjectTodo({ key: v.key, id: it.note.id }), 'Ticked off.')),
        isTask && it.kind === 'task' && m('Edit…', () => rename(it)),
        isTask && it.tier !== 'now' && m('Move to Now', () => act(api.backlogEdit({ ...taskRef(it), op: 'move', to: 'now' }))),
        isTask && it.tier === 'now' && m('Move to Next', () => act(api.backlogEdit({ ...taskRef(it), op: 'move', to: 'next' }))),
        isTask && it.tier !== 'later' && m('Move to Later', () => act(api.backlogEdit({ ...taskRef(it), op: 'move', to: 'later' }))),
        isTask && m(it.kind !== 'task' ? 'Tick off my task for it' : 'Tick off', () => act(api.backlogEdit({ ...taskRef(it), op: 'tick' }), 'Ticked off. It\'s under Done in .shellby/tasks.md.')),
        isTask && it.kind === 'task' && m('Remove', () => act(api.backlogEdit({ ...taskRef(it), op: 'remove' }))),
        ...helpers.map(wf => m(`Hand it to ${wf.name}`, () => hand(it, wf))),
        it.kind !== 'task' && m('Hide', () => act(api.backlogHide({ ...target, id: it.id }), 'Hidden on this PC. Show it again from the bottom of the list.')),
      ]);
    }

    function rename(it) {
      const b = [...box.querySelectorAll('.bl-row')].find(li => li.dataset.id === it.id)?.querySelector('.pj-h-text b');
      if (!b) return;
      const input = h('input', { type: 'text', class: 'field slim bl-rename', value: it.title, 'aria-label': 'Task', maxlength: '200' });
      let settled = false;
      const done = async save => {
        if (settled) return;
        settled = true;
        const title = input.value.trim();
        if (save && title && title !== it.title) await act(api.backlogEdit({ ...taskRef(it), op: 'rename', title }));
        else draw(views.get(key));
      };
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); done(true); }
        if (e.key === 'Escape') { e.stopPropagation(); done(false); }
      });
      input.addEventListener('blur', () => done(true), { once: true });
      b.replaceWith(input);
      input.focus();
      input.select();
    }

    async function hand(it, wf) {
      const r = await api.backlogHand({ ...target, id: it.id, workflowId: wf.id }).catch(() => null);
      if (r?.cancelled) return;
      if (!r?.ok) return SB.toast(r?.error || 'It didn\'t start.');
      SB.toast(r.queued ? `${r.name} will take #${it.issue.number} once its current run is done.` : `${r.name} is on #${it.issue.number}. Follow it on the Automate page.`, { ms: 7000 });
    }

    async function doThis(it, btn) {
      if (SB.isCrabOnly()) return SB.claudeUpsell('backlog');
      btn.disabled = true;
      btn.textContent = 'Making a copy…';
      const r = await api.backlogDo({ ...target, id: it.id }).catch(() => null);
      btn.disabled = false;
      btn.textContent = 'Do this';
      if (!r?.ok) {
        if (r?.needsClaude) return SB.claudeUpsell('backlog');
        if (r?.doing) return openTab(r.tabId);
        if (r?.busy) return;
        if (r?.needsClone && onClone) return SB.toast(r.error, { ms: 8000, action: 'Clone…', onAction: () => onClone(r.repo) });
        SB.toast(r?.error || 'Couldn\'t start that.', { ms: 7000 });
        if (r?.stale) load(true);
        return;
      }
      openTab(r.tabId);
      SB.toast(r.warn || 'It\'s in a copy on its own branch. Read the prompt, then send it.', { ms: r.warn ? 10000 : 6000 });
      load(false);
    }

    if (views.has(key)) draw(views.get(key));
    else body.replaceChildren(h('p', { class: 'muted small pj-calm', text: `Putting together what's next for ${name}…` }));
    load(false);
    return box;
  }

  // A Linear or Jira read finished in the background: that project's card, if it's showing, looks again.
  api.onBacklogChanged(o => {
    const k = o?.root ? keyOf({ root: o.root }) : o?.repo ? keyOf({ repo: o.repo }) : null;
    for (const [cardKey, c] of live) {
      if (!c.box.isConnected) { live.delete(cardKey); continue; }
      if (cardKey === k) c.load(false);
    }
  });

  // A Next up task's work came home, or its pull request merged: tick it off?
  api.onBacklogOfferTick(o => {
    if (!o?.tabId || !o.title) return;
    SB.toast(`${o.why === 'merged' ? 'Merged' : 'Brought home'}. Tick off “${o.title}”?`, {
      ms: 14000, action: 'Tick it off',
      onAction: async () => {
        const r = await api.backlogTickLinked(o.tabId).catch(() => null);
        SB.toast(r?.ok ? `Ticked off: ${r.title}` : r?.error || 'Couldn\'t tick it off.');
      },
    });
  });

  /** The copy menu's extra item for a Next up conversation (tab-git.js). */
  async function copyMenuItems(tab) {
    const info = await api.backlogTab(tab.id).catch(() => null);
    if (!info?.linked) return [];
    const item = (icon, title, sub, run) => h('button', { class: 'menu-item', onclick: () => { SB.closeMenus(); run(); } },
      h('span', { class: 'mi-check', text: icon }),
      h('span', {}, h('div', { class: 'mi-title', text: title }), h('div', { class: 'mi-sub', text: sub })));
    if (info.pr) return [item('⇱', 'Open the pull request', `#${info.pr.number}, opened from Next up`, () => api.openExternal(info.pr.url))];
    if (info.needsPush) return [item('⇡', 'Open a draft pull request', 'Needs “Let Claude tasks push” on in Settings → GitHub', () => SB.toast('Turn on Let Claude tasks push in Settings → GitHub first.'))];
    if (!info.canPr) return [];
    const sub = info.issue ? `Push this branch and open a draft that closes #${info.issue}`
      : info.ticket ? `Push this branch and open a draft linked to ${info.ticket}` : 'Push this branch and open a draft pull request';
    return [item('⇡', 'Open a draft pull request', sub, async () => {
      if (tab.busy) return SB.toast('Let him finish first.');
      SB.toast('Pushing the branch and opening a draft…', { ms: 8000 });
      const r = await api.backlogOpenPr(tab.id).catch(() => null);
      if (!r?.ok) return SB.toast(r?.error || 'Couldn\'t open it.', { ms: 9000 });
      SB.toast(`Draft pull request #${r.number} is up.`, { ms: 10000, action: 'Open it', onAction: () => api.openExternal(r.url) });
    })];
  }

  SB.backlog = { card, copyMenuItems };
})();
