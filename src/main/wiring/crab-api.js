// Driving the crab from outside: the API the Claude Code plugin and the
// `shellby` command talk to, and installing that command (clipath.js).
// Kept out of main.js, which only wires it up.
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run: runCli } = require('../claude-cli');
const clipath = require('../clipath');
const { MODES } = require('../config');
const crabtools = require('../crabtools');
const focus = require('../focus');
const snippets = require('../snippets');
const system32 = require('../system32');

/** d: what main shares (main.js `shared`). */
function wireCrabApi(d) {
  // ---- driving the crab

  // The MCP server (claude-plugin/mcp/server.js) and the `shellby` command post
  // here through the hooks port. Everything they ask for is checked again on this
  // side: that port is reachable by anything running on this PC.
  function createCrabApi() {
    d.external.onCrab = body => applyCrabIntent(body);
    d.external.onCli = (body, { token }) => runCliRequest(body, token);
  }

  /**
   * Put a line in his bubble that didn't come from voice.js (an MCP `say`, a
   * track that just started). Held back while he guards your focus, exactly like
   * one of his own remarks.
   */
  function sayText(text, occasion, ms = 9000) {
    if (d.CAPTURE || !d.config || !d.critter) return false;
    if (focus.guarding(d.config.get('focus'), Date.now()) || d.life?.hushed()) return false;
    d.said = { text: String(text).slice(0, 120), occasion, until: Date.now() + ms };
    d.chirp(occasion);
    d.refreshCritter();
    setTimeout(d.refreshCritter, ms + 50);
    return true;
  }

  function applyCrabIntent(body) {
    const checked = crabtools.parseRequest(body);
    if (!checked.ok) return { ok: false, error: checked.error, status: 400 };
    const intent = checked.intent;

    if (intent.action === 'status') return { text: crabtools.statusReply(crabStatusView()) };

    if (intent.action === 'list_routines' || intent.action === 'add_routine') {
      if (d.config.get('crabOnly')) return { ok: false, error: 'Routines are off: Shellby is in just-the-crab mode.', status: 403 };
      if (intent.action === 'list_routines') return { text: crabtools.routinesReply(d.routinesView()) };
      return d.routineService.proposeRoutine(intent.routine, { modelGiven: intent.modelGiven });
    }

    if (['list_workflows', 'run_workflow', 'add_workflow'].includes(intent.action)) {
      if (d.config.get('crabOnly') || !d.workflows) return { ok: false, error: 'Workflows are off: Shellby is in just-the-crab mode.', status: 403 };
      if (intent.action === 'list_workflows') return { text: crabtools.workflowsReply(d.workflows.claudeList()) };
      if (intent.action === 'run_workflow') return d.workflows.runFromClaude(intent.name, intent.inputs, 'claude');
      d.wake();
      return d.workflows.proposeFromClaude(intent.workflow);
    }

    // Next up for the project Claude is working in (wiring/backlog.js). Reading
    // it needs no Claude; adding writes only .shellby/tasks.md in a clone Shellby knows.
    if (intent.action === 'next_up' || intent.action === 'add_task') return backlogRequest(intent.action, intent);

    if (intent.action === 'wear') {
      const items = d.wardrobe.view().accessories.map(a => ({ id: a.key, name: a.name, slot: a.slot, owned: !a.locked }));
      const match = crabtools.matchItem(intent.item, items);
      if (match.item) {
        const r = d.wardrobe.setOutfit({ [match.item.slot]: match.item.id });
        if (!r.ok) return { ok: false, error: r.error, status: 400 };
      }
      return { text: crabtools.wearReply(match, intent.item) };
    }

    // say and celebrate both put something in his bubble. They go through the
    // same gate his own remarks do, so "guard my focus" still means quiet.
    d.wake();
    if (intent.action === 'celebrate') {
      d.flashState('success');
      const fx = d.outfit().confetti;
      if (fx) d.send(d.critter, 'critter:burst', fx);
    }
    if (intent.text) sayText(intent.text, 'mcp');
    return { text: crabtools.ackReply(intent) };
  }

  /** Everything `status` reports, gathered from the parts that own it. */
  function crabStatusView() {
    const v = d.xpView();
    const own = d.manager?.aggregate || { state: 'idle', busy: 0 };
    const ext = d.external?.summary || { state: 'idle', busy: 0 };
    return {
      level: v.level, title: v.title, xp: v.xp,
      state: own.state === 'asking' || ext.state === 'asking' ? 'asking' : own.state === 'working' || ext.state === 'working' ? 'working' : 'idle',
      busy: own.busy + ext.busy,
      mood: d.healthMood,
      sample: d.health?.monitor?.latest || null,
      limit: d.usageService.limitWait(),
      focus: d.focusState(),
    };
  }

  // ---- the shellby command

  const cliTokenPath = () => clipath.tokenPath(app.getPath('userData'));
  // An isolated dev/test run keeps its copy of the command inside its own profile:
  // e2e-integrations installs and removes it, and must not delete the real one.
  const cliBinDir = () => clipath.binDir(d.ISOLATED ? app.getPath('userData')
    : process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'));

  function cliSettings() {
    const raw = d.config.get('cli');
    return { installed: !!(raw && raw.installed) };
  }

  /** The token the command authenticates with, made on first install. */
  function readCliToken() {
    try { return fs.readFileSync(cliTokenPath(), 'utf8').trim() || null; } catch { return null; }
  }

  /**
   * A `shellby do` from a terminal. The token keeps out web pages and other
   * accounts; it does not pretend to keep out the user's own programs, which is
   * why the task still shows up as a task they can see and stop.
   */
  function runCliRequest(body, token) {
    if (!cliSettings().installed) return { ok: false, error: 'The shellby command is turned off.', status: 403 };
    const expected = readCliToken();
    if (!expected || !clipath.tokenMatches(expected, token)) return { ok: false, error: 'Wrong token.', status: 401 };

    if (body?.action === 'status') return { text: crabtools.statusReply(crabStatusView()) };
    if (body?.action === 'snippets') return { text: snippets.cliText(d.allSnippets()) };
    // Your hours are yours: behind the token, unlike status.
    if (body?.action === 'time') {
      const range = ['today', 'week', 'last-week', 'month', 'last-month'].includes(body.range) ? body.range : 'week';
      if (!d.timeTracker) return { ok: false, error: 'Shellby is still starting up. Try again in a moment.', status: 503 };
      return d.timeTracker.cliText(range, { estimates: body.estimates === true }).then(text => ({ text }));
    }
    // `shellby next` / `shellby task add|done`: Next up for the project the terminal is in (wiring/backlog.js).
    if (['next', 'task-add', 'task-done'].includes(body?.action)) return backlogRequest(body.action, body.args);
    // `shellby take`: the Claude Code session in that terminal opens as a tab (wiring/handoff.js).
    if (body?.action === 'take') return d.handoff.take(body);
    if (body?.action === 'flow-list' || body?.action === 'flow-run') {
      if (d.config.get('crabOnly') || !d.workflows) return { ok: false, error: 'Workflows are off: Shellby is in just-the-crab mode.', status: 403 };
      const flow = clipath.parseFlowRequest(body);
      if (!flow.ok) return { ok: false, error: flow.error, status: 400 };
      if (flow.request.action === 'flow-list') return { text: crabtools.workflowsReply(d.workflows.claudeList()) };
      return d.workflows.runFromClaude(flow.request.name, flow.request.inputs, 'terminal');
    }
    const checked = clipath.parseTaskRequest(body, { modes: MODES.filter(m => m !== 'autonomous'), isDir: d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } } });
    if (!checked.ok) return { ok: false, error: checked.error, status: 400 };

    const { cwd, mode, snippet } = checked.task;
    let { prompt } = checked.task;
    if (snippet) {
      const x = d.expandSnippet(snippet, prompt, { sigil: '@', max: 4000, cwd: cwd || undefined });
      if (!x) return { ok: false, error: snippets.unknownText(snippet, d.allSnippets(cwd || undefined)), status: 404 };
      if (!x.ok) return { ok: false, error: x.error, status: 400 };
      prompt = x.prompt;
    }
    const r = d.startTask(prompt, snippet ? `@${snippet} from the terminal` : 'From the terminal', { mode, cwd });
    if (!r.ok) return { ok: false, error: r.error || 'Shellby could not start that.', status: 400 };
    if (snippet) d.noteSnippetUse(snippet);
    d.showPanel({ focusInput: false, tabId: r.tabId });
    d.wake();
    return { text: 'Shellby is on it.' };
  }

  /**
   * Next up from a terminal or Claude Code: the list, a task added, a task
   * ticked off, for the project `cwd` is in. -> { text } | { ok: false, error, status }
   */
  async function backlogRequest(action, raw) {
    const checked = crabtools.parseBacklogArgs(action, raw);
    if (!checked.ok) return { ok: false, error: checked.error, status: 400 };
    const { cwd, title, n } = checked.args;
    const r = action === 'next' || action === 'next_up' ? await d.backlogText(cwd)
      : action === 'task-done' ? await d.backlogDoneFromCwd(cwd, n)
        // From Claude (MCP), it says so on the list: a task you didn't write shouldn't pass for yours.
        : await d.backlogAddFromCwd(cwd, action === 'add_task' ? `${title} (added by Claude)` : title);
    return r.ok ? { text: r.text } : { ok: false, error: r.error, status: r.stale ? 409 : 400 };
  }

  /** Write the command, its shims and its token, and put the folder on PATH. */
  async function installCli() {
    const dir = cliBinDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(path.join(__dirname, '..', '..', 'cli', 'shellby.js'), path.join(dir, 'shellby.js'));
      fs.writeFileSync(path.join(dir, 'cli-version.json'), JSON.stringify({ version: app.getVersion() }));
      fs.writeFileSync(path.join(dir, 'shellby.cmd'), clipath.cmdShim());
      fs.writeFileSync(path.join(dir, 'shellby'), clipath.shShim());
      fs.writeFileSync(path.join(dir, 'shellby.ps1'), clipath.ps1Shim());
      if (!readCliToken()) fs.writeFileSync(cliTokenPath(), clipath.newToken(), { mode: 0o600 });
      const onPath = await addToUserPath(dir);
      d.config.set({ cli: { installed: true } });
      return { ok: true, dir, onPath };
    } catch (e) {
      return { ok: false, error: `Couldn't set it up: ${e.message}` };
    }
  }

  async function removeCli() {
    const dir = cliBinDir();
    try {
      await removeFromUserPath(dir);
      for (const f of ['shellby.js', 'shellby.cmd', 'shellby', 'shellby.ps1', 'cli-version.json']) {
        fs.rmSync(path.join(dir, f), { force: true });
      }
      fs.rmSync(cliTokenPath(), { force: true });   // a fresh install gets a fresh token
      d.config.set({ cli: { installed: false } });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // HKCU only: no admin rights, and the machine PATH is never touched.
  function userPath() {
    return new Promise(resolve => {
      runCli(system32.REG, ['query', 'HKCU\\Environment', '/v', 'Path'], 5000).then(r => {
        const m = r.ok && /\sPath\s+REG_(?:EXPAND_)?SZ\s+(.*)/i.exec(r.stdout || '');
        resolve(m ? m[1].trim() : '');
      }).catch(() => resolve(''));
    });
  }

  async function setUserPath(value) {
    // setx truncates past 1024 characters, so the value goes in through reg.
    const r = await runCli(system32.REG, ['add', 'HKCU\\Environment', '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', value, '/f'], 8000);
    // Tell Explorer, so a new terminal from the Start menu sees it. Best effort:
    // the PATH is already written, and signing out would pick it up regardless.
    if (r.ok) await runCli(system32.POWERSHELL, clipath.settingChangeArgs(), 15000);
    return !!r.ok;
  }

  async function addToUserPath(dir) {
    // A dev or test run has its own profile; it must not edit the PATH the real
    // installed Shellby (and the person using this PC) depends on.
    if (process.platform !== 'win32' || d.ISOLATED) return false;
    const current = await userPath();
    if (clipath.isOnPath(current, dir)) return true;
    return setUserPath(clipath.pathWith(current, dir));
  }

  async function removeFromUserPath(dir) {
    if (process.platform !== 'win32' || d.ISOLATED) return false;
    const current = await userPath();
    if (!clipath.isOnPath(current, dir)) return true;
    return setUserPath(clipath.pathWithout(current, dir));
  }

  function cliView() {
    // The command reaches him over the sessions port; with that off it can't.
    return { ...cliSettings(), dir: cliBinDir(), available: process.platform === 'win32', listening: !!d.config.get('externalSessions') };
  }

  return { cliBinDir, cliView, createCrabApi, installCli, removeCli, sayText };
}

module.exports = { wireCrabApi };
