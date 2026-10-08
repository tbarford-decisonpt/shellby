// Keeping Claude Code itself current (claude-update.js): the daily look at the
// npm registry, and `claude update` when you ask or when you've said he may.
// Kept out of main.js, which only wires it up.
const { checkStatus, run } = require('../claude-cli');
const { ClaudeUpdates } = require('../claude-update');

/** @param d  what main shares with its wiring (main.js shared) */
function wireClaudeUpdates(d) {
  function createClaudeUpdates() {
    // Screenshots and the fake CLI have nothing real to update.
    if (d.CAPTURE || d.FAKE_CLI) return;
    d.claudeUpdates = new ClaudeUpdates({
      config: d.config,
      status: () => d.claudeStatus,
      busy: () => d.manager?.aggregate?.busy || 0,
      isOff: () => !!d.config.get('crabOnly'),
      run,
      // After `claude update`, look at the version again and tell the panel,
      // the same way a sign-in or sign-out does.
      recheck: async () => {
        d.claudeStatus = await checkStatus({ configured: d.claudePath() });
        d.refreshStatusLine();
        d.send(d.panel, 'claude:status', d.claudeStatus);
        d.noteClaudeVersion?.(); // new tricks, now it's updated
        return d.claudeStatus;
      },
      notify: (title, body) => d.notify(title, body, showClaudeSetting),
      toPanel: (channel, payload) => d.send(d.panel, channel, payload),
      log: d.log,
    });
    d.claudeUpdates.start();
  }

  /** Settings → About, beside Shellby's own update: where the notification points. */
  function showClaudeSetting() {
    d.showPanel({ focusInput: false });
    d.send(d.panel, 'panel:view', 'settings');
    d.send(d.panel, 'panel:jump', 'About');
  }

  const claudeUpdateView = () => (d.claudeUpdates ? d.claudeUpdates.view() : null);

  return { claudeUpdateView, createClaudeUpdates };
}

module.exports = { wireClaudeUpdates };
