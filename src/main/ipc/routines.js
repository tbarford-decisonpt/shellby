// Routines and the things that run on their own: the routine editor and its
// test runs, the weekly dependency watch (depwatch.js), and the usage forecast
// with the work held for after a reset (forecast.js, held.js).
// Kept out of main.js, which only wires it up.
const confirm = require('../confirm');
const crabtools = require('../crabtools');
const depwatch = require('../depwatch');
const held = require('../held');
const routineTemplates = require('../routine-templates');
const { validateRoutine } = require('../routines');

/**
 * @param {Pick<import('electron').IpcMain, 'handle' | 'on'>} ipcMain  main's, behind ipc-guard.js
 * @param d  what main shares with its IPC (main.js ipcDeps)
 */
function registerRoutinesIpc(ipcMain, d) {
  // ---- routines
  ipcMain.handle('usage:breakdown', () => d.usageBreakdown());
  // What the message being typed usually costs (usage-ledger.js). Only its category
  // is worked out from the text; nothing of it is kept.
  ipcMain.handle('usage:estimate', (_e, req) => {
    const text = typeof req?.text === 'string' ? req.text.slice(0, 50000) : '';
    if (!text.trim() || d.config.get('crabOnly')) return null;
    return d.usagePlan.estimateFor(d.isStr(req.tabId) ? req.tabId : null, text);
  });
  ipcMain.handle('routines:list', () => d.routinesView());
  ipcMain.handle('routines:templates', () => routineTemplates.TEMPLATES);
  ipcMain.handle('routines:save', async (_e, input) => {
    const existing = d.routines().find(r => r.id === input?.id);
    const { routine, errors } = validateRoutine({ ...existing, ...input }, { allowAutonomous: !!d.config.get('autonomousAcknowledged') });
    if (!routine) return { ok: false, errors };
    // A routine runs unattended. One that may act without a prompt for every
    // step (Smart, Auto-edit, Autonomous, or MCP servers it may use unasked)
    // is confirmed in the isolated window whenever what it does, where, how
    // freely, or on which model changes.
    const unattended = !['ask', 'plan'].includes(routine.mode) || !!routine.mcp?.length;
    const servers = r => JSON.stringify([r?.mcp || [], !!r?.mcpOnly]);
    const changed = !existing || ['mode', 'prompt', 'cwd'].some(k => existing[k] !== routine[k]) || servers(existing) !== servers(routine) || (existing.model || '') !== routine.model;
    if (unattended && changed) {
      const response = await confirm.ask(d.panel, {
        ...d.dialogLook(), icon: '⟳', danger: routine.mode === 'autonomous',
        ...crabtools.routineQuestion(routine, { replacing: existing || null, defaultFolder: d.currentCwd(), own: true }),
        buttons: [{ label: existing ? 'Save changes' : 'Add routine', style: routine.mode === 'autonomous' ? 'danger' : 'primary' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
      });
      if (response !== 0) return { ok: false, cancelled: true, errors: ['Not saved.'] };
    }
    const list = existing ? d.routines().map(r => (r.id === routine.id ? routine : r)) : [...d.routines(), routine];
    if (list.length > 50) return { ok: false, errors: ['That is a lot of routines. Delete some first (limit 50).'] };
    d.saveRoutines(list);
    return { ok: true, routine, routines: d.routinesView() };
  });
  ipcMain.handle('routines:draft', (_e, text) => d.draftRoutine(text));
  // Build it with Claude (the routine editor's chat) and its test runs. A test
  // is the saved routine run by hand; stopping or reading one only works on a
  // tab that is one of those tests.
  const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  ipcMain.handle('routines:chat', (_e, req) => (isObj(req)
    ? d.chatRoutine({ routine: isObj(req.routine) ? req.routine : {}, messages: req.messages, runId: d.isStr(req.runId) ? req.runId : null })
    : { ok: false, error: 'Nothing to send.' }));
  ipcMain.handle('routines:repair', (_e, id) => (d.isStr(id) ? d.repairRoutine(id) : { ok: false, error: 'That routine is gone.' }));
  ipcMain.handle('routines:test', (_e, id) => (d.isStr(id) ? d.testRoutine(id) : { ok: false, error: 'Save it first.' }));
  ipcMain.handle('routines:test-status', (_e, tabId) => (d.isStr(tabId) && d.routineTests.has(tabId) ? d.routineTestView(tabId) : null));
  ipcMain.handle('routines:test-stop', (_e, tabId) => {
    if (!d.isStr(tabId) || !d.routineTests.has(tabId) || !d.manager.tabs.has(tabId)) return false;
    d.manager.interrupt(tabId);
    return true;
  });
  d.registerWorkflowIpc(ipcMain);
  ipcMain.handle('routines:delete', (_e, id) => {
    d.saveRoutines(d.routines().filter(r => r.id !== id));
    const list = d.heldList();
    if (list.some(h => h.kind === 'routine' && h.routineId === id)) d.saveHeld(list.filter(h => !(h.kind === 'routine' && h.routineId === id)));
    return d.routinesView();
  });
  ipcMain.handle('routines:run', (_e, id) => {
    const r = d.routines().find(x => x.id === id);
    return r ? d.runRoutine(r, { reason: 'manual' }) : { ok: false, error: 'Routine not found.' };
  });

  // ---- dependency watch (depwatch.js). Only a project from the last check is
  // accepted: the renderer names one, it never hands over a folder of its own.
  ipcMain.handle('depwatch:get', () => d.depWatch.view());
  ipcMain.handle('depwatch:set', (_e, on) => d.depWatch.setEnabled(on === true));
  ipcMain.handle('depwatch:scan', () => d.depWatch.scan());
  ipcMain.handle('depwatch:bump', async (_e, key) => {
    const r = d.depWatch.result(key);
    if (!r || !depwatch.needsAttention(r)) return { ok: false, error: 'Nothing to bump there. Check again first.' };
    if (!d.isFolder(r.key)) return { ok: false, error: "Shellby can't find that folder any more." };
    // The copy gets its own branch; the pull request is opened from it.
    const res = await d.startTaskInCopy(r.key, `Bump dependencies in ${r.name}`, w => depwatch.bumpPrompt(r, { branch: w.branch, base: w.base }));
    if (res.ok) d.showPanel({ focusInput: false, tabId: res.tabId });
    return res;
  });
  // A routine for the editor to fill in: saving it goes through routines:save
  // like any other, with its confirmation.
  ipcMain.handle('depwatch:routine', (_e, key) => {
    const r = d.depWatch.result(key);
    if (!r) return null;
    return {
      name: `Weekly package bump: ${r.name}`.slice(0, 60),
      prompt: depwatch.routinePrompt(r.name),
      cwd: r.key, mode: 'smart',
      schedule: { type: 'weekly', time: '10:00', days: [1] },
    };
  });

  // ---- usage forecast, and work held for after the reset
  ipcMain.handle('outlook:get', () => d.outlookView());
  ipcMain.handle('held:add', async (_e, input = {}) => {
    if (d.config.get('crabOnly')) return { ok: false, error: 'That needs Claude Code.' };
    if (input?.kind === 'task') return d.queueTask(input);
    if (input?.kind === 'routine') {
      const r = d.routines().find(x => x.id === input.routineId);
      return r ? d.holdForReset({ kind: 'routine', routineId: r.id, name: r.name }) : { ok: false, error: 'Routine not found.' };
    }
    if (input?.kind !== 'message') return { ok: false, error: "There's nothing to hold." };
    const tab = d.isStr(input.tabId) && d.manager.tabs.get(input.tabId);
    if (!tab) return { ok: false, error: 'That conversation is closed.' };
    const text = String(input.text || '').trim().slice(0, 50000);
    const files = (Array.isArray(input.attachments) ? input.attachments : []).filter(d.isStr).slice(0, 20);
    return d.holdForReset({ kind: 'message', tabId: tab.id, cwd: tab.session.cwd, title: tab.title, text, attachments: files });
  });
  // Answers with what was held, so a message can go back in the box to edit.
  ipcMain.handle('held:cancel', (_e, id) => {
    const list = d.heldList();
    const h = d.isStr(id) && list.find(x => x.id === id);
    if (!h) return { ok: false };
    d.saveHeld(held.without(list, id));
    // A queued task that's running now stops too; its conversation stays.
    if (h.kind === 'task' && h.tabId && d.queueWaits.has(h.tabId)) d.manager.interrupt(h.tabId);
    return { ok: true, item: h };
  });
  ipcMain.handle('held:keepAwake', (_e, on) => {
    d.config.set({ queueKeepAwake: on === true });
    d.syncKeepAwake();
    d.sendOutlook();
    return { ok: true, keepAwake: on === true };
  });
}

module.exports = { registerRoutinesIpc };
