// Before/after pictures of a dev server either side of a turn (shots.js).
// Kept out of main.js, which only wires it up.
//
// Best effort all the way: a picture never holds a turn up, a capture that
// fails just means no pair, and one capture runs at a time.
const path = require('path');
const { app, BrowserWindow, session } = require('electron');
const shots = require('../shots');

/** d: what main shares (main.js `shared`). */
function wireShots(d) {
  const dir = () => path.join(app.getPath('userData'), 'turn-shots');
  const pending = new Map(); // tabId -> { turnId, url, root, before: Promise<id|null> }
  let queue = Promise.resolve();

  const shotsOn = () => !d.CAPTURE && !!d.config && d.config.get('turnShots') !== false && !d.config.get('crabOnly');

  // One hidden window at a time, however many tabs finish together.
  function captureQueued(url) {
    const next = queue.then(() => shots.capture(url, { electron: { BrowserWindow, session } }));
    queue = next.catch(() => null);
    return next.catch(() => null);
  }

  async function take(tabId, turnId, which, url) {
    const png = await captureQueued(url);
    if (!png) return null;
    const id = shots.shotId(turnId, which);
    if (!shots.save(dir(), tabId, id, png)) return null;
    shots.prune(dir(), tabId);
    return id;
  }

  /**
   * A turn is starting (sessions.js beginTurn). Not awaited: the picture is
   * taken alongside, never in the way. A conversation in its own copy is
   * skipped: the dev server serves your checkout, not the copy.
   */
  function beforeTurn(tab) {
    pending.delete(tab.id);
    if (!shotsOn() || tab.worktree || !shots.validTab(tab.id) || !/^[0-9a-f-]{8,64}$/.test(tab.turnId || '')) return;
    const cwd = tab.session?.cwd;
    const server = d.devServers && shots.pickServer(d.devServers.view().servers, cwd);
    if (!server) return;
    const before = take(tab.id, tab.turnId, 'before', server.url).catch(() => null);
    pending.set(tab.id, { turnId: tab.turnId, url: server.url, before });
  }

  /** A turn's diff has been noted (sessions.js noteTurnChanges): the after picture, if it touched the UI. */
  async function afterTurn(tabId, summary) {
    const p = pending.get(tabId);
    pending.delete(tabId);
    if (!p) return;
    // Nothing that shows on the page: the before picture has no pair to be in.
    if (!summary || !shots.anyUi(summary.files)) { p.before.then(id => id && shots.remove(dir(), tabId, id)); return; }
    try {
      const before = await p.before;
      if (!before) return;
      await new Promise(r => setTimeout(r, shots.SETTLE_MS)); // hot reload catching up
      // The next turn has started: an "after" now could show its edits too.
      if (d.manager.isBusy(tabId)) { shots.remove(dir(), tabId, before); return; }
      const after = await take(tabId, p.turnId, 'after', p.url);
      if (!after || !d.manager.tabs.has(tabId)) return;
      d.manager.note(tabId, { kind: 'shots', after: summary.after, url: p.url, shots: { before, after } });
    } catch (err) {
      d.log.info(`shots: ${err.message}`);
    }
  }

  /**
   * A picture for the panel, as a data URL: only one a 'shots' item in that
   * tab's transcript names, read from Shellby's own folder.
   */
  function shotImage(tabId, id) {
    if (!shots.validTab(tabId) || !shots.validShot(id)) return null;
    const named = d.history.load(tabId).some(i => i.kind === 'shots' && (i.shots?.before === id || i.shots?.after === id));
    return named ? shots.read(dir(), tabId, id) : null;
  }

  return { shotsBeforeTurn: beforeTurn, shotsAfterTurn: afterTurn, shotImage };
}

module.exports = { wireShots };
