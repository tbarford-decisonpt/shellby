/* Shellby panel — Toolbox → Team: the repo's team pack (.shellby/team.json), so
   a teammate gets the same snippets, workflows, hooks and rules straight away.
   Main reads the file and does every add (team-ipc.js), through the confirm
   windows those already have; this lists what's in it, what you have, and the
   form for making one. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const STALE_MS = 3000;
  const SCOPES = [['local', 'Just me, in this project'], ['user', 'Me, in every project']];
  const LIST_WORDS = { allow: 'Runs without asking', ask: 'Always asks first', deny: 'Never runs' };
  const WHERE_WORDS = { user: 'in your settings', project: "in the project's shared settings", local: 'in your settings for this project' };

  let loading = null;
  let lastTry = 0;
  let busy = null;        // what's being added: 'snippets', 'wf:name', 'hook:<key>'…
  let gen = 0;            // bumped by every newer view, so a slow refresh can't put an older one back
  let draft = null;       // the make/edit form while it's open
  let written = null;     // { file, notes } after a save, until the form opens again
  const scopes = new Map(); // 'hook:<key>' -> 'local' | 'user', kept across re-renders

  const rerender = () => { if (state.view === 'toolbox') SB.views.toolbox.render(); };

  function refresh(force = false) {
    if (loading || (!force && Date.now() - lastTry < STALE_MS)) return loading;
    lastTry = Date.now();
    const at = gen;
    loading = api.getTeamPack()
      .then(v => { if (at === gen) state.team = v; })
      .catch(() => {})
      .finally(() => { loading = null; rerender(); });
    return loading;
  }

  const count = () => (state.team?.hasPack ? (state.team.waiting || '') : '');

  async function act(key, fn, okText) {
    if (busy) return;
    busy = key;
    rerender();
    let r;
    try { r = await fn(); } catch { r = { ok: false, error: "Shellby couldn't do that. Try again." }; }
    busy = null;
    if (r?.view) { state.team = r.view; gen++; }
    if (r?.ok && okText) SB.toast(okText);
    else if (r && !r.ok && !r.cancelled && r.error) SB.toast(r.error, { ms: 7000 });
    rerender();
    // The pane was redrawn: back to the same button, or its row once the button has gone.
    const pane = $('setupPane');
    const back = [...pane.querySelectorAll('[data-act]')].find(el => el.dataset.act === key)
      || [...pane.querySelectorAll('[data-row]')].find(el => el.dataset.row === key);
    back?.focus();
    return r;
  }

  // ================================================================ what's in it

  const section = (title, n, ...rows) => (n ? [h('div', { class: 'row-label team-label', text: `${title} (${n})` }), ...rows] : []);
  const doneTag = text => h('span', { class: 'team-done', text: `✓ ${text}` });

  const scopePick = (key) => {
    const sel = h('select', { class: 'field slim', 'aria-label': 'Where to add it', onchange: e => scopes.set(key, e.target.value) },
      SCOPES.map(([v, t]) => h('option', { value: v, text: t })));
    sel.value = scopes.get(key) || 'local';
    return sel;
  };

  function snippetsBlock(s, q) {
    const list = s.list.filter(x => !q || x.name.includes(q) || x.text.toLowerCase().includes(q));
    if (!s.list.length || (q && !list.length)) return [];
    const head = {
      off: ['Prompts the team saves as /name. Read them first: they go to Claude as written when you use one.', 'Use these snippets'],
      changed: ['The team changed these since you turned them on, so they\'re off until you look again.', 'Use the new ones'],
      on: ['On in this repo. Type /name in the box, or shellby do @name in a terminal here.', null],
    }[s.state];
    return section('Snippets', s.list.length,
      h('div', { class: 'mcp-bar team-bar' },
        h('span', { class: `muted small${s.state === 'changed' ? ' warn' : ''}`, text: head[0] }),
        head[1]
          ? h('button', { class: 'btn primary slim-btn', type: 'button', dataset: { act: 'snippets' }, disabled: !!busy, onclick: () => act('snippets', () => api.useTeamSnippets(s.hash), 'Team snippets are on in this repo') }, busy === 'snippets' ? '…' : head[1])
          : h('button', { class: 'btn ghost slim-btn', type: 'button', dataset: { act: 'snippets' }, disabled: !!busy, onclick: () => act('snippets', () => api.stopTeamSnippets(), 'Team snippets are off') }, 'Turn off')),
      h('ul', { class: 'tool-list team-list' }, list.map(x => h('li', { class: 'tool-row snippet-row' },
        h('div', { class: 'tool-main' },
          h('div', { class: 'tool-name' }, h('code', { text: `/${x.name}` }), x.hint ? h('span', { class: 'snip-hint', text: `<${x.hint}>` }) : null),
          h('p', { class: 'tool-desc', text: x.text }),
          x.yours ? h('p', { class: 'snip-note', text: `You have your own /${x.name}, so yours runs.` }) : null)))));
  }

  function workflowRow(w) {
    const key = `wf:${w.name}`;
    const label = { new: 'Add', different: 'Update' }[w.state];
    return h('li', { class: 'tool-row', tabindex: '-1', dataset: { row: key } },
      h('div', { class: 'tool-main' },
        h('div', { class: 'tool-name' }, h('span', { text: `⚡ ${w.name}` })),
        w.description ? h('p', { class: 'tool-desc', text: w.description }) : null,
        h('p', { class: `tool-stats${w.error ? ' err' : ''}`, text: w.error || (w.state === 'different' ? `${w.steps} steps · yours differs from the team's` : `${w.steps} step${w.steps === 1 ? '' : 's'}`) })),
      h('div', { class: 'tool-actions' },
        w.state === 'added' ? doneTag('Added')
          : label ? h('button', { class: 'btn slim-btn', type: 'button', dataset: { act: key }, disabled: !!busy, title: 'Shows everything it can do before adding it',
            onclick: () => act(key, () => api.addTeamWorkflow(w.name), w.state === 'new' ? `Added "${w.name}" to Automate` : `Updated "${w.name}"`) }, busy === key ? '…' : label) : null));
  }

  // Led by what Shellby makes of the command, then the command itself: the
  // pack's own "about" is the team's word for it, so it comes last, quoted.
  function hookRow(x) {
    const key = `hook:${x.key}`;
    return h('li', { class: 'tool-row', tabindex: '-1', dataset: { row: key } },
      h('div', { class: 'tool-main' },
        h('div', { class: 'tool-name' }, h('span', { text: x.describe })),
        h('code', { class: 'team-cmd', text: x.command, title: x.command }),
        x.about ? h('p', { class: 'tool-stats', text: `The team says: “${x.about}”` }) : null),
      h('div', { class: 'tool-actions team-add' },
        x.state === 'added' ? doneTag(`Added ${WHERE_WORDS[x.where] || ''}`.trim())
          : [scopePick(key), h('button', { class: 'btn slim-btn', type: 'button', dataset: { act: key }, disabled: !!busy, title: 'Shows the command before adding it',
            onclick: () => act(key, () => api.addTeamHook(x.key, scopes.get(key) || 'local'), 'Hook added') }, busy === key ? '…' : 'Add')]));
  }

  function ruleRow(x) {
    const key = `rule:${x.key}`;
    return h('li', { class: 'tool-row', tabindex: '-1', dataset: { row: key } },
      h('div', { class: 'tool-main' },
        h('div', { class: 'tool-name' }, h('code', { text: x.rule })),
        h('p', { class: 'tool-stats', text: `${x.list}: ${LIST_WORDS[x.list]}` })),
      h('div', { class: 'tool-actions team-add' },
        x.state === 'added' ? doneTag(`Added ${WHERE_WORDS[x.where] || ''}`.trim())
          : [scopePick(key), h('button', { class: 'btn slim-btn', type: 'button', dataset: { act: key }, disabled: !!busy,
            onclick: () => act(key, () => api.addTeamRule(x.key, scopes.get(key) || 'local'), 'Rule added') }, busy === key ? '…' : 'Add')]));
  }

  function packView(v, q) {
    const match = (...texts) => !q || texts.some(t => (t || '').toLowerCase().includes(q));
    const wfs = v.workflows.filter(w => match(w.name, w.description));
    const hooks = v.hooks.filter(x => match(x.command, x.about, x.describe));
    const rules = v.rules.filter(x => match(x.rule));
    const body = [
      ...snippetsBlock(v.snippets, q),
      ...section('Workflows', wfs.length, h('ul', { class: 'tool-list team-list' }, wfs.map(workflowRow))),
      ...section('Hooks', hooks.length,
        h('p', { class: 'muted small team-note', text: 'Optional ones the team suggests. Hooks run commands with your Windows account, so read each one.' }),
        h('ul', { class: 'tool-list team-list' }, hooks.map(hookRow))),
      ...section('Rules', rules.length, h('ul', { class: 'tool-list team-list' }, rules.map(ruleRow))),
    ];
    return [
      h('div', { class: 'team-head' },
        h('div', { class: 'team-title' },
          h('h3', { text: v.name || v.where.name }),
          h('p', { class: 'muted small', text: v.about || `The team pack in ${v.where.name}, from .shellby/team.json.` })),
        h('div', { class: 'team-head-btns' },
          h('button', { class: 'btn ghost slim-btn', type: 'button', onclick: () => api.revealTeamPack() }, 'Show file'),
          h('button', { class: 'btn ghost slim-btn', type: 'button', onclick: openDraft }, 'Edit pack'))),
      v.waiting ? null : h('p', { class: 'setup-status team-all', role: 'status', text: '✓ You have everything in this team pack.' }),
      v.problems?.length ? h('details', { class: 'team-problems' },
        h('summary', { text: `${v.problems.length} part${v.problems.length === 1 ? '' : 's'} of the file couldn't be used` }),
        h('ul', {}, v.problems.map(p => h('li', { text: p })))) : null,
      ...(body.length ? body : [h('p', { class: 'history-empty', text: q ? 'No matches.' : 'This team pack is empty.' })]),
    ];
  }

  function noPack(v) {
    return [h('div', { class: 'snip-empty team-empty' },
      h('p', { text: `${v.where.name} has no team pack yet. Make one to share your snippets, workflows, hooks and rules with everyone who works here: it's a file in the repo, .shellby/team.json, that teammates get with git.` }),
      h('button', { class: 'btn primary slim-btn', type: 'button', onclick: openDraft }, 'Make a team pack'))];
  }

  // ================================================================ making one

  async function openDraft() {
    let r;
    try { r = await api.draftTeamPack(); } catch { r = null; }
    if (!r?.ok) return SB.toast(r?.error || "Shellby couldn't do that.", { ms: 7000 });
    const p = r.picked;
    draft = {
      ...r, error: null, saving: false,
      ticked: { snippets: new Set(p.snippets), workflows: new Set(p.workflows), hooks: new Set(p.hooks), rules: new Set(p.rules) },
    };
    written = null;
    $('setupPane').dataset.mounted = '';
    rerender();
    requestAnimationFrame(() => $('teamName')?.focus());
  }

  function closeDraft() { draft = null; $('setupPane').dataset.mounted = ''; rerender(); }

  function picker(kind, title, items, keyOf, labelOf, subOf) {
    if (!items.length) return null;
    const set = draft.ticked[kind];
    return h('fieldset', { class: 'team-pick' },
      h('legend', { class: 'row-label', text: title }),
      items.map(it => {
        const key = keyOf(it);
        const sub = subOf(it);
        return h('label', { class: 'team-check' },
          h('input', { type: 'checkbox', checked: set.has(key), onchange: e => { if (e.target.checked) set.add(key); else set.delete(key); } }),
          h('span', {}, h('span', { class: 'team-check-name', text: labelOf(it) }), sub ? h('span', { class: 'team-check-sub', text: sub }) : null));
      }));
  }

  async function saveDraft() {
    const d = draft;
    if (d.saving) return;
    d.saving = true;
    d.error = null;
    const status = $('teamStatus');
    if (status) { status.textContent = 'Saving…'; status.className = 'setup-status'; }
    let r;
    try {
      r = await api.writeTeamPack({
        name: $('teamName').value, about: $('teamAbout').value,
        snippets: [...d.ticked.snippets], workflows: [...d.ticked.workflows], hooks: [...d.ticked.hooks], rules: [...d.ticked.rules],
      });
    } catch { r = { ok: false, error: "Shellby couldn't save it." }; }
    d.saving = false;
    if (!r?.ok) {
      d.error = r?.error || "Shellby couldn't save it.";
      if (status) { status.textContent = d.error; status.className = 'setup-status err'; }
      return;
    }
    state.team = r.view;
    written = { file: r.file, notes: r.notes || [] };
    closeDraft();
  }

  function draftForm() {
    const d = draft;
    const where = { user: 'yours', project: 'project', local: 'just you' };
    return h('div', { class: 'snip-editor team-editor' },
      h('div', { class: 'snip-head' },
        h('h3', { text: d.exists ? 'Edit the team pack' : 'Make a team pack' }),
        h('span', { class: 'field-hint', text: `${d.repo}/.shellby/team.json` })),
      d.broken ? h('p', { class: 'snip-note', text: "The file there now can't be read, so saving replaces it." }) : null,
      d.missing ? h('p', { class: 'snip-note', text: `The pack has ${d.missing} thing${d.missing === 1 ? '' : 's'} you don't have here. Saving from this PC leaves ${d.missing === 1 ? 'it' : 'them'} out.` }) : null,
      h('label', { class: 'team-field' }, h('span', { class: 'row-label', text: 'Name' }),
        h('input', { id: 'teamName', class: 'field', type: 'text', maxlength: '60', value: d.name, spellcheck: 'false' })),
      h('label', { class: 'team-field' }, h('span', { class: 'row-label', text: 'What it is for (optional)' }),
        h('input', { id: 'teamAbout', class: 'field', type: 'text', maxlength: '300', value: d.about, placeholder: 'How we work on this repo' })),
      picker('snippets', 'Snippets', d.all.snippets, s => s.name, s => `/${s.name}`, s => s.text.split('\n')[0].slice(0, 90)),
      picker('workflows', 'Workflows', d.all.workflows, w => w.id, w => `⚡ ${w.name}`, w => w.description),
      picker('hooks', 'Hooks (teammates choose whether to add each one)', d.all.hooks, x => x.key, x => x.summary || x.command, x => `${x.event}${x.matcher ? ` · ${x.matcher}` : ''} · ${where[x.source] || x.source}`),
      picker('rules', 'Rules', d.all.rules, x => x.key, x => x.rule, x => `${x.list} · ${where[x.scope] || x.scope}`),
      !d.all.snippets.length && !d.all.workflows.length && !d.all.hooks.length && !d.all.rules.length
        ? h('p', { class: 'muted small', text: 'You have nothing to share yet: save a snippet or a workflow first.' }) : null,
      h('p', { class: 'muted small', text: 'Anyone who can read the repo can read this file. Shellby won\'t save anything that looks like a password or key.' }),
      h('div', { class: 'row' },
        h('p', { id: 'teamStatus', class: `setup-status${d.error ? ' err' : ''}`, role: 'status', text: d.error || '' }),
        h('button', { class: 'btn ghost slim-btn', type: 'button', onclick: closeDraft }, 'Cancel'),
        h('button', { class: 'btn primary slim-btn', type: 'button', onclick: saveDraft }, d.exists ? 'Save changes' : 'Make it')));
  }

  function writtenNote() {
    if (!written) return null;
    return h('div', { class: 'team-written', role: 'status' },
      h('p', {}, 'Saved. Commit ', h('code', { text: written.file }), ' and push it, and your team gets it the next time they pull.'),
      written.notes.map(n => h('p', { class: 'snip-note', text: n })),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Dismiss', onclick: () => { written = null; rerender(); } }, h('span', { text: '✕' })));
  }

  // ================================================================ the tab

  function render(q) {
    refresh();
    const pane = $('setupPane');
    pane.hidden = false;
    $('toolList').hidden = true;
    // The form is built once while it's open, so a refresh can't take the cursor out of it.
    if (draft) {
      if (pane.dataset.mounted !== 'team:draft') { pane.replaceChildren(draftForm()); pane.dataset.mounted = 'team:draft'; }
      return;
    }
    pane.dataset.mounted = 'team';
    const v = state.team;
    let body;
    if (!v) body = [h('p', { class: 'history-empty', text: 'Looking for a team pack…' })];
    else if (!v.where) body = [h('p', { class: 'history-empty', text: "A team pack lives in a git repository. Pick a project folder to see its pack, or make one." })];
    else if (!v.hasPack) body = noPack(v);
    else if (v.error) {
      body = [h('div', { class: 'snip-empty team-empty' },
        h('p', { class: 'snip-note', text: v.error }),
        h('div', { class: 'row' },
          h('button', { class: 'btn ghost slim-btn', type: 'button', onclick: () => api.revealTeamPack() }, 'Show file'),
          h('button', { class: 'btn slim-btn', type: 'button', onclick: openDraft }, 'Make it again')))];
    } else body = packView(v, q);
    pane.replaceChildren(...[writtenNote(), ...body].filter(Boolean));
  }

  // Another folder: another repo's pack. An open form was for the old one.
  api.onTeam?.((v) => {
    state.team = v;
    lastTry = Date.now();
    gen++;
    if (draft) closeDraft(); else rerender();
  });

  // The repo you're in has a team pack you haven't seen (or it changed).
  api.onTeamNotice?.((n) => {
    lastTry = 0;
    const what = n.name ? `${n.name} (${n.repo})` : n.repo;
    SB.toast(n.first ? `${what} has a team pack: ${n.contents}.` : `The team pack in ${what} changed.`, {
      action: 'Have a look', ms: 12000, onAction: () => SB.showToolbox('team'),
    });
    if (state.view === 'toolbox') rerender();
  });

  SB.toolboxTeam = { render, count, refresh: () => refresh(true) };
})();
