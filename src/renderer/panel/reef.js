/* Shellby panel — reef health and coral (src/main/reef/index.js, docs/REEF.md).
   Two places: the Reef card under a project's page (html/reef.html), with its
   coral, each signal's last reading against its best, a sparkline, the next
   step and the watch toggle; and the Coral list on the Tank page
   (html/reef-tank.html). Everything comes through api.getGame('reef') and
   api.onGame, and the only things it can ask for are watch, stop, check and a Fix this prompt. */
'use strict';
(function () {
  const { h, api, $ } = SB;
  let view = null;
  let busy = false;

  const fmt = (v, unit) => (v == null ? '–' : `${Number.isInteger(v) ? v : v.toFixed(1)}${unit}`);
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const sameRoot = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

  // A coral: its picture and, when motion is welcome, its sway frame on top (reef.css alternates them).
  function coral(art, px = 3) {
    if (!art?.pixels?.length) return h('span');
    const still = SB.Sprite.grid(art.pixels, art.palette, { px });
    const wrap = h('span', { class: 'reef-art' }, still);
    if (art.frames?.[0]) {
      const sway = SB.Sprite.grid(art.frames[0], art.palette, { px });
      sway.classList.add('reef-sway');
      wrap.append(sway);
    }
    return wrap;
  }

  // The last readings as a little line; better is always up, so a falling count reads as rising.
  function sparkline(sig) {
    const vals = sig.series || [];
    if (vals.length < 2) return h('span', { class: 'reef-spark empty', 'aria-hidden': 'true' });
    const w = 72, ht = 18;
    const lo = Math.min(...vals, sig.best), hi = Math.max(...vals, sig.best);
    const span = hi - lo || 1;
    const y = v => {
      const t = (v - lo) / span;
      return (sig.better === 'lower' ? t : 1 - t) * (ht - 4) + 2;
    };
    const x = i => (i / (vals.length - 1)) * (w - 4) + 2;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${ht}`);
    svg.setAttribute('class', 'reef-spark');
    svg.setAttribute('aria-hidden', 'true');
    const best = document.createElementNS(ns, 'line');
    Object.entries({ x1: 0, x2: w, y1: y(sig.best), y2: y(sig.best), class: 'reef-spark-best' }).forEach(([k, v]) => best.setAttribute(k, v));
    const line = document.createElementNS(ns, 'polyline');
    line.setAttribute('points', vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '));
    line.setAttribute('class', `reef-spark-line ${sig.trend}`);
    svg.append(best, line);
    return svg;
  }

  const TREND = { up: ['▲', 'getting better'], down: ['▼', 'slipping'], flat: ['·', 'steady'] };

  // Fix this / Fix the worst: Shellby writes the prompt (reef/prompts.js) and it
  // goes in the box of a new conversation in the project's folder. Nothing is
  // sent until you press Enter.
  async function fix(r, sig) {
    try {
      const f = await api.gameAct('reef', 'fix', { id: r.id, sig });
      if (!f?.prompt) { SB.toast(f?.error || 'Nothing to fix there right now.'); return; }
      SB.setView('chat');
      await SB.newTabIn({ cwd: f.root || r.root, draft: f.prompt });
    } catch {
      SB.toast("Couldn't write that prompt just now. Try again in a moment.");
    }
  }

  function signalRow(r, sig) {
    const [mark, words] = TREND[sig.trend] || TREND.flat;
    const canFix = r?.on && sig.fixable;
    return h('li', { class: `reef-sig${sig.near ? ' near' : ''}`, dataset: { sig: sig.id } },
      h('div', { class: 'reef-sig-main' },
        h('span', { class: 'reef-sig-label', text: sig.label }),
        h('span', { class: 'reef-sig-hint muted small', text: sig.hint }),
        canFix ? h('button', { type: 'button', class: 'link-btn inline reef-fix', title: 'Puts a prompt for this in a new conversation, to read before you send it', onclick: () => fix(r, sig.id) }, 'Fix this') : null),
      sparkline(sig),
      h('span', { class: `reef-trend ${sig.trend}`, title: words, 'aria-label': words, text: mark }),
      h('span', { class: 'reef-sig-val' },
        h('b', { text: fmt(sig.last, sig.unit) }),
        h('span', { class: 'muted small', text: sig.atBest ? ' best' : ` · best ${fmt(sig.best, sig.unit)}` })));
  }

  async function act(action, payload) {
    if (busy) return;
    busy = true;
    renderCard();
    try {
      const v = await api.gameAct('reef', action, payload);
      if (v?.error) SB.toast(v.error);
      if (v?.projects) view = v;
    } catch {
      SB.toast("Couldn't reach the reef just now. Try again in a moment.");
    } finally {
      busy = false;
      renderAll();
    }
  }

  // ---------------------------------------------------------------- a project's page

  function reefFor(p) {
    const roots = (p?.local || []).map(c => c.root);
    return view?.projects.find(r => roots.some(root => sameRoot(root, r.root))) || null;
  }

  function renderCard() {
    const card = $('reefCard');
    if (!card) return;
    const p = SB.pj?.detail?.();
    const open = SB.state.view === 'projects' && !!p && !$('pjDetailScreen')?.hidden;
    const local = p?.local?.[0];
    card.hidden = !open || !local || !view;
    if (card.hidden) return;
    const r = reefFor(p);
    const watched = !!r?.on;
    $('reefCoral').replaceChildren(r ? coral(r.art, 3) : h('span', { class: 'reef-coral-empty', text: '🪸' }));
    $('reefStage').textContent = !r ? 'Not watched yet. Watch it and every real improvement grows a coral in his tank.'
      : !watched ? `Paused · ${r.stageName} · ${plural(r.polyps, 'polyp')}. Its coral stays in the tank.`
        : `${r.stageName} · ${plural(r.polyps, 'polyp')}${r.paidToday ? ' · paid out today' : ''}`;
    card.dataset.stage = r ? String(r.stage) : '';
    const buttons = watched
      ? [r.worst ? h('button', { type: 'button', class: 'btn primary slim-btn reef-fix-worst', title: 'Puts a prompt for the signal with the most room to get better in a new conversation', onclick: () => fix(r, 'worst') }, 'Fix the worst') : null,
        h('button', { type: 'button', class: 'btn slim-btn', disabled: busy, onclick: () => act('check', { id: r.id }), title: 'Read the ledgers and coverage again now. The escape-hatch count runs once a day.' }, busy ? 'Checking…' : 'Check now'),
        h('button', { type: 'button', class: 'btn ghost slim-btn', disabled: busy, onclick: () => act('unwatch', { root: local.root }) }, 'Stop watching')]
      : [h('button', { type: 'button', class: 'btn primary slim-btn', disabled: busy, onclick: () => act('watch', { root: local.root }) }, busy ? 'Starting…' : 'Watch this reef')];
    $('reefActions').replaceChildren(...buttons.filter(Boolean));
    const next = watched && r.next;
    $('reefNext').hidden = !next;
    if (next) $('reefNext').replaceChildren(h('span', { class: 'reef-next-label', text: 'Next best: ' }), next.text);
    $('reefSignals').replaceChildren(...(r?.signals || []).map(sig => signalRow(r, sig)));
    $('reefSignals').hidden = !r?.signals?.length;
    const waiting = watched ? r.waiting : [];
    $('reefWaiting').hidden = !waiting.length;
    $('reefWaiting').textContent = waiting.length
      ? `Not read yet: ${waiting.map(w => w.label.toLowerCase()).join(', ')}. Each is read when there's something to read (a lint or test run, a coverage file, a pull request's checks).`
      : '';
  }

  // ---------------------------------------------------------------- the tank page

  function renderTank() {
    const list = $('reefTankList');
    if (!list || !view) return;
    const reefs = view.projects;
    $('reefTankMeta').textContent = reefs.length ? `${plural(view.watching, 'reef')} watched · ${plural(view.polyps, 'polyp')}` : '';
    if (!reefs.length) {
      list.replaceChildren(h('li', { class: 'reef-tank-empty muted small' },
        'No coral yet. Open a project on the Projects page and press ', h('b', { text: 'Watch this reef' }), '.'));
      return;
    }
    list.replaceChildren(...reefs.map(r => h('li', { class: 'reef-tank-item', dataset: { stage: String(r.stage), id: r.id } },
      h('span', { class: 'reef-tank-art' }, coral(r.art, 2)),
      h('span', { class: 'reef-tank-text' },
        h('b', { text: r.name }),
        h('span', { class: 'muted small', text: `${r.on ? r.stageName : 'Paused'} · ${plural(r.polyps, 'polyp')}` })))));
  }

  function renderAll() { renderCard(); renderTank(); }

  async function load() {
    try {
      const v = await api.getGame('reef');
      if (v?.projects) view = v;
    } catch { /* not there yet */ }
    renderAll();
  }

  api.onGame(({ what, view: v, event } = {}) => {
    if (what !== 'reef' || !v?.projects) return;
    view = v;
    renderAll();
    if (event?.kind === 'best') {
      const sig = v.projects.find(p => p.id === event.id)?.signals.find(s => s.id === event.sig);
      SB.toast(`🪸 ${event.name}'s reef: ${sig ? sig.label.toLowerCase() : 'a signal'} reached a new best. +1 polyp${event.paid ? '' : ' (today’s XP is already paid)'}.`);
    }
  });

  // Redrawn whenever the page under it changes: a project opened, another view shown.
  const watch = el => el && new MutationObserver(renderAll).observe(el, { attributes: true, attributeFilter: ['hidden', 'data-view'] });
  watch(document.body);
  watch($('pjDetailScreen'));
  watch($('pjListScreen'));
  // Read again each time Projects or the Tank is shown: cheap, and a reading that came in meanwhile is there.
  new MutationObserver(() => { if (SB.state.view === 'projects' || SB.state.view === 'tank') load(); })
    .observe(document.body, { attributes: true, attributeFilter: ['data-view'] });
  SB.reef = { load, render: renderAll };
})();
