// Small, safe Markdown -> HTML for Claude's replies.
// Safety model: the whole input is HTML-escaped first; only a fixed set of tags
// is ever produced, and links become inert <a data-href> handled by the app
// (https only). Works in the browser and in Node (for tests).
(function (root) {
  const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Link URLs wait behind this marker until emphasis is done, so `_` or `*` in a
  // URL can't turn into <em> inside the href.
  const URL_MARK = String.fromCharCode(1);
  const URL_HELD = new RegExp(`${URL_MARK}(\\d+)${URL_MARK}`, 'g');
  const CODE_MARK = String.fromCharCode(0);
  const CODE_HELD = new RegExp(`${CODE_MARK}(\\d+)${CODE_MARK}`, 'g');
  const MARKS = new RegExp(`[${CODE_MARK}${URL_MARK}]`, 'g');

  function inline(s) {
    const codes = [];
    const urls = [];
    // A code span in the URL goes back to its literal backticks: no <code> in an href.
    const hold = u => `${URL_MARK}${urls.push(u.replace(CODE_HELD, (_m, i) => `\`${codes[i]}\``)) - 1}${URL_MARK}`;
    // `code`, or ``code with a ` in it``: the run of backticks that opens it closes it.
    s = s.replace(/(`+)(?!`)([^\n]*?[^`\n])\1(?!`)/g, (_m, _t, c) => `\u0000${codes.push(c.replace(/^ (.*) $/, '$1')) - 1}\u0000`);
    // The title shows where it really goes on hover: the text is Claude's to choose.
    const anchor = (t, u) => `<a data-href="${hold(u)}" href="#" title="${hold(u)}">${t}</a>`;
    // One level of parentheses in a URL (a Wikipedia page) stays part of it.
    s = s.replace(/\[([^\]\n]+)\]\((https:\/\/(?:[^()\s]|\([^()\s]*\))+)\)/g, (_m, t, u) => anchor(t.replace(/https:\/\/[^\s<]+/g, hold), u));
    // <https://…> and a bare https:// address link too, less the punctuation that ends a sentence.
    s = s.replace(/&lt;(https:\/\/[^\s&]+(?:&amp;[^\s&]+)*)&gt;/g, (_m, u) => anchor(hold(u), u));
    s = s.replace(/(^|[^\w/="'`])(https:\/\/(?:(?!&(?:lt|gt|quot|#39);)[^\s\u0000\u0001])+)/g, (_m, pre, u) => {
      let tail = '';
      for (;;) {
        const m = u.match(/[.,;:!?*_~]$/) || (u.endsWith(')') && (u.match(/\(/g) || []).length < (u.match(/\)/g) || []).length ? [')'] : null);
        if (!m) break;
        tail = m[0] + tail;
        u = u.slice(0, -m[0].length);
      }
      return u.length > 'https://'.length ? `${pre}${anchor(hold(u), u)}${tail}` : _m;
    });
    s = s.replace(/\*\*\*(?=\S)([^\n]*?\S)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^_\w])__(?=\S)([^\n]*?\S)__(?!\w)/g, '$1<strong>$2</strong>');
    // Emphasis must hug its text (`*word*`), so `2 * 3 * 4` and snake_case stay plain.
    s = s.replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~(?=\S)([^~\n]*?\S)~~/g, '<del>$1</del>');
    s = s.replace(URL_HELD, (_m, i) => urls[i]);
    return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${codes[i]}</code>`);
  }

  // ---- GFM tables
  // Alignment leaves as data-align rather than a style attribute: the panel's
  // CSP is `style-src 'self'`, so an inline style would be dropped on the floor.
  const PIPE = /(?<!\\)\|/;

  // A row's cells: split on unescaped pipes, less the optional outer pair.
  const cells = row => row.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
    .split(PIPE).map(c => c.trim().replace(/\\\|/g, '|'));

  // The `|:---|---:|` row as its per-column alignment, or null if that is not
  // what this line is (left is the default, so it stays unmarked).
  const alignments = row => {
    const cs = cells(row);
    if (!cs.length || !cs.every(c => /^:?-+:?$/.test(c))) return null;
    return cs.map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : null));
  };

  // A line that starts something of its own, so it can't be the lazy last line
  // of a paragraph in a list item or a quote.
  const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)[^`]*$/;
  const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
  const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const QUOTE = /^ {0,3}&gt; ?(.*)$/;
  const ITEM = /^( *)([-*+•]|(\d{1,9})[.)])(?:\s+(.*))?$/;
  const BLANK = /^\s*$/;
  const TASK = /^\[([ xX])\]\s+(.*)$/;
  const indentOf = l => l.match(/^ */)[0].length;
  const starts = l => FENCE.test(l) || HEADING.test(l) || RULE.test(l) || QUOTE.test(l) || ITEM.test(l);

  // Lines -> HTML. Quotes and list items hold blocks of their own, so they come
  // back through here; `tight` drops the <p> round a list item's text.
  function blocks(lines, tight = false) {
    const out = [];
    let para = [];
    const flush = () => {
      if (!para.length) return;
      const body = inline(para.join('\n'));
      out.push(tight ? body : `<p>${body}</p>`);
      para = [];
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = line.match(FENCE);
      if (fence) {
        flush();
        const close = new RegExp(`^ {0,3}${fence[1][0] === '`' ? '`' : '~'}{${fence[1].length},}\\s*$`);
        const body = [];
        for (i++; i < lines.length && !close.test(lines[i]); i++) body.push(lines[i]);
        // A fence that never closes (a reply cut off mid-block) runs to the end,
        // as it would anywhere else; data-open lets the bar say it's unfinished.
        const open = i >= lines.length;
        const lang = fence[2].replace(/^\.+/, '');
        out.push(`<pre><code${lang ? ` data-lang="${lang}"` : ''}${open ? ' data-open="1"' : ''}>${body.join('\n')}</code></pre>`);
        continue;
      }
      if (BLANK.test(line)) { flush(); continue; }
      const h = line.match(HEADING);
      if (h) {
        flush();
        // # is the reply's own title, so it starts at h3: h1 and h2 belong to the panel.
        const n = Math.min(h[1].length + 2, 6);
        out.push(`<h${n}>${inline(h[2])}</h${n}>`);
        continue;
      }
      if (RULE.test(line)) { flush(); out.push('<hr>'); continue; }
      if (QUOTE.test(line)) {
        flush();
        const body = [];
        // Quoted lines, and the lazy ones that carry on its last paragraph.
        for (; i < lines.length; i++) {
          const q = lines[i].match(QUOTE);
          if (q) body.push(q[1]);
          else if (!BLANK.test(lines[i]) && !starts(lines[i]) && !BLANK.test(body[body.length - 1] ?? '')) body.push(lines[i]);
          else break;
        }
        i--;
        out.push(`<blockquote>${blocks(body)}</blockquote>`);
        continue;
      }
      const item = line.match(ITEM);
      // A number can start a list in the middle of a paragraph only as "1.", so
      // a sentence that wraps onto "2024. was a year" stays a sentence.
      if (item && (item[4] !== undefined || !para.length) && !(para.length && item[3] && item[3] !== '1')) {
        flush();
        i = list(lines, i, out) - 1;
        continue;
      }
      // A table, if a delimiter row sits under this one with the same number of
      // cells. Insisting the counts match keeps prose that happens to contain a
      // pipe as prose.
      if (PIPE.test(line)) {
        const head = cells(line);
        const align = alignments(lines[i + 1] ?? '');
        if (align && align.length === head.length) {
          flush();
          const cell = (tag, text, a) => `<${tag}${a ? ` data-align="${a}"` : ''}>${inline(text)}</${tag}>`;
          const body = [];
          for (i += 2; i < lines.length && !BLANK.test(lines[i]) && PIPE.test(lines[i]); i++) {
            const row = cells(lines[i]);
            body.push(`<tr>${head.map((_, c) => cell('td', row[c] ?? '', align[c])).join('')}</tr>`);
          }
          i--; // the loop's own i++ lands us on the line that ended the table
          out.push(`<div class="md-table"><table><thead><tr>${head.map((t, c) => cell('th', t, align[c])).join('')}</tr></thead>${body.length ? `<tbody>${body.join('')}</tbody>` : ''}</table></div>`);
          continue;
        }
      }
      para.push(line.trim());
    }
    flush();
    return out.join('');
  }

  // The list that starts at lines[start], into out; returns the line after it.
  // An item is its marker's line, the lines indented past the marker (a nested
  // list, a code block, a second paragraph) and lazy lines that carry on its text.
  function list(lines, start, out) {
    const first = lines[start].match(ITEM);
    const base = first[1].length;
    const ordered = !!first[3];
    const kind = m => (m[3] ? `o${m[2].slice(-1)}` : `u${m[2]}`);
    const sameKind = kind(first);
    const items = [];
    let loose = false;
    let i = start;
    while (i < lines.length) {
      const m = lines[i].match(ITEM);
      if (!m || m[1].length < base || m[1].length > base + 1 || kind(m) !== sameKind) break;
      const width = base + m[2].length + 1;
      const body = [m[4] ?? ''];
      let gap = false;
      for (i++; i < lines.length; i++) {
        const l = lines[i];
        if (BLANK.test(l)) { body.push(''); continue; }
        const ind = indentOf(l);
        const blankBefore = BLANK.test(body[body.length - 1]);
        if (ind >= base + 2 || (ind > base && !ITEM.test(l))) {
          if (blankBefore) gap = true;
          body.push(l.slice(Math.min(ind, width)));
          continue;
        }
        if (!blankBefore && !starts(l) && !PIPE.test(l)) { body.push(l.trim()); continue; }
        break;
      }
      // Blank lines at the item's end belong between items, not inside one.
      let trailing = 0;
      while (body.length > 1 && BLANK.test(body[body.length - 1])) { body.pop(); trailing++; }
      const next = lines[i]?.match(ITEM);
      const sibling = next && next[1].length >= base && next[1].length <= base + 1 && kind(next) === sameKind;
      if (gap || (trailing && sibling)) loose = true;
      items.push(body);
      if (trailing && !sibling) break;
    }
    const lis = items.map(body => {
      const task = body[0].match(TASK);
      if (task) body = [task[2], ...body.slice(1)];
      const html = blocks(body, !loose);
      return task ? `<li class="md-task" data-done="${task[1] === ' ' ? '0' : '1'}">${html}</li>` : `<li>${html}</li>`;
    }).join('');
    const n = ordered ? Number(first[3]) : 1;
    const tag = ordered ? 'ol' : 'ul';
    out.push(`<${tag}${ordered && n !== 1 ? ` start="${n}"` : ''}${items.some(b => TASK.test(b[0])) ? ' class="md-tasks"' : ''}>${lis}</${tag}>`);
    return i;
  }

  function render(src) {
    // The placeholder characters can't come from the text itself, so no one can forge one.
    const text = esc(String(src ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').replace(MARKS, ''));
    return blocks(text.split('\n'));
  }

  const api = { render, escape: esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbyMarkdown = api;
})(typeof window !== 'undefined' ? window : globalThis);
