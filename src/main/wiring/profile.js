// Your profile, opened first at boot: the settings (config.js) and the
// conversations' history (history.js), each tidied as it opens.
// Kept out of main.js, which only wires it up.
const { app } = require('electron');
const path = require('path');
const attach = require('../attachments');
const { setPlanOnly } = require('../claude/cli');
const { Config } = require('../config');
const { History } = require('../history');
const rooms = require('../rooms');

const PURGE_EVERY_MS = 24 * 60 * 60 * 1000;

/** d: what main shares (main.js `shared`). Sets d.config and d.history. */
function wireProfile(d) {
  function openProfile() {
    const { log } = d;
    const userData = app.getPath('userData');
    const config = d.config = new Config(userData);
    if (config.recoveredFrom) log.error('settings.json could not be read; started from defaults', `the old copy is at ${config.recoveredFrom}`);
    if (config.unreadable) log.error('settings.json is locked; running on defaults and not saving this session', config.unreadable);
    // Rooms are decided once: everything for someone who was already here, one
    // door at a time for someone new (rooms.js).
    if (config.get('rooms') == null) config.set({ rooms: rooms.initialRooms(!!config.get('onboarded')) });
    setPlanOnly(config.get('planOnly')); // before anything launches Claude Code
    const history = d.history = new History(path.join(userData, 'sessions'), { onError: (what, err) => log.error(`history: ${what}`, err) });
    // Transcripts orphaned by an older build (which trimmed the index without
    // deleting them) or by an interrupted delete. Cheap, and it only ever removes
    // files nothing lists; see History.sweep().
    const swept = history.sweep();
    if (swept) log.info(`cleared ${swept} orphaned transcript${swept > 1 ? 's' : ''}`);
    // Turns the last run started and never finished (the PC died, or he was quit
    // mid-task): marked cut off before any tab opens, and told to the panel once.
    const cut = history.takeCutOff({ crashed: !!d.lastRun?.unclean });
    if (cut.length) {
      log.warn(`${cut.length} conversation${cut.length > 1 ? 's were' : ' was'} cut off mid-turn`, d.lastRun?.unclean ? 'the last run ended without quitting' : 'quit while working');
      d.cutOff = cut.map(e => ({ id: e.id, title: e.title, crashed: !!d.lastRun?.unclean }));
    }
    // Recently deleted empties itself: at boot, and daily for a PC that never restarts.
    const purgeBin = () => {
      const n = history.purgeExpired();
      if (n) log.info(`purged ${n} expired deleted conversation${n > 1 ? 's' : ''}`);
    };
    purgeBin();
    setInterval(purgeBin, PURGE_EVERY_MS).unref?.();
    attach.prune(path.join(userData, 'screenshots'));
  }

  return { openProfile };
}

module.exports = { wireProfile };
