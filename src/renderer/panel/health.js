/* Shellby panel — Health: live vitals, drives, sensor setup and alert settings. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const NS = 'http://www.w3.org/2000/svg';
  const SPARK_MS = 10 * 60 * 1000;   // sparklines show the last 10 minutes
  const HISTORY_MAX = 720;           // matches the monitor's hour of 5 s samples
  const GB = 1024 ** 3;

  let view = null;                   // last snapshot from main (see health/service.js view())
  let history = [];
  let fx = null;
  let saveTimer = null;
  const HOGS_REFRESH_MS = 30 * 1000; // the process list is a ~3 s read; don't add to the heat
  let hogs = null;                   // { ok, metric, procs } from main
  let hogsAt = 0;
  let hogsLoading = false;
  let hogMetric = null;              // the user's pick; null follows the mood
  let drawnHogs = null;              // the result the list shows, so 5 s samples don't rebuild it
  let startup = null;                // { ok, items } from main

  const levelOf = id => view?.checks?.[id]?.level || 'ok';
  const pendingOf = id => view?.checks?.[id]?.pending || null;
  const fmt = (v, digits = 0) => (Number.isFinite(v) ? v.toFixed(digits) : '—');
  const gb = n => {
    if (!Number.isFinite(n)) return '?';
    const g = n / GB;
    return g >= 1000 ? `${(g / 1024).toFixed(1)} TB` : g >= 100 ? `${Math.round(g)} GB` : `${g.toFixed(g < 10 ? 1 : 0)} GB`;
  };

  // ------------------------------------------------------------ sparkline

  function sparkline(points, key, { min, max, warn }) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 30');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'hl-spark');
    svg.setAttribute('aria-hidden', 'true');
    const now = points.length ? points[points.length - 1].at : Date.now();
    const pts = points.filter(p => p.at >= now - SPARK_MS && Number.isFinite(p[key]));
    const y = v => 30 - ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * 28 - 1;
    const x = at => 100 - ((now - at) / SPARK_MS) * 100;
    if (warn != null && warn > min && warn < max) {
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', 0); line.setAttribute('x2', 100);
      line.setAttribute('y1', y(warn)); line.setAttribute('y2', y(warn));
      line.setAttribute('class', 'hl-spark-warn');
      svg.append(line);
    }
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
    return svg;
  }

  // ------------------------------------------------------------ hero

  const MOOD_COPY = {
    hot: { title: 'Running hot', line: (r, t) => `${r.label} is at ${Math.round(r.value)}°C, over your ${t}°C line. Shellby is fanning himself.` },
    scorching: { title: 'Overheating!', line: (r, t) => `${r.label} is at ${Math.round(r.value)}°C, ${Math.round(r.value - t)}°C past your warning. Check what's using it.` },
    dizzy: { title: "Memory's nearly full", line: r => `${Math.round(r.value)}% of ${gb(r.total)} in use. Shellby is seeing stars.` },
    stuffed: { title: (r) => `${r.drive} is filling up`, line: r => `Only ${gb(r.value * GB)} left. Junk is spilling out of his shell.` },
  };

  function readingFor(id) {
    const s = view?.sample;
    if (!s || !id) return null;
    if (id.startsWith('gpu-temp:')) { const g = s.gpus[Number(id.slice(9))]; return g && { label: s.gpus.length > 1 ? `GPU ${Number(id.slice(9)) + 1}` : 'GPU', value: g.temp }; }
    if (id === 'cpu-temp') return { label: 'CPU', value: s.cpu.temp };
    if (id === 'ram') return s.ram && { value: s.ram.pct, total: s.ram.total };
    if (id.startsWith('disk:')) { const d = s.disks.find(x => `disk:${x.id}` === id); return d && { drive: d.id, value: d.free / GB, total: d.total }; }
    return null;
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
      const r = readingFor(view.mood.id) || {};
      const copy = MOOD_COPY[view.mood.mood];
      const warnLine = view.mood.id === 'cpu-temp' ? t.cpuWarn : t.gpuWarn;
      eyebrow = view.mood.level === 'critical' ? 'Needs attention' : 'Heads up';
      title = typeof copy.title === 'function' ? copy.title(r) : copy.title;
      sub = copy.line(r, warnLine);
      $('hlAsk').hidden = false;
      $('hlAsk').dataset.check = view.mood.id;
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
    $('hlEyebrow').textContent = eyebrow;
    $('hlTitle').textContent = title;
    $('hlSub').textContent = sub;
    fx?.set(mood?.mood || null);
  }

  function renderCrab() {
    // fit:false keeps the sprite's view box on the crab itself, which the
    // health overlays are positioned against (hats just overflow upwards).
    $('hlSprite').replaceChildren(SB.sprite(state.skin, { fit: false }));
    if (!fx) fx = window.ShellbyHealthFx.mount($('hlFx'), $('hlHero'));
  }

  // ------------------------------------------------------------ gauges

  function gauge({ id, label, value, unit, digits = 0, sub, spark, level = 'ok', pending, missing, askable }) {
    return h('article', { class: `hl-gauge lvl-${level}${missing ? ' missing' : ''}`, dataset: { id: id || '' } },
      h('header', {},
        h('span', { class: 'hl-glabel', text: label }),
        pending && level === 'ok' ? h('span', { class: 'hl-watch', title: 'Over the line; Shellby reacts if it stays there', text: 'watching' }) : null,
        level === 'critical' ? h('span', { class: 'hl-pill critical', title: 'Very high' }, h('span', { class: 'hl-pill-very', text: 'very ' }), 'high') : null,
        level === 'warn' ? h('span', { class: 'hl-pill warn', text: 'high' }) : null),
      h('div', { class: 'hl-value' }, missing ? h('span', { class: 'hl-dash', text: '—' }) : [fmt(value, digits), h('small', { text: unit })]),
      h('div', { class: 'hl-gsub' }, missing || sub || ' '),
      spark || h('div', { class: 'hl-spark empty' }),
      askable && level !== 'ok' ? h('button', { class: 'hl-mini', type: 'button', onclick: () => ask(id) }, 'Ask Shellby why') : null);
  }

  function renderGauges() {
    const box = $('hlGauges');
    const s = view?.sample;
    if (!s) { box.replaceChildren(); return; }
    const t = view.thresholds;
    const g = s.gpus[0];
    const cards = [];
    const tempRange = warn => ({ min: 25, max: Math.max(100, warn + 12), warn });
    cards.push(gauge({
      id: 'gpu-temp:0', label: 'GPU temp', value: g?.temp, unit: '°C', askable: true,
      sub: g ? g.name.replace(/^NVIDIA GeForce /, '') : null,
      missing: g?.temp == null ? (g ? 'No temperature reading' : 'No supported GPU found') : null,
      level: levelOf('gpu-temp:0'), pending: pendingOf('gpu-temp:0'),
      spark: g?.temp != null ? sparkline(history, 'gpuT', tempRange(t.gpuWarn)) : null,
    }));
    cards.push(gauge({
      id: 'cpu-temp', label: 'CPU temp', value: s.cpu.temp, unit: '°C', askable: true,
      sub: s.cpu.name ? s.cpu.name.replace(/\s+\d+-Core Processor$/i, '').replace(/^AMD |^Intel\(R\) /, '') : null,
      missing: s.cpu.temp == null ? h('button', { class: 'hl-link', type: 'button', onclick: () => $('hlSetup').scrollIntoView({ behavior: 'smooth', block: 'center' }) }, 'Set up CPU temperature →') : null,
      level: levelOf('cpu-temp'), pending: pendingOf('cpu-temp'),
      spark: s.cpu.temp != null ? sparkline(history, 'cpuT', tempRange(t.cpuWarn)) : null,
    }));
    cards.push(gauge({
      id: 'ram', label: 'Memory', value: s.ram?.pct, unit: '%', askable: true,
      sub: s.ram ? `${gb(s.ram.used)} of ${gb(s.ram.total)}` : null,
      level: levelOf('ram'), pending: pendingOf('ram'),
      spark: sparkline(history, 'ram', { min: 0, max: 100, warn: t.ramWarn }),
    }));
    cards.push(gauge({
      label: 'CPU load', value: s.cpu.load, unit: '%',
      sub: 'all cores',
      spark: sparkline(history, 'cpu', { min: 0, max: 100 }),
    }));
    if (g) {
      cards.push(gauge({
        label: 'GPU load', value: g.load, unit: '%',
        sub: g.memTotal ? `VRAM ${(g.memUsed / 1024).toFixed(1)} / ${(g.memTotal / 1024).toFixed(0)} GB` : null,
        missing: g.load == null ? 'Not reported' : null,
        spark: g.load != null ? sparkline(history, 'gpu', { min: 0, max: 100 }) : null,
      }));
    }
    box.replaceChildren(...cards);
  }

  // ------------------------------------------------------------ drives

  function renderDisks() {
    const disks = view?.sample?.disks || [];
    if (!disks.length) {
      $('hlDisks').replaceChildren(h('li', { class: 'hl-empty', text: view?.sample ? 'No local drives found.' : 'Reading drives…' }));
      return;
    }
    $('hlDisks').replaceChildren(...disks.map(d => {
      const id = `disk:${d.id}`;
      const level = levelOf(id);
      const used = d.total ? 1 - d.free / d.total : 0;
      return h('li', { class: `hl-disk lvl-${level}` },
        h('div', { class: 'hl-disk-top' },
          h('b', { text: d.id }), h('span', { class: 'hl-disk-label', text: d.label || 'Local disk' }),
          h('span', { class: 'hl-disk-free' }, h('b', { text: gb(d.free) }), ` free of ${gb(d.total)}`)),
        h('div', { class: 'hl-bar', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(used * 100), 'aria-label': `${d.id} ${Math.round(used * 100)}% full` },
          h('span', { style: `transform: scaleX(${used.toFixed(4)})` })),
        level !== 'ok' ? h('button', { class: 'hl-mini', type: 'button', onclick: () => ask(id) }, 'Ask Shellby what to clean up') : null);
    }));
  }

  // ------------------------------------------------------------ sensors

  function renderSources() {
    const s = view?.sample;
    const src = view?.sources || {};
    const g = s?.gpus?.[0];
    const row = (ok, title, detail) => h('li', { class: `hl-src ${ok === true ? 'ok' : ok === false ? 'off' : 'na'}` },
      h('span', { class: 'hl-src-dot', 'aria-hidden': 'true' }), h('div', {}, h('b', { text: title }), h('span', { text: detail })));
    const lhmText = { ok: 'reading from LibreHardwareMonitor', auth: 'LibreHardwareMonitor wants a password', off: 'needs LibreHardwareMonitor', unknown: 'checking…' }[src.lhm] || 'checking…';
    $('hlSources').replaceChildren(
      row(!!src.gpuTemp, 'GPU', g ? `${g.name} · via ${g.vendor === 'nvidia' && src.nvidia ? 'nvidia-smi' : 'LibreHardwareMonitor'}` : 'no NVIDIA GPU found (AMD and Intel GPUs need LibreHardwareMonitor)'),
      row(src.cpuTemp ? true : src.lhm === 'unknown' ? null : false, 'CPU temperature', s?.cpu?.temp != null ? `${s.cpu.name || 'CPU'} · ${lhmText}` : lhmText),
      row(true, 'Memory, CPU load and drives', 'built into Windows'),
    );
    const needsSetup = view?.sample && !src.cpuTemp;
    $('hlSetup').hidden = !needsSetup;
    $('hlAuth').hidden = src.lhm !== 'auth';
    if (document.activeElement !== $('hlPort')) $('hlPort').value = view?.settings?.lhmPort || 8085;
  }

  // ------------------------------------------------------------ what's hogging it

  const HOG_MOODS = new Set(['hot', 'scorching', 'dizzy']);
  const METRIC_OF = id => (String(id).startsWith('gpu-temp') ? 'gpu' : id === 'cpu-temp' ? 'cpu' : id === 'ram' ? 'mem' : null);
  const METRIC_LABEL = { cpu: 'CPU', gpu: 'GPU', mem: 'memory' };
  const size = n => (n >= GB ? gb(n) : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`);
  const pct = v => `${fmt(v, v > 0 && v < 10 ? 1 : 0)}%`;

  // Only while he sweats or is dizzy: that's when "why?" is the next question.
  function hogsWanted() {
    const m = view?.settings?.enabled && view?.mood;
    return m && HOG_MOODS.has(m.mood) ? METRIC_OF(m.id) : null;
  }

  function renderHogs() {
    const auto = hogsWanted();
    $('hlHogs').hidden = !auto;
    if (!auto) { hogMetric = null; drawnHogs = null; return; }
    const metric = hogMetric || auto;
    const noGpu = hogs?.procs?.length > 0 && hogs.procs.every(p => p.gpu == null);
    for (const b of $('hlHogsSeg').querySelectorAll('button')) {
      b.setAttribute('aria-selected', String(b.dataset.metric === metric));
      b.hidden = b.dataset.metric === 'gpu' && noGpu;
    }
    if (hogs?.metric !== metric || Date.now() - hogsAt > HOGS_REFRESH_MS) loadHogs(metric);
    const list = $('hlHogList');
    if (!hogs || hogs.metric !== metric) {
      drawnHogs = null;
      list.replaceChildren(h('li', { class: 'hl-empty', text: "Looking at what's running…" }));
      return;
    }
    if (drawnHogs === hogs) return;
    drawnHogs = hogs;
    if (!hogs.ok) return list.replaceChildren(h('li', { class: 'hl-empty', text: hogs.error }));
    if (!hogs.procs.length) return list.replaceChildren(h('li', { class: 'hl-empty', text: `Nothing is using much ${METRIC_LABEL[metric]} right now.` }));
    const ramTotal = view?.sample?.ram?.total || 0;
    list.replaceChildren(...hogs.procs.map(p => hogRow(p, metric, ramTotal)));
  }

  function hogRow(p, metric, ramTotal) {
    const share = metric === 'mem' ? (ramTotal ? p.mem / ramTotal : 0) : p[metric] / 100;
    const rest = [
      metric !== 'cpu' && `CPU ${pct(p.cpu)}`,
      metric !== 'gpu' && p.gpu != null && `GPU ${pct(p.gpu)}`,
      metric !== 'mem' && size(p.mem),
    ].filter(Boolean).join(' · ');
    return h('li', { class: 'hl-hog' },
      h('div', { class: 'hl-hog-top' },
        h('b', { class: 'hl-hog-name', text: p.name, title: `${p.name} (process ${p.pid})` }),
        h('span', { class: 'hl-hog-rest', text: rest }),
        h('span', { class: 'hl-hog-val', text: metric === 'mem' ? size(p.mem) : pct(p[metric]) })),
      h('div', { class: 'hl-hog-bar', 'aria-hidden': 'true' }, h('span', { style: `transform: scaleX(${Math.min(1, Math.max(0, share)).toFixed(4)})` })),
      p.locked
        ? h('span', { class: 'hl-hog-locked', title: p.locked, text: 'protected' })
        : h('button', { class: 'hl-hog-end', type: 'button', 'aria-label': `End ${p.name} (process ${p.pid})`, onclick: e => endTask(p, e.currentTarget) }, 'End task'));
  }

  async function loadHogs(metric) {
    if (hogsLoading) return;
    hogsLoading = true;
    try {
      hogs = await api.getHogs(metric);
      hogsAt = Date.now();
    } finally {
      hogsLoading = false;
    }
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
    $('hlNotifyToggle').closest('label').title = state.settings.notifications ? '' : 'Notifications are off in Settings';
    for (const input of $('hlThresholds').querySelectorAll('input')) {
      if (document.activeElement !== input) input.value = st[input.dataset.key] ?? '';
    }
  }

  function renderLog() {
    const log = view?.log || [];
    $('hlClearLog').hidden = !log.length;
    if (!log.length) {
      $('hlLog').replaceChildren(h('li', { class: 'hl-empty', text: "No alerts yet. Shellby's keeping an eye out." }));
      return;
    }
    $('hlLog').replaceChildren(...log.slice(0, 15).map(e => {
      const up = ['ok', 'warn', 'critical'].indexOf(e.to) > ['ok', 'warn', 'critical'].indexOf(e.from);
      return h('li', { class: `hl-logrow ${up ? e.to : 'recovered'}` },
        h('span', { class: 'hl-logdot', 'aria-hidden': 'true' }),
        h('span', { class: 'hl-logtitle', text: e.title }),
        h('time', { text: SB.relTime(e.at), title: new Date(e.at).toLocaleString() }));
    }));
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
    renderHogs();
    renderGauges();
    renderDisks();
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
    SB.prefill([
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
  $('hlHogsRefresh').addEventListener('click', () => { hogsAt = 0; renderHogs(); });
  $('hlClearLog').addEventListener('click', async () => { view = await api.clearHealthLog(); render(); });

  // ------------------------------------------------------------ live updates

  api.onHealth(snap => {
    // Live samples carry no history; extend ours with the same compact point the monitor keeps.
    view = { ...view, ...snap, history: undefined };
    const s = snap.sample;
    if (s && s.at !== history[history.length - 1]?.at) {
      const g = s.gpus[0];
      const r = v => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
      history.push({ at: s.at, cpu: r(s.cpu.load), cpuT: r(s.cpu.temp), gpu: r(g?.load), gpuT: r(g?.temp), ram: r(s.ram?.pct) });
      if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
    }
    render();
  });
  api.onHealthLog(log => { if (view) { view.log = log; if (state.view === 'health') renderLog(); } });

  async function load() {
    view = await api.getHealth();
    history = view.history || [];
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
