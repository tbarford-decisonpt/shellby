/* Shellby panel — Health: live vitals, drives, sensor setup and alert settings. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const NS = 'http://www.w3.org/2000/svg';
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const HISTORY_MAX = 720;           // matches the monitor's hour of 5 s samples
  const GB = 1024 ** 3;
  const MARK_MS = 10 * 1000;         // how long a picked alert stays marked on its graph
  const RANGE_KEY = 'shellby.health.range';

  let view = null;                   // last snapshot from main (see health/service.js view())
  let history = [];
  let fx = null;
  let saveTimer = null;
  const pref = () => { try { return window.localStorage.getItem(RANGE_KEY); } catch { return null; } };
  let rangeMs = Number(pref()) === HOUR ? HOUR : 10 * MIN;
  let mark = null;                   // { id, at, until }: an alert picked from the log
  const HOGS_REFRESH_MS = 30 * 1000; // the process list is a ~3 s read; don't add to the heat
  let hogs = null;                   // { ok, metric, procs, groups } from main
  let hogsAt = 0;
  let hogsLoading = false;
  let hogsAgain = false;             // a read was asked for while one was out: do one more
  let hogsOpen = false;              // opened by hand (it also opens itself while he sweats)
  let hogMetric = null;              // the user's pick; null follows the mood
  let hogMode = 'app';               // 'app' adds processes up by name, 'proc' lists each
  let drawnHogs = null;              // what the list shows, so 5 s samples don't rebuild it
  let startup = null;                // { ok, items } from main
  let sensorsOpened = false;         // the Sensors fold opens itself once, when setup is needed
  const drawn = {};                  // section -> signature of what it shows now

  const levelOf = id => view?.checks?.[id]?.level || 'ok';
  const pendingOf = id => view?.checks?.[id]?.pending || null;
  const readingOf = id => view?.checks?.[id]?.reading || null;
  const fmt = (v, digits = 0) => (Number.isFinite(v) ? v.toFixed(digits) : '—');
  const gb = n => {
    if (!Number.isFinite(n)) return '?';
    const g = n / GB;
    return g >= 1000 ? `${(g / 1024).toFixed(1)} TB` : g >= 100 ? `${Math.round(g)} GB` : `${g.toFixed(g < 10 ? 1 : 0)} GB`;
  };
  const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
  const smooth = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
  // Rebuild a section only when what it shows has changed, so a 5 s sample
  // doesn't throw away a focused button or make a screen reader start over.
  const changed = (name, sig) => (drawn[name] === sig ? false : ((drawn[name] = sig), true));

  // ------------------------------------------------------------ sparkline

  function windowOf(points, key) {
    const now = points.length ? points[points.length - 1].at : Date.now();
    const pts = points.filter(p => p.at >= now - rangeMs && Number.isFinite(p[key]));
    return { now, pts };
  }

  function sparkline(points, key, { min, max, warn, markAt }) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 30');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'hl-spark');
    svg.setAttribute('aria-hidden', 'true');
    const { now, pts } = windowOf(points, key);
    const y = v => 30 - ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * 28 - 1;
    const x = at => 100 - ((now - at) / rangeMs) * 100;
    const line = (cls, x1, y1, x2, y2) => {
      const l = document.createElementNS(NS, 'line');
      Object.entries({ x1, y1, x2, y2, class: cls }).forEach(([k, v]) => l.setAttribute(k, v));
      svg.append(l);
    };
    if (warn != null && warn > min && warn < max) line('hl-spark-warn', 0, y(warn), 100, y(warn));
    if (pts.length > 1) {
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(2)},${y(p[key]).toFixed(2)}`).join(' ');
      const area = document.createElementNS(NS, 'path');
      area.setAttribute('d', `${d} L${x(pts[pts.length - 1].at).toFixed(2)},30 L${x(pts[0].at).toFixed(2)},30 Z`);
      area.setAttribute('class', 'hl-spark-area');
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', 'hl-spark-line');
      path.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.append(area, path);
    }
    if (markAt != null && markAt >= now - rangeMs) line('hl-spark-mark', x(markAt), 0, x(markAt), 30);
    return svg;
  }

  /** "↓52° ↑84°": lowest and highest in the graph's window, or '' without enough points. */
  function stats(key, unit) {
    const { pts } = windowOf(history, key);
    if (pts.length < 2) return '';
    const vals = pts.map(p => p[key]);
    const r = v => `${Math.round(v)}${unit}`;
    return `↓${r(Math.min(...vals))} ↑${r(Math.max(...vals))}`;
  }

  // ------------------------------------------------------------ hero

  const warnFor = (kind, t) => (kind === 'gpu-temp' ? t.gpuWarn : kind === 'storage-temp' ? t.storageWarn : t.cpuWarn);
  const named = r => `${r.label || 'It'}${r.kind === 'storage-temp' && r.model ? ` (${r.model})` : ''}`;

  // The verdict, worded from the check's own reading: every kind main can
  // raise reads right, including ones without a gauge of their own.
  function heroCopy(mood, t) {
    const r = readingOf(mood.id) || {};
    const v = Math.round(r.value);
    switch (mood.mood) {
      case 'hot':
        return { title: 'Running hot', line: `${named(r)} is at ${v}°C, over your ${warnFor(r.kind, t)}°C line. Shellby is fanning himself.` };
      case 'scorching':
        return { title: 'Overheating!', line: `${named(r)} is at ${v}°C, ${v - warnFor(r.kind, t)}°C past your warning. Check what's using it.` };
      case 'dizzy':
        return { title: "Memory's nearly full", line: `${v}% of ${gb(r.total)} in use. Shellby is seeing stars.` };
      case 'stuffed':
        if (r.kind === 'reclaim') {
          return {
            title: `${gb(r.value * GB)} of developer clutter`,
            line: `${r.sources?.length ? `Mostly ${r.sources.slice(0, 3).join(', ')}. ` : ''}Junk is spilling out of his shell.`,
            ask: "Ask Shellby what's safe to clear",
          };
        }
        return { title: `${r.drive} is filling up`, line: `Only ${gb(r.value * GB)} left. Junk is spilling out of his shell.`, ask: 'Ask Shellby what to clean up' };
      default:
        return { title: 'Heads up', line: '' };
    }
  }

  function renderHero() {
    const hero = $('hlHero');
    const t = view?.thresholds || {};
    const mood = view?.settings?.moods === false ? null : view?.mood;
    const off = view && !view.settings?.enabled;
    hero.dataset.level = off ? 'off' : view?.worst || 'ok';
    $('hlLive').classList.toggle('on', !!view?.running);
    $('hlEnable').hidden = !off;
    $('hlAsk').hidden = true;

    let title, sub, eyebrow = 'Vitals';
    if (off) {
      title = 'Health checks are off';
      sub = "Shellby isn't watching temperatures, memory or drives right now.";
    } else if (!view?.sample) {
      title = 'Taking a first reading…';
      sub = '';
    } else if (view.mood) {
      const copy = heroCopy(view.mood, t);
      eyebrow = view.mood.level === 'critical' ? 'Needs attention' : 'Heads up';
      title = copy.title;
      sub = copy.line;
      $('hlAsk').hidden = false;
      $('hlAsk').dataset.check = view.mood.id;
      setText($('hlAsk'), copy.ask || 'Ask Shellby why');
    } else {
      const s = view.sample;
      const bits = [
        s.gpus[0]?.temp != null && `GPU ${Math.round(s.gpus[0].temp)}°C`,
        s.cpu.temp != null && `CPU ${Math.round(s.cpu.temp)}°C`,
        s.ram && `memory ${Math.round(s.ram.pct)}%`,
      ].filter(Boolean);
      title = 'All calm';
      sub = `${bits.join(' · ')}${bits.length ? '. ' : ''}Shellby's keeping an eye on things.`;
    }
    // The hero is a live region: only touch it when the words change.
    setText($('hlEyebrow'), eyebrow);
    setText($('hlTitle'), title);
    setText($('hlSub'), sub);
    fx?.set(mood?.mood || null);
  }

  function renderCrab() {
    // fit:false keeps the sprite's view box on the crab itself, which the
    // health overlays are positioned against (hats just overflow upwards).
    $('hlSprite').replaceChildren(SB.sprite(state.skin, { fit: false }));
    if (!fx) fx = window.ShellbyHealthFx.mount($('hlFx'), $('hlHero'));
    renderPorthole();
  }

  // ------------------------------------------------------------ the porthole

  // A window into his real tank (tank.js, tank-paint.js): the floor, the back
  // glass and whatever stands nearest his spot, painted once, still. He and
  // his mood effects stay on top as before, at --px, so they scale together.
  // An empty tank looks just as this always has.
  const PORTHOLE_PX = 4;   // css px per art pixel, as --px on .has-porthole
  const CRAB_LIFT = 14;    // css px, .hl-crab's bottom
  const FOCUS_AT = 0.28;   // his favourite piece stands to his left, not behind him
  function renderPorthole(v = SB.tankView?.()) {
    const box = $('hlHero').querySelector('.hl-tank');
    const P = SB.tankPaint;
    let canvas = box.querySelector('.hl-porthole');
    const show = !!(P && v && v.pieces.length);
    box.classList.toggle('has-porthole', show);
    if (!show) { canvas?.remove(); box.style.removeProperty('--px'); return; }
    if (!box.dataset.watched) { // a narrow panel changes its size: paint it again at the new one
      box.dataset.watched = '1';
      new ResizeObserver(() => { if (state.view === 'health') renderPorthole(); }).observe(box);
    }
    if (!canvas) {
      canvas = h('canvas', { class: 'hl-porthole', 'aria-hidden': 'true' });
      box.prepend(canvas);
    }
    const dpr = window.devicePixelRatio || 1;
    // Whole device pixels a pixel, as near --px as they come (exact at 100–200%),
    // and he and his moods take the same scale, so they stand on the floor.
    const K = Math.max(1, Math.round(PORTHOLE_PX * dpr));
    box.style.setProperty('--px', `${K / dpr}px`);
    const cssW = box.clientWidth || 148, cssH = box.clientHeight || 112;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const scene = P.resolve(v.layout, v);
    const artW = canvas.width / K;
    const ox = Math.max(0, Math.min(scene.world.w - artW, v.focusX - artW * FOCUS_AT));
    const oy = scene.world.crabY + 1 - (cssH - CRAB_LIFT) * dpr / K;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(K, 0, 0, K, -Math.round(ox * K), -Math.round(oy * K));
    P.paint(ctx, scene, { still: true });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  document.addEventListener('sb:tank', e => { if (state.view === 'health') renderPorthole(e.detail); });

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
        ? h('button', { class: 'hl-link', type: 'button', onclick: () => openSensors() }, 'Set up CPU temperature →')
        : subKey || ' ');
    });
    parts.spark.replaceChildren(spec.spark
      ? sparkline(history, spec.spark.key, { ...spec.spark, markAt: marked ? mark.at : null })
      : h('div', { class: 'hl-spark empty' }));
    setText(parts.stats, spec.spark ? stats(spec.spark.key, spec.unit === '°C' ? '°' : spec.unit) : '');
    parts.stats.title = `Lowest and highest in the last ${rangeMs === HOUR ? 'hour' : '10 minutes'}`;
    parts.ask.hidden = !(spec.askable && level !== 'ok');
  }

  const shortGpu = name => String(name || '').replace(/^NVIDIA GeForce |^AMD Radeon /, '');
  const shortCpu = name => (name ? name.replace(/\s+\d+-Core Processor$/i, '').replace(/^AMD |^Intel\(R\) /, '') : null);
  const watts = w => (Number.isFinite(w) && w > 0 ? `${Math.round(w)} W` : null);
  const join = (...bits) => bits.filter(Boolean).join(' · ') || null;

  function gaugeSpecs(s, t) {
    const specs = [];
    const many = s.gpus.length > 1;
    const tempRange = (warn, floor = 25) => ({ min: floor, max: Math.max(100, warn + 12), warn });
    const check = key => ({ level: levelOf(key), pending: pendingOf(key) });
    (s.gpus.length ? s.gpus : [null]).forEach((g, i) => {
      const key = `gpu-temp:${i}`;
      specs.push({
        key, label: many ? `GPU ${i + 1} temp` : 'GPU temp', value: g?.temp, unit: '°C', askable: true, ...check(key),
        sub: g && join(shortGpu(g.name), g.hotspot != null && `hotspot ${Math.round(g.hotspot)}°`),
        missing: g?.temp == null ? (g ? 'No temperature reading' : 'No supported GPU found') : null,
        spark: g?.temp != null ? { key: `gpuT${i || ''}`, ...tempRange(t.gpuWarn) } : null,
      });
    });
    specs.push({
      key: 'cpu-temp', label: 'CPU temp', value: s.cpu.temp, unit: '°C', askable: true, ...check('cpu-temp'),
      sub: join(shortCpu(s.cpu.name), watts(s.cpu.power)),
      missing: s.cpu.temp == null ? 'setup' : null,
      spark: s.cpu.temp != null ? { key: 'cpuT', ...tempRange(t.cpuWarn) } : null,
    });
    specs.push({
      key: 'ram', label: 'Memory', value: s.ram?.pct, unit: '%', askable: true, ...check('ram'),
      sub: s.ram ? `${gb(s.ram.used)} of ${gb(s.ram.total)}` : null,
      missing: s.ram ? null : 'Not reported',
      spark: { key: 'ram', min: 0, max: 100, warn: t.ramWarn },
    });
    specs.push({ key: 'cpu-load', label: 'CPU load', value: s.cpu.load, unit: '%', sub: 'all cores', spark: { key: 'cpu', min: 0, max: 100 } });
    s.gpus.forEach((g, i) => {
      specs.push({
        key: `gpu-load:${i}`, label: many ? `GPU ${i + 1} load` : 'GPU load', value: g.load, unit: '%',
        sub: join(g.memTotal ? `VRAM ${(g.memUsed / 1024).toFixed(1)} / ${(g.memTotal / 1024).toFixed(0)} GB` : null, watts(g.power)),
        missing: g.load == null ? 'Not reported' : null,
        spark: g.load != null ? { key: `gpu${i || ''}`, min: 0, max: 100 } : null,
      });
    });
    (s.storage || []).forEach((d, i) => {
      const key = `storage-temp:${i}`;
      specs.push({
        key, label: s.storage.length > 1 ? `Drive ${i + 1} temp` : 'Drive temp', value: d.temp, unit: '°C', askable: true, ...check(key),
        sub: join(d.name, Number.isFinite(d.life) && `${Math.round(d.life)}% life left`),
        missing: d.temp == null ? 'No temperature reading' : null,
        spark: d.temp != null ? { key: `stT${i}`, ...tempRange(t.storageWarn, 20) } : null,
      });
    });
    const b = s.battery;
    if (b) {
      specs.push({
        key: 'battery', label: 'Battery', value: b.level, unit: '%',
        sub: join(b.health != null && `${Math.round(b.health)}% health`, b.rate > 0 ? `charging ${b.rate.toFixed(1)} W` : b.rate < 0 ? `using ${(-b.rate).toFixed(1)} W` : null),
        missing: b.level == null ? 'Not reported' : null,
      });
    }
    return specs;
  }

  function renderGauges() {
    const box = $('hlGauges');
    const s = view?.sample;
    if (!s) { box.replaceChildren(); cards.clear(); return; }
    const specs = gaugeSpecs(s, view.thresholds);
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
    try { window.localStorage.setItem(RANGE_KEY, String(ms)); } catch { /* lasts this session */ }
    renderGauges();
  }

  // ------------------------------------------------------------ fans

  function renderFans() {
    const fans = view?.sample?.fans || [];
    $('hlFansBlock').hidden = !fans.length;
    if (!changed('fans', JSON.stringify(fans))) return;
    $('hlFans').replaceChildren(...fans.map(f => h('li', { class: `hl-fan${f.rpm ? '' : ' stopped'}` },
      h('span', { class: 'hl-fan-name', text: f.name }),
      h('b', { text: f.rpm ? `${f.rpm.toLocaleString()} rpm` : 'stopped' }))));
  }

  // ------------------------------------------------------------ drives

  function renderDisks() {
    const disks = view?.sample?.disks || [];
    if (!disks.length) {
      if (changed('disks', view?.sample ? 'none' : 'reading')) {
        $('hlDisks').replaceChildren(h('li', { class: 'hl-empty', text: view?.sample ? 'No local drives found.' : 'Reading drives…' }));
      }
      return;
    }
    if (!changed('disks', JSON.stringify(disks.map(d => [d.id, d.label, d.free, d.total, levelOf(`disk:${d.id}`)])))) return;
    $('hlDisks').replaceChildren(...disks.map(d => {
      const id = `disk:${d.id}`;
      const level = levelOf(id);
      const used = d.total ? 1 - d.free / d.total : 0;
      return h('li', { class: `hl-disk lvl-${level}`, dataset: { id } },
        h('div', { class: 'hl-disk-top' },
          h('b', { text: d.id }), h('span', { class: 'hl-disk-label', text: d.label || 'Local disk' }),
          h('span', { class: 'hl-disk-free' }, h('b', { text: gb(d.free) }), ` free of ${gb(d.total)}`)),
        h('div', { class: 'hl-bar', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(used * 100), 'aria-label': `${d.id} ${Math.round(used * 100)}% full` },
          h('span', { style: `transform: scaleX(${used.toFixed(4)})` })),
        level !== 'ok' ? h('button', { class: 'hl-mini', type: 'button', onclick: () => ask(id) }, 'Ask Shellby what to clean up') : null);
    }));
  }

  // ------------------------------------------------------------ developer clutter

  function spaceRows(sp) {
    const rows = [];
    if (sp.docker?.reclaimable > 0) {
      rows.push({ name: 'Docker', detail: `unused, of ${gb(sp.docker.size)} in all`, size: sp.docker.reclaimable, title: sp.docker.rows.map(r => `${r.type}: ${gb(r.reclaimable)} of ${gb(r.size)}`).join('\n') });
    }
    for (const c of sp.caches || []) {
      rows.push({ name: `${c.name} cache`, detail: SB.shortPath(c.dir), size: c.size, partial: c.partial, title: c.dir });
    }
    for (const i of sp.images || []) {
      rows.push({ name: i.name, detail: "virtual disk, doesn't shrink on its own", size: i.size, image: true, title: i.file });
    }
    return rows;
  }

  function renderSpace() {
    const sp = view?.space;
    const on = !!(view?.settings?.enabled && view?.settings?.space && sp);
    $('hlSpace').hidden = !on;
    if (!on) return;
    const level = levelOf('reclaim');
    $('hlSpace').dataset.level = level;
    $('hlAskSpace').disabled = !view.checks?.reclaim;
    if (!changed('space', `${sp.at}|${level}`)) return;
    const rows = spaceRows(sp);
    const max = Math.max(1, ...rows.map(r => r.size));
    $('hlSpaceTotal').textContent = sp.reclaimable > 0 ? `${gb(sp.reclaimable)} could come back` : 'Nothing to reclaim';
    $('hlSpaceList').replaceChildren(...(rows.length ? rows.map(r => h('li', { class: `hl-space-row${r.image ? ' image' : ''}`, title: r.title },
      h('div', { class: 'hl-hog-top' },
        h('b', { class: 'hl-hog-name', text: r.name }),
        h('span', { class: 'hl-hog-rest', text: r.detail }),
        h('span', { class: 'hl-hog-val', text: `${r.partial ? '≥ ' : ''}${gb(r.size)}` })),
      h('div', { class: 'hl-hog-bar', 'aria-hidden': 'true' }, h('span', { style: `transform: scaleX(${(r.size / max).toFixed(4)})` }))))
      : [h('li', { class: 'hl-empty', text: 'No Docker, WSL or package caches worth mentioning.' })]));
    $('hlSpaceFine').textContent = [
      sp.vmMemory ? `WSL's virtual machine is holding ${gb(sp.vmMemory)} of memory.` : null,
      `Measured ${SB.relTime(sp.at)}. Shellby only reads these; nothing is pruned or deleted.`,
    ].filter(Boolean).join(' ');
  }

  // ------------------------------------------------------------ sensors

  function renderSources() {
    const s = view?.sample;
    const src = view?.sources || {};
    const g = s?.gpus?.[0];
    const app = src.app === 'hwinfo' ? 'HWiNFO' : 'LibreHardwareMonitor';
    const row = (ok, title, detail) => h('li', { class: `hl-src ${ok === true ? 'ok' : ok === false ? 'off' : 'na'}` },
      h('span', { class: 'hl-src-dot', 'aria-hidden': 'true' }), h('div', {}, h('b', { text: title }), h('span', { text: detail })));
    const lhmText = { ok: `reading from ${app}`, auth: 'LibreHardwareMonitor wants a password', off: 'needs LibreHardwareMonitor', unknown: 'checking…' }[src.lhm] || 'checking…';
    const rows = [
      [!!src.gpuTemp, 'GPU', g ? `${g.name} · via ${g.vendor === 'nvidia' && src.nvidia ? 'nvidia-smi' : app}` : 'no NVIDIA GPU found (AMD and Intel GPUs need LibreHardwareMonitor)'],
      [src.cpuTemp ? true : src.lhm === 'unknown' ? null : false, 'CPU temperature', s?.cpu?.temp != null ? `${s.cpu.name || 'CPU'} · ${lhmText}` : lhmText],
      [src.storage ? true : null, 'Drive temperatures and fans', src.storage || src.fans ? `${s.storage.length} drive${s.storage.length === 1 ? '' : 's'}, ${s.fans.length} fan${s.fans.length === 1 ? '' : 's'} · ${lhmText}` : `none reported · ${lhmText}`],
      [true, 'Memory, CPU load and drives', 'built into Windows'],
    ];
    if (changed('sources', JSON.stringify(rows))) $('hlSources').replaceChildren(...rows.map(r => row(...r)));
    const needsSetup = !!(view?.sample && !src.cpuTemp);
    $('hlSetup').hidden = !needsSetup;
    $('hlAuth').hidden = src.lhm !== 'auth';
    setText($('hlSensorsSum'), !view?.sample ? '' : needsSetup ? 'CPU temperature needs setting up' : `reading from ${src.app === 'hwinfo' ? 'HWiNFO' : 'LibreHardwareMonitor'}${src.nvidia ? ' and nvidia-smi' : ''}`);
    // Open the fold the first time setup is needed; after that it's the user's.
    if (needsSetup && !sensorsOpened) { sensorsOpened = true; $('hlSensorsFold').open = true; }
    if (document.activeElement !== $('hlPort')) $('hlPort').value = view?.settings?.lhmPort || 8085;
  }

  function openSensors() {
    $('hlSensorsFold').open = true;
    $('hlSetup').scrollIntoView({ behavior: smooth(), block: 'center' });
  }

  // ------------------------------------------------------------ what's using it

  const HOG_MOODS = new Set(['hot', 'scorching', 'dizzy']);
  const METRIC_OF = id => (String(id).startsWith('gpu-temp') ? 'gpu' : id === 'cpu-temp' ? 'cpu' : id === 'ram' ? 'mem' : null);
  const METRIC_LABEL = { cpu: 'CPU', gpu: 'GPU', mem: 'memory' };
  const size = n => (n >= GB ? gb(n) : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`);
  const pct = v => `${fmt(v, v > 0 && v < 10 ? 1 : 0)}%`;

  // While he sweats or is dizzy the list opens itself: "why?" is the next question.
  function hogsAuto() {
    const m = view?.settings?.enabled && view?.mood;
    return m && HOG_MOODS.has(m.mood) ? METRIC_OF(m.id) : null;
  }

  function renderHogs() {
    const enabled = !!view?.settings?.enabled;
    $('hlHogs').hidden = !enabled;
    const auto = enabled ? hogsAuto() : null;
    if (!auto && !hogsOpen) hogMetric = null;
    const open = enabled && (hogsOpen || !!auto);
    $('hlHogs').dataset.open = String(open);
    $('hlHogsOpen').hidden = open;
    for (const id of ['hlHogsSeg', 'hlHogsGroup', 'hlHogsRefresh', 'hlHogList', 'hlHogsFine']) $(id).hidden = !open;
    $('hlHogsClose').hidden = !open || !!auto;
    setText($('hlHogsTitle'), auto ? "What's hogging it" : "What's using it");
    if (!open) { drawnHogs = null; return; }

    const metric = hogMetric || auto || 'cpu';
    const noGpu = hogs?.procs?.length > 0 && hogs.procs.every(p => p.gpu == null);
    for (const b of $('hlHogsSeg').querySelectorAll('button')) {
      b.setAttribute('aria-selected', String(b.dataset.metric === metric));
      b.hidden = b.dataset.metric === 'gpu' && noGpu;
    }
    for (const b of $('hlHogsGroup').querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.group === hogMode));
    if (hogs?.metric !== metric || Date.now() - hogsAt > HOGS_REFRESH_MS) loadHogs(metric);
    const list = $('hlHogList');
    if (!hogs || hogs.metric !== metric) {
      drawnHogs = null;
      list.replaceChildren(h('li', { class: 'hl-empty', text: "Looking at what's running…" }));
      return;
    }
    if (drawnHogs?.hogs === hogs && drawnHogs.mode === hogMode) return;
    drawnHogs = { hogs, mode: hogMode };
    if (!hogs.ok) return list.replaceChildren(h('li', { class: 'hl-empty', text: hogs.error }));
    const rows = hogMode === 'app' ? hogs.groups || [] : hogs.procs;
    if (!rows.length) return list.replaceChildren(h('li', { class: 'hl-empty', text: `Nothing is using much ${METRIC_LABEL[metric]} right now.` }));
    const ramTotal = view?.sample?.ram?.total || 0;
    // The numbers change with every read, so the rows are rebuilt; a focused
    // button is found again on its row (same app, or same process) afterwards.
    const focused = list.contains(document.activeElement) ? document.activeElement.closest('.hl-hog')?.dataset.key : null;
    list.replaceChildren(...rows.map(p => hogRow(p, metric, ramTotal)));
    if (focused) [...list.querySelectorAll('.hl-hog')].find(li => li.dataset.key === focused)?.querySelector('button')?.focus();
  }

  // Shellby's own CPU and memory (health/footprint.js), owned up to above the
  // list, with a pointer to what makes him lighter when he's costing a lot.
  function renderSelf() {
    const self = view?.settings?.enabled ? view.self : null;
    $('hlSelf').hidden = !self;
    if (!self) return;
    setText($('hlSelfLine'), self.line);
    $('hlSelfLine').title = self.detail;
    $('hlSelfHint').hidden = !self.hint;
    setText($('hlSelfHintText'), self.hint || '');
    $('hlSelfSettings').hidden = !self.jump;
  }

  function hogRow(p, metric, ramTotal) {
    const isGroup = hogMode === 'app';
    const share = metric === 'mem' ? (ramTotal ? p.mem / ramTotal : 0) : p[metric] / 100;
    const rest = [
      metric !== 'cpu' && `CPU ${pct(p.cpu)}`,
      metric !== 'gpu' && p.gpu != null && `GPU ${pct(p.gpu)}`,
      metric !== 'mem' && size(p.mem),
    ].filter(Boolean).join(' · ');
    const many = isGroup && p.count > 1;
    const owned = isGroup ? p.owned : p.owned ? 1 : 0;
    const who = many ? `all ${p.count} ${p.name} processes` : isGroup ? p.name : `${p.name} (process ${p.pid})`;
    let action;
    if (p.locked) action = h('span', { class: 'hl-hog-locked', title: p.locked, text: 'protected' });
    else action = h('button', { class: 'hl-hog-end', type: 'button', 'aria-label': `End ${who}`, onclick: e => (isGroup ? endGroup(p, e.currentTarget) : endTask(p, e.currentTarget)) }, many ? 'End all' : 'End task');
    return h('li', { class: 'hl-hog', dataset: { key: isGroup ? `app:${p.name.toLowerCase()}` : `pid:${p.pid}` } },
      h('div', { class: 'hl-hog-top' },
        h('b', { class: 'hl-hog-name', text: p.name, title: isGroup ? `${p.name}: ${p.count} process${p.count === 1 ? '' : 'es'}` : `${p.name} (process ${p.pid})` }),
        many ? h('span', { class: 'hl-hog-count', text: `×${p.count}` }) : null,
        owned ? h('span', { class: 'hl-hog-owned', title: "Started by one of Shellby's tasks. They end when that task closes.", text: many && owned < p.count ? `${owned} Shellby task` : 'Shellby task' }) : null,
        h('span', { class: 'hl-hog-rest', text: rest }),
        h('span', { class: 'hl-hog-val', text: metric === 'mem' ? size(p.mem) : pct(p[metric]) })),
      h('div', { class: 'hl-hog-bar', 'aria-hidden': 'true' }, h('span', { style: `transform: scaleX(${Math.min(1, Math.max(0, share)).toFixed(4)})` })),
      action);
  }

  async function loadHogs(metric) {
    if (hogsLoading) { hogsAgain = true; return; }
    hogsLoading = true;
    try {
      hogs = await api.getHogs(metric);
      hogsAt = Date.now();
    } finally {
      hogsLoading = false;
    }
    // A read that began before an End task may still list what was ended.
    if (hogsAgain) { hogsAgain = false; hogsAt = 0; }
    if (state.view === 'health') renderHogs();
  }

  async function endTask(p, btn) {
    btn.disabled = true;
    let r;
    try { r = await api.endTask(p.pid); } finally { btn.disabled = false; }
    if (r?.cancelled) return;
    if (!r?.ok) return SB.toast(r?.error || "Couldn't end that one.");
    SB.toast(r.gone ? `${p.name} had already closed` : `Ended ${p.name}`);
    hogsAt = 0;
    renderHogs();
  }

  async function endGroup(g, btn) {
    btn.disabled = true;
    let r;
    try { r = await api.endTaskGroup(g.name); } finally { btn.disabled = false; }
    if (r?.cancelled) return;
    if (!r?.ok) return SB.toast(r?.error || "Couldn't end those.");
    const bits = [r.ended && `Ended ${r.ended} ${g.name}`, r.gone && `${r.gone} had already closed`, r.failed && `${r.failed} wouldn't end`].filter(Boolean);
    SB.toast(bits.join(', ') || `${g.name} had already closed`);
    hogsAt = 0;
    renderHogs();
  }

  // ------------------------------------------------------------ starts with Windows

  function renderStartup() {
    const items = startup?.items || [];
    const on = items.filter(i => !i.off).length;
    const off = items.length - on;
    $('hlAskStartup').disabled = !startup?.ok;
    if (!startup?.ok) {
      $('hlStartupSum').textContent = startup ? startup.error : 'Reading the startup list…';
      $('hlStartup').replaceChildren();
      return;
    }
    $('hlStartupSum').textContent = on
      ? `${on} thing${on === 1 ? '' : 's'} start${on === 1 ? 's' : ''} when you sign in${off ? `, and ${off} you've switched off` : ''}.`
      : `Nothing starts when you sign in${off ? ` (${off} switched off)` : ''}.`;
    $('hlStartup').replaceChildren(...items.map(i => h('li', { class: `hl-start${i.off ? ' off' : ''}`, title: i.command },
      h('span', { class: 'hl-start-name', text: i.name }),
      i.off ? h('span', { class: 'hl-start-off', text: 'off' }) : null,
      h('span', { class: 'hl-start-where', text: i.location }),
      i.locked
        ? h('span', { class: 'hl-start-locked', title: i.locked, text: 'locked' })
        : h('button', {
          class: 'hl-start-switch', type: 'button',
          'aria-label': `${i.off ? 'Switch on' : 'Switch off'} ${i.name} at sign-in`,
          onclick: e => switchStartup(i, e.currentTarget),
        }, i.off ? 'Switch on' : 'Switch off'))));
  }

  async function loadStartup() {
    startup = await api.getStartupApps();
    if (state.view === 'health') renderStartup();
  }

  async function switchStartup(item, btn) {
    btn.disabled = true;
    let r;
    try { r = await api.setStartupApp(item.id, !item.off); } finally { btn.disabled = false; }
    if (!r?.ok) return SB.toast(r?.error || "Couldn't switch that one.");
    SB.toast(r.off ? `${r.name} won't start with Windows now` : `${r.name} starts with Windows again`);
    if (r.list) startup = r.list;
    if (state.view === 'health') renderStartup();
  }

  // ------------------------------------------------------------ settings + log

  function renderSettings() {
    const st = view?.settings || {};
    $('hlEnabledToggle').checked = !!st.enabled;
    $('hlMoodsToggle').checked = !!st.moods;
    $('hlNotifyToggle').checked = !!st.notify;
    $('hlSpaceToggle').checked = !!st.space;
    $('hlNotifyToggle').closest('label').title = state.settings.notifications ? '' : 'Notifications are off in Settings';
    for (const input of $('hlThresholds').querySelectorAll('input')) {
      if (document.activeElement !== input) input.value = st[input.dataset.key] ?? '';
    }
    setText($('hlSettingsSum'), !view ? '' : !st.enabled ? 'off'
      : `GPU ${st.gpuWarn}° · CPU ${st.cpuWarn}° · memory ${st.ramWarn}%${st.notify ? '' : ' · no notifications'}`);
  }

  // Which graph an alert can be shown on: the history key its check writes.
  function sparkKeyOf(id) {
    if (id === 'cpu-temp') return 'cpuT';
    if (id === 'ram') return 'ram';
    if (id.startsWith('gpu-temp:')) return `gpuT${Number(id.slice(9)) || ''}`;
    if (id.startsWith('storage-temp:')) return `stT${id.slice(13)}`;
    return null;
  }

  function renderLog() {
    const log = view?.log || [];
    $('hlClearLog').hidden = !log.length;
    // Times are relative, so the list is redrawn once a minute at most.
    if (!changed('log', `${log.length}|${log[0]?.at}|${Math.floor(Date.now() / MIN)}`)) return;
    if (!log.length) {
      $('hlLog').replaceChildren(h('li', { class: 'hl-empty', text: "No alerts yet. Shellby's keeping an eye out." }));
      return;
    }
    $('hlLog').replaceChildren(...log.slice(0, 15).map(e => {
      const up = ['ok', 'warn', 'critical'].indexOf(e.to) > ['ok', 'warn', 'critical'].indexOf(e.from);
      const where = sparkKeyOf(String(e.id)) ? 'on its graph' : e.kind === 'disk' ? 'in Drives' : e.kind === 'reclaim' ? 'in Developer clutter' : null;
      const inner = [
        h('span', { class: 'hl-logdot', 'aria-hidden': 'true' }),
        h('span', { class: 'hl-logtitle', text: e.title }),
        h('time', { text: SB.relTime(e.at), title: new Date(e.at).toLocaleString() }),
      ];
      return h('li', { class: `hl-logrow ${up ? e.to : 'recovered'}` }, where
        ? h('button', { class: 'hl-logbtn', type: 'button', title: `Show ${where}`, onclick: () => showAlert(e) }, inner)
        : inner);
    }));
  }

  /** Take an alert from the log to where it happened: its graph, its drive, or the clutter card. */
  function showAlert(e) {
    const id = String(e.id);
    if (!sparkKeyOf(id)) {
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

  function renderBadge() {
    const b = $('healthBadge');
    const worst = view?.settings?.enabled ? view.worst : 'ok';
    b.hidden = !worst || worst === 'ok';
    b.classList.toggle('critical', worst === 'critical');
    b.classList.toggle('warn', worst === 'warn');
  }

  function render() {
    renderBadge();
    if (state.view !== 'health') return;
    renderHero();
    renderSelf();
    renderHogs();
    renderGauges();
    renderFans();
    renderDisks();
    renderSpace();
    renderSources();
    renderSettings();
    renderLog();
  }

  // ------------------------------------------------------------ actions

  async function ask(checkId) {
    const r = await api.askAboutHealth(checkId);
    if (r?.needsClaude) return SB.claudeUpsell('health');
    if (!r?.ok) return SB.toast(r?.error || "Couldn't start that.");
    SB.setView('chat');
    SB.toast('Shellby is looking into it');
  }

  async function askStartup() {
    const r = await api.askAboutStartup();
    if (r?.needsClaude) return SB.claudeUpsell('health');
    if (!r?.ok) return SB.toast(r?.error || "Couldn't start that.");
    SB.setView('chat');
    SB.toast('Shellby is going through your startup list');
  }

  async function save(patch) {
    view = await api.setHealth(patch);
    render();
  }

  $('hlAsk').addEventListener('click', e => ask(e.currentTarget.dataset.check));
  $('hlAskSpace').addEventListener('click', () => ask('reclaim'));
  $('hlEnable').addEventListener('click', () => save({ enabled: true }));
  $('hlRecheck').addEventListener('click', async () => { view = await api.recheckHealth(); render(); SB.toast('Checked every sensor again'); });
  $('hlCheckLhm').addEventListener('click', async () => {
    view = await api.recheckHealth();
    render();
    const st = view.sources?.lhm;
    SB.toast(st === 'ok' ? 'Found it! CPU temperature is on.' : st === 'auth' ? 'LHM wants a password; turn off its authentication.' : `Nothing answering on port ${view.settings.lhmPort} yet.`);
  });
  // Hand the whole LHM setup to Claude. The box is filled in, not sent: it runs
  // winget and an elevated program, so you see what you're agreeing to first.
  $('hlClaudeLhm').addEventListener('click', () => {
    if (SB.isCrabOnly()) return SB.claudeUpsell('lhm');
    const port = view?.settings?.lhmPort || 8085;
    SB.prefillNew([
      'Set up LibreHardwareMonitor so Shellby can read my CPU temperature from its local web server.',
      '1. If it isn\'t installed, install it with `winget install --id LibreHardwareMonitor.LibreHardwareMonitor -e --accept-source-agreements --accept-package-agreements`, then find where LibreHardwareMonitor.exe ended up.',
      `2. Make sure LHM isn't running, then in LibreHardwareMonitor.config (next to the exe; run LHM once and close it if the file isn't there yet) turn on the remote web server on port ${port} with no authentication, and set it to start minimized to the tray. Read the file first and use the setting names it already has.`,
      '3. Start it as administrator (`Start-Process -Verb RunAs`); I\'ll accept the Windows prompt.',
      `4. Check that http://127.0.0.1:${port}/data.json answers, and tell me if anything needs me to click something in LHM.`,
      'Ask me before making LHM run at Windows startup.',
    ].join('\n') + '\n');
  });
  $('hlGetLhm').addEventListener('click', () => api.openExternal('https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases/latest'));
  $('hlPort').addEventListener('change', e => save({ lhmPort: Number(e.target.value) }));
  $('hlEnabledToggle').addEventListener('change', e => save({ enabled: e.target.checked }));
  $('hlMoodsToggle').addEventListener('change', e => save({ moods: e.target.checked }));
  $('hlNotifyToggle').addEventListener('change', e => save({ notify: e.target.checked }));
  $('hlSpaceToggle').addEventListener('change', e => save({ space: e.target.checked }));
  $('hlThresholds').addEventListener('input', e => {
    const input = e.target.closest('input[data-key]');
    if (!input || input.value === '') return;
    clearTimeout(saveTimer);
    // Debounced, and the main process clamps to the allowed range.
    saveTimer = setTimeout(() => save({ [input.dataset.key]: Number(input.value) }), 500);
  });
  $('hlThresholds').addEventListener('focusout', () => renderSettings());
  $('hlAskStartup').addEventListener('click', askStartup);
  $('hlHogsSeg').addEventListener('click', e => {
    const b = e.target.closest('button[data-metric]');
    if (!b) return;
    hogMetric = b.dataset.metric;
    renderHogs();
  });
  $('hlHogsGroup').addEventListener('click', e => {
    const b = e.target.closest('button[data-group]');
    if (!b) return;
    hogMode = b.dataset.group;
    renderHogs();
  });
  $('hlHogsOpen').addEventListener('click', () => { hogsOpen = true; hogsAt = 0; renderHogs(); $('hlHogsSeg').querySelector('[aria-selected="true"]')?.focus(); });
  $('hlHogsClose').addEventListener('click', () => { hogsOpen = false; renderHogs(); $('hlHogsOpen').focus(); });
  $('hlHogsRefresh').addEventListener('click', () => { hogsAt = 0; renderHogs(); });
  $('hlSelfSettings').addEventListener('click', () => { if (view?.self?.jump) SB.jumpToSettingByName(view.self.jump); });
  $('hlRange').addEventListener('click', e => {
    const b = e.target.closest('button[data-range]');
    if (b) setRange(Number(b.dataset.range));
  });
  $('hlClearLog').addEventListener('click', async () => { view = await api.clearHealthLog(); render(); });

  // ------------------------------------------------------------ live updates

  api.onHealth(snap => {
    // Live samples carry no history, only the point this sample added to main's.
    const { point, ...rest } = snap;
    view = { ...view, ...rest, history: undefined };
    if (point && point.at !== history[history.length - 1]?.at) {
      history.push(point);
      if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
    }
    render();
  });
  api.onHealthLog(log => { if (view) { view.log = log; if (state.view === 'health') renderLog(); } });

  async function load() {
    view = await api.getHealth();
    // Keep any live points that arrived while this was on its way.
    const base = view.history || [];
    const last = base[base.length - 1]?.at ?? -Infinity;
    history = [...base, ...history.filter(p => p.at > last)].slice(-HISTORY_MAX);
    render();
  }

  SB.views.health = {
    render: () => {
      renderCrab();
      api.healthViewed();
      load();
      loadStartup();
    },
  };
  SB.refreshHealthCrab = () => { if (state.view === 'health') renderCrab(); };
  // The titlebar badge needs a first reading even if the view is never opened.
  setTimeout(() => api.getHealth().then(v => { view = v; history = v.history || []; renderBadge(); }), 1500);
})();
