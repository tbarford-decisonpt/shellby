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

  // The pure part (durations, money, days, form checks) lives in shared/time-format.js.
  const F = window.ShellbyTimeFormat;
  const { dur, decimal, money, dateOf } = F;
  const shortDay = day => dateOf(day).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const today = () => F.dayKey();
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
      const label = F.chartLabel(d.day, many);
      const words = `${shortDay(d.day)}: ${d.seconds ? dur(d.seconds) : 'nothing'}`;
      return h('li', { class: `tm-bar${d.seconds ? '' : ' zero'}${d.day === today() ? ' today' : ''}`, title: words, 'aria-label': words },
        h('span', { class: 'tm-bar-value', text: d === peak && d.seconds && !many ? dur(d.seconds) : '' }),
        h('span', { class: 'tm-bar-track' }, h('i', { style: `height:${F.barPercent(d.seconds, max, 4)}%` })),
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
      syncPick(p),
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
    const parts = F.dayParts(r);
    const commitsTip = F.commitsTip(r);
    return h('li', { class: `tm-day${r.total ? '' : ' empty'}${r.estimated ? ' est' : ''}` },
      h('span', { class: 'tm-day-date', text: shortDay(r.day) }),
      h('span', { class: 'tm-day-hours' }, h('b', { text: r.total ? dur(r.total) : '—' }), h('small', { text: parts.join(' · ') })),
      r.commitCount ? h('span', { class: 'tm-commits', title: commitsTip, tabindex: '0', 'aria-label': `${F.plural(r.commitCount, 'commit')}: ${r.commits.map(c => c.subject).join('; ')}` }, F.plural(r.commitCount, 'commit')) : h('span'),
      note,
      h('span', { class: 'tm-nudge' },
        h('button', { type: 'button', class: 'icon-btn', title: 'Take 15 minutes off', 'aria-label': `Take 15 minutes off ${shortDay(r.day)}`, disabled: !r.total || r.estimated, onclick: () => nudge(-15) }, '−'),
        h('button', { type: 'button', class: 'icon-btn', title: 'Add 15 minutes', 'aria-label': `Add 15 minutes to ${shortDay(r.day)}`, onclick: () => nudge(15) }, '+')));
  }

  function projectRow(p, max, sum) {
    const pay = F.payLabel(p, sum.currency);
    const details = h('details', { class: 'tm-project', open: open.has(p.key) },
      h('summary', {},
        h('span', { class: 'tm-p-name' }, h('b', { text: p.name }), p.client ? h('small', { text: p.client }) : null),
        h('span', { class: 'tm-p-hours' }, h('b', { text: p.seconds ? dur(p.seconds) : '—' }), h('small', { text: [p.billed && p.billed !== p.seconds ? `${decimal(p.billed)} h billed` : '', pay].filter(Boolean).join(' · ') })),
        h('span', { class: 'tm-p-bar', 'aria-hidden': 'true' }, h('i', { style: `width:${F.barPercent(p.seconds, max, 2)}%` }))),
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
    const rounds = F.roundValues(view.choices.round, view.choices.roundModes);
    setOptions($('timeRound'), rounds, F.roundLabel, s.roundMinutes ? `${s.roundMinutes}|${s.roundMode}` : '0|nearest');
    if (document.activeElement !== $('timeCurrency')) $('timeCurrency').value = s.currency;
    // Projects you said not to track, with the way back.
    const ignored = view.projects.filter(p => p.ignored);
    $('timeIgnored').hidden = !ignored.length;
    $('timeIgnored').replaceChildren('Not tracked: ', ...ignored.flatMap((p, i) => [i ? ', ' : '', p.name, ' ',
      h('button', { type: 'button', class: 'link-btn', text: 'track again', 'aria-label': `Track ${p.name} again`,
        onclick: () => api.setTimeProject(p.key, { ignored: false }).then(load) })]));
  }

  // ------------------------------------------------------------------ sending to a tracker
  //
  // One link until you connect Toggl, Clockify or Harvest; then a day picker
  // and a Send button here, and a "Goes to" pick in each project's details.

  let syncForm = false;     // the connect form is open
  let syncList = null;      // { ok, options, links } or { ok: false, error }, once per visit
  let syncLoading = false;
  let syncDay = null;
  const trackerName = () => view.sync.providers.find(p => p.id === view.sync.provider)?.name || 'your tracker';
  const optionLabel = o => [o.client, o.name, o.task].filter(Boolean).join(' · ');

  function loadSyncList(fresh = false) {
    if (syncLoading) return;
    syncLoading = true;
    api.timeSyncProjects({ fresh }).then(r => { syncList = r; }, () => { syncList = { ok: false, error: 'something went wrong' }; }).finally(() => { syncLoading = false; render(); });
  }

  // The tracker project this one's hours go to, in its details.
  function syncPick(p) {
    if (!view.sync.provider || !syncList?.ok) return null;
    const link = syncList.links[p.key];
    const sel = h('select', { class: 'field', 'aria-label': `Where ${p.name}'s hours go in ${trackerName()}` },
      h('option', { value: '', text: 'Not matched: not sent' }),
      ...syncList.options.map(o => h('option', { value: o.id, text: optionLabel(o) })));
    sel.value = link?.id || '';
    sel.addEventListener('change', async () => {
      const r = await api.linkTimeSync(p.key, sel.value || null);
      if (!r?.ok) return SB.toast(r?.error || "Couldn't save that.");
      loadSyncList();
    });
    return h('label', { class: 'field-label' },
      `Goes to in ${trackerName()}`, link?.guessed ? h('span', { class: 'field-hint', text: ' (matched for you)' }) : null, sel);
  }

  function renderSync() {
    const s = view.sync;
    const el = $('timeSync');
    $('timePrivacy').textContent = s.provider
      ? `Hours are kept on this PC. They go to ${trackerName()} only when you send a day.`
      : 'Hours are kept only on this PC, never synced or sent anywhere.';
    if (!s.provider && !syncForm) {
      el.replaceChildren(h('p', { class: 'muted small' },
        h('button', { type: 'button', class: 'link-btn', text: 'Send hours to Toggl, Clockify or Harvest…', onclick: () => { syncForm = true; renderSync(); $('timeSyncToken').focus(); } })));
      return;
    }
    if (!s.provider) {
      const provider = h('select', { class: 'field slim', 'aria-label': 'Time tracker' }, ...s.providers.map(p => h('option', { value: p.id, text: p.name })));
      const where = h('p', { class: 'muted small', text: s.providers[0].where });
      provider.addEventListener('change', () => { where.textContent = s.providers.find(p => p.id === provider.value).where; });
      const token = h('input', { type: 'password', class: 'field slim', id: 'timeSyncToken', spellcheck: 'false', autocomplete: 'off', placeholder: 'API token', 'aria-label': 'API token' });
      const err = h('p', { class: 'form-errors', role: 'alert', hidden: true });
      const connect = h('button', { type: 'submit', class: 'btn primary slim-btn', text: 'Connect' });
      const form = h('form', { class: 'tm-sync', novalidate: true },
        h('div', { class: 'row wrap' }, provider, token, connect,
          h('button', { type: 'button', class: 'btn ghost slim-btn', text: 'Cancel', onclick: () => { syncForm = false; renderSync(); } })),
        where, err,
        h('p', { class: 'muted small', text: 'The token stays on this PC, encrypted by Windows. Shellby only sends the days you send.' }));
      form.addEventListener('submit', async e => {
        e.preventDefault();
        connect.disabled = true;
        const r = await api.connectTimeSync(provider.value, token.value);
        connect.disabled = false;
        if (!r?.ok) { err.hidden = false; err.textContent = r?.error || "Couldn't connect."; return; }
        syncForm = false;
        syncList = null;
        SB.toast(`Connected to ${s.providers.find(p => p.id === provider.value).name}`);
        load();
      });
      el.replaceChildren(form);
      return;
    }
    const name = trackerName();
    const day = h('input', { type: 'date', class: 'field slim', max: today(), value: syncDay || today(), 'aria-label': 'Which day to send' });
    const again = () => s.sentDays.includes(day.value);
    const send = h('button', { type: 'button', class: 'btn slim-btn', text: again() ? `Update in ${name}` : `Send to ${name}` });
    day.addEventListener('change', () => { syncDay = day.value; send.textContent = again() ? `Update in ${name}` : `Send to ${name}`; });
    send.addEventListener('click', async () => {
      send.disabled = true;
      try {
        const r = await api.sendTimeSync(day.value);
        const left = r?.unmatched?.length ? ` Not matched yet: ${r.unmatched.join(', ')}.` : '';
        if (r?.sent) SB.toast(`Sent ${r.sent === 1 ? '1 entry' : `${r.sent} entries`} to ${r.tracker}, ${r.hours.toFixed(2)} h.${r.error ? ` ${r.of - r.sent} didn't go: ${r.error}` : ''}${left}`);
        else SB.toast(`${r?.error || "Couldn't send that day."}${left}`);
      } finally { send.disabled = false; }
      load();
    });
    let armed = false;
    const off = h('button', { type: 'button', class: 'link-btn', text: 'disconnect' });
    off.addEventListener('click', async () => {
      if (!armed) { armed = true; off.textContent = 'sure? disconnect'; setTimeout(() => { armed = false; off.textContent = 'disconnect'; }, 4000); return; }
      await api.disconnectTimeSync();
      syncList = null;
      SB.toast(`Disconnected from ${name}. Nothing there was changed.`);
      load();
    });
    el.replaceChildren(
      h('div', { class: 'row wrap' }, day, send),
      h('p', { class: 'muted small' },
        `${name}${s.account ? ` (${s.account})` : ''}: each project's billed hours for that day, one entry each. Pick where a project goes in its details above; sending a day again updates it. `, off),
      syncList && !syncList.ok ? h('p', { class: 'muted small', text: `Couldn't load your ${name} projects: ${syncList.error}` }) : null);
  }

  function render() {
    if (!view) return;
    if (view.sync.provider && !syncList) loadSyncList();
    const on = view.settings.enabled;
    $('timeToggle').checked = on;
    $('timeIntro').hidden = on || view.summary.projects.length > 0;
    renderNow(view.now);
    renderRanges();
    renderTotals(view.summary);
    renderChart(view.summary);
    renderProjects(view.summary);
    renderExport(view.summary);
    renderSync();
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
    const cur = F.currencyCode(e.target.value);
    if (!cur) { SB.toast('A currency is three letters, like USD or EUR.'); e.target.value = view.settings.currency; return; }
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
    const problem = F.addTimeProblem({ key, day: $('timeAddDay').value, minutes, note });
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

  SB.views.time = { render: () => { syncList = null; load(); scheduleRefresh(); } };
})();
