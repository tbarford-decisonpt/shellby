// The Claude Code terminal's own conveniences, in Shellby: @ file mentions,
// prompt history, ! shell commands, rewind, /export, permission rules and MCP
// servers. The pieces live in their own modules (fileindex, shellcmd, rewind,
// exporter, claude-setup, mcpadmin, outputstyles); this file is the IPC that
// joins them to the panel, kept out of main.js, which is long enough.
//
// Everything that loosens what Claude may do on its own (an allow rule, a
// removed deny rule, a new MCP server) or runs a program (the first ! command)
// is asked in the isolated confirm window, never decided by the panel.
// Tightening needs no question.
const fs = require('fs');
const os = require('os');
const path = require('path');
const fileIndex = require('./fileindex');
const shellCmd = require('./shellcmd');
const rewind = require('./rewind');
const exporter = require('./exporter');
const claudeSetup = require('./claude/setup');
const mcpAdmin = require('./mcpadmin');
const outputStyles = require('./outputstyles');
const changes = require('./changes');
const btw = require('./btw');
const { run: runCli, skipSettings } = require('./claude/cli');

const MAX_PROMPTS = 100;
const MAX_PROMPT_CHARS = 4000;
const MCP_TIMEOUT_MS = 60000;
// After the sign-in page opens: look for "connected" every 3 s for 5 minutes.
const SIGNIN_POLL_MS = 3000;
const SIGNIN_POLLS = 100;
const isStr = s => typeof s === 'string' && s.length > 0 && s.length < 10000;

// Kept out of the history file: anything that looks like it carries a key.
const SECRET = /(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|AKIA[0-9A-Z]{16}|xox[abposr]-[\w-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY|\b(password|passwd|secret|api[_-]?key|token)\s*[=:]\s*\S{6,})/i;

/** The prompt list with `text` as its newest entry (an earlier copy moves up). Pure. */
function addPrompt(list, text) {
  const t = typeof text === 'string' ? text.trim() : '';
  const prev = Array.isArray(list) ? list.filter(p => typeof p === 'string' && p !== t) : [];
  if (!t || t.length > MAX_PROMPT_CHARS || t.startsWith('/compact') || SECRET.test(t)) return prev.slice(-MAX_PROMPTS);
  return [...prev, t].slice(-MAX_PROMPTS);
}

/**
 * deps: { ipcMain, manager, history, config, confirm, dialog, clipboard, app,
 *   panel(), dialogLook(), changeRef(raw), setupWhere(), setupView(),
 *   runClaude(args, timeout, { cwd }), currentCwd(), toolbox(), lastInit(),
 *   turnEnding(tabId) -> promise of that tab's last diff being noted,
 *   correctionFromTurns(tabId, kind, refs), noteCorrection(tabId, event),
 *   dataDir, stat(event), noteUndone(turns) -> the weekly card's turns taken back,
 *   openExternal(url) -> the browser, log }
 */
function register(deps) {
  const { ipcMain, manager, history, config, confirm, dialog, clipboard, app } = deps;
  let asking = false; // one confirm at a time, so a flood of them can't be clicked through

  async function ask(spec) {
    if (asking) return null;
    asking = true;
    try { return await confirm.ask(deps.panel(), { ...deps.dialogLook(), ...spec }); } finally { asking = false; }
  }

  const tabOf = id => (isStr(id) ? manager.tabs.get(id) : null);
  const cwdOf = id => tabOf(id)?.session.cwd || deps.currentCwd();
  const tildify = p => String(p || '').replace(os.homedir(), '~');

  // ---- what you've sent, for Up and Ctrl+R: a file of its own, not settings
  const promptsFile = path.join(deps.dataDir, 'prompt-history.json');
  let prompts = null;
  const loadPrompts = () => {
    if (prompts) return prompts;
    try { prompts = JSON.parse(fs.readFileSync(promptsFile, 'utf8')); } catch { prompts = []; }
    if (!Array.isArray(prompts)) prompts = [];
    return prompts;
  };
  function rememberPrompt(text) {
    const next = addPrompt(loadPrompts(), text);
    if (next.length === prompts.length && next.every((p, i) => p === prompts[i])) return;
    prompts = next;
    const tmp = `${promptsFile}.tmp`;
    try { fs.writeFileSync(tmp, JSON.stringify(prompts)); fs.renameSync(tmp, promptsFile); } catch { /* a convenience: never worth an error */ }
  }
  ipcMain.handle('prompt:history', () => loadPrompts());

  // ---- @ mentions
  ipcMain.handle('files:suggest', async (_e, { tabId, query } = {}) => {
    const q = typeof query === 'string' ? query.slice(0, 200) : '';
    try {
      return (await fileIndex.suggest(cwdOf(tabId), q, 12)).map(p => ({ path: p, mention: fileIndex.mention(p), dir: p.endsWith('/') }));
    } catch { return []; }
  });

  // ---- ! shell commands
  // The first one asks, in the confirm window: from then on ! is yours to use,
  // the same as typing in a terminal.
  async function shellAllowed() {
    if (config.get('shellAcknowledged')) return true;
    const response = await ask({
      icon: '⌨️', danger: true,
      title: 'Run commands with ! ?',
      message: 'A message that starts with ! runs as a PowerShell command in the conversation\'s folder, with your Windows account\'s permissions, the same as typing it in a terminal.',
      detail: 'Its output shows in the conversation and goes to Claude with your next message.',
      note: 'Shellby asks this once. To send Claude a message that starts with !, type !! instead.',
      buttons: [{ label: 'Let ! run commands', style: 'danger' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
    });
    if (response !== 0) return false;
    config.set({ shellAcknowledged: true });
    return true;
  }

  ipcMain.handle('shell:run', async (_e, { tabId, command } = {}) => {
    const tab = tabOf(tabId);
    const cmd = typeof command === 'string' ? command.trim() : '';
    if (!tab) return { ok: false, error: 'That conversation is closed.' };
    if (!cmd) return { ok: false, error: 'Type a command after the !' };
    if (cmd.length > shellCmd.MAX_COMMAND) return { ok: false, error: 'That command is too long.' };
    if (tab.shellRunning || tab.rewinding) return { ok: false, error: tab.rewinding ? 'Rewinding: try again in a moment.' : 'One command at a time: the last one is still running.' };
    if (!(await shellAllowed())) return { ok: false, cancelled: true, error: 'Not run.' };
    tab.shellRunning = true;
    let r;
    try { r = await shellCmd.run(tab.session.cwd, cmd); } finally { tab.shellRunning = false; }
    if (!manager.tabs.has(tab.id)) return { ok: false, error: 'That conversation is closed.' };
    tab.shellRuns = [...(tab.shellRuns || []), r].slice(-10);
    manager.note(tab.id, { kind: 'shell', command: r.command, output: r.output, code: r.code, timedOut: r.timedOut, ms: r.ms });
    fileIndex.forget(tab.session.cwd);
    rememberPrompt(`!${cmd}`);
    deps.stat('shell-run');
    return { ok: true, code: r.code };
  });

  // ---- /btw: a side question, answered from a fork of the conversation (btw.js)
  // The tab's own CLI (the fake one in tests), in its folder, so --resume finds it.
  ipcMain.handle('btw:ask', async (_e, { tabId, question } = {}) => {
    const tab = tabOf(tabId);
    if (!tab) return { ok: false, error: 'That conversation is closed.' };
    if (tab.btwAsking) return { ok: false, error: 'One side question at a time: the last one is still being answered.' };
    const s = tab.session;
    tab.btwAsking = true;
    let r;
    try {
      r = await btw.ask({
        question, sessionId: s.sessionId, resumeAt: s.resumeAt, model: s.model, cwd: s.cwd, lean: skipSettings(os.homedir()),
      }, (args, timeout, opts) => runCli(s.exePath(), [...(s.argsPrefix || []), ...args], timeout, opts));
    } finally { tab.btwAsking = false; }
    if (r.detail) deps.log?.warn?.(`btw: ${r.detail}`);
    if (r.ok) deps.stat('btw');
    return { ok: r.ok, answer: r.answer, error: r.error };
  });

  // ---- rewind
  ipcMain.handle('rewind:points', (_e, tabId) => {
    const tab = tabOf(tabId);
    if (!tab?.saved) return { points: [] };
    const items = history.load(tab.id);
    const undone = new Set(items.filter(i => i.kind === 'undone').map(i => i.after));
    return {
      busy: tab.session.busy,
      points: rewind.points(items).map(p => {
        const plan = rewind.plan(items, p.turnId);
        return { ...p, conversation: plan.conversation, code: plan.changes.filter(c => !undone.has(c.after)).length };
      }),
    };
  });

  ipcMain.handle('rewind:run', async (_e, { tabId, turnId, conversation = true, code = true } = {}) => {
    const tab = tabOf(tabId);
    if (!tab?.saved || !isStr(turnId)) return { ok: false, error: 'There is nothing to rewind in this conversation.' };
    if (tab.session.busy) return { ok: false, error: 'Let him finish first (or press Stop), then rewind.' };
    if (tab.shellRunning) return { ok: false, error: 'A ! command is still running. Rewind when it has finished.' };
    if (tab.rewinding) return { ok: false, error: 'Already rewinding.' };
    if (tab.branching) return { ok: false, error: 'Making a branch of this one: try again in a moment.' };
    if (!conversation && !code) return { ok: false, error: 'Pick the conversation, the code, or both.' };
    tab.rewinding = true;
    try { return await doRewind(tab, turnId, { conversation, code }); } finally { tab.rewinding = false; }
  });

  async function doRewind(tab, turnId, { conversation, code }) {
    // The last turn's diff is worked out after it ends: wait for it, so it's undone too.
    await deps.turnEnding(tab.id);
    let items = history.load(tab.id);
    let plan = rewind.plan(items, turnId);
    if (!plan.ok) return plan;
    if (conversation && !plan.conversation) {
      return { ok: false, error: 'That part of the conversation is from before Shellby could rewind it. You can still put the code back.' };
    }

    // Undoing turns' code is a correction (corrections.js): what they changed,
    // read now, before the transcript is cut.
    const lesson = code && plan.changes.length ? deps.correctionFromTurns?.(tab.id, 'rewind', { afters: plan.changes.map(c => c.after) }) : null;
    // Awaited, so a lesson card is in the feed before the panel redraws from `kept`;
    // a failure to note one never fails the rewind itself.
    const learn = async () => { if (lesson && restored) await Promise.resolve(deps.noteCorrection?.(tab.id, lesson)).catch(() => {}); };

    // The code first: if a file changed since and can't go back, the
    // conversation is left as it was. Every turn that did go back is marked
    // undone straight away, so trying again carries on from there.
    let restored = 0;
    let turnsBack = 0; // turns whose code went back, for the weekly card
    if (code) {
      const done = new Set(items.filter(i => i.kind === 'undone').map(i => i.after));
      for (const ch of plan.changes) {
        if (done.has(ch.after)) continue; // already undone by hand
        const ref = deps.changeRef({ tabId: tab.id, root: ch.root, before: ch.before, after: ch.after });
        if (!ref) return { ok: false, error: "Couldn't find one of those turns' changes any more, so nothing more was rewound.", restored };
        if (ref.retired) return { ok: false, error: 'Some of that work has been brought home and its copy tidied away. Undo it there with git.', restored };
        const r = await changes.undo(ref);
        if (!r.ok) {
          const more = restored ? ` ${restored} file${restored === 1 ? ' was' : 's were'} already put back from later turns.` : '';
          return { ok: false, error: `${r.error}${more} The conversation was left as it was.`, restored };
        }
        restored += r.restored || 0;
        turnsBack += 1;
        manager.note(tab.id, { kind: 'undone', after: ref.after, restored: r.restored || 0 });
      }
      fileIndex.forget(tab.session.cwd);
    }

    const marker = { t: Date.now(), kind: 'rewound', conversation: !!conversation, code: !!code, restored };
    if (!conversation) {
      manager.note(tab.id, marker);
      await learn();
      if (turnsBack) deps.noteUndone?.(turnsBack);
      return { ok: true, restored, kept: true };
    }

    // Read the transcript again: the undo notes above, and anything else that
    // arrived while the code went back, are part of what's kept or cut.
    items = history.load(tab.id);
    plan = rewind.plan(items, turnId);
    if (!plan.ok) return plan;
    const kept = [...items.slice(0, plan.index), ...plan.tail, marker];
    // The transcript before Claude's side: if the disk says no, nothing has
    // changed for Claude either and the rewind can simply be tried again.
    if (!history.rewrite(tab.id, kept)) return { ok: false, error: "Couldn't save the rewound conversation, so it was left as it was.", restored };
    history.update(tab.id, plan.fresh ? { claudeSessionId: null, resumeAt: null, context: null } : { resumeAt: plan.anchor, context: null });
    await tab.session.rewindTo(plan.fresh ? null : plan.anchor);
    tab.shellRuns = [];
    manager.changed();
    deps.stat('rewound');
    await learn();
    deps.noteUndone?.(items.slice(plan.index).filter(i => i.kind === 'user').length);
    return { ok: true, restored, items: kept, text: plan.text, attachments: plan.attachments };
  }

  // ---- /export
  ipcMain.handle('session:export', async (_e, { id, to } = {}) => {
    const entry = isStr(id) ? history.get(id) : null;
    if (!entry) return { ok: false, error: 'Send it something first: there is nothing to export yet.' };
    const md = exporter.toMarkdown(entry, history.load(id));
    if (to === 'clipboard') {
      // Electron 44's writeText is a promise: report what actually happened.
      try { await clipboard.writeText(md); } catch { return { ok: false, error: "Couldn't copy it: something else is holding the clipboard. Try again." }; }
      return { ok: true, to };
    }
    const r = await dialog.showSaveDialog(deps.panel(), {
      title: 'Export conversation', defaultPath: path.join(app.getPath('documents'), exporter.fileName(entry)),
      filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'Text', extensions: ['txt'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, cancelled: true };
    try { fs.writeFileSync(r.filePath, md); } catch (e) { return { ok: false, error: `Couldn't save it: ${e.message}` }; }
    return { ok: true, to: 'file', path: r.filePath };
  });

  // ---- permission rules
  const LIST_WORDS = { allow: 'run without asking', ask: 'always ask first', deny: 'never run' };
  const SCOPE_WORDS = { user: 'your settings, so every project', project: "this project's shared settings", local: 'your own settings for this project' };

  async function changeRule({ scope, list, rule } = {}, remove) {
    const fail = error => ({ ok: false, error, setup: deps.setupView() });
    const target = claudeSetup.settingsFiles(deps.setupWhere()).find(f => f.scope === scope);
    if (!target) return fail("Shellby can't save rules there.");
    // Adding checks the rule's shape; removing only needs it to be one that's really in
    // the file, word for word, since Claude Code itself writes rules this form would refuse
    // (multi-line commands, very long ones).
    const v = remove
      ? (deps.setupView().permissions.rules.some(r => r.scope === scope && r.list === list && r.rule === rule)
        ? { list, rule }
        : { error: 'That rule changed on disk since this list was made. Rescan and try again.' })
      : claudeSetup.validateRule(list, rule);
    if (v.error) return fail(v.error);
    // Loosening: a new allow rule, or taking away an ask or deny.
    const loosens = remove ? v.list !== 'allow' : v.list === 'allow';
    if (loosens) {
      const response = await ask({
        icon: '🔓', danger: true,
        title: remove ? `Remove this ${v.list} rule?` : 'Add this allow rule?',
        message: remove
          ? `Claude Code will no longer ${LIST_WORDS[v.list]} for this. Your permission mode decides instead.`
          : `Claude Code will run this without asking, in every session that reads ${SCOPE_WORDS[scope]}.`,
        detail: `${v.rule}\n\nIn ${tildify(target.file)}`,
        note: 'A backup of the file is kept beside it.',
        buttons: [{ label: remove ? 'Remove it' : 'Allow it', style: 'danger' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
      });
      if (response !== 0) return { ok: false, cancelled: true, setup: deps.setupView() };
    }
    let r;
    try {
      r = claudeSetup.changeSettings(target.file, s => (remove ? claudeSetup.withoutRule(s, v.list, v.rule) : claudeSetup.withRule(s, v.list, v.rule)));
    } catch { r = { ok: false, error: "Couldn't save your Claude Code settings." }; }
    if (r.ok) deps.stat(remove ? 'rule-removed' : 'rule-saved');
    return { ...r, setup: deps.setupView() };
  }
  ipcMain.handle('setup:save-rule', (_e, req) => changeRule(req || {}, false));
  ipcMain.handle('setup:remove-rule', (_e, req) => changeRule(req || {}, true));

  // ---- MCP servers
  const running = () => [...manager.tabs.values()].filter(t => t.session.proc);

  async function refreshMcp(tabId) {
    const t = tabOf(tabId)?.session.proc ? tabOf(tabId) : running()[0];
    if (!t) return { ok: false, error: 'Statuses come from a running conversation. Send one a message, then try again.' };
    const r = await t.session.request('mcp_status');
    if (!r.ok) return r;
    const servers = Array.isArray(r.response.mcpServers) ? r.response.mcpServers.filter(s => s && typeof s.name === 'string') : [];
    deps.toolbox()?.setInit({ ...(deps.lastInit() || {}), mcp_servers: servers.map(s => ({ name: s.name, status: s.status, ...(s.scope ? { source: s.scope } : {}) })) });
    return { ok: true, servers: servers.length };
  }
  ipcMain.handle('mcp:refresh', (_e, tabId) => refreshMcp(tabId));

  // Reconnect and on/off act on every open conversation that's running, which
  // is what the Toolbox's one list of servers stands for.
  async function everyRunning(tabId, subtype, payload, verb) {
    const tabs = running();
    if (!tabs.length) return { ok: false, error: `${verb} needs a running conversation. Send one a message, then try again.` };
    const results = await Promise.all(tabs.map(t => t.session.request(subtype, payload, MCP_TIMEOUT_MS)));
    await refreshMcp(tabId);
    const failed = results.filter(r => !r.ok);
    if (failed.length === results.length) return { ok: false, error: failed[0].error };
    return { ok: true, done: results.length - failed.length, of: results.length };
  }
  ipcMain.handle('mcp:reconnect', (_e, { tabId, name } = {}) => (isStr(name) ? everyRunning(tabId, 'mcp_reconnect', { serverName: name }, 'Reconnecting') : { ok: false, error: 'Unknown server.' }));
  // Sign in to a server that needs it, without a terminal: the CLI's
  // mcp_authenticate hands back the sign-in page and waits on its own
  // localhost callback, then reconnects that conversation by itself. Shellby
  // opens the page, watches for "connected", and reconnects the other running
  // conversations so they pick up the new sign-in too. A claude.ai connector
  // finishes on claude.ai with no callback: Reconnect afterwards picks it up.
  const signingIn = new Set();
  async function watchSignIn(t, tabId, name) {
    if (signingIn.has(name)) return;
    signingIn.add(name);
    try {
      for (let i = 0; i < SIGNIN_POLLS; i++) {
        await new Promise(r => setTimeout(r, SIGNIN_POLL_MS));
        if (!t.session.proc) return;
        const r = await t.session.request('mcp_status');
        const s = r.ok && Array.isArray(r.response.mcpServers) ? r.response.mcpServers.find(x => x && x.name === name) : null;
        if (s?.status === 'connected') {
          await Promise.all(running().filter(o => o !== t).map(o => o.session.request('mcp_reconnect', { serverName: name }, MCP_TIMEOUT_MS)));
          await refreshMcp(tabId);
          deps.stat('mcp-signed-in');
          return;
        }
        if (s && s.status !== 'needs-auth' && s.status !== 'pending') return;
      }
    } finally { signingIn.delete(name); }
  }
  ipcMain.handle('mcp:signin', async (_e, { tabId, name } = {}) => {
    if (!isStr(name)) return { ok: false, error: 'Unknown server.' };
    const t = tabOf(tabId)?.session.proc ? tabOf(tabId) : running()[0];
    if (!t) return { ok: false, error: 'Signing in needs a running conversation. Send one a message, then try again.' };
    const r = await t.session.request('mcp_authenticate', { serverName: name }, MCP_TIMEOUT_MS);
    if (!r.ok) return r;
    if (!r.response.requiresUserAction) { await refreshMcp(tabId); return { ok: true, done: true }; }
    const url = mcpAdmin.signInUrl(r.response.authUrl);
    if (!url) return { ok: false, error: `${name} didn't give Shellby a sign-in page it could open.` };
    deps.openExternal(url);
    if (r.response.callbackExpected) watchSignIn(t, tabId, name);
    return { ok: true, opened: true, connector: !r.response.callbackExpected };
  });
  ipcMain.handle('mcp:toggle', (_e, { tabId, name, enabled } = {}) => (isStr(name) ? everyRunning(tabId, 'mcp_toggle', { serverName: name, enabled: !!enabled }, 'Turning a server on or off') : { ok: false, error: 'Unknown server.' }));

  ipcMain.handle('mcp:add', async (_e, input) => {
    const built = mcpAdmin.addArgs(input);
    if (built.error) return { ok: false, error: built.error };
    const s = built.summary;
    const cwd = cwdOf(input?.tabId);
    const where = s.scope === 'user' ? mcpAdmin.SCOPE_WORDS.user : `${mcpAdmin.SCOPE_WORDS[s.scope]} (${tildify(cwd)})`;
    const extra = [
      s.env?.length ? `Environment: ${s.env.join(', ')}` : null,
      s.headers?.length ? `Headers: ${s.headers.join(', ')}` : null,
    ].filter(Boolean).join('\n');
    const response = await ask({
      icon: '🔌', danger: s.transport === 'stdio',
      title: `Add the MCP server "${s.name}"?`,
      message: s.transport === 'stdio'
        ? `Claude Code will start this program by itself in every session for ${where}.`
        : `Claude Code will connect to this server in every session for ${where}.`,
      detail: `${s.target}${extra ? `\n\n${extra}` : ''}`,
      note: s.transport === 'stdio'
        ? "It runs with your Windows account's permissions. Only add servers you trust."
        : 'Only add servers you trust: Claude will see what they send back.',
      buttons: [{ label: 'Add it', style: s.transport === 'stdio' ? 'danger' : 'primary' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
    });
    if (response !== 0) return { ok: false, cancelled: true };
    const r = await deps.runClaude(built.args, MCP_TIMEOUT_MS, { cwd });
    if (r.notInstalled) return { ok: false, error: 'Claude Code needs to be installed first.' };
    if (!r.ok) return { ok: false, error: (r.stderr || r.stdout || 'Claude Code said no.').trim().split('\n').slice(-3).join(' ') };
    deps.stat('mcp-added');
    return { ok: true, name: s.name, note: 'New conversations will have it. Ones already running pick it up next time they start.' };
  });

  ipcMain.handle('mcp:remove', async (_e, { tabId, name } = {}) => {
    if (!isStr(name)) return { ok: false, error: 'Unknown server.' };
    const cwd = cwdOf(tabId);
    // Read from the config files, not `claude mcp get`, which would start the server to check on it.
    const found = mcpAdmin.findServer(name, { home: deps.setupWhere().home, cwd });
    const built = mcpAdmin.removeArgs(name, found?.scope);
    if (built.error) return { ok: false, error: built.error };
    const where = found.scope === 'user' ? mcpAdmin.SCOPE_WORDS.user : `${mcpAdmin.SCOPE_WORDS[found.scope]} (${tildify(cwd)})`;
    const response = await ask({
      icon: '🔌', title: `Remove the MCP server "${name}"?`,
      message: `Claude Code will stop using it in sessions for ${where}.`,
      detail: found.target || name,
      buttons: [{ label: 'Remove it', style: 'primary' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
    });
    if (response !== 0) return { ok: false, cancelled: true };
    const r = await deps.runClaude(built.args, MCP_TIMEOUT_MS, { cwd });
    if (!r.ok) return { ok: false, error: (r.stderr || r.stdout || 'Claude Code said no.').trim().split('\n').slice(-3).join(' ') };
    deps.stat('mcp-removed');
    return { ok: true };
  });

  // ---- output styles
  ipcMain.handle('styles:list', () => outputStyles.list({ home: deps.setupWhere().home, cwd: deps.currentCwd() }));

  // changeRule: Toolbox → Team adds a pack's rules the same way (team-ipc.js).
  return { rememberPrompt, changeRule: req => changeRule(req || {}, false) };
}

module.exports = { register, addPrompt };
