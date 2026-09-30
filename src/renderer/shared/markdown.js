// Small, safe Markdown -> HTML for Claude's replies.
// Safety model: the whole input is HTML-escaped first; only a fixed set of tags
// is ever produced, and links become inert <a data-href> handled by the app
// (https only). Works in the browser and in Node (for tests).
(function (root) {
  const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function inline(s) {
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (_m, c) => `\u0000${codes.push(c) - 1}\u0000`);
    s = s.replace(/\[([^\]\n]+)\]\((https:\/\/[^)\s]+)\)/g, (_m, t, u) => `<a data-href="${u}" href="#">${t}</a>`);
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    // Emphasis must hug its text (`*word*`), so `2 * 3 * 4` and snake_case stay plain.
    s = s.replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1<em>$2</em>');
    return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${codes[i]}</code>`);
  }

  function render(src) {
    const text = esc(String(src ?? '').replace(/\r\n?/g, '\n'));
    const lines = text.split('\n');
    const out = [];
    let para = [];
    let list = null; // { type: 'ul'|'ol', items: [] }

    const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join('\n'))}</p>`); para = []; } };
    const flushList = () => {
      if (list) { out.push(`<${list.type}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.type}>`); list = null; }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
      if (fence) {
        flushPara(); flushList();
        const body = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
        out.push(`<pre><code${fence[1] ? ` data-lang="${fence[1]}"` : ''}>${body.join('\n')}</code></pre>`);
        continue;
      }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { flushPara(); flushList(); out.push(`<h${Math.min(h[1].length + 2, 6)}>${inline(h[2])}</h${Math.min(h[1].length + 2, 6)}>`); continue; }
      const ul = line.match(/^\s*[-*•]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        flushPara();
        const type = ul ? 'ul' : 'ol';
        if (list && list.type !== type) flushList();
        if (!list) list = { type, items: [] };
        list.items.push((ul || ol)[1]);
        continue;
      }
      if (/^\s*$/.test(line)) { flushPara(); flushList(); continue; }
      if (/^\s*(---|\*\*\*)\s*$/.test(line)) { flushPara(); flushList(); out.push('<hr>'); continue; }
      if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += ' ' + line.trim(); continue; }
      flushList();
      para.push(line);
    }
    flushPara(); flushList();
    return out.join('');
  }

  const api = { render, escape: esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbyMarkdown = api;
})(typeof window !== 'undefined' ? window : globalThis);
