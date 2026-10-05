/* Shellby panel — Routines: scheduled Claude Code tasks. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const form = $('routineEditor');
  let editing = null;      // routine being edited (null = new)
  let folder = null;       // chosen cwd for the editor (null = default)
  let chat = null;         // Build it with Claude (wf-chat.js), one per editor session
  let trial = false;       // a new routine Claude saved switched off to test it
  let tools = {};          // { mcp?, mcpOnly? }: MCP servers it may use without asking (mcp-picker.js)
  let mcpList = null;      // the servers it could pick, for its folder (null while reading)

  // Templates live in main (routine-templates.js), so the dependency checkup's
  // prompt and the one the Sticker Book uses can't drift apart.
  let templates = [];
  api.routineTemplates().then(list => { templates = Array.isArray(list) ? list : []; if (state.view === 'routines') render(); });

  const MODE_NAME = { ask: 'Ask first', smart: 'Smart', acceptEdits: 'Auto-edit', plan: 'Plan only', autonomous: 'Autonomous' };
  const ECO_NAME = { npm: 'npm', pnpm: 'pnpm', yarn: 'Yarn', bun: 'Bun', pip: 'Python', cargo: 'Rust', go: 'Go', ruby: 'Ruby', php: 'PHP', dotnet: '.NET', osv: 'OSV' };
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  const templateButton = t => h('button', { class: 'template', type: 'button', onclick: () => openEditor({ ...t, isTemplate: true }) },
    h('b', {}, t.icon ? `${t.icon} ` : '', t.name), h('span', { text: t.note || t.prompt }));

  // Waiting for the usage window to reset (src/main/held.js): click to run it on schedule instead.
  function heldPill(r) {
    return h('button', { class: 'r-pill held', type: 'button', title: 'Held for after your usage resets. Click to cancel.', 'aria-label': `Don't run ${r.name} after the reset`, onclick: async () => {
      await api.cancelHeld(r.held.id);
      SB.toast(`"${r.name}" won't run after the reset.`);
    } }, `after reset · ${r.held.atText}`);
  }

  // How the last run went, as a dot and a few words (the same line Workflows uses).
  function lastRunStatus(r) {
    const [tone, text] = r.running ? ['run', 'Running now']
      : r.lastStatus === 'ok' ? ['ok', `Ran ${SB.relTime(r.lastRunAt)}`]
        : r.lastStatus === 'error' ? ['err', `Failed ${SB.relTime(r.lastRunAt)}`]
          : r.lastStatus === 'stopped' ? ['none', `Stopped ${SB.relTime(r.lastRunAt)}`]
            : r.lastRunAt ? ['none', `Started ${SB.relTime(r.lastRunAt)}`]
              : ['none', 'Never run'];
    return h('span', { class: `ar-status ${tone}` }, h('span', { class: 'ar-dot', 'aria-hidden': 'true' }), text);
  }

  function render() {
    const list = $('routineList');
    const routines = state.routines || [];
    SB.renderResetQueue?.();
    renderDeps();
    renderFlaky();
    // The explainer is for before your first routine; after that the list says it.
    $('routinesView').querySelector('.view-lede').hidden = routines.length > 0;
    if (!routines.length) {
      list.replaceChildren(h('li', { class: 'routine-empty' },
        h('p', {}, 'No routines yet. Start from one of these:'),
        h('div', { class: 'templates' }, templates.map(templateButton))));
      return;
    }
    // The ones you haven't set up yet stay a click away.
    const have = new Set(routines.map(r => r.name.toLowerCase()));
    const more = templates.filter(t => !have.has(t.name.toLowerCase()));
    list.replaceChildren(...routines.map(r => h('li', { class: `ar-row routine${r.enabled ? '' : ' paused'}` }, h('div', { class: 'ar-top' },
      h('span', { class: 'ar-icon', 'aria-hidden': 'true' }, SB.icon(SB.ICONS.clock, { width: 1.4 })),
      h('div', { class: 'ar-main' },
        h('div', { class: 'ar-name' },
          h('button', { type: 'button', class: 'ar-title', 'aria-label': `Edit ${r.name}`, onclick: () => openEditor(r) }, r.name),
          r.held ? heldPill(r) : null),
        h('div', { class: 'ar-meta' },
          lastRunStatus(r),
          r.lastStatus === 'error' && !r.running ? fixButton(r) : null,
          h('span', { class: 'ar-when' },
            r.scheduleText,
            ' · ', r.enabled ? h('span', { title: r.next ? new Date(r.next).toLocaleString() : '' }, `next ${SB.untilTime(r.next)}`) : 'paused',
            // Smart is the default for routines: only say the mode when it's something else.
            r.mode === 'smart' ? null : ` · ${MODE_NAME[r.mode] || r.mode}`)),
        h('div', { class: 'ar-desc', text: r.prompt, title: r.prompt })),
      h('div', { class: 'ar-actions routine-actions' },
        h('button', { class: 'icon-btn', type: 'button', title: 'Run now', 'aria-label': `Run ${r.name} now`, disabled: r.running, onclick: async () => {
          const res = await api.runRoutine(r.id);
          SB.toast(res.ok ? `Started "${r.name}"` : res.error);
          if (res.ok) SB.setView('chat');
        } }, SB.icon(SB.ICONS.play, { width: 1.5 })),
        // Near or at the usage limit: one run once it resets, rather than now.
        state.outlook?.resetAt && !r.held ? h('button', { class: 'icon-btn', type: 'button', title: `Run after the reset (${state.outlook.resetText})`, 'aria-label': `Run ${r.name} after the usage reset`, onclick: async () => {
          const res = await api.holdForReset({ kind: 'routine', routineId: r.id });
          SB.toast(res.ok ? `"${r.name}" runs at ${res.atText}, once your usage resets.` : res.error);
        } }, SB.icon(SB.ICONS.clock, { width: 1.4 })) : null,
        h('button', { class: 'icon-btn danger-hover', type: 'button', title: 'Delete', 'aria-label': `Delete ${r.name}`, onclick: async () => {
          state.routines = await api.deleteRoutine(r.id);
          render();
          SB.toast(`Deleted "${r.name}"`);
        } }, SB.icon(SB.ICONS.trash)),
        h('label', { class: 'toggle mini', title: r.enabled ? 'Pause' : 'Resume' },
          h('input', { type: 'checkbox', checked: r.enabled, 'aria-label': `Run ${r.name} on its schedule`, onchange: async e => {
            const res = await api.saveRoutine({ ...r, enabled: e.target.checked });
            if (res.ok) state.routines = res.routines; else SB.toast(res.errors.join(' '));
            render();
          } }), h('span', { class: 'switch' })))))),
    ...(more.length ? [h('li', { class: 'routine-more' },
      h('details', { class: 'wf-disclosure' }, h('summary', { text: `More templates (${more.length})` }), h('div', { class: 'templates' }, more.map(templateButton))))] : []));
  }

  // ------------------------------------------------------------ dependency health

  // What each project's last audit and outdated check found (checkup.js).
  function depsLine(c) {
    const bits = [];
    if (c.audit?.status === 'clean') bits.push(h('span', { class: `dep-pill ${c.fresh ? 'ok' : ''}`, text: c.fresh ? '🧼 Fresh' : 'No known vulnerabilities' }));
    else if (c.audit?.status === 'issues') bits.push(h('span', { class: 'dep-pill err', text: c.audit.count ? plural(c.audit.count, 'vulnerability', 'vulnerabilities') : 'Vulnerable' }));
    if (c.outdated?.status === 'issues') bits.push(h('span', { class: 'dep-pill warn', text: c.outdated.count ? `${c.outdated.count} outdated` : 'Outdated' }));
    else if (c.outdated?.status === 'clean') bits.push(h('span', { class: 'dep-pill ok', text: 'Up to date' }));
    if (!bits.length) bits.push(h('span', { class: 'dep-pill', text: "Couldn't read the result" }));
    return bits;
  }

  function renderDeps() {
    const list = state.checkups || [];
    $('depsHealth').hidden = !list.length;
    if (!list.length) return;
    const fresh = list.filter(c => c.fresh).length;
    $('depsSummary').textContent = `${fresh} of ${plural(list.length, 'project')} fresh`;
    $('depsList').replaceChildren(...list.map(c => {
      const at = Math.max(c.audit?.at || 0, c.outdated?.at || 0);
      return h('li', { class: 'dep' },
        h('div', { class: 'dep-main' },
          h('div', { class: 'dep-name' }, h('span', { text: c.name }), c.ecosystem ? h('small', { text: ECO_NAME[c.ecosystem] || c.ecosystem }) : null),
          h('div', { class: 'dep-pills' }, ...depsLine(c), h('time', { title: new Date(at).toLocaleString(), text: `checked ${SB.relTime(at)}` }))),
        h('button', { class: 'btn ghost slim-btn', type: 'button', title: `Check ${c.name}'s dependencies again`, onclick: async () => {
          const res = await api.runCheckup(c.key);
          if (!res.ok) SB.toast(res.error);
          else { SB.setView('chat'); SB.toast('Press Enter to run the checkup'); }
        } }, 'Check again'));
    }));
  }

  SB.applyCheckups = list => { state.checkups = Array.isArray(list) ? list : []; if (state.view === 'routines') renderDeps(); };
  api.getCheckups().then(SB.applyCheckups);
  api.onCheckups(SB.applyCheckups);

  // ------------------------------------------------------------ flaky tests

  // Tests that failed and then passed on the same code (flaky.js).
  const RUNNER_NAME = { node: 'node --test', jest: 'Jest', vitest: 'Vitest', mocha: 'Mocha', pytest: 'pytest', go: 'Go', cargo: 'Rust', playwright: 'Playwright', rspec: 'RSpec', dotnet: '.NET', phpunit: 'PHPUnit' };

  function flakyPills(f) {
    const bits = [];
    if (f.status === 'fixed') bits.push(h('span', { class: 'dep-pill ok', text: 'Fixed for good' }));
    else bits.push(h('span', { class: `dep-pill ${f.week >= 2 ? 'err' : 'warn'}`, text: f.week ? `flaked ${f.week === 1 ? 'once' : `${f.week} times`} this week` : `flaked ${plural(f.total, 'time')}` }));
    if (f.status === 'fixing') bits.push(h('span', { class: 'dep-pill', text: `Fixing: ${Math.min(f.clean.runs, f.clean.of)} of ${f.clean.of} clean runs` }));
    if (f.status === 'quarantined') bits.push(h('span', { class: 'dep-pill', text: 'Quarantined' }));
    if (f.issue) bits.push(h('a', { class: 'dep-pill', href: '#', 'data-href': f.issue.url, title: 'Open the issue on GitHub', text: `Issue #${f.issue.number}` }));
    return bits;
  }

  function flakyButton(f, action, label, title, primary = false) {
    return h('button', { class: `btn ${primary ? '' : 'ghost '}slim-btn`, type: 'button', title, onclick: async e => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const res = await api.flakyAct({ key: f.key, id: f.id, action });
      btn.disabled = false;
      if (res?.canceled) return;
      if (!res?.ok) SB.toast(res?.error || "That didn't work.");
      else if (action === 'dismiss') SB.toast(`Shellby will leave ${f.label} be`);
      else if (action === 'issue') SB.toast(`${res.existing ? 'Already filed' : 'Filed'} as issue #${res.number}`);
    } }, label);
  }

  function flakyButtons(f) {
    if (f.status === 'watching') {
      return [
        flakyButton(f, 'fix', 'Fix it', 'Claude finds the cause and fixes it, in a copy of the repository', true),
        flakyButton(f, 'quarantine', 'Quarantine', 'Claude skips just this test, with a note, in a copy of the repository'),
        f.issuable && !f.issue && flakyButton(f, 'issue', 'File an issue', 'A GitHub issue with what Shellby saw, labelled shellby so the Issue helper can offer to fix it. Asks first'),
        flakyButton(f, 'dismiss', 'Not flaky', "Hide it unless it keeps doing this (say, it was a server that wasn't up)"),
      ];
    }
    if (f.status === 'quarantined' && f.retry) return [flakyButton(f, 'unquarantine', 'Try it again', 'Claude un-skips it and runs it 20 times, in a copy of the repository', true)];
    return [];
  }

  function renderFlaky() {
    const list = state.flaky?.list || [];
    const on = state.flaky?.on !== false;
    $('flakyTests').hidden = !list.length;
    if (!list.length) return;
    const now = list.filter(f => f.week && f.status !== 'fixed').length;
    $('flakySummary').textContent = on ? (now ? `${plural(now, 'test')} flaky this week` : 'Nothing flaky this week') : 'Spotting is off in Settings';
    $('flakyList').replaceChildren(...list.map(f => h('li', { class: `dep flaky ${f.status}` },
      h('div', { class: 'dep-main' },
        h('div', { class: 'dep-name' },
          h('span', { text: f.label, title: f.suite ? 'A run failed without naming a test' : f.id }),
          h('small', { text: [f.project, RUNNER_NAME[f.framework]].filter(Boolean).join(' · ') })),
        h('div', { class: 'dep-pills' }, ...flakyPills(f), h('time', { title: new Date(f.lastAt).toLocaleString(), text: `last ${SB.relTime(f.lastAt)}` }))),
      h('div', { class: 'flaky-actions' }, ...flakyButtons(f)))));
  }

  SB.applyFlaky = v => { state.flaky = v && typeof v === 'object' ? { on: v.on !== false, list: Array.isArray(v.list) ? v.list : [] } : { on: true, list: [] }; if (state.view === 'routines') renderFlaky(); };
  SB.refreshFlaky = () => api.getFlaky().then(SB.applyFlaky);
  SB.refreshFlaky();
  // Main pushes the list alone; whether spotting is on comes from settings.
  api.onFlaky(list => SB.applyFlaky({ on: state.settings?.flakyTests !== false, list }));
  api.onFlakyFocus(() => {
    SB.refreshFlaky().then(() => {
      const sec = $('flakyTests');
      if (sec.hidden) return;
      sec.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      $('flakyTitle').setAttribute('tabindex', '-1');
      $('flakyTitle').focus({ preventScroll: true });
    });
  });
  $('flakyForget').addEventListener('click', () => api.forgetFlaky()); // main asks first

  // ------------------------------------------------------------ editor

  function syncWhen() {
    const type = form.elements.type.value;
    form.querySelectorAll('[data-when]').forEach(el => { el.hidden = !el.dataset.when.split(' ').includes(type); });
  }
  form.elements.type.addEventListener('change', syncWhen);

  // `greeting`: what Claude said about a draft, to open the chat with.
  function openEditor(r = null, { greeting = '' } = {}) {
    if (chat) closeEditor(); // one editor, one chat: whatever was open goes the usual way
    editing = r && !r.isTemplate ? r : null;
    $('routineEditorTitle').textContent = editing ? `Edit “${r.name}”` : 'New routine';
    $('routineTplNote').hidden = !(r?.isTemplate && r.note);
    $('routineTplNote').textContent = r?.isTemplate && r.note ? r.note : '';
    fillForm(r);
    form.querySelector('option[value=autonomous]').disabled = !state.settings.autonomousAcknowledged;
    $('routineErrors').hidden = true;
    const host = chatHost();
    chat = SB.wfChat.create(host, { greeting });
    host.bind(chat);
    $('routineWork').append(chat.el);
    $('routineWork').hidden = false;
    $('routineWork').scrollIntoView({ behavior: 'smooth', block: 'start' });
    form.elements.name.focus();
  }

  function fillForm(r) {
    folder = r?.cwd || null;
    const s = r?.schedule || { type: 'daily', time: '09:00' };
    form.elements.name.value = r?.name || '';
    form.elements.prompt.value = r?.prompt || '';
    form.elements.type.value = s.type;
    form.elements.time.value = s.time || '09:00';
    form.elements.everyHours.value = s.everyHours || 4;
    const days = new Set((s.days || [1]).map(String));
    form.querySelectorAll('input[name=day]').forEach(c => { c.checked = days.has(c.value); });
    form.elements.mode.value = r?.mode || 'smart';
    form.elements.catchUp.checked = r ? r.catchUp !== false : true;
    $('routineFolder').textContent = folder ? SB.tildify(folder) : `Default (${SB.tildify(state.cwd)})`;
    tools = { ...(r?.mcp?.length ? { mcp: [...r.mcp] } : {}), ...(r?.mcp?.length && r.mcpOnly ? { mcpOnly: true } : {}) };
    syncWhen();
    loadMcp();
  }

  // Its folder decides which project servers count, so they're read again when it changes.
  let mcpSeq = 0;
  function loadMcp() {
    const seq = ++mcpSeq;
    mcpList = null;
    drawMcp();
    api.mcpServers(folder || null)
      .then(l => { if (seq === mcpSeq) mcpList = Array.isArray(l) ? l : []; })
      .catch(() => { if (seq === mcpSeq) mcpList = []; })
      .finally(() => { if (seq === mcpSeq) drawMcp(); });
  }

  function drawMcp() {
    const host = $('routineMcp');
    const at = [...host.querySelectorAll('input')].indexOf(document.activeElement);
    host.replaceChildren(SB.mcpPicker.field({ at: 'mcp', value: tools, servers: mcpList, onChange: () => {}, rebuild: drawMcp }));
    if (at >= 0) host.querySelectorAll('input')[at]?.focus();
  }

  // The routine as it is in the editor, ready for routines:save. How it last ran
  // isn't sent: main keeps what it has, which a test run may have just changed.
  function readForm() {
    const type = form.elements.type.value;
    const schedule = type === 'interval'
      ? { type, everyHours: Number(form.elements.everyHours.value) }
      : type === 'weekly'
        ? { type, time: form.elements.time.value, days: [...form.querySelectorAll('input[name=day]:checked')].map(c => Number(c.value)) }
        : { type, time: form.elements.time.value };
    return {
      ...(editing ? { id: editing.id, createdAt: editing.createdAt, enabled: editing.enabled } : {}),
      name: form.elements.name.value, prompt: form.elements.prompt.value, cwd: folder,
      mode: form.elements.mode.value, schedule, catchUp: form.elements.catchUp.checked,
      // Always sent, so unticking every server clears them (main merges with what it has).
      mcp: [...(tools.mcp || [])], mcpOnly: !!tools.mcp?.length && !!tools.mcpOnly,
    };
  }

  function closeEditor() {
    // A new routine Claude tested was saved switched off; it stays in the list that way.
    if (trial && editing) SB.toast(`"${editing.name}" is saved, switched off. Switch it on in the list when you're ready.`);
    $('routineWork').hidden = true;
    chat?.el.remove();
    chat = null;
    editing = null;
    trial = false;
  }

  function showErrors(errors) {
    $('routineErrors').hidden = !errors.length;
    $('routineErrors').textContent = errors.join(' ');
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    // Saving is when a routine Claude tested (saved switched off) is switched on.
    const input = { ...readForm(), ...(trial ? { enabled: true } : {}) };
    const res = await api.saveRoutine(input);
    if (!res.ok) { showErrors(res.errors); return; }
    state.routines = res.routines;
    trial = false;
    closeEditor();
    render();
    const saved = state.routines.find(r => r.id === res.routine.id);
    SB.toast(`Saved. Next run ${SB.untilTime(saved?.next)}`);
  });

  // ------------------------------------------------------------ Build it with Claude (wf-chat.js)

  // The routine editor's side of the chat. A test saves the routine (a new one
  // switched off, so it can't run on its schedule before you press Save) and
  // runs it once in its own tab; when that tab's turn ends, Claude reads it.
  function chatHost() {
    let mine = null;
    const alive = () => !!mine && chat === mine && !$('routineWork').hidden;
    const snapshot = () => JSON.stringify(readForm());
    return {
      alive,
      noun: 'routine',
      getDef: () => readForm(),
      ask: async ({ def, messages, runId }) => {
        const res = await api.chatRoutine({ routine: def, messages, runId });
        return res?.ok && res.routine ? { ...res, def: res.routine } : res;
      },
      apply: (def, { since } = {}) => {
        if (!alive()) return false;
        if (since && snapshot() !== since) return 'conflict';
        const before = readForm();
        fillForm({ ...before, ...def });
        flashChanged(before, readForm());
        showErrors([]);
        return true;
      },
      testSave: async () => {
        if (!alive()) return { ok: false, error: 'The editor was closed.' };
        const input = readForm();
        const sent = { ...input, enabled: editing && !trial ? input.enabled : false };
        let res;
        try { res = await api.saveRoutine(sent); } catch { res = { ok: false, errors: ['Couldn\'t save it.'] }; }
        if (!res?.ok) {
          if (!res?.cancelled && alive()) showErrors(res?.errors || []);
          return { ok: false, declined: !!res?.cancelled, error: (res?.errors || []).join(' ') || 'Not saved.' };
        }
        state.routines = res.routines;
        render();
        if (alive()) {
          if (!editing) trial = true;
          editing = res.routine;
          $('routineEditorTitle').textContent = `Edit “${res.routine.name}”`;
        }
        return { ok: true, id: res.routine.id };
      },
      startRun: id => api.testRoutine(id),
      stopRun: runId => api.stopRoutineTest(runId),
      getRun: runId => api.routineTestStatus(runId),
      openRun: runId => {
        if (state.tabs.has(runId)) SB.activate(runId);
        else SB.toast('That run\'s tab is closed. Find it in History.');
      },
      // What you said in the chat goes to the workflow builder, with the routine's instruction for context.
      extras: (res, turns) => {
        if (!res.workflow) return [];
        const said = turns.filter(t => t.role === 'user').map(t => t.text).join('\n');
        return [workflowOffer(res.workflow.why, `${said}\n\n(Started as a routine: ${readForm().prompt})`.trim().slice(0, 2000))];
      },
      // The host is made before its chat, which is bound to it straight after.
      bind: c => { mine = c; },
    };
  }

  // What Claude's change touched glows for a moment, the way the workflow editor's steps do.
  const FIELD_OF = { name: 'name', prompt: 'prompt', mode: 'mode', catchUp: 'catchUp' };
  function flashChanged(before, after) {
    const targets = Object.entries(FIELD_OF).filter(([k]) => before[k] !== after[k]).map(([, f]) => form.elements[f]);
    if (JSON.stringify(before.schedule) !== JSON.stringify(after.schedule)) targets.push(form.elements.type);
    if (before.cwd !== after.cwd) targets.push($('routineFolder'));
    for (const el of targets) {
      const target = el?.closest('.field-label, .toggle') || el;
      if (!target) continue;
      target.classList.remove('wf-touched');
      void target.offsetWidth; // restart the animation
      target.classList.add('wf-touched');
      setTimeout(() => target.classList.remove('wf-touched'), 1700);
    }
  }

  api.onRoutineTestRun(summary => chat?.onRun(summary));

  // ------------------------------------------------------------ fix with Claude

  // A failed routine: Claude reads its last run and opens a corrected one in
  // the editor, with what it changed in the chat. Saving it is up to you.
  let fixing = null; // the routine Claude is looking at
  async function fixRoutine(r) {
    if (fixing) { SB.toast('Claude is already looking at one. Give it a moment.'); return; }
    if (!$('routineWork').hidden) { SB.toast('Close the routine editor first, then try again.'); return; }
    fixing = r.id;
    render();
    let res;
    try { res = await api.repairRoutine(r.id); } catch { res = { ok: false, error: 'Couldn\'t reach Claude. Try again.' }; }
    fixing = null;
    if (state.view === 'routines') render();
    if (!res?.ok) { SB.toast(res?.error || 'Claude couldn\'t fix that.'); return; }
    if (!$('routineWork').hidden) { SB.toast('Claude has a fix, but the editor is open. Close it and try again.'); return; }
    const now = (state.routines || []).find(x => x.id === r.id);
    if (!now) { SB.toast('That routine was deleted.'); return; }
    if (state.view !== 'routines') SB.setView('routines');
    openEditor({ ...now, ...res.routine }, { greeting: res.note });
    SB.toast('Check Claude\'s fix, then press Save.');
  }

  function fixButton(r) {
    const busy = fixing === r.id;
    return h('button', {
      type: 'button', class: 'btn primary slim-btn r-fix', disabled: busy,
      title: 'Claude reads the failed run and opens a corrected routine for you to check',
      onclick: () => fixRoutine(r),
    }, busy ? 'Claude is looking…' : 'Fix with Claude');
  }

  // ------------------------------------------------------------ a workflow's job

  // Claude thinks it should be a workflow (it starts on an event, or needs steps
  // with decisions between them): one click drafts it as one. The routine editor
  // only closes once the workflow draft is open, so a failed one loses nothing.
  async function asWorkflow(text) {
    if (!text.trim() || !SB.views.workflows?.draftFrom) return;
    if (await SB.views.workflows.draftFrom(text) && chat) closeEditor();
  }

  function workflowOffer(why, text) {
    return h('div', { class: 'rt-workflow-offer' },
      h('p', { class: 'wf-chat-tag', text: why }),
      h('button', { type: 'button', class: 'btn slim-btn', onclick: () => asWorkflow(text) }, 'Build it as a workflow'));
  }
  // ------------------------------------------------------------ describe it

  // Claude only fills in the editor; the routine is saved by the Save button,
  // so what you see there is exactly what runs.
  const ask = $('routineAsk');
  const ASK_NOTE = $('routineAskNote').textContent;
  let asked = ''; // what you described, for "Build it as a workflow instead"
  function askNote(text, err = false, offer = false) {
    $('routineAskNote').textContent = text;
    $('routineAskNote').classList.toggle('err', err);
    $('routineAsWorkflow').hidden = !offer;
  }
  $('routineAsWorkflow').addEventListener('click', () => { askNote(ASK_NOTE); asWorkflow(asked); });
  ask.addEventListener('submit', async e => {
    e.preventDefault();
    if (ask.classList.contains('busy')) return;
    const text = $('routineAskText').value.trim();
    if (!text) { askNote('Say what you want done and when.', true); $('routineAskText').focus(); return; }
    ask.classList.add('busy');
    $('routineAskBtn').disabled = true;
    askNote('Claude is drafting it…');
    try {
      const res = await api.draftRoutine(text);
      if (!res.ok) { askNote(res.error, true); return; }
      $('routineAskText').value = '';
      asked = text;
      openEditor({ ...res.draft, isTemplate: true }, { greeting: `I filled this in from “${text}”. Tell me what to change, or ask me to test it.` });
      if (res.workflow) askNote(`${res.workflow.why} The closest routine is below, or:`, false, true);
      else askNote(ASK_NOTE);
      SB.toast('Drafted. Check it over, then press Save.');
    } catch {
      askNote('Couldn\'t reach Claude. Try again.', true);
    } finally {
      ask.classList.remove('busy');
      $('routineAskBtn').disabled = false;
    }
  });

  $('routineCancel').addEventListener('click', closeEditor);
  $('newRoutineBtn').addEventListener('click', () => openEditor());
  $('routineFolderBtn').addEventListener('click', async () => {
    const dir = await api.pickAnyFolder();
    if (dir) { folder = dir; $('routineFolder').textContent = SB.tildify(dir); loadMcp(); }
  });

  // openEditor: Dependency watch (depwatch.js) offers its routine through the same editor.
  SB.views.routines = { render, openEditor };
})();
