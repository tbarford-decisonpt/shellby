// The trail (Ctrl+Shift+E): where Claude has been in your files, worked out
// from a conversation's items as they arrive. Only what it touched: the files
// it read, changed or found in a search, the folders it searched or ran
// commands in, and anything outside the project. Pure: the panel draws it
// (panel/trail.js), and main matches a change's tests against the project's
// files with testsFor (ipc trail:tests). See test/trail.test.js.
(function (root) {
  // Edits to one file in one turn before it reads as going round in circles,
  // and failed edits (the text it meant to replace wasn't there).
  const CIRCLE_WRITES = 3;
  const CIRCLE_FAILS = 2;
  const MAX_HITS = 30;      // files one search lights up
  const MAX_EVENTS = 5000;  // steps kept for a very long conversation; the oldest go
  const MAX_TESTS = 3;      // tests named for one changed file

  const READS = new Set(['Read', 'NotebookRead']);
  const WRITES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
  const SEARCHES = new Set(['Grep', 'Glob']);
  const RUNS = new Set(['Bash', 'PowerShell']);
  // What he holds for each kind of step (shared/workposes.js ITEMS).
  const POSE = { read: 'read', write: 'write', search: 'search', run: 'run' };

  // ------------------------------------------------------------ paths

  /** Forward slashes, no doubled or trailing ones, . and .. worked out. */
  function norm(p) {
    const s = String(p ?? '').trim().replace(/\\/g, '/');
    if (!s) return '';
    const unc = s.startsWith('//');
    const rooted = unc || s.startsWith('/') || /^[a-z]:\//i.test(s);
    // Never above the root: a drive, /, or a share's //server/share.
    const floor = unc ? 2 : /^[a-z]:\//i.test(s) ? 1 : 0;
    const out = [];
    for (const part of s.split('/')) {
      if (part === '' || part === '.') continue;
      if (part !== '..') out.push(part);
      else if (out.length > floor && out[out.length - 1] !== '..') out.pop();
      else if (!rooted) out.push(part);
    }
    const joined = out.join('/');
    if (unc) return `//${joined}`;
    return s.startsWith('/') ? `/${joined}` : joined;
  }
  const keyOf = p => norm(p).toLowerCase(); // Windows paths don't care about case
  const isAbs = p => /^([a-z]:\/|\/)/i.test(String(p).replace(/\\/g, '/'));
  const resolve = (p, base) => (isAbs(p) || !base ? norm(p) : norm(`${base}/${p}`));
  const baseName = p => norm(p).split('/').pop() || norm(p);
  // The last part of a path already in forward slashes (fileindex's), without norm's work.
  const lastPart = f => f.slice(f.lastIndexOf('/') + 1);
  const stem = name => name.replace(/\.[^.]+$/, '');

  /** p relative to the folder `under`, or null when it's somewhere else. */
  function relTo(p, under) {
    const k = keyOf(p), u = keyOf(under);
    if (!u) return null;
    if (k === u) return '';
    return k.startsWith(`${u}/`) ? norm(p).slice(norm(under).length + 1) : null;
  }

  // ------------------------------------------------------------ what a file is

  // Keys, certificates and the files that hold passwords. The examples people
  // commit (.env.example) are meant to be read.
  const SECRET = [/^\.env(\.(?!example$|sample$|template$|dist$)[\w.-]+)?$/i, /\.(pem|key|p12|pfx|jks|keystore|ppk)$/i,
    /^id_(rsa|dsa|ecdsa|ed25519)$/i, /^credentials(\.json)?$/i, /^\.(npmrc|pypirc|netrc|pgpass)$/i, /^secrets?\.(json|ya?ml|toml|env)$/i];
  const isSecret = p => SECRET.some(re => re.test(baseName(p)));

  // A test file, by its folder or its name.
  const TEST_NAME = /(\.(test|spec)\.[^.]+$)|(^test_.+\.py$)|(_test\.(go|py|rb|exs?)$)|((Tests?|Spec)\.(java|kt|cs|swift|scala|php)$)/;
  const isTest = p => {
    const n = norm(p);
    return TEST_NAME.test(baseName(n)) || /(^|\/)(__tests__|tests?|spec)\//i.test(n);
  };

  // Whose test a file is, by its name: app.test.js, app.spec.ts, test_app.py,
  // app_test.go and AppTest.java are all app's. -> the name, lower case, or null.
  // The same names TEST_NAME knows: AppTest with its capital, so contest.js is nobody's test.
  const TEST_OF = [/^(.+)\.(test|spec)\.[^.]+$/i, /^test_(.+)\.py$/i, /^(.+)_test\.(go|py|rb|exs?)$/i, /^(.+?)(Tests?|Spec)\.(java|kt|cs|swift|scala|php)$/];
  function testOf(name) {
    for (const re of TEST_OF) { const m = re.exec(name); if (m) return m[1].toLowerCase(); }
    return null;
  }

  /**
   * The project's test files by whose test they are, in one pass over `files`
   * (relative paths, as fileindex lists them: tens of thousands in a big repo).
   */
  function testIndex(files) {
    const index = new Map();
    for (const f of Array.isArray(files) ? files : []) {
      if (typeof f !== 'string' || f.endsWith('/')) continue;
      const of = testOf(lastPart(f));
      if (!of) continue;
      if (!index.has(of)) index.set(of, []);
      index.get(of).push(f);
    }
    return index;
  }

  /**
   * The tests for `rel`, from testIndex (or a list of files): named after it,
   * nearest first. A test file has none of its own.
   */
  function testsFor(rel, filesOrIndex) {
    if (!rel || isTest(rel)) return [];
    const index = filesOrIndex instanceof Map ? filesOrIndex : testIndex(filesOrIndex);
    const found = index.get(stem(baseName(rel)).toLowerCase()) || [];
    const dir = norm(rel).toLowerCase().split('/').slice(0, -1);
    const near = f => { const d = f.toLowerCase().split('/'); let i = 0; while (i < dir.length && i < d.length - 1 && d[i] === dir[i]) i++; return i; };
    return [...found].sort((a, b) => near(b) - near(a) || a.length - b.length).slice(0, MAX_TESTS);
  }

  // A command that runs a whole test suite.
  const SUITE = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|t)\b|\bnode\s+--test\b|\b(pytest|jest|vitest|mocha|ava|rspec|phpunit|tox)\b|\b(go|cargo|dotnet|deno|mix)\s+test\b|\b(mvn|gradlew?)\b.*\btest\b|\bmake\s+test\b/i;
  /** Did any of `commands` run `test` (a relative path)? Itself by name, or a whole suite. */
  const ranTest = (commands, test) => commands.some(c => SUITE.test(c) || c.toLowerCase().includes(baseName(test).toLowerCase()));

  // ------------------------------------------------------------ search results

  // The files a Grep or Glob found, from its result's text: one per line, alone
  // (files_with_matches, the default, and Glob), before ":<count>" (count), or
  // before ":<line>:" (content). Content from a search of one file has no
  // path on its lines, and its context lines are "path-<line>-": neither is a file.
  const NOT_A_PATH = /^(Found \d+|No (files|matches)|\(Results are truncated|--$)/i;
  const CONTENT_LINE = /^((?:[a-z]:)?[^:]+):\d+:/i;
  function hitsOf(text, base, mode = null) {
    const out = [];
    const seen = new Set();
    for (const raw of String(text || '').split('\n')) {
      const line = raw.trim();
      if (!line || NOT_A_PATH.test(line) || line.length > 500) continue;
      let p;
      if (mode === 'content') {
        const m = CONTENT_LINE.exec(line);
        if (!m) continue;
        p = m[1];
      } else {
        const drive = /^[a-z]:[\\/]/i.test(line) ? line.slice(0, 2) : '';
        p = drive + line.slice(drive.length).split(':')[0];
      }
      if (!/[\\/.]/.test(p) || /\s{2,}/.test(p)) continue;
      const abs = resolve(p, base);
      const k = keyOf(abs);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(abs);
      if (out.length >= MAX_HITS) break;
    }
    return out;
  }

  // ------------------------------------------------------------ the log

  /** An empty trail for a conversation working in `cwd`. */
  function create(cwd = '') {
    return {
      cwd: norm(cwd), events: [], byTool: new Map(), seq: 0, turn: 0, working: false,
      turnIds: new Map(), diffs: [], asks: new Map(), lanes: new Map(),
    };
  }

  function push(s, ev) {
    ev.seq = ++s.seq;
    ev.key = keyOf(ev.path);
    s.events.push(ev);
    if (ev.toolId) s.byTool.set(ev.toolId, ev);
    if (s.events.length > MAX_EVENTS) {
      const gone = s.events.shift();
      if (gone.toolId) s.byTool.delete(gone.toolId);
    }
  }

  // Where a tool step went, from what Claude asked it to do (stream.js `target`).
  // An item saved before `target` existed still has the Read's path as its detail.
  function stepOf(s, item) {
    const t = item.target && typeof item.target === 'object' ? item.target : {};
    const name = item.name;
    if (READS.has(name)) {
      const p = t.path || item.filePath || item.detail;
      return p ? { kind: 'read', path: resolve(p, s.cwd), lines: Array.isArray(t.lines) ? t.lines : null } : null;
    }
    if (WRITES.has(name)) {
      const p = item.filePath || t.path;
      return p ? { kind: 'write', path: resolve(p, s.cwd), edits: Array.isArray(item.edits) ? item.edits.length || 1 : 1 } : null;
    }
    if (SEARCHES.has(name)) {
      return {
        kind: 'search', path: t.path ? resolve(t.path, s.cwd) : s.cwd, pattern: typeof t.pattern === 'string' ? t.pattern.slice(0, 200) : null, dir: true,
        mode: name === 'Grep' && typeof t.mode === 'string' ? t.mode : null,
      };
    }
    if (RUNS.has(name)) return { kind: 'run', path: s.cwd, command: String(item.detail || '').slice(0, 400), dir: true };
    return null;
  }

  /**
   * Take in one of the conversation's items. -> whether the trail changed.
   * Mutates `s`: it's the panel's own working copy, and a long conversation
   * has thousands of these.
   */
  function apply(s, item) {
    if (!s || !item || typeof item !== 'object') return false;
    switch (item.kind) {
      case 'cleared': {
        const fresh = create(s.cwd);
        for (const k of Object.keys(fresh)) s[k] = fresh[k];
        return true;
      }
      case 'user':
        if (item.steerId) return false; // read mid-turn: part of the turn it went into
        s.turn++;
        if (item.turnId) s.turnIds.set(item.turnId, s.turn);
        s.working = true;
        s.asks.clear();
        return true;
      case 'result':
        s.working = false;
        s.asks.clear();
        for (const lane of s.lanes.values()) lane.done = true;
        return true;
      case 'tool': {
        if (item.agent) {
          s.lanes.set(item.id, { index: s.lanes.size, label: item.agent.description || item.agent.type || 'helper', done: false });
          return true;
        }
        if (!s.cwd && !isAbs(item.filePath || item.target?.path || item.detail || '')) return false;
        const step = stepOf(s, item);
        if (!step || !step.path) return false;
        push(s, { ...step, toolId: item.id || null, lane: item.sub && item.parent ? item.parent : null, turn: s.turn, at: item.t || null });
        return true;
      }
      case 'tool_result': {
        const lane = s.lanes.get(item.id);
        if (lane) { lane.done = true; return true; }
        for (const [id, a] of s.asks) if (a.toolId === item.id) s.asks.delete(id);
        const ev = s.byTool.get(item.id);
        if (!ev) return false;
        ev.done = true;
        if (item.isError) {
          ev.failed = true;
          ev.denied = /declined|denied|interrupted|rejected|doesn't want/i.test(String(item.text || ''));
          return true;
        }
        if (ev.kind === 'search') ev.hits = hitsOf(item.text, s.cwd, ev.mode);
        return true;
      }
      case 'moved':
        // Into its own copy: what it did before is the same files there.
        return typeof item.from === 'string' && typeof item.cwd === 'string' ? rebase(s, item.cwd, item.from) : false;
      case 'task':
        if (item.phase === 'done' && s.lanes.has(item.toolUseId)) { s.lanes.get(item.toolUseId).done = true; return true; }
        return false;
      case 'changes': {
        // A turn's git diff: what really changed, whatever ran (a sed in a Bash
        // step too). Its paths are relative to the repository's root.
        if (!Array.isArray(item.files)) return false;
        const turn = (item.turnId && s.turnIds.get(item.turnId)) || s.turn;
        const base = item.root || s.cwd;
        s.diffs = s.diffs.filter(d => d.turn !== turn);
        for (const f of item.files) {
          if (typeof f?.path !== 'string') continue;
          const path = resolve(f.path, base);
          s.diffs.push({ turn, path, key: keyOf(path), status: f.status || 'M', added: Number(f.added) || 0, removed: Number(f.removed) || 0 });
        }
        return true;
      }
      case 'undone': {
        // A turn taken back: its changes are gone from the files.
        const turn = item.turnId && s.turnIds.get(item.turnId);
        if (!turn) return false;
        s.diffs = s.diffs.filter(d => d.turn !== turn);
        return true;
      }
      case 'permission': {
        const p = item.filePath || item.input?.file_path || item.input?.notebook_path;
        if (!p || !item.requestId) return false;
        const path = resolve(p, s.cwd);
        s.asks.set(item.requestId, { path, key: keyOf(path), toolId: item.toolUseId || null });
        return true;
      }
      case 'decision':
        return s.asks.delete(item.requestId);
      default:
        return false;
    }
  }

  /**
   * The conversation moved (into its own copy of the repository, say): what it
   * did in the old folder is the same files in the new one.
   */
  function rebase(s, cwd, from = s.cwd) {
    const to = norm(cwd);
    if (!to || !from || keyOf(to) === keyOf(from)) { if (to) s.cwd = to; return false; }
    const move = (x) => {
      const rel = relTo(x.path, from);
      if (rel === null) return;
      x.path = rel ? `${to}/${rel}` : to;
      x.key = keyOf(x.path);
    };
    s.events.forEach(e => { move(e); if (e.hits) e.hits = e.hits.map(p => { const o = { path: p }; move(o); return o.path; }); });
    s.diffs.forEach(move);
    s.asks.forEach(move);
    s.cwd = to;
    return true;
  }

  /** The step numbered `seq`, or null once it has gone (a very long conversation). */
  const stepAt = (s, seq) => s.events.find(e => e.seq === seq) || null;

  // ------------------------------------------------------------ the view

  function fileEntry(files, path, isDir) {
    const key = keyOf(path);
    let f = files.get(key);
    if (!f) {
      f = {
        key, path: norm(path), dir: !!isDir, reads: 0, writes: 0, fails: 0, denied: 0, hits: 0, searches: 0, runs: 0,
        lines: [], patterns: [], turns: new Set(), lanes: new Set(), lastSeq: 0, lastTool: null, lastWrite: null,
        turnWrites: new Map(), turnFails: new Map(), diff: null, ask: false,
      };
      files.set(key, f);
    }
    return f;
  }
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

  /**
   * What to draw: the tree of what was touched, the crab and his helpers, the
   * counts and the signals. upTo: a step number, for the replay (state as it
   * was then). scope 'turn': only the latest turn shown; 'all': the whole
   * conversation, with earlier turns marked as earlier.
   */
  function view(s, { upTo = Infinity, scope = 'all', busy } = {}) {
    const atEnd = upTo >= s.seq;
    // Whether he's still at it: the panel knows best (a turn cut off leaves no result behind).
    const working = atEnd ? (typeof busy === 'boolean' ? busy && s.working : s.working) : true;
    const evs = atEnd ? s.events : s.events.filter(e => e.seq <= upTo);
    const last = evs[evs.length - 1] || null;
    const turnNow = atEnd ? s.turn : last ? last.turn : 0;
    const inScope = t => scope === 'all' || t === turnNow;
    const files = new Map();
    const commands = [];
    for (const e of evs) {
      if (!inScope(e.turn)) continue;
      const f = fileEntry(files, e.path, e.dir);
      if (!e.dir) f.dir = false; // searched as a folder, but read or changed: a file
      f.turns.add(e.turn);
      if (e.lane) f.lanes.add(e.lane);
      f.lastSeq = e.seq;
      f.lastTool = e.toolId;
      if (e.kind === 'read') { if (e.failed) f.fails++; else f.reads++; if (e.lines) f.lines.push(e.lines); }
      if (e.kind === 'write') {
        // An edit counts once it's done: one waiting for your OK hasn't changed anything yet.
        // Once its turn is over (or in the replay), it's as done as it will be.
        const done = e.done || !atEnd || !working || e.turn !== s.turn;
        if (e.failed) { if (e.denied) f.denied++; else { f.fails++; bump(f.turnFails, e.turn); } } else if (done) { f.writes++; bump(f.turnWrites, e.turn); }
        f.lastWrite = e.toolId;
      }
      if (e.kind === 'search') {
        f.searches++;
        if (e.pattern && !f.patterns.includes(e.pattern)) f.patterns.push(e.pattern);
        for (const hp of e.hits || []) {
          const h = fileEntry(files, hp, false);
          h.hits++;
          h.turns.add(e.turn);
          h.hitBy ||= e.toolId;
        }
      }
      if (e.kind === 'run') { f.runs++; if (e.turn === turnNow && !e.failed) commands.push(e.command); }
    }
    // The diffs of turns that had ended by then.
    for (const d of s.diffs) {
      if (!inScope(d.turn) || (!atEnd && d.turn >= turnNow)) continue;
      const f = fileEntry(files, d.path, false);
      f.turns.add(d.turn);
      const was = f.diff;
      f.diff = {
        status: !was ? d.status : was.status === 'A' && d.status !== 'D' ? 'A' : d.status,
        added: (was?.added || 0) + d.added, removed: (was?.removed || 0) + d.removed, turn: d.turn,
      };
    }
    if (atEnd) for (const a of s.asks.values()) fileEntry(files, a.path, false).ask = true;

    const list = [...files.values()].map(f => finish(f, s.cwd, turnNow));
    const inside = list.filter(f => f.rel !== null);
    const outside = list.filter(f => f.rel === null && !f.dir).sort((a, b) => a.path.localeCompare(b.path));
    const tree = treeOf(inside, s.cwd);

    // Where each crab stands: the main thread's last step, and each helper's.
    const mainLast = [...evs].reverse().find(e => !e.lane && inScope(e.turn)) || null;
    const crab = mainLast ? { key: spotOf(mainLast, s.cwd), pose: POSE[mainLast.kind] || null, working, seq: mainLast.seq } : null;
    const helpers = [];
    for (const [id, lane] of s.lanes) {
      if (atEnd && (lane.done || !working)) continue;
      const e = [...evs].reverse().find(x => x.lane === id && inScope(x.turn));
      if (e && (atEnd || e.turn === turnNow)) helpers.push({ lane: id, index: lane.index, label: lane.label, key: spotOf(e, s.cwd), pose: POSE[e.kind] || null });
    }

    const changed = list.filter(f => !f.dir && (f.writes || f.diff));
    return {
      root: s.cwd, tree, outside, crab, helpers, turn: turnNow, steps: s.seq, at: atEnd ? s.seq : Math.max(0, upTo), live: atEnd,
      counts: {
        read: list.filter(f => !f.dir && f.reads).length, changed: changed.length,
        seen: list.filter(f => !f.dir && f.hits && !f.reads && !f.writes && !f.diff).length,
        outside: outside.length, secrets: list.filter(f => f.secret).length,
      },
      circles: list.filter(f => f.circles).sort((a, b) => b.circles - a.circles),
      secrets: list.filter(f => f.secret && f.fresh), // opened in the turn shown, not one long gone
      // Changed in the turn shown, for the untested check (main finds their tests).
      changedNow: changed.filter(f => f.rel && f.changedNow && !f.isTest).map(f => f.rel),
      commands,
    };
  }

  // A file's marks, in words the panel shows (and tests read).
  function finish(f, cwd, turnNow) {
    const rel = relTo(f.path, cwd);
    const writesNow = f.turnWrites.get(turnNow) || 0;
    const failsNow = f.turnFails.get(turnNow) || 0;
    const circling = writesNow >= CIRCLE_WRITES || failsNow >= CIRCLE_FAILS;
    return {
      ...f,
      rel,
      name: f.dir && rel === '' ? baseName(cwd) : baseName(f.path),
      fresh: f.turns.has(turnNow),
      changedNow: !f.dir && (writesNow > 0 || (f.diff?.turn === turnNow && f.diff.status !== 'D')),
      circles: circling ? writesNow + failsNow : 0,
      secret: !f.dir && isSecret(f.path),
      isTest: !f.dir && isTest(rel ?? f.path),
      turns: [...f.turns],
      lanes: [...f.lanes],
      turnWrites: undefined,
      turnFails: undefined,
    };
  }

  // A step's place on the map: its file, or the folder it searched or ran in ('' is the project).
  function spotOf(e, cwd) {
    if (!e.dir) return e.key;
    const rel = relTo(e.path, cwd);
    return rel === '' ? '' : e.key;
  }

  // The folders and files under the project, folders first, a folder with a
  // single folder in it and nothing marked on it shown as one row (a/b/c).
  function treeOf(entries, cwd) {
    const rootNode = { kind: 'dir', key: '', path: norm(cwd), name: baseName(cwd) || cwd, kids: new Map(), info: null };
    for (const f of entries) {
      if (f.rel === '') { rootNode.info = f; continue; }
      const parts = f.rel.split('/');
      let node = rootNode;
      const depth = f.dir ? parts.length : parts.length - 1;
      for (let i = 0; i < depth; i++) {
        const lower = parts[i].toLowerCase();
        let next = node.kids.get(`d:${lower}`);
        if (!next) {
          const path = `${node.path}/${parts[i]}`;
          next = { kind: 'dir', key: keyOf(path), path, name: parts[i], kids: new Map(), info: null };
          node.kids.set(`d:${lower}`, next);
        }
        node = next;
      }
      if (f.dir) node.info = f;
      else node.kids.set(`f:${f.key}`, { kind: 'file', key: f.key, path: f.path, name: f.name, info: f });
    }
    const shape = (node) => {
      if (node.kind === 'file') return node;
      // a/b/c: merged while there's one folder in it and nothing on it.
      let n = { ...node, kids: [...node.kids.values()].map(shape) };
      while (node !== rootNode && n.kids.length === 1 && n.kids[0].kind === 'dir' && !n.info) {
        const only = n.kids[0];
        n = { ...only, name: `${n.name}/${only.name}` };
      }
      n.kids = [...n.kids].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.kind === 'dir' ? -1 : 1));
      return n;
    };
    return shape(rootNode);
  }

  /** The tree as rows to draw, top to bottom: { node, depth }; a folder in `closed` (keys) hides what's in it. */
  function rows(tree, closed = new Set()) {
    const out = [];
    const walk = (node, depth) => {
      out.push({ node, depth });
      if (node.kind === 'dir' && !closed.has(node.key)) for (const k of node.kids) walk(k, depth + 1);
    };
    if (tree) walk(tree, 0);
    return out;
  }

  /**
   * The files changed in the turn shown whose tests nobody read, changed or ran
   * then. tests: { rel -> [test rel paths] } from main.
   */
  function untested(v, tests) {
    const touched = new Set();
    const walk = n => { if (n.kind === 'file' && n.info.fresh && (n.info.reads || n.info.writes)) touched.add(n.info.rel?.toLowerCase()); (n.kids || []).forEach(walk); };
    if (v.tree) walk(v.tree);
    const out = [];
    for (const rel of v.changedNow) {
      const list = tests && Object.hasOwn(tests, rel) && Array.isArray(tests[rel]) ? tests[rel] : [];
      if (!list.length) continue;
      if (list.some(t => touched.has(t.toLowerCase()) || ranTest(v.commands, t))) continue;
      out.push({ file: rel, tests: list });
    }
    return out;
  }

  const api = {
    create, apply, rebase, stepAt, view, rows, untested, testsFor, testIndex, isTest, isSecret, hitsOf, norm, keyOf, relTo, ranTest,
    CIRCLE_WRITES, CIRCLE_FAILS, MAX_HITS, MAX_EVENTS, MAX_TESTS,
  };
  root.ShellbyTrail = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
