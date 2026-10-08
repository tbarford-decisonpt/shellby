/* Shellby panel — Workflows: one workflow's runs, and one run. */
'use strict';
(function () {
  const { h, api, state } = SB;
  const W = SB.wfKit;
  const {
    setMapMode, current, workflows, fill, screen, backBtn, runNow, home, startRun, keepFocus, RUN_TRIGGER,
    runDuration, go, statusPill, firstLine, pref, PREF, layoutSwitch, focusFk, normalise, toDef, G, MAX, icon,
    TRIGGER_INFO, STATUS_WORD, STEP_INFO, STATUS_GLYPH, roomBtn, plural, openEditor, answer, throttle,
  } = W;
  // The editor's, in workflows.js (loaded after this): how a step or a trigger
  // reads in a line, and the frame of a map node's inspector.
  const stepSummary = s => W.stepSummary(s);
  const triggerSummary = t => W.triggerSummary(t);
  const inspRoot = (...a) => W.inspRoot(...a);
  const inspHead = (...a) => W.inspHead(...a);

  // ================================================================ runs of one workflow

  const runsState = { id: null, list: null, error: '' };

  function renderRuns() {
    setMapMode(false);
    const { id, name } = current();
    const w = workflows().find(x => x.id === id);
    if (runsState.id !== id) { runsState.id = id; runsState.list = null; runsState.error = ''; }
    if (!runsState.list && !runsState.error) loadRuns();
    const body = runsState.error ? h('p', { class: 'wf-err', text: runsState.error })
      : !runsState.list ? h('p', { class: 'muted small', role: 'status', text: 'Loading…' })
        : !runsState.list.length ? h('p', { class: 'wf-empty', text: 'No runs yet.' })
          : h('ul', { class: 'wf-runs', 'aria-label': 'Runs, newest first' }, runsState.list.map(runRow));
    fill(screen, 
      h('div', { class: 'view-head' }, backBtn(), h('h2', { text: 'Runs' }),
        w ? h('button', { type: 'button', class: 'btn primary slim-btn', onclick: () => startRunFromRuns(w) }, 'Run now') : null),
      h('p', { class: 'view-lede', text: w?.name || name || '' }),
      body);
  }

  function startRunFromRuns(w) {
    if (!w.inputs?.length) return runNow(w, {});
    home();
    startRun(w);
  }

  async function loadRuns() {
    const id = runsState.id;
    try {
      const l = await api.listRuns(id);
      if (runsState.id !== id) return;
      runsState.list = (Array.isArray(l) ? l : []).filter(r => r.workflowId === id).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    } catch {
      runsState.error = 'Couldn\'t load the runs.';
    }
    if (current().name === 'runs') keepFocus(renderRuns);
  }

  function runRow(r) {
    const meta = [RUN_TRIGGER[r.trigger?.type] || r.trigger?.type || '', r.startedAt ? SB.relTime(r.startedAt) : '', runDuration(r), r.steps ? `${r.done || 0}/${r.steps} steps` : ''].filter(Boolean);
    return h('li', {}, h('button', { type: 'button', class: 'wf-run-row', 'data-fk': `run-${r.id}`, onclick: () => go('run', { runId: r.id }) },
      statusPill(r.status, null),
      h('span', { class: 'wf-run-meta', text: meta.join(' · ') }),
      r.waiting ? h('span', { class: 'wf-run-wait', text: 'needs you' }) : null,
      r.error ? h('span', { class: 'wf-run-err', text: firstLine(r.error) }) : null));
  }

  // ================================================================ one run

  // sel: the map node whose inspector is open (undefined until the run first loads, then
  // whatever needs you: a question, or the step that failed).
  const runState = { id: null, rec: undefined, busy: '', sel: undefined };
  const openOutputs = new Set();

  function renderRun() {
    const { runId } = current();
    if (runState.id !== runId) { runState.id = runId; runState.rec = undefined; runState.busy = ''; runState.sel = undefined; openOutputs.clear(); }
    if (runState.rec === undefined) { loadRun(); }
    const r = runState.rec;
    // The map needs the workflow itself; one that's since been deleted can only be listed.
    const w = r && workflows().find(x => x.id === r.workflowId);
    const layout = w ? pref(PREF.runLayout, 'map') : 'list';
    const head = h('div', { class: 'view-head' }, backBtn(), h('h2', { class: 'wf-title', text: r?.workflowName || 'Run' }),
      w ? layoutSwitch(layout, v => { pref.set(PREF.runLayout, v); keepFocus(renderRun); focusFk(`lay-${v}`); }, 'Show the run as') : null);
    if (r === undefined) return fill(screen, head, h('p', { class: 'muted small', role: 'status', text: 'Loading…' }));
    if (!r) { setMapMode(false); return fill(screen, head, h('p', { class: 'wf-empty', text: 'This run isn\'t kept any more.' })); }
    setMapMode(layout === 'map');
    const status = h('div', { class: 'wf-run-status', role: 'status', 'aria-live': 'polite' },
      statusPill(r.status, null),
      h('span', { class: 'wf-run-meta', text: [RUN_TRIGGER[r.trigger?.type] || r.trigger?.type, r.startedAt ? `started ${SB.relTime(r.startedAt)}` : '', runDuration(r)].filter(Boolean).join(' · ') }));
    if (layout === 'map') {
      fill(screen, head, status, r.error ? h('pre', { class: 'wf-run-error wf-run-error-map', text: r.error }) : null, runActions(r), runMap(r, w));
      return;
    }
    fill(screen, head, status,
      r.error ? h('pre', { class: 'wf-run-error', text: r.error }) : null,
      runActions(r),
      Object.keys(r.inputs || {}).length ? factsList('Inputs', r.inputs) : null,
      h('h3', { class: 'wf-h3', text: 'Steps' }),
      timeline(r),
      Object.keys(r.vars || {}).length ? outputDetails('vars', 'Values', h('pre', { class: 'wf-pre', text: pretty(r.vars) })) : null);
  }

  const END_TITLE = { ok: 'Done', error: 'Failed', stopped: 'Stopped', running: 'Still going', waiting: 'Waiting', interrupted: 'Interrupted' };

  // The run drawn on its workflow: every node shows how its step went.
  function runMap(r, w) {
    const def = normalise(toDef(w));
    const stats = G.statusMap(r);
    const strays = G.strays(def.steps, stats);
    const trig = r.trigger?.type;
    const byHand = !def.when.some(t => t.type === trig);
    if (runState.sel === undefined) runState.sel = firstConcern(r, stats);
    const canvas = SB.wfCanvas.mount({
      id: `run-${r.id}`,
      label: 'The run as a map. Each step shows how it went.',
      readOnly: true,
      steps: def.steps,
      maxDepth: MAX.depth,
      sel: runState.sel,
      icon,
      started: Object.keys(r.steps || {}).length > 0,
      triggers: [
        () => ({ sel: 'manual', kind: 'trigger', type: 'manual', icon: 'play', title: byHand ? RUN_TRIGGER[trig] || 'By hand' : 'Run by hand', sub: byHand ? 'Started this run' : '', dashed: !byHand, ran: byHand }),
        ...def.when.map((t, i) => () => ({
          sel: `t${i}`, kind: 'trigger', type: t.type, icon: 'trigger', title: TRIGGER_INFO[t.type]?.name || t.type,
          sub: t.type === trig ? 'Started this run' : triggerSummary(t), ran: t.type === trig,
        })),
      ],
      step: (s, place) => {
        const a = stats.get(place.key);
        const word = a ? STATUS_WORD[a.status] || a.status : 'Didn\'t run';
        return {
          sel: `k:${place.key}`, type: s.type, icon: s.type,
          title: s.label || STEP_INFO[s.type]?.name || s.type,
          sub: runNodeSub(s, a),
          status: a?.status || 'pending',
          ran: !!a && !['pending', 'skipped'].includes(a.status),
          badge: a ? `${STATUS_GLYPH[a.status] || ''}${a.passes > 1 ? ` ×${a.passes}` : ''}` : '',
          note: a?.passes > 1 ? `${word}, ${a.passes} times` : word,
          branches: a?.branches,
          loopLabel: s.type === 'each' ? `Each ${s.as || 'item'}` : '',
        };
      },
      end: { sel: 'end', type: 'end', title: END_TITLE[r.status] || r.status, sub: runDuration(r), status: r.status, ran: r.status === 'ok' },
      select: sel => { runState.sel = sel; },
      inspect: (box, sel, close) => inspectRun(box, sel, close, { r, def, stats, trig, byHand }),
      tools: [roomBtn()],
    });
    return h('div', { class: 'wf-mappane' },
      strays.length ? h('p', { class: 'field-hint wf-map-strays', text: `${plural(strays.length, 'step')} in this run ${strays.length === 1 ? 'isn\'t' : 'aren\'t'} in the workflow any more. List shows everything it did.` }) : null,
      canvas.el);
  }

  // What a node says under its name during a run: how long, how many, which way.
  function runNodeSub(s, a) {
    if (!a) return stepSummary(s);
    const e = a.entries[a.entries.length - 1];
    if (s.type === 'if' && a.branches.length === 1) return a.branches[0] === 'then' ? 'Went to Then' : 'Went to Otherwise';
    if (s.type === 'each' && e.output && Number.isFinite(e.output.count)) return e.output.total > e.output.count ? `${e.output.count} of ${e.output.total}` : plural(e.output.count, 'item');
    if (a.status === 'waiting') return e.question || (e.waitUntil ? `Until ${SB.untilTime(e.waitUntil)}` : 'Waiting for you');
    if (a.status === 'error' && e.error) return firstLine(e.error);
    return e.startedAt && e.endedAt ? SB.duration(e.endedAt - e.startedAt) : stepSummary(s);
  }

  // Open on what needs you: a step that's asking, else the one that failed.
  function firstConcern(r, stats) {
    if (r.waiting?.key) return `k:${G.keyTemplate(r.waiting.key)}`;
    for (const [key, a] of stats) if (a.status === 'error') return `k:${key}`;
    return null;
  }

  function inspectRun(box, sel, close, { r, def, stats, trig, byHand }) {
    if (sel === 'end') {
      fill(box, inspRoot('end', inspHead('flag', END_TITLE[r.status] || r.status, null, close),
        h('p', { class: 'field-hint', text: [r.endedAt ? `Ended ${SB.relTime(r.endedAt)}` : 'Not finished', runDuration(r)].filter(Boolean).join(' · ') }),
        r.error ? h('pre', { class: 'wf-run-error small', text: r.error }) : null,
        Object.keys(r.vars || {}).length ? factsList('Values', r.vars) : h('p', { class: 'field-hint', text: 'No values were set.' })));
      return true;
    }
    if (sel === 'manual' || /^t\d+$/.test(sel)) {
      const t = sel === 'manual' ? null : def.when[Number(sel.slice(1))];
      const started = t ? t.type === trig : byHand;
      const data = r.trigger?.data;
      fill(box, inspRoot('trigger', inspHead(t ? 'trigger' : 'play', t ? TRIGGER_INFO[t.type]?.name || t.type : 'Run by hand', null, close),
        started ? null : h('p', { class: 'field-hint', text: 'This didn\'t start this run.' }),
        started && data && Object.keys(data).length ? factsList('What started it', data) : null,
        started && Object.keys(r.inputs || {}).length ? factsList('Inputs', r.inputs) : null,
        started && !Object.keys(data || {}).length && !Object.keys(r.inputs || {}).length ? h('p', { class: 'field-hint', text: 'It started this run, with nothing to pass on.' }) : null));
      return true;
    }
    const key = sel.slice(2);
    const found = G.stepKeys(def.steps).find(x => x.key === key);
    if (!found) return false;
    const s = found.step;
    const a = stats.get(key);
    const items = [];
    for (const e of a?.entries || []) {
      const pass = /.*\.each(\d+)\./.exec(e.key || ''); // the innermost loop's pass
      if (a.passes > 1 && pass) items.push(h('li', { class: 'wf-tl-pass', style: '--depth: 0', text: `#${Number(pass[1]) + 1}` }));
      items.push(timelineItem(r, e, 0));
    }
    fill(box, inspRoot(s.type, inspHead(s.type, s.label || STEP_INFO[s.type]?.name || s.type, null, close),
      h('p', { class: 'field-hint wfc-insp-sub', text: stepSummary(s) }),
      items.length ? h('ol', { class: 'wf-tl wfc-insp-tl' }, items) : h('p', { class: 'field-hint', text: 'It didn\'t run.' })));
    return true;
  }

  let loadingRun = false;
  async function loadRun() {
    if (loadingRun) return;
    loadingRun = true;
    const id = runState.id;
    let rec;
    try { rec = await api.getRun(id); } catch { rec = null; }
    loadingRun = false;
    if (runState.id !== id) return;
    runState.rec = rec || null;
    if (current().name === 'run') keepFocus(renderRun);
  }

  function runActions(r) {
    const busy = runState.busy;
    const act = (label, kind, fn, cls = 'btn slim-btn') => h('button', { type: 'button', class: cls, disabled: !!busy, 'data-fk': `act-${kind}`, onclick: () => fn(r) }, busy === kind ? `${label}…` : label);
    const btns = [];
    if (r.status === 'running' || r.status === 'waiting') btns.push(act('Stop', 'stop', stopRun));
    if (['error', 'interrupted', 'stopped'].includes(r.status)) btns.push(act('Retry from the failed step', 'resume', resumeRun));
    if (r.status === 'error') btns.push(act(busy === 'repair' ? 'Claude is looking' : 'Fix with Claude', 'repair', repairRun, 'btn primary slim-btn'));
    return btns.length ? h('div', { class: 'row wrap wf-run-actions' }, btns) : null;
  }

  async function runCall(kind, fn, okText) {
    runState.busy = kind;
    keepFocus(renderRun);
    let res;
    try { res = await fn(); } catch { res = { ok: false, error: 'That didn\'t work. Try again.' }; }
    runState.busy = '';
    SB.toast(res?.ok ? okText : res?.error || 'That didn\'t work.');
    if (current().name === 'run') { keepFocus(renderRun); refreshRun(); }
    return res;
  }

  const stopRun = r => runCall('stop', () => api.stopRun(r.id), 'Stopping it');
  const resumeRun = r => runCall('resume', () => api.resumeRun(r.id), 'Picking up from the failed step');

  async function repairRun(r) {
    runState.busy = 'repair';
    keepFocus(renderRun);
    let res;
    try { res = await api.repairWorkflow(r.id); } catch { res = { ok: false, error: 'Couldn\'t reach Claude. Try again.' }; }
    runState.busy = '';
    if (!res?.ok || !res.workflow) {
      SB.toast(res?.error || 'Claude couldn\'t fix it.');
      if (current().name === 'run') keepFocus(renderRun);
      return;
    }
    // The id is kept, so saving overwrites the workflow that failed.
    openEditor(res.workflow, { title: `Fix “${res.workflow.name || r.workflowName}”`, note: res.note || 'Claude changed the workflow. Check it over, then press Save.' });
  }

  function factsList(title, obj) {
    return h('div', { class: 'wf-facts' }, h('h3', { class: 'wf-h3', text: title }),
      h('dl', {}, Object.entries(obj).flatMap(([k, v]) => [h('dt', { class: 'wf-mono', text: k }), h('dd', { text: typeof v === 'string' ? v : pretty(v) })])));
  }

  // Keys are paths of step ids: look, pick.then.fix, files.each3.move. Indent by depth, and head each
  // loop pass with its number.
  function timeline(r) {
    const order = (r.order || Object.keys(r.steps || {})).filter(k => r.steps?.[k]);
    if (!order.length) return h('p', { class: 'wf-empty small', text: 'No steps have started yet.' });
    const items = [];
    const seenPass = new Set();
    for (const key of order) {
      const parts = key.split('.');
      for (let i = 1; i < parts.length; i += 2) {
        const m = /^each(\d+)$/.exec(parts[i]);
        const pass = parts.slice(0, i + 1).join('.');
        if (m && !seenPass.has(pass)) {
          seenPass.add(pass);
          items.push(h('li', { class: 'wf-tl-pass', style: `--depth: ${(i + 1) / 2}`, text: `#${Number(m[1]) + 1}` }));
        }
      }
      items.push(timelineItem(r, r.steps[key], (parts.length - 1) / 2));
    }
    return h('ol', { class: 'wf-tl' }, items);
  }

  function timelineItem(r, e, depth) {
    const meta = [];
    if (e.startedAt && e.endedAt) meta.push(SB.duration(e.endedAt - e.startedAt));
    if (e.attempts > 1) meta.push(`${e.attempts} tries`);
    if (e.type === 'if' && e.output?.branch) meta.push(e.output.branch === 'then' ? 'went to Then' : 'went to Otherwise');
    if (e.type === 'each' && e.output && Number.isFinite(e.output.count)) meta.push(e.output.total > e.output.count ? `${e.output.count} of ${e.output.total}` : plural(e.output.count, 'item'));
    if (e.status === 'waiting' && e.waitUntil) meta.push(`until ${SB.untilTime(e.waitUntil)}`);
    const waitingAsk = e.status === 'waiting' && (e.question || (r.waiting?.key === e.key && r.waiting.question));
    return h('li', { class: `wf-tl-item s-${e.status}`, style: `--depth: ${depth}` },
      h('span', { class: 'wf-tl-glyph', 'aria-hidden': 'true', text: STATUS_GLYPH[e.status] || '·' }),
      h('div', { class: 'wf-tl-main' },
        h('div', { class: 'wf-tl-title' },
          h('span', { class: 'wf-step-icon', 'aria-hidden': 'true' }, icon(e.type)),
          h('span', { class: 'wf-tl-name', text: e.label || e.id || STEP_INFO[e.type]?.name || e.key }),
          h('span', { class: 'sr-only', text: `: ${STATUS_WORD[e.status] || e.status}` }),
          meta.length ? h('span', { class: 'wf-tl-meta', text: meta.join(' · ') }) : null),
        e.error ? h('pre', { class: 'wf-run-error small', text: e.error }) : null,
        waitingAsk ? askBox(r, e) : null,
        e.tabId ? h('button', { type: 'button', class: 'btn ghost slim-btn wf-open-tab', onclick: () => openTab(e.tabId) }, 'Open conversation') : null,
        e.output != null && e.type !== 'if' ? stepOutput(e) : null));
  }

  function askBox(r, e) {
    const question = e.question || r.waiting?.question || '';
    const choices = e.choices?.length ? e.choices : r.waiting?.choices?.length ? r.waiting.choices : ['Continue', 'Stop'];
    return h('div', { class: 'wf-waiting', role: 'group', 'aria-label': 'Waiting for you' },
      h('p', { class: 'wf-waiting-q', text: question }),
      h('div', { class: 'row wrap' }, choices.map(c => h('button', {
        type: 'button', class: 'btn slim-btn',
        onclick: async ev => { ev.currentTarget.disabled = true; await answer(r.id, e.key, c); refreshRun(); },
      }, c))));
  }

  function openTab(tabId) {
    if (state.tabs.has(tabId)) { SB.activate(tabId); return; }
    SB.setView('chat');
    SB.toast('That conversation is closed. Find it in History.');
  }

  function stepOutput(e) {
    const o = e.output;
    let body;
    if (e.type === 'claude' && typeof o === 'object') {
      const rest = { ...o };
      delete rest.reply;
      delete rest.tabId;
      body = [o.reply ? SB.renderMarkdownInto(h('div', { class: 'wf-md' }), String(o.reply)) : null, fieldViews(rest)];
    } else if (e.type === 'run' && typeof o === 'object') {
      body = [h('pre', { class: 'wf-pre', text: String(o.output ?? '') || '(nothing printed)' }), h('p', { class: 'field-hint', text: `Exit code ${o.code}` })];
    } else if (e.type === 'http' && typeof o === 'object') {
      body = [h('p', { class: 'field-hint', text: `Status ${o.status}` }), h('pre', { class: 'wf-pre', text: o.json != null ? pretty(o.json) : String(o.body ?? '') })];
    } else if (e.type === 'file' && typeof o === 'object' && 'text' in o) {
      body = h('pre', { class: 'wf-pre', text: String(o.text ?? '') });
    } else {
      body = h('pre', { class: 'wf-pre', text: pretty(o) });
    }
    return outputDetails(e.key, 'Output', body);
  }

  // A Claude step's fields, each shown as what it is: short values as a
  // name/value list, long text as markdown, lists and objects as JSON.
  function fieldViews(fields) {
    const entries = Object.entries(fields);
    const isLong = v => typeof v === 'string' && (v.includes('\n') || v.length > 200);
    const short = entries.filter(([, v]) => (v === null || typeof v !== 'object') && !isLong(v));
    return [
      short.length ? h('dl', { class: 'wf-fields' }, short.map(([k, v]) => [h('dt', { text: k }), h('dd', { text: String(v) })])) : null,
      entries.filter(([, v]) => isLong(v)).map(([k, v]) => [h('p', { class: 'field-hint', text: k }), SB.renderMarkdownInto(h('div', { class: 'wf-md' }), v)]),
      entries.filter(([, v]) => v && typeof v === 'object').map(([k, v]) => [h('p', { class: 'field-hint', text: k }), h('pre', { class: 'wf-pre', text: pretty(v) })]),
    ];
  }

  function outputDetails(key, label, body) {
    const det = h('details', { class: 'wf-out', open: openOutputs.has(key) }, h('summary', { text: label }), body);
    det.addEventListener('toggle', () => { if (det.open) openOutputs.add(key); else openOutputs.delete(key); });
    return det;
  }

  function pretty(v) {
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
  }

  // A run moved on (a push from main): redraw whichever of these is showing.
  const refreshRuns = throttle(() => { if (current().name === 'runs') loadRuns(); }, 800);
  const refreshRun = throttle(() => { if (current().name === 'run') loadRun(); }, 500);

  Object.assign(W, { renderRuns, renderRun, refreshRuns, refreshRun });
})();
