/* Shellby panel — a project's standup ("Yesterday / Today / Blockers") and its
   weekly report, on the project's page (projects.js), ready to paste into
   Slack or an email. Main builds the words from your commits, conversations
   and tracked time (src/main/projects/standup.js); this shows them and copies
   them. Nothing is sent anywhere: Copy puts it on the clipboard, that's all. */
'use strict';
(function () {
  const { h, api } = SB;

  const KINDS = [['standup', 'Standup'], ['week', 'This week'], ['last-week', 'Last week']];
  const FORMATS = [['slack', 'Slack'], ['text', 'Email']];
  const PREF = { kind: 'shellby.pj.reportKind', format: 'shellby.pj.reportFormat' };
  const FRESH_MS = 60 * 1000; // the page redraws often; git is read again after this

  // `${key}|${kind}` -> { at, r }, and the reads under way, so a redraw doesn't read git again.
  const cache = new Map();
  const reading = new Map();
  let seq = 0;

  const pick = (v, list, fallback) => (list.some(([id]) => id === v) ? v : fallback);

  function read(key, kind, force) {
    const id = `${key}|${kind}`;
    const hit = cache.get(id);
    if (hit && !force && Date.now() - hit.at < FRESH_MS) return Promise.resolve(hit.r);
    if (reading.has(id)) return reading.get(id);
    const p = Promise.resolve().then(() => api.projectReport({ key, kind })).catch(() => null)
      .then(r => { cache.set(id, { at: Date.now(), r }); return r; })
      .finally(() => reading.delete(id));
    reading.set(id, p);
    return p;
  }

  // A row of radio buttons that look like a segmented control.
  function seg(label, options, value, onPick) {
    const name = `pjrep-${++seq}`;
    return h('div', { class: 'seg pj-seg', role: 'radiogroup', 'aria-label': label },
      options.map(([v, text]) => h('label', {},
        h('input', { type: 'radio', name, value: v, checked: v === value, onchange: () => onPick(v) }),
        h('span', { text }))));
  }

  /** The card: Standup | This week | Last week, Slack | Email, the words, and Copy. */
  function card(p) {
    let kind = pick(SB.pref(PREF.kind), KINDS, 'standup');
    let format = pick(SB.pref(PREF.format), FORMATS, 'slack');
    const out = h('pre', { class: 'pj-report', tabindex: '0', 'aria-label': 'The report, as it will be copied' });
    const status = h('p', { class: 'muted small pj-report-status', role: 'status' });
    const copy = h('button', { type: 'button', class: 'btn primary slim-btn', text: 'Copy', disabled: true, onclick: () => {
      const r = cache.get(`${p.key}|${kind}`)?.r;
      if (!r?.ok) return;
      api.copyText(r[format]);
      SB.toast(format === 'slack' ? 'Copied. Paste it into Slack.' : 'Copied. Paste it into your email.', { ms: 2500 });
    } });
    const again = h('button', { type: 'button', class: 'btn ghost slim-btn', text: 'Refresh', onclick: () => load(true) });

    function paint(r) {
      const ok = !!r?.ok;
      out.textContent = ok ? r[format] : '';
      out.hidden = !ok;
      copy.disabled = !ok;
      status.textContent = ok ? '' : "Couldn't put it together. Try Refresh.";
      status.hidden = ok;
    }
    async function load(force = false) {
      const want = kind;
      const hit = cache.get(`${p.key}|${want}`);
      if (hit) paint(hit.r);
      else { out.hidden = true; copy.disabled = true; status.hidden = false; status.textContent = 'Putting it together…'; }
      const r = await read(p.key, want, force);
      if (want === kind && out.isConnected) paint(r);
    }

    const body = h('section', { class: 'pj-panel pj-report-card', 'aria-label': 'Standup and weekly report' },
      h('p', { class: 'row-label', text: 'Standup & weekly report' }),
      h('p', { class: 'muted small', text: 'From your commits, your conversations with Claude and the time tracked here, ready to paste.' }),
      h('div', { class: 'row wrap pj-report-pick' },
        seg('Which report', KINDS, kind, v => { kind = v; SB.pref.set(PREF.kind, v); load(); }),
        seg('Words for', FORMATS, format, v => {
          format = v;
          SB.pref.set(PREF.format, v);
          const hit = cache.get(`${p.key}|${kind}`);
          if (hit) paint(hit.r); // still reading: load() paints it in the new words
        })),
      status, out,
      h('div', { class: 'row wrap' }, copy, again));
    load();
    return body;
  }

  SB.pjReport = { card };
})();
