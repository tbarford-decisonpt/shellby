// What adds up over time: streaks and nudges, focus sessions, shell stickers
// and the beach, dependency checkups and the week in review, the flaky test
// detective and time on each project. Kept out of main.js, which only wires
// it up.
const { dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const confirm = require('../confirm');
const recap = require('../recap');
const { reviewPrompt } = require('../review');
const stickers = require('../stickers');
const streaks = require('../streaks');

/**
 * @param {Pick<import('electron').IpcMain, 'handle' | 'on'>} ipcMain  main's, behind ipc-guard.js
 * @param d  what main shares with its IPC (main.js ipcDeps)
 */
function registerProgressIpc(ipcMain, d) {
  // ---- streaks and nudges
  ipcMain.handle('streaks:get', () => d.streaksView());
  if (d.NUDGE_TEST) ipcMain.handle('dev:check-nudges', () => d.checkNudges());
  if (d.FORECAST_TEST) ipcMain.handle('dev:usage', (_e, r = {}) => {
    const item = { kind: 'usage', status: r.status === 'rejected' ? 'rejected' : 'allowed', fiveHour: { pct: Number(r.pct), resetsAt: Number(r.resetsAt) }, sevenDay: null };
    const event = recap.usageEvent('dev', 'Dev', item);
    if (event) d.recapLog = recap.record(d.recapLog, { ...event, t: Date.now() - (Number(r.minsAgo) || 0) * 60 * 1000 }, Date.now());
    d.config.set({ lastUsage: { ...item, at: Date.now() } });
    d.send(d.panel, 'usage', item);
    d.onUsage(item);
    d.refreshOutlook();
    return d.outlookView();
  });
  if (d.RECAP_TEST) ipcMain.handle('dev:away', (_e, r = {}) => d.checkAway({ idleMs: Number(r.idleMs) || 0, locked: !!r.locked }));
  ipcMain.handle('streaks:set', (_e, patch = {}) => {
    const s = streaks.normalize(d.config.get('streaks'));
    const next = { ...s };
    if ('nudges' in patch) next.nudges = !!patch.nudges;
    if ('afterDays' in patch) next.afterDays = patch.afterDays;
    d.saveStreaks(streaks.normalize(next));
    return d.streaksView();
  });
  ipcMain.handle('streaks:mute', (_e, { key, muted } = {}) => {
    if (d.isStr(key)) d.saveStreaks(streaks.setMuted(d.config.get('streaks'), key, muted));
    return d.streaksView();
  });
  ipcMain.on('streaks:open', (_e, key) => {
    const s = streaks.normalize(d.config.get('streaks'));
    const p = d.isStr(key) && s.projects[key];
    if (p) d.send(d.panel, 'tab:new-in', { cwd: key, draft: `Where did we leave off in ${p.name}? Summarize what changed recently, what's unfinished, and suggest the next step.` });
  });
  // "Look over my changes": a read-only security review of what's pending in one
  // project, in that project's own folder. Only a folder Shellby already tracks
  // is accepted, and the task runs in Ask-first mode whatever mode you're in, so
  // a review can't change anything without you.
  ipcMain.handle('review:start', (_e, key) => {
    const s = streaks.normalize(d.config.get('streaks'));
    const p = d.isStr(key) && s.projects[key];
    if (!p || !fs.existsSync(key)) return { ok: false, error: "Shellby can't find that folder any more." };
    const r = d.startTask(reviewPrompt(p.name), `Look over ${p.name}`, { mode: 'ask', cwd: key });
    if (r.ok) d.showPanel({ focusInput: false, tabId: r.tabId });
    return r;
  });

  // ---- focus sessions
  ipcMain.handle('focus:get', () => d.focusView());
  ipcMain.handle('focus:start', (_e, minutes) => d.startFocus(minutes));
  ipcMain.handle('focus:stop', () => d.stopFocus());

  // ---- shell stickers (stickers.js)
  const stickerId = id => (d.isStr(id) && /^[0-9a-f]{12}$/.test(id) ? id : null);
  const slotOf = n => (Number.isInteger(n) && n >= 0 && n < 64 ? n : null);
  ipcMain.handle('stickers:get', () => d.stickersView());
  // ---- the beach (beach.js): read-only, built from stickers, streaks and finds
  ipcMain.handle('beach:get', () => d.beachView());
  ipcMain.handle('beach:seen', () => d.beachSeen());
  ipcMain.handle('stickers:place', (_e, { id, slot, shell } = {}) => {
    if (!stickerId(id) || slotOf(slot) === null) return { ok: false, error: 'That sticker or spot is not there.', view: d.stickersView() };
    return d.editStickers(shell, (s, sh, _n, now) => stickers.place(s, sh, id, slot, now));
  });
  ipcMain.handle('stickers:remove', (_e, { id, shell } = {}) => (stickerId(id) ? d.editStickers(shell, (s, sh, _n, now) => stickers.remove(s, sh, id, now)) : { ok: false, view: d.stickersView() }));
  ipcMain.handle('stickers:restack', (_e, { id, dir, shell } = {}) => (stickerId(id) && (dir === 'up' || dir === 'down')
    ? d.editStickers(shell, (s, sh, _n, now) => stickers.restack(s, sh, id, dir, now)) : { ok: false, view: d.stickersView() }));
  ipcMain.handle('stickers:flip', (_e, { id, shell } = {}) => (stickerId(id) ? d.editStickers(shell, (s, sh, _n, now) => stickers.flip(s, sh, id, now)) : { ok: false, view: d.stickersView() }));
  ipcMain.handle('stickers:arrange', (_e, { shell } = {}) => d.editStickers(shell, (s, sh, n, now) => stickers.arrange(s, sh, n, now)));
  ipcMain.handle('stickers:hide', (_e, { id, hidden } = {}) => {
    if (stickerId(id)) d.config.set({ stickers: stickers.setHidden(d.config.get('stickers'), id, !!hidden, Date.now()) });
    return d.stickersView();
  });
  ipcMain.handle('stickers:options', (_e, opts) => {
    if (opts && typeof opts === 'object') d.config.set({ stickers: stickers.setOptions(d.config.get('stickers'), { auto: opts.auto, card: opts.card }) });
    return d.stickersView();
  });
  ipcMain.on('stickers:seen', (_e, ids) => {
    if (!Array.isArray(ids)) return;
    const s = d.stickerState();
    const next = stickers.markSeen(s, ids.filter(stickerId));
    if (next.unseen.length !== s.unseen.length) d.config.set({ stickers: next });
  });
  // "Pick up where we left off" in a project, from its page in the Sticker Book.
  ipcMain.on('stickers:open', (_e, id) => {
    const p = stickerId(id) && d.stickerState().projects[id];
    if (!p?.root || !fs.existsSync(p.root)) return;
    d.send(d.panel, 'tab:new-in', { cwd: p.root, draft: `Where did we leave off in ${p.name}? Summarize what changed since we last shipped it, what's unfinished, and suggest the next step.` });
  });
  // "Check its dependencies", from its page in the Sticker Book.
  ipcMain.handle('stickers:checkup', (_e, id) => {
    const p = stickerId(id) && d.stickerState().projects[id];
    return p?.root ? d.runCheckup(p.root) : { ok: false, error: "Shellby doesn't know where that project lives on this PC." };
  });

  // ---- dependency checkups and the week in review
  ipcMain.handle('checkups:get', () => d.checkupsView());
  // Only a folder already in the list: the renderer can't point this anywhere new.
  ipcMain.handle('checkups:run', (_e, key) => (d.isStr(key) && d.checkupsView().some(c => c.key === key) ? d.runCheckup(key) : { ok: false, error: 'Unknown project.' }));
  // ---- the flaky test detective. Only a test already on the list, by its project and name.
  ipcMain.handle('flaky:get', () => ({ on: d.config.get('flakyTests') !== false, list: d.flakyView() }));
  ipcMain.handle('flaky:act', (_e, o) => {
    const src = o && typeof o === 'object' ? o : {};
    if (!d.isStr(src.key) || !d.isStr(src.id) || src.id.length > 200 || !d.isStr(src.action)) return { ok: false, error: 'Unknown test.' };
    if (d.config.get('crabOnly')) return { ok: false, error: 'That needs Claude Code: Shellby is in just-the-crab mode.' };
    return d.flakyAct(src.key, src.id, src.action);
  });
  ipcMain.handle('flaky:forget', async () => {
    const response = await confirm.ask(d.panel, {
      ...d.dialogLook(), icon: '🎲',
      title: 'Forget flaky tests?',
      message: 'Forget every flaky test Shellby has noted?',
      detail: 'He starts watching from scratch. Tests you quarantined stay skipped in your code.',
      buttons: [{ label: 'Forget them' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
    });
    if (response !== 0) return { ok: false };
    d.config.set({ flaky: null });
    d.send(d.panel, 'flaky', d.flakyView());
    return { ok: true };
  });
  ipcMain.handle('week:get', () => d.weekView());

  // ---- time on each project (timetrack-service.js). Everything from the panel is checked here.
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const timeOpts = o => {
    const src = o && typeof o === 'object' ? o : {};
    const only = src.only && typeof src.only === 'object'
      ? (d.isStr(src.only.key) && src.only.key.length <= 400 ? { key: src.only.key } : typeof src.only.client === 'string' && src.only.client.length <= 60 ? { client: src.only.client } : null)
      : null;
    return {
      range: typeof src.range === 'string' ? src.range.slice(0, 20) : 'week',
      from: DAY.test(src.from) ? src.from : null, to: DAY.test(src.to) ? src.to : null,
      estimates: !!src.estimates, only,
    };
  };
  const timeKey = k => (d.isStr(k) && k.length <= 400 && path.isAbsolute(k) ? k : null); // a project is a folder
  ipcMain.handle('time:get', (_e, o) => d.timeTracker.view(timeOpts(o)));
  ipcMain.handle('time:settings', (_e, patch) => d.timeTracker.setSettings(patch && typeof patch === 'object' ? patch : {}));
  ipcMain.handle('time:project', (_e, key, patch) => d.timeTracker.setProject(timeKey(key), patch && typeof patch === 'object' ? patch : {}));
  ipcMain.handle('time:remove', (_e, key) => d.timeTracker.removeProject(timeKey(key)));
  ipcMain.handle('time:add', (_e, entry) => {
    const e = entry && typeof entry === 'object' ? entry : {};
    return d.timeTracker.addTime({ key: timeKey(e.key), day: DAY.test(e.day) ? e.day : null, minutes: Number(e.minutes) || 0, note: typeof e.note === 'string' ? e.note.slice(0, 400) : undefined });
  });
  ipcMain.handle('time:add-folder', async () => {
    const r = await dialog.showOpenDialog(d.panel, { title: 'Which project folder should Shellby keep time for?', defaultPath: d.currentCwd(), properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0] || !d.isFolder(r.filePaths[0])) return { ok: false, canceled: true };
    return d.timeTracker.addFolder(r.filePaths[0]);
  });
  ipcMain.handle('time:export-csv', (_e, o) => d.timeTracker.exportCsv(timeOpts(o)).catch(e => { d.log.error('time csv', e); return { ok: false, error: "Couldn't save that file." }; }));
  ipcMain.handle('time:export-pdf', (_e, o) => d.timeTracker.exportPdf(timeOpts(o)).catch(e => { d.log.error('time pdf', e); return { ok: false, error: "Couldn't make the timesheet." }; }));
  ipcMain.handle('time:copy', (_e, o) => d.timeTracker.copyText(timeOpts(o)));
  // Only a file this page just saved: it says where, and nothing else gets opened.
  ipcMain.handle('time:show-file', (_e, file) => {
    if (!d.isStr(file) || !d.timeTracker.wasSaved(file) || !fs.existsSync(file)) return false;
    shell.showItemInFolder(file);
    return true;
  });
}

module.exports = { registerProgressIpc };
