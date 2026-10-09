/* Shellby panel — the Council, a tab of Shellby's screen: advisor crabs sat
   round a table who each argue one angle of a question, and Shellby in the
   chair at its head who weighs them. Main runs the calls (src/main/council/)
   and tells us as each seat starts and finishes ('council:progress'), so the
   table lights up seat by seat. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const VOTE_MARK = { for: '✓', against: '✗', conditional: '~' };
  const VOTE_WORD = { for: 'For', against: 'Against', conditional: 'Depends' };
  const MODE_SEAT_NOTE = { quick: 'one answer for the whole table', full: 'each advisor on their own', debate: 'each on their own, then a rebuttal round' };
  // Where seats sit, as angles round the table (degrees, 90 is the head).
  // The head is Shellby's; advisors fill each side from the head outwards, and
  // the near side stays open so the table faces you.
  const HEAD = 90, ARC_NEAR = 66, ARC_FAR = -30;
  const SEAT_RING = { rx: 42, ry: 34 }, PLAQUE_RING = { rx: 31, ry: 20 }, CENTRE = { x: 50, y: 60 };
  const ROLL_MS = 2600; // how long each advisor holds the floor in the roll call after a sitting

  let view = null;     // main's council:view
  let session = null;  // the session on the table, live or from the minutes
  let live = null;     // { status: { seatId: 'thinking' | 'spoke' }, opinions } while it sits
  let followUp = null; // the session a follow-up builds on
  let focusSeat = null;
  let speaking = null; // the seat with the floor: the last to answer, or the roll call's
  let rollTimer = null;

  // ------------------------------------------------------------ seats

  const allSeats = () => [...(view?.defaults || []), ...(view?.settings.custom || [])];
  const seated = () => (view ? view.settings.seated.map(id => allSeats().find(s => s.id === id)).filter(Boolean) : []);
  const tableSeats = () => session?.seats || seated();

  function angles(n) {
    const left = Math.ceil(n / 2), right = n - left;
    const spread = (count, from, to) => Array.from({ length: count }, (_, i) => from + ((to - from) * (i + 0.5)) / count);
    // Alternate sides so seat order reads left, right, left... from the head down.
    const l = spread(left, 180 - ARC_NEAR, 180 - ARC_FAR), r = spread(right, ARC_NEAR, ARC_FAR);
    return Array.from({ length: n }, (_, i) => (i % 2 ? r[i >> 1] : l[i >> 1]));
  }

  function at(ring, deg) {
    const a = (deg * Math.PI) / 180;
    return { x: CENTRE.x + ring.rx * Math.cos(a), y: CENTRE.y - ring.ry * Math.sin(a), depth: Math.sin(a) };
  }

  function crabFor(seat) {
    if (seat.id === 'chair') return SB.sprite(state.skin);
    const svg = SB.Sprite.build(state.skin, { accessories: state.outfit?.crewAccessories ?? [], fit: true });
    svg.style.filter = `hue-rotate(${SB.HUES[seat.hue % SB.HUES.length]}deg) saturate(1.1)`;
    return svg;
  }

  // ------------------------------------------------------------ the table

  function renderTable() {
    const seats = tableSeats();
    const crabs = $('ccCrabs'), ui = $('ccSeats');
    crabs.replaceChildren();
    ui.replaceChildren();
    if (!state.skin) return;
    const placed = [{ seat: { id: 'chair', name: 'Shellby', hue: 0 }, deg: HEAD }, ...seats.map((seat, i) => ({ seat, deg: angles(seats.length)[i] }))];
    for (const { seat, deg } of placed) {
      const p = at(SEAT_RING, deg), q = at(PLAQUE_RING, deg);
      // Further back is smaller and lower in the stack: the table hides their legs.
      const scale = (seat.id === 'chair' ? 1.22 : 1) * (1 - 0.16 * p.depth);
      const vars = `--x:${p.x}%;--y:${p.y}%;--s:${scale.toFixed(3)};--z:${Math.round(10 - p.depth * 5)}`;
      crabs.append(h('div', { class: `cc-crab${seat.id === 'chair' ? ' is-chair' : ''}`, style: vars, dataset: { seat: seat.id } },
        seat.id === 'chair' ? h('i', { class: 'cc-throne' }) : null,
        h('span', { class: 'cc-crab-sprite' }, crabFor(seat))));
      ui.append(seatUi(seat, vars, `--px:${q.x}%;--py:${q.y}%`));
    }
    paintStates();
  }

  function seatUi(seat, vars, plaqueVars) {
    const name = seat.id === 'chair' ? 'Shellby, in the chair' : seat.name;
    return h('div', { class: 'cc-seat', role: 'listitem', style: `${vars};${plaqueVars}`, dataset: { seat: seat.id } },
      h('button', { type: 'button', class: 'cc-hit', 'aria-label': name, onclick: () => pickSeat(seat.id) }),
      h('div', { class: 'cc-bubble', 'aria-hidden': 'true' }),
      h('div', { class: 'cc-place' },
        h('i', { class: 'cc-lamp' }),
        h('span', { class: 'cc-plaque' }, seat.id === 'chair' ? 'Chair' : seat.name),
        h('span', { class: 'cc-vote' })));
  }

  // Thinking, spoken and voted, seat by seat: from the live run or the minutes.
  function paintStates() {
    const opinions = live?.opinions || session?.opinions || {};
    const rebuttals = session?.rebuttals || {};
    for (const el of document.querySelectorAll('#ccSeats .cc-seat')) {
      const id = el.dataset.seat;
      const status = live?.status[id] || (id === 'chair' ? (session?.chair ? 'spoke' : '') : opinions[id] ? 'spoke' : session ? 'silent' : '');
      el.dataset.state = status;
      document.querySelector(`#ccCrabs [data-seat="${id}"]`)?.setAttribute('data-state', status);
      el.classList.toggle('is-focus', focusSeat === id);
      el.classList.toggle('is-speaking', speaking === id && focusSeat === null);
      document.querySelector(`#ccCrabs [data-seat="${id}"]`)?.classList.toggle('is-speaking', speaking === id && focusSeat === null);
      const bubble = el.querySelector('.cc-bubble'), vote = el.querySelector('.cc-vote');
      if (id === 'chair') {
        bubble.textContent = status === 'thinking' ? '…' : '';
        vote.textContent = '';
        continue;
      }
      const o = opinions[id];
      const v = rebuttals[id]?.vote || o?.vote;
      bubble.textContent = status === 'thinking' ? '…' : o?.stance || (status === 'silent' ? '(no answer)' : '');
      vote.textContent = v ? VOTE_MARK[v] : '';
      vote.dataset.vote = v || '';
      vote.title = v ? VOTE_WORD[v] : '';
    }
    renderScroll();
  }

  function renderScroll() {
    const text = $('ccScrollText'), tally = $('ccTally'), scroll = $('ccScroll');
    tally.replaceChildren();
    scroll.disabled = !session?.chair;
    if (live) { text.textContent = live.debating ? 'The council is arguing it out…' : live.status.chair === 'thinking' ? 'Shellby is weighing it up…' : 'The council is thinking…'; return; }
    if (!session) { text.textContent = followUp ? 'Ask a follow-up: the council remembers its last verdict.' : 'The council is waiting for a question.'; return; }
    text.textContent = session.chair?.verdict || 'The chair couldn’t reach a verdict. The advisors’ answers are below.';
    for (const v of ['for', 'conditional', 'against']) {
      const n = session.tally?.[v] || 0;
      if (n) tally.append(h('span', { class: 'cc-pip', dataset: { vote: v }, title: `${n} ${VOTE_WORD[v].toLowerCase()}` }, `${VOTE_MARK[v]} ${n}`));
    }
  }

  // After a sitting, each advisor holds the floor in turn, then the chair; once.
  function rollCall() {
    clearTimeout(rollTimer);
    speaking = null;
    if (!session || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const order = [...session.seats.filter(s => session.opinions?.[s.id]).map(s => s.id), 'chair'];
    const step = i => {
      speaking = order[i] ?? null;
      if (SB.state.view === 'council') paintStates();
      if (speaking) rollTimer = setTimeout(() => step(i + 1), ROLL_MS);
    };
    step(0);
  }

  function pickSeat(id) {
    clearTimeout(rollTimer);
    speaking = null;
    focusSeat = focusSeat === id ? null : id;
    paintStates();
    const row = id === 'chair' ? $('ccVerdict') : document.querySelector(`#ccOpinions [data-seat="${id}"]`);
    if (row && !$('ccMinutes').hidden) {
      row.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      row.classList.remove('is-flash');
      void row.offsetWidth;
      row.classList.add('is-flash');
    }
  }

  // ------------------------------------------------------------ the minutes

  function renderMinutes() {
    const box = $('ccMinutes');
    box.hidden = !session;
    if (!session) return;
    const c = session.chair;
    const list = (title, items) => (items?.length ? h('div', { class: 'cc-list' }, h('h4', { text: title }), h('ul', {}, items.map(t => h('li', { text: t })))) : null);
    $('ccVerdict').replaceChildren(
      h('header', {},
        h('p', { class: 'cc-eyebrow', text: `${session.question}` }),
        h('h3', { text: c ? c.verdict : 'No verdict this time' }),
        c ? meter(c.confidence, 'Chair’s confidence') : null),
      c ? h('div', { class: 'cc-lists' }, list('They agree', c.agree), list('They split', c.split), list('Next steps', c.next)) : null,
      h('div', { class: 'cc-actions' },
        c ? h('button', { type: 'button', class: 'btn primary', onclick: sendToChat }, 'Send to chat') : null,
        h('button', { type: 'button', class: 'btn', onclick: copyMinutes }, 'Copy minutes'),
        c ? h('button', { type: 'button', class: 'btn ghost', onclick: startFollowUp }, 'Ask a follow-up') : null,
        h('span', { class: 'muted small cc-cost', text: costLine(session) })));
    const seats = session.seats || [];
    $('ccOpinions').replaceChildren(...seats.map(s => opinionRow(s, session.opinions?.[s.id], session.rebuttals?.[s.id])));
  }

  function opinionRow(seat, o, r) {
    const icon = h('span', { class: 'cc-row-crab', 'aria-hidden': 'true' }, state.skin ? crabFor(seat) : null);
    if (!o) return h('li', { class: 'cc-row is-silent', dataset: { seat: seat.id } }, icon, h('div', {}, h('h4', { text: seat.name }), h('p', { class: 'muted small', text: 'Didn’t answer this time.' })));
    return h('li', { class: 'cc-row', dataset: { seat: seat.id } }, icon,
      h('div', { class: 'cc-row-body' },
        h('div', { class: 'cc-row-head' },
          h('h4', { text: seat.name }),
          h('span', { class: 'cc-chip', dataset: { vote: r?.vote || o.vote } }, `${VOTE_MARK[r?.vote || o.vote]} ${VOTE_WORD[r?.vote || o.vote]}`),
          meter(o.confidence, `${seat.name}’s confidence`)),
        h('p', { class: 'cc-stance', text: o.stance }),
        o.argument ? h('p', { class: 'cc-argument', text: o.argument }) : null,
        o.risks.length ? h('ul', { class: 'cc-risks', 'aria-label': 'Risks' }, o.risks.map(t => h('li', { text: t }))) : null,
        r ? h('p', { class: 'cc-rebuttal' }, h('b', { text: 'After hearing the others: ' }), r.reply) : null));
  }

  function meter(n, label) {
    return h('span', { class: 'cc-meter', role: 'meter', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(n), title: `${label}: ${n}%` },
      h('i', { style: `--v:${n}%` }), h('b', { text: `${n}%` }));
  }

  const costLine = s => {
    const calls = `${s.calls} call${s.calls === 1 ? '' : 's'}`;
    return s.cost ? `${calls} · $${s.cost.toFixed(s.cost < 0.01 ? 4 : 3)} of your plan` : calls;
  };

  function minutesText(s) {
    const lines = [`Council: ${s.question}`, ''];
    if (s.chair) {
      lines.push(`Verdict (${s.chair.confidence}%): ${s.chair.verdict}`);
      for (const [t, items] of [['Agree', s.chair.agree], ['Split', s.chair.split], ['Next', s.chair.next]]) if (items.length) lines.push(`${t}:`, ...items.map(x => `- ${x}`));
      lines.push('');
    }
    for (const seat of s.seats) {
      const o = s.opinions[seat.id];
      if (o) lines.push(`${seat.name} [${o.vote}, ${o.confidence}%]: ${o.stance}`, `  ${o.argument}`);
    }
    return lines.join('\n');
  }

  function sendToChat() {
    const c = session?.chair;
    if (!c) return;
    const next = c.next.length ? `\n\nNext steps the council suggested:\n${c.next.map(x => `- ${x}`).join('\n')}` : '';
    SB.setView('chat');
    SB.prefill(`The council's verdict on "${session.question}": ${c.verdict}${next}`);
  }

  async function copyMinutes() {
    try { await navigator.clipboard.writeText(minutesText(session)); SB.toast('Minutes copied.'); } catch { SB.toast('Couldn’t copy: another app is holding the clipboard.'); }
  }

  function startFollowUp() {
    followUp = session.id;
    $('ccQuestion').value = '';
    $('ccQuestion').placeholder = `A follow-up on “${session.question.slice(0, 60)}”`;
    $('ccQuestion').focus();
    renderScroll();
  }

  function clearFollowUp() {
    followUp = null;
    $('ccQuestion').placeholder = 'Put another decision to the council.';
  }

  // ------------------------------------------------------------ asking

  function renderModes() {
    const mode = view?.settings.mode || 'quick';
    for (const b of document.querySelectorAll('#ccModes [data-mode]')) b.setAttribute('aria-checked', String(b.dataset.mode === mode));
    const n = seated().length;
    const calls = mode === 'quick' ? 1 : n + 1 + (mode === 'debate' ? 1 : 0);
    $('ccHint').textContent = `${n} advisors, ${MODE_SEAT_NOTE[mode]} · ${calls} call${calls === 1 ? '' : 's'}`;
  }

  // One save at a time, each on top of the last, so quick clicks never undo each other.
  let saving = Promise.resolve();
  function save(patch) {
    if (live) return saving;
    saving = saving.then(async () => {
      view = await api.saveCouncil({ ...view.settings, ...patch });
      renderModes();
      renderSeatEditor();
      if (!session) renderTable();
    }).catch(() => SB.toast('Couldn’t save the council’s seats. Try again.'));
    return saving;
  }

  // While the council sits, who sits and how can't change under it.
  function lock(on) {
    $('ccConvene').disabled = on;
    for (const el of document.querySelectorAll('#ccModes button, #ccSeatList input, #ccSeatList button, #ccCustomForm button')) el.disabled = on;
  }

  async function convene(e) {
    e.preventDefault();
    const question = $('ccQuestion').value.trim();
    if (!question || live) return;
    const before = session;
    clearTimeout(rollTimer);
    session = null;
    focusSeat = null;
    speaking = null;
    live = { status: {}, opinions: {} };
    lock(true);
    $('ccMinutes').hidden = true;
    renderTable();
    let r;
    try {
      r = await api.convene({ question, mode: view.settings.mode, project: $('ccProject').checked, followUp });
    } catch {
      r = { ok: false, error: 'The council couldn’t sit. Try again.' };
    }
    live = null;
    lock(false);
    if (!$('ccSeatsEditor').hidden) renderSeatEditor();
    if (!r.ok) {
      SB.toast(r.error);
      session = before; // the last sitting stays on the table
      renderTable();
      renderMinutes();
      return;
    }
    session = r.session;
    clearFollowUp();
    rollCall();
    $('ccQuestion').value = '';
    renderTable();
    renderMinutes();
    if (!$('ccHistory').hidden) renderHistory();
  }

  function onProgress(ev) {
    if (!live || !ev) return;
    if (ev.kind === 'thinking') live.status[ev.seat] = 'thinking';
    if (ev.kind === 'spoke') { live.status[ev.seat] = ev.opinion ? 'spoke' : 'silent'; live.opinions[ev.seat] = ev.opinion; if (ev.opinion) speaking = ev.seat; }
    if (ev.kind === 'debating') live.debating = true;
    if (ev.kind === 'rebutted') live.debating = false;
    if (SB.state.view === 'council') paintStates();
  }

  // ------------------------------------------------------------ seats and history drawers

  function toggleDrawer(btn, drawer, fill) {
    const open = drawer.hidden;
    drawer.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) fill();
  }

  function renderSeatEditor() {
    if (!view) return;
    const { seated: on, custom } = view.settings, { seated: max, min, custom: maxCustom } = view.limits;
    $('ccSeatsNote').textContent = `Seat ${min} to ${max} advisors. More seats cost more in Full and Debate, not in Quick.`;
    $('ccSeatList').replaceChildren(...allSeats().map(s => {
      const isOn = on.includes(s.id);
      const box = h('input', { type: 'checkbox', checked: isOn, disabled: (isOn && on.length <= min) || (!isOn && on.length >= max) });
      box.addEventListener('change', () => save({ seated: box.checked ? [...on, s.id] : on.filter(x => x !== s.id) }));
      return h('li', { class: 'cc-seat-item' },
        h('span', { class: 'cc-row-crab', 'aria-hidden': 'true' }, state.skin ? crabFor(s) : null),
        h('label', {}, box, h('b', { text: s.name }), h('span', { class: 'muted small', text: s.brief })),
        s.custom ? h('button', { type: 'button', class: 'btn ghost slim-btn', 'aria-label': `Remove ${s.name}`, onclick: () => save({ custom: custom.filter(c => c.id !== s.id), seated: on.filter(x => x !== s.id) }) }, 'Remove') : null);
    }));
    $('ccCustomForm').hidden = custom.length >= maxCustom;
  }

  function addCustom(e) {
    e.preventDefault();
    const name = $('ccCustomName').value.trim(), brief = $('ccCustomBrief').value.trim();
    if (!name || !brief) { SB.toast('Give the advisor a name and what they argue for.'); return; }
    const id = `c-${Math.random().toString(36).slice(2, 10)}`;
    const hue = (view.settings.custom.length + 5) % SB.HUES.length;
    const { seated: on, custom } = view.settings;
    $('ccCustomName').value = '';
    $('ccCustomBrief').value = '';
    save({ custom: [...custom, { id, name, brief, hue }], seated: on.length < view.limits.seated ? [...on, id] : on });
  }

  async function renderHistory() {
    const list = await api.councilHistory();
    const ul = $('ccHistoryList');
    if (!list.length) { ul.replaceChildren(h('li', { class: 'muted small', text: 'No sessions yet. Each one you convene is kept here, free to read again.' })); return; }
    ul.replaceChildren(...list.map(s => h('li', { class: 'cc-history-item' },
      h('button', { type: 'button', class: 'cc-history-open', onclick: () => openSession(s.id) },
        h('b', { text: s.question }),
        h('span', { class: 'muted small', text: `${SB.relTime(s.at)} · ${s.mode}${s.verdict ? ` · ${s.verdict}` : ''}` })),
      h('button', { type: 'button', class: 'btn ghost slim-btn', 'aria-label': 'Forget this session', onclick: async () => { await api.forgetCouncil(s.id); if (followUp === s.id) clearFollowUp(); renderHistory(); } }, '✕'))));
  }

  async function openSession(id) {
    if (live) return;
    const s = await api.councilSession(id);
    if (!s) { SB.toast('That session has gone.'); renderHistory(); return; }
    session = s;
    focusSeat = null;
    clearFollowUp();
    rollCall();
    renderTable();
    renderMinutes();
  }

  // ------------------------------------------------------------ the view

  async function render() {
    if (!view) view = await api.councilView();
    renderModes();
    renderTable();
    renderMinutes();
    if (!$('ccSeatsEditor').hidden) renderSeatEditor();
  }

  $('ccAsk').addEventListener('submit', convene);
  $('ccQuestion').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('ccAsk').requestSubmit(); });
  $('ccModes').addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if (b && view) save({ mode: b.dataset.mode }); });
  $('ccScroll').addEventListener('click', () => pickSeat('chair'));
  $('ccSeatsBtn').addEventListener('click', () => toggleDrawer($('ccSeatsBtn'), $('ccSeatsEditor'), renderSeatEditor));
  $('ccHistoryBtn').addEventListener('click', () => toggleDrawer($('ccHistoryBtn'), $('ccHistory'), renderHistory));
  $('ccCustomForm').addEventListener('submit', addCustom);
  api.onCouncilProgress(onProgress);

  SB.views.council = { render };
})();
