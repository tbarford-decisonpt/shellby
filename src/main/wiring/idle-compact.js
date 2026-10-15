// Idle compaction, run from the idle sweep (wiring/sessions.js): each quiet tab
// that idle-compact.js says is due gets Claude Code's own /compact, the same as
// its Compact button. Only with "Compact long conversations while they're idle"
// on in Settings, and only on this PC: a remote tab's settings are over there.
const os = require('os');
const idle = require('../idle-compact');
const setup = require('../claude/setup');

const MANAGED_SETTINGS = 'C:\\Program Files\\ClaudeCode\\managed-settings.json';

// Claude Code's settings for the folders a tab works in, lowest precedence
// first. A tab in its own copy reads the original checkout's too: the copy
// has no settings.local.json, which git ignores.
function settingsFor(cwds, home) {
  const files = [...new Set(cwds.filter(Boolean).flatMap(cwd => setup.settingsFiles({ home, cwd }).map(f => f.file))), MANAGED_SETTINGS];
  return idle.fromSettings(files.map(f => setup.readSettings(f).data));
}

/** d: what main shares; home: whose ~/.claude to read. -> the ids of the tabs it compacted. */
function compactIdleTabs(d, { now = Date.now(), home = os.homedir() } = {}) {
  if (d.CAPTURE || !d.config?.get('idleCompact') || d.config.get('crabOnly') || !d.claudeStatus?.loggedIn) return [];
  const done = [];
  for (const tab of d.manager.tabs.values()) {
    const s = tab.session;
    if (s.remoteHost) continue;
    const view = {
      saved: tab.saved, routine: !!(tab.routineId || tab.workflowRunId), inTerminal: tab.inTerminal,
      busy: s.busy, waiting: s.pending.size > 0 || s.runningCrew().length > 0,
      cache: s.cache, tokens: s.context?.tokens, lastFor: tab.idleCompactFor,
    };
    // The cheap checks first, with Claude Code's default floor as the lowest
    // it could be: settings files are only read for a tab that might be due.
    if (!idle.due(view, { now, floor: idle.FLOOR_MIN_TOKENS })) continue;
    const settings = settingsFor([tab.worktree?.originalCwd, s.cwd], home);
    if (settings.off || !idle.due(view, { now, floor: idle.minTokens(settings.env, process.env) })) continue;
    tab.idleCompactFor = s.cache.at;
    try {
      const turnId = d.manager.send(tab.id, '/compact', { kind: 'user', text: '/compact' });
      tab.idleCompacting = true;
      d.send(d.tabWindow?.(tab.id) || d.panel, 'tab:sent', { tabId: tab.id, item: { kind: 'user', text: '/compact', attachments: [], turnId } });
      done.push(tab.id);
    } catch (err) {
      d.log.warn('Idle compaction did not start', err.message);
    }
  }
  return done;
}

module.exports = { compactIdleTabs };
