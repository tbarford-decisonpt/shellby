// The Toolbox: its tools, prompt snippets, Claude Code's hooks and memory, and
// the skill shop (plugin marketplaces). Kept out of main.js, which only wires
// it up.
const { shell } = require('electron');
const path = require('path');
const claudeSetup = require('../claude-setup');
const hookTest = require('../hook-test');
const snippets = require('../snippets');
const { samePath } = require('../toolbox');

/** d: what main shares with its IPC (main.js ipcDeps). */
function registerToolboxIpc(ipcMain, d) {
  // ---- toolbox
  ipcMain.handle('toolbox:get', () => d.toolbox.current);
  ipcMain.handle('toolbox:rescan', () => { d.toolbox.rescan(); return d.toolbox.current; });
  ipcMain.handle('toolbox:pin', (_e, { kind, name, pinned } = {}) => {
    if (!(d.TRICKS_KIND.has(kind) || kind === 'snippet') || !d.isStr(name)) return d.pinnedTools();
    if (kind === 'snippet' && pinned && !snippets.find(d.snippetList(), name)) return d.pinnedTools();
    const rest = d.pinnedTools().filter(p => !(p.kind === kind && p.name === name));
    d.config.set({ pinnedTools: pinned ? [...rest, { kind, name }].slice(-12) : rest });
    return d.pinnedTools();
  });
  // ---- prompt snippets (Toolbox → Snippets, /name in the box)
  ipcMain.handle('snippets:save', (_e, { snippet, was } = {}) => {
    const list = d.snippetList();
    const r = snippets.save(list, snippet, typeof was === 'string' ? was : null);
    if (!r.ok) return r;
    const from = snippets.normalizeName(was);
    return { ok: true, name: r.name, ...d.setSnippets(r.list, from && from !== r.name ? { from, to: r.name } : null) };
  });
  ipcMain.handle('snippets:remove', (_e, name) => d.setSnippets(snippets.remove(d.snippetList(), d.isStr(name) ? name : '')));
  ipcMain.handle('snippets:duplicate', (_e, name) => {
    const r = snippets.duplicate(d.snippetList(), d.isStr(name) ? name : '');
    return r.ok ? { ok: true, name: r.name, ...d.setSnippets(r.list) } : r;
  });
  ipcMain.on('snippets:used', (_e, name) => { if (d.isStr(name)) d.noteSnippetUse(name); });
  ipcMain.handle('snippets:export', () => d.exportSnippets());
  ipcMain.handle('snippets:import', () => d.importSnippets());
  // The five Shellby starts with, for anyone who deleted them and wants them back.
  ipcMain.handle('snippets:starters', () => d.mergeSnippets(snippets.STARTERS));
  // "/review the auth module" -> the prompt to send. null: not a snippet, send it as it is.
  ipcMain.handle('snippets:expand', (_e, text, tabId) => {
    // Not isStr: a pasted file after /tests can be long. task:send's own limit applies.
    const call = snippets.parseShortcut(typeof text === 'string' ? text.slice(0, d.PANEL_MAX_TEXT) : '', '/');
    // The tab's own folder, for that repo's team snippets.
    const cwd = (d.isStr(tabId) && d.manager.tabs.get(tabId)?.session.cwd) || undefined;
    if (!call) return null;
    const x = d.expandSnippet(call.name, call.args, { max: d.PANEL_MAX_TEXT, cwd });
    // The menu lists the team snippets of Shellby's folder; this conversation is
    // in another. Say so rather than sending "/ship" to Claude as it is.
    if (!x && snippets.find(d.allSnippets(), call.name)?.team) {
      return { ok: false, error: `/${call.name} is a team snippet from ${path.basename(d.currentCwd())}, and this conversation is working somewhere else.` };
    }
    return x;
  });
  ipcMain.on('toolbox:reveal', (_e, p) => {
    // Only reveal files the toolbox itself reported (never arbitrary paths from the renderer).
    const known = d.toolbox.current && ['skills', 'agents', 'commands'].some(k => d.toolbox.current[k].some(t => t.path === p));
    if (known) shell.showItemInFolder(p);
  });

  // ---- hooks and memory (Toolbox → Hooks / Memory)
  // Memory paths are only ever ones a fresh scan lists, so the panel can't aim a write anywhere else.
  const knownMemory = p => d.isStr(p) && claudeSetup.scanMemory(d.setupWhere()).find(m => samePath(m.path, p));
  ipcMain.handle('setup:get', () => d.setupView());
  ipcMain.handle('setup:read-memory', (_e, p) => {
    const m = knownMemory(p);
    return m ? claudeSetup.readMemory(m.path) : { ok: false, error: "Shellby doesn't edit that file." };
  });
  ipcMain.handle('setup:write-memory', (_e, { path: p, text, mtimeMs } = {}) => {
    const m = knownMemory(p);
    if (!m || typeof text !== 'string' || !Number.isFinite(mtimeMs)) return { ok: false, error: "Shellby doesn't edit that file." };
    let r;
    try { r = claudeSetup.writeMemory(m.path, text, mtimeMs); } catch { r = { ok: false, error: "Couldn't save that file." }; }
    if (r.ok) d.stat('memory-saved');
    return { ...r, setup: d.setupView() };
  });
  ipcMain.handle('setup:save-hook', (_e, req) => d.confirmAndChangeHook(req || {}, false));
  ipcMain.handle('setup:remove-hook', (_e, req) => d.confirmAndChangeHook(req || {}, true));
  ipcMain.handle('setup:pause-hook', (_e, req) => d.pauseHook(req || {}));
  ipcMain.handle('setup:resume-hook', (_e, id) => d.resumeHook(id));
  ipcMain.handle('setup:forget-paused-hook', (_e, id) => d.forgetPausedHook(id));
  ipcMain.handle('setup:test-hook', (_e, req) => d.testHook(req || {}));
  // The JSON a hook would get, to show (and change) before a test run.
  ipcMain.handle('setup:sample-hook-input', (_e, hook) => {
    const h = hook && typeof hook === 'object' ? hook : {};
    if (!claudeSetup.HOOK_EVENTS.some(e => e.name === h.event)) return null;
    return hookTest.samplePayload({ event: h.event, matcher: d.isStr(h.matcher) ? h.matcher : '', command: d.isStr(h.command) ? h.command : '' }, d.setupCwd());
  });
  ipcMain.on('setup:reveal', (_e, p) => {
    if (!d.isStr(p)) return;
    const s = d.setupView();
    const hit = [...s.memory.filter(m => m.exists), ...s.hooks, ...s.paused].find(x => samePath(x.path, p));
    if (hit) shell.showItemInFolder(hit.path);
  });

  // ---- skill shop (Claude Code plugin marketplaces)
  // No marketplace refresh (git pull) while an install confirmation is open.
  ipcMain.handle('shop:list', (_e, { refresh = false } = {}) => d.shopBlocked() || d.shop.list({ refresh: !!refresh && !d.shopAsking }));
  ipcMain.handle('shop:install', (_e, id) => d.confirmAndInstallPlugin(id));
  ipcMain.handle('shop:uninstall', (_e, id) => d.confirmAndUninstallPlugin(id));
  ipcMain.handle('shop:add-marketplace', (_e, source) => d.confirmAndAddMarketplace(source));
  ipcMain.on('shop:open', (_e, id) => {
    // Only links the CLI itself reported for a listed plugin.
    const url = d.shop.find(id)?.url;
    if (url) shell.openExternal(url);
  });
}

module.exports = { registerToolboxIpc };
