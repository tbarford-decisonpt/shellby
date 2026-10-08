// Line diffs for Claude's file edits: what an Edit, MultiEdit, Write or
// NotebookEdit is about to change, as red and green lines.
// Pure, no DOM: the panel draws the rows, main uses editsOf() to keep a compact
// copy on each tool item. Works in the browser and in Node (for tests).
(function (root) {
  const MAX_TEXT = 20000;        // per side; past this the diff is cut short
  const MAX_CELLS = 2000000;     // LCS table size before falling back to "all removed, all added"

  const clip = s => (typeof s === 'string' ? s.slice(0, MAX_TEXT) : '');
  const str = v => typeof v === 'string';

  /**
   * The text changes a write tool makes: [{ old, new }]. `old` is null for a
   * whole-file Write, where the previous contents aren't part of the call.
   * Anything else (or a malformed input) is [].
   */
  function editsOf(name, input) {
    const i = input || {};
    if (name === 'Edit' && str(i.new_string)) return [{ old: clip(i.old_string), new: clip(i.new_string) }];
    if (name === 'MultiEdit' && Array.isArray(i.edits)) {
      return i.edits.filter(e => e && str(e.new_string)).slice(0, 50).map(e => ({ old: clip(e.old_string), new: clip(e.new_string) }));
    }
    if (name === 'Write' && str(i.content)) return [{ old: null, new: clip(i.content) }];
    if (name === 'NotebookEdit') {
      if (i.edit_mode === 'delete') return [{ old: '(this cell)', new: '' }];
      if (str(i.new_source)) return [{ old: i.edit_mode === 'insert' ? '' : null, new: clip(i.new_source) }];
    }
    return [];
  }

  const split = s => (s ? s.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : []);

  /** Line-by-line diff: [{ t: ' ' | '-' | '+', s }]. */
  function diffLines(a, b) {
    const A = split(a), B = split(b);
    let pre = 0;
    while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
    let suf = 0;
    while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
    const a2 = A.slice(pre, A.length - suf), b2 = B.slice(pre, B.length - suf);
    const out = A.slice(0, pre).map(s => ({ t: ' ', s }));
    if (a2.length * b2.length > MAX_CELLS) {
      for (const s of a2) out.push({ t: '-', s });
      for (const s of b2) out.push({ t: '+', s });
    } else {
      // Classic LCS table, walked forwards so removals come before additions.
      const n = a2.length, m = b2.length;
      const w = m + 1;
      const L = new Uint32Array((n + 1) * w);
      for (let x = n - 1; x >= 0; x--) {
        for (let y = m - 1; y >= 0; y--) {
          L[x * w + y] = a2[x] === b2[y] ? L[(x + 1) * w + y + 1] + 1 : Math.max(L[(x + 1) * w + y], L[x * w + y + 1]);
        }
      }
      let x = 0, y = 0;
      while (x < n && y < m) {
        if (a2[x] === b2[y]) { out.push({ t: ' ', s: a2[x] }); x++; y++; }
        else if (L[(x + 1) * w + y] >= L[x * w + y + 1]) out.push({ t: '-', s: a2[x++] });
        else out.push({ t: '+', s: b2[y++] });
      }
      while (x < n) out.push({ t: '-', s: a2[x++] });
      while (y < m) out.push({ t: '+', s: b2[y++] });
    }
    for (const s of A.slice(A.length - suf)) out.push({ t: ' ', s });
    return out;
  }

  /**
   * Rows to draw for one edit, with line numbers when we know where it starts
   * (`line`: the old text's first line in the file). Long unchanged runs fold
   * into { t: '…', n } so a one-line change in a big block stays one screen.
   *   [{ t, s, a?, b? }]  a = old line number, b = new line number
   */
  function rows(edit, { line = null, context = 3 } = {}) {
    const lines = edit.old == null ? split(edit.new).map(s => ({ t: '+', s })) : diffLines(edit.old, edit.new);
    let a = line, b = line;
    const numbered = lines.map(r => {
      const row = { ...r };
      if (a != null) {
        if (r.t !== '+') row.a = a++;
        if (r.t !== '-') row.b = b++;
      }
      return row;
    });
    const out = [];
    for (let i = 0; i < numbered.length;) {
      if (numbered[i].t !== ' ') { out.push(numbered[i++]); continue; }
      let j = i;
      while (j < numbered.length && numbered[j].t === ' ') j++;
      const run = numbered.slice(i, j);
      const head = i === 0 ? 0 : context;              // keep context after a change
      const tail = j === numbered.length ? 0 : context; // and before the next one
      if (run.length > head + tail + 1) {
        out.push(...run.slice(0, head), { t: '…', n: run.length - head - tail }, ...run.slice(run.length - tail));
      } else out.push(...run);
      i = j;
    }
    return out;
  }

  /** { added, removed } line counts across edits. */
  function stats(edits) {
    let added = 0, removed = 0;
    for (const e of edits || []) {
      if (e.old == null) { added += split(e.new).length; continue; }
      for (const r of diffLines(e.old, e.new)) {
        if (r.t === '+') added++;
        else if (r.t === '-') removed++;
      }
    }
    return { added, removed };
  }

  /** The 1-based line `needle` starts on in `text`, or null if it isn't there. */
  function lineOf(text, needle) {
    if (!str(text) || !str(needle) || !needle) return null;
    const at = text.indexOf(needle);
    if (at < 0) return null;
    let n = 1;
    for (let i = text.indexOf('\n'); i !== -1 && i < at; i = text.indexOf('\n', i + 1)) n++;
    return n;
  }

  const api = { editsOf, diffLines, rows, stats, lineOf, MAX_TEXT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbyDiff = api;
})(typeof window !== 'undefined' ? window : globalThis);
