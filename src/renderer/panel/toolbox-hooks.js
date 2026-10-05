/* Shellby panel — Toolbox → Hooks: automatic actions Claude Code runs at set
   moments. The list says in words what each hook does and when, grouped by
   moment; New hook starts from a recipe (or a blank one); the form explains each
   choice; Test run tries a command once; Pause takes a hook out without losing it.
   Every change, and every first test of a command, asks in the confirm window
   (main.js), and main re-checks all of it. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const kit = () => SB.setupKit;

  // null: the list. { step: 'pick' } or { step: 'form', entry, recipe, draft, error, test, claude }.
  let ed = null;
  const openRows = new Set();        // rows opened up, so a rescan doesn't fold them shut
  const rowTests = new Map();        // row id -> { busy, verdict, error }
  let forgetArmed = null;            // a paused hook's id, for a few seconds after the first click on "Forget it"
  let asking = false;                // Claude is writing a hook; one ask at a time
  const askText = { pick: '', form: '' }; // what's typed in each Ask Claude box, kept across redraws

  const SCOPE = {
    user: { title: 'Every project', sub: 'Only you. Saved in your own Claude Code settings.' },
    project: { title: 'This project, shared', sub: 'Saved in .claude/settings.json, so anyone with the project gets it too.' },
    local: { title: 'This project, only you', sub: 'Saved in .claude/settings.local.json, which git usually leaves out.' },
  };
  const SCOPE_SHORT = { user: 'every project', project: 'this project, shared', local: 'this project, only you' };
  // Tool chips: a chip can stand for more than one tool name (Glob|Grep).
  const TOOLS = [
    ['Bash', 'Shell commands'], ['Edit|MultiEdit', 'Edits'], ['Write', 'New files'], ['Read', 'Reading files'],
    ['Glob|Grep', 'Searching'], ['WebFetch|WebSearch', 'The web'], ['Agent|Task', 'Helper agents'], ['mcp__.*', 'MCP tools'],
  ];
  const TOOL_WORDS = {
    Bash: 'shell commands', Edit: 'edits', MultiEdit: 'edits', Write: 'new files', Read: 'reading files',
    Glob: 'searches', Grep: 'searches', WebFetch: 'web pages', WebSearch: 'web searches', Agent: 'helper agents', Task: 'helper agents', 'mcp__.*': 'MCP tools',
  };

  const events = () => state.setup.events;
  // A row by what it is, not where it sits, so removing the one above doesn't hand it another's state.
  const rowKey = t => `${t.source}\n${t.paused ? t.pausedId : t.fp}`;
  const eventOf = name => events().find(e => e.name === name);
  const isPlugin = t => t.source.startsWith('plugin:');
  const tokens = m => String(m || '').split('|').map(s => s.trim()).filter(Boolean);
  const chipOn = (m, value) => tokens(value).every(v => tokens(m).includes(v));
  const capital = s => s.charAt(0).toUpperCase() + s.slice(1);
  const join = words => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);

  /** "for shell commands", "for new sessions", "" for everything. */
  function matcherWords(event, matcher) {
    const e = eventOf(event);
    if (!matcher || matcher === '*' || !e?.matcher) return '';
    if (e.choices) {
      const labels = tokens(matcher).map(t => e.choices.find(c => c[0] === t)?.[1].toLowerCase() || t);
      return `for ${join(labels)}`;
    }
    if (e.tools && /^[\w|.*]+$/.test(matcher)) {
      const words = [...new Set(tokens(matcher).map(t => TOOL_WORDS[t] || t))];
      return `only for ${join(words)}`;
    }
    return `only when it matches ${matcher}`;
  }

  /** When it runs, for what, and where, in a sentence or two. */
  function sentence(t) {
    const e = eventOf(t.event);
    const what = matcherWords(t.event, t.matcher);
    const when = `${e ? e.when : `on ${t.event}`}${what ? `, ${what}` : ''}`;
    const where = isPlugin(t) ? `It comes with the ${kit().sourceLabel(t.source)} plugin.` : `Saved for ${SCOPE_SHORT[t.source] || t.source}.`;
    return t.paused ? `Paused, so Claude Code isn't running it. Resumed, it runs ${when}. ${where}` : `Runs ${when}. ${where}`;
  }

  // ================================================================ the list

  async function act(fn, done, failed) {
    const r = await kit().call(fn);
    if (r.ok) { rowTests.clear(); if (done) SB.toast(done); } else if (!r.cancelled) SB.toast(r.error || failed);
    kit().rerender();
    return r;
  }

  function testResult(t) {
    const run = rowTests.get(rowKey(t));
    if (!run) return null;
    if (run.busy) return h('p', { class: 'hook-verdict busy', role: 'status', text: 'Running it once…' });
    if (run.error) return h('p', { class: 'hook-verdict warn', role: 'status', text: run.error });
    return verdictBox(run.verdict, run.result);
  }

  async function testRow(t) {
    const key = rowKey(t);
    rowTests.set(key, { busy: true });
    kit().rerender();
    const r = await kit().call(() => api.testHook({ event: t.event, matcher: t.matcher, command: t.command, timeout: t.timeout }));
    if (r.cancelled) rowTests.delete(key);
    else rowTests.set(key, r.ok ? { verdict: r.verdict, result: r.result } : { error: r.error || "Couldn't run it." });
    kit().rerender();
  }

  function rowActions(t) {
    const ours = !isPlugin(t);
    const btn = (label, onclick, cls = 'btn ghost slim-btn', extra = {}) => h('button', { class: cls, type: 'button', onclick, ...extra }, label);
    const out = [];
    if (t.type === 'command') out.push(btn('Test run', () => testRow(t), 'btn ghost slim-btn', { title: 'Run it once now with made-up details, to see what Claude Code would do' }));
    if (t.paused) {
      out.push(btn('Resume', () => act(() => api.resumeHook(t.pausedId), 'Hook resumed. New sessions run it again.', "Couldn't resume that hook"), 'btn slim-btn'));
      const armed = forgetArmed === t.pausedId;
      out.push(btn(armed ? 'Forget it for good?' : 'Forget it', () => {
        if (!armed) {
          forgetArmed = t.pausedId;
          setTimeout(() => { if (forgetArmed === t.pausedId) { forgetArmed = null; kit().rerender(); } }, 4000);
          kit().rerender();
          return;
        }
        forgetArmed = null;
        act(() => api.forgetPausedHook(t.pausedId), 'Paused hook forgotten', "Couldn't forget that hook");
      }, armed ? 'btn danger slim-btn' : 'btn ghost slim-btn'));
      return out;
    }
    if (t.editable) out.push(btn('Edit', () => { ed = { step: 'form', entry: t, recipe: null, error: '' }; kit().rerender(); }));
    if (ours) {
      out.push(btn('Pause', () => act(() => api.pauseHook(t.source, t.at, t.fp), 'Hook paused. Resume it any time.', "Couldn't pause that hook"),
        'btn ghost slim-btn', { title: 'Stop it running for now, without losing it' }));
    }
    out.push(btn('Show file', () => api.revealSetupFile(t.path)));
    if (ours) {
      out.push(btn('Remove', () => act(() => api.removeHook(t.source, t.at, t.fp), 'Hook removed', "Couldn't remove that hook"),
        'btn ghost slim-btn danger-hover', { 'aria-label': 'Remove this hook' }));
    }
    return out;
  }

  function hookRow(t) {
    const what = matcherWords(t.event, t.matcher);
    const key = rowKey(t);
    const row = h('details', { class: `hook-row${t.paused ? ' is-paused' : ''}`, open: openRows.has(key) },
      h('summary', { class: 'hook-sum' },
        h('span', { class: 'hook-icon', 'aria-hidden': 'true', text: t.icon || (t.paused ? '⏸️' : '⚙️') }),
        h('span', { class: 'hook-title' },
          h('strong', { text: t.summary }),
          h('span', { class: 'hook-meta', text: capital([what, isPlugin(t) ? null : SCOPE_SHORT[t.source]].filter(Boolean).join(' · ') || 'every time') })),
        t.paused ? h('span', { class: 'hook-badge', text: 'Paused' }) : null,
        isPlugin(t) ? h('span', { class: 'src-pill', text: kit().sourceLabel(t.source) }) : null),
      h('div', { class: 'hook-detail' },
        h('p', { class: 'hook-sentence', text: sentence(t) }),
        h('pre', { class: 'hook-full', text: t.command || '(empty)' }),
        t.type !== 'command' ? h('p', { class: 'muted small', text: `A ${t.type} hook. Shellby can list it, but only command hooks can be edited here.` }) : null,
        isPlugin(t) ? h('p', { class: 'muted small', text: 'To stop it, turn the plugin off in Get more.' }) : null,
        testResult(t),
        h('div', { class: 'row hook-actions' }, rowActions(t))));
    row.addEventListener('toggle', () => { if (row.open) openRows.add(key); else openRows.delete(key); });
    return h('li', {}, row);
  }

  // Grouped by moment, in the order a session meets them.
  function groups(rows) {
    const order = name => { const i = events().findIndex(e => e.name === name); return i < 0 ? 99 : i; };
    const byEvent = new Map();
    for (const t of rows) byEvent.set(t.event, [...(byEvent.get(t.event) || []), t]);
    return [...byEvent.keys()].sort((a, b) => order(a) - order(b) || a.localeCompare(b)).map(name =>
      h('li', { class: 'hook-group' },
        h('h3', { class: 'hook-group-head' },
          h('span', { text: eventOf(name)?.label || name }),
          h('code', { text: name, title: 'What Claude Code calls this moment' })),
        h('ul', { class: 'hook-rows' }, byEvent.get(name).map(hookRow))));
  }

  function starters() {
    const recipes = state.setup.recipes || [];
    const picks = ['sound-done', 'guard-git', 'git-context'].map(id => recipes.find(r => r.id === id)).filter(Boolean);
    return h('li', { class: 'hook-empty' },
      h('p', { class: 'hook-empty-title', text: "You don't have any hooks of your own yet." }),
      h('p', { class: 'muted small', text: 'A few people start with:' }),
      h('div', { class: 'hook-recipes' }, picks.map(recipeButton)),
      h('button', { class: 'btn ghost slim-btn', type: 'button', onclick: () => { ed = { step: 'pick' }; kit().rerender(); } }, 'See every idea'));
  }

  function renderList(q) {
    const s = state.setup;
    const pane = $('setupPane');
    const list = $('toolList');
    list.hidden = false;
    const unreadable = s.settings.filter(f => f.state === 'unreadable');
    const canAdd = s.settings.some(f => f.state !== 'unreadable');
    pane.dataset.mounted = 'hooks';
    pane.replaceChildren(
      h('div', { class: 'setup-intro' },
        h('p', { text: 'Hooks are things Claude Code does by itself at moments you choose: play a sound when it finishes, stop a risky command, tidy a file after an edit.' }),
        canAdd ? h('button', { class: 'btn primary slim-btn', type: 'button', onclick: () => { ed = { step: 'pick' }; kit().rerender(); } }, '+ New hook') : null),
      unreadable.map(f => h('p', { class: 'setup-warn', text: `Couldn't read ${SB.tildify(f.path)}, so its hooks aren't listed and Shellby won't change it.` })));

    const match = t => !q || [t.summary, t.event, eventOf(t.event)?.label || '', t.matcher, t.command, t.source].some(v => String(v).toLowerCase().includes(q));
    const own = [...s.hooks.filter(t => !isPlugin(t)), ...(s.paused || [])].filter(match);
    const plugins = s.hooks.filter(isPlugin).filter(match);
    const items = [];
    if (own.length) items.push(...groups(own.slice(0, 300)));
    else if (!q && canAdd) items.push(starters());
    if (plugins.length) {
      const names = [...new Set(plugins.map(t => kit().sourceLabel(t.source)))];
      items.push(h('li', {}, h('details', { class: 'hook-plugins', open: !!q },
        h('summary', {}, h('span', { text: `From plugins (${plugins.length})` }), h('span', { class: 'muted small', text: join(names) })),
        h('p', { class: 'muted small', text: 'Plugins you installed bring these. Turn a plugin off or remove it in Get more.' }),
        h('ul', { class: 'hook-rows' }, groups(plugins.slice(0, 300))))));
    }
    if (!items.length) items.push(h('li', { class: 'history-empty', text: q ? 'No matches.' : 'No hooks yet.' }));
    list.replaceChildren(...items);
  }

  // ================================================================ new hook: pick a starting point

  function recipeButton(r) {
    const e = eventOf(r.event);
    const what = matcherWords(r.event, r.matcher);
    return h('button', {
      class: 'hook-recipe', type: 'button', dataset: { recipe: r.id },
      onclick: () => { ed = { step: 'form', entry: null, recipe: r, error: '' }; kit().rerender(); },
    },
    h('span', { class: 'hook-icon', 'aria-hidden': 'true', text: r.icon }),
    h('span', { class: 'hook-recipe-text' },
      h('strong', { text: r.title }),
      h('span', { class: 'hook-recipe-blurb', text: r.blurb }),
      h('span', { class: 'hook-meta', text: [e?.label, what].filter(Boolean).join(', ') })));
  }

  // ================================================================ ask Claude
  //
  // Claude only fills in the form (main's hook-draft.js runs it with no tools).
  // Saving still goes through the confirm window, and Test run still asks first.

  // Every Ask Claude control on screen: { el, busy(mine), idle(result or null) }.
  // The pane can be rebuilt while Claude works (a tab away and back), so the
  // end of an ask settles whichever controls are showing then, not the ones it began from.
  const askControls = new Set();
  const liveControls = () => [...askControls].filter(c => c.el.isConnected || (askControls.delete(c), false));

  /** fn() -> { ok, apply } or { ok: false, error }. apply() runs once the controls are free again. */
  async function ask(owner, fn) {
    if (asking) return;
    asking = true;
    for (const c of liveControls()) c.busy(c === owner);
    const r = await fn();
    asking = false;
    for (const c of liveControls()) c.idle(c === owner ? r : null);
    if (!r.ok && !r.cancelled && !owner.el.isConnected) SB.toast(r.error || "Claude couldn't write that hook.");
    if (r.ok) r.apply();
  }

  /** A box to tell Claude what you want. onAsk(text) answers like ask()'s fn. */
  function askBox({ key, label, placeholder, button, hint, onAsk }) {
    const id = `hookAsk-${key}`;
    const box = h('textarea', { class: 'field area hook-ask-text', id, rows: '1', maxlength: '1000', spellcheck: 'true', placeholder, disabled: asking });
    box.value = askText[key];
    const note = h('p', { class: 'field-hint hook-ask-note', id: `${id}-note`, 'aria-live': 'polite', text: asking ? 'Claude is busy with another ask…' : hint });
    box.setAttribute('aria-describedby', note.id);
    const btn = h('button', { class: 'btn slim-btn', type: 'button', disabled: asking }, button);
    const control = {
      el: box,
      busy: mine => {
        box.disabled = true; btn.disabled = true;
        if (mine) { btn.textContent = 'Asking…'; note.classList.remove('err'); note.textContent = 'Claude is writing it. This takes a few seconds.'; }
      },
      idle: r => {
        box.disabled = false; btn.disabled = false; btn.textContent = button;
        if (r?.ok) { askText[key] = ''; return; }
        note.textContent = r ? r.error || "Claude couldn't write that. Try saying it another way." : hint;
        note.classList.toggle('err', !!r);
        if (r) box.focus();
      },
    };
    askControls.add(control);
    const go = () => ask(control, () => onAsk(box.value.trim()));
    box.addEventListener('input', () => { askText[key] = box.value; });
    // It looks like one line, so Enter asks; Shift+Enter starts a new line. Never submits the hook form around it.
    box.addEventListener('keydown', ev => { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); go(); } });
    btn.addEventListener('click', go);
    return h('div', { class: 'hook-ask' },
      h('label', { class: 'hook-label', for: id, text: label }),
      h('div', { class: 'hook-ask-row' }, box, btn),
      note);
  }

  const freshDraft = (hook, where) => ({ ...hook, where, sample: '', sampleEdited: false, sampleOpen: false });
  const hookOf = d => ({ event: d.event, matcher: d.matcher, command: d.command, timeout: d.timeout });
  const sameHook = (a, b) => JSON.stringify(hookOf(a)) === JSON.stringify(hookOf(b));

  async function draftNew(text) {
    const e0 = ed; // a fresh object per visit to New hook, so a late answer can't land on a later visit
    const r = await kit().call(() => api.draftHook(text));
    if (!r.ok) return r;
    return {
      ok: true,
      apply: () => {
        if (ed !== e0) { SB.toast('Claude wrote a hook, but you moved on. Ask again from New hook.'); return; }
        askText.form = '';
        ed = { step: 'form', entry: null, recipe: null, error: '', claude: { title: r.title, note: r.note }, draft: freshDraft(r.hook, r.scope) };
        kit().rerender();
      },
    };
  }

  /** Change the hook in the form. No words means "fix what the failed test run showed". */
  async function revise(e0, text) {
    const before = { ...e0.draft };
    // A test of a command since changed would only mislead.
    const test = e0.test?.verdict && e0.test.command === before.command ? { verdict: e0.test.verdict, result: e0.test.result } : null;
    const r = await kit().call(() => api.draftHook(text, hookOf(before), test));
    if (!r.ok) return r;
    return {
      ok: true,
      apply: () => {
        if (ed !== e0) { SB.toast('Claude changed the hook, but you closed it first.'); return; }
        if (!sameHook(e0.draft, before)) { SB.toast("You changed the hook while Claude worked, so yours was kept. Ask again to use Claude's."); return; }
        // Where it's saved stays the person's choice. Details typed in for the test stay; the example ones follow the new moment.
        const kept = e0.draft.sampleEdited ? { sample: e0.draft.sample, sampleEdited: true, sampleOpen: e0.draft.sampleOpen } : {};
        e0.draft = { ...freshDraft(r.hook, e0.draft.where), ...kept };
        e0.claude = { title: e0.claude?.title || r.title, note: r.note };
        e0.test = null;
        e0.error = '';
        remount('command');
        SB.toast('Claude changed it. Check it over, then try it.');
      },
    };
  }

  function fixButton(e0) {
    if (e0.test?.verdict?.tone !== 'warn' || e0.test.command !== e0.draft.command) return null;
    const label = '✨ Fix it with Claude';
    const btn = h('button', { class: 'btn slim-btn hook-fix', type: 'button', disabled: asking }, label);
    const control = {
      el: btn,
      busy: mine => { btn.disabled = true; if (mine) btn.textContent = 'Claude is looking…'; },
      idle: r => {
        btn.disabled = false; btn.textContent = label;
        if (r && !r.ok && !r.cancelled) SB.toast(r.error || "Claude couldn't fix it.");
      },
    };
    askControls.add(control);
    btn.addEventListener('click', () => ask(control, () => revise(e0, '')));
    return btn;
  }

  function pickView() {
    const s = state.setup;
    const recipes = s.recipes || [];
    return h('div', { class: 'setup-form hook-pick' },
      h('div', { class: 'setup-head' },
        h('button', { class: 'back-btn', type: 'button', onclick: () => { ed = null; kit().rerender(); } }, '← Hooks'),
        h('strong', { text: 'New hook' })),
      askBox({
        key: 'pick', label: 'Describe it, and Claude writes it', button: 'Ask Claude', onAsk: draftNew,
        placeholder: "Don't let Claude edit anything in the migrations folder",
        hint: "You'll see exactly what it runs, and can test it, before anything is saved.",
      }),
      h('p', { class: 'hook-lead', text: "Or pick a starting point. Next you'll see exactly what it runs and can change any of it. Nothing is saved until you say so." }),
      (s.recipeGroups || []).map(g => {
        const mine = recipes.filter(r => r.group === g.id);
        return mine.length ? h('section', { class: 'hook-pick-group' },
          h('h3', { class: 'hook-group-head', text: g.title }),
          h('div', { class: 'hook-recipes' }, mine.map(recipeButton))) : null;
      }),
      h('section', { class: 'hook-pick-group' },
        h('h3', { class: 'hook-group-head', text: 'Something else' }),
        h('button', {
          class: 'hook-recipe', type: 'button', dataset: { recipe: 'custom' },
          onclick: () => { ed = { step: 'form', entry: null, recipe: null, error: '' }; kit().rerender(); },
        },
        h('span', { class: 'hook-icon', 'aria-hidden': 'true', text: '🛠️' }),
        h('span', { class: 'hook-recipe-text' },
          h('strong', { text: 'Write my own' }),
          h('span', { class: 'hook-recipe-blurb', text: 'Choose the moment and type the command yourself.' })))));
  }

  // ================================================================ the form

  function verdictBox(v, result) {
    if (!v) return null;
    const out = [result?.stdout, result?.stderr].filter(x => x && x.trim()).join('\n').trim();
    return h('div', { class: `hook-verdict ${v.tone}`, role: 'status' },
      h('strong', { text: v.title }),
      v.detail ? h('p', { text: v.detail }) : null,
      out ? h('details', {}, h('summary', { text: 'Everything it printed' }), h('pre', { text: out.slice(0, 4000) })) : null);
  }

  // What the moment can do with the command's answer, in words.
  function canDo(e) {
    if (!e) return '';
    const bits = [];
    if (e.context) bits.push('Whatever it prints is passed to Claude.');
    if (e.blocks) bits.push(`It can stop ${e.blocks}: exit with code 2 and print why.`);
    else if (e.feedback) bits.push('Exit with code 2 and Claude is told what it printed.');
    else if (!e.context) bits.push("It can't change what Claude does; it's for side effects like sounds and logs.");
    return bits.join(' ');
  }

  function matcherField(d, e, refreshSample) {
    if (!e?.matcher) return null;
    const input = h('input', { class: 'field mono slim hook-pattern', name: 'matcher', type: 'text', spellcheck: 'false', value: d.matcher, 'aria-label': 'Pattern', placeholder: e.tools ? 'Bash, Edit|Write, mcp__github__.*' : 'blank for all' });
    const chips = [];
    const sync = () => {
      for (const c of chips) c.setAttribute('aria-pressed', String(c.dataset.value ? chipOn(d.matcher, c.dataset.value) : !d.matcher));
      input.value = d.matcher;
    };
    const chip = (value, label) => {
      const c = h('button', { class: 'hook-chip', type: 'button', dataset: { value }, 'aria-pressed': 'false' }, label);
      c.addEventListener('click', () => {
        if (!value) d.matcher = '';
        else {
          const have = tokens(d.matcher);
          const mine = tokens(value);
          d.matcher = (chipOn(d.matcher, value) ? have.filter(t => !mine.includes(t)) : [...have, ...mine.filter(t => !have.includes(t))]).join('|');
        }
        sync();
        refreshSample();
      });
      chips.push(c);
      return c;
    };
    input.addEventListener('input', () => { d.matcher = input.value.trim(); sync(); refreshSample(); });
    const options = e.tools ? TOOLS : e.choices || [];
    const body = options.length
      ? [h('div', { class: 'hook-chips', role: 'group', 'aria-label': 'Only for' }, chip('', e.tools ? 'Every tool' : 'Any'), options.map(([v, l]) => chip(v, l))),
        e.tools ? h('label', { class: 'hook-pattern-row' }, h('span', { class: 'field-hint', text: 'Or a pattern:' }), input) : null]
      : [input];
    sync();
    return h('div', { class: 'hook-field' },
      h('span', { class: 'hook-label', text: e.tools ? 'Which tools?' : e.choices ? 'Which ones?' : 'Which agents?' }),
      body,
      h('span', { class: 'field-hint', text: e.tools ? 'Leave it on Every tool to run for all of them.' : e.choices ? '' : 'An agent type, like Explore. Blank for every agent.' }));
  }

  function whereField(d, entry) {
    const s = state.setup;
    const scopes = entry ? [entry.source] : s.settings.filter(f => f.state !== 'unreadable').map(f => f.scope);
    if (!scopes.includes(d.where)) d.where = scopes[0];
    return h('fieldset', { class: 'hook-field hook-where' },
      h('legend', { class: 'hook-label', text: entry ? 'Saved for' : 'Where should it apply?' }),
      scopes.map(k => {
        const radio = h('input', { type: 'radio', name: 'where', value: k, checked: d.where === k, disabled: !!entry });
        radio.addEventListener('change', () => { if (radio.checked) d.where = k; });
        return h('label', { class: 'hook-where-opt' }, radio,
          h('span', {}, h('strong', { text: SCOPE[k]?.title || k }), h('span', { class: 'field-hint', text: SCOPE[k]?.sub || '' })));
      }));
  }

  function testField(ed, d) {
    const out = () => [testOutput(ed.test), fixButton(ed)].filter(Boolean);
    const box = h('div', { class: 'hook-test-out' }, out());
    const area = h('textarea', { class: 'field area mono hook-sample', spellcheck: 'false', 'aria-label': 'Test details (JSON)', rows: '8' });
    area.value = d.sample || '';
    area.addEventListener('input', () => { d.sample = area.value; d.sampleEdited = true; });
    const reset = h('button', { class: 'btn ghost slim-btn', type: 'button' }, 'Back to the example');
    reset.addEventListener('click', async () => { d.sampleEdited = false; await loadSample(d, true); area.value = d.sample; });
    const more = h('details', { class: 'hook-more', open: !!d.sampleOpen },
      h('summary', { text: 'What Claude Code sends it' }),
      h('p', { class: 'field-hint', text: 'Your command gets these details as JSON on its input. Change them to try a different case, like a different command or file.' }),
      area, h('div', { class: 'row' }, reset));
    more.addEventListener('toggle', () => { d.sampleOpen = more.open; });
    const run = h('button', { class: 'btn slim-btn hook-test-run', type: 'button', disabled: !!ed.test?.busy }, 'Test run');
    // The form may have been rebuilt meanwhile (another moment picked, a tab away and back): update what's showing.
    const show = () => {
      const pane = $('setupPane');
      pane.querySelector('.hook-test-out')?.replaceChildren(...out());
      const btn = pane.querySelector('.hook-test-run');
      if (btn) btn.disabled = !!ed.test?.busy;
    };
    run.addEventListener('click', async () => {
      ed.test = { busy: true };
      show();
      if (!d.sampleEdited) await loadSample(d, true);
      const command = d.command; // what ran, so Fix with Claude can tell if it's been changed since
      const r = await kit().call(() => api.testHook({ event: d.event, matcher: d.matcher, command, timeout: d.timeout }, d.sampleEdited ? d.sample : null));
      if (ed.draft !== d) return; // Claude rewrote the hook meanwhile: this was a test of the old one
      ed.test = r.cancelled ? null : r.ok ? { verdict: r.verdict, result: r.result, command } : { error: r.error || "Couldn't run it." };
      show();
    });
    return h('div', { class: 'hook-field hook-test' },
      h('div', { class: 'hook-test-head' },
        h('span', { class: 'hook-label', text: 'Try it first' }),
        run),
      h('span', { class: 'field-hint', text: 'Runs the command once now with made-up details, and says what Claude Code would do with the answer.' }),
      box, more);
  }

  function testOutput(t) {
    if (!t) return null;
    if (t.busy) return h('p', { class: 'hook-verdict busy', role: 'status', text: 'Running it once…' });
    if (t.error) return h('p', { class: 'hook-verdict warn', role: 'status', text: t.error });
    return verdictBox(t.verdict, t.result);
  }

  async function loadSample(d, force = false) {
    if (d.sampleEdited && !force) return;
    const sample = await api.sampleHookInput({ event: d.event, matcher: d.matcher, command: d.command }).catch(() => null);
    if (sample) d.sample = JSON.stringify(sample, null, 2);
  }

  function hookForm(e0) {
    const entry = e0.entry;
    const recipe = e0.recipe;
    e0.draft = e0.draft || {
      event: entry?.event || recipe?.event || 'PreToolUse',
      matcher: entry?.matcher ?? recipe?.matcher ?? '',
      command: entry?.command || recipe?.command || '',
      timeout: entry?.timeout ?? recipe?.timeout ?? '',
      where: entry?.source || recipe?.scope || 'user',
      sample: '', sampleEdited: false, sampleOpen: false,
    };
    const d = e0.draft;
    const e = eventOf(d.event);
    const refreshSample = () => { if (!d.sampleEdited) loadSample(d).then(() => { const a = $('setupPane').querySelector('.hook-sample'); if (a && !d.sampleEdited) a.value = d.sample; }); };
    if (!d.sample) refreshSample();

    const event = h('select', { class: 'field', name: 'event', 'aria-describedby': 'hookCanDo' }, events().map(x => h('option', { value: x.name, text: x.label })));
    event.value = d.event;
    event.addEventListener('change', () => {
      const was = eventOf(d.event);
      d.event = event.value;
      const now = eventOf(d.event);
      const sameKind = was && now && !!was.tools === !!now.tools && !was.choices && !now.choices;
      if (!now?.matcher || !sameKind) d.matcher = '';
      remount('event');
    });
    // One line, but wrapped so a long command can be read whole. Enter submits instead of breaking it.
    const command = h('textarea', { class: 'field mono hook-command', name: 'command', rows: '1', spellcheck: 'false', placeholder: 'bash -c \'echo "hello from a hook"\'' });
    command.value = d.command;
    command.addEventListener('input', () => { d.command = command.value; });
    command.addEventListener('keydown', ev => { if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); command.form?.requestSubmit(); } });
    const timeout = h('input', { class: 'field', name: 'timeout', type: 'number', min: '1', max: '3600', placeholder: '60', value: d.timeout });
    timeout.addEventListener('input', () => { d.timeout = timeout.value; });
    const status = h('p', { class: `setup-status${e0.error ? ' err' : ''}`, role: 'status', text: e0.error || '' });
    const save = h('button', { class: 'btn primary slim-btn', type: 'submit' }, entry ? 'Save changes…' : 'Add hook…');
    const back = () => { ed = entry ? null : { step: 'pick' }; kit().rerender(); };

    return h('form', {
      class: 'setup-form hook-form',
      onsubmit: async ev => {
        ev.preventDefault();
        save.disabled = true;
        const hook = { event: d.event, matcher: eventOf(d.event)?.matcher ? d.matcher : '', command: d.command, timeout: d.timeout };
        const r = await kit().call(() => api.saveHook(d.where, hook, entry?.at || null, entry?.fp || null));
        save.disabled = false;
        if (r.ok) { ed = null; SB.toast(entry ? 'Hook saved. New sessions use it.' : 'Hook added. New sessions use it.'); kit().rerender(); return; }
        if (r.cancelled) return;
        e0.error = r.error || "Couldn't save that hook.";
        status.textContent = e0.error;
        status.classList.add('err');
      },
    },
    h('div', { class: 'setup-head' },
      h('button', { class: 'back-btn', type: 'button', onclick: back }, entry ? '← Hooks' : '← Ideas'),
      h('strong', { text: recipe ? recipe.title : entry ? 'Edit hook' : e0.claude?.title || 'Your own hook' })),
    recipe && !e0.claude ? h('div', { class: 'hook-recipe-note' },
      h('span', { class: 'hook-icon', 'aria-hidden': 'true', text: recipe.icon }),
      h('p', {}, recipe.blurb, recipe.tweak ? h('span', { class: 'hook-tweak', text: ` ${recipe.tweak}` }) : null)) : null,
    e0.claude?.note ? h('div', { class: 'hook-recipe-note hook-claude-note' },
      h('span', { class: 'hook-icon', 'aria-hidden': 'true', text: '✨' }),
      h('p', {}, h('strong', { text: 'From Claude: ' }), e0.claude.note,
        h('span', { class: 'hook-tweak', text: ' Read the command below before you save it.' }))) : null,
    askBox({
      key: 'form', label: 'Ask Claude to change it', button: 'Ask Claude', onAsk: text => revise(e0, text),
      placeholder: entry || recipe || e0.claude ? 'Only for Python files' : 'Describe what it should do, and Claude fills this in',
      hint: 'Claude changes the fields below. Nothing is saved until you press the button at the bottom.',
    }),
    h('label', { class: 'hook-field' },
      h('span', { class: 'hook-label', text: 'When should it run?' }),
      event,
      h('span', { class: 'field-hint', id: 'hookCanDo', text: canDo(e) })),
    matcherField(d, e, refreshSample),
    h('label', { class: 'hook-field' },
      h('span', { class: 'hook-label', text: 'What should it run?' }),
      command,
      h('span', { class: 'field-hint', text: 'One line, run in Git Bash from the project folder. For anything longer, save a script and run that.' })),
    whereField(d, entry),
    testField(e0, d),
    h('details', { class: 'hook-more' },
      h('summary', { text: 'More options' }),
      h('label', { class: 'hook-field' },
        h('span', { class: 'hook-label', text: 'Give up after (seconds)' }),
        timeout,
        h('span', { class: 'field-hint', text: 'Claude Code stops waiting for it after this long. 60 if you leave it blank.' }))),
    status,
    h('div', { class: 'row setup-actions' },
      h('span', { class: 'field-hint', text: "You'll see the command and confirm it before it's saved." }),
      h('button', { class: 'btn ghost slim-btn', type: 'button', onclick: () => { ed = null; kit().rerender(); } }, 'Cancel'),
      save));
  }

  // Rebuild the form in place (the moment changed, so its choices did), keeping focus where it was.
  function remount(focusName) {
    const pane = $('setupPane');
    pane.replaceChildren(hookForm(ed));
    pane.querySelector(`[name="${focusName}"]`)?.focus();
  }

  // ================================================================ entry points

  function render(q) {
    const pane = $('setupPane');
    if (ed) {
      $('toolList').hidden = true;
      const key = ed.step === 'pick' ? 'hook:pick' : `hook:${ed.entry?.id || ed.recipe?.id || 'new'}`;
      if (pane.dataset.mounted !== key) {
        // A different hook's form starts with an empty Ask box; mid-ask it's the same one coming back.
        if (ed.step === 'form' && !asking) askText.form = '';
        pane.replaceChildren(ed.step === 'pick' ? pickView() : hookForm(ed));
        pane.dataset.mounted = key;
        pane.scrollIntoView?.({ block: 'nearest' });
      }
      return;
    }
    renderList(q);
  }

  SB.toolboxHooks = { render };
})();
