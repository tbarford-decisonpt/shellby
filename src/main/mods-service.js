// Toolbox → Mods: check one, turn it on or off, run its tests, open it, remove
// it, or start a conversation that builds a new one (mods.js has the reading).
//
// A mod's code runs inside every Claude Code conversation on this PC, Shellby's
// and the terminal's, so turning one on is asked in the isolated confirm
// window, with what `claude plugin validate` says it can do. So is running its
// tests, which runs its code. Turning one off never asks: that only ever does less.
// What you said yes to is pinned to the mod's files as they were (mods.js stamp):
// if they change while you decide, or between test runs, it asks again.
//
// The panel names a mod by its plugin id; its folder always comes from the
// Toolbox's own scan. Every Claude Code call is the CLI with an argument array.
//
// deps: {
//   toolbox() -> ToolboxWatcher, shop() -> Marketplace, blocked() -> null | { ok: false, error },
//   askOnce(spec) -> Promise<number | null>, runClaude(args, timeoutMs) -> Promise<{ ok, stdout, stderr, notInstalled? }>,
//   uninstallPlugin(id) -> Promise<result>, trash(path) -> Promise, openFolder(dir) -> result, reveal(dir),
//   home, log
// }
const fs = require('fs');
const path = require('path');
const mods = require('./mods');

const VALIDATE_TIMEOUT_MS = 60 * 1000;
const TEST_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_SHOWN = 12;
const isStr = v => typeof v === 'string' && v.length > 0 && v.length < 300;
const GONE = { ok: false, error: "That mod isn't in the Toolbox any more. Rescan and try again." };
const OLD_CLI = "Claude Code couldn't check that mod. Make sure it's up to date (2.1.288 or newer).";
const SET_IN = { project: "this project's .claude/settings.json", local: "this project's .claude/settings.local.json" };

// What the confirm window gives back: null when another Shellby question is open.
const answered = a => (a === 0 ? null : { ok: false, cancelled: true, ...(a === null ? { busy: true } : {}) });
// The mod's files as they were when it was listed: what a yes is pinned to.
const sameMod = (a, b) => !!a && !!b && a.path === b.path && a.stamp === b.stamp && a.version === b.version && a.modules.join('\n') === b.modules.join('\n');

// What the confirm window lists: the worst first, then the hooks by name.
// It never says a mod is safe: the list is read from its source, and code can
// reach for things in ways a reading misses.
function describe(mod, report, home) {
  const lines = report.powers.slice(0, MAX_SHOWN).map(p => `${p.risk === 'high' ? '⚠ ' : '• '}${p.text}`);
  if (report.other.length) lines.push(`• Also uses ${report.other.slice(0, 6).join(', ')}`);
  if (!report.callsKnown) lines.push("• Claude Code couldn't say what it reaches for");
  const hooks = report.hooks.length ? `\n\nHooks: ${report.hooks.slice(0, MAX_SHOWN).join(', ')}${report.hooks.length > MAX_SHOWN ? '…' : ''}` : '';
  return `${lines.join('\n') || '• Nothing Claude Code could see beyond reacting inside it'}${hooks}\n\nIn ${mods.shownPath(mod.path, home)}`;
}

function createModsService(deps) {
  const find = id => (isStr(id) && deps.toolbox()?.current?.mods?.find(m => m.id === id)) || null;
  const view = () => deps.toolbox()?.current || null;
  // Tests you've said yes to running since Shellby started: the folder and its files as they were.
  const testsOk = new Set();
  let testing = false;
  const busy = new Set();

  async function check(id) {
    const blocked = deps.blocked?.();
    if (blocked) return blocked;
    const m = find(id);
    if (!m) return GONE;
    const r = await deps.runClaude(['plugin', 'validate', '--json', m.path], VALIDATE_TIMEOUT_MS);
    if (r.notInstalled) return { ok: false, error: 'Checking a mod needs Claude Code. Set it up in Settings.' };
    // A mod with problems exits 1 with its report all the same.
    let report;
    try { report = mods.parseValidate(JSON.parse(r.stdout)); } catch { report = null; }
    if (!report) {
      deps.log?.warn?.(`mods: validate gave no report for ${m.id}`, (r.stderr || '').slice(0, 300));
      return { ok: false, error: OLD_CLI };
    }
    const p = mods.powers(report);
    return { ok: true, id, stamp: m.stamp, report: { ...report, powers: p.list, other: p.other } };
  }

  async function setEnabled(id, on) {
    const blocked = deps.blocked?.();
    if (blocked) return blocked;
    const m = find(id);
    if (!m) return GONE;
    if (m.source === 'session') return { ok: false, error: "A conversation loaded it with --plugin-dir, so there's no switch for it here." };
    if (m.enabled === !!on) return { ok: true, already: true, toolbox: view() };
    if (m.problem) return { ok: false, error: m.problem };
    // Shellby switches your own setting. One in the project's settings wins over it.
    if (SET_IN[m.setBy]) return { ok: false, error: `${SET_IN[m.setBy][0].toUpperCase()}${SET_IN[m.setBy].slice(1)} turns it ${m.enabled ? 'on' : 'off'}, and that wins over yours. Change "${m.id}" under enabledPlugins there.` };
    if (busy.has(id)) return { ok: false, error: 'Still working on that one.' };
    busy.add(id);
    try {
      if (on) {
        const asked = await askToTurnOn(m);
        if (!asked.ok) return asked;
      }
      const shop = deps.shop();
      if (!shop) return { ok: false, error: 'Shellby is still starting. Try again in a moment.' };
      // A mod written since the shop last listed isn't one it knows yet. A list
      // already under way may have started before it was there: then once more.
      if (!shop.known(id)) {
        shop.invalidate();
        await shop.list().catch(() => null);
        if (!shop.known(id)) {
          shop.invalidate();
          const again = await shop.list().catch(() => null);
          if (again && !again.ok) return { ok: false, error: again.error || "Couldn't ask Claude Code about it." };
        }
        if (!shop.known(id)) return { ok: false, error: `Claude Code doesn't list ${m.name} yet. Rescan, then try again.` };
      }
      const r = await shop.setEnabled(id, !!on);
      if (r.ok) deps.toolbox()?.rescan({ plugins: false });
      return { ...r, toolbox: view() };
    } finally { busy.delete(id); }
  }

  // Check it, then ask. Refused outright when Claude Code says it won't load.
  async function askToTurnOn(m) {
    const c = await check(m.id);
    if (!c.ok) return c;
    if (c.report.errors.length) {
      return { ok: false, report: c.report, error: `Claude Code wouldn't load it: ${c.report.errors[0]}. Fix that, then turn it on.` };
    }
    const answer = await deps.askOnce({
      icon: '🧩', danger: true,
      title: `Turn on the mod ${m.name}?`,
      message: 'Its code runs inside every Claude Code conversation on this PC: in Shellby, your terminal and your editor.',
      detail: describe(m, c.report, deps.home),
      note: `${m.source === 'user' ? 'It is a folder in ~/.claude/skills, written by you, Claude or something else on this PC.' : `It came from the ${m.marketplace} marketplace.`} This list is read from its code, which can't show everything code can do. Only turn on a mod you trust. Turning it off again is one click.`,
      buttons: [{ label: 'Turn it on', style: 'danger' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
    });
    const no = answered(answer);
    if (no) return no;
    // What you said yes to is what gets turned on: not files that changed while you read.
    if (!sameMod(find(m.id), m)) return { ok: false, error: 'The mod changed while you were deciding. Check it again and turn it on once more.' };
    return { ok: true };
  }

  // `claude plugin test` runs the mod's code, so each mod asks, and asks again once its files change.
  async function runTests(id) {
    const blocked = deps.blocked?.();
    if (blocked) return blocked;
    const m = find(id);
    if (!m) return GONE;
    if (!m.tests) return { ok: false, error: `${m.name} has no tests yet (*.test.ts files). Ask Claude to write some.` };
    if (testing) return { ok: false, error: 'A test run is still going. Wait for it to finish.' };
    const pinned = `${m.path}\0${m.stamp}`;
    if (!testsOk.has(pinned)) {
      const answer = await deps.askOnce({
        icon: '🧪', danger: true, title: `Run the tests of ${m.name}?`,
        message: `Claude Code runs its ${m.tests === 1 ? 'test' : `${m.tests} tests`} against the mod, which runs the mod's code.`,
        detail: mods.shownPath(m.path, deps.home),
        note: "It runs with your Windows account's permissions. Shellby asks again if the mod changes.",
        buttons: [{ label: 'Run them', style: 'danger' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
      });
      const no = answered(answer);
      if (no) return no;
      if (!sameMod(find(id), m)) return { ok: false, error: 'The mod changed while you were deciding. Try again.' };
      testsOk.add(pinned);
    }
    testing = true;
    try {
      const r = await deps.runClaude(['plugin', 'test', m.path], TEST_TIMEOUT_MS);
      if (r.notInstalled) return { ok: false, error: 'Running tests needs Claude Code. Set it up in Settings.' };
      if (r.timedOut) return { ok: false, error: `The tests were still going after ${TEST_TIMEOUT_MS / 60000} minutes, so Shellby stopped them.` };
      return { ok: true, id, result: mods.summarizeTest(r) };
    } finally { testing = false; }
  }

  async function remove(id) {
    const m = find(id);
    if (!m) return GONE;
    if (m.source === 'plugin') {
      const r = await deps.uninstallPlugin(id);
      // The shop's own flow says "canceled".
      return r?.canceled ? { ok: false, cancelled: true, ...(r.busy ? { busy: true } : {}) } : { ...r, toolbox: view() };
    }
    const found = mods.removalTarget(m, deps.home);
    if (!found.ok) return found;
    const answer = await deps.askOnce({
      icon: '🗑️', title: `Remove the mod ${m.name}?`,
      message: "Its folder goes to the Recycle Bin, so you can restore it from there. New conversations won't load it; open ones keep it until they end.",
      detail: mods.shownPath(found.target, deps.home),
      buttons: [{ label: 'Move to Recycle Bin', style: 'primary' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
    });
    const no = answered(answer);
    if (no) return no;
    // Looked at again: the folder could have been swapped for a link while you read.
    const still = mods.removalTarget(find(id) || m, deps.home);
    if (!still.ok || still.target !== found.target) return still.ok ? { ok: false, error: 'The mod moved while you were deciding. Rescan and try again.' } : still;
    try {
      await deps.trash(found.target);
    } catch (err) {
      deps.log?.warn?.(`mods: couldn't move ${found.target} to the Recycle Bin: ${err.message}`);
      return { ok: false, error: "Windows wouldn't move it to the Recycle Bin. Is a file in it open somewhere?" };
    }
    deps.toolbox()?.rescan({ plugins: false });
    return { ok: true, toolbox: view() };
  }

  function open(id) {
    const m = find(id);
    return m ? deps.openFolder(m.path) : GONE;
  }

  function reveal(id) {
    const m = find(id);
    if (m) deps.reveal(m.path);
  }

  // The first message of a conversation that builds one, and the folder it starts in.
  function draft(req = {}) {
    const blocked = deps.blocked?.();
    if (blocked) return blocked;
    const named = mods.checkNewName(req.name, view()?.mods || []);
    if (!named.ok) return named;
    const skills = path.join(deps.home, '.claude', 'skills');
    if (fs.existsSync(path.join(skills, named.name))) return { ok: false, error: `There's already a folder called ${named.name} in ~/.claude/skills. Pick another name.` };
    const idea = typeof req.idea === 'string' ? req.idea.trim().slice(0, 2000) : '';
    if (!idea) return { ok: false, error: 'Say what it should do, in a sentence.' };
    let cwd = deps.home;
    try { if (fs.statSync(skills).isDirectory()) cwd = skills; } catch { /* no skills folder yet: Claude makes it */ }
    return { ok: true, name: named.name, cwd, prompt: mods.buildPrompt({ name: named.name, idea, home: deps.home }) };
  }

  function register(ipcMain) {
    const obj = v => (v && typeof v === 'object' ? v : {});
    ipcMain.handle('mods:check', (_e, id) => check(id));
    ipcMain.handle('mods:set-enabled', (_e, req) => setEnabled(obj(req).id, !!obj(req).on));
    ipcMain.handle('mods:test', (_e, id) => runTests(id));
    ipcMain.handle('mods:remove', (_e, id) => remove(id));
    ipcMain.handle('mods:open', (_e, id) => open(id));
    ipcMain.handle('mods:draft', (_e, req) => draft(obj(req)));
    ipcMain.on('mods:reveal', (_e, id) => reveal(id));
  }

  return { check, setEnabled, runTests, remove, open, reveal, draft, register };
}

module.exports = { createModsService, describe };
