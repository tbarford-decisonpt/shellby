/* Shellby panel — Routines: scheduled Claude Code tasks. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const form = $('routineEditor');
  let editing = null;      // routine being edited (null = new)
  let folder = null;       // chosen cwd for the editor (null = default)

  const TEMPLATES = [
    { name: 'Friday Downloads tidy', prompt: 'Sort my Downloads folder into subfolders by file type (Documents, Images, Archives, Installers, Other). Don\'t delete anything. Finish with a short summary of what moved.', schedule: { type: 'weekly', time: '17:00', days: [5] }, mode: 'acceptEdits' },
    { name: 'Morning briefing', prompt: 'List the files in my Documents and Desktop that changed in the last 24 hours, grouped by folder, with one line on what each probably is.', schedule: { type: 'daily', time: '08:30' }, mode: 'smart' },
    { name: 'Disk space watch', prompt: 'Check free space on every drive. If any drive is under 15% free, find the 10 largest folders on it and suggest what could be cleaned up. Don\'t delete anything.', schedule: { type: 'weekly', time: '12:00', days: [1] }, mode: 'smart' },
  ];

  const MODE_NAME = { ask: 'Ask first', smart: 'Smart', acceptEdits: 'Auto-edit', plan: 'Plan only', autonomous: 'Autonomous' };

  function statusPill(r) {
    if (r.running) return h('span', { class: 'r-pill running', text: 'running' });
    if (r.lastStatus === 'ok') return h('span', { class: 'r-pill ok', text: `ran ${SB.relTime(r.lastRunAt)}` });
    if (r.lastStatus === 'error') return h('span', { class: 'r-pill err', text: `failed ${SB.relTime(r.lastRunAt)}` });
    if (r.lastStatus === 'stopped') return h('span', { class: 'r-pill', text: `stopped ${SB.relTime(r.lastRunAt)}` });
    if (r.lastRunAt) return h('span', { class: 'r-pill', text: `started ${SB.relTime(r.lastRunAt)}` });
    return h('span', { class: 'r-pill', text: 'never run' });
  }

  function render() {
    const list = $('routineList');
    const routines = state.routines || [];
    if (!routines.length) {
      list.replaceChildren(h('li', { class: 'routine-empty' },
        h('p', {}, 'No routines yet. Start from one of these:'),
        h('div', { class: 'templates' }, TEMPLATES.map(t => h('button', { class: 'template', type: 'button', onclick: () => openEditor({ ...t, isTemplate: true }) },
          h('b', { text: t.name }), h('span', { text: t.prompt }))))));
      return;
    }
    list.replaceChildren(...routines.map(r => h('li', { class: `routine${r.enabled ? '' : ' paused'}` },
      h('label', { class: 'toggle mini', title: r.enabled ? 'Pause' : 'Resume' },
        h('input', { type: 'checkbox', checked: r.enabled, onchange: async e => {
          const res = await api.saveRoutine({ ...r, enabled: e.target.checked });
          if (res.ok) state.routines = res.routines; else SB.toast(res.errors.join(' '));
          render();
        } }), h('span', { class: 'switch' })),
      h('div', { class: 'routine-main' },
        h('div', { class: 'routine-name' }, r.name, statusPill(r)),
        h('div', { class: 'routine-when' },
          r.scheduleText,
          ' · ', r.enabled ? h('span', { title: r.next ? new Date(r.next).toLocaleString() : '' }, `next ${SB.untilTime(r.next)}`) : 'paused',
          ' · ', MODE_NAME[r.mode] || r.mode),
        h('div', { class: 'routine-prompt', text: r.prompt, title: r.prompt })),
      h('div', { class: 'routine-actions' },
        h('button', { class: 'icon-btn', type: 'button', title: 'Run now', 'aria-label': `Run ${r.name} now`, disabled: r.running, onclick: async () => {
          const res = await api.runRoutine(r.id);
          SB.toast(res.ok ? `Started "${r.name}"` : res.error);
          if (res.ok) SB.setView('chat');
        } }, SB.icon(SB.ICONS.play, { width: 1.5 })),
        h('button', { class: 'icon-btn', type: 'button', title: 'Edit', 'aria-label': `Edit ${r.name}`, onclick: () => openEditor(r) }, SB.icon(SB.ICONS.edit)),
        h('button', { class: 'icon-btn danger-hover', type: 'button', title: 'Delete', 'aria-label': `Delete ${r.name}`, onclick: async () => {
          state.routines = await api.deleteRoutine(r.id);
          render();
          SB.toast(`Deleted "${r.name}"`);
        } }, SB.icon(SB.ICONS.trash))))));
  }

  // ------------------------------------------------------------ editor

  function syncWhen() {
    const type = form.elements.type.value;
    form.querySelectorAll('[data-when]').forEach(el => { el.hidden = !el.dataset.when.split(' ').includes(type); });
  }
  form.elements.type.addEventListener('change', syncWhen);

  function openEditor(r = null) {
    editing = r && !r.isTemplate ? r : null;
    folder = r?.cwd || null;
    $('routineEditorTitle').textContent = editing ? `Edit “${r.name}”` : 'New routine';
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
    form.querySelector('option[value=autonomous]').disabled = !state.settings.autonomousAcknowledged;
    $('routineFolder').textContent = folder ? SB.tildify(folder) : `Default (${SB.tildify(state.cwd)})`;
    $('routineErrors').hidden = true;
    syncWhen();
    form.hidden = false;
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    form.elements.name.focus();
  }

  function closeEditor() { form.hidden = true; editing = null; }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const type = form.elements.type.value;
    const schedule = type === 'interval'
      ? { type, everyHours: Number(form.elements.everyHours.value) }
      : type === 'weekly'
        ? { type, time: form.elements.time.value, days: [...form.querySelectorAll('input[name=day]:checked')].map(c => Number(c.value)) }
        : { type, time: form.elements.time.value };
    const input = {
      ...(editing ? { id: editing.id, createdAt: editing.createdAt, lastRunAt: editing.lastRunAt, lastStatus: editing.lastStatus, enabled: editing.enabled } : {}),
      name: form.elements.name.value, prompt: form.elements.prompt.value, cwd: folder,
      mode: form.elements.mode.value, schedule, catchUp: form.elements.catchUp.checked,
    };
    const res = await api.saveRoutine(input);
    if (!res.ok) {
      $('routineErrors').hidden = false;
      $('routineErrors').textContent = res.errors.join(' ');
      return;
    }
    state.routines = res.routines;
    closeEditor();
    render();
    const saved = state.routines.find(r => r.id === res.routine.id);
    SB.toast(`Saved. Next run ${SB.untilTime(saved?.next)}`);
  });
  // ------------------------------------------------------------ describe it

  // Claude only fills in the editor; the routine is saved by the Save button,
  // so what you see there is exactly what runs.
  const ask = $('routineAsk');
  const ASK_NOTE = $('routineAskNote').textContent;
  function askNote(text, err = false) {
    $('routineAskNote').textContent = text;
    $('routineAskNote').classList.toggle('err', err);
  }
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
      askNote(ASK_NOTE);
      openEditor({ ...res.draft, isTemplate: true });
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
    if (dir) { folder = dir; $('routineFolder').textContent = SB.tildify(dir); }
  });

  SB.views.routines = { render };
})();
