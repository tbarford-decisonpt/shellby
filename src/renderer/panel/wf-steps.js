/* Shellby panel — Workflows: each step type's fields. */
'use strict';
(function () {
  const { h, api, state } = SB;
  const W = SB.wfKit;
  const {
    area, sel, folderField, putOrDrop, check, changed, rebuild, keyOf, slot, METHODS, txt, rowsEditor, objRows,
    rowsObj, FILE_ACTIONS, TELL_TO, num, workflowPicker, ed, current, workflows, FIELD_TYPES, uid, MAX, fill,
    waitUnits, WAIT_UNITS, noWheel, selectControl, openAdvanced,
  } = W;

  // ------------------------------------------------------------ step types

  const ins = (ctx, extra = {}) => ({ ctx, ...extra });

  const STEP_FIELDS = {
    claude: (s, c) => [
      area('What should Claude do?', s.prompt, v => { s.prompt = v; }, { at: `${c.at}.prompt`, insert: ins(c), attrs: { rows: 5, maxlength: 8000, class: 'field area wf-prompt', placeholder: 'Find out why the build failed. Don\'t change anything yet.' } }),
      h('div', { class: 'grid-2' },
        sel('Permission mode', SB.MODES.map(m => [m.id, m.title, m.id === 'autonomous' && !state.settings.autonomousAcknowledged && s.mode !== 'autonomous']), s.mode || 'smart', v => { s.mode = v; }, { at: `${c.at}.mode` }),
        modelField(s, c)),
      folderField('Folder', s.cwd, v => putOrDrop(s, 'cwd', v), { at: `${c.at}.cwd`, placeholder: 'The workflow\'s folder' }),
      check('Fresh conversation', s.fresh, v => putOrDrop(s, 'fresh', v), { hint: 'Otherwise it carries on the conversation earlier Claude steps had, so it knows what they found.' }),
      SB.mcpPicker.field({ at: `${c.at}.mcp`, value: s, servers: mcpList(s), onChange: changed, rebuild: i => rebuild(`mcp-${keyOf(s)}-${i ?? 0}`), fk: `mcp-${keyOf(s)}`, slot }),
      outputFields(s, c),
    ],
    mcp: (s, c) => mcpStepFields(s, c),
    run: (s, c) => [
      area('Command (PowerShell)', s.command, v => { s.command = v; }, { at: `${c.at}.command`, insert: ins(c, { secrets: true }), attrs: { rows: 3, maxlength: 4000, class: 'field area wf-mono', placeholder: 'npm test' }, hint: 'Values go in as quoted text, so they can\'t become code.' }),
      folderField('Folder', s.cwd, v => putOrDrop(s, 'cwd', v), { at: `${c.at}.cwd`, placeholder: 'The workflow\'s folder' }),
      check('Carry on if it fails', s.allowFail, v => putOrDrop(s, 'allowFail', v), { hint: 'Later steps can check {{ id.ok }} and {{ id.code }}.' }),
    ],
    http: (s, c) => [
      h('div', { class: 'wf-http' },
        sel('Method', METHODS.map(m => [m, m]), s.method || 'GET', v => { s.method = v; }, { at: `${c.at}.method` }),
        txt('Address', s.url, v => { s.url = v; }, { at: `${c.at}.url`, insert: ins(c, { secrets: true }), attrs: { maxlength: 2000, placeholder: 'https://example.com/api', class: 'field wf-mono' } })),
      rowsEditor({
        legend: 'Headers', rows: objRows(s.headers), at: `${c.at}.headers`, addText: 'Add a header',
        blank: () => ({ k: '', v: '' }),
        columns: [{ key: 'k', label: 'Header', placeholder: 'Authorization', mono: true }, { key: 'v', label: 'Value', placeholder: 'Bearer {{ secrets.TOKEN }}', insert: ins(c, { secrets: true }) }],
        onChange: rows => putOrDrop(s, 'headers', Object.keys(rowsObj(rows)).length ? rowsObj(rows) : undefined),
      }),
      area('Body', s.body, v => putOrDrop(s, 'body', v), { at: `${c.at}.body`, insert: ins(c, { secrets: true }), attrs: { rows: 3, class: 'field area wf-mono', placeholder: '{ "text": "{{ fix.reply }}" }' } }),
      check('Carry on if it fails', s.allowFail, v => putOrDrop(s, 'allowFail', v), { hint: 'Later steps can check {{ id.ok }} and {{ id.status }}.' }),
    ],
    file: (s, c) => [
      sel('Do what', FILE_ACTIONS, s.action || 'read', v => { s.action = v; if (v === 'read') delete s.content; rebuild(`fa-${keyOf(s)}`); }, { at: `${c.at}.action`, attrs: { 'data-fk': `fa-${keyOf(s)}` } }),
      txt('File', s.path, v => { s.path = v; }, { at: `${c.at}.path`, insert: ins(c), attrs: { placeholder: 'C:\\Users\\you\\notes.md', class: 'field wf-mono' }, hint: 'A full path.' }),
      (s.action || 'read') === 'read' ? null : area('What to write', s.content, v => putOrDrop(s, 'content', v), { at: `${c.at}.content`, insert: ins(c), attrs: { rows: 4 } }),
    ],
    ask: (s, c) => [
      txt('Question', s.question, v => { s.question = v; }, { at: `${c.at}.question`, insert: ins(c), attrs: { maxlength: 300, placeholder: 'Push the fix?' } }),
      choicesField(s, c),
    ],
    tell: (s, c) => [
      sel('Send to', TELL_TO, s.to || 'notification', v => { s.to = v; if (v !== 'file') delete s.path; rebuild(`tt-${keyOf(s)}`); }, { at: `${c.at}.to`, attrs: { 'data-fk': `tt-${keyOf(s)}` } }),
      txt('Title (optional)', s.title, v => putOrDrop(s, 'title', v), { at: `${c.at}.title`, insert: ins(c), attrs: { maxlength: 100, placeholder: 'The workflow\'s name' } }),
      area('Message', s.text, v => { s.text = v; }, { at: `${c.at}.text`, insert: ins(c), attrs: { rows: 3, maxlength: 1000 } }),
      s.to === 'file' ? txt('File', s.path, v => { s.path = v; }, { at: `${c.at}.path`, insert: ins(c), attrs: { placeholder: 'C:\\Users\\you\\log.md', class: 'field wf-mono' }, hint: 'The message is added to the end.' }) : null,
    ],
    set: (s, c) => [rowsEditor({
      legend: 'Values', rows: objRows(s.values), at: `${c.at}.values`, addText: 'Add a value',
      hint: 'Later steps use them as {{ vars.name }}.',
      blank: () => ({ k: '', v: '' }),
      columns: [{ key: 'k', label: 'Name', placeholder: 'summary', mono: true, width: '.8fr' }, { key: 'v', label: 'Value', placeholder: '{{ brief.reply }}', insert: ins(c) }],
      onChange: rows => { s.values = rowsObj(rows); },
    })],
    if: (s, c) => [
      txt('Test', s.test, v => { s.test = v; }, { at: `${c.at}.test`, insert: ins(c, { cond: true }), attrs: { class: 'field wf-mono', placeholder: 'diagnose.fixable == true' }, hint: 'Compare with == != > < contains, and join with and, or, not.' }),
    ],
    each: (s, c) => [
      txt('Go through', s.over, v => { s.over = v; }, { at: `${c.at}.over`, insert: ins(c), attrs: { class: 'field wf-mono', placeholder: '{{ trigger.files }}' }, hint: 'A list from an earlier step or the trigger.' }),
      h('div', { class: 'grid-2' },
        txt('Call each one', s.as, v => putOrDrop(s, 'as', v), { at: `${c.at}.as`, attrs: { class: 'field wf-mono', placeholder: 'item' } }),
        num('At most', s.max, v => putOrDrop(s, 'max', v), { at: `${c.at}.max`, attrs: { min: 1, max: 100 } })),
    ],
    wait: (s, c) => [waitField(s, c)],
    workflow: (s, c) => [
      workflowPicker('Workflow', s.name, v => { s.name = v; prefillInputs(s, v); rebuild(`wn-${keyOf(s)}`); }, { at: `${c.at}.name`, attrs: { 'data-fk': `wn-${keyOf(s)}` } }),
      rowsEditor({
        legend: 'Its inputs', rows: objRows(s.inputs), at: `${c.at}.inputs`, addText: 'Add an input',
        blank: () => ({ k: '', v: '' }),
        columns: [{ key: 'k', label: 'Input', mono: true, width: '.8fr' }, { key: 'v', label: 'Value', insert: ins(c) }],
        onChange: rows => putOrDrop(s, 'inputs', Object.keys(rowsObj(rows)).length ? rowsObj(rows) : undefined),
      }),
    ],
    worktree: (s, c) => [
      txt('Repository', s.repo, v => { s.repo = v; }, { at: `${c.at}.repo`, insert: ins(c), attrs: { class: 'field wf-mono', placeholder: '{{ trigger.repo }}' }, hint: 'owner/name, cloned on this PC (the Projects page clones it). The copy starts from its main branch on GitHub; your checkout isn\'t touched.' }),
      txt('Branch name (optional)', s.branch, v => putOrDrop(s, 'branch', v), { at: `${c.at}.branch`, insert: ins(c), attrs: { maxlength: 60, placeholder: 'issue-{{ trigger.number }}' }, hint: 'Becomes shellby/<name>-<code>. Later steps work in {{ id.path }}.' }),
    ],
    pr: (s, c) => [
      txt('Copy', s.folder, v => { s.folder = v; }, { at: `${c.at}.folder`, insert: ins(c), attrs: { class: 'field wf-mono', placeholder: '{{ copy.path }}' }, hint: 'The folder a “Make a copy” step made. Whatever is left uncommitted there is committed first.' }),
      txt('Title', s.title, v => { s.title = v; }, { at: `${c.at}.title`, insert: ins(c), attrs: { maxlength: 250, placeholder: '{{ trigger.title }}' } }),
      area('Description (optional)', s.body, v => putOrDrop(s, 'body', v), { at: `${c.at}.body`, insert: ins(c), attrs: { rows: 4, placeholder: 'Closes #{{ trigger.number }}' } }),
      check('Open it as a draft', s.draft !== false, v => { s.draft = v; }, { hint: 'Needs “Let Claude tasks push code and open pull requests” in Settings → GitHub.' }),
    ],
    stop: (s, c) => [
      sel('Finish the run as', [['ok', 'Done (ok)'], ['error', 'Failed']], s.status || 'ok', v => { s.status = v; }, { at: `${c.at}.status` }),
      txt('Message (optional)', s.message, v => putOrDrop(s, 'message', v), { at: `${c.at}.message`, attrs: { maxlength: 1000 } }),
    ],
  };

  function modelField(s, c) {
    const models = state.models || [];
    const groups = [...new Set(models.map(m => m.group))];
    const options = [['', 'Default'], ...groups.map(g => ({ group: g, options: models.filter(m => m.group === g).map(m => [m.id, m.label]) }))];
    if (s.model && !models.some(m => m.id === s.model)) options.push([s.model, s.model]);
    return sel('Model', options, s.model || '', v => putOrDrop(s, 'model', v), { at: `${c.at}.model` });
  }

  // The MCP servers a step can offer, for its folder (a project's own servers
  // depend on it). Read once per folder each time the editor opens; null while
  // still being read.
  const mcpLists = new Map(); // folder -> list, or null while it's read
  let mcpEpoch = 0;
  function mcpList(s) {
    const folder = s?.cwd || ed.def?.cwd || '';
    if (mcpLists.has(folder)) return mcpLists.get(folder);
    mcpLists.set(folder, null);
    const epoch = mcpEpoch;
    api.mcpServers(folder || null)
      .then(l => (Array.isArray(l) ? l : []), () => [])
      .then(l => {
        if (epoch !== mcpEpoch) return; // another editor has opened since
        mcpLists.set(folder, l);
        if (current().name === 'editor') rebuild();
      });
    return null;
  }

  // An MCP tool step: the server, its tool (read from the server on request),
  // and the arguments as JSON.
  const mcpTools = new Map(); // server -> [{ name, description, inputSchema }]

  // A new editor reads the servers and their tools again (wf-model.js openEditor).
  function forgetMcp() {
    mcpLists.clear();
    mcpEpoch++;
    mcpTools.clear();
  }

  function mcpStepFields(s, c) {
    const known = mcpList(s);
    const servers = (known || []).filter(x => x.direct);
    const options = [['', servers.length ? 'Pick one…' : known ? 'No servers Shellby can call' : 'Looking…'], ...servers.map(x => [x.name, x.name])];
    if (s.server && !servers.some(x => x.name === s.server)) options.push([s.server, `${s.server} (not found)`]);
    const tools = mcpTools.get(s.server) || null;
    const tool = tools?.find(t => t.name === s.tool) || null;
    const note = h('p', { class: 'field-hint', 'aria-live': 'polite' });
    const load = h('button', {
      type: 'button', class: 'btn slim-btn', disabled: !s.server,
      onclick: async () => {
        load.disabled = true;
        note.textContent = `Starting ${s.server} to ask what it can do…`;
        let r;
        try { r = await api.mcpTools(s.server, s.cwd || ed.def.cwd || null); } catch { r = { ok: false, error: 'Couldn\'t reach it. Try again.' }; }
        load.disabled = false;
        if (!r?.ok) { note.textContent = r?.error || 'Couldn\'t read its tools.'; return; }
        mcpTools.set(s.server, r.tools);
        rebuild(`mt-${keyOf(s)}`);
      },
    }, tools ? 'Read again' : 'Read its tools');
    const toolField = tools?.length
      ? sel('Tool', [['', 'Pick one…'], ...tools.map(t => [t.name, t.name]), ...(s.tool && !tool ? [[s.tool, `${s.tool} (not found)`]] : [])], s.tool || '', v => { s.tool = v; rebuild(`mt-${keyOf(s)}`); }, { at: `${c.at}.tool`, attrs: { 'data-fk': `mt-${keyOf(s)}` } })
      : txt('Tool', s.tool, v => { s.tool = v; }, { at: `${c.at}.tool`, attrs: { maxlength: 128, class: 'field wf-mono', placeholder: 'create_issue', 'data-fk': `mt-${keyOf(s)}` } });
    const skeleton = tool?.inputSchema ? SB.mcpPicker.argsSkeleton(tool.inputSchema) : null;
    return [
      sel('Server', options, s.server || '', v => { s.server = v; rebuild(`ms-${keyOf(s)}`); }, { at: `${c.at}.server`, attrs: { 'data-fk': `ms-${keyOf(s)}` }, hint: 'Servers that come with a plugin, or need you to sign in, work in an Ask Claude step instead.' }),
      h('div', { class: 'row' }, load, note),
      toolField,
      tool?.description ? h('p', { class: 'field-hint wf-tool-about', text: tool.description }) : null,
      area('Arguments (JSON)', s.args, v => putOrDrop(s, 'args', v), { at: `${c.at}.args`, insert: ins(c), attrs: { rows: 4, class: 'field area wf-mono', placeholder: '{ "title": "{{ diagnose.cause }}" }' }, hint: 'Text values go in "quotes", like "{{ fix.reply }}". Lists and numbers go in without them.' }),
      skeleton && !s.args ? h('button', { type: 'button', class: 'btn ghost slim-btn', onclick: () => { s.args = skeleton; changed(); rebuild(`ms-${keyOf(s)}`); } }, 'Fill in its arguments') : null,
      folderField('Folder', s.cwd, v => putOrDrop(s, 'cwd', v), { at: `${c.at}.cwd`, placeholder: 'The workflow\'s folder', hint: 'Where the server starts, and which project\'s servers count.' }),
      check('Carry on if it fails', s.allowFail, v => putOrDrop(s, 'allowFail', v), { hint: 'Later steps can check {{ id.ok }} and {{ id.text }}.' }),
    ];
  }

  function prefillInputs(s, name) {
    const target = workflows().find(w => w.name === name);
    if (!target?.inputs?.length) return;
    const now = { ...(s.inputs || {}) };
    for (const i of target.inputs) if (!(i.name in now)) now[i.name] = '';
    s.inputs = now;
  }

  function outputFields(s, c) {
    const rows = Object.entries(s.output || {}).map(([name, f]) => ({ name, type: f?.type || 'string', description: f?.description || '' }));
    return rowsEditor({
      legend: 'Output fields', rows, at: `${c.at}.output`, addText: 'Add a field',
      hint: 'Claude ends its reply with these, so later steps can use {{ id.field }}.',
      blank: () => ({ name: '', type: 'string', description: '' }),
      columns: [
        { key: 'name', label: 'Field', placeholder: 'fixable', mono: true, width: '.9fr' },
        { key: 'type', label: 'Type', kind: 'select', options: FIELD_TYPES, width: '.8fr' },
        { key: 'description', label: 'Description', placeholder: 'True if a small fix works', width: '1.3fr' },
      ],
      onChange: list2 => {
        const out = Object.fromEntries(list2.filter(r => r.name.trim()).map(r => [r.name.trim(), { type: r.type, description: r.description }]));
        putOrDrop(s, 'output', Object.keys(out).length ? out : undefined);
      },
    });
  }

  function choicesField(s, c) {
    const id = uid('choice');
    const chips = h('ul', { class: 'wf-chips', 'aria-label': 'Choices' });
    const input = h('input', { class: 'field', id, maxlength: 40, autocomplete: 'off', placeholder: 'Add a choice' });
    const addBtn = h('button', { type: 'button', class: 'btn slim-btn', onclick: add }, 'Add');
    const note = h('p', { class: 'field-hint' });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    function list2() { return s.choices ? [...s.choices] : []; }
    function set(next) { putOrDrop(s, 'choices', next.length ? next : undefined); changed(); draw(); }
    function add() {
      const v = input.value.trim();
      const cur = list2();
      if (!v || cur.length >= MAX.choices) return;
      if (cur.some(x => x.toLowerCase() === v.toLowerCase())) { input.select(); return; }
      input.value = '';
      set([...cur, v]);
      input.focus();
    }
    function draw() {
      const cur = list2();
      fill(chips, ...cur.map((ch, i) => h('li', { class: 'wf-chip' }, h('span', { text: ch }),
        h('button', { type: 'button', class: 'wf-chip-x', 'aria-label': `Remove the choice “${ch}”`, onclick: () => { const n = list2(); n.splice(i, 1); set(n); input.focus(); } }, '×'))));
      const full = cur.length >= MAX.choices;
      input.disabled = full;
      addBtn.disabled = full;
      note.textContent = !cur.length ? 'No choices: you get Continue or Stop, and Stop ends the run.'
        : cur.length === 1 ? 'Add at least one more (2 to 4).' : `Later steps can check {{ ${s.id || 'id'}.choice }}.`;
    }
    draw();
    return h('div', { class: 'wf-field' },
      h('label', { class: 'field-label', for: id, text: 'Choices (optional)' }),
      chips, h('div', { class: 'row' }, input, addBtn), note, slot(`${c.at}.choices`, input));
  }

  function waitField(s, c) {
    const seconds = Number.isFinite(s.seconds) ? s.seconds : 60;
    const unit = waitUnits.get(s) || ([...WAIT_UNITS].reverse().find(([, f]) => seconds % f === 0) || WAIT_UNITS[0])[0];
    const factor = () => WAIT_UNITS.find(([u]) => u === (waitUnits.get(s) || unit))[1];
    const amount = noWheel(h('input', { class: 'field', type: 'number', min: 1, inputmode: 'numeric', 'aria-label': 'How long' }));
    amount.value = String(seconds / WAIT_UNITS.find(([u]) => u === unit)[1]);
    const recompute = () => { const n = Number(amount.value); s.seconds = Number.isFinite(n) && amount.value !== '' ? Math.round(n * factor()) : undefined; changed(); };
    amount.addEventListener('input', recompute);
    const unitSel = selectControl(WAIT_UNITS.map(([u]) => [u, u]), unit, v => { waitUnits.set(s, v); recompute(); }, { 'aria-label': 'Unit' });
    return h('div', { class: 'wf-field', role: 'group', 'aria-label': 'How long to wait' },
      h('div', { class: 'field-label', text: 'Wait for' }),
      h('div', { class: 'grid-2' }, amount, unitSel),
      slot(`${c.at}.seconds`, amount));
  }

  // ------------------------------------------------------------ Advanced (per step)

  function advanced(step, c) {
    const det = h('details', { class: 'wf-advanced', open: openAdvanced.has(step) },
      h('summary', { text: 'Advanced' }),
      h('div', { class: 'wf-advanced-body' },
        txt('Name for later steps', step.id, v => putOrDrop(step, 'id', v.trim()), {
          at: `${c.at}.id`, attrs: { class: 'field wf-mono', maxlength: 32, placeholder: step.type },
          hint: `Later steps use its results as {{ ${step.id || 'name'}.… }}. Lowercase letters, digits and _.`,
        }),
        txt('Only if', step.if, v => putOrDrop(step, 'if', v), { at: `${c.at}.if`, insert: ins(c, { cond: true }), attrs: { class: 'field wf-mono', placeholder: 'inputs.branch == "main"' }, hint: 'Skipped when this is false.' }),
        h('div', { class: 'grid-2' },
          num('Retry (times)', step.retry?.times, v => setRetry(step, 'times', v), { at: `${c.at}.retry.times`, attrs: { min: 0, max: 5, placeholder: '0' } }),
          num('Between tries (seconds)', step.retry?.delaySec, v => setRetry(step, 'delaySec', v), { at: `${c.at}.retry.delaySec`, attrs: { min: 1, max: 3600, placeholder: '30' } })),
        num('Time limit (minutes)', step.timeoutMin, v => putOrDrop(step, 'timeoutMin', v), { at: `${c.at}.timeoutMin`, attrs: { min: 1, max: 720, placeholder: 'None' } }),
        check('Carry on after an error', step.continueOnError, v => putOrDrop(step, 'continueOnError', v), { hint: 'The error is recorded and the next step runs.' })));
    det.addEventListener('toggle', () => { if (det.open) openAdvanced.add(step); else openAdvanced.delete(step); });
    return det;
  }

  function setRetry(step, key, v) {
    const r = { ...(step.retry || {}) };
    putOrDrop(r, key, v);
    if (!r.times && !r.delaySec) delete step.retry; else step.retry = r;
  }

  Object.assign(W, { forgetMcp, STEP_FIELDS, advanced });
})();
