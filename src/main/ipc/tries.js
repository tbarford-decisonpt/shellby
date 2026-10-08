// Try it N ways' IPC (wiring/tries.js). tries:start is the only way in, and
// it always asks in the isolated confirmation window before anything runs:
// the panel can ask for tries, never approve them.
// Kept out of main.js, which only wires it up.
const tries = require('../tries');

/**
 * @param {Pick<import('electron').IpcMain, 'handle' | 'on'>} ipcMain  main's, behind ipc-guard.js
 * @param d  what main shares with its IPC (main.js ipcDeps)
 */
function registerTriesIpc(ipcMain, d) {
  const isId = v => typeof v === 'string' && v.length > 0 && v.length <= 80;
  ipcMain.handle('tries:start', (_e, req) => {
    if (!req || typeof req !== 'object') return { ok: false, error: 'Nothing to try.' };
    const raw = typeof req.arg === 'string' ? req.arg : typeof req.text === 'string' ? req.text : '';
    if (raw.length > tries.MAX_TEXT) return { ok: false, error: "That's too long to try several ways at once." };
    // What was typed after /tries: "3 fix the login".
    const parsed = typeof req.arg === 'string' ? tries.parseArg(req.arg) : { n: req.n, text: raw };
    if (parsed.error) return { ok: false, error: parsed.error };
    return d.tries.start({
      tabId: isId(req.tabId) ? req.tabId : null,
      n: Number.isInteger(parsed.n) ? parsed.n : NaN,
      text: parsed.text,
      // Paths, which every try gets (wiring/tries.js, try-files.js). Past the cap, problem() says so.
      attachments: Array.isArray(req.attachments) ? req.attachments.slice(0, 50).filter(f => typeof f === 'string') : [],
    });
  });
  ipcMain.handle('tries:stop', (_e, runId) => d.tries.stop(isId(runId) ? runId : null));
  ipcMain.handle('tries:status', (_e, runId) => d.tries.status(isId(runId) ? runId : null));
}

module.exports = { registerTriesIpc };
