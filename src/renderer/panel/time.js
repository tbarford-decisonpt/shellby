/* Shellby panel — Time: hours on each project for timesheets and invoices
   (src/main/timetrack.js). A tab beside History. Everything is worked out in
   main; this draws it and sends back edits. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;

  SB.NAV_SECTION.time = 'history';
  for (const b of document.querySelectorAll('[data-goto-view]')) b.addEventListener('click', () => SB.setView(b.dataset.gotoView));

  let view = null;          // the last view from main
  let rangeId = 'week';
  let estimates = false;    // fill untracked days from commits
  const open = new Set();   // projects with their details open, kept across redraws
  let refreshTimer = null;

  // ------------------------------------------------------------------ words

  const dur = s => {
    const m = Math.round(Math.max(0, s || 0) / 60);
    const hrs = Math.floor(m / 60);
    return hrs ? `${hrs}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
  };
  const decimal = s => (Math.round(((s || 0) / 3600) * 100) / 100).toFixed(2);
  const money = (n, cur) => {
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(n); } catch { return `${n.toFixed(2)} ${cur}`; }
  };
  const dateOf = day => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d); };
  const shortDay = day => dateOf(day).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const WHY = {
    window: 'from the window in front', shellby: "while Claude works in it, here in Shellby", claude: 'while Claude works in it',
    recent: "you were just in it", idle: '', other: '', none: '',
  };

  // ------------------------------------------------------------------ loading

  // Loads can overlap (the minute refresh, a click, a save): only the newest one draws.
  let loadSeq = 0;
  async function load() {
    const seq = ++loadSeq;
    const next = await api.getTime({ range: rangeId, estimates });
    if (seq !== loadSeq) return;
    view = next;
    render();
  }

  function scheduleRefresh() {
    clearInterval(refreshTimer);
    // Today's numbers move while you work: a quiet redraw each minute, never
    // while you're typing into the page.
    refreshTimer = setInterval(() => {
      if (state.view !== 'time') return clearInterval(refreshTimer);
      if ($('timeView').contains(document.activeElement) && document.activeElement.matches('input, select, textarea')) return;
      load();
    }, 60 * 1000);
  }

  // ------------------------------------------------------------------ drawing

  function renderNow(now) {
    const el = $('timeNow');
    if (!now?.enabled) { el.textContent = ''; el.hidden = true; return; }
    el.hidden = false;
    const todayLine = `${dur(now.today)} today`;
    el.replaceChildren(...(now.key
      ? [h('span', { class: 'tm-live', 'aria-hidden': 'true' }), h('b', { text: now.name }), ` · ${dur(now.seconds)} today${WHY[now.why] ? `, ${WHY[now.why]}` : ''}`, h('span', { class: 'tm-now-all', text: todayLine })]
      : [h('span', { class: 'tm-live off', 'aria-hidden': 'true' }), now.why === 'idle' ? 'Paused while you’re away' : 'Not on a project right now', h('span', { class: 'tm-now-all', text: todayLine })]));
  }

  function renderRanges() {
    $('timeRanges').replaceChildren(...view.ranges.map(r => h('button', {
      type: 'button', role: 'tab', 'aria-selected': String(r.id === view.range.id), dataset: { range: r.id },
      onclick: () => { rangeId = r.id; load(); },
    }, r.label)));
  }

  // One hue, light to full: the bar is the hours. Values on hover (and in each
  // bar's label for screen readers); the busiest day is labelled outright.
  function renderChart(sum) {
    const days = sum.days;
    const max = Math.max(...days.map(d => d.seconds), 1);
    const many = days.length > 10;
    const peak = days.reduce((a, d) => (d.seconds > a.seconds ? d : a), days[0] || { seconds: 0 });
    $('timeChart').classList.toggle('many', many);
    $('timeChart').replaceChildren(...days.map(d => {
      const date = dateOf(d.day);
      const label = many ? (date.getDate() === 1 || date.getDay() === 1 ? String(date.getDate()) : '') : date.toLocaleDateString(undefined, { weekday: 'short' });
      const words = `${shortDay(d.day)}: ${d.seconds ? dur(d.seconds) : 'nothing'}`;
      return h('li', { class: `tm-bar${d.seconds ? '' : ' zero'}${d.day === today() ? ' today' : ''}`, title: words, 'aria-label': words },
        h('span', { class: 'tm-bar-value', text: d === peak && d.seconds && !many ? dur(d.seconds) : '' }),
        h('span', { class: 'tm-bar-track' }, h('i', { style: `height:${d.seconds ? Math.max(4, Math.round((d.seconds / max) * 100)) : 0}%` })),
        h('span', { class: 'tm-bar-day', text: label }));
    }));
  }

  function projectSettings(p) {
    const onBooks = view.projects.find(x => x.key === p.key);
    const save = patch => api.setTimeProject(p.key, patch).then(r => (r?.ok ? load() : SB.toast(r?.error || "Couldn't save that.")));
    const name = h('input', { class: 'field', value: p.name, maxlength: '60', 'aria-label': 'Name on the timesheet' });
    const client = h('input', { class: 'field', value: p.client || '', maxlength: '60', placeholder: 'Who it’s for', list: 'timeClients', 'aria-label': 'Client' });
    const rate = h('input', { class: 'field', type: 'number', min: '0', step: '0.01', value: p.rate ?? '', placeholder: '0.00', 'aria-label': `Hourly rate in ${view.settings.currency}` });
    const billable = h('input', { type: 'checkbox', checked: p.billable });
    name.addEventListener('change', () => save({ name: name.value.trim() || p.name }));
    client.addEventListener('change', () => save({ client: client.value.trim() }));
    rate.addEventListener('change', () => save({ rate: rate.value === '' ? null : Number(rate.value) }));
    billable.addEventListener('change', () => save({ billable: billable.checked }));
    let armed = false;
    const forget = h('button', { type: 'button', class: 'btn ghost slim-btn danger-hover', text: 'Forget its time' });
    forget.addEventListener('click', async () => {
      if (!armed) { armed = true; forget.textContent = 'Sure? All of it, every day'; setTimeout(() => { armed = false; forget.textContent = 'Forget its time'; }, 4000); return; }
      const r = await api.removeTimeProject(p.key);
      if (!r?.ok) return SB.toast(r?.error || "Couldn't do that.");
      open.delete(p.key);
      load();
    });
    return h('div', { class: 'tm-psettings' },
      h('div', { class: 'grid-2' },
        h('label', { class: 'field-label' }, 'Name', name),
        h('label', { class: 'field-label' }, 'Client', client)),
      h('div', { class: 'tm-prow' },
        h('label', { class: 'field-label tm-rate' }, `Rate per hour (${view.settings.currency})`, rate),
        h('label', { class: 'toggle' }, billable, h('span', { class: 'switch' }), 'Billable')),
      h('div', { class: 'row wrap' },
        h('button', { type: 'button', class: 'btn ghost slim-btn', text: 'Stop tracking it', title: "Shellby won't count time for this project from now on. What's already there stays.", onclick: () => save({ ignored: true }) }),
        onBooks ? forget : null));
  }

  function dayRow(p, r) {
    const note = h('input', { class: 'field tm-note', value: r.note, maxlength: '200', placeholder: r.commits.length ? r.commits.map(c => c.subject).slice(0, 3).join('; ') : 'What it was for', 'aria-label': `What ${shortDay(r.day)} was for` });
    note.addEventListener('change', () => api.addTime({ key: p.key, day: r.day, minutes: 0, note: note.value.trim() }).then(x => (x?.ok ? load() : SB.toast(x?.error || "Couldn't save that."))));
    const nudge = minutes => api.addTime({ key: p.key, day: r.day, minutes }).then(x => (x?.ok ? load() : SB.toast(x?.error || "Couldn't change that.")));
    const parts = [r.tracked ? `${dur(r.tracked)} tracked` : '', r.manual ? `${r.manual > 0 ? '+' : '−'}${dur(Math.abs(r.manual))} by hand` : '', !r.tracked && !r.manual && r.estimate ? `~${dur(r.estimate)} from commits` : ''].filter(Boolean);
    const commitsTip = r.commits.length ? r.commits.map(c => `• ${c.subject}`).join('\n') + (r.commitCount > r.commits.length ? `\n…and ${r.commitCount - r.commits.length} more` : '') : '';
    return h('li', { class: `tm-day${r.total ? '' : ' empty'}${r.estimated ? ' est' : ''}` },
      h('span', { class: 'tm-day-date', text: shortDay(r.day) }),
      h('span', { class: 'tm-day-hours' }, h('b', { text: r.total ? dur(r.total) : '—' }), h('small', { text: parts.join(' · ') })),
      r.commitCount ? h('span', { class: 'tm-commits', title: commitsTip, tabindex: '0', 'aria-label': `${r.commitCount} commit${r.commitCount === 1 ? '' : 's'}: ${r.commits.map(c => c.subject).join('; ')}` }, `${r.commitCount} commit${r.commitCount === 1 ? '' : 's'}`) : h('span'),
      note,
      h('span', { class: 'tm-nudge' },
        h('button', { type: 'button', class: 'icon-btn', title: 'Take 15 minutes off', 'aria-label': `Take 15 minutes off ${shortDay(r.day)}`, disabled: !r.total || r.estimated, onclick: () => nudge(-15) }, '−'),
        h('button', { type: 'button', class: 'icon-btn', title: 'Add 15 minutes', 'aria-label': `Add 15 minutes to ${shortDay(r.day)}`, onclick: () => nudge(15) }, '+')));
  }

  function projectRow(p, max, sum) {
    const pay = p.billable && p.rate ? money(p.amount, sum.currency) : p.billable ? '' : 'not billable';
    const details = h('details', { class: 'tm-project', open: open.has(p.key) },
      h('summary', {},
        h('span', { class: 'tm-p-name' }, h('b', { text: p.name }), p.client ? h('small', { text: p.client }) : null),
        h('span', { class: 'tm-p-hours' }, h('b', { text: p.seconds ? dur(p.seconds) : '—' }), h('small', { text: [p.billed && p.billed !== p.seconds ? `${decimal(p.billed)} h billed` : '', pay].filter(Boolean).join(' · ') })),
        h('span', { class: 'tm-p-bar', 'aria-hidden': 'true' }, h('i', { style: `width:${p.seconds ? Math.max(2, Math.round((p.seconds / max) * 100)) : 0}%` }))),
      h('div', { class: 'tm-p-body' },
        !p.seconds && p.unfilled ? h('p', { class: 'muted small', text: `Commits here but no time kept: about ${dur(p.unfilled)} going by them.` }) : null,
        h('ul', { class: 'tm-days' }, p.days.map(r => dayRow(p, r))),
        projectSettings(p)));
    details.addEventListener('toggle', () => { if (details.open) open.add(p.key); else open.delete(p.key); });
    return h('li', {}, details);
  }

  function renderProjects(sum) {
    const max = Math.max(...sum.projects.map(p => p.seconds), 1);
    const list = sum.projects.map(p => projectRow(p, max, sum));
    $('timeProjects').replaceChildren(...(list.length ? list : [h('li', { class: 'tm-empty' },
      view.settings.enabled
        ? 'Nothing yet for this period. Time shows up here as you work: open a project in your editor or terminal, or have Claude work in one.'
        : 'Nothing kept for this period. Turn on Keep time and Shellby starts counting.')]));
    // Clients typed before, offered as you type.
    let dl = $('timeClients');
    if (!dl) { dl = h('datalist', { id: 'timeClients' }); document.body.append(dl); }
    dl.replaceChildren(...view.clients.map(c => h('option', { value: c })));
  }

  function renderTotals(sum) {
    $('timeTotal').replaceChildren(h('b', { text: dur(sum.totals.seconds) }), h('span', { text: ` ${view.range.label.toLowerCase()}` }));
    $('timeAmount').textContent = sum.totals.amount ? `${money(sum.totals.amount, sum.currency)} · ${decimal(sum.totals.billed)} billable h` : sum.totals.billed ? `${decimal(sum.totals.billed)} billable h` : '';
    const fill = $('timeFill');
    if (sum.totals.unfilled || estimates) {
      fill.hidden = false;
      fill.replaceChildren(
        h('label', { class: 'toggle' },
          h('input', { type: 'checkbox', checked: estimates, onchange: e => { estimates = e.target.checked; load(); } }), h('span', { class: 'switch' }),
          estimates ? 'Days with commits but no time are filled in from the commits' : `Fill days with commits but no time from the commits (about ${dur(sum.totals.unfilled)})`));
    } else fill.hidden = true;
  }

  function renderExport(sum) {
    const sel = $('timeOnly');
    const was = sel.value;
    const opt = (value, text) => h('option', { value, text });
    sel.replaceChildren(opt('', 'Every project'),
      ...sum.clients.map(c => opt(JSON.stringify({ client: c }), `Client: ${c}`)),
      ...sum.projects.map(p => opt(JSON.stringify({ key: p.key }), `Project: ${p.name}`)));
    if ([...sel.options].some(o => o.value === was)) sel.value = was;
    const none = !sum.projects.some(p => p.seconds);
    for (const id of ['timePdf', 'timeCsv', 'timeCopy']) $(id).disabled = none;
  }

  function renderForm() {
    const sel = $('timeAddProject');
    const was = sel.value;
    const all = [...view.projects.filter(p => !p.ignored).map(p => ({ key: p.key, name: p.name })), ...view.known];
    sel.replaceChildren(...(all.length ? all.map(p => h('option', { value: p.key, text: p.name })) : [h('option', { value: '', text: 'No projects yet' })]));
    if (all.some(p => p.key === was)) sel.value = was;
    const day = $('timeAddDay');
    day.max = today();
    if (!day.value) day.value = today();
  }

  function renderSettings() {
    const s = view.settings;
    const setOptions = (sel, values, label, current) => {
      if (sel.options.length !== values.length) sel.replaceChildren(...values.map(x => h('option', { value: String(x), text: label(x) })));
      sel.value = String(current);
    };
    setOptions($('timeIdle'), view.choices.idle, m => `${m} minutes away`, s.idleMinutes);
    const rounds = view.choices.round.flatMap(m => (m ? view.choices.roundModes.map(mode => `${m}|${mode}`) : ['0|nearest']));
    setOptions($('timeRound'), rounds, r => {
      const [m, mode] = r.split('|');
      return m === '0' ? "Don't round" : `${mode === 'up' ? 'Up' : 'To the nearest'} ${m} min`;
    }, s.roundMinutes ? `${s.roundMinutes}|${s.roundMode}` : '0|nearest');
    if (document.activeElement !== $('timeCurrency')) $('timeCurrency').value = s.currency;
    // Projects you said not to track, with the way back.
    const ignored = view.projects.filter(p => p.ignored);
    $('timeIgnored').hidden = !ignored.length;
    $('timeIgnored').replaceChildren('Not tracked: ', ...ignored.flatMap((p, i) => [i ? ', ' : '', p.name, ' ',
      h('button', { type: 'button', class: 'link-btn', text: 'track again', 'aria-label': `Track ${p.name} again`,
        onclick: () => api.setTimeProject(p.key, { ignored: false }).then(load) })]));
  }

  function render() {
    if (!view) return;
    const on = view.settings.enabled;
    $('timeToggle').checked = on;
    $('timeIntro').hidden = on || view.summary.projects.length > 0;
    renderNow(view.now);
    renderRanges();
    renderTotals(view.summary);
    renderChart(view.summary);
    renderProjects(view.summary);
    renderExport(view.summary);
    renderForm();
    renderSettings();
  }

  // ------------------------------------------------------------------ actions

  $('timeToggle').addEventListener('change', async e => {
    await api.setTimeSettings({ enabled: e.target.checked });
    SB.toast(e.target.checked ? 'Shellby is keeping time' : 'Time keeping is off. What’s there stays.');
    load();
  });
  $('timeIdle').addEventListener('change', e => api.setTimeSettings({ idleMinutes: Number(e.target.value) }).then(load));
  $('timeRound').addEventListener('change', e => {
    const [m, mode] = e.target.value.split('|');
    api.setTimeSettings({ roundMinutes: Number(m), roundMode: mode }).then(load);
  });
  $('timeCurrency').addEventListener('change', async e => {
    const cur = e.target.value.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur)) { SB.toast('A currency is three letters, like USD or EUR.'); e.target.value = view.settings.currency; return; }
    await api.setTimeSettings({ currency: cur });
    load();
  });
  $('timeAddFolder').addEventListener('click', async () => {
    const r = await api.addTimeFolder();
    if (r?.ok) { SB.toast('Added. Its time counts from now on'); load(); }
  });

  for (const b of document.querySelectorAll('.tm-sign [data-sign]')) {
    b.addEventListener('click', () => document.querySelectorAll('.tm-sign [data-sign]').forEach(x => x.setAttribute('aria-checked', String(x === b))));
  }

  $('timeAdd').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('timeAddError');
    const sign = Number(document.querySelector('.tm-sign [aria-checked="true"]').dataset.sign);
    const minutes = (Number($('timeAddHours').value) || 0) * 60 + (Number($('timeAddMinutes').value) || 0);
    const key = $('timeAddProject').value;
    const note = $('timeAddNote').value.trim();
    const problem = !key ? 'Pick a project.' : !$('timeAddDay').value ? 'Pick a day.' : !minutes && !note ? 'How much time?' : minutes > 24 * 60 ? "That's more than a day." : null;
    err.hidden = !problem;
    err.textContent = problem || '';
    if (problem) return;
    const r = await api.addTime({ key, day: $('timeAddDay').value, minutes: sign * minutes, ...(note ? { note } : {}) });
    if (!r?.ok) { err.hidden = false; err.textContent = r?.error || "Couldn't add that."; return; }
    $('timeAddNote').value = '';
    SB.toast(sign > 0 ? `Added ${dur(minutes * 60)}` : `Took off ${dur(minutes * 60)}`);
    load();
  });

  const exportOpts = () => {
    let only;
    try { only = $('timeOnly').value ? JSON.parse($('timeOnly').value) : null; } catch { only = null; }
    return { range: rangeId, estimates, only };
  };
  async function saved(r, what) {
    if (r?.canceled) return;
    if (!r?.ok) return SB.toast(r?.error || `Couldn't save the ${what}.`);
    SB.toast(`Saved the ${what}`, { action: 'Show file', onAction: () => api.showTimeFile(r.file) });
  }
  $('timePdf').addEventListener('click', async e => {
    e.target.disabled = true;
    try { await saved(await api.exportTimePdf(exportOpts()), 'timesheet'); } finally { e.target.disabled = false; }
  });
  $('timeCsv').addEventListener('click', async () => saved(await api.exportTimeCsv(exportOpts()), 'spreadsheet'));
  $('timeCopy').addEventListener('click', async () => {
    const r = await api.copyTime(exportOpts());
    SB.toast(r?.ok ? 'Copied. Paste it into an invoice or an email' : r?.error || "Couldn't copy that.");
  });

  api.onTimeNow(now => {
    if (view) view.now = now;
    if (state.view === 'time') renderNow(now);
  });

  SB.views.time = { render: () => { load(); scheduleRefresh(); } };
})();
