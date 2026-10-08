/* Shellby panel — Workflows: the editor's JSON, Save, and Build it with Claude. */
'use strict';
(function () {
  const { h, api, $ } = SB;
  const W = SB.wfKit;
  const {
    ed, rebuild, screen, normalise, changed, validateSoon, uid, current, normErrors, mapOn, selFor, applyView,
    loadView, home, within, openSteps, openAdvanced, CONTAINERS, nav, clone, paintErrors, go, walk, stepFk,
  } = W;

  // ------------------------------------------------------------ JSON

  function toggleJson() {
    if (!ed.json) {
      ed.json = true;
      ed.jsonText = JSON.stringify(ed.def, null, 2);
      ed.jsonError = '';
      rebuild();
      screen.querySelector('.wf-json')?.focus();
      return;
    }
    if (applyJson()) requestAnimationFrame(() => screen.querySelector('.wf-json-toggle')?.focus());
  }

  function applyJson() {
    let parsed;
    try { parsed = JSON.parse(ed.jsonText); } catch (e) { return jsonFail(`That isn't valid JSON: ${e.message}`); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return jsonFail('A workflow is one { … } object.');
    // Editing keeps who it is, even if the pasted text left those out.
    if (ed.def.id && !parsed.id) parsed.id = ed.def.id;
    if (ed.def.createdAt && !parsed.createdAt) parsed.createdAt = ed.def.createdAt;
    ed.def = normalise(parsed);
    ed.json = false;
    ed.jsonError = '';
    changed();
    rebuild();
    validateSoon.now();
    return true;
  }

  function jsonFail(msg) {
    ed.jsonError = msg;
    const err = screen.querySelector('.wf-json-err');
    if (err) { err.hidden = false; err.textContent = msg; }
    screen.querySelector('.wf-json')?.focus();
    return false;
  }

  function jsonPane() {
    const id = uid('json');
    const ta = h('textarea', { class: 'field area wf-json', id, rows: 20, spellcheck: 'false', oninput: e => { ed.jsonText = e.target.value; ed.dirty = true; } });
    ta.value = ed.jsonText;
    return h('div', { class: 'wf-json-pane' },
      h('label', { class: 'field-label', for: id, text: 'The whole workflow as JSON' }),
      ta,
      h('p', { class: 'wf-err wf-json-err', role: 'alert', hidden: !ed.jsonError, text: ed.jsonError }),
      h('div', { class: 'row end' },
        h('button', { type: 'button', class: 'btn ghost slim-btn', onclick: () => { ed.json = false; ed.jsonError = ''; rebuild(); } }, 'Back to the form'),
        h('button', { type: 'button', class: 'btn slim-btn', onclick: applyJson }, 'Apply')));
  }

  // ------------------------------------------------------------ Save

  async function save() {
    if (ed.saving) return;
    if (ed.json && !applyJson()) return;
    validateSoon.cancel();
    ed.saving = true;
    const btn = $('wfSave');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    let res;
    try { res = await api.saveWorkflow(ed.def); } catch { res = { ok: false, errors: [{ path: '', message: 'Couldn\'t save. Try again.' }] }; }
    ed.saving = false;
    if (current().name !== 'editor') return;
    if (!res?.ok) {
      ed.errors = normErrors(res?.errors);
      if (!ed.errors.length) ed.errors = [{ path: '', message: 'Not saved.' }];
      ed.failedSave = true;
      openErrored();
      if (mapOn()) ed.sel = ed.errors.map(e => selFor(e.path)).find(Boolean) || ed.sel;
      rebuild();
      requestAnimationFrame(() => { const box = $('wfSummary'); if (box && !box.hidden) { box.tabIndex = -1; box.focus(); box.scrollIntoView({ block: 'nearest' }); } else screen.querySelector('[aria-invalid="true"]')?.focus(); });
      return;
    }
    ed.dirty = false;
    if (res.view) applyView(res.view); else loadView();
    SB.toast(`Saved “${res.workflow?.name || ed.def.name}”`);
    home();
  }

  // After a failed save, open every card with a problem in it (and their parents).
  function openErrored() {
    const visit = (steps, at) => steps.forEach((s, i) => {
      const here = `${at}[${i}]`;
      if (ed.errors.some(e => within(e.path, here) && e.path !== here)) openSteps.add(s);
      if (ed.errors.some(e => within(e.path, `${here}.retry`) || within(e.path, `${here}.if`) || within(e.path, `${here}.id`) || within(e.path, `${here}.timeoutMin`))) openAdvanced.add(s);
      for (const k of CONTAINERS[s.type] || []) visit(s[k] || [], `${here}.${k}`);
    });
    visit(ed.def.steps, 'steps');
  }

  // ------------------------------------------------------------ Build it with Claude (wf-chat.js)

  function chatHost() {
    let chat = null;
    const alive = () => !!chat && ed.chat === chat && nav.some(x => x.name === 'editor');
    return {
      alive,
      noun: 'workflow',
      getDef: () => { if (ed.json) applyJson(); return clone(ed.def); },
      ask: async ({ def, messages, runId }) => {
        const res = await api.chatWorkflow({ workflow: def, messages, runId });
        return res?.ok && res.workflow ? { ...res, def: res.workflow } : res;
      },
      startRun: id => api.runWorkflow(id, {}),
      stopRun: runId => api.stopRun(runId),
      getRun: runId => api.getRun(runId),
      apply: (def, { since } = {}) => {
        if (!alive()) return false;
        if (ed.json) applyJson();
        if (since && JSON.stringify(ed.def) !== since) return 'conflict';
        const before = stepPrints(ed.def);
        ed.def = normalise(def);
        ed.dirty = true;
        ed.touched = true;
        ed.json = false;
        ed.sel = null;
        if (current().name !== 'editor') return true;
        rebuild();
        validateSoon.now();
        flashChanged(before);
        return true;
      },
      testSave: async () => {
        if (!alive()) return { ok: false, error: 'The editor was closed.' };
        if (ed.json && !applyJson()) return { ok: false, error: 'The JSON has a problem.' };
        // A new workflow is tested switched off, so its triggers can't fire before you Save it.
        const enabled = ed.def.enabled !== false;
        const sent = { ...clone(ed.def), enabled: ed.def.id && !ed.trial ? enabled : false };
        let res;
        try { res = await api.saveWorkflow(sent); } catch { res = { ok: false, errors: [{ message: 'Couldn\'t save it.' }] }; }
        if (!res?.ok) {
          if (!res?.declined && alive()) { ed.errors = normErrors(res?.errors); if (current().name === 'editor') paintErrors(); }
          return { ok: false, declined: !!res?.declined, error: normErrors(res?.errors).map(e => e.message).join(' ') || 'Not saved.' };
        }
        if (res.view) applyView(res.view); else loadView();
        if (alive()) {
          if (!ed.def.id) ed.trial = true;
          // Saving gives it an id and hook addresses. Only those are copied in: anything you
          // changed while it saved stays, and so does your on/off.
          const fillIn = def => {
            def.id = res.workflow.id;
            def.createdAt = res.workflow.createdAt;
            const tokens = res.workflow.when.filter(t => t.type === 'webhook').map(t => t.token);
            for (const t of def.when.filter(x => x.type === 'webhook')) {
              const token = tokens.shift();
              if (!t.token) t.token = token;
            }
          };
          fillIn(ed.def);
          // What's on disk now, for "changes that aren't saved": a new one tested switched off
          // still differs from yours (it's on), so leaving it still warns until you Save.
          fillIn(sent);
          ed.saved = JSON.stringify(sent);
        }
        return { ok: true, id: res.workflow.id };
      },
      openRun: runId => { if (alive()) go('run', { runId }); },
      // The host is made before its chat, which is bound to it straight after.
      bind: c => { chat = c; },
    };
  }

  // Each step's own settings (not the steps inside it), by id: what Claude's change touched.
  function stepPrints(def) {
    const prints = new Map();
    walk(def?.steps, s => {
      const own = Object.fromEntries(Object.entries(s).filter(([k]) => !(CONTAINERS[s.type] || []).includes(k)));
      prints.set(s.id, JSON.stringify(own));
    });
    return prints;
  }

  function flashChanged(before) {
    const after = stepPrints(ed.def);
    walk(ed.def.steps, s => {
      if (before.get(s.id) === after.get(s.id)) return;
      const el = [...screen.querySelectorAll('[data-fk]')].find(e => e.dataset.fk === stepFk(s));
      const target = el?.closest('.wfc-cell, .wf-card');
      if (!target) return;
      target.classList.remove('wf-touched');
      void target.offsetWidth; // restart the animation
      target.classList.add('wf-touched');
    });
  }

  Object.assign(W, { chatHost, toggleJson, jsonPane, save });
})();
