// Projects and what runs in them: the weekly dependency watch (depwatch.js),
// the Projects page and dev servers, and workflows (the Automate page).
// Kept out of main.js, which only wires it up.
const { app, clipboard, safeStorage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run: runCli } = require('../claude-cli');
const confirm = require('../confirm');
const depwatch = require('../depwatch');
const devRunner = require('../devservers/runner');
const devScripts = require('../devservers/scripts');
const mcpServers = require('../mcpservers');
const { DevServers } = require('../devservers/service');
const native = require('../native-windows');
const { Projects } = require('../projects/service');
const { MAX_TABS } = require('../sessions');
const shellCmd = require('../shellcmd');
const streaks = require('../streaks');
const { WorkflowService } = require('../workflows/service');
const worktrees = require('../worktrees');

/** d: what main shares (main.js `shared`). */
function wireProjects(d) {
  // ---- dependency watch

  // The projects it looks at: the git repos Shellby has seen you work in, then
  // your recent folders (depwatch.candidates keeps the ones with a lockfile it can read).
  function depProjects() {
    const s = streaks.normalize(d.config.get('streaks'));
    return depwatch.candidates({
      projects: Object.entries(s.projects).map(([key, p]) => ({ key, name: p.name })),
      recent: d.config.get('recentFolders') || [],
      exclude: [d.worktreeHome()], // a bump task's copy is where the work happens, not a project of its own
      has: (dir, file) => { try { return fs.statSync(path.join(dir, file)).isFile(); } catch { return false; } },
      // The start of a file (is yarn.lock Yarn 1's or Yarn 2+'s?).
      peek: (dir, file) => {
        let fd = null;
        try {
          fd = fs.openSync(path.join(dir, file), 'r');
          const buf = Buffer.alloc(depwatch.PEEK_BYTES);
          return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0));
        } catch { return ''; } finally { if (fd !== null) fs.closeSync(fd); }
      },
    });
  }

  // ---- projects and dev servers

  function createProjects() {
    d.devServers = new DevServers({
      config: d.config,
      dir: path.join(app.getPath('userData'), 'devservers'),
      runner: devRunner,
      info: native.processInfo,
      readScripts: devScripts.read,
      startTask: d.startTask,
      panelFocused: () => !!(d.panel?.isVisible() && d.panel.isFocused()),
      openCard: showServer,
      notify: n => d.notify(n.title, n.body, n.onClick, { tone: n.tone || 'default', action: n.action || null }),
    });
    d.devServers.on('change', v => { d.send(d.panel, 'servers:changed', v); d.refreshCritter(); d.tankGauges?.servers(); });
    d.devServers.on('crashed', v => {
      if (!d.config.get('crabOnly')) d.speak('serverDown');
      d.bugdex?.serverCrashed(v); // a Beached Whale (or what its log says it was) on the loose
    });
    d.devServers.on('up', v => d.bugdex?.serverUp(v));
    d.devServers.on('installed', ({ project }) => d.send(d.panel, 'projects:installed', { project }));
    d.projects = new Projects({
      config: d.config,
      devServers: d.devServers,
      known: d.knownProjects,
      lastWorked: () => new Map(Object.entries(streaks.normalize(d.config.get('streaks')).projects).map(([key, p]) => [key, p.lastSeen || 0])),
      github: () => ({
        signedIn: !!d.github?.signedIn,
        login: d.github?.view().login || null,
        can: f => !!d.github?.can(f),
        gh: () => d.github.gh(),
        claudeEnv: () => d.github.claudeEnv(),
      }),
      insights: d.projectInsights,
      sessions: () => d.history?.list() || [],
      ci: () => d.ciView(),
      // Where every open tab works, its copy or not: a copy any of them is in isn't abandoned.
      copies: () => ({
        home: d.worktreeHome(),
        open: [...(d.manager?.tabs.values() || [])].flatMap(t => [t.worktree?.path, t.session?.cwd]).filter(p => typeof p === 'string'),
      }),
      retireCopy,
      // A cloned project's to-dos are its .shellby/tasks.md, and next_up adds Next up's
      // issues and loose ends to its answer (wiring/backlog.js). Read when used:
      // the backlog is wired after this.
      repoTasks: {
        list: root => d.backlogRepoTasks?.list(root) || [],
        add: (root, text, from) => d.backlogRepoTasks?.add(root, text, from) || { ok: false, error: 'Shellby is still starting up.' },
        finish: (root, ref) => d.backlogRepoTasks?.finish(root, ref) || { ok: false, error: 'Shellby is still starting up.' },
      },
      backlog: (where, opts) => d.backlogForTerminal?.(where, opts) || Promise.resolve([]),
      journal: (roots, name) => {
        const v = d.journal?.view(roots);
        return v ? { ...v, draft: d.journal.draftFor(v.root, name) } : null;
      },
      time: () => d.timeTracker?.state ?? d.config.get('timeTracking'),
      weekly: () => d.config.get('weekly'),
    });
    d.projects.on('change', () => d.send(d.panel, 'projects:changed'));
    d.devServers.reattach();
  }

  // A copy the inbox found abandoned (projects/inbox.js), tidied away. With its
  // History entry, the way "Throw it away" in its conversation does it, so the
  // entry points home again; a copy History has no record of, by git alone.
  // Either way only one of Shellby's own branches (worktrees.checkWorktree).
  async function retireCopy({ path: copyPath, root, branch }) {
    const sameAs = to => p => typeof p === 'string' && path.resolve(p).toLowerCase() === path.resolve(to).toLowerCase();
    const entry = (d.history?.list() || []).find(e => sameAs(copyPath)(e.worktree?.path));
    const w = entry?.worktree;
    // The record has to be about this repo's copy, not one another repository's worktree list points at.
    if (w && !worktrees.checkWorktree(w) && sameAs(root)(w.root)) {
      if (d.manager.tabs.has(entry.id)) return { ok: false, error: 'Its conversation is open. Throw it away from there.' };
      return d.retireWorktree(entry.id, w, { force: true });
    }
    const bare = { path: copyPath, root, branch, base: 'HEAD' };
    const bad = worktrees.checkWorktree(bare);
    if (bad) return { ok: false, error: bad };
    return worktrees.remove(bare, { force: true });
  }

  // A server's card on its project's page (the crab's sign, a toast, the tray).
  function showServer(serverId = null) {
    d.showPanel({ focusInput: false });
    d.send(d.panel, 'panel:view', 'projects');
    d.send(d.panel, 'projects:show', { serverId: serverId || d.devServers?.summary().firstId || null });
  }

  // Quitting with servers running: they keep running unless you chose otherwise
  // (Settings, the Projects page, the tray, and this note the first time).
  async function serversOnQuit() {
    if (!d.devServers?.liveCount()) return;
    let { onQuit, quitNoteSeen } = d.devServers.view().settings;
    if (onQuit === 'keep' && !quitNoteSeen) {
      const n = d.devServers.liveCount();
      const answer = await confirm.ask(d.panel, {
        ...d.dialogLook(),
        icon: '🖥️',
        title: `${n} dev server${n === 1 ? '' : 's'} will keep running`,
        message: `After Shellby closes, ${n === 1 ? 'it keeps' : 'they keep'} running, and Shellby picks ${n === 1 ? 'it' : 'them'} back up, log and all, when it starts again.`,
        note: 'You can change this any time on the Projects page or in Settings.',
        buttons: [{ label: 'Leave them running', style: 'primary' }, { label: 'Stop them' }, { label: 'Always stop them' }],
        defaultId: 0, cancelId: 0,
      });
      d.devServers.setSettings({ quitNoteSeen: true, ...(answer === 2 ? { onQuit: 'stop' } : {}) });
      if (answer === 1 || answer === 2) onQuit = 'stop';
    }
    if (onQuit === 'stop') {
      await Promise.race([d.devServers.stopAll(), new Promise(r => setTimeout(r, 3000))]);
      // Anything still going after that is ended on its own, past Shellby's exit.
      await d.devServers.stopAll({ detached: true });
    }
  }

  function createDepWatch() {
    d.depWatch = new depwatch.DepWatch({
      config: d.config,
      projects: depProjects,
      isOff: () => !!d.config.get('crabOnly'),
      toPanel: (channel, payload) => d.send(d.panel, channel, payload),
      notify: n => d.notify(n.title, n.body, showDepWatch, { urgent: n.urgent, action: 'Have a look' }),
    });
    d.depWatch.start();
  }

  function showDepWatch() {
    d.showPanel({ focusInput: false });
    d.send(d.panel, 'panel:view', 'routines');
  }

  // A task that starts in a copy of its own (worktrees.js), whatever the
  // worktrees setting says: work that ends in a pull request has no business in
  // your checkout. promptFor(worktree) writes the prompt once the branch is known.
  // start: the commit the copy starts from (a pull request's head, startfrom.js), else your HEAD.
  // copy: a worktree already made (an issue's, from its default branch: github/pullrequest.js makeCopy).
  // draft: the prompt waits in the box for you to read and send (Next up, wiring/backlog.js);
  // a copy nothing was ever sent from goes when its tab closes (dropUnsentCopy).
  // attachments(worktree): the files that go with the prompt, as a message sent
  // from the box would carry them (attachments.js), once the copy is known (tries).
  async function startTaskInCopy(dir, title, promptFor, { mode = null, start = 'HEAD', copy = null, draft = false, attachments = null } = {}) {
    if (d.config.get('crabOnly') || !d.claudeStatus?.installed || !d.claudeStatus?.loggedIn) return { ok: false, needsClaude: true, error: 'That needs Claude Code: set it up first.' };
    let w = copy;
    if (!w) {
      const made = await worktrees.create(dir, { home: d.worktreeHome(), title, start });
      if (!made) return { ok: false, noCopy: true, error: "That folder isn't in a git repository." };
      if (!made.ok) return { ok: false, noCopy: true, error: made.error };
      w = made.worktree;
    }
    const tabId = d.randomUUID();
    try {
      const tab = d.openTab({ tabId, title, mode, cwd: w.cwd });
      tab.worktree = w;
      const prompt = promptFor(w);
      // Where it started, so closing it unsent can tell nothing was done in it.
      if (draft) tab.unsentCopy = { head: (await worktrees.git(w.path, ['rev-parse', 'HEAD'], { timeout: 5000 })).out?.trim() || null };
      else {
        const files = typeof attachments === 'function' ? attachments(w) : [];
        if (files.length) d.manager.send(tabId, d.composePrompt(prompt, files), { kind: 'user', text: prompt, attachments: files, title });
        else d.manager.send(tabId, prompt, { kind: 'user', text: prompt, title });
      }
      d.history.update(tabId, { cwd: w.cwd, worktree: w });
      d.manager.note(tabId, { kind: 'moved', branch: w.branch, base: w.base });
      d.wake();
      // A draft has no History entry until it's sent: its title and folder go along instead.
      const entry = d.history.get(tabId) || { title, cwd: w.cwd };
      d.send(d.panel, 'tab:opened', { tabId, entry, items: d.history.load(tabId), background: false, ...(draft ? { busy: false, draft: prompt } : {}) });
      return { ok: true, tabId, worktree: w };
    } catch (err) {
      // Tidy up without letting a second failure hide the first.
      try {
        if (d.manager.tabs.has(tabId)) await d.manager.closeAndWait(tabId);
        if (d.history.get(tabId)) d.history.remove(tabId); // it would point at a copy that's gone
        await worktrees.remove(w, { force: true });
      } catch (e) { d.log.info(`dependency task cleanup: ${e.message}`); }
      return { ok: false, error: err.message };
    }
  }

  // A draft tab (startTaskInCopy's draft) closed before anything was sent from
  // it: a copy with nothing in it goes too, and so does its History entry,
  // which would only point at a folder that's gone. One with changes stays.
  async function dropUnsentCopy(tab) {
    const w = tab?.worktree;
    if (!tab?.unsentCopy?.head || !w) return false;
    if ((d.history.load(tab.id) || []).some(i => i.kind === 'user')) return false;
    const [s, head] = await Promise.all([worktrees.status(w), worktrees.git(w.path, ['rev-parse', 'HEAD'], { timeout: 5000 })]);
    // Ignored files (a .env copied in, a build) are work too: only a copy exactly as it was made goes.
    if (!s?.ok || s.uncommitted || s.ignored?.length || head.out?.trim() !== tab.unsentCopy.head) return false;
    const r = await worktrees.remove(w, { force: true });
    if (!r.ok) { d.log.info(`unsent copy: ${r.error}`); return false; }
    if (d.history.get(tab.id)) d.history.remove(tab.id);
    return true;
  }

  // ---- workflows

  // One tool-less `claude -p` call (drafts and the editors' chats), in your home
  // folder. Dev and screenshot runs: the fake CLI answers instead.
  function runClaudeOnce(args, timeoutMs, opts) {
    if (d.FAKE_CLI) return runCli(process.env.SHELLBY_NODE || 'node', [d.FAKE_CLI, ...args], timeoutMs, { cwd: os.homedir(), ...opts });
    const exe = d.claudeExe();
    if (!exe) return Promise.resolve({ stdout: '', stderr: 'Claude Code isn\'t installed yet. Set it up in Settings first.', timedOut: false });
    return runCli(exe, args, timeoutMs, { cwd: os.homedir(), ...opts });
  }

  // The Automate page (workflows/service.js). Everything Shellby-specific a run
  // needs comes in through these few functions; the engine itself knows nothing
  // of Electron.
  function createWorkflows() {
    d.workflows = new WorkflowService({
      config: d.config, home: os.homedir(), manager: d.manager, maxTabs: MAX_TABS,
      dataDir: path.join(app.getPath('userData'), 'workflows'),
      isOff: () => !!d.config.get('crabOnly'),
      openTab: opts => d.openTab(opts),
      closeTab: tabId => { d.manager.close(tabId); d.workflows.onTabClosed(tabId); },
      currentCwd: d.currentCwd,
      claudeReady: () => !d.config.get('crabOnly') && !!d.claudeStatus?.installed && !!d.claudeStatus?.loggedIn,
      allowAutonomous: () => !!d.config.get('autonomousAcknowledged'),
      confirm: spec => { d.wake(); return confirm.ask(d.panel, { ...d.dialogLook(), ...spec }); },
      notify: (title, body, onClick, opts) => d.notify(title, body, onClick, opts),
      tellPhone: event => d.tellChannel(event),
      say: text => d.sayText(text, 'workflow'),
      showWorkflows: runId => {
        d.showPanel({ focusInput: false });
        if (runId) d.send(d.panel, 'workflows:open-run', runId); else d.send(d.panel, 'panel:view', 'workflows');
      },
      toPanel: (channel, payload) => d.send(d.panel, channel, payload),
      runCommand: (cwd, command, opts) => shellCmd.run(cwd, command, opts),
      runClaude: runClaudeOnce,
      makeCopy: d.makeIssueCopy,
      openPullRequest: d.openIssuePr,
      copy: text => clipboard.writeText(text),
      crypto: {
        available: () => safeStorage.isEncryptionAvailable(),
        encrypt: text => safeStorage.encryptString(text),
        decrypt: buf => safeStorage.decryptString(buf),
      },
      webhookPort: () => (d.external?.status === 'listening' ? d.external.port : null),
      liveMcp: () => d.toolbox?.current?.mcp || [],
      // Shellby's own profile: settings, run records, the approval key. Never a workflow's to write.
      forbiddenDirs: () => [app.getPath('userData')],
      log: { info: (...a) => d.log.info(...a), warn: (...a) => d.log.warn(...a) },
    });
    d.workflows.start();
    if (d.external) d.external.onFlow = body => (d.config.get('crabOnly') ? { ok: false, error: 'Workflows are off.', status: 403 } : d.workflows.webhook(body));
  }

  function registerWorkflowIpc(ipcMain) {
    const isId = v => typeof v === 'string' && v.length > 0 && v.length <= 80;
    const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
    const off = { ok: false, error: 'Workflows are off in just-the-crab mode.' };
    const ready = () => !!d.workflows && !d.config.get('crabOnly');
    ipcMain.handle('workflows:list', () => (d.workflows ? d.workflows.view() : null));
    ipcMain.handle('workflows:validate', (_e, def) => (d.workflows ? d.workflows.validate(def) : off));
    ipcMain.handle('workflows:save', (_e, def) => (ready() && isObj(def) ? d.workflows.save(def, { source: 'panel' }) : { ok: false, errors: [{ path: '', message: off.error }] }));
    ipcMain.handle('workflows:delete', (_e, id) => (d.workflows && isId(id) ? d.workflows.remove(id) : null));
    ipcMain.handle('workflows:run', (_e, id, inputs) => (ready() && isId(id) ? d.workflows.runManual(id, isObj(inputs) ? inputs : {}) : off));
    ipcMain.handle('workflows:draft', (_e, text) => (ready() ? d.workflows.draft(text) : off));
    ipcMain.handle('workflows:repair', (_e, runId) => (ready() && isId(runId) ? d.workflows.repair(runId) : off));
    ipcMain.handle('workflows:chat', (_e, req) => (ready() && isObj(req) ? d.workflows.chat({ workflow: isObj(req.workflow) ? req.workflow : {}, messages: req.messages, runId: isId(req.runId) ? req.runId : null }) : off));
    ipcMain.handle('workflows:import', (_e, text) => (d.workflows ? d.workflows.importText(text) : off));
    ipcMain.handle('workflows:export', (_e, id) => (d.workflows && isId(id) ? d.workflows.exportText(id) : off));
    ipcMain.handle('workflows:runs', (_e, id) => (d.workflows ? d.workflows.listRuns(isId(id) ? id : null) : []));
    ipcMain.handle('workflows:run-get', (_e, runId) => (d.workflows && isId(runId) ? d.workflows.getRun(runId) : null));
    ipcMain.handle('workflows:run-stop', (_e, runId) => (d.workflows && isId(runId) ? d.workflows.stopRun(runId) : off));
    ipcMain.handle('workflows:run-resume', (_e, runId) => (ready() && isId(runId) ? d.workflows.resumeRun(runId) : off));
    ipcMain.handle('workflows:run-answer', (_e, runId, key, choice) => (d.workflows && isId(runId) && typeof key === 'string' && typeof choice === 'string' ? d.workflows.answer(runId, key, choice) : off));
    ipcMain.handle('workflows:secret-set', (_e, name, value) => (d.workflows ? d.workflows.setSecret(name, value) : off));
    ipcMain.handle('workflows:secret-delete', (_e, name) => (d.workflows && typeof name === 'string' ? d.workflows.deleteSecret(name) : null));
    // The MCP servers a workflow step or a routine can pick, and one server's
    // tools (which starts it for a moment). Both editors use them.
    // Never a network share: reading one makes Windows sign in to that machine.
    const folderArg = v => (typeof v === 'string' && v.length <= 1024 && path.isAbsolute(v) && !/^[\\/]{2}/.test(v) ? v : null);
    ipcMain.handle('workflows:mcp-servers', (_e, cwd) => (ready() ? d.workflows.mcpServerList(folderArg(cwd)) : []));
    ipcMain.handle('workflows:mcp-tools', (_e, server, cwd) => (ready() && typeof server === 'string' && mcpServers.NAME.test(server) ? d.workflows.mcpTools(server, folderArg(cwd)) : off));
  }

  return {
    createDepWatch, createProjects, createWorkflows, registerWorkflowIpc, runClaudeOnce,
    dropUnsentCopy, serversOnQuit, showServer, startTaskInCopy,
  };
}

module.exports = { wireProjects };
