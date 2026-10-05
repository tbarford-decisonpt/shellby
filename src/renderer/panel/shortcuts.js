// Every keyboard shortcut in the panel, in one table: the cheat sheet (Ctrl+/)
// lists it, the Ctrl+K palette shows an action's keys from it, and the handlers
// for the newer shortcuts match against it, so the three can't drift apart.
// Also the palette's ranking, and which project a conversation is in. Pure, no
// DOM. Works in the browser and in Node (for tests).
(function (root) {
  // keys: how each way of pressing it is written, shown as is. Ones that can't
  // be matched as a single press ("Esc Esc", "Ctrl+1…6") are only ever shown;
  // their handlers live where they always did.
  const SHORTCUTS = [
    { id: 'palette', group: 'Anywhere', keys: ['Ctrl+K'], what: 'Jump anywhere, or run an action on this conversation' },
    { id: 'shortcuts', group: 'Anywhere', keys: ['Ctrl+/', '?'], what: 'This list of shortcuts (? when you’re not typing)' },
    { id: 'dock', group: 'Anywhere', keys: ['Ctrl+1…6'], what: 'The screens on the bottom bar, in order' },
    { id: 'back', group: 'Anywhere', keys: ['Esc'], what: 'Close a menu, go back a screen, or hide the panel' },

    { id: 'newTab', group: 'Conversations', keys: ['Ctrl+T'], what: 'New conversation' },
    { id: 'closeTab', group: 'Conversations', keys: ['Ctrl+W'], what: 'Close this conversation (press twice if he’s still working)' },
    { id: 'nextTab', group: 'Conversations', keys: ['Ctrl+Tab', 'Ctrl+PgDn'], what: 'Next conversation' },
    { id: 'prevTab', group: 'Conversations', keys: ['Ctrl+Shift+Tab', 'Ctrl+PgUp'], what: 'Previous conversation' },
    { id: 'moveTab', group: 'Conversations', keys: ['Ctrl+Shift+PgUp', 'Ctrl+Shift+PgDn'], what: 'Move this conversation left or right' },
    { id: 'renameTab', group: 'Conversations', keys: ['F2'], what: 'Rename it (on its tab)' },

    { id: 'stop', group: 'This conversation', keys: ['Esc'], what: 'Stop, while he’s working' },
    { id: 'rewind', group: 'This conversation', keys: ['Esc Esc'], what: 'Rewind to an earlier message (with the box empty)' },
    { id: 'tryAgain', group: 'This conversation', keys: ['Ctrl+Shift+B'], what: 'Try your last message another way, in a new tab' },
    { id: 'showChanges', group: 'This conversation', keys: ['Ctrl+Shift+D'], what: 'Show what the last turn changed' },
    { id: 'bringHome', group: 'This conversation', keys: ['Ctrl+Shift+H'], what: 'Bring its own copy home (merge it back)' },
    { id: 'cycleMode', group: 'This conversation', keys: ['Shift+Tab'], what: 'Next permission mode (in the box)' },

    { id: 'send', group: 'The message box', keys: ['Enter'], what: 'Send, or queue it while he works' },
    { id: 'newline', group: 'The message box', keys: ['Shift+Enter'], what: 'New line' },
    { id: 'hold', group: 'The message box', keys: ['Ctrl+Shift+Enter'], what: 'Hold it for after your usage resets' },
    { id: 'recall', group: 'The message box', keys: ['↑', '↓'], what: 'What you sent before; ↑ in an empty box edits a queued message' },
    { id: 'searchSent', group: 'The message box', keys: ['Ctrl+R'], what: 'Search what you’ve sent' },
    { id: 'slash', group: 'The message box', keys: ['/'], what: 'Skills, commands and your snippets' },
    { id: 'mention', group: 'The message box', keys: ['@'], what: 'Mention a file' },
    { id: 'shell', group: 'The message box', keys: ['!'], what: 'Run a shell command yourself' },
    { id: 'paste', group: 'The message box', keys: ['Ctrl+V'], what: 'Paste a screenshot or copied files' },

    { id: 'askKeys', group: 'Cards in the chat', keys: ['Y', 'A', 'N'], what: 'Allow, Always allow or Deny a request (outside the box)' },
    { id: 'questionKeys', group: 'Cards in the chat', keys: ['1…9'], what: 'Pick an answer to his question' },
  ];

  const GROUPS = [...new Set(SHORTCUTS.map(s => s.group))];
  const byId = new Map(SHORTCUTS.map(s => [s.id, s]));

  const KEY_NAMES = { Esc: 'Escape', PgUp: 'PageUp', PgDn: 'PageDown', '↑': 'ArrowUp', '↓': 'ArrowDown' };
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

  /** Does this keydown press shortcut `id` (any of its ways)? */
  function matches(e, id) {
    const s = byId.get(id);
    if (!s || !e || e.isComposing) return false;
    return s.keys.some(combo => {
      const c = parse(combo);
      if (!c) return false;
      if (!!e.ctrlKey !== c.ctrl || !!e.altKey !== c.alt || e.metaKey) return false;
      if (!isSymbol(c.key) && !!e.shiftKey !== c.shift) return false;
      return String(e.key).toLowerCase() === c.key.toLowerCase();
    });
  }

  /** Its keys as one line, for a tooltip or the palette: "Ctrl+Tab or Ctrl+PgDn". */
  const label = id => (byId.get(id)?.keys || []).join(' or ');
  /** The first way of pressing it, for a short hint. */
  const primary = id => byId.get(id)?.keys[0] || '';

  /** The table for the cheat sheet: [{ group, items }], in the table's order. */
  const grouped = () => GROUPS.map(group => ({ group, items: SHORTCUTS.filter(s => s.group === group) }));

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

  const api = { SHORTCUTS, GROUPS, parse, matches, label, primary, grouped, idOf, noteRecent, score, rank, cloneFor, RECENT_MAX };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbyShortcuts = api;
})(typeof window !== 'undefined' ? window : globalThis);
