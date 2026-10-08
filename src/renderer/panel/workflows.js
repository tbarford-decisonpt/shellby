/* Shellby panel — Workflows: the editor screen (its sections, the map, the
   inspector), live updates, and the wiring to the rest of the panel. Loaded
   last of the workflow files; wf-kit.js says how they fit together. */
'use strict';
(function () {
  const { h, api, state } = SB;
  const W = SB.wfKit;
  const {
    G, fill, screen,
    slots, cards, ed, setMapMode, mapOn, backBtn, layoutSwitch, pref, PREF, rebuild, toggleJson, jsonPane,
    paintErrors, up, save, txt, area, folderField, uid, changed, slot, rowsEditor, MAX, popup, TRIGGER_INFO,
    menuItem, icon, ONCE_TRIGGERS, TRIGGER_DEFAULTS, keyOf, trigSel, trigFk, iconBtn, sel, workflowPicker, num,
    wrap, STEP_INFO, countSteps, STEP_GROUPS, menuLabel, CONTAINERS, newStep, openSteps, stepSel, putOrDrop,
    STEP_FIELDS, advanced, copyStep, walk, stepFk, MODE_NAME, firstLine, TELL_TO, humanSeconds, FILE_ACTIONS,
    plural, roomBtn, workflows, current, refreshList, refreshRuns, refreshRun, applyView, leaveEditorIfNeeded,
    openEditor, blankWorkflow, nav, home, focusDescribeSoon, resetNav, show, render, draftFrom,
  } = W;

  // ================================================================ the editor: screen

  function renderEditor() {
    slots.clear();
    cards.length = 0;
    ed.map = null;
    const d = ed.def;
    setMapMode(mapOn());
    fill(screen,
      h('div', { class: 'view-head' },
        backBtn(),
        h('h2', { class: 'wf-title', text: ed.title }),
        ed.json ? null : layoutSwitch(ed.layout, v => { ed.layout = v; pref.set(PREF.layout, v); rebuild(`lay-${v}`); }, 'Show the workflow as'),
        h('button', {
          type: 'button', class: 'btn ghost slim-btn wf-json-toggle', 'aria-pressed': String(ed.json),
          title: 'See and edit the whole workflow as text', onclick: toggleJson,
        }, 'JSON')),
      h('div', { class: 'wf-summary', id: 'wfSummary', role: 'status', 'aria-live': 'polite', hidden: true }),
      // The chat sits beside the workflow when there's room, under it when not. It's the same
      // element every time, so a rebuild keeps the conversation and whatever you're typing.
      h('div', { class: 'wf-work' },
        ed.json ? jsonPane()
          : mapOn() ? mapPane(d)
            : h('div', { class: 'wf-editor' }, basicsSection(d), inputsSection(d), whenSection(d), stepsSection(d)),
        ed.chat?.el),
      editorFoot());
    paintErrors();
  }

  function editorFoot() {
    return h('div', { class: 'wf-foot' },
      h('p', { class: 'field-hint', text: ed.isNew ? 'Nothing is saved until you press Save.' : 'Saving replaces the workflow as it is now.' }),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn ghost', onclick: up }, 'Cancel'),
        h('button', { type: 'button', class: 'btn primary', id: 'wfSave', disabled: ed.saving, onclick: save }, ed.saving ? 'Saving…' : 'Save')));
  }

  const nameField = (d, cls) => txt('Name', d.name, v => { d.name = v; }, { at: 'name', cls, attrs: { maxlength: 60, placeholder: 'Red build fixer', 'data-fk': 'wf-name' } });

  // Description, folder and concurrency: in the list's first section, or the map's Settings.
  const aboutFields = d => [
    area('Description', d.description, v => { d.description = v; }, { at: 'description', attrs: { rows: 2, maxlength: 500, placeholder: 'Optional: what it\'s for' } }),
    folderField('Default folder', d.cwd, v => { d.cwd = v; }, { at: 'cwd', placeholder: 'Shellby\'s current folder', hint: 'Where Claude and commands work, unless a step says otherwise.' }),
    concurrencyField(d),
  ];

  function basicsSection(d) {
    return h('section', { class: 'wf-section', 'aria-label': 'About it' }, nameField(d), aboutFields(d));
  }

  function concurrencyField(d) {
    const name = uid('conc');
    const radio = (value, label) => h('label', { class: 'wf-radio' },
      h('input', { type: 'radio', name, value, checked: (d.concurrency || 'skip') === value, onchange: () => { d.concurrency = value; changed(); } }),
      h('span', { text: label }));
    return h('fieldset', { class: 'wf-fieldset' },
      h('legend', { class: 'field-label', text: 'If it\'s already running when triggered' }),
      h('div', { class: 'seg wf-seg' }, radio('skip', 'Skip'), radio('queue', 'Queue')),
      slot('concurrency', null));
  }

  function sectionHead(title, lede, at) {
    return [h('h3', { class: 'wf-h3', text: title }), lede ? h('p', { class: 'field-hint wf-lede', text: lede }) : null, at ? slot(at, null) : null];
  }

  function inputsSection(d) {
    return h('section', { class: 'wf-section' },
      sectionHead('Inputs', 'Asked for when it\'s run by hand, by Claude Code or by another workflow. Use them as {{ inputs.name }}.', null),
      rowsEditor({
        legend: 'Inputs', rows: d.inputs, at: 'inputs', addText: 'Add an input', max: MAX.inputs,
        blank: () => ({ name: '', label: '', default: '', required: false }),
        columns: [
          { key: 'name', label: 'Name', placeholder: 'branch', mono: true },
          { key: 'label', label: 'Label', placeholder: 'Branch' },
          { key: 'default', label: 'Default', placeholder: 'main' },
          { key: 'required', label: 'Required', kind: 'check', width: 'auto' },
        ],
        onChange: rows => { d.inputs = rows; },
      }));
  }

  // ------------------------------------------------------------ When

  function whenSection(d) {
    const addBtn = h('button', {
      type: 'button', class: 'btn slim-btn wf-add', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-fk': 'add-trigger', disabled: d.when.length >= MAX.triggers,
      onclick: () => popup(addBtn, () => triggerMenu(d)),
    }, '+ Add a trigger');
    return h('section', { class: 'wf-section' },
      sectionHead('When', 'What starts it. Every workflow can also be run by hand.', 'when'),
      h('ul', { class: 'wf-cards', 'aria-label': 'Triggers' }, d.when.map((t, i) => triggerCard(t, i))),
      d.when.length ? null : h('p', { class: 'wf-empty small', text: 'No triggers: it runs only when you start it.' }),
      addBtn);
  }

  const triggerMenu = d => Object.entries(TRIGGER_INFO).map(([type, info]) => menuItem(info.name, info.sub, () => addTrigger(type), {
    glyph: icon('trigger'), disabled: ONCE_TRIGGERS.includes(type) && d.when.some(t => t.type === type),
  }));

  function addTrigger(type) {
    const t = { type, ...(TRIGGER_DEFAULTS[type]?.() || {}) };
    ed.def.when.push(t);
    changed();
    if (!mapOn()) { rebuild(`tr-${keyOf(t)}`); return; }
    ed.sel = trigSel(t);
    rebuild();
    focusInspector();
  }

  function removeTrigger(i) {
    const t = ed.def.when[i];
    if (!t) return;
    const info = TRIGGER_INFO[t.type] || { name: t.type };
    if (ed.sel === trigSel(t)) ed.sel = null;
    ed.def.when.splice(i, 1);
    changed();
    rebuild(ed.def.when.length ? trigFk(ed.def.when[Math.min(i, ed.def.when.length - 1)]) : 'add-trigger');
    SB.toast(`Removed “${info.name}”`, { action: 'Undo', onAction: () => { ed.def.when.splice(i, 0, t); changed(); rebuild(trigFk(t)); } });
  }

  function triggerCard(t, i) {
    const at = `when[${i}]`;
    const info = TRIGGER_INFO[t.type] || { name: t.type };
    const k = keyOf(t);
    const li = h('li', { class: 'wf-card wf-trigger' },
      h('div', { class: 'wf-card-head' },
        h('span', { class: 'wf-step-icon', 'aria-hidden': 'true' }, icon('trigger')),
        h('h4', { class: 'wf-card-title', tabindex: '-1', 'data-fk': `tr-${k}`, text: info.name }),
        iconBtn('close', `Remove the trigger “${info.name}”`, () => removeTrigger(i))),
      h('div', { class: 'wf-card-body' }, triggerFields(t, at)),
      slot(at, null));
    cards.push({ at, el: li });
    return li;
  }

  function triggerFields(t, at) {
    switch (t.type) {
      case 'schedule': return scheduleFields(t, at);
      case 'ci': return [
        sel('When a build', [['failed', 'fails'], ['fixed', 'goes green again'], ['passed', 'passes'], ['merged', 'is merged'], ['review', 'needs your review'], ['any', 'changes at all']], t.on || 'failed', v => { t.on = v; }, { at: `${at}.on` }),
        txt('Repository (optional)', t.repo, v => { t.repo = v; }, { at: `${at}.repo`, attrs: { placeholder: 'owner/name' }, hint: 'Leave empty for every repository Shellby watches.' }),
      ];
      case 'issue': return [
        sel('When an issue is', [['any', 'assigned to me or labelled shellby'], ['assigned', 'assigned to me'], ['labelled', 'labelled shellby']], t.on || 'any', v => { t.on = v; }, { at: `${at}.on`, hint: 'The label counts in your own repositories and the ones cloned on this PC. Needs “Offer to take on issues” in Settings → GitHub.' }),
        txt('Repository (optional)', t.repo, v => { t.repo = v; }, { at: `${at}.repo`, attrs: { placeholder: 'owner/name' }, hint: 'Leave empty for every repository.' }),
      ];
      case 'shipped': return [
        sel('What ships', [['any', 'Anything'], ['push', 'A push'], ['deploy', 'A deploy'], ['release', 'A release'], ['merge', 'A merged pull request']], t.kind || 'any', v => { t.kind = v; }, { at: `${at}.kind` }),
        txt('Project (optional)', t.project, v => { t.project = v; }, { at: `${at}.project`, attrs: { placeholder: 'Any project' } }),
      ];
      case 'task': return [sel('When a task', [['any', 'finishes'], ['ok', 'succeeds'], ['error', 'fails']], t.outcome || 'any', v => { t.outcome = v; }, { at: `${at}.outcome`, hint: 'Your own conversations, not a workflow\'s.' })];
      case 'folder': return [
        folderField('Folder to watch', t.path, v => { t.path = v; }, { at: `${at}.path`, placeholder: 'C:\\Users\\you\\Downloads' }),
        h('div', { class: 'grid-2' },
          txt('Files (optional)', t.pattern, v => { t.pattern = v; }, { at: `${at}.pattern`, attrs: { placeholder: '*.pdf' } }),
          sel('When files are', [['added', 'added'], ['changed', 'changed'], ['any', 'added or changed']], t.events || 'added', v => { t.events = v; }, { at: `${at}.events` })),
      ];
      case 'workflow': return [
        h('div', { class: 'grid-2' },
          workflowPicker('Workflow', t.name, v => { t.name = v; }, { at: `${at}.name` }),
          sel('When it', [['any', 'finishes'], ['ok', 'succeeds'], ['error', 'fails']], t.status || 'any', v => { t.status = v; }, { at: `${at}.status` })),
      ];
      case 'webhook': return webhookFields(t);
      case 'claude': return [h('p', { class: 'field-hint', text: 'Claude Code (over MCP) or the shellby command can start it, passing its inputs. Only workflows with this trigger can be started that way.' })];
      case 'startup': return [h('p', { class: 'field-hint', text: 'Runs each time Shellby starts.' })];
      case 'health': return [h('p', { class: 'field-hint', text: 'Runs when Health spots something overheating or a drive filling up.' })];
      default: return [];
    }
  }

  function scheduleFields(t, at) {
    const s = t.schedule || (t.schedule = { type: 'daily', time: '09:00' });
    const k = keyOf(t);
    const kinds = [['daily', 'Every day'], ['weekly', 'On certain days'], ['interval', 'Every few hours'], ['minutes', 'Every few minutes']];
    const out = [h('div', { class: 'grid-2' },
      sel('Repeat', kinds, s.type, v => { t.schedule = defaultSchedule(v, s); rebuild(`sk-${k}`); }, { attrs: { 'data-fk': `sk-${k}` } }),
      s.type === 'daily' || s.type === 'weekly' ? timeField(s) : null,
      s.type === 'interval' ? num('Every (hours)', s.everyHours, v => { s.everyHours = v; }, { attrs: { min: 1, max: 168 } }) : null,
      s.type === 'minutes' ? num('Every (minutes)', s.every, v => { s.every = v; }, { attrs: { min: 5, max: 1440 } }) : null)];
    if (s.type === 'weekly') out.push(daysField(s));
    out.push(slot(`${at}.schedule`, null));
    return out;
  }

  function defaultSchedule(type, prev) {
    const time = prev.time || '09:00';
    if (type === 'weekly') return { type, time, days: prev.days?.length ? prev.days : [1] };
    if (type === 'interval') return { type, everyHours: 4 };
    if (type === 'minutes') return { type, every: 15 };
    return { type: 'daily', time };
  }

  function timeField(s) {
    const el = h('input', { class: 'field', type: 'time' });
    el.value = s.time || '09:00';
    el.addEventListener('input', () => { s.time = el.value; changed(); });
    return wrap('At', el);
  }

  function daysField(s) {
    const days = new Set(s.days || [1]);
    const box = (n, label) => h('label', {},
      h('input', { type: 'checkbox', checked: days.has(n), onchange: e => { if (e.target.checked) days.add(n); else days.delete(n); s.days = [...days].sort((a, b) => a - b); changed(); } }),
      h('span', { text: label }));
    return h('fieldset', { class: 'wf-fieldset' }, h('legend', { class: 'field-label', text: 'Days' }),
      h('div', { class: 'days' }, [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']].map(([n, l]) => box(n, l))));
  }

  function webhookFields(t) {
    const port = state.workflows?.webhookPort;
    const url = `http://127.0.0.1:${port || '<port>'}/v1/flow`;
    const token = t.token || '<token>';
    const example = `Invoke-RestMethod -Method Post -Uri ${url} -Headers @{ 'X-Shellby' = '1' } -ContentType 'application/json' -Body '{"hook":"${token}","data":{}}'`;
    return [
      h('div', { class: 'wf-field' }, h('div', { class: 'field-label', text: 'Address' }), h('code', { class: 'path wf-code-line', text: url })),
      h('div', { class: 'wf-field' },
        h('div', { class: 'field-label', text: 'Call it from PowerShell' }),
        h('pre', { class: 'wf-pre', tabindex: '0', 'aria-label': 'PowerShell example', text: example }),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn slim-btn', onclick: () => { api.copyText(example); SB.toast('Copied'); } }, 'Copy'),
          h('span', { class: 'field-hint', text: t.token ? 'Whatever you put in "data" arrives as trigger.*' : 'The token appears here after the first save.' }))),
      port ? null : h('p', { class: 'field-hint', text: 'Shellby\'s local port isn\'t running right now, so the address is a placeholder.' }),
    ];
  }

  // ------------------------------------------------------------ Steps

  function stepsSection(d) {
    return h('section', { class: 'wf-section' },
      sectionHead('Steps', 'They run from the top. Open one to change it.', 'steps'),
      stepList(d.steps, 'steps', 1, [], 'Add a step', 'Steps'));
  }

  function stepList(steps, at, depth, chain, addText, label) {
    const items = [];
    steps.forEach((s, i) => {
      if (i > 0) items.push(h('li', { class: 'wf-gap' }, addButton(steps, i, depth, `Add a step before “${s.label || STEP_INFO[s.type]?.name}”`, true)));
      items.push(stepCard(steps, i, `${at}[${i}]`, depth, [...chain, { list: steps, index: i }]));
    });
    items.push(h('li', { class: 'wf-end' }, addButton(steps, steps.length, depth, addText, false)));
    return h('ol', { class: `wf-steps depth-${depth}`, 'aria-label': label }, items);
  }

  function addButton(steps, index, depth, label, small) {
    const fk = `add-${keyOf(steps)}-${index}`;
    const btn = h('button', {
      type: 'button', class: small ? 'wf-gap-btn' : 'btn ghost slim-btn wf-add', 'aria-label': label, title: small ? label : null,
      'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-fk': fk,
      onclick: () => popup(btn, () => typeMenu(type => insertStep(steps, index, type), depth)),
    }, small ? icon('plus', 1.6) : `+ ${label}`);
    return btn;
  }

  function typeMenu(pick, depth) {
    const full = countSteps() >= MAX.steps;
    return STEP_GROUPS.flatMap(([group, types]) => [menuLabel(group), ...types.map(type => menuItem(STEP_INFO[type].name, STEP_INFO[type].sub, () => pick(type), {
      glyph: icon(type), disabled: full || (CONTAINERS[type] && depth >= MAX.depth),
    }))]);
  }

  function insertStep(steps, index, type) {
    const s = newStep(type);
    steps.splice(index, 0, s);
    openSteps.add(s);
    changed();
    if (mapOn()) ed.sel = stepSel(s);
    rebuild();
    if (mapOn()) focusInspector(); else focusFirstIn(s);
  }

  // The first field after Label in the map's inspector: what the step or trigger actually does.
  function focusInspector() {
    const fields = [...screen.querySelectorAll('.wfc-insp-body .field')];
    const el = fields.find(f => !f.closest('.wfc-label-field')) || screen.querySelector('.wfc-insp-body button');
    el?.focus();
  }

  function focusFirstIn(step) {
    const card = screen.querySelector(`[data-card="${keyOf(step)}"]`);
    // The first field after Label: what the step actually does.
    const fields = card ? [...card.querySelectorAll(':scope > .wf-step-body .field')] : [];
    const el = fields[1] || fields[0] || card?.querySelector('.wf-step-toggle');
    el?.focus();
    card?.scrollIntoView({ block: 'nearest' });
  }

  function stepCard(steps, i, at, depth, chain) {
    const step = steps[i];
    const k = keyOf(step);
    const info = STEP_INFO[step.type] || { name: step.type };
    const open = openSteps.has(step);
    const name = () => step.label || info.name;
    const titleEl = h('span', { class: 'wf-step-title', text: name() });
    const ctx = { at, depth, chain, step };
    const li = h('li', { class: `wf-card wf-step${open ? ' open' : ''}`, 'data-type': step.type, 'data-card': k },
      h('div', { class: 'wf-card-head' },
        h('button', {
          type: 'button', class: 'wf-step-toggle', 'aria-expanded': String(open), 'data-fk': `t-${k}`,
          onclick: () => { if (open) openSteps.delete(step); else openSteps.add(step); rebuild(`t-${k}`); },
        },
        h('span', { class: 'wf-step-icon', 'aria-hidden': 'true' }, icon(step.type)),
        h('span', { class: 'wf-step-text' }, titleEl, open ? null : h('span', { class: 'wf-step-sum', text: stepSummary(step) })),
        h('span', { class: 'wf-err-dot', 'aria-hidden': 'true' })),
        iconBtn('up', `Move “${name()}” up`, () => moveStep(steps, i, -1), { disabled: i === 0, 'data-fk': `up-${k}` }),
        iconBtn('down', `Move “${name()}” down`, () => moveStep(steps, i, 1), { disabled: i === steps.length - 1, 'data-fk': `dn-${k}` }),
        iconBtn('more', `More for “${name()}”`, e => stepMenu(steps, i, e.currentTarget), { 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-fk': `mo-${k}` })),
      slot(at, null),
      open ? h('div', { class: 'wf-step-body' },
        txt('Label', step.label, v => { putOrDrop(step, 'label', v); titleEl.textContent = name(); }, { at: `${at}.label`, attrs: { maxlength: 80, placeholder: info.name } }),
        STEP_FIELDS[step.type]?.(step, ctx) || [],
        containerLists(step, ctx),
        advanced(step, ctx)) : null);
    cards.push({ at, el: li });
    return li;
  }

  function containerLists(step, ctx) {
    if (step.type === 'if') {
      return [
        branch('Then', step.then, `${ctx.at}.then`, ctx, 'Add a step to Then'),
        branch('Otherwise', step.else, `${ctx.at}.else`, ctx, 'Add a step to Otherwise'),
      ];
    }
    if (step.type === 'each') return [branch('Repeat', step.steps, `${ctx.at}.steps`, ctx, 'Add a step to repeat')];
    return [];
  }

  function branch(label, steps, at, ctx, addText) {
    return h('div', { class: 'wf-branch' },
      h('div', { class: 'wf-branch-label', text: label }),
      slot(at, null),
      stepList(steps, at, ctx.depth + 1, ctx.chain, addText, label));
  }

  function moveStep(steps, i, by) {
    const j = i + by;
    if (j < 0 || j >= steps.length) return;
    const s = steps[i];
    steps.splice(i, 1);
    steps.splice(j, 0, s);
    changed();
    rebuild(`${by < 0 ? 'up' : 'dn'}-${keyOf(s)}`);
  }

  function stepMenu(steps, i, anchor) {
    const s = steps[i];
    popup(anchor, () => [
      menuItem('Duplicate', 'A copy right after it', () => {
        const c = copyStep(s);
        steps.splice(i + 1, 0, c);
        openSteps.add(c);
        changed();
        rebuild();
        focusFirstIn(c);
      }, { disabled: countSteps() >= MAX.steps }),
      menuItem('Move up', null, () => moveStep(steps, i, -1), { disabled: i === 0 }),
      menuItem('Move down', null, () => moveStep(steps, i, 1), { disabled: i === steps.length - 1 }),
      h('div', { class: 'menu-sep' }),
      menuItem('Delete', null, () => deleteStep(steps, i)),
    ]);
  }

  function deleteStep(steps, i) {
    const s = steps[i];
    walk([s], x => { if (ed.sel === stepSel(x)) ed.sel = null; }); // it, or a step inside it
    steps.splice(i, 1);
    changed();
    const next = steps[Math.min(i, steps.length - 1)];
    rebuild(next ? stepFk(next) : `add-${keyOf(steps)}-${steps.length}`);
    SB.toast(`Deleted “${s.label || STEP_INFO[s.type]?.name}”`, { action: 'Undo', onAction: () => { steps.splice(i, 0, s); changed(); rebuild(stepFk(s)); } });
  }

  function stepSummary(s) {
    switch (s.type) {
      case 'claude': return `${MODE_NAME[s.mode || 'smart'] || s.mode} · ${firstLine(s.prompt) || 'Nothing to do yet'}`;
      case 'run': return firstLine(s.command) || 'No command yet';
      case 'http': return `${s.method || 'GET'} ${s.url || '…'}`;
      case 'mcp': return `${s.server || 'No server yet'} · ${s.tool || 'no tool yet'}`;
      case 'ask': return s.question || 'No question yet';
      case 'tell': return `${(TELL_TO.find(([v]) => v === (s.to || 'notification')) || [])[1] || s.to}: ${firstLine(s.text) || '…'}`;
      case 'set': return Object.keys(s.values || {}).join(', ') || 'Nothing set yet';
      case 'if': return `If ${s.test || '…'}`;
      case 'each': return `Each ${s.as || 'item'} in ${s.over || '…'}`;
      case 'wait': return `Wait ${humanSeconds(s.seconds)}`;
      case 'file': return `${(FILE_ACTIONS.find(([v]) => v === (s.action || 'read')) || [])[1] || s.action} · ${s.path || '…'}`;
      case 'workflow': return s.name ? `Run “${s.name}”` : 'No workflow picked';
      case 'stop': return s.status === 'error' ? `Stop as failed${s.message ? `: ${s.message}` : ''}` : `Stop${s.message ? `: ${s.message}` : ''}`;
      case 'worktree': return s.repo ? `Copy of ${s.repo}` : 'No repository yet';
      case 'pr': return `${s.draft === false ? 'Pull request' : 'Draft'}: ${firstLine(s.title) || '…'}`;
      default: return '';
    }
  }

  // A trigger in a line, for its node on the map (the server's wording is only for saved ones).
  function triggerSummary(t) {
    const s = t.schedule || {};
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    switch (t.type) {
      case 'schedule':
        if (s.type === 'weekly') return `${(s.days || []).map(n => DAYS[n]).join(', ') || 'No days'} at ${s.time || '09:00'}`;
        if (s.type === 'interval') return `Every ${plural(s.everyHours || 0, 'hour')}`;
        if (s.type === 'minutes') return `Every ${plural(s.every || 0, 'minute')}`;
        return `Every day at ${s.time || '09:00'}`;
      case 'ci': return `${{ failed: 'Fails', fixed: 'Goes green again', passed: 'Passes', merged: 'Is merged', review: 'Needs your review', any: 'Any change' }[t.on] || t.on}${t.repo ? ` · ${t.repo}` : ''}`;
      case 'issue': return `${{ assigned: 'Assigned to me', labelled: 'Labelled shellby', any: 'Assigned or labelled' }[t.on] || t.on}${t.repo ? ` · ${t.repo}` : ''}`;
      case 'shipped': return `${{ any: 'Anything', push: 'A push', deploy: 'A deploy', release: 'A release', merge: 'A merge' }[t.kind] || t.kind}${t.project ? ` · ${t.project}` : ''}`;
      case 'task': return { ok: 'A task succeeds', error: 'A task fails' }[t.outcome] || 'A task finishes';
      case 'folder': return `${t.pattern || 'Files'} ${t.events === 'changed' ? 'changed' : t.events === 'any' ? 'added or changed' : 'added'}${t.path ? ` in ${SB.shortPath(t.path, 28)}` : ''}`;
      case 'workflow': return t.name ? `“${t.name}” ${{ ok: 'succeeds', error: 'fails' }[t.status] || 'finishes'}` : 'No workflow picked';
      default: return TRIGGER_INFO[t.type]?.sub || '';
    }
  }

  // ================================================================ the editor: map

  // sel -> what it stands for ({ kind: 'step', step, place } / { kind: 'trigger', t, index }),
  // filled in as the map draws its nodes.
  let selInfo = new Map();

  function mapPane(d) {
    selInfo = new Map();
    const settingsBtn = h('button', {
      type: 'button', class: 'btn ghost slim-btn wf-settings-btn', 'aria-expanded': String(ed.sel === 'settings'), 'data-fk': 'wf-settings',
      onclick: e => ed.map?.select(ed.sel === 'settings' ? null : 'settings', { focus: e.detail === 0 }),
    }, icon('settings'), 'Settings');
    const canvas = SB.wfCanvas.mount({
      id: `ed-${keyOf(d)}`,
      label: 'The workflow as a map. Steps run from the top; an If splits into two lanes.',
      steps: d.steps,
      maxDepth: MAX.depth,
      sel: ed.sel,
      icon,
      triggers: [() => manualNode(d), ...d.when.map((t, i) => () => triggerNode(t, i))],
      step: (s, place) => {
        selInfo.set(stepSel(s), { kind: 'step', step: s, place });
        return {
          sel: stepSel(s), type: s.type, icon: s.type, at: place.at, removable: true,
          title: s.label || STEP_INFO[s.type]?.name || s.type,
          sub: stepSummary(s),
          badge: s.if ? 'only if' : '',
          note: s.if ? `Only if ${s.if}` : '',
          loopLabel: s.type === 'each' ? `Each ${s.as || 'item'}` : '',
        };
      },
      register: (at, cell) => { cards.push({ at, el: cell }); return slot(at, null); },
      select: sel => { ed.sel = sel; settingsBtn.setAttribute('aria-expanded', String(sel === 'settings')); },
      closed: was => { if (was === 'settings') settingsBtn.focus(); },
      inspect: (box, sel, close) => inspectEdit(box, sel, close),
      add: (list, index, btn, depth) => popup(btn, () => typeMenu(type => insertStep(list, index, type), depth)),
      addLabel: (list, index) => {
        const named = s => `“${s.label || STEP_INFO[s.type]?.name}”`;
        if (index < list.length) return `Add a step before ${named(list[index])}`;
        return list.length ? `Add a step after ${named(list[list.length - 1])}` : 'Add a step here';
      },
      addFk: (list, index) => `add-${keyOf(list)}-${index}`,
      addTrigger: d.when.length < MAX.triggers ? btn => popup(btn, () => triggerMenu(d)) : null,
      move: (step, list, index) => {
        if (!G.moveTo(d.steps, step, list, index, MAX.depth)) return;
        changed();
        rebuild(stepFk(step));
        SB.toast(`Moved “${step.label || STEP_INFO[step.type]?.name}”`);
      },
      remove: removeSel,
      tools: [roomBtn()],
    });
    ed.map = canvas;
    return h('div', { class: 'wf-mappane' },
      h('div', { class: 'wf-mapbar' }, nameField(d, 'wf-mapbar-name'), settingsBtn),
      canvas.el,
      h('p', { class: 'sr-only', text: 'Press a node to change it. Drag a step onto a + to move it. List shows the same workflow as a list.' }));
  }

  function manualNode(d) {
    selInfo.set('manual', { kind: 'manual' });
    return {
      sel: 'manual', kind: 'trigger', type: 'manual', icon: 'play', dashed: true, title: 'Run by hand',
      sub: d.inputs.length ? `Asks for ${plural(d.inputs.length, 'input')}` : 'Press Run any time',
    };
  }

  function triggerNode(t, index) {
    selInfo.set(trigSel(t), { kind: 'trigger', t, index });
    return {
      sel: trigSel(t), kind: 'trigger', type: t.type, icon: 'trigger', at: `when[${index}]`, removable: true,
      title: TRIGGER_INFO[t.type]?.name || t.type, sub: triggerSummary(t),
    };
  }

  function removeSel(sel) {
    const it = selInfo.get(sel);
    if (it?.kind === 'step') deleteStep(it.place.list, it.place.index);
    else if (it?.kind === 'trigger') removeTrigger(it.index);
  }

  // The inspector: the same fields the list shows, for the one node you picked.
  function inspectEdit(box, sel, close) {
    const it = sel === 'settings' ? { kind: 'settings' } : selInfo.get(sel);
    if (!it) return false;
    const d = ed.def;
    if (it.kind === 'step') fill(box, stepInspector(it.step, it.place, close));
    else if (it.kind === 'trigger') fill(box, triggerInspector(it.t, it.index, close));
    else if (it.kind === 'manual') {
      fill(box, inspRoot('manual', inspHead('play', 'Run by hand', null, close),
        h('p', { class: 'field-hint', text: 'Any workflow can be started with Run on the Workflows page, from another workflow, or by Claude Code when it has the Claude Code trigger. Inputs are what it asks for first.' }),
        inputsSection(d)));
    } else {
      fill(box, inspRoot('settings', inspHead('settings', 'Settings', null, close), aboutFields(d)));
    }
    return true;
  }

  const inspRoot = (type, ...kids) => h('div', { class: 'wf-step wfc-insp-root', 'data-type': type }, kids);

  function inspHead(iconName, title, actions, close) {
    const titleEl = typeof title === 'string' ? h('h3', { class: 'wfc-insp-title', text: title }) : title;
    return h('div', { class: 'wfc-insp-head' },
      h('span', { class: 'wf-step-icon', 'aria-hidden': 'true' }, icon(iconName)),
      titleEl, actions,
      iconBtn('close', 'Close', close, { 'data-fk': 'insp-close', title: 'Close (Esc)' }));
  }

  function stepInspector(step, place, close) {
    const info = STEP_INFO[step.type] || { name: step.type };
    const ctx = { at: place.at, depth: place.depth, chain: place.chain, step };
    const name = () => step.label || info.name;
    const titleEl = h('h3', { class: 'wfc-insp-title', text: name() });
    const more = iconBtn('more', `More for “${name()}”`, e => stepMapMenu(place, e.currentTarget), { 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-fk': 'insp-more' });
    const inside = { if: 'Its steps are on the map, in the Then and Otherwise lanes under it. Press + in a lane to add one.', each: 'The steps it repeats are on the map, inside the loop under it.' }[step.type];
    return inspRoot(step.type,
      inspHead(step.type, titleEl, more, close),
      h('p', { class: 'field-hint wfc-insp-sub', text: info.sub }),
      slot(place.at, null),
      txt('Label', step.label, v => { putOrDrop(step, 'label', v); titleEl.textContent = name(); }, { at: `${place.at}.label`, cls: 'wfc-label-field', attrs: { maxlength: 80, placeholder: info.name } }),
      STEP_FIELDS[step.type]?.(step, ctx) || [],
      inside ? h('p', { class: 'field-hint', text: inside }) : null,
      advanced(step, ctx));
  }

  function stepMapMenu({ list, index }, anchor) {
    const s = list[index];
    popup(anchor, () => [
      menuItem('Duplicate', 'A copy right after it', () => {
        const c = copyStep(s);
        list.splice(index + 1, 0, c);
        changed();
        ed.sel = stepSel(c);
        rebuild();
        focusInspector();
      }, { disabled: countSteps() >= MAX.steps }),
      menuItem('Move up', null, () => moveStep(list, index, -1), { disabled: index === 0 }),
      menuItem('Move down', null, () => moveStep(list, index, 1), { disabled: index === list.length - 1 }),
      h('div', { class: 'menu-sep' }),
      menuItem('Delete', null, () => deleteStep(list, index)),
    ]);
  }

  function triggerInspector(t, index, close) {
    const at = `when[${index}]`;
    const info = TRIGGER_INFO[t.type] || { name: t.type };
    return inspRoot('trigger',
      inspHead('trigger', info.name, null, close),
      h('p', { class: 'field-hint wfc-insp-sub', text: info.sub || '' }),
      slot(at, null),
      triggerFields(t, at),
      h('button', { type: 'button', class: 'btn ghost slim-btn wfc-insp-remove', onclick: () => removeTrigger(index) }, 'Remove this trigger'));
  }

  // ================================================================ live updates

  function onRun(summary) {
    if (!summary?.id) return;
    ed.chat?.onRun(summary); // Claude's test run, wherever you are
    const w = workflows().find(x => x.id === summary.workflowId);
    if (w && (!w.lastRun || w.lastRun.id === summary.id || (summary.startedAt || 0) >= (w.lastRun.startedAt || 0))) w.lastRun = summary;
    if (state.view !== 'workflows') return;
    const s = current();
    if (s.name === 'list') refreshList();
    if (s.name === 'runs' && s.id === summary.workflowId) refreshRuns();
    if (s.name === 'run' && s.runId === summary.id) refreshRun();
  }

  // Next-run times drift into the past while the panel is open.
  setInterval(() => { if (state.view === 'workflows' && current().name === 'list' && !document.hidden) api.listWorkflows().then(applyView).catch(() => {}); }, 60000);

  // ================================================================ wiring

  SB.applyWorkflows = applyView;
  SB.onWorkflowRun = onRun;
  SB.workflows = {
    create: () => { SB.setView('workflows'); leaveEditorIfNeeded(() => openEditor(blankWorkflow())); },
    describe: () => {
      SB.setView('workflows');
      leaveEditorIfNeeded(() => {
        if (nav.length > 1) home();
        focusDescribeSoon();
      });
    },
  };

  // A notification about a run (it needs an answer, it failed) opens that run.
  function openRun(runId) {
    if (typeof runId !== 'string') return;
    resetNav({ name: 'run', runId });
    if (state.view !== 'workflows') SB.setView('workflows'); else show();
  }

  Object.assign(W, { renderEditor, stepSummary, triggerSummary, inspRoot, inspHead });
  SB.views.workflows = { render, openRun, draftFrom };
})();
