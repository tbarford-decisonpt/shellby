/* Shellby panel — Workflows: the editor's model: opening, leaving and validating. */
'use strict';
(function () {
  const { h, api, $ } = SB;
  const W = SB.wfKit;
  const {
    pref, PREF, CONTAINERS, clone, current, nav, go, focusFk, keepFocus, debounce, plural, fill, STEP_INFO,
  } = W;

  // ================================================================ the editor: model

  const ed = {
    def: null, title: '', isNew: true, dirty: false, saved: null, touched: false,
    errors: [], failedSave: false, saving: false, json: false, jsonText: '', jsonError: '',
    layout: pref(PREF.layout, 'map'), // 'map' or 'list'
    sel: null,                        // the map node the inspector shows: 's<n>', 't<n>', 'manual', 'settings'
    map: null,                        // the map on screen, while there is one
    chat: null,                       // Build it with Claude (wf-chat.js), one per workflow (chats)
    trial: false,                     // saved only by Claude's test runs so far: kept switched off until you Save
  };
  // Each saved workflow's chat, by id, while the panel is open: leaving the editor
  // (Save takes you to the list) and coming back carries the conversation on.
  const chats = new Map();
  const keepChat = id => { if (id && ed.chat) chats.set(id, ed.chat); };
  const mapOn = () => !ed.json && ed.layout === 'map';
  const stepSel = s => `s${keyOf(s)}`;
  const trigSel = t => `t${keyOf(t)}`;
  // Where focus goes after a rebuild, in whichever layout is showing.
  const stepFk = s => (mapOn() ? `node-${stepSel(s)}` : `t-${keyOf(s)}`);
  const trigFk = t => (mapOn() ? `node-${trigSel(t)}` : `tr-${keyOf(t)}`);
  const openSteps = new WeakSet();
  const openAdvanced = new WeakSet();
  const waitUnits = new WeakMap();
  const serials = new WeakMap();
  let serialN = 0;
  const keyOf = obj => { if (!serials.has(obj)) serials.set(obj, ++serialN); return serials.get(obj); };

  function blankWorkflow() {
    return { name: '', description: '', enabled: true, cwd: '', concurrency: 'skip', inputs: [], when: [], steps: [] };
  }

  const STEP_DEFAULTS = {
    claude: () => ({ prompt: '', mode: 'smart' }),
    run: () => ({ command: '' }),
    http: () => ({ method: 'GET', url: '' }),
    mcp: () => ({ server: '', tool: '' }),
    file: () => ({ action: 'read', path: '' }),
    ask: () => ({ question: '' }),
    tell: () => ({ to: 'notification', text: '' }),
    if: () => ({ test: '', then: [], else: [] }),
    each: () => ({ over: '', as: 'item', max: 25, steps: [] }),
    set: () => ({ values: {} }),
    wait: () => ({ seconds: 300 }),
    workflow: () => ({ name: '' }),
    stop: () => ({ status: 'ok' }),
    worktree: () => ({ repo: '{{ trigger.repo }}', branch: '' }),
    pr: () => ({ folder: '', title: '', draft: true }),
  };

  const TRIGGER_DEFAULTS = {
    schedule: () => ({ schedule: { type: 'daily', time: '09:00' } }),
    ci: () => ({ on: 'failed', repo: '' }),
    issue: () => ({ on: 'any', repo: '' }),
    shipped: () => ({ kind: 'any', project: '' }),
    task: () => ({ outcome: 'any' }),
    folder: () => ({ path: '', pattern: '', events: 'added' }),
    workflow: () => ({ name: '', status: 'any' }),
  };

  function walk(steps, fn) {
    for (const s of steps || []) {
      fn(s);
      for (const k of CONTAINERS[s.type] || []) walk(s[k], fn);
    }
  }

  function countSteps() { let n = 0; walk(ed.def.steps, () => { n++; }); return n; }

  function takenIds() {
    const taken = new Set();
    walk(ed.def?.steps, s => { if (s.id) taken.add(s.id); });
    return taken;
  }

  // claude1, run2…: the same scheme the validator uses, so ids never jump on save.
  function nameSteps(steps, taken) {
    walk(steps, s => {
      if (s.id) return;
      let n = 0;
      let id;
      do { id = `${s.type}${++n}`; } while (taken.has(id));
      taken.add(id);
      s.id = id;
    });
  }

  function normalise(def) {
    const d = clone(def && typeof def === 'object' && !Array.isArray(def) ? def : {});
    for (const k of ['inputs', 'when', 'steps']) if (!Array.isArray(d[k])) d[k] = [];
    walk(d.steps, s => { for (const k of CONTAINERS[s.type] || []) if (!Array.isArray(s[k])) s[k] = []; });
    const taken = new Set();
    walk(d.steps, s => { if (s.id) taken.add(s.id); });
    nameSteps(d.steps, taken);
    return d;
  }

  function newStep(type) {
    const s = { type, ...STEP_DEFAULTS[type]() };
    nameSteps([s], takenIds());
    return s;
  }

  function copyStep(step) {
    const c = clone(step);
    walk([c], s => { delete s.id; });
    nameSteps([c], takenIds());
    return c;
  }

  // ================================================================ the editor: opening and leaving

  function openEditor(def, { title, note = null } = {}) {
    const d = normalise(def);
    // A blank new one shows its problems once you start; anything with content is checked straight away.
    const blank = !d.id && !d.name && !d.steps.length && !d.when.length;
    Object.assign(ed, {
      // What Claude said about a draft or a fix opens the chat, so you can carry on from it.
      def: d, isNew: !d.id, dirty: (!d.id && !blank) || !!note, touched: false,
      errors: [], failedSave: false, saving: false, json: false, jsonText: '', jsonError: '',
      title: title || (d.id ? `Edit “${d.name || 'workflow'}”` : 'New workflow'), sel: null, map: null, trial: false,
    });
    W.forgetMcp(); // read again: one may have been added since
    const kept = d.id && chats.get(d.id);
    if (kept) {
      ed.chat = kept;
      if (note) kept.tell(note);
    } else {
      const host = W.chatHost();
      ed.chat = SB.wfChat.create(host, { greeting: note || '' });
      host.bind(ed.chat);
      keepChat(d.id);
    }
    if (d.steps.length === 1) openSteps.add(d.steps[0]);
    if (current().name === 'editor') nav.pop();
    go('editor');
    if (kept) kept.resume();
    // What's on disk, to tell a real change from one that was typed and then put back.
    // Nothing to compare against when it opens with changes already in it.
    ed.saved = ed.dirty ? null : JSON.stringify(ed.def);
    if (!blank) validateSoon.now();
    if (blank) requestAnimationFrame(() => focusFk('wf-name'));
  }

  function unsaved() {
    if (!ed.dirty) return false;
    if (ed.saved === null) return true;
    if (ed.json && ed.jsonText !== JSON.stringify(ed.def, null, 2)) return true;
    return JSON.stringify(ed.def) !== ed.saved;
  }

  function leaveEditor(then) {
    if (!unsaved()) { validateSoon.cancel(); return then(); }
    SB.toast('You have changes that aren\'t saved.', {
      action: 'Discard them', ms: 5000,
      onAction: () => { ed.dirty = false; validateSoon.cancel(); then(); },
    });
  }

  let mapFrame = 0;
  function changed() {
    ed.dirty = true;
    ed.touched = true;
    validateSoon();
    // The map's nodes say what their steps do: keep them in step with what you type.
    cancelAnimationFrame(mapFrame);
    mapFrame = requestAnimationFrame(() => { if (ed.map?.el.isConnected) ed.map.update(); });
  }

  // Structural changes (add, move, delete, a different schedule kind) rebuild the editor.
  function rebuild(focus) {
    keepFocus(W.renderEditor);
    if (focus && !focusFk(focus)) focusFallback(focus);
  }
  function focusFallback(fk) {
    const m = /^(?:up|dn)-(\d+)$/.exec(fk);
    if (m) focusFk(`t-${m[1]}`);
  }

  // ================================================================ the editor: validation

  let validateSeq = 0;
  async function validate() {
    if (!ed.def || current().name !== 'editor') return;
    const seq = ++validateSeq;
    let res;
    try { res = await api.validateWorkflow(ed.def); } catch { return; }
    if (seq !== validateSeq || !res) return;
    ed.errors = res.ok ? [] : normErrors(res.errors);
    if (!ed.errors.length) ed.failedSave = false;
    paintErrors();
  }
  const validateSoon = debounce(validate, 400);
  validateSoon.now = () => { validateSoon.cancel(); validate(); };

  const normErrors = errs => (Array.isArray(errs) ? errs : errs ? [errs] : [])
    .map(e => (typeof e === 'string' ? { path: '', message: e } : { path: String(e?.path || ''), message: String(e?.message || '') }))
    .filter(e => e.message);

  // Error slots: validator path -> the message under that field.
  // Emptied in place for each new editor screen: the other files hold them too.
  const slots = new Map();
  const cards = [];

  const parentPath = p => p.replace(/(\.[^.[\]]+|\[\d+\])$/, '');
  const within = (p, at) => p === at || p.startsWith(`${at}.`) || p.startsWith(`${at}[`);

  function findSlot(path) {
    let p = path;
    while (p) {
      if (slots.has(p)) return slots.get(p);
      const up1 = parentPath(p);
      if (up1 === p) break;
      p = up1;
    }
    return null;
  }

  function paintErrors() {
    for (const s of slots.values()) { s.err.hidden = true; s.err.textContent = ''; s.control?.removeAttribute('aria-invalid'); }
    const loose = [];
    for (const e of ed.errors) {
      const slot = findSlot(e.path);
      if (!slot) { loose.push(e); continue; }
      slot.err.hidden = false;
      slot.err.textContent = slot.err.textContent ? `${slot.err.textContent} ${e.message}` : e.message;
      slot.control?.setAttribute('aria-invalid', 'true');
    }
    for (const c of cards) c.el.classList.toggle('has-err', ed.errors.some(e => within(e.path, c.at)));
    paintSummary(loose);
  }

  function paintSummary(loose) {
    const box = $('wfSummary');
    if (!box) return;
    const items = loose.map(e => h('li', {}, describeAt(e.path) ? h('b', { text: `${describeAt(e.path)}: ` }) : null, e.message));
    const marked = ed.errors.length - loose.length;
    const head = ed.failedSave && ed.errors.length
      ? (marked ? `Not saved yet. ${plural(ed.errors.length, 'thing')} to fix, marked ${mapOn() ? 'on the map' : 'below'}.` : 'Not saved yet.')
      : null;
    box.hidden = !items.length && !head;
    fill(box, head ? h('p', { class: 'wf-summary-head', text: head }) : null, items.length ? h('ul', {}, items) : null);
  }

  const pathTokens = path => [...String(path).matchAll(/([A-Za-z_]+)|\[(\d+)\]/g)].map(m => (m[2] !== undefined ? Number(m[2]) : m[1]));

  // The innermost step a validator path points into: "steps[2].then[0].prompt" -> that step.
  function stepAt(tokens) {
    if (tokens[0] !== 'steps') return null;
    let node = ed.def;
    let found = null;
    for (const t of tokens) {
      node = node?.[t];
      if (node && typeof node === 'object' && !Array.isArray(node) && node.type) found = node;
    }
    return found;
  }

  // "steps[2].then[0].prompt" -> "“Fix it”", for errors with no field to sit under.
  function describeAt(path) {
    const tokens = pathTokens(path);
    if (tokens[0] === 'when' && typeof tokens[1] === 'number') return `Trigger ${tokens[1] + 1}`;
    if (tokens[0] === 'inputs' && typeof tokens[1] === 'number') return `Input ${tokens[1] + 1}`;
    const found = stepAt(tokens);
    return found ? `“${found.label || found.id || STEP_INFO[found.type]?.name}”` : '';
  }

  // The map node that holds a problem, so a failed save can open it.
  function selFor(path) {
    const tokens = pathTokens(path);
    const step = stepAt(tokens);
    if (step) return stepSel(step);
    const t = tokens[0] === 'when' && ed.def.when[tokens[1]];
    if (t) return trigSel(t);
    if (tokens[0] === 'inputs') return 'manual';
    return ['description', 'cwd', 'concurrency'].includes(tokens[0]) ? 'settings' : null;
  }

  Object.assign(W, {
    leaveEditor, ed, openEditor, keepChat, blankWorkflow, unsaved, normErrors, slots, changed, walk, rebuild, keyOf,
    waitUnits, openAdvanced, normalise, validateSoon, mapOn, selFor, within, openSteps, paintErrors, stepFk,
    cards, TRIGGER_DEFAULTS, trigSel, trigFk, countSteps, newStep, stepSel, copyStep,
  });
})();
