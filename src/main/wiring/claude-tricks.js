// New tricks (claude-tricks.js): when the Claude Code Shellby finds is newer
// than the one he saw last, read its changelog and tell you what it can do now.
// The first version he ever sees is only remembered, never announced.
const tricks = require('../claude-tricks');

/** @param d  what main shares with its wiring (main.js shared); fetchImpl is for tests */
function wireClaudeTricks(d, { fetchImpl } = {}) {
  let reading = null;
  // Dev and e2e runs may point at a changelog of their own (and only then may
  // the fake CLI's version be announced: nothing real changed).
  const devUrl = () => d.changelogUrl?.() || null;
  const off = () => d.CAPTURE || (d.FAKE_CLI && !devUrl());

  const state = () => tricks.normalizeState(d.config.get('claudeTricksState'));
  const save = patch => d.config.set({ claudeTricksState: { ...state(), ...patch } });

  /** The card waiting to be seen, for the panel's first paint. */
  const claudeTricksPending = () => (off() ? null : state().pending);

  function dismissClaudeTricks() {
    if (state().pending) save({ pending: null });
  }

  function announce(dg) {
    d.send(d.panel, 'claude:tricks', dg);
    d.speak('newTricks');
    if (!(d.panel?.isVisible() && d.panel.isFocused())) {
      const n = dg.added || dg.highlights.length;
      d.notify(`Claude Code ${dg.to} can do ${n} new ${n === 1 ? 'thing' : 'things'}`, dg.highlights[0].text.replace(/`/g, '').slice(0, 160),
        () => { d.showPanel({ focusInput: false }); d.send(d.panel, 'panel:view', 'chat'); d.send(d.panel, 'claude:tricks', state().pending); },
        { tone: 'celebrate' });
    }
  }

  /** Look at the version Shellby last found. Resolves when any reading is done; never throws. */
  function noteClaudeVersion() {
    if (off() || reading) return reading || Promise.resolve();
    const now = tricks.version(d.claudeStatus?.version);
    const s = state();
    if (!now) return Promise.resolve();
    if (!s.lastSeen || tricks.compare(now, s.lastSeen) <= 0) {
      if (now !== s.lastSeen) save({ lastSeen: now });
      return Promise.resolve();
    }
    // Turned off (or Claude isn't in use at all): keep up quietly, so turning
    // it back on doesn't bring up a pile of old news.
    if (d.config.get('claudeTricks') === false || d.config.get('crabOnly')) {
      save({ lastSeen: now, pending: null });
      return Promise.resolve();
    }
    reading = tricks.fetchChangelog({ url: devUrl() || tricks.CHANGELOG_URL, fetchImpl })
      .then(text => {
        const dg = tricks.digest(tricks.parseChangelog(text), s.lastSeen, now);
        save({ lastSeen: now, pending: dg });
        if (dg) announce(dg);
      })
      // Offline or the changelog moved: try again the next time the version is looked at.
      .catch(err => d.log?.warn?.("Couldn't read Claude Code's changelog", err?.message || String(err)))
      .finally(() => { reading = null; });
    return reading;
  }

  return { claudeTricksPending, dismissClaudeTricks, noteClaudeVersion };
}

module.exports = { wireClaudeTricks };
