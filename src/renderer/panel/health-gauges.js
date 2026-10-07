/* Shellby panel — Health: a gauge per sensor with its graph, the graphs'
   range, and an alert from the log shown where it happened. health.js holds
   the snapshot; the specs and paths are health-logic.js's. */
'use strict';
(function () {
  const { h, $, state } = SB;
  const L = window.ShellbyHealthLogic;
  const H = SB.health;
  const NS = 'http://www.w3.org/2000/svg';
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const MARK_MS = 10 * 1000;         // how long a picked alert stays marked on its graph
  const RANGE_KEY = 'shellby.health.range';
  const { setText, smooth, levelOf, pendingOf, ask } = H;
  const { fmt } = L;

  let rangeMs = Number(SB.pref(RANGE_KEY)) === HOUR ? HOUR : 10 * MIN;
  let mark = null;                   // { id, at, until }: an alert picked from the log

  // ------------------------------------------------------------ sparkline

  function sparkline(points, key, { min, max, warn, markAt }) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 30');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'hl-spark');
    svg.setAttribute('aria-hidden', 'true');
    const { now, pts } = L.windowOf(points, key, rangeMs);
    const y = v => L.sparkY(v, min, max);
    const x = at => L.sparkX(at, now, rangeMs);
    const line = (cls, x1, y1, x2, y2) => {
      const l = document.createElementNS(NS, 'line');
      Object.entries({ x1, y1, x2, y2, class: cls }).forEach(([k, v]) => l.setAttribute(k, v));
      svg.append(l);
    };
    if (warn != null && warn > min && warn < max) line('hl-spark-warn', 0, y(warn), 100, y(warn));
    const paths = L.sparkPaths(pts, key, now, { min, max }, rangeMs);
    if (paths) {
      const area = document.createElementNS(NS, 'path');
      area.setAttribute('d', paths.area);
      area.setAttribute('class', 'hl-spark-area');
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', paths.line);
      path.setAttribute('class', 'hl-spark-line');
      path.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.append(area, path);
    }
    if (markAt != null && markAt >= now - rangeMs) line('hl-spark-mark', x(markAt), 0, x(markAt), 30);
    return svg;
  }

  // ------------------------------------------------------------ gauges

  const cards = new Map();           // key -> { el, parts, sig }

  function makeCard(key) {
    const parts = {
      label: h('span', { class: 'hl-glabel' }),
      badge: h('span', { class: 'hl-badges' }),
      value: h('div', { class: 'hl-value' }),
      sub: h('div', { class: 'hl-gsub' }),
      spark: h('div', { class: 'hl-spark-box' }),
      stats: h('div', { class: 'hl-gstats' }),
      ask: h('button', { class: 'hl-mini', type: 'button', hidden: true, onclick: () => ask(key) }, 'Ask Shellby why'),
    };
    const el = h('article', { class: 'hl-gauge', dataset: { id: key } },
      h('header', {}, parts.label, parts.badge), parts.value, parts.sub, parts.spark, parts.stats, parts.ask);
    return { el, parts, sig: {} };
  }

  function badgeFor(level, pending) {
    if (level === 'critical') return h('span', { class: 'hl-pill critical', title: 'Very high' }, h('span', { class: 'hl-pill-very', text: 'very ' }), 'high');
    if (level === 'warn') return h('span', { class: 'hl-pill warn', text: 'high' });
    if (pending) return h('span', { class: 'hl-watch', title: 'Over the line; Shellby reacts if it stays there', text: 'watching' });
    return null;
  }

  // Update a card where it stands: only the parts whose content changed.
  function updateCard(card, spec) {
    const { el, parts, sig } = card;
    const level = spec.level || 'ok';
    const once = (name, value, apply) => { if (sig[name] !== value) { sig[name] = value; apply(); } };
    const marked = mark && mark.id === spec.key;
    once('class', `${level}|${!!spec.missing}|${marked}`, () => {
      el.className = `hl-gauge lvl-${level}${spec.missing ? ' missing' : ''}${marked ? ' marked' : ''}`;
    });
    setText(parts.label, spec.label);
    once('badge', `${level}|${!!spec.pending}`, () => parts.badge.replaceChildren(...[badgeFor(level, spec.pending && level === 'ok')].filter(Boolean)));
    const valueText = spec.missing ? '—' : `${fmt(spec.value, spec.digits || 0)}|${spec.unit}`;
    once('value', valueText, () => parts.value.replaceChildren(...(spec.missing
      ? [h('span', { class: 'hl-dash', text: '—' })]
      : [fmt(spec.value, spec.digits || 0), h('small', { text: spec.unit })])));
    const subKey = spec.missing === 'setup' ? 'setup' : String(spec.missing || spec.sub || '');
    once('sub', subKey, () => {
      const setup = spec.missing === 'setup';
      parts.sub.title = setup ? '' : subKey;   // the card clips it; the tooltip doesn't
      parts.sub.replaceChildren(setup
        ? h('button', { class: 'hl-link', type: 'button', onclick: () => H.openSensors() }, 'Set up CPU temperature →')
        : subKey || ' ');
    });
    const history = H.history();
    parts.spark.replaceChildren(spec.spark
      ? sparkline(history, spec.spark.key, { ...spec.spark, markAt: marked ? mark.at : null })
      : h('div', { class: 'hl-spark empty' }));
    setText(parts.stats, spec.spark ? L.stats(history, spec.spark.key, spec.unit === '°C' ? '°' : spec.unit, rangeMs) : '');
    parts.stats.title = `Lowest and highest in the last ${rangeMs === HOUR ? 'hour' : '10 minutes'}`;
    parts.ask.hidden = !(spec.askable && level !== 'ok');
  }

  function renderGauges() {
    const box = $('hlGauges');
    const view = H.view();
    const s = view?.sample;
    if (!s) { box.replaceChildren(); cards.clear(); return; }
    const specs = L.gaugeSpecs(s, view.thresholds, key => ({ level: levelOf(key), pending: pendingOf(key) }));
    const keep = new Set(specs.map(sp => sp.key));
    for (const [key, card] of cards) if (!keep.has(key)) { card.el.remove(); cards.delete(key); }
    specs.forEach((spec, i) => {
      let card = cards.get(spec.key);
      if (!card) { card = makeCard(spec.key); cards.set(spec.key, card); }
      updateCard(card, spec);
      // Moved only when out of place, so a focused card keeps its focus.
      if (box.children[i] !== card.el) box.insertBefore(card.el, box.children[i] || null);
    });
    for (const b of $('hlRange').querySelectorAll('button')) b.setAttribute('aria-selected', String(Number(b.dataset.range) === rangeMs));
  }

  function setRange(ms) {
    rangeMs = ms;
    SB.pref.set(RANGE_KEY, ms);
    renderGauges();
  }

  /** Take an alert from the log to where it happened: its graph, its drive, or the clutter card. */
  function showAlert(e) {
    const id = String(e.id);
    if (!L.sparkKeyOf(id)) {
      const target = e.kind === 'disk' ? [...document.querySelectorAll('.hl-disk')].find(el => el.dataset.id === id) || $('hlDrivesBlock') : $('hlSpace');
      if (target && !target.hidden) target.scrollIntoView({ behavior: smooth(), block: 'center' });
      else SB.toast("That one isn't on screen any more.");
      return;
    }
    const age = Date.now() - e.at;
    if (age > HOUR) return SB.toast('That was over an hour ago, and the graphs keep the last hour.');
    if (!cards.has(id)) return SB.toast("That sensor isn't reporting right now.");
    if (age > rangeMs) setRange(HOUR);
    mark = { id, at: e.at, until: Date.now() + MARK_MS };
    renderGauges();
    cards.get(id).el.scrollIntoView({ behavior: smooth(), block: 'center' });
    setTimeout(() => { if (mark && Date.now() >= mark.until) { mark = null; if (state.view === 'health') renderGauges(); } }, MARK_MS + 50);
  }

  $('hlRange').addEventListener('click', e => {
    const b = e.target.closest('button[data-range]');
    if (b) setRange(Number(b.dataset.range));
  });

  Object.assign(H, { renderGauges, setRange, showAlert });
})();
