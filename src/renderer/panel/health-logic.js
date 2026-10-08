// The Health screen's words and numbers (health.js and the files beside it
// draw them): sizes, the hero's verdict, each gauge's spec, the graphs' paths
// and ranges, developer clutter, the sensor list, what's using the machine,
// the startup list and the alert log. Pure, no DOM. Works in the browser and
// in Node (for tests).
(function (root) {
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;

  const fmt = (v, digits = 0) => (Number.isFinite(v) ? v.toFixed(digits) : '—');
  const gb = n => {
    if (!Number.isFinite(n)) return '?';
    const g = n / GB;
    return g >= 1000 ? `${(g / 1024).toFixed(1)} TB` : g >= 100 ? `${Math.round(g)} GB` : `${g.toFixed(g < 10 ? 1 : 0)} GB`;
  };
  const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

  // ------------------------------------------------------------ the hero

  const warnFor = (kind, t) => (kind === 'gpu-temp' ? t.gpuWarn : kind === 'storage-temp' ? t.storageWarn : t.cpuWarn);
  const named = r => `${r.label || 'It'}${r.kind === 'storage-temp' && r.model ? ` (${r.model})` : ''}`;

  // The verdict, worded from the check's own reading: every kind main can
  // raise reads right, including ones without a gauge of their own.
  function heroCopy(mood, reading, t) {
    const r = reading || {};
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

  // All calm: the headline numbers, then that he's watching.
  function calmLine(s) {
    const bits = [
      s.gpus[0]?.temp != null && `GPU ${Math.round(s.gpus[0].temp)}°C`,
      s.cpu.temp != null && `CPU ${Math.round(s.cpu.temp)}°C`,
      s.ram && `memory ${Math.round(s.ram.pct)}%`,
    ].filter(Boolean);
    return `${bits.join(' · ')}${bits.length ? '. ' : ''}Shellby's keeping an eye on things.`;
  }

  // The hero's words for a snapshot (null before the first): { eyebrow, title,
  // sub, ask }, ask being { check, text } when there's something to ask about.
  function heroWords(view) {
    if (view && !view.settings?.enabled) {
      return { eyebrow: 'Vitals', title: 'Health checks are off', sub: "Shellby isn't watching temperatures, memory or drives right now.", ask: null };
    }
    if (!view?.sample) return { eyebrow: 'Vitals', title: 'Taking a first reading…', sub: '', ask: null };
    if (view.mood) {
      const copy = heroCopy(view.mood, view.checks?.[view.mood.id]?.reading || null, view.thresholds || {});
      return {
        eyebrow: view.mood.level === 'critical' ? 'Needs attention' : 'Heads up',
        title: copy.title, sub: copy.line, ask: { check: view.mood.id, text: copy.ask || 'Ask Shellby why' },
      };
    }
    return { eyebrow: 'Vitals', title: 'All calm', sub: calmLine(view.sample), ask: null };
  }

  // ------------------------------------------------------------ gauges

  const shortGpu = name => String(name || '').replace(/^NVIDIA GeForce |^AMD Radeon /, '');
  const shortCpu = name => (name ? name.replace(/\s+\d+-Core Processor$/i, '').replace(/^AMD |^Intel\(R\) /, '') : null);
  const watts = w => (Number.isFinite(w) && w > 0 ? `${Math.round(w)} W` : null);
  const join = (...bits) => bits.filter(Boolean).join(' · ') || null;

  // A card per sensor, in the order they show. check(key) -> { level, pending }.
  function gaugeSpecs(s, t, check) {
    const specs = [];
    const many = s.gpus.length > 1;
    const tempRange = (warn, floor = 25) => ({ min: floor, max: Math.max(100, warn + 12), warn });
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

  // ------------------------------------------------------------ the graphs

  // The points inside the graph's window, which ends at the newest point.
  function windowOf(points, key, rangeMs) {
    const now = points.length ? points[points.length - 1].at : Date.now();
    const pts = points.filter(p => p.at >= now - rangeMs && Number.isFinite(p[key]));
    return { now, pts };
  }

  // Where a value and a time land in the graph's 100 × 30 view box.
  const sparkY = (v, min, max) => 30 - ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * 28 - 1;
  const sparkX = (at, now, rangeMs) => 100 - ((now - at) / rangeMs) * 100;

  // The line and the area under it, as SVG paths; null with fewer than two points.
  function sparkPaths(pts, key, now, { min, max }, rangeMs) {
    if (pts.length < 2) return null;
    const x = at => sparkX(at, now, rangeMs);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(2)},${sparkY(p[key], min, max).toFixed(2)}`).join(' ');
    const area = `${line} L${x(pts[pts.length - 1].at).toFixed(2)},30 L${x(pts[0].at).toFixed(2)},30 Z`;
    return { line, area };
  }

  /** "↓52° ↑84°": lowest and highest in the graph's window, or '' without enough points. */
  function stats(points, key, unit, rangeMs) {
    const { pts } = windowOf(points, key, rangeMs);
    if (pts.length < 2) return '';
    const vals = pts.map(p => p[key]);
    const r = v => `${Math.round(v)}${unit}`;
    return `↓${r(Math.min(...vals))} ↑${r(Math.max(...vals))}`;
  }

  // Which graph an alert can be shown on: the history key its check writes.
  function sparkKeyOf(id) {
    if (id === 'cpu-temp') return 'cpuT';
    if (id === 'ram') return 'ram';
    if (id.startsWith('gpu-temp:')) return `gpuT${Number(id.slice(9)) || ''}`;
    if (id.startsWith('storage-temp:')) return `stT${id.slice(13)}`;
    return null;
  }

  // ------------------------------------------------------------ developer clutter and sensors

  // shortPath: SB.shortPath, for the cache folders.
  function spaceRows(sp, shortPath) {
    const rows = [];
    if (sp.docker?.reclaimable > 0) {
      rows.push({ name: 'Docker', detail: `unused, of ${gb(sp.docker.size)} in all`, size: sp.docker.reclaimable, title: sp.docker.rows.map(r => `${r.type}: ${gb(r.reclaimable)} of ${gb(r.size)}`).join('\n') });
    }
    for (const c of sp.caches || []) {
      rows.push({ name: `${c.name} cache`, detail: shortPath(c.dir), size: c.size, partial: c.partial, title: c.dir });
    }
    for (const i of sp.images || []) {
      rows.push({ name: i.name, detail: "virtual disk, doesn't shrink on its own", size: i.size, image: true, title: i.file });
    }
    return rows;
  }

  // Where each reading comes from: rows of [ok (true, false or null for n/a),
  // title, detail], whether CPU temperature still needs setting up, and the fold's summary.
  function sources(view) {
    const s = view?.sample;
    const src = view?.sources || {};
    const g = s?.gpus?.[0];
    const app = src.app === 'hwinfo' ? 'HWiNFO' : 'LibreHardwareMonitor';
    const lhmText = { ok: `reading from ${app}`, auth: 'LibreHardwareMonitor wants a password', off: 'needs LibreHardwareMonitor', unknown: 'checking…' }[src.lhm] || 'checking…';
    const rows = [
      [!!src.gpuTemp, 'GPU', g ? `${g.name} · via ${g.vendor === 'nvidia' && src.nvidia ? 'nvidia-smi' : app}` : 'no NVIDIA GPU found (AMD and Intel GPUs need LibreHardwareMonitor)'],
      [src.cpuTemp ? true : src.lhm === 'unknown' ? null : false, 'CPU temperature', s?.cpu?.temp != null ? `${s.cpu.name || 'CPU'} · ${lhmText}` : lhmText],
      [src.storage ? true : null, 'Drive temperatures and fans', src.storage || src.fans ? `${plural(s.storage.length, 'drive')}, ${plural(s.fans.length, 'fan')} · ${lhmText}` : `none reported · ${lhmText}`],
      [true, 'Memory, CPU load and drives', 'built into Windows'],
    ];
    const needsSetup = !!(view?.sample && !src.cpuTemp);
    const summary = !view?.sample ? '' : needsSetup ? 'CPU temperature needs setting up' : `reading from ${app}${src.nvidia ? ' and nvidia-smi' : ''}`;
    return { rows, needsSetup, summary };
  }

  // ------------------------------------------------------------ what's using it

  const HOG_MOODS = new Set(['hot', 'scorching', 'dizzy']);
  const metricOf = id => (String(id).startsWith('gpu-temp') ? 'gpu' : id === 'cpu-temp' ? 'cpu' : id === 'ram' ? 'mem' : null);
  const METRIC_LABEL = { cpu: 'CPU', gpu: 'GPU', mem: 'memory' };
  const size = n => (n >= GB ? gb(n) : `${Math.max(1, Math.round(n / MB))} MB`);
  const pct = v => `${fmt(v, v > 0 && v < 10 ? 1 : 0)}%`;

  // While he sweats or is dizzy the list opens itself, on what he's reacting to.
  function hogsAuto(view) {
    const m = view?.settings?.enabled && view?.mood;
    return m && HOG_MOODS.has(m.mood) ? metricOf(m.id) : null;
  }

  // One row of the list: an app (its processes added up) or a single process.
  function hogWords(p, metric, isGroup, ramTotal) {
    const share = metric === 'mem' ? (ramTotal ? p.mem / ramTotal : 0) : p[metric] / 100;
    const many = isGroup && p.count > 1;
    const owned = isGroup ? p.owned : p.owned ? 1 : 0;
    return {
      key: isGroup ? `app:${p.name.toLowerCase()}` : `pid:${p.pid}`,
      title: isGroup ? `${p.name}: ${plural(p.count, 'process', 'processes')}` : `${p.name} (process ${p.pid})`,
      who: many ? `all ${p.count} ${p.name} processes` : isGroup ? p.name : `${p.name} (process ${p.pid})`,
      rest: [
        metric !== 'cpu' && `CPU ${pct(p.cpu)}`,
        metric !== 'gpu' && p.gpu != null && `GPU ${pct(p.gpu)}`,
        metric !== 'mem' && size(p.mem),
      ].filter(Boolean).join(' · '),
      value: metric === 'mem' ? size(p.mem) : pct(p[metric]),
      share: Math.min(1, Math.max(0, share)),
      many,
      owned,
      ownedText: many && owned < p.count ? `${owned} Shellby task` : 'Shellby task',
      end: many ? 'End all' : 'End task',
    };
  }

  // What ending every process of an app did.
  function endedLine(name, r) {
    const bits = [r.ended && `Ended ${r.ended} ${name}`, r.gone && `${r.gone} had already closed`, r.failed && `${r.failed} wouldn't end`].filter(Boolean);
    return bits.join(', ') || `${name} had already closed`;
  }

  // ------------------------------------------------------------ startup, settings and the log

  function startupSummary(items) {
    const on = items.filter(i => !i.off).length;
    const off = items.length - on;
    return on
      ? `${plural(on, 'thing')} start${on === 1 ? 's' : ''} when you sign in${off ? `, and ${off} you've switched off` : ''}.`
      : `Nothing starts when you sign in${off ? ` (${off} switched off)` : ''}.`;
  }

  function settingsSummary(view) {
    const st = view?.settings || {};
    if (!view) return '';
    if (!st.enabled) return 'off';
    return `GPU ${st.gpuWarn}° · CPU ${st.cpuWarn}° · memory ${st.ramWarn}%${st.notify ? '' : ' · no notifications'}`;
  }

  const LEVELS = ['ok', 'warn', 'critical'];

  // An alert in the log: whether it got worse, and where it can be shown (null: nowhere).
  function logEntry(e) {
    const up = LEVELS.indexOf(e.to) > LEVELS.indexOf(e.from);
    const where = sparkKeyOf(String(e.id)) ? 'on its graph' : e.kind === 'disk' ? 'in Drives' : e.kind === 'reclaim' ? 'in Developer clutter' : null;
    return { up, where };
  }

  const api = {
    GB, fmt, gb, heroCopy, calmLine, heroWords, gaugeSpecs, windowOf, sparkX, sparkY, sparkPaths, stats, sparkKeyOf,
    spaceRows, sources, metricOf, METRIC_LABEL, size, pct, hogsAuto, hogWords, endedLine, startupSummary, settingsSummary, logEntry,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbyHealthLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
