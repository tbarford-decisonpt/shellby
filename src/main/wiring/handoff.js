// Moving a conversation between Shellby and a terminal, both ways (handoff.js
// decides; this does): Continue in terminal, Pick it up here, Bring it into
// Shellby, and `shellby take` from inside a terminal session.
// Kept out of main.js, which only wires it up.
const fs = require('fs');
const { spawn } = require('child_process');
const handoff = require('../handoff');
const worktrees = require('../worktrees');
const { terminalEnv, billingScrub } = require('../claude/cli');
const { POWERSHELL, CMD, windowsTerminal } = require('../system32');

const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** d: what main shares (main.js `shared`). */
function wireHandoff(d) {
  const claudeExe = () => d.claudeExe();

  // Claude Code looks for a conversation under the folder it's resumed in. One
  // written somewhere else (a copy brought home since, a tab that moved) is
  // copied there first, the way branching does.
  function placeTranscript(sessionId, cwd) {
    const configDir = d.claudeConfigDir();
    const file = worktrees.findSession({ configDir, sessionId, prefer: [cwd] });
    if (!file) return "Claude Code has no record of this conversation on this PC, so there's nothing to pick up.";
    if (!worktrees.copySession({ configDir, file, to: cwd })) return "Claude Code's record of this conversation couldn't be put where the terminal will look for it.";
    return null;
  }

  async function openTerminal({ cwd, sessionId }) {
    const exe = claudeExe();
    if (!exe) return { ok: false, error: 'Claude Code is not installed.' };
    const misplaced = placeTranscript(sessionId, cwd);
    if (misplaced) return { ok: false, error: misplaced };
    const r = handoff.launchPlans({
      exe, cwd, sessionId, scrub: billingScrub(), env: terminalEnv(),
      wt: windowsTerminal(), powershell: POWERSHELL, cmd: CMD,
    });
    return r.ok ? handoff.launch(r.plans, spawn) : r;
  }

  // A note in the conversation itself: in an open tab it's shown and kept, in a
  // closed one it's only kept, and shown when it's next opened.
  function note(id, item) {
    if (d.manager.tabs.has(id)) d.manager.note(id, item);
    else d.history.append(id, item);
  }

  /** From the tab menu, the palette or a History row. id: a tab or History id. */
  async function continueInTerminal(id) {
    const tab = d.manager.tabs.get(id);
    const entry = d.history.get(id);
    if (!tab && !entry) return { ok: false, error: 'That conversation is closed.' };
    const s = tab?.session;
    const sessionId = s?.sessionId || entry?.claudeSessionId || null;
    const check = handoff.continueCheck({
      busy: !!s?.busy, pending: s?.pending.size || 0, crew: s?.runningCrew().length || 0,
      sessionId, resumeAt: s ? s.resumeAt : entry?.resumeAt,
    });
    if (!check.ok) return check;
    // A conversation on another computer carries on in a terminal over there.
    const place = d.remoteService?.placeOf(s?.cwd || entry?.cwd);
    if (place) {
      if (s) await s.stop();
      const r = await d.remoteService.resumeInTerminal(place, sessionId);
      if (!r.ok) return r;
      const at = Date.now();
      if (tab) d.manager.setInTerminal(id, at);
      else d.history.update(id, { inTerminal: at });
      note(id, { kind: 'handoff', to: 'terminal', shell: r.shell });
      d.log.info(`handoff: to ${r.shell} on another computer`);
      return { ok: true, shell: r.shell, text: `Carrying on in a terminal on ${place.host}.` };
    }
    const cwd = handoff.terminalCwd({ cwd: s?.cwd || entry?.cwd, worktree: tab?.worktree || entry?.worktree }, isDir);
    if (!cwd) return { ok: false, error: "That conversation's folder isn't there any more." };
    // Ended cleanly first: it's idle, so this is a moment, not an interruption.
    if (s) await s.stop();
    const r = await openTerminal({ cwd, sessionId });
    if (!r.ok) return r;
    const at = Date.now();
    if (tab) d.manager.setInTerminal(id, at);
    else d.history.update(id, { inTerminal: at });
    note(id, { kind: 'handoff', to: 'terminal', shell: r.shell });
    d.log.info(`handoff: to ${r.shell}`);
    return { ok: true, shell: r.shell, text: `Carrying on in ${handoff.SHELL_NAMES[r.shell] || 'a terminal'}.` };
  }

  /** Back from the terminal: sending from this tab is allowed again. */
  function pickUp(tabId) {
    const tab = d.manager.tabs.get(tabId);
    if (!tab) return { ok: false, error: 'That conversation is closed.' };
    if (!tab.inTerminal) return { ok: true };
    d.manager.setInTerminal(tabId, null);
    note(tabId, { kind: 'handoff', to: 'shellby' });
    const live = handoff.isSessionId(tab.session.sessionId) && d.external?.known(tab.session.sessionId);
    return live?.live
      ? { ok: true, warning: `It still looks open in ${live.client || 'the terminal'}. Type /exit there before you send anything here.` }
      : { ok: true };
  }

  /**
   * Open an outside session as a tab: the conversation it came from if Shellby
   * already has it (one you sent to a terminal), otherwise a new one.
   */
  function openHere(session) {
    if (d.config.get('crabOnly') || !d.claudeStatus?.installed || !d.claudeStatus?.loggedIn) return { ok: false, error: 'That needs Claude Code: set it up first.' };
    const from = session.client || 'the terminal';
    const known = handoff.entryFor(d.history.list(), session.id);
    if (known && d.manager.tabs.has(known.id)) {
      if (d.manager.tabs.get(known.id).inTerminal) {
        d.manager.setInTerminal(known.id, null);
        note(known.id, { kind: 'handoff', to: 'shellby', from });
      }
      d.showPanel({ focusInput: false, tabId: known.id });
      return { ok: true, tabId: known.id };
    }
    if (!isDir(session.cwd)) return { ok: false, error: "That session's folder isn't there any more." };
    const misplaced = placeTranscript(session.id, session.cwd);
    if (misplaced) return { ok: false, error: misplaced };
    try {
      let tabId;
      if (known) {
        tabId = known.id;
        d.history.update(tabId, { inTerminal: null });
      } else {
        tabId = d.randomUUID();
        d.history.create({ id: tabId, title: handoff.titleFor(session), cwd: session.cwd, mode: d.config.get('mode') });
        d.history.update(tabId, { claudeSessionId: session.id });
      }
      d.openTab({ tabId, historyEntry: d.history.get(tabId) });
      note(tabId, { kind: 'handoff', to: 'shellby', from });
      d.send(d.panel, 'tab:opened', { tabId, entry: d.history.get(tabId), items: d.history.load(tabId), background: false, busy: false });
      d.showPanel({ focusInput: false, tabId });
      d.log.info('handoff: brought in from outside');
      return { ok: true, tabId };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /** "Bring it into Shellby", on a session in Settings → Claude Code everywhere. */
  function bringIn({ id, force = false } = {}) {
    if (!handoff.isSessionId(id)) return { ok: false, error: "That session's id doesn't look like Claude Code's, so Shellby can't pick it up." };
    const session = d.external?.known(id) || null;
    const check = handoff.bringInCheck(session, { force: force === true });
    return check.ok ? openHere(session) : check;
  }

  /**
   * `shellby take` (and /shellby:handoff, which runs it): the session in that
   * terminal opens in Shellby. body: { action: 'take', args: { cwd, id? } },
   * already past the CLI token check.
   */
  function take(body) {
    const args = body?.args && typeof body.args === 'object' ? body.args : {};
    const cwd = typeof args.cwd === 'string' ? args.cwd : '';
    if (!handoff.safePath(cwd) || !isDir(cwd)) return { ok: false, error: 'That folder does not exist.', status: 400 };
    if (args.id != null && !handoff.isSessionId(args.id)) return { ok: false, error: "That isn't a Claude Code session id.", status: 400 };
    const session = handoff.externalFor(d.external?.summary.sessions || [], { id: args.id || null, cwd });
    if (!session) return { ok: false, error: "Shellby can't see a Claude Code session in this folder. Is the Shellby plugin installed, and Settings → Claude Code everywhere on?", status: 404 };
    const check = handoff.bringInCheck({ ...session, live: true }, { fromInside: true });
    if (!check.ok) return { ok: false, error: check.error, status: 400 };
    const r = openHere(session);
    if (!r.ok) return { ok: false, error: r.error, status: 400 };
    d.wake();
    return { text: `It's open in Shellby. ${check.warning}` };
  }

  /**
   * Claude Code's cloud review of a conversation's branch (/code-review ultra),
   * in a terminal of its own in that conversation's folder or copy. It runs
   * interactively on purpose: Claude Code's launch dialog says what it costs
   * and asks before anything starts, and the review is billed apart from your plan.
   */
  async function ultraReview(tabId) {
    const tab = d.manager.tabs.get(tabId);
    if (!tab) return { ok: false, error: 'That conversation is closed.' };
    const cwd = handoff.terminalCwd({ cwd: tab.session?.cwd, worktree: tab.worktree }, isDir);
    if (!cwd) return { ok: false, error: "That conversation's folder isn't there any more." };
    const exe = claudeExe();
    if (!exe) return { ok: false, error: 'Claude Code is not installed.' };
    const r = handoff.launchPlans({
      exe, cwd, prompt: handoff.TERMINAL_PROMPTS.ultraReview, scrub: billingScrub(), env: terminalEnv(),
      wt: windowsTerminal(), powershell: POWERSHELL, cmd: CMD,
    });
    const started = r.ok ? await handoff.launch(r.plans, spawn) : r;
    if (!started.ok) return started;
    return { ok: true, shell: started.shell, text: `Opened ${handoff.SHELL_NAMES[started.shell] || 'a terminal'} with /code-review ultra. Claude Code asks there before it starts.` };
  }

  // Claude Code's cloud sessions, in a terminal of their own (handoff.js
  // cloudArgs): teleport one here, start one on what you wrote, or pick up the
  // conversation behind a pull request. Claude Code asks and shows its own lists
  // there. tabId: the conversation whose folder it opens in, else Shellby's own.
  const CLOUD_SAYS = {
    teleport: 'with claude --teleport. Pick the cloud session there; Bring it into Shellby works once it runs.',
    cloud: 'with claude --cloud. Claude Code starts the cloud session there.',
    pr: 'with claude --from-pr. Pick the pull request there.',
  };
  async function openCloud({ kind, value = null, tabId = null } = {}) {
    const tab = tabId ? d.manager.tabs.get(tabId) : null;
    const cwd = handoff.terminalCwd({ cwd: tab?.session?.cwd || d.currentCwd(), worktree: tab?.worktree || null }, isDir);
    if (!cwd) return { ok: false, error: "That conversation's folder isn't there any more." };
    const flag = { teleport: '--teleport', cloud: '--cloud', pr: '--from-pr' }[kind];
    if (flag && !d.claudeSupports(flag)) return { ok: false, error: `This Claude Code doesn't have ${flag} yet. Update it, then try again.` };
    const exe = claudeExe();
    if (!exe) return { ok: false, error: 'Claude Code is not installed.' };
    const r = handoff.launchPlans({
      exe, cwd, cloud: { kind, value }, scrub: billingScrub(), env: terminalEnv(),
      wt: windowsTerminal(), powershell: POWERSHELL, cmd: CMD,
    });
    const started = r.ok ? await handoff.launch(r.plans, spawn) : r;
    if (!started.ok) return started;
    return { ok: true, shell: started.shell, text: `Opened ${handoff.SHELL_NAMES[started.shell] || 'a terminal'} ${CLOUD_SAYS[kind]}` };
  }

  return { continueInTerminal, pickUp, bringIn, take, ultraReview, openCloud };
}

module.exports = { wireHandoff };
