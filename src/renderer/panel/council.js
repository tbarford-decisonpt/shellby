/* Shellby panel — the Council, a tab of Shellby's screen: advisor crabs sat
   round a table who each argue one angle of a question, and Shellby in the
   chair at its head who weighs them. Before they sit he can read the project
   and lay what he found on the table as numbered cards, and pick who sits.
   Main runs the calls (src/main/council/) and tells us as the read, the
   seating and each seat start and finish ('council:progress'), so the table
   lights up step by step. The minutes are drawn by council-minutes.js. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const M = SB.councilMinutes;
  const MODE_SEAT_NOTE = { quick: 'one answer for the whole table', debate: 'each on their own, then they answer each other' };
  // Where seats sit, as angles round the table (degrees, 90 is the head).
  // The head is Shellby's; advisors fill each side from the head outwards, and
  // the near side stays open so the table faces you.
  const HEAD = 90, ARC_NEAR = 66, ARC_FAR = -30;
  const SEAT_RING = { rx: 42, ry: 34 }, PLAQUE_RING = { rx: 31, ry: 20 }, CENTRE = { x: 50, y: 60 };
  const ROLL_MS = 2600; // how long each advisor holds the floor in the roll call after a sitting

  let view = null;     // main's council:view
  let session = null;  // the session on the table, live or from the minutes
  let live = null;     // { phase, status: { seatId: 'thinking' | 'spoke' }, opinions, facts, seats } while it sits
  let followUp = null; // the session a follow-up builds on
  let focusSeat = null;
  let speaking = null; // the seat with the floor: the last to answer, or the roll call's
  let litFact = null;  // a fact card lit from the minutes
  let rollTimer = null;

  // ------------------------------------------------------------ seats

  const allSeats = () => [...(view?.roster || []), ...(view?.settings.custom || [])];
  const seated = () => (view ? view.settings.seated.map(id => allSeats().find(s => s.id === id)).filter(Boolean) : []);
  const tableSeats = () => live?.seats || session?.seats || seated();
  const record = id => view?.records?.[id];

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
        h('span', { class: 'cc-crab-sprite' }, M.crab(seat))));
      ui.append(seatUi(seat, vars, `--px:${q.x}%;--py:${q.y}%`));
    }
    paintStates();
  }

  function seatUi(seat, vars, plaqueVars) {
    const name = seat.id === 'chair' ? 'Shellby, in the chair' : seat.name;
    const rec = record(seat.id);
    return h('div', { class: 'cc-seat', role: 'listitem', style: `${vars};${plaqueVars}`, dataset: { seat: seat.id } },
      h('button', { type: 'button', class: 'cc-hit', 'aria-label': name, onclick: () => pickSeat(seat.id) }),
      h('div', { class: 'cc-bubble', 'aria-hidden': 'true' }),
      h('div', { class: 'cc-place' },
        h('i', { class: 'cc-lamp' }),
        h('span', { class: 'cc-plaque' }, seat.id === 'chair' ? 'Chair' : seat.name),
        rec?.of ? h('span', { class: 'cc-record', title: `Right ${rec.right} of ${rec.of} times on verdicts you followed` }, `${rec.right}/${rec.of}`) : null,
        h('span', { class: 'cc-vote' })));
  }

  // The fact cards on the felt: what he read, numbered as the advisors cite them.
  function renderDeck() {
    const facts = live?.facts || session?.facts || [];
    $('ccDeck').replaceChildren(...facts.map((f, i) => h('li', { class: 'cc-card', style: `--i:${i};--n:${facts.length}`, dataset: { fact: String(i + 1) }, title: f.claim }, `F${i + 1}`)));
  }

  // The facts the seat with the floor (or the one you picked) leans on.
  function litFacts() {
    const id = focusSeat ?? speaking;
    if (litFact) return [litFact];
    if (!id) return [];
    const opinions = live?.opinions || session?.opinions || {};
    return (id === 'chair' ? session?.chair?.cites : opinions[id]?.cites) || [];
  }

  // Thinking, spoken and voted, seat by seat: from the live run or the minutes.
  function paintStates() {
    const opinions = live?.opinions || session?.opinions || {};
    const rebuttals = session?.rebuttals || {};
    for (const el of document.querySelectorAll('#ccSeats .cc-seat')) {
      const id = el.dataset.seat;
      const status = live?.status[id] || (id === 'chair' ? (session?.chair ? 'spoke' : '') : opinions[id] ? 'spoke' : session ? 'silent' : '');
      const crabEl = document.querySelector(`#ccCrabs [data-seat="${id}"]`);
      el.dataset.state = status;
      crabEl?.setAttribute('data-state', status);
      el.classList.toggle('is-focus', focusSeat === id);
      el.classList.toggle('is-speaking', speaking === id && focusSeat === null);
      crabEl?.classList.toggle('is-speaking', speaking === id && focusSeat === null);
      crabEl?.classList.toggle('is-reading', id === 'chair' && live?.phase === 'reading');
      const bubble = el.querySelector('.cc-bubble'), vote = el.querySelector('.cc-vote');
      if (id === 'chair') {
        bubble.textContent = live?.phase === 'reading' ? '📖' : status === 'thinking' ? '…' : '';
        vote.textContent = '';
        continue;
      }
      const o = opinions[id];
      const v = rebuttals[id]?.vote || o?.vote;
      bubble.textContent = status === 'thinking' ? '…' : o?.stance || (status === 'silent' ? '(no answer)' : '');
      vote.textContent = v ? M.VOTE_MARK[v] : '';
      vote.dataset.vote = v || '';
      vote.dataset.changed = String(!!rebuttals[id]?.changed);
      vote.title = v ? `${M.VOTE_WORD[v]}${rebuttals[id]?.changed ? ', after changing their mind' : ''}` : '';
    }
    const lit = new Set(litFacts().map(String));
    for (const card of document.querySelectorAll('#ccDeck .cc-card')) card.classList.toggle('is-lit', lit.has(card.dataset.fact));
    renderScroll();
  }

  const LIVE_TEXT = {
    reading: () => `Shellby is reading ${live?.project || 'the project'}…`,
    picking: () => 'Shellby is choosing who sits…',
    debating: () => 'The council is arguing it out…',
  };

  function renderScroll() {
    const text = $('ccScrollText'), tally = $('ccTally'), scroll = $('ccScroll'), stamp = $('ccStamp');
    tally.replaceChildren();
    scroll.disabled = !session?.chair;
    stamp.hidden = true;
    $('ccNewBtn').hidden = live !== null || (!session && !followUp);
    if (live) {
      text.textContent = LIVE_TEXT[live.phase]?.() || (live.status.chair === 'thinking' ? 'Shellby is weighing it up…' : 'The council is thinking…');
      return;
    }
    if (!session) { text.textContent = followUp ? 'Ask a follow-up: the council remembers its last verdict.' : 'The council is waiting for a question.'; return; }
    const d = session.chair?.decision;
    if (d) { stamp.hidden = false; stamp.dataset.decision = d; stamp.textContent = M.DECISION_WORD[d]; }
    text.textContent = session.chair?.verdict || 'The chair couldn’t reach a verdict. The advisors’ answers are below.';
    for (const v of ['for', 'conditional', 'against']) {
      const n = session.tally?.[v] || 0;
      if (n) tally.append(h('span', { class: 'cc-pip', dataset: { vote: v }, title: `${n} ${M.VOTE_WORD[v].toLowerCase()}` }, `${M.VOTE_MARK[v]} ${n}`));
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

  const smooth = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
  function flash(row) {
    if (!row) return;
    row.scrollIntoView({ block: 'nearest', behavior: smooth() });
    row.classList.remove('is-flash');
    void row.offsetWidth;
    row.classList.add('is-flash');
  }

  function pickSeat(id) {
    clearTimeout(rollTimer);
    speaking = null;
    litFact = null;
    focusSeat = focusSeat === id ? null : id;
    paintStates();
    if (!$('ccMinutes').hidden) flash(id === 'chair' ? $('ccVerdict') : document.querySelector(`#ccOpinions [data-seat="${id}"]`));
  }

  // A cited fact: lit on the table, and found in What he read.
  function cite(n) {
    clearTimeout(rollTimer);
    speaking = null;
    focusSeat = null;
    litFact = n;
    paintStates();
    flash(document.querySelector(`#ccVerdict [data-fact="${n}"]`));
  }

  // ------------------------------------------------------------ the minutes

  function renderMinutes() {
    const box = $('ccMinutes');
    box.hidden = !session;
    if (!session) return;
    $('ccVerdict').replaceChildren(...M.verdict(session, {
      plan, note, answerOpen, cite, outcome,
      copy: copyMinutes, followUp: startFollowUp,
    }).filter(Boolean));
    $('ccOpinions').replaceChildren(...(session.seats || []).map(s => M.opinionRow(session, s, cite)));
  }

  async function plan() {
    const r = await api.councilPlan(session.id);
    if (r?.needsClaude) return SB.claudeUpsell('council');
    if (!r?.ok) return SB.toast(r?.error || 'Couldn’t open a plan for that.');
    SB.setView('chat');
    SB.toast('The plan is ready in a new conversation. Read it over, then send.');
  }

  async function note() {
    const r = await api.councilNote(session.id);
    if (!r?.ok) return SB.toast(r?.error || 'Couldn’t add that to Notes.');
    SB.toast(`Added to Notes for ${r.list}.`, { action: 'Show', onAction: () => SB.setView('notes') });
  }

  // What's still open: he reads the project for it, and the council sits again on the same question.
  function answerOpen() {
    if (live || !session?.chair?.open?.length) return;
    followUp = session.id;
    sit(session.question, { read: true });
  }

  async function outcome(result) {
    const r = await api.councilOutcome({ id: session.id, result });
    if (!r?.ok) return SB.toast(r?.error || 'Couldn’t save that.');
    view = { ...view, records: r.records };
    // Another sitting may be on the table by now: the answer only replaces its own.
    if (session?.id === r.session.id) session = r.session;
    renderTable();
    renderMinutes();
    if (!$('ccSeatsEditor').hidden) renderSeatEditor();
    if (!$('ccHistory').hidden) renderHistory();
  }

  async function copyMinutes() {
    try { await navigator.clipboard.writeText(M.text(session)); SB.toast('Minutes copied.'); } catch { SB.toast('Couldn’t copy: another app is holding the clipboard.'); }
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

  // Clears the table for a fresh question, with no follow-up on the last one.
  // The old sitting stays in Past sessions.
  function newSession() {
    if (live) return;
    clearTimeout(rollTimer);
    session = null;
    focusSeat = null;
    speaking = null;
    litFact = null;
    clearFollowUp();
    $('ccQuestion').value = '';
    renderTable();
    renderDeck();
    renderMinutes();
    $('ccQuestion').focus();
  }

  // ------------------------------------------------------------ asking

  function renderModes() {
    const s = view?.settings;
    const mode = s?.mode || 'quick';
    for (const b of document.querySelectorAll('#ccModes [data-mode]')) b.setAttribute('aria-checked', String(b.dataset.mode === mode));
    const project = view?.project;
    const read = !!project && !project.blocked && s?.read !== false;
    const box = $('ccProject');
    box.checked = read;
    box.disabled = !project || !!project.blocked;
    $('ccReadText').textContent = project ? `Read ${project.name} first` : 'Read the project first';
    $('ccReadLabel').title = !project ? 'Open a project in the chat first: there’s nothing here for him to read.'
      : project.blocked || `He reads ${project.name} (never changes it) for the facts the question turns on, and every advisor argues from them. One more call, never more than $${view.limits.budget.toFixed(2)}.`;
    const n = seated().length;
    const who = s?.pick ? `${view.limits.pickMin}–${view.limits.pickMax} advisors he picks` : `${n} advisors`;
    const most = s?.pick ? view.limits.pickMax : n;
    const calls = (read || s?.pick ? 1 : 0) + (mode === 'quick' ? 1 : most + 2);
    const cost = M.estimateText(view.estimate);
    $('ccHint').textContent = `${who}, ${MODE_SEAT_NOTE[mode]} · ${s?.pick && mode !== 'quick' ? 'up to ' : ''}${calls} call${calls === 1 ? '' : 's'}${cost ? ` · ${cost}` : ''}`;
    $('ccHint').title = cost ? `${cost} of your plan: a guess from the model’s price and how long answers usually run${read ? `, with the read anywhere up to its $${view.limits.budget.toFixed(2)} cap` : ''}. Each session shows what it really cost.` : '';
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
    for (const el of document.querySelectorAll('#ccModes button, #ccProject, #ccPick, #ccSeatList input, #ccSeatList button, #ccCustomForm button, .cc-actions button')) el.disabled = on;
    if (!on) renderModes();
  }

  function convene(e) {
    e.preventDefault();
    const question = $('ccQuestion').value.trim();
    if (!question || live) return;
    sit(question, { read: $('ccProject').checked });
  }

  async function sit(question, { read }) {
    const before = session;
    clearTimeout(rollTimer);
    session = null;
    focusSeat = null;
    speaking = null;
    litFact = null;
    live = { phase: null, status: {}, opinions: {}, facts: [], seats: null };
    lock(true);
    $('ccMinutes').hidden = true;
    renderTable();
    renderDeck();
    let r;
    try {
      r = await api.convene({ question, mode: view.settings.mode, read, followUp });
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
      renderDeck();
      renderMinutes();
      return;
    }
    session = r.session;
    if (r.records) view = { ...view, records: r.records };
    clearFollowUp();
    rollCall();
    $('ccQuestion').value = '';
    renderTable();
    renderDeck();
    renderMinutes();
    if (!$('ccHistory').hidden) renderHistory();
  }

  function onProgress(ev) {
    if (!live || !ev) return;
    if (ev.kind === 'reading' || ev.kind === 'picking' || ev.kind === 'debating') live.phase = ev.kind;
    if (ev.kind === 'reading' && typeof ev.project === 'string') live.project = ev.project;
    if (ev.kind === 'read') { live.phase = null; live.facts = Array.isArray(ev.facts) ? ev.facts : []; renderDeck(); }
    if (ev.kind === 'seated' && Array.isArray(ev.seats)) { live.phase = null; live.seats = ev.seats; renderTable(); }
    if (ev.kind === 'thinking') live.status[ev.seat] = 'thinking';
    if (ev.kind === 'spoke') { live.status[ev.seat] = ev.opinion ? 'spoke' : 'silent'; live.opinions[ev.seat] = ev.opinion; if (ev.opinion) speaking = ev.seat; }
    if (ev.kind === 'rebutted') live.phase = null;
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
    const { seated: on, custom, pick } = view.settings, { seated: max, min, custom: maxCustom, pickMin, pickMax } = view.limits;
    $('ccPick').checked = pick;
    $('ccSeatsNote').textContent = pick
      ? `For each question he seats the ${pickMin} to ${pickMax} below whose angles matter most. The ones you tick sit when he can’t pick.`
      : `Seat ${min} to ${max} advisors. More seats cost more in Debate, not in Quick.`;
    $('ccSeatList').replaceChildren(...allSeats().map(s => {
      const isOn = on.includes(s.id);
      const rec = record(s.id);
      const box = h('input', { type: 'checkbox', checked: isOn, disabled: (isOn && on.length <= min) || (!isOn && on.length >= max) });
      box.addEventListener('change', () => save({ seated: box.checked ? [...on, s.id] : on.filter(x => x !== s.id) }));
      return h('li', { class: 'cc-seat-item' },
        h('span', { class: 'cc-row-crab', 'aria-hidden': 'true' }, state.skin ? M.crab(s) : null),
        h('label', {}, box, h('b', { text: s.name }), h('span', { class: 'muted small', text: s.brief }),
          rec?.of ? h('span', { class: 'cc-record-line', text: `Right ${rec.right} of ${rec.of} times on verdicts you followed` }) : null),
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

  const OUTCOME_MARK = { worked: '✓ worked', failed: '✗ didn’t work', skipped: 'not followed' };

  async function renderHistory() {
    const list = await api.councilHistory();
    const ul = $('ccHistoryList');
    if (!list.length) { ul.replaceChildren(h('li', { class: 'muted small', text: 'No sessions yet. Each one you convene is kept here, free to read again.' })); return; }
    ul.replaceChildren(...list.map(s => h('li', { class: 'cc-history-item' },
      h('button', { type: 'button', class: 'cc-history-open', onclick: () => openSession(s.id) },
        h('b', { text: s.question }),
        h('span', { class: 'muted small', text: [SB.relTime(s.at), s.mode, s.decision ? M.DECISION_WORD[s.decision] : '', s.outcome ? OUTCOME_MARK[s.outcome.result] : '', M.spentText(s), s.verdict].filter(Boolean).join(' · ') })),
      h('button', { type: 'button', class: 'btn ghost slim-btn', 'aria-label': 'Forget this session', onclick: async () => { await api.forgetCouncil(s.id); if (followUp === s.id) clearFollowUp(); renderHistory(); } }, '✕'))));
  }

  async function openSession(id) {
    if (live) return;
    const s = await api.councilSession(id);
    if (!s) { SB.toast('That session has gone.'); renderHistory(); return; }
    session = s;
    focusSeat = null;
    litFact = null;
    clearFollowUp();
    rollCall();
    renderTable();
    renderDeck();
    renderMinutes();
  }

  // ------------------------------------------------------------ the view

  async function render() {
    // The project can change between visits (a new folder in the chat), so ask each time.
    if (!live) view = await api.councilView();
    renderModes();
    renderTable();
    renderDeck();
    renderMinutes();
    if (!$('ccSeatsEditor').hidden) renderSeatEditor();
  }

  $('ccAsk').addEventListener('submit', convene);
  $('ccQuestion').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('ccAsk').requestSubmit(); });
  $('ccModes').addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if (b && view) save({ mode: b.dataset.mode }); });
  $('ccProject').addEventListener('change', e => { if (view) save({ read: e.target.checked }); });
  $('ccPick').addEventListener('change', e => { if (view) save({ pick: e.target.checked }); });
  $('ccScroll').addEventListener('click', () => pickSeat('chair'));
  $('ccNewBtn').addEventListener('click', newSession);
  $('ccSeatsBtn').addEventListener('click', () => toggleDrawer($('ccSeatsBtn'), $('ccSeatsEditor'), renderSeatEditor));
  $('ccHistoryBtn').addEventListener('click', () => toggleDrawer($('ccHistoryBtn'), $('ccHistory'), renderHistory));
  $('ccCustomForm').addEventListener('submit', addCustom);
  api.onCouncilProgress(onProgress);

  SB.views.council = { render };
})();
