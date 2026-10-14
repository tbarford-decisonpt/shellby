/* Shellby panel — the trail (Ctrl+Shift+E): where Claude has been in your
   files, beside the chat, with him on it. Only what he touched: what he read
   leaves footprints, what he changed is dug over with its +/−, and a search
   lights up what it found. He walks to each file as he works there, holding
   what he works with, and his helpers walk their own. Above the map: what's
   worth a look (going in circles, a change whose test nobody ran, a file that
   holds secrets). Below it: the replay, every step again, the feed following.
   It is the File manager's first tab; the second, All files, is files-dock.js's, and this file keeps the drawer they share: its tabs, width and grip.
   What it all means is shared/trail.js's (pure); this file draws it. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const T = window.ShellbyTrail;
  const W = window.ShellbyWorkPoses;

  const drawer = $('trail');
  const map = $('trailMap');
  const rowsEl = $('trailRows');
  const crabsEl = $('trailCrabs');
  const signals = $('trailSignals');
  const counts = $('trailCounts');
  const scrub = $('trailScrub');
  const playBtn = $('trailPlay');
  const liveBtn = $('trailLive');
  const toggleBtn = $('trailBtn');
  const panelEl = $('trailPanel');
  const tabBtns = [...drawer.querySelectorAll('.drawer-tabs [role="tab"]')];

  const MIN_CHAT = 340;     // what the chat keeps beside it before the panel grows
  const SCREEN_GAP = 16;    // a grown panel stays this far inside the screen (pane-room.js)
  const WALK_MS = 500;      // one walk from file to file (trail.css .walking)
  const PLAY_MS = 420;      // a step of the replay
  const PAINT_MS = 200;     // the map is drawn this often at most while items pour in
  const LANDED_MS = 2400;   // how long a step the trail sent you to stays lit
  const OPEN_KEY = 'shellby.trail.open';
  const SCOPE_KEY = 'shellby.trail.scope';
  const TAB_KEY = 'shellby.drawer.tab';  // the File manager's tab: 'trail' or 'files'
  const WIDTH_KEY = 'shellby.trail.width';
  const TRAIL_W = 272;      // its width until you drag it (trail.css --trail-w)
  const MIN_W = 220;        // narrower and the names no longer fit beside their marks
  const STEP_W = 16;        // an arrow key on its edge
  const OVER_GAP = 48;      // lying over the chat, this much of the chat stays in view
  const MAX_SIGNALS = 3;

  // Footprints, as pixel grids (shared/sprite.js grid): read, changed, found.
  const PRINTS = {
    read: { pixels: ['1.1.', '.1.1'], palette: { 1: '#7fd6c2' } },
    dug: { pixels: ['.22.', '2112'], palette: { 1: '#ff7a5c', 2: '#e2573a' } },
    seen: { pixels: ['.1.', '1.1', '.1.'], palette: { 1: '#ffc15e' } },
  };

  let open = false;
  let tabId = null;
  let scope = window.localStorage.getItem(SCOPE_KEY) === 'turn' ? 'turn' : 'all';
  let replayAt = null;      // a step number while replaying, null for now
  let playTimer = null;
  let frame = 0;            // a paint asked for, not yet run
  let active = -1;          // the row with the keyboard (aria-activedescendant)
  let rowList = [];         // what's drawn: [{ node, depth, el }]
  let landedEl = null;      // the feed's step lit by the replay
  const closed = new Map(); // tab id -> folder keys closed
  const tests = new Map();  // tab id -> { sig, map } (ipc trail:tests)
  let shows = !SB.solo && SB.pref(TAB_KEY) !== 'trail' ? 'files' : 'trail'; // the tab up when the drawer is open: All files unless the Trail was left up (a conversation's own window has none)
  const tabs = new Map(); // the drawer's other tabs: name -> { show({ focus }), hide() } (files-dock.js)
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ------------------------------------------------------------ taking items in

  // Every item of every conversation, live or replayed (feed.js render): the
  // trail is kept whether the drawer is open or not, so opening it is instant.
  SB.trailTake = (tab, item, replay) => {
    if (!tab.trail) { tab.trail = T.create(tab.cwd || state.cwd); tab.trailCwd = tab.cwd; }
    else if (tab.cwd && tab.cwd !== tab.trailCwd) { tab.trailCwd = tab.cwd; T.rebase(tab.trail, tab.cwd); } // moved into its own copy
    if (!T.apply(tab.trail, item)) return;
    if (!open || tab.id !== tabId) return;
    if (!replay && item.kind === 'result') tests.delete(tab.id); // a finished turn: its tests asked after again
    schedule();
  };

  // Its feed started over (feed.js wipe: rewind, /clear): so does what's shown of its trail.
  SB.trailReset = (tab) => {
    if (tab.id !== tabId) return;
    restart();
    if (open) schedule();
  };

  // The conversation you're in changed (tabs.js activate): the trail follows it.
  SB.trailFollow = () => {
    if (state.activeTab === tabId) return;
    tabId = state.activeTab;
    restart();
    for (const id of [...closed.keys(), ...tests.keys()]) if (!state.tabs.has(id)) { closed.delete(id); tests.delete(id); } // closed since
    if (open) schedule();
  };

  // Back to now, with nobody on the map yet: a new map, so nobody walks over from the last one.
  function restart() {
    stopPlay();
    replayAt = null;
    active = -1;
    unland();
    holder = null;
    for (const c of crabsEl.querySelectorAll('.tr-crab')) c.remove();
  }

  // Live, a busy turn can bring dozens of items a second: the map is drawn at
  // most every PAINT_MS, and not while you're pressing on it (a row redrawn
  // under the pointer would lose the click).
  let lastPaint = 0;
  let pressing = false;
  function schedule() {
    if (frame) return;
    const wait = Math.max(0, lastPaint + PAINT_MS - performance.now());
    frame = setTimeout(() => requestAnimationFrame(() => {
      frame = 0;
      if (pressing) { schedule(); return; }
      lastPaint = performance.now();
      paint();
    }), wait);
  }

  // ------------------------------------------------------------ opening

  SB.trailOpen = () => open;
  SB.drawerShows = () => (open ? shows : null);
  SB.toggleTrail = async (force, { focus = false } = {}) => {
    const want = force ?? !open;
    if (want === open) { if (want && focus) showTab(shows, { focus }); return; }
    open = want;
    drawer.hidden = !open;
    document.body.classList.toggle('trail-open', open);
    toggleBtn?.setAttribute('aria-pressed', String(open));
    // A conversation's own window keeps the panel's choice as it is.
    if (!SB.solo) try { window.localStorage.setItem(OPEN_KEY, open ? '1' : ''); } catch { /* lasts this session */ }
    if (!open) {
      tabs.get(shows)?.hide();
      stopPlay();
      replayAt = null;
      unland();
      document.body.classList.remove('trail-over');
      if (drawer.contains(document.activeElement)) $('input').focus();
      return;
    }
    tabId = null;
    SB.trailFollow();
    await makeRoom();
    if (!open) return; // closed again while the panel grew
    setWidth(drawer.getBoundingClientRect().width); // a width kept from a wider window fits this one
    showTab(shows, { focus });
  };

  // ------------------------------------------------------------ its tabs

  // The drawer's other tabs register here (files-dock.js), so this file never reaches into theirs.
  SB.drawerTab = (name, hooks) => {
    tabs.set(name, hooks);
    if (open && shows === name) hooks.show({ focus: false });
  };

  // One tab up at a time: the Trail's own panel, or one registered above.
  function showTab(name, { focus = false } = {}) {
    if (name !== 'trail' && !tabs.has(name)) name = 'trail';
    if (shows !== name) tabs.get(shows)?.hide();
    if (shows === 'trail' && name !== 'trail') {
      // Leaving the Trail: its replay stops (it would keep scrolling the feed), and its empty look goes.
      stopPlay();
      replayAt = null;
      unland();
      drawer.classList.remove('nothing-yet');
    }
    shows = name;
    if (!SB.solo) try { window.localStorage.setItem(TAB_KEY, name); } catch { /* lasts this session */ }
    drawer.dataset.tab = name;
    for (const b of tabBtns) {
      const on = b.dataset.tab === name;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    panelEl.hidden = name !== 'trail';
    if (name !== 'trail') return tabs.get(name).show({ focus });
    paint();
    if (focus) map.focus();
  }

  // Ctrl+Shift+E and Ctrl+Shift+F: the drawer on that tab, or closed when that tab is already up.
  SB.toggleDrawer = (name, { focus = false } = {}) => {
    if (name !== 'trail' && !tabs.has(name)) name = 'trail'; // a tab this window has none of (All files in solo)
    if (open && shows === name) return SB.toggleTrail(false);
    if (open) return showTab(name, { focus });
    shows = name;
    return SB.toggleTrail(true, { focus });
  };

  // The chat keeps MIN_CHAT beside the drawer: the panel grows toward the
  // middle of its screen, as for a split (pane-room.js). On a screen with no
  // room for that, the drawer lies over the chat instead.
  async function makeRoom() {
    document.body.classList.remove('trail-over');
    const whole = $('chatView').getBoundingClientRect().width;
    if (!whole) return; // not on screen: measured when the chat shows (restoreTrail)
    const short = MIN_CHAT - (whole - drawer.getBoundingClientRect().width); // the chat beside the drawer
    if (short <= 0) return;
    const zoom = api.zoomFactor?.() || 1;
    const want = { width: Math.round(window.innerWidth * zoom) + Math.ceil(short * zoom), height: Math.round(window.innerHeight * zoom) };
    if (SB.solo || want.width > window.screen.availWidth - SCREEN_GAP) { document.body.classList.add('trail-over'); return; }
    const r = await api.fitPanel(want);
    if (!r?.ok) document.body.classList.add('trail-over');
  }

  // ------------------------------------------------------------ painting

  const tabNow = () => state.tabs.get(tabId) || null;
  const closedOf = id => { if (!closed.has(id)) closed.set(id, new Set()); return closed.get(id); };

  function paint() {
    if (!open || shows !== 'trail') return;
    const tab = tabNow();
    const s = tab?.trail;
    if (!s || !s.seq) { paintEmpty(tab); return; }
    drawer.classList.remove('nothing-yet');
    const v = T.view(s, { upTo: replayAt ?? Infinity, scope, busy: !!tab.busy });
    paintScope();
    paintRows(tab, v);
    paintCrabs(v);
    paintSignals(tab, v);
    paintFoot(s, v);
    if (v.live && !v.crab?.working) askTests(tab, v);
  }

  function paintEmpty(tab) {
    drawer.classList.add('nothing-yet');
    paintScope();
    rowsEl.replaceChildren(h('div', { class: 'trail-empty' },
      h('p', { class: 'trail-empty-lead', text: tab?.busy ? 'Setting off…' : 'No tracks yet.' }),
      h('p', { text: 'When he reads, searches or changes a file, it turns up here, and so does he: you can watch where he goes, and stop him early if it’s the wrong place.' })));
    for (const c of crabsEl.querySelectorAll('.tr-crab')) c.remove();
    signals.replaceChildren();
    counts.textContent = '';
    scrub.max = '0';
    scrub.value = '0';
    scrub.disabled = true;
    playBtn.disabled = true;
    liveBtn.hidden = true;
    rowList = [];
  }

  function paintScope() {
    for (const b of drawer.querySelectorAll('.trail-scope [data-scope]')) b.setAttribute('aria-pressed', String(b.dataset.scope === scope));
  }

  // One row per folder and file, the project at the top, then what's outside it.
  function paintRows(tab, v) {
    const shut = closedOf(tab.id);
    const list = T.rows(v.tree, shut);
    if (v.outside.length) {
      list.push({ node: { kind: 'group', key: '\u0000outside', name: 'Outside this project' }, depth: 0 });
      for (const f of v.outside) list.push({ node: { kind: 'file', key: f.key, path: f.path, name: f.name, info: f, outside: true }, depth: 1 });
    }
    const keyNow = rowList[active]?.node.key;
    rowList = list.map((r, i) => ({ ...r, el: rowEl(r, i, shut) }));
    rowsEl.replaceChildren(...rowList.map(r => r.el));
    active = keyNow === undefined ? -1 : rowList.findIndex(r => r.node.key === keyNow);
    markActive();
  }

  function rowEl({ node, depth }, i, shut) {
    if (node.kind === 'group') return h('div', { class: 'tr-row tr-group', role: 'presentation', id: `tr-${i}`, text: node.name });
    const f = node.info;
    const dir = node.kind === 'dir';
    const isRoot = dir && node.key === '';
    const cls = ['tr-row', dir ? 'tr-dir' : 'tr-file'];
    if (isRoot) cls.push('tr-root');
    if (f && !f.fresh) cls.push('earlier');
    if (f?.ask) cls.push('asking');
    if (f?.circles) cls.push('circling');
    if (f?.secret) cls.push('secret');
    if (node.outside) cls.push('outside');
    const shutNow = dir && shut.has(node.key);
    const el = h('div', {
      class: cls.join(' '), role: 'treeitem', id: `tr-${i}`, 'aria-level': String(depth + 1),
      'aria-expanded': dir ? String(!shutNow) : null, 'aria-selected': 'false',
      dataset: { key: node.key, i: String(i) }, style: `--d:${depth}`, title: titleOf(node),
    },
    dir ? h('span', { class: 'tr-chev', 'aria-hidden': 'true' }) : printsOf(f),
    h('span', { class: 'tr-name', text: isRoot ? node.name : dir ? `${node.name}/` : node.name }),
    node.outside ? h('span', { class: 'tr-where', text: SB.tildify(f.path.slice(0, -f.name.length).replace(/\/$/, '')) }) : null,
    marksOf(f, dir, isRoot),
    dir ? null : h('span', { class: 'tr-acts' },
      h('button', { type: 'button', class: 'tr-act', dataset: { act: 'mention' }, title: 'Put it in your message (@)', 'aria-label': `Mention ${node.name} in your message`, tabindex: '-1', text: '@' }),
      h('button', { type: 'button', class: 'tr-act', dataset: { act: 'open' }, title: 'Open it in the file viewer (Shift+Enter) · Ctrl: your editor', 'aria-label': `Open ${node.name}`, tabindex: '-1' }, SB.icon('M9.5 2.5h4v4M13.5 2.5 8 8M12 9.5v3.2c0 .4-.4.8-.8.8H3.3c-.4 0-.8-.4-.8-.8V4.8c0-.4.4-.8.8-.8h3.2', { width: 1.4 }))));
    return el;
  }

  // His footprints before the name: dug over where he changed it, prints where
  // he read it, a glint where a search found it and nothing more.
  function printsOf(f) {
    const kind = f.writes || f.diff ? 'dug' : f.reads ? 'read' : f.hits ? 'seen' : null;
    const p = kind && PRINTS[kind];
    return h('span', { class: `tr-prints${kind ? ` p-${kind}` : ''}`, 'aria-hidden': 'true' }, p ? SB.Sprite.grid(p.pixels, p.palette, { px: 3 }) : null);
  }

  // What happened there, in a few words at the row's end.
  function marksOf(f, dir, isRoot) {
    const out = [];
    const mark = (cls, text, title) => out.push(h('span', { class: `tr-mark ${cls}`, text, title }));
    if (!f) return h('span', { class: 'tr-marks' });
    if (f.ask) mark('m-ask', 'your OK?', 'He’s waiting for you to allow this change');
    if (f.circles) mark('m-circles', `↻${f.circles}`, `${f.circles} edits here this turn${f.fails ? `, ${f.fails} that didn’t apply` : ''}`);
    if (f.secret) mark('m-secret', 'secret', 'This kind of file can hold passwords and keys');
    if (dir) {
      if (isRoot && f.runs) mark('m-run', plural(f.runs, 'command'), `Ran ${plural(f.runs, 'command')} in the project folder`);
      if (f.searches) mark('m-search', f.patterns[0] ? `“${clip(f.patterns[0], 14)}”` : 'searched', f.patterns.length ? `Searched for ${f.patterns.map(p => `“${p}”`).join(', ')}` : 'Searched here');
    } else if (f.diff) {
      if (f.diff.status === 'A') mark('m-new', 'new', 'Made in this conversation');
      if (f.diff.status === 'D') mark('m-gone', 'deleted', 'Deleted in this conversation');
      if (f.diff.status !== 'D') out.push(h('span', { class: 'dstat tr-mark' }, h('span', { class: 'add', text: `+${f.diff.added}` }), h('span', { class: 'del', text: `−${f.diff.removed}` })));
    } else if (f.writes) {
      mark('m-edit', f.writes > 1 ? `edited ×${f.writes}` : 'edited', 'Its changes show here once the turn is over');
    } else if (f.reads) {
      mark('m-read', f.reads > 1 ? `read ×${f.reads}` : 'read', linesOf(f));
    } else if (f.hits && !f.ask) {
      mark('m-seen', 'seen', 'A search found it; he hasn’t opened it');
    }
    if (f.fails && !f.circles && !dir) mark('m-miss', f.fails > 1 ? `missed ×${f.fails}` : 'missed', 'Edits that didn’t apply: the text he meant to replace wasn’t there');
    if (f.lanes?.length) out.push(...f.lanes.map(lane => h('span', { class: 'tr-lane', style: `--lane-hue:${SB.HUES[laneIndex(lane) % SB.HUES.length]}deg`, title: 'A helper was here' })));
    return h('span', { class: 'tr-marks' }, ...out);
  }

  const laneIndex = id => tabNow()?.trail?.lanes.get(id)?.index ?? 0;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  function linesOf(f) {
    if (!f.lines.length) return 'Read the whole file';
    return `Read lines ${f.lines.map(([a, b]) => (b ? `${a}–${b}` : `${a} on`)).join(', ')}`;
  }
  function titleOf(node) {
    if (node.kind === 'dir') return node.key === '' ? SB.tildify(node.path) : node.path;
    return `${node.path}\nClick: where he did it · Shift+Enter: open it`;
  }

  // ------------------------------------------------------------ the crabs

  // Him, holding what he works with; a helper in its lane's colour. Rebuilt
  // only when what he holds changes.
  function crabSprite(pose, helper) {
    const held = pose && W.ITEMS[pose] ? [W.ITEMS[pose]] : [];
    if (helper) {
      const svg = SB.sprite(state.skin, { accessories: [...(state.outfit?.crewAccessories || []).filter(a => a.slot !== 'held'), ...held] });
      svg.style.filter = `hue-rotate(${SB.HUES[helper.index % SB.HUES.length]}deg) saturate(1.1)`;
      return svg;
    }
    return SB.sprite(state.skin, { accessories: [...(state.outfit?.accessories || []).filter(a => a.slot !== 'held'), ...held] });
  }

  // His pose holds for a moment, as on the desktop (shared/workposes.js), so a
  // burst of quick steps reads as one job and his claws don't flicker.
  let holder = null;
  const mainHolder = () => (holder ||= W.holder((pose) => {
    const el = crabsEl.querySelector('.tr-crab.main');
    if (el) dress(el, pose, null);
  }));

  function dress(el, pose, helper) {
    if (el.dataset.pose === String(pose)) return;
    el.dataset.pose = String(pose);
    el.querySelector('.tr-sprite').replaceChildren(crabSprite(pose, helper));
  }

  function paintCrabs(v) {
    const want = [];
    if (v.crab) want.push({ id: 'main', key: v.crab.key, pose: v.crab.working ? v.crab.pose : null, helper: null, working: v.crab.working });
    for (const hp of v.helpers) want.push({ id: hp.lane, key: hp.key, pose: hp.pose, helper: hp, working: true });
    const keep = new Set(want.map(w => w.id));
    for (const el of crabsEl.querySelectorAll('.tr-crab')) if (!keep.has(el.dataset.id)) el.remove();
    for (const w of want) {
      let el = crabsEl.querySelector(`.tr-crab[data-id="${CSS.escape(w.id)}"]`);
      const fresh = !el;
      if (fresh) {
        el = h('div', { class: `tr-crab${w.helper ? ' helper' : ' main'}`, dataset: { id: w.id } }, h('span', { class: 'tr-sprite' }));
        crabsEl.append(el);
      }
      el.classList.toggle('resting', !w.working);
      if (w.helper || !v.live) dress(el, w.pose, w.helper);
      else if (fresh) dress(el, w.working ? w.pose : null, null);
      if (!w.helper && v.live) mainHolder().set(w.pose, w.working);
      place(el, w.key, fresh);
    }
    // Live and nobody's pointing at the map: keep him in view.
    const me = crabsEl.querySelector('.tr-crab.main');
    if (me && v.live && !map.matches(':hover') && !map.contains(document.activeElement)) rowOf(v.crab.key)?.scrollIntoView({ block: 'nearest' });
  }

  // The row he stands on: his file's, or the nearest folder of it still showing.
  function rowOf(key) {
    let best = null;
    for (const r of rowList) {
      const k = r.node.key;
      if (r.node.kind === 'group') continue;
      if (k === key) return r.el;
      if (r.node.kind === 'dir' && (k === '' || key.startsWith(`${k}/`)) && (!best || k.length > best.node.key.length)) best = r;
    }
    return best?.el || rowList[0]?.el || null;
  }

  // Beside the name on his row; a helper sharing it stands a little further on.
  function place(el, key, fresh) {
    const row = rowOf(key);
    if (!row) return;
    const name = row.querySelector('.tr-name');
    const marks = row.querySelector('.tr-marks');
    const size = el.classList.contains('helper') ? 26 : 36;
    const others = [...crabsEl.querySelectorAll('.tr-crab')].filter(c => c !== el && c.dataset.key === key).length;
    const end = marks ? marks.offsetLeft - size - 4 : row.offsetWidth - size;
    const x = Math.max(8, Math.min(name.offsetLeft + name.offsetWidth + 6 + others * 18, end));
    const y = row.offsetTop + (row.offsetHeight - size) / 2 - 2;
    const moved = el.dataset.key !== key;
    el.dataset.key = key;
    el.style.setProperty('--x', `${Math.round(x)}px`);
    el.style.setProperty('--y', `${Math.round(y)}px`);
    if (fresh || !moved || reduced()) { el.dataset.x = String(x); return; }
    // Facing where he's going, and scuttling while he gets there.
    const wasX = Number(el.dataset.x ?? x);
    el.dataset.x = String(x);
    if (Math.abs(x - wasX) > 2) el.classList.toggle('left', x < wasX);
    el.classList.add('walking');
    clearTimeout(el.walkTimer);
    el.walkTimer = setTimeout(() => el.classList.remove('walking'), WALK_MS);
  }

  // ------------------------------------------------------------ what's worth a look

  function paintSignals(tab, v) {
    if (!v.live) { signals.replaceChildren(); return; }
    const out = [];
    for (const f of v.circles.slice(0, 2)) {
      const where = f.rel || f.path;
      out.push(signal('circles', `He keeps going back to ${f.name}: ${plural(f.circles, 'edit')} this turn${f.fails ? `, ${f.fails} that didn’t apply` : ''}.`,
        'Ask what’s wrong', () => SB.prefill(`You've changed ${where} ${f.circles} times this turn. Stop and tell me what's going wrong before you change it again.`), f.key));
    }
    const t = tests.get(tab.id);
    if (t?.map && !v.crab?.working) {
      for (const u of T.untested(v, t.map).slice(0, 2)) {
        out.push(signal('tests', `${baseOf(u.file)} changed, and nobody ran ${baseOf(u.tests[0])}.`,
          'Run it', () => SB.prefill(`Run ${u.tests[0]} and fix anything it catches.`), T.keyOf(`${v.root}/${u.file}`)));
      }
    }
    if (v.secrets.length) {
      const names = v.secrets.slice(0, 2).map(f => f.name).join(' and ');
      out.push(signal('secret', `He opened ${names}${v.secrets.length > 2 ? ` and ${v.secrets.length - 2} more` : ''}. Files like that can hold passwords and keys.`, null, null, v.secrets[0].key));
    }
    signals.replaceChildren(...out.slice(0, MAX_SIGNALS));
  }

  const baseOf = p => String(p).split('/').pop();

  function signal(kind, text, action, run, key) {
    return h('div', { class: `trail-signal s-${kind}` },
      h('button', { type: 'button', class: 'tr-sig-text', text, title: 'Show it on the trail', onclick: () => select(key) }),
      action ? h('button', { type: 'button', class: 'btn slim-btn', text: action, title: 'Puts it in the box for you to send', onclick: run }) : null);
  }

  // The tests named after what changed, asked of main once a turn is over.
  async function askTests(tab, v) {
    if (!v.changedNow.length) return;
    const sig = v.changedNow.join('\n');
    const had = tests.get(tab.id);
    if (had?.sig === sig) return;
    tests.set(tab.id, { sig, map: null });
    const r = await api.trailTests(tab.id, v.changedNow).catch(() => null);
    if (tests.get(tab.id)?.sig !== sig) return;
    tests.set(tab.id, { sig, map: r?.tests || {} });
    if (tab.id === tabId) schedule();
  }

  // ------------------------------------------------------------ the replay

  function paintFoot(s, v) {
    const first = s.events[0]?.seq || 1;
    scrub.disabled = v.steps < 2;
    playBtn.disabled = v.steps < 2;
    scrub.min = String(first);
    scrub.max = String(v.steps);
    scrub.value = String(v.at);
    scrub.style.setProperty('--fill', `${v.steps > first ? ((v.at - first) / (v.steps - first)) * 100 : 100}%`);
    scrub.setAttribute('aria-valuetext', v.live ? `Now, step ${v.steps}` : `Step ${v.at} of ${v.steps}`);
    liveBtn.hidden = v.live;
    drawer.classList.toggle('replaying', !v.live);
    drawer.classList.toggle('playing', !!playTimer);
    const c = v.counts;
    const bits = [
      c.read && `${c.read} read`, c.changed && `${c.changed} changed`, c.seen && `${c.seen} only seen in a search`,
      c.outside && `${c.outside} outside the project`,
    ].filter(Boolean);
    counts.textContent = v.live ? (bits.join(' · ') || 'Nothing touched in this turn yet') : `Step ${v.at} of ${v.steps}`;
  }

  function goTo(step, { follow = true } = {}) {
    const s = tabNow()?.trail;
    if (!s) return;
    replayAt = step >= s.seq ? null : Math.max(s.events[0]?.seq || 1, step);
    paint();
    if (follow) land(replayAt == null ? null : T.stepAt(s, replayAt));
  }

  // The step's row in the feed, scrolled to and lit while the replay is on it.
  function land(ev) {
    unland();
    const el = ev && tabNow()?.tools.get(ev.toolId);
    if (!el) return;
    el.classList.add('trail-here');
    el.scrollIntoView({ block: 'nearest', behavior: reduced() || playTimer ? 'auto' : 'smooth' });
    landedEl = el;
  }
  function unland() { landedEl?.classList.remove('trail-here'); landedEl = null; }

  function play() {
    const s = tabNow()?.trail;
    if (!s || s.seq < 2) return;
    if (playTimer) return stopPlay();
    if (replayAt == null) replayAt = (s.events[0]?.seq || 1) - 1;
    playTimer = setInterval(() => {
      const now = tabNow()?.trail; // the trail as it is now: a rewind makes a new one
      if (!now || replayAt == null || replayAt >= now.seq) { stopPlay(); goTo(Infinity); return; }
      goTo(replayAt + 1);
    }, reduced() ? PLAY_MS * 1.5 : PLAY_MS);
    drawer.classList.add('playing');
  }
  function stopPlay() {
    clearInterval(playTimer);
    playTimer = null;
    drawer.classList.remove('playing');
  }

  // ------------------------------------------------------------ going places

  function select(key) {
    if (key == null) return;
    const i = rowList.findIndex(r => r.node.key === key);
    if (i < 0) return;
    active = i;
    markActive();
    rowList[i].el.scrollIntoView({ block: 'nearest' });
    rowList[i].el.classList.add('tr-flash');
    setTimeout(() => rowList[i]?.el.classList.remove('tr-flash'), LANDED_MS);
  }

  function markActive() {
    rowList.forEach((r, i) => r.el.setAttribute('aria-selected', String(i === active)));
    map.setAttribute('aria-activedescendant', active >= 0 && rowList[active] ? rowList[active].el.id : '');
  }

  // Where he did it: the step in the feed that last changed the file (or read
  // it, or found it), opened and lit. Further back than the feed keeps: its
  // turn's changes if it has them, else the file itself.
  function goToStep(node) {
    const tab = tabNow();
    const f = node?.info;
    if (!tab || !f) return;
    const id = f.lastWrite || f.lastTool || f.hitBy;
    const el = id && tab.tools.get(id);
    if (!el) {
      if (f.diff && SB.hasChanges?.(tab)) return SB.showChanges(tab);
      return SB.toast('That step is further back than this conversation shows. Shift+Enter opens the file.');
    }
    if (el.dataset.edit && !el.open) el.open = true;
    el.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
    el.classList.add('history-landed');
    setTimeout(() => el.classList.remove('history-landed'), LANDED_MS);
  }

  // In the file viewer, as a file link opens (files.js); Ctrl opens your editor, Shift shows it in
  // its folder. A conversation's own window has no viewer: the editor, as before.
  function openIt(node, { ctrl = false, shift = false } = {}) {
    if (!node?.path) return;
    if (ctrl || shift || SB.solo || !SB.viewer) return SB.openFile(node.path, { tabId, reveal: shift });
    SB.viewer.openLink(tabId, node.path);
  }

  // @path in the box, where the caret is (fileindex.js mention's form).
  function mention(node) {
    const input = $('input');
    const rel = node.info?.rel ?? null;
    const p = rel || node.path;
    const text = /\s/.test(p) ? `@"${p}"` : `@${p}`;
    const at = input.selectionStart ?? input.value.length;
    const pad = at > 0 && !/\s$/.test(input.value.slice(0, at)) ? ' ' : '';
    input.setRangeText(`${pad}${text} `, at, input.selectionEnd ?? at, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  }

  function toggleDir(node, wantOpen) {
    const shut = closedOf(tabId);
    const isOpen = !shut.has(node.key);
    if (wantOpen === isOpen) return false;
    if (isOpen) shut.add(node.key); else shut.delete(node.key);
    paint();
    return true;
  }

  rowsEl.addEventListener('click', (e) => {
    const row = e.target.closest('.tr-row');
    if (!row || row.classList.contains('tr-group')) return;
    const r = rowList[Number(row.dataset.i)];
    if (!r) return;
    active = Number(row.dataset.i);
    markActive();
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'open') return openIt(r.node, { ctrl: e.ctrlKey, shift: e.shiftKey });
    if (act === 'mention') return mention(r.node);
    if (r.node.kind === 'dir') return toggleDir(r.node);
    if (e.shiftKey) return openIt(r.node, { shift: true });
    goToStep(r.node);
  });
  rowsEl.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.tr-file');
    if (row && !e.target.closest('[data-act]')) openIt(rowList[Number(row.dataset.i)]?.node, { ctrl: e.ctrlKey });
  });
  // The map keeps the keyboard; the rows aren't stops of their own.
  rowsEl.addEventListener('mousedown', (e) => { if (!e.target.closest('[data-act]')) { e.preventDefault(); map.focus({ preventScroll: true }); } });

  map.addEventListener('keydown', (e) => {
    const r = rowList[active];
    const step = (d) => {
      let i = active;
      do { i = Math.min(rowList.length - 1, Math.max(0, i + d)); } while (rowList[i]?.node.kind === 'group' && i > 0 && i < rowList.length - 1);
      active = i;
      markActive();
      rowList[i]?.el.scrollIntoView({ block: 'nearest' });
    };
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); return step(1);
      case 'ArrowUp': e.preventDefault(); return step(-1);
      case 'Home': e.preventDefault(); active = 0; return step(0);
      case 'End': e.preventDefault(); active = rowList.length - 1; return step(0);
      case 'ArrowRight': e.preventDefault(); if (r?.node.kind === 'dir' && !toggleDir(r.node, true)) step(1); return;
      case 'ArrowLeft': e.preventDefault(); if (r?.node.kind === 'dir' && toggleDir(r.node, false)) return; return step(-1);
      case 'Enter':
        e.preventDefault();
        if (!r) return;
        if (e.shiftKey) return openIt(r.node, { ctrl: e.ctrlKey });
        if (r.node.kind === 'dir') return toggleDir(r.node);
        return goToStep(r.node);
      case ' ': e.preventDefault(); return play();
      case 'Escape': e.preventDefault(); e.stopPropagation(); return SB.toggleTrail(false);
      default:
        if (e.key === '@' && r?.node.kind === 'file') { e.preventDefault(); mention(r.node); }
    }
  });
  map.addEventListener('pointerdown', () => { pressing = true; });
  for (const type of ['pointerup', 'pointercancel']) window.addEventListener(type, () => { pressing = false; }, true);
  map.addEventListener('focus', () => { if (active < 0 && rowList.length) { active = 0; markActive(); } });

  drawer.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); SB.toggleTrail(false); }
  });
  drawer.querySelector('.trail-scope').addEventListener('click', (e) => {
    const b = e.target.closest('[data-scope]');
    if (!b || b.dataset.scope === scope) return;
    scope = b.dataset.scope;
    try { window.localStorage.setItem(SCOPE_KEY, scope); } catch { /* lasts this session */ }
    paint();
  });
  const tabList = drawer.querySelector('.drawer-tabs');
  tabList.addEventListener('click', (e) => {
    const b = e.target.closest('[role="tab"]');
    if (b && b.dataset.tab !== shows) showTab(b.dataset.tab);
  });
  // Arrow keys move between the tabs, Home and End to the ends.
  tabList.addEventListener('keydown', (e) => {
    const i = tabBtns.indexOf(document.activeElement);
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabBtns.length - 1 }[e.key];
    if (i < 0 || to === undefined) return;
    e.preventDefault();
    const b = tabBtns[(to + tabBtns.length) % tabBtns.length];
    showTab(b.dataset.tab);
    b.focus();
  });
  scrub.addEventListener('input', () => { stopPlay(); goTo(Number(scrub.value)); });
  playBtn.addEventListener('click', play);
  liveBtn.addEventListener('click', () => { stopPlay(); goTo(Infinity); });
  $('trailClose').addEventListener('click', () => SB.toggleTrail(false));
  toggleBtn?.addEventListener('click', () => SB.toggleTrail());
  // His skin or outfit changed: dressed again on the next paint.
  api.onSkin?.(() => { for (const c of crabsEl.querySelectorAll('.tr-crab')) delete c.dataset.pose; schedule(); });
  // A narrower or wider chat moves the names he stands beside.
  new ResizeObserver(() => { if (open) schedule(); }).observe(map);

  // ------------------------------------------------------------ its width

  // Drag the line on its left edge, or arrow keys on it (Home and End for the
  // narrowest and widest); a double-click puts the usual width back. Beside the
  // chat, the chat keeps MIN_CHAT; lying over it, OVER_GAP of it stays in view.
  const grip = $('trailGrip');
  const widest = () => {
    const whole = $('chatView').getBoundingClientRect().width;
    if (!whole) return Infinity; // the chat isn't on screen: nothing to measure against yet
    return Math.max(MIN_W, Math.floor(whole - (document.body.classList.contains('trail-over') ? OVER_GAP : MIN_CHAT)));
  };
  function setWidth(px, { save = false } = {}) {
    const max = widest();
    const w = Math.round(Math.min(max, Math.max(MIN_W, px)));
    document.body.style.setProperty('--trail-w', `${w}px`);
    grip.setAttribute('aria-valuemin', String(MIN_W));
    if (Number.isFinite(max)) grip.setAttribute('aria-valuemax', String(max));
    grip.setAttribute('aria-valuenow', String(w));
    // A conversation's own window keeps the panel's width as it is.
    if (save && !SB.solo) try { window.localStorage.setItem(WIDTH_KEY, String(w)); } catch { /* lasts this session */ }
  }
  const kept = Number(window.localStorage.getItem(WIDTH_KEY));
  if (kept >= MIN_W) document.body.style.setProperty('--trail-w', `${Math.round(kept)}px`); // fitted to the window when it opens

  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = e.clientX;
    const from = drawer.getBoundingClientRect().width;
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing-trail');
    const move = ev => setWidth(from + start - ev.clientX);
    // Whichever of these comes first ends it, once (as tab-panes.js's dividers do).
    let done = false;
    const up = ev => {
      if (done || ev.pointerId !== e.pointerId) return;
      done = true;
      grip.removeEventListener('pointermove', move);
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) grip.removeEventListener(type, up);
      document.body.classList.remove('resizing-trail');
      setWidth(drawer.getBoundingClientRect().width, { save: true });
    };
    grip.addEventListener('pointermove', move);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) grip.addEventListener(type, up);
  });
  grip.addEventListener('dblclick', () => setWidth(TRAIL_W, { save: true }));
  grip.addEventListener('keydown', (e) => {
    const w = drawer.getBoundingClientRect().width;
    const to = { ArrowLeft: w + STEP_W, ArrowRight: w - STEP_W, Home: MIN_W, End: Infinity }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    setWidth(to, { save: true });
  });

  // Open as you left it: boot.js calls this once the tabs are back.
  SB.restoreTrail = () => { if (window.localStorage.getItem(OPEN_KEY) === '1' && !SB.solo && state.view === 'chat') SB.toggleTrail(true); };
})();
