// The Toolbox: its tools, Claude Code's hooks and memory, and the skill shop
// (plugin marketplaces). Hooks and plugins run programs, so each change asks.
// Kept out of main.js, which only wires it up.
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findClaude, run: runCli } = require('../claude-cli');
const claudeSetup = require('../claude-setup');
const confirm = require('../confirm');
const hookDraft = require('../hook-draft');
const { describeHook } = require('../hook-recipes');
const hookTest = require('../hook-test');
const { Marketplace } = require('../marketplace');
const statusLine = require('../statusline');
const { ToolboxWatcher, samePath } = require('../toolbox');

/** d: what main shares (main.js `shared`). */
function wireToolbox(d) {
  // ---- toolbox

  function createToolbox() {
    d.toolbox = new ToolboxWatcher({
      home: os.homedir(),
      getCwd: d.currentCwd,
      getPlugins: () => [],
      seenFile: d.CAPTURE ? null : path.join(app.getPath('userData'), 'toolbox-seen.json'),
      log: d.log,
    });
    d.toolbox.on('changed', tb => d.send(d.panel, 'toolbox', tb));
    d.toolbox.on('learned', trick => {
      if (!d.TRICKS_KIND.has(trick.kind)) return;
      const learned = [{ ...trick, at: Date.now() }, ...(d.config.get('learnedTricks') || [])].slice(0, 30);
      d.config.set({ learnedTricks: learned });
      d.send(d.panel, 'toolbox:learned', trick);
      d.flashState('learned', 5000);
      d.stat('trick-learned');
      d.awardXp('trick', { label: trick.name });
      const noun = { skill: 'skill', agent: 'helper agent', command: 'command' }[trick.kind];
      if (!(d.panel.isVisible() && d.panel.isFocused())) {
        d.notify(`Shellby learned a new ${noun}`, `${trick.name}${trick.description ? `: ${trick.description}` : ''}`.slice(0, 160),
          () => { d.showPanel({ focusInput: false }); d.send(d.panel, 'panel:view', 'toolbox'); }, { tone: 'celebrate' });
      }
    });
    d.toolbox.start();
  }

  // ---- hooks and memory

  // Isolated dev/test runs get a pretend home, and only folders inside it count as
  // projects, so they never read above it or edit the real ~/.claude or a real repo.
  const setupHome = () => (d.ISOLATED ? path.join(app.getPath('userData'), 'claude-home') : os.homedir());
  const setupCwd = () => {
    const c = d.currentCwd();
    // Working in the home folder means "no project": say so with the same home.
    if (samePath(c, os.homedir())) return setupHome();
    const rel = path.relative(setupHome(), c);
    const insideHome = !rel.startsWith('..') && !path.isAbsolute(rel);
    return d.ISOLATED && !insideHome ? setupHome() : c;
  };
  const setupWhere = () => ({ home: setupHome(), cwd: setupCwd(), ceiling: d.ISOLATED ? setupHome() : null });
  const setupView = () => {
    const where = setupWhere();
    const view = claudeSetup.scanSetup({ ...where, plugins: d.toolbox?.plugins() || [] });
    return { ...view, paused: pausedView(claudeSetup.settingsFiles(where)) };
  };
  const HOOK_WHERE = { user: 'your settings, so every project', project: "this project's shared settings", local: 'your own settings for this project' };
  const isAt = at => !!at && typeof at === 'object' && d.isStr(at.event) && Number.isInteger(at.group) && Number.isInteger(at.hook);
  // The confirm window wraps text and folds runs of spaces, so spell long runs out:
  // padding can't push the end of a command out of sight.
  const showCommand = c => c.replace(/ {3,}/g, m => ` [${m.length} spaces] `);
  let hookAsking = false; // one hook question at a time, so a flood of them can't be clicked through

  // Hooks run programs on their own in every session, so each change is asked in
  // the isolated confirm window, never decided by the panel. The panel names a
  // scope (user / project / local), never a path; `at`+`fp` pin the hook it saw.
  async function confirmAndChangeHook({ scope, at, fp, hook: input } = {}, remove = false) {
    const fail = error => ({ ok: false, error, setup: setupView() });
    if (hookAsking) return fail('Answer the open question about a hook first.');
    const target = claudeSetup.settingsFiles(setupWhere()).find(f => f.scope === scope);
    if (!target) return fail("Shellby can't save hooks there.");
    const editing = isAt(at) && d.isStr(fp);
    if (remove && !editing) return fail('Pick a hook to remove.');
    const existing = editing ? setupView().hooks.find(h => h.source === scope && h.fp === fp) : null;
    if (editing && !existing) return { ...fail('That hook changed on disk since this list was made. Rescan and try again.'), conflict: true };
    // Only command hooks are edited here (prompt and http hooks can only be removed).
    if (editing && !remove && !existing.editable) return fail("Shellby can't edit that kind of hook. Open the file to change it.");
    let hook = existing;
    if (!remove) {
      const v = claudeSetup.validateHook(input);
      if (v.error) return fail(v.error);
      hook = v.hook;
    }

    const when = claudeSetup.HOOK_EVENTS.find(e => e.name === hook.event)?.when || `on ${hook.event}`;
    const matching = hook.matcher ? ` (matching ${hook.matcher})` : '';
    const [title, label] = remove ? ['Remove this hook?', 'Remove it'] : editing ? ['Change this hook?', 'Save it'] : ['Add this hook?', 'Add it'];
    // New commands are short and one line (validateHook), so the whole thing is shown.
    // One being removed may be anything already in the file: shown in part, which is enough to recognise it.
    const shown = remove && hook.command.length > 400 ? `${showCommand(hook.command.slice(0, 400))}… (+${hook.command.length - 400} more characters)` : showCommand(hook.command);
    hookAsking = true;
    let response;
    try {
      response = await confirm.ask(d.panel, {
        ...d.dialogLook(), icon: '🪝', danger: !remove, title,
        message: remove
          ? `Claude Code will stop running this ${when}${matching}.`
          : `Claude Code will run this ${when}${matching}, in every session that reads ${HOOK_WHERE[scope]}.`,
        detail: `${shown}\n\nIn ${target.file.replace(os.homedir(), '~')}`,
        note: remove
          ? 'A backup of the file is kept beside it.'
          : "Hooks run with your Windows account's permissions and don't ask first. Only add commands you understand. A backup of the file is kept beside it.",
        buttons: [{ label, style: remove ? 'primary' : 'danger' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
      });
    } finally { hookAsking = false; }
    if (response !== 0) return { ok: false, cancelled: true, setup: setupView() };

    const change = remove ? s => claudeSetup.withoutHook(s, at)
      : editing ? s => claudeSetup.replaceHook(s, at, hook)
        : s => claudeSetup.withHook(s, hook);
    let r;
    try { r = claudeSetup.changeHooks(target.file, change, editing ? { at, fp } : null); } catch { r = { ok: false, error: "Couldn't save your Claude Code settings." }; }
    if (r.ok) d.stat(remove ? 'hook-removed' : 'hook-saved');
    return { ...r, setup: setupView() };
  }

  // ---- pause, resume and test run

  // Claude Code has no off switch for one hook, so Pause takes it out of the
  // settings file and keeps it here, exactly as it was, for Resume to put back.
  // Only main writes this list (the panel can't set it). Resuming one of your own
  // hooks doesn't ask; a project's might be one you paused because you didn't
  // trust it, so that asks first.
  const MAX_PAUSED = 100;
  const pausedList = () => (Array.isArray(d.config.get('pausedHooks')) ? d.config.get('pausedHooks') : []);
  const isEntry = p => !!p && d.isStr(p.id) && d.isStr(p.scope) && d.isStr(p.file) && d.isStr(p.event) && typeof p.matcher === 'string' && !!p.entry && typeof p.entry === 'object' && !Array.isArray(p.entry);

  // The paused hooks of the settings files that load here (a project's only show in that project).
  function pausedView(files) {
    return pausedList().filter(isEntry).flatMap(p => {
      const f = files.find(x => x.scope === p.scope && samePath(x.file, p.file));
      if (!f) return [];
      const type = d.isStr(p.entry.type) ? p.entry.type : 'command';
      const command = String(p.entry.command || p.entry.prompt || p.entry.url || '').slice(0, 1000);
      return [{
        ...describeHook({ type, command }),
        id: `paused:${p.id}`, pausedId: p.id, paused: true, pausedAt: p.at || 0,
        source: p.scope, path: f.file, event: p.event, matcher: p.matcher, type, command,
        timeout: Number.isFinite(p.entry.timeout) ? p.entry.timeout : null, editable: false,
      }];
    });
  }

  async function pauseHook({ scope, at, fp } = {}) {
    const fail = error => ({ ok: false, error, setup: setupView() });
    const changed = () => ({ ...fail('That hook changed on disk since this list was made. Rescan and try again.'), conflict: true });
    if (hookAsking) return fail('Answer the open question about a hook first.');
    const target = claudeSetup.settingsFiles(setupWhere()).find(f => f.scope === scope);
    if (!target || !isAt(at) || !d.isStr(fp)) return fail('Pick a hook to pause.');
    const existing = setupView().hooks.find(h => h.source === scope && h.fp === fp);
    if (!existing) return changed();
    if (pausedList().length >= MAX_PAUSED) return fail(`Shellby keeps up to ${MAX_PAUSED} paused hooks. Resume or forget one first.`);
    const when = claudeSetup.HOOK_EVENTS.find(e => e.name === existing.event)?.when || `on ${existing.event}`;
    hookAsking = true;
    let response;
    try {
      response = await confirm.ask(d.panel, {
        ...d.dialogLook(), icon: '⏸️', title: 'Pause this hook?',
        message: `Claude Code will stop running it ${when} until you resume it.`,
        detail: `${existing.summary}\n\n${showCommand(existing.command.slice(0, 400))}`,
        note: 'Shellby keeps it, and Resume puts it back exactly as it was. Sessions already open keep the hooks they started with.',
        buttons: [{ label: 'Pause it', style: 'primary' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
      });
    } finally { hookAsking = false; }
    if (response !== 0) return { ok: false, cancelled: true, setup: setupView() };

    // Kept first, then taken out: if the write fails, nothing is lost.
    const found = claudeSetup.hookEntry(claudeSetup.readSettings(target.file).data, at);
    if (!found) return changed();
    const id = d.randomUUID();
    d.config.set({ pausedHooks: [...pausedList(), { id, scope, file: target.file, ...found, at: Date.now() }] });
    let r;
    try { r = claudeSetup.changeHooks(target.file, s => claudeSetup.withoutHook(s, at), { at, fp }); } catch { r = { ok: false, error: "Couldn't save your Claude Code settings." }; }
    if (!r.ok) d.config.set({ pausedHooks: pausedList().filter(p => p.id !== id) });
    return { ...r, setup: setupView() };
  }

  async function resumeHook(id) {
    const fail = error => ({ ok: false, error, setup: setupView() });
    const p = pausedList().find(x => isEntry(x) && x.id === id);
    if (!p) return fail("That paused hook isn't there any more.");
    const target = claudeSetup.settingsFiles(setupWhere()).find(f => f.scope === p.scope && samePath(f.file, p.file));
    if (!target) return fail('Open the project it belongs to, then resume it there.');
    if (p.scope !== 'user') {
      if (hookAsking) return fail('Answer the open question about a hook first.');
      const when = claudeSetup.HOOK_EVENTS.find(e => e.name === p.event)?.when || `on ${p.event}`;
      const command = String(p.entry.command || p.entry.prompt || p.entry.url || '');
      hookAsking = true;
      let response;
      try {
        response = await confirm.ask(d.panel, {
          ...d.dialogLook(), icon: '🪝', danger: true, title: 'Resume this hook?',
          message: `Claude Code will run it ${when} again, in every session that reads ${HOOK_WHERE[p.scope]}.`,
          detail: `${showCommand(command.slice(0, 1000))}${command.length > 1000 ? `… (+${command.length - 1000} more characters)` : ''}\n\nIn ${target.file.replace(os.homedir(), '~')}`,
          note: "Hooks run with your Windows account's permissions and don't ask first. Only resume it if you trust where this project came from.",
          buttons: [{ label: 'Resume it', style: 'danger' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
        });
      } finally { hookAsking = false; }
      if (response !== 0) return { ok: false, cancelled: true, setup: setupView() };
    }
    let r;
    // Already back in the file (resumed before a crash, or by hand): just stop listing it as paused.
    const where = { event: p.event, matcher: p.matcher };
    const back = s => (claudeSetup.hasHook(s, where, p.entry) ? s : claudeSetup.withHook(s, where, p.entry));
    try { r = claudeSetup.changeHooks(target.file, back); } catch { r = { ok: false, error: "Couldn't save your Claude Code settings." }; }
    if (r.ok) d.config.set({ pausedHooks: pausedList().filter(x => x.id !== id) });
    return { ...r, setup: setupView() };
  }

  // A paused hook isn't running, so letting go of it doesn't need the confirm window.
  function forgetPausedHook(id) {
    if (!d.isStr(id)) return { ok: false, error: 'Pick a paused hook.', setup: setupView() };
    d.config.set({ pausedHooks: pausedList().filter(x => x.id !== id) });
    return { ok: true, setup: setupView() };
  }

  // Commands you've said yes to testing since Shellby started, in that folder
  // (the same `npm test` does something else in another project), so trying again
  // with different test details doesn't ask every time. One test runs at a time.
  const testedCommands = new Set();
  let testRunning = false;

  async function testHook({ hook: input, payload } = {}) {
    const v = claudeSetup.validateHook(input);
    if (v.error) return { ok: false, error: v.error };
    const hook = v.hook;
    const cwd = setupCwd();
    let body;
    if (payload === undefined || payload === null || payload === '') body = hookTest.samplePayload(hook, cwd);
    else {
      const parsed = hookTest.parsePayload(payload);
      if (parsed.error) return { ok: false, error: parsed.error };
      body = parsed.payload;
    }
    if (testRunning) return { ok: false, error: 'A test run is still going. Wait for it to finish.' };
    const tested = `${cwd}\0${hook.command}`;
    if (!testedCommands.has(tested)) {
      if (hookAsking) return { ok: false, error: 'Answer the open question about a hook first.' };
      const when = claudeSetup.HOOK_EVENTS.find(e => e.name === hook.event)?.when || `on ${hook.event}`;
      hookAsking = true;
      let response;
      try {
        response = await confirm.ask(d.panel, {
          ...d.dialogLook(), icon: '🧪', danger: true, title: 'Run this command once?',
          message: `Shellby will run it now, the way Claude Code would ${when}, with made-up details for the test.`,
          detail: `${showCommand(hook.command)}\n\nIn ${cwd.replace(os.homedir(), '~')}`,
          note: "It runs with your Windows account's permissions, for real: a command that deletes or pushes will do it. Shellby asks once per command and folder until it restarts.",
          buttons: [{ label: 'Run it', style: 'danger' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
        });
      } finally { hookAsking = false; }
      if (response !== 0) return { ok: false, cancelled: true };
      testedCommands.add(tested);
    }
    testRunning = true;
    try {
      const result = await hookTest.runHook({ command: hook.command, payload: body, cwd, timeout: hook.timeout || 60 });
      return { ok: true, result, verdict: hookTest.verdict(hook.event, result) };
    } finally { testRunning = false; }
  }

  // Ask Claude: a hook drafted (or changed) from what the person says. It only
  // fills the form; saving still asks in the confirm window, like any hook.
  let hookDrafting = false;

  async function draftHook(req = {}) {
    if (d.config.get('crabOnly') || !d.claudeStatus?.installed || !d.claudeStatus?.loggedIn) {
      return { ok: false, error: 'Asking Claude needs Claude Code set up and signed in, in Settings.' };
    }
    if (hookDrafting) return { ok: false, error: 'Claude is already working on one. Give it a moment.' };
    hookDrafting = true;
    try {
      return await hookDraft.askClaude(req, { runClaude: d.runClaudeOnce, home: setupHome(), cwd: setupCwd(), log: d.log });
    } finally { hookDrafting = false; }
  }

  // ---- skill shop

  function createShop() {
    // Every shop call runs in an empty folder of its own, so a source like
    // "some/dir" can never resolve to a real folder next to Shellby.
    const cwd = path.join(app.getPath('userData'), 'plugin-cli');
    d.shop = new Marketplace({
      pluginsRoot: path.join(os.homedir(), '.claude', 'plugins'),
      run: async (args, timeout) => {
        // The exe is looked up per call: Claude Code may be installed after Shellby starts.
        const exe = d.claudeStatus?.exe || findClaude(process.env, d.claudePath());
        if (!exe) return { ok: false, notInstalled: true, stdout: '', stderr: '' };
        try { fs.mkdirSync(cwd, { recursive: true }); } catch { /* execFile reports it */ }
        return runCli(exe, args, timeout, { cwd });
      },
    });
  }

  // The shop needs Claude Code; just-the-crab mode hides it, and main enforces that too.
  function shopBlocked() {
    if (!d.shop) return { ok: false, error: 'Shellby is still starting. Try again in a moment.' };
    if (d.config.get('crabOnly')) return { ok: false, error: 'The Skill Shop needs Claude Code. Turn it on in Settings.' };
    return null;
  }

  // One shop dialog at a time, so a busy panel can't stack prompts under your typing.
  async function askOnce(spec) {
    if (d.shopAsking) return null;
    d.shopAsking = true;
    try { return await confirm.ask(d.panel, { ...d.dialogLook(), ...spec }); } finally { d.shopAsking = false; }
  }

  // Plugins can bring hooks and MCP servers that run programs, so installing one
  // is confirmed in an isolated window the panel can't click through. The dialog
  // says where the plugin really comes from, and anything outside Anthropic's
  // marketplaces gets the red warning.
  async function confirmAndInstallPlugin(id) {
    const blocked = shopBlocked();
    if (blocked) return blocked;
    if (!d.shop.known(id)) return { ok: false, error: "That plugin isn't in your marketplaces." };
    const p = d.shop.find(id);
    if (p.installed) return { ok: true, already: true, id, view: d.shop.view() };
    const official = d.shop.suggestedFor(p.marketplace);
    const from = official ? `${official.label} by ${official.by}` : (d.shop.marketplace(p.marketplace)?.source || p.marketplace);
    const shownAt = d.shop.cache?.at; // what the dialog shows comes from this catalog
    const response = await askOnce({
      icon: '🧰', danger: !official,
      title: 'Install plugin?',
      message: `"${p.name}" from ${from}`,
      detail: [p.description, p.url && `Source: ${p.url}`].filter(Boolean).join('\n\n'),
      note: official
        ? 'Plugins can add skills, agents and commands. Some also add hooks or MCP servers that run programs on your PC.'
        : "This marketplace isn't one of Anthropic's. Plugins can add hooks or MCP servers that run programs on your PC, so only install it if you trust whoever publishes it.",
      buttons: [{ label: 'Install', style: 'primary' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
    });
    if (response === null) return { ok: false, canceled: true, busy: true };
    if (response !== 0) return { ok: false, canceled: true };
    // A marketplace refresh that landed while you were deciding could have changed
    // what "Install" means; ask again rather than install something you didn't see.
    if (d.shop.cache?.at !== shownAt) return { ok: false, error: 'The marketplace changed while you were deciding. Check the plugin again and press Install once more.' };
    const r = await d.shop.install(id);
    if (r.ok) {
      d.stat('plugin-installed');
      d.toolbox?.rescan();
    }
    await d.shop.list().catch(() => {}); // best effort: the cache is already patched
    return { ...r, view: d.shop.view() };
  }

  async function confirmAndUninstallPlugin(id) {
    const blocked = shopBlocked();
    if (blocked) return blocked;
    const p = d.shop.known(id) ? d.shop.find(id) : null;
    if (!p?.installed) return { ok: false, error: "That plugin isn't installed." };
    if (p.scope !== 'user') return { ...(await d.shop.uninstall(id)), view: d.shop.view() }; // explains the terminal route
    const response = await askOnce({
      icon: '🧹',
      title: 'Remove plugin?',
      message: `"${p.name}" (${p.marketplace})`,
      detail: 'Its skills, agents and commands go away in new conversations.',
      buttons: [{ label: 'Remove', style: 'primary' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
    });
    if (response === null) return { ok: false, canceled: true, busy: true };
    if (response !== 0) return { ok: false, canceled: true };
    const r = await d.shop.uninstall(id);
    if (r.ok) d.toolbox?.rescan();
    await d.shop.list().catch(() => {});
    return { ...r, view: d.shop.view() };
  }

  // The Shellby plugin itself, one click from Settings: add our marketplace if it
  // isn't there, then install. Same isolated confirm as any plugin.
  const SHELLBY_SOURCE = 'x-salmon/shellby';
  const pluginView = () => ({ state: statusLine.inspectPlugin(d.claudeSettings()) });
  async function confirmAndInstallShellbyPlugin() {
    const blocked = shopBlocked();
    if (blocked) return { ...pluginView(), ...blocked };
    if (pluginView().state === 'on') return pluginView();
    const response = await askOnce({
      icon: '🦀',
      title: 'Install the Shellby plugin?',
      message: `Adds the Shellby marketplace (${SHELLBY_SOURCE}) to Claude Code and installs the Shellby plugin.`,
      detail: 'Its hooks tell Shellby when a Claude Code session works, asks for permission or finishes, in any terminal or editor on this PC.',
      note: 'The hooks only talk to Shellby on this PC (127.0.0.1) and do nothing when Shellby is closed.',
      buttons: [{ label: 'Install', style: 'primary' }, { label: 'Cancel' }], defaultId: 0, cancelId: 1,
    });
    if (response === null) return { ...pluginView(), busy: true };
    if (response !== 0) return pluginView();
    await d.shop.list().catch(() => {});
    const existing = d.shop.marketplace('shellby');
    if (existing && !String(existing.source || '').toLowerCase().includes(SHELLBY_SOURCE)) {
      return { ...pluginView(), error: `You already have a different marketplace called "shellby" (${existing.source}). Remove it in the Skill Shop first.` };
    }
    if (!existing) {
      const added = await d.shop.addMarketplace(SHELLBY_SOURCE);
      if (!added.ok) return { ...pluginView(), error: added.error };
    }
    await d.shop.list({ refresh: true }).catch(() => {});
    const r = await d.shop.install(statusLine.PLUGIN_ID);
    if (r.ok) { d.stat('plugin-installed'); d.toolbox?.rescan(); }
    return { ...pluginView(), ...(r.ok ? { installed: true } : { error: r.error || "Claude Code couldn't install the plugin." }) };
  }

  return {
    askOnce, confirmAndChangeHook, confirmAndInstallPlugin, confirmAndInstallShellbyPlugin, draftHook,
    confirmAndUninstallPlugin, createShop, createToolbox, forgetPausedHook, pauseHook, pluginView,
    resumeHook, setupCwd, setupView, setupWhere, shopBlocked, testHook,
  };
}

module.exports = { wireToolbox };
