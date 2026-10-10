// Every keyboard shortcut in the panel, in one table: the cheat sheet (Ctrl+/)
// lists it, the Ctrl+K palette shows an action's keys from it, and the handlers
// for the newer shortcuts match against it, so the three can't drift apart.
// Also the palette's ranking, and which project a conversation is in. Pure, no
// DOM. Works in the browser and in Node (for tests).
(function (root) {
  // keys: how each way of pressing it is written, shown as is. Ones that can't
  // be matched as a single press ("Esc Esc", "Ctrl+1…8") are only ever shown;
  // their handlers live where they always did. fixed: can't be changed in the
  // list (Ctrl+/), because what it does depends on the very key (Esc, Enter, a
  // typed /, PgUp for left and PgDn for right).
  const SHORTCUTS = [
    { id: 'palette', group: 'Anywhere', keys: ['Ctrl+K', 'Ctrl+Shift+P'], what: 'Jump anywhere, or run an action on this conversation' },
    { id: 'shortcuts', fixed: true, group: 'Anywhere', keys: ['Ctrl+/', '?'], what: 'This list of shortcuts (? when you’re not typing)' },
    { id: 'dock', fixed: true, group: 'Anywhere', keys: ['Ctrl+1…8'], what: 'The screens on the bottom bar, in order' },
    { id: 'back', fixed: true, group: 'Anywhere', keys: ['Esc'], what: 'Close a menu, or go back a screen' },
    { id: 'zoomIn', group: 'Anywhere', keys: ['Ctrl+=', 'Ctrl++'], what: 'Bigger text in the panel (it stays that way)' },
    { id: 'zoomOut', group: 'Anywhere', keys: ['Ctrl+-'], what: 'Smaller text in the panel' },
    { id: 'zoomReset', group: 'Anywhere', keys: ['Ctrl+0'], what: 'Text back to its usual size' },

    { id: 'newTab', group: 'Conversations', keys: ['Ctrl+T'], what: 'New conversation' },
    { id: 'closeTab', group: 'Conversations', keys: ['Ctrl+W'], what: 'Close this conversation (press twice if he’s still working)' },
    { id: 'nextTab', group: 'Conversations', keys: ['Ctrl+Tab', 'Ctrl+PgDn'], what: 'Next conversation' },
    { id: 'prevTab', group: 'Conversations', keys: ['Ctrl+Shift+Tab', 'Ctrl+PgUp'], what: 'Previous conversation' },
    { id: 'moveTab', fixed: true, group: 'Conversations', keys: ['Ctrl+Shift+PgUp', 'Ctrl+Shift+PgDn'], what: 'Move this conversation left or right' },
    { id: 'tabList', group: 'Conversations', keys: ['Ctrl+Shift+A'], what: 'Every open conversation, grouped by what it needs from you' },
    { id: 'renameTab', fixed: true, group: 'Conversations', keys: ['F2'], what: 'Rename it (on its tab)' },
    { id: 'splitPane', group: 'Conversations', keys: ['Ctrl+\\'], what: 'Another conversation alongside this one (or drag a tab into the chat, or out of the window)' },
    { id: 'reopenTab', group: 'Conversations', keys: ['Ctrl+Shift+T'], what: 'Bring back the conversation you closed last (again for the one before)' },

    { id: 'stop', fixed: true, group: 'This conversation', keys: ['Esc'], what: 'Stop, while he’s working' },
    { id: 'find', group: 'This conversation', keys: ['Ctrl+F'], what: 'Find text in it (Enter and Shift+Enter step through)' },
    { id: 'rewind', fixed: true, group: 'This conversation', keys: ['Esc Esc'], what: 'Rewind to an earlier message (with the box empty)' },
    { id: 'tryAgain', group: 'This conversation', keys: ['Ctrl+Shift+B'], what: 'Try your last message another way, in a new tab' },
    { id: 'showChanges', group: 'This conversation', keys: ['Ctrl+Shift+D'], what: 'Show what the last turn changed' },
    { id: 'bringHome', group: 'This conversation', keys: ['Ctrl+Shift+H'], what: 'Bring its own copy home (merge it back)' },
    { id: 'outline', group: 'This conversation', keys: ['Ctrl+Shift+O'], what: 'Outline: every message you sent and the files each turn touched' },
    { id: 'problems', group: 'This conversation', keys: ['Ctrl+Shift+M'], what: 'Problems: the errors its checks found, file by file, each with Fix it' },
    { id: 'cycleMode', fixed: true, group: 'This conversation', keys: ['Shift+Tab'], what: 'Next permission mode (in the box)' },

    { id: 'send', fixed: true, group: 'The message box', keys: ['Enter'], what: 'Send, or queue it while he works' },
    { id: 'newline', fixed: true, group: 'The message box', keys: ['Shift+Enter'], what: 'New line' },
    { id: 'hold', fixed: true, group: 'The message box', keys: ['Ctrl+Shift+Enter'], what: 'Hold it for after your usage resets' },
    { id: 'recall', fixed: true, group: 'The message box', keys: ['↑', '↓'], what: 'What you sent before; ↑ in an empty box edits a queued message' },
    { id: 'searchSent', group: 'The message box', keys: ['Ctrl+R'], what: 'Search what you’ve sent' },
    { id: 'slash', fixed: true, group: 'The message box', keys: ['/'], what: 'Skills, commands and your snippets' },
    { id: 'mention', fixed: true, group: 'The message box', keys: ['@'], what: 'Mention a file' },
    { id: 'shell', fixed: true, group: 'The message box', keys: ['!'], what: 'Run a shell command yourself' },
    { id: 'paste', fixed: true, group: 'The message box', keys: ['Ctrl+V'], what: 'Paste a screenshot or copied files' },

    { id: 'askKeys', fixed: true, group: 'Cards in the chat', keys: ['Y', 'A', 'N'], what: 'Allow, Always allow or Deny a request (outside the box)' },
    { id: 'questionKeys', fixed: true, group: 'Cards in the chat', keys: ['1…9'], what: 'Pick an answer to his question' },
  ];

  const GROUPS = [...new Set(SHORTCUTS.map(s => s.group))];
  const byId = new Map(SHORTCUTS.map(s => [s.id, s]));

  const KEY_NAMES = { Esc: 'Escape', PgUp: 'PageUp', PgDn: 'PageDown', '↑': 'ArrowUp', '↓': 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', Space: ' ' };
  const MODS = new Set(['Ctrl', 'Shift', 'Alt']);

  /** "Ctrl+Shift+D" -> { ctrl, shift, alt, key }, or null for one that's only shown. */
  function parse(combo) {
    const text = String(combo || '');
    if (!text || /…| /.test(text)) return null;
    // The key is whatever follows the last modifier, so "Ctrl+/" and "+" both work.
    const parts = text.split('+');
    const mods = [];
    while (parts.length > 1 && MODS.has(parts[0])) mods.push(parts.shift());
    const key = parts.join('+');
    if (!key) return null;
    return { ctrl: mods.includes('Ctrl'), shift: mods.includes('Shift'), alt: mods.includes('Alt'), key: KEY_NAMES[key] || key };
  }

  // A symbol (/, ?, @) is Shift on some keyboards and not on others, so Shift
  // doesn't count for it; for letters and named keys it does.
  const isSymbol = key => key.length === 1 && !/[a-z0-9]/i.test(key);

  // ------------------------------------------------------------ your own keys
  //
  // Settings keep { id: [combo] } for the ones you changed (main's settings,
  // so they follow you with Sync); the table's own keys are the rest. Read
  // through a getter the panel sets once, and checked again only when the
  // object it hands back is a new one.

  // Keys that mean something already: text editing, the browser, the dock,
  // and the ones the box and comment boxes handle themselves.
  const RESERVED = ['Ctrl+Z', 'Ctrl+Y', 'Ctrl+Shift+Z', 'Ctrl+A', 'Ctrl+C', 'Ctrl+X', 'Ctrl+V', 'Ctrl+Shift+I', 'Ctrl+Shift+R',
    'Ctrl+Backspace', 'Ctrl+Delete', 'Ctrl+Enter', 'Ctrl+S', 'Alt+F4', 'Ctrl+Left', 'Ctrl+Right', 'Ctrl+Home', 'Ctrl+End',
    ...Array.from({ length: 8 }, (_v, i) => `Ctrl+${i + 1}`)];
  const MAX_WAYS = 2;

  const sig = (c) => `${c.ctrl}|${c.alt}|${isSymbol(c.key) ? '' : c.shift}|${c.key.toLowerCase()}`;
  const RESERVED_SIGS = new Set(RESERVED.map(k => sig(parse(k))));

  let source = () => null;
  let seenRaw;
  let seen = {};

  /** Where the panel keeps your keys: a function that returns the settings' map. */
  function useOverrides(get) {
    source = typeof get === 'function' ? get : () => get;
    seenRaw = undefined;
  }

  function overrides() {
    const raw = source();
    if (raw !== seenRaw) { seenRaw = raw; seen = sanitizeOverrides(raw); }
    return seen;
  }

  /** How shortcut `id` is pressed now: your keys if you changed it, else the table's. */
  const keysOf = id => overrides()[id] || byId.get(id)?.keys || [];

  /** Can it be changed at all? */
  const changeable = id => { const s = byId.get(id); return !!s && !s.fixed && s.keys.some(k => parse(k)); };

  // Why `combo` can't be one of id's keys, with `ov` as your other changes; null if it can.
  function whyNot(id, combo, ov) {
    const c = parse(combo);
    if (!c) return 'That can’t be pressed as one shortcut.';
    if (!c.ctrl && !c.alt && !/^F([1-9]|1[0-2])$/.test(c.key)) return 'Use Ctrl or Alt with it, so typing never sets it off.';
    if (RESERVED_SIGS.has(sig(c))) return `${combo} already means something (copying, undo, the screens on the bar…).`;
    for (const other of SHORTCUTS) {
      if (other.id === id) continue;
      const keys = ov[other.id] || other.keys;
      if (keys.some(k => { const o = parse(k); return o && sig(o) === sig(c); })) return `${combo} is already “${other.what.split(/[:(,]/)[0].trim()}”.`;
    }
    return null;
  }

  /** Can `combo` be shortcut id's key, with your other changes as they are? -> null | why not */
  function checkBinding(id, combo, ov = overrides()) {
    if (!changeable(id)) return 'That one can’t be changed.';
    return whyNot(id, String(combo || ''), ov);
  }

  /**
   * Your saved keys, cleaned: known ids that can change, one or two ways each
   * that parse, need Ctrl or Alt, aren't taken and don't clash with each
   * other. Main runs the same over what the panel saves (ipc/settings.js).
   */
  function sanitizeOverrides(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const s of SHORTCUTS) {
      const keys = raw[s.id];
      if (!changeable(s.id) || !Array.isArray(keys) || !keys.length || keys.length > MAX_WAYS) continue;
      if (!keys.every(k => typeof k === 'string' && k.length <= 30 && parse(k))) continue;
      if (new Set(keys.map(k => sig(parse(k)))).size !== keys.length) continue;
      if (keys.join() === s.keys.join()) continue; // the same as the table's: nothing changed
      out[s.id] = keys.slice();
    }
    // Checked all together, so a key moved off one shortcut is free for
    // another; where two still clash, the one later in the table gives way.
    for (let again = true; again;) {
      again = false;
      for (const s of [...SHORTCUTS].reverse()) {
        if (out[s.id] && out[s.id].some(k => whyNot(s.id, k, out))) { delete out[s.id]; again = true; break; }
      }
    }
    return out;
  }

  const CODE_NAMES = { Escape: 'Esc', PageUp: 'PgUp', PageDown: 'PgDn', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'Space' };
  const LONE = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Dead', 'Unidentified', 'Process', 'OS']);

  /** A keydown written the table's way ("Ctrl+Shift+O"), or null for a lone modifier. */
  function comboOf(e) {
    const k = e?.key;
    if (!k || LONE.has(k) || e.isComposing) return null;
    const key = CODE_NAMES[k] || (k.length === 1 ? k.toUpperCase() : k);
    const mods = [e.ctrlKey && 'Ctrl', e.shiftKey && !isSymbol(k) && 'Shift', e.altKey && 'Alt'].filter(Boolean);
    return [...mods, key].join('+');
  }

  /** Does this keydown press shortcut `id` (any of its ways)? */
  function matches(e, id) {
    const s = byId.get(id);
    if (!s || !e || e.isComposing) return false;
    return keysOf(id).some(combo => {
      const c = parse(combo);
      if (!c) return false;
      if (!!e.ctrlKey !== c.ctrl || !!e.altKey !== c.alt || e.metaKey) return false;
      if (!isSymbol(c.key) && !!e.shiftKey !== c.shift) return false;
      return String(e.key).toLowerCase() === c.key.toLowerCase();
    });
  }

  /** Its keys as one line, for a tooltip or the palette: "Ctrl+Tab or Ctrl+PgDn". */
  const label = id => keysOf(id).join(' or ');
  /** The first way of pressing it, for a short hint. */
  const primary = id => keysOf(id)[0] || '';

  /**
   * The table for the cheat sheet: [{ group, items }], in the table's order,
   * each with the keys it has now, changed: true where they're yours, and
   * changeable where they can be.
   */
  const grouped = () => GROUPS.map(group => ({
    group,
    items: SHORTCUTS.filter(s => s.group === group).map(s => ({ ...s, keys: keysOf(s.id), changed: !!overrides()[s.id], changeable: changeable(s.id) })),
  }));

  // ------------------------------------------------------------ palette ranking

  const RECENT_MAX = 8;
  const idOf = entry => entry.id || `${entry.group}:${entry.title}`;

  /** The recent list with `id` moved to the front (a new array). */
  function noteRecent(list, id, max = RECENT_MAX) {
    if (!id) return Array.isArray(list) ? list.slice(0, max) : [];
    return [id, ...(Array.isArray(list) ? list : []).filter(x => x !== id)].slice(0, max);
  }

  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Every word has to appear somewhere; titles that start with the query rank first.
  function score(entry, q, words) {
    const title = String(entry.title || '').toLowerCase();
    const hay = `${title} ${entry.sub || ''} ${entry.keys || ''} ${entry.group || ''}`.toLowerCase();
    if (!words.every(w => hay.includes(w))) return -1;
    const bare = title.replace(/^(settings › |mode: |effort: |\/)/, '');
    if (bare.startsWith(q) || title.startsWith(q)) return 0;
    if (title.includes(q)) return 1;
    if (new RegExp(`\\b${escape(q)}`).test(title)) return 2;
    return 3;
  }

  /**
   * What the palette lists for a query. Typed: best match first, then what you
   * ran lately, then the group's place in `groupRank`, then the order given.
   * Empty: `pinned` (this conversation's actions) first, then up to `recentShown`
   * recent entries under "Recent", then `browse` (screens and settings).
   */
  function rank(entries, raw, { recent = [], groupRank = {}, limit = 40, pinned = [], browse = [], recentShown = 5 } = {}) {
    const q = String(raw || '').trim().toLowerCase();
    const recentAt = id => { const i = recent.indexOf(id); return i < 0 ? Infinity : i; };
    if (!q) {
      const shown = new Set(pinned.map(idOf));
      const byKey = new Map(entries.map(e => [idOf(e), e]));
      const lately = recent.map(id => byKey.get(id)).filter(e => e && !shown.has(idOf(e))).slice(0, recentShown);
      for (const e of lately) shown.add(idOf(e));
      return [...pinned, ...lately.map(e => ({ ...e, id: idOf(e), group: 'Recent' })), ...browse.filter(e => !shown.has(idOf(e)))];
    }
    const words = q.split(/\s+/);
    return entries
      .map((entry, i) => ({ entry, i, s: score(entry, q, words), r: recentAt(idOf(entry)), g: groupRank[entry.group] ?? 99 }))
      .filter(x => x.s >= 0)
      .sort((a, b) => a.s - b.s || a.r - b.r || a.g - b.g || a.i - b.i)
      .slice(0, limit)
      .map(x => x.entry);
  }

  // ------------------------------------------------------------ the conversation's project

  const folderKey = p => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

  /**
   * The listed project (and which of its clones) a folder is in: the clone whose
   * root is the folder or holds it, the deepest one if they nest. Windows paths,
   * any case, either slash. null when it's in none of them.
   */
  function cloneFor(projects, folder) {
    const want = folderKey(folder);
    if (!want || !Array.isArray(projects)) return null;
    let best = null;
    for (const project of projects) {
      for (const clone of project?.local || []) {
        const root = folderKey(clone?.root);
        if (!root || !(want === root || want.startsWith(`${root}\\`))) continue;
        if (!best || root.length > best.len) best = { project, clone, len: root.length };
      }
    }
    return best && { project: best.project, clone: best.clone };
  }

  const api = {
    SHORTCUTS, GROUPS, RESERVED, parse, matches, label, primary, grouped, idOf, noteRecent, score, rank, cloneFor, RECENT_MAX,
    useOverrides, keysOf, changeable, checkBinding, sanitizeOverrides, comboOf,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbyShortcuts = api;
})(typeof window !== 'undefined' ? window : globalThis);
