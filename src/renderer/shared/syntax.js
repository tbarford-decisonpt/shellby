// Syntax colours for code: fenced blocks in a reply, and the lines of a diff.
// A small scanner driven by a table per language, not a parser: it knows
// comments, strings, numbers, keywords and a little more, which is what makes
// code easy to read at a glance. Pure, no DOM: it hands back tokens, and the
// panel makes them spans with textContent, so nothing here is ever HTML.
// Works in the browser and in Node (for tests).
//
// A tokenizer carries its state from line to line (a block comment or a
// template string that runs on), so a diff can feed it one line at a time.
(function (root) {
  const MAX_LINE = 2000;      // longer lines (minified code) stay plain past this
  const words = s => new Set(s.split(/\s+/).filter(Boolean));

  const C_LIKE = { line: ['//'], block: [['/*', '*/']], str: ['"', "'"] };
  const JS_KW = words(`break case catch class const continue debugger default delete do else export extends
    finally for from function if import in instanceof let new of return static super switch this throw try
    typeof var void while with yield async await get set as`);
  const TS_KW = words(`${[...JS_KW].join(' ')} interface type enum implements namespace declare abstract public
    private protected readonly keyof infer is satisfies module`);
  const JS_LIT = words('true false null undefined NaN Infinity');
  const JS_TYPES = words('string number boolean any unknown never object void bigint symbol');

  const LANGS = {
    js: { ...C_LIKE, str: ['"', "'", '`'], multi: ['`'], kw: JS_KW, lit: JS_LIT, caps: true, regex: true, deco: '@' },
    ts: { ...C_LIKE, str: ['"', "'", '`'], multi: ['`'], kw: TS_KW, lit: JS_LIT, types: JS_TYPES, caps: true, regex: true, deco: '@' },
    json: { line: ['//'], block: [['/*', '*/']], str: ['"'], lit: words('true false null'), keys: true },
    py: {
      line: ['#'], str: ['"', "'"], triple: ['"""', "'''"], deco: '@', caps: true,
      kw: words(`and as assert async await break class continue def del elif else except finally for from global
        if import in is lambda nonlocal not or pass raise return try while with yield match case`),
      lit: words('True False None self cls'),
      types: words('int float str bool list dict set tuple bytes object type'),
    },
    sh: {
      line: ['#'], str: ['"', "'"], vars: /^\$(\{[^}\n]*\}|[A-Za-z_]\w*|[0-9#?@*$!-])/, dash: true,
      kw: words(`if then else elif fi for while until do done case esac in function return local export
        readonly declare unset shift exit break continue source alias set trap eval exec select time`),
      lit: words('true false'),
    },
    ps: {
      line: ['#'], block: [['<#', '#>']], str: ['"', "'"], vars: /^\$(\{[^}\n]*\}|[\w:]+)/, nocase: true, dash: true,
      kw: words(`begin break catch class continue data do dynamicparam else elseif end enum exit filter finally
        for foreach from function if in param process return switch throw trap try until using while
        -eq -ne -gt -ge -lt -le -like -notlike -match -notmatch -contains -notcontains -in -notin -and -or
        -not -xor -is -isnot -replace -split -join -f`),
      lit: words('$true $false $null'),
      cmdlet: /^[A-Z][a-z]+-[A-Z]\w*/,
    },
    css: {
      block: [['/*', '*/']], line: [], str: ['"', "'"], dash: true, css: true,
      kw: words('!important'),
    },
    html: { markup: true },
    rust: {
      ...C_LIKE, caps: true, macros: true, life: true,
      kw: words(`as async await break const continue crate dyn else enum extern fn for if impl in let loop match
        mod move mut pub ref return self Self static struct super trait type unsafe use where while`),
      lit: words('true false None Some Ok Err'),
      types: words('i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box'),
    },
    go: {
      ...C_LIKE, str: ['"', "'", '`'], multi: ['`'], caps: false,
      kw: words(`break case chan const continue default defer else fallthrough for func go goto if import interface
        map package range return select struct switch type var`),
      lit: words('true false nil iota'),
      types: words('int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 float32 float64 string bool byte rune error any'),
    },
    c: {
      ...C_LIKE, caps: true, pre: '#',
      kw: words(`auto break case catch class const constexpr continue default delete do else enum explicit extern
        for friend goto if inline namespace new noexcept operator private protected public return sizeof static
        struct switch template this throw try typedef typename union using virtual volatile while abstract
        base foreach in is lock out override params readonly ref sealed var async await get set yield
        extends final finally implements import instanceof interface package super synchronized throws`),
      lit: words('true false null nullptr NULL'),
      types: words('int long short char float double void bool unsigned signed size_t string object byte decimal'),
    },
    sql: {
      line: ['--'], block: [['/*', '*/']], str: ["'", '"'], nocase: true,
      kw: words(`select from where and or not insert into values update set delete create table drop alter add
        index primary key foreign references join left right inner outer full on as group by order having
        limit offset distinct union all exists in is like between case when then else end view with returning
        default unique check constraint begin commit rollback transaction asc desc if replace`),
      lit: words('null true false'),
      types: words('int integer bigint smallint text varchar char boolean date timestamp numeric real serial json jsonb blob'),
    },
    yaml: { line: ['#'], str: ['"', "'"], lit: words('true false null yes no on off ~'), yamlKeys: true },
    toml: { line: ['#'], str: ['"', "'"], triple: ['"""', "'''"], lit: words('true false'), yamlKeys: true, sections: true },
    ini: { line: [';', '#'], str: ['"'], yamlKeys: true, sections: true },
    md: { md: true },
    diff: { diff: true },
  };

  const ALIASES = {
    javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js',
    typescript: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
    jsonc: 'json', json5: 'json',
    python: 'py', py3: 'py',
    bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', shellscript: 'sh',
    powershell: 'ps', pwsh: 'ps', ps1: 'ps', psm1: 'ps', psd1: 'ps',
    scss: 'css', less: 'css',
    xml: 'html', svg: 'html', htm: 'html', vue: 'html', svelte: 'html', xaml: 'html', csproj: 'html',
    rs: 'rust', golang: 'go',
    cpp: 'c', 'c++': 'c', cc: 'c', h: 'c', hpp: 'c', cxx: 'c', cs: 'c', csharp: 'c', java: 'c', kotlin: 'c', kt: 'c',
    swift: 'c', dart: 'c', php: 'c',
    yml: 'yaml', cfg: 'ini', conf: 'ini', properties: 'ini', gitconfig: 'ini', editorconfig: 'ini',
    markdown: 'md', mdx: 'md', patch: 'diff',
  };

  /** A fence's info string ("```ts title=x") or a name, as a language key, or null. */
  function langOf(name) {
    const n = String(name || '').trim().split(/[\s{,]/)[0].toLowerCase();
    if (!n) return null;
    if (LANGS[n]) return n;
    return ALIASES[n] || null;
  }

  const FILE_NAMES = { dockerfile: 'sh', makefile: 'sh', '.bashrc': 'sh', '.zshrc': 'sh', '.gitignore': 'ini', '.npmrc': 'ini', '.env': 'ini' };

  /** A file's path as a language key, or null. */
  function langFromPath(p) {
    const base = String(p || '').split(/[\\/]/).pop().toLowerCase();
    if (FILE_NAMES[base]) return FILE_NAMES[base];
    if (base.startsWith('.env')) return 'ini';
    const dot = base.lastIndexOf('.');
    return dot > 0 || (dot === 0 && base.length > 1) ? langOf(base.slice(dot + 1)) : null;
  }

  const IDENT = /^[A-Za-z_$][\w$]*/;
  const IDENT_DASH = /^-?[A-Za-z_][\w-]*/;
  const NUMBER = /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)(?:n|[a-zA-Z%]{1,4})?/;

  function push(out, t, s) {
    if (!s) return;
    const last = out[out.length - 1];
    if (last && last.t === t) last.s += s;
    else out.push({ t, s });
  }

  // Where a string that opened with `q` ends on this line: the index after its
  // closing quote, or -1 if it runs past the end.
  function stringEnd(text, from, q, raw) {
    for (let i = from; i < text.length; i++) {
      if (!raw && text[i] === '\\') { i++; continue; }
      if (text.startsWith(q, i)) return i + q.length;
    }
    return -1;
  }

  // Can a / here start a regex literal (rather than divide)? Only after
  // something that can't end a value.
  function regexAllowed(out) {
    for (let k = out.length - 1; k >= 0; k--) {
      const tk = out[k];
      if (tk.t === null && /^\s*$/.test(tk.s)) continue;
      if (tk.t === 'kw') return /^(return|typeof|case|in|of|new|delete|void|throw|yield|await|else|do)$/.test(tk.s.trim());
      if (tk.t !== null) return false;
      const ch = tk.s.trimEnd().slice(-1);
      return ch === '' || '(,=:[!&|?{};+-*%<>~^'.includes(ch);
    }
    return true;
  }

  function scanCode(spec, text, state, out) {
    let i = 0;
    const n = text.length;
    let lineStart = true;  // only whitespace so far on this line

    // Carry on with whatever the last line left open.
    if (state.in === 'block') {
      const e = text.indexOf(state.end, 0);
      if (e < 0) { push(out, 'com', text); return state; }
      push(out, 'com', text.slice(0, e + state.end.length));
      i = e + state.end.length;
      state = {};
    } else if (state.in === 'str') {
      const e = stringEnd(text, 0, state.q, state.raw);
      if (e < 0) { push(out, 'str', text); return state; }
      push(out, 'str', text.slice(0, e));
      i = e;
      state = {};
    }

    while (i < n) {
      const rest = text.slice(i);
      const ch = text[i];

      if (ch === ' ' || ch === '\t') {
        const m = /^[ \t]+/.exec(rest)[0];
        push(out, null, m);
        i += m.length;
        continue;
      }

      if (spec.sections && lineStart && ch === '[') {
        push(out, 'type', text.slice(i));
        return state;
      }
      if (spec.pre && lineStart && ch === spec.pre) {
        const m = /^#\s*\w+/.exec(rest);
        if (m) { push(out, 'meta', m[0]); i += m[0].length; lineStart = false; continue; }
      }

      // Comments.
      const bc = (spec.block || []).find(([a]) => rest.startsWith(a));
      if (bc) {
        const e = text.indexOf(bc[1], i + bc[0].length);
        if (e < 0) { push(out, 'com', rest); return { in: 'block', end: bc[1] }; }
        push(out, 'com', text.slice(i, e + bc[1].length));
        i = e + bc[1].length;
        lineStart = false;
        continue;
      }
      const lc = (spec.line || []).find(a => rest.startsWith(a));
      // In a shell a # only starts a comment at the start of a word.
      if (lc && !(spec.dash && lc === '#' && i > 0 && !/\s/.test(text[i - 1]))) {
        push(out, 'com', rest);
        return state;
      }

      // Strings.
      const tq = (spec.triple || []).find(q => rest.startsWith(q));
      if (tq) {
        const e = stringEnd(text, i + 3, tq, false);
        if (e < 0) { push(out, 'str', rest); return { in: 'str', q: tq }; }
        push(out, 'str', text.slice(i, e));
        i = e;
        lineStart = false;
        continue;
      }
      if (spec.str && spec.str.includes(ch)) {
        // Rust's lifetimes ('a) aren't strings.
        if (spec.life && ch === "'" && /^'[A-Za-z_]\w*(?!')/.test(rest) && !/^'.'/.test(rest)) {
          const m = /^'[A-Za-z_]\w*/.exec(rest)[0];
          push(out, 'type', m);
          i += m.length;
          continue;
        }
        const raw = spec.dash && ch === "'"; // shells and PowerShell don't escape in single quotes
        const e = stringEnd(text, i + 1, ch, raw);
        const multi = spec.multi && spec.multi.includes(ch);
        if (e < 0) {
          push(out, 'str', rest);
          return multi ? { in: 'str', q: ch, raw } : state;
        }
        const s = text.slice(i, e);
        const isKey = (spec.keys || spec.yamlKeys) && /^\s*:/.test(text.slice(e));
        push(out, isKey ? 'prop' : 'str', s);
        i = e;
        lineStart = false;
        continue;
      }

      if (spec.regex && ch === '/' && regexAllowed(out)) {
        const m = /^\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[a-z]*/.exec(rest);
        if (m) { push(out, 'str', m[0]); i += m[0].length; lineStart = false; continue; }
      }

      if (spec.vars && ch === '$') {
        const m = spec.vars.exec(rest);
        if (m) {
          const low = m[0].toLowerCase();
          push(out, spec.lit && spec.lit.has(low) ? 'lit' : 'var', m[0]);
          i += m[0].length;
          lineStart = false;
          continue;
        }
      }

      if (spec.deco && ch === spec.deco && /^@[A-Za-z_]/.test(rest)) {
        const m = /^@[\w.]+/.exec(rest)[0];
        push(out, 'meta', m);
        i += m.length;
        lineStart = false;
        continue;
      }

      if (spec.css) {
        if (ch === '@') {
          const m = /^@[\w-]+/.exec(rest);
          if (m) { push(out, 'kw', m[0]); i += m[0].length; lineStart = false; continue; }
        }
        if (ch === '#' && /^#[\da-fA-F]{3,8}\b/.test(rest)) {
          const m = /^#[\da-fA-F]{3,8}/.exec(rest)[0];
          push(out, 'num', m);
          i += m.length;
          continue;
        }
        if (rest.startsWith('!important')) { push(out, 'kw', '!important'); i += 10; continue; }
      }

      // Numbers, but not the 2 in x2.
      if (/[\d.]/.test(ch) && !(i > 0 && /[\w$]/.test(text[i - 1]))) {
        const m = NUMBER.exec(rest);
        if (m && /\d/.test(m[0])) {
          push(out, 'num', m[0]);
          i += m[0].length;
          lineStart = false;
          continue;
        }
      }

      // YAML/TOML/INI keys: `name:` or `name =` at the start of a line.
      if ((spec.yamlKeys) && lineStart) {
        const m = /^(-\s+)?([\w.$/@-][\w .$/@-]*?)(\s*)([:=])(?=\s|$)/.exec(rest);
        if (m) {
          if (m[1]) push(out, null, m[1]);
          push(out, 'prop', m[2]);
          push(out, null, m[3] + m[4]);
          i += m[0].length;
          lineStart = false;
          continue;
        }
      }

      if (spec.cmdlet && /[A-Z]/.test(ch)) {
        const m = spec.cmdlet.exec(rest);
        if (m) { push(out, 'fn', m[0]); i += m[0].length; lineStart = false; continue; }
      }

      const idRe = spec.dash ? IDENT_DASH : IDENT;
      const im = (spec.dash && ch === '-' && i > 0 && /[\w]/.test(text[i - 1])) ? null : idRe.exec(rest);
      if (im) {
        let w = im[0];
        if (spec.css && w.startsWith('-') && !/^-[a-z]/i.test(w)) w = '-';
        const key = spec.nocase ? w.toLowerCase() : w;
        const after = text.slice(i + w.length);
        let t = null;
        if (spec.kw && spec.kw.has(key)) t = 'kw';
        else if (spec.lit && spec.lit.has(key)) t = 'lit';
        else if (spec.types && spec.types.has(key)) t = 'type';
        else if (spec.macros && after.startsWith('!')) { t = 'fn'; w += '!'; }
        else if (spec.css && /^\s*:(?!:)/.test(after) && /^[\s;{]*$/.test(text.slice(0, i).slice(-1) || ' ')) t = 'prop';
        else if (/^\s*\(/.test(after)) t = 'fn';
        else if (spec.caps && /^[A-Z][a-z0-9]\w*$/.test(w)) t = 'type';
        push(out, t, w);
        i += w.length;
        lineStart = false;
        continue;
      }

      push(out, null, ch);
      i++;
      lineStart = false;
    }
    return state;
  }

  // HTML and XML: tags, attributes, strings and comments. <script> and <style>
  // bodies stay plain, which is fine for reading.
  function scanMarkup(text, state, out) {
    let i = 0;
    const n = text.length;
    if (state.in === 'com') {
      const e = text.indexOf('-->');
      if (e < 0) { push(out, 'com', text); return state; }
      push(out, 'com', text.slice(0, e + 3));
      i = e + 3;
      state = {};
    }
    while (i < n) {
      const rest = text.slice(i);
      if (state.in === 'tag') {
        const m = /^(\s+)|^(\/?>)|^([^\s=>/"']+)|^(=)|^("[^"]*"?|'[^']*'?)|^(.)/.exec(rest);
        if (m[2]) { push(out, 'tag', m[2]); state = {}; }
        else if (m[3]) push(out, 'attr', m[3]);
        else if (m[5]) push(out, 'str', m[5]);
        else push(out, null, m[0]);
        i += m[0].length;
        continue;
      }
      if (rest.startsWith('<!--')) {
        const e = text.indexOf('-->', i + 4);
        if (e < 0) { push(out, 'com', rest); return { in: 'com' }; }
        push(out, 'com', text.slice(i, e + 3));
        i = e + 3;
        continue;
      }
      const tm = /^<\/?[A-Za-z!?][\w:.-]*/.exec(rest);
      if (tm) {
        push(out, 'tag', tm[0]);
        i += tm[0].length;
        state = { in: 'tag' };
        continue;
      }
      const em = /^&[#\w]+;/.exec(rest);
      if (em) { push(out, 'lit', em[0]); i += em[0].length; continue; }
      const next = text.slice(i + 1).search(/[<&]/);
      const end = next < 0 ? n : i + 1 + next;
      push(out, null, text.slice(i, end));
      i = end;
    }
    return state;
  }

  function scanMarkdown(text, state, out) {
    if (/^\s{0,3}#{1,6}\s/.test(text)) push(out, 'kw', text);
    else if (/^\s{0,3}(```|~~~)/.test(text)) push(out, 'meta', text);
    else if (/^\s*([-*+]|\d+[.)])\s/.test(text)) {
      const m = /^\s*([-*+]|\d+[.)])/.exec(text)[0];
      push(out, 'punct', m);
      push(out, null, text.slice(m.length));
    } else if (/^\s*>/.test(text)) push(out, 'com', text);
    else push(out, null, text);
    return state;
  }

  function scanDiff(text, state, out) {
    const t = /^@@/.test(text) ? 'meta' : /^\+/.test(text) ? 'ins' : /^-/.test(text) ? 'del' : null;
    push(out, t, text);
    return state;
  }

  /**
   * A tokenizer for one language that keeps its place from line to line.
   * line(text) -> [{ t, s }], where t is null (plain) or one of kw, str, com,
   * num, fn, type, lit, var, prop, tag, attr, meta, punct, ins, del. Joining
   * every s gives the line back exactly. Unknown language: one plain token.
   */
  function lineTokenizer(lang) {
    const key = langOf(lang) || (LANGS[lang] ? lang : null);
    const spec = key ? LANGS[key] : null;
    let state = {};
    return {
      lang: key,
      line(text) {
        text = String(text ?? '');
        const out = [];
        if (!spec) { push(out, null, text); return out; }
        const head = text.length > MAX_LINE ? text.slice(0, MAX_LINE) : text;
        state = spec.markup ? scanMarkup(head, state, out)
          : spec.md ? scanMarkdown(head, state, out)
            : spec.diff ? scanDiff(head, state, out)
              : scanCode(spec, head, state, out);
        if (head.length < text.length) push(out, null, text.slice(MAX_LINE));
        return out;
      },
      /** Where it is (for a diff to copy the new side's place to the old side). */
      get state() { return state; },
      set state(s) { state = s || {}; },
    };
  }

  /** Every line of `code`, tokenized: [[{ t, s }]]. */
  function tokenize(code, lang) {
    const tk = lineTokenizer(lang);
    return String(code ?? '').split('\n').map(l => tk.line(l));
  }

  const api = { langOf, langFromPath, lineTokenizer, tokenize, LANGS: Object.keys(LANGS), MAX_LINE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbySyntax = api;
})(typeof window !== 'undefined' ? window : globalThis);
