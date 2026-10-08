// Line comments on a turn's diff, the bookkeeping half (line-comments-ui.js draws it):
// numbering a unified diff's lines, turning a picked run of them into an anchor,
// and writing every comment up as the one follow-up Claude gets. Pure, no DOM.
// Works in the browser and in Node (for tests).
(function (root) {
  // Header lines the panel never shows (feed.js's renderDiff skips the same).
  const HEADER = /^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index)/;
  const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  const MAX_ROWS = 4000;
  const MAX_QUOTE = 8;        // lines of code quoted back per comment
  const MAX_BODY = 4000;      // characters in one comment
  const MAX_COMMENTS = 200;   // per conversation

  /**
   * A unified diff as rows, each with its line number on either side:
   *   [{ kind: 'hunk'|'add'|'del'|'ctx'|'meta', text, old, new }]
   * old/new are null where the line doesn't exist on that side.
   */
  function numberLines(patch) {
    const rows = [];
    let oldAt = 0, newAt = 0;
    // Only between "diff --git" and its first hunk: inside one, a removed
    // "-- note" is "--- note", and that's code.
    let inHeader = true;
    for (const line of String(patch || '').replace(/\n$/, '').split('\n')) {
      if (rows.length >= MAX_ROWS) break;
      if (line.startsWith('diff --git')) inHeader = true;
      if (inHeader && HEADER.test(line)) continue;
      if (HUNK.test(line)) inHeader = false;
      const hunk = HUNK.exec(line);
      if (hunk) {
        oldAt = Number(hunk[1]);
        newAt = Number(hunk[2]);
        rows.push({ kind: 'hunk', text: line, old: null, new: null });
      } else if (line.startsWith('+')) rows.push({ kind: 'add', text: line, old: null, new: newAt++ });
      else if (line.startsWith('-')) rows.push({ kind: 'del', text: line, old: oldAt++, new: null });
      else if (line.startsWith('\\')) rows.push({ kind: 'meta', text: line, old: null, new: null });
      else if (line || rows.length) rows.push({ kind: 'ctx', text: line, old: oldAt++, new: newAt++ });
    }
    return rows;
  }

  const commentable = row => !!row && (row.kind === 'add' || row.kind === 'del' || row.kind === 'ctx');

  /**
   * Rows a..b (either order) as what a comment is about. Line numbers are the
   * file as the turn left it ('new'), unless every picked line was removed,
   * when they're the file as it was before ('old').
   *   -> { side, start, end, quote: [text] } | null
   */
  function anchor(rows, a, b) {
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    const picked = rows.slice(Math.max(0, lo), hi + 1).filter(commentable);
    if (!picked.length) return null;
    const side = picked.some(r => r.new != null) ? 'new' : 'old';
    const nums = picked.map(r => r[side]).filter(n => n != null);
    const quote = picked.map(r => r.text);
    return {
      side, start: Math.min(...nums), end: Math.max(...nums),
      quote: quote.length > MAX_QUOTE ? [...quote.slice(0, MAX_QUOTE - 2), '…', quote[quote.length - 1]] : quote,
    };
  }

  // The rows a stored comment covers in this diff, or null if it no longer lines up.
  function rowsFor(rows, c) {
    const at = n => rows.findIndex(r => commentable(r) && r[c.side] === n);
    const first = at(c.start), last = at(c.end);
    return first < 0 || last < 0 ? null : { first, last };
  }

  const where = c => `${c.start === c.end ? `Line ${c.start}` : `Lines ${c.start}–${c.end}`}${c.side === 'old' ? ' (removed)' : ''}`;

  // A fence longer than any run of backticks in the code it holds.
  const fence = lines => '`'.repeat(Math.max(3, ...lines.map(l => Math.max(0, ...(l.match(/`+/g) || []).map(r => r.length + 1)))));

  /**
   * Every comment, grouped by file in the order you left them, as one message.
   * summary: anything you also typed in the box, said first.
   */
  function compose(comments, summary = '') {
    const list = (comments || []).filter(c => c && typeof c.body === 'string' && c.body.trim());
    if (!list.length) return '';
    const files = new Map();
    for (const c of list) {
      if (!files.has(c.file)) files.set(c.file, []);
      files.get(c.file).push(c);
    }
    const count = `${list.length} comment${list.length === 1 ? '' : 's'}`;
    const across = files.size === 1 ? '' : ` across ${files.size} files`;
    const out = [
      `I reviewed your changes and left ${count}${across}. Address each one, then tell me in a line per comment what you did about it.`,
      'Line numbers are from the files as your turn left them; if something has moved since, go by the quoted code.',
    ];
    if (summary.trim()) out.push('', summary.trim());
    for (const [file, cs] of files) {
      out.push('', `### ${file}`);
      for (const c of [...cs].sort((x, y) => (x.side === y.side ? x.start - y.start : x.side === 'new' ? -1 : 1))) {
        const quote = Array.isArray(c.quote) ? c.quote : [];
        const f = fence(quote);
        out.push('', `**${where(c)}**`);
        if (quote.length) out.push(`${f}diff`, ...quote, f);
        out.push(c.body.trim());
      }
    }
    return out.join('\n');
  }

  // What's kept between sessions: well-formed comments only, newest last, capped.
  function sanitize(list, now = Date.now(), maxAgeMs = 30 * 864e5) {
    if (!Array.isArray(list)) return [];
    const ok = c => c && typeof c === 'object'
      && typeof c.id === 'string' && typeof c.file === 'string' && c.file
      && typeof c.root === 'string' && typeof c.before === 'string' && typeof c.after === 'string'
      && (c.side === 'new' || c.side === 'old') && Number.isInteger(c.start) && Number.isInteger(c.end) && c.start <= c.end
      && typeof c.body === 'string' && c.body.trim()
      && Array.isArray(c.quote) && c.quote.every(l => typeof l === 'string')
      && !(typeof c.at === 'number' && now - c.at > maxAgeMs);
    return list.filter(ok).slice(-MAX_COMMENTS).map(c => ({ ...c, body: c.body.slice(0, MAX_BODY) }));
  }

  const api = { numberLines, commentable, anchor, rowsFor, where, compose, sanitize, MAX_BODY, MAX_COMMENTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbyLineComments = api;
})(typeof window !== 'undefined' ? window : globalThis);
