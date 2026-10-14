'use strict';
// Claude Code's background sessions (bg-sessions.js): listed every couple of
// minutes from `claude agents --json --all`, and right away when the panel
// asks. One that comes to need you raises his claw (a toast, your phone if you
// ticked "He needs permission"); one that finishes says so the same way.
// Open, Logs, Stop, Respawn and Remove are Claude Code's own subcommands.
const { run: runCli } = require('../claude/cli');
const bg = require('../bg-sessions');
const confirm = require('../confirm');

const POLL_MS = 2 * 60 * 1000;
const LIST_MS = 20000;
const ACT_MS = 30000;
const LOG_CHARS = 20000;

/**
 * d: what main shares, read when used: config, CAPTURE, claudeExe, claudeStatus,
 * panel, send, sayText, notify, tellChannel, showPanel, dialogLook, handoff, log
 */
function wireBgSessions(d) {
  const ask = spec => confirm.ask(d.panel, { ...d.dialogLook(), ...spec });
  let list = null;        // the last listing (null until the first)
  let listing = null;     // the listing in flight, shared by everyone who asks meanwhile

  const usable = () => !d.CAPTURE && !d.config.get('crabOnly') && !!d.claudeStatus?.installed && !!d.claudeExe?.();
  // The fake CLI (tests) is a script node runs, as wiring/sessions.js starts it.
  const cli = (args, ms) => {
    if (d.FAKE_CLI) return runCli(process.env.SHELLBY_NODE || 'node', [d.FAKE_CLI, ...args], ms);
    const exe = d.claudeExe?.();
    return exe ? runCli(exe, args, ms) : Promise.resolve({ ok: false, stdout: '', stderr: 'Claude Code is not installed.' });
  };

  function refresh() {
    if (!usable()) return Promise.resolve(list || []);
    if (listing) return listing;
    listing = cli(['agents', '--json', '--all'], LIST_MS).then(r => {
      const next = r.ok ? bg.parseAgents(r.stdout) : (list || []);
      for (const n of bg.newsBetween(list, next)) tell(n);
      list = next;
      d.send(d.panel, 'bg-sessions', view());
      return next;
    }).catch(err => { d.log.info(`bg sessions: ${err.message}`); return list || []; })
      .finally(() => { listing = null; });
    return listing;
  }

  function tell({ kind, session: s }) {
    const needs = kind === 'needs';
    const what = needs ? (s.state === 'review' ? 'is ready for review' : `needs you${s.needs ? `: ${s.needs}` : ''}`) : s.state === 'failed' ? 'failed' : 'finished';
    d.sayText?.(`Background: ${s.name.slice(0, 50)} ${what}.`, needs ? 'bg-needs' : 'bg-done');
    if (!(d.panel?.isVisible() && d.panel?.isFocused())) {
      d.notify?.(`In the background: ${s.name.slice(0, 60)}`, `It ${what}. Click to see it.`, () => { d.showPanel({ focusInput: false }); d.send(d.panel, 'panel:jump', 'Everywhere'); }, { urgent: needs });
    }
    d.tellChannel?.(needs
      ? { kind: 'asking', project: s.name, message: `A background session ${what}` }
      : { kind: 'done', project: s.name });
  }

  const view = () => ({ sessions: (list || []).map(s => ({ ...s, label: bg.stateLabel(s.state), running: bg.isRunning(s) })), available: usable() });

  // Only a session the last listing had: the panel never names one itself.
  const known = id => (typeof id === 'string' && bg.ID.test(id) ? (list || []).find(s => s.id === id) || null : null);

  async function logs(id) {
    const s = known(id);
    if (!s) return { ok: false, error: 'That session has gone.' };
    const r = await cli(['logs', s.id], ACT_MS);
    return r.ok ? { ok: true, name: s.name, text: r.stdout.slice(-LOG_CHARS) } : { ok: false, error: (r.stderr || 'claude logs failed').trim().slice(0, 300) };
  }

  async function act(id, verb) {
    const s = known(id);
    if (!s) return { ok: false, error: 'That session has gone.' };
    if (verb === 'rm') {
      const yes = await ask({
        icon: '🧹', danger: true,
        title: `Remove ${s.name.slice(0, 60)}?`,
        message: 'Claude Code deletes this background session, and its worktree if it has one and nothing in it is unsaved.',
        note: "Unpushed work keeps the worktree: Claude Code says so, and nothing is thrown away.",
        buttons: [{ label: 'Remove it', style: 'danger' }, { label: 'Keep it' }], defaultId: 1, cancelId: 1,
      });
      if (yes !== 0) return { ok: false, cancelled: true };
    }
    const r = await cli([verb, s.id], ACT_MS);
    await refresh();
    const said = `${r.stdout}\n${r.stderr}`.trim();
    return r.ok ? { ok: true, said: said.slice(0, 300) } : { ok: false, error: (said || `claude ${verb} failed`).slice(0, 400) };
  }

  // Open here: a running one is stopped first (its conversation is kept), so
  // two copies never write to it at once.
  async function open(id) {
    const s = known(id);
    if (!s) return { ok: false, error: 'That session has gone.' };
    if (!s.sessionId) return { ok: false, error: "Claude Code didn't say which conversation that is." };
    if (bg.isRunning(s)) {
      const yes = await ask({
        icon: '🦀', title: `Open ${s.name.slice(0, 60)} in Shellby?`,
        message: s.state === 'working' ? 'It is still working. Shellby stops it in the background first, then carries the conversation on here.' : 'Shellby stops it in the background first, then carries the conversation on here.',
        buttons: [{ label: 'Open it here' }, { label: 'Not now' }], defaultId: 0, cancelId: 1,
      });
      if (yes !== 0) return { ok: false, cancelled: true };
      const stopped = await cli(['stop', s.id], ACT_MS);
      if (!stopped.ok) return { ok: false, error: `It wouldn't stop: ${(stopped.stderr || stopped.stdout).trim().slice(0, 200)}` };
    }
    const r = d.handoff.openBackground({ sessionId: s.sessionId, cwd: s.cwd, name: s.name });
    refresh();
    return r;
  }

  function start(every) {
    setTimeout(refresh, 20 * 1000); // once boot has settled
    every(refresh, POLL_MS);
  }

  return { bgSessions: { start, refresh, view, logs, open, stop: id => act(id, 'stop'), respawn: id => act(id, 'respawn'), remove: id => act(id, 'rm') } };
}

module.exports = { wireBgSessions };
