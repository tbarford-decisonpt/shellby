// The world around him: Claude Code sessions elsewhere, PC health, telling you
// when you're away (channels.js), the stream overlay (obs.js), the Stream Deck
// keys (deck.js), desk lighting (rgb.js), your Discord profile (discord.js),
// music, typing, the weather, the shellby command and the crab card.
// Kept out of main.js, which only wires it up.
const { app, clipboard, ClipboardItem, nativeImage, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const channels = require('../channels');
const { OpenRgbClient } = require('../rgb');

/**
 * @param {Pick<import('electron').IpcMain, 'handle' | 'on'>} ipcMain  main's, behind ipc-guard.js
 * @param d  what main shares with its IPC (main.js ipcDeps)
 */
function registerSurroundingsIpc(ipcMain, d) {
  // ---- Claude Code sessions elsewhere
  ipcMain.on('clipboard:text', (_e, text) => { if (d.isStr(text) && text.length <= 2000) clipboard.writeText(text).catch(e => d.log.warn("couldn't copy text", e?.message)); });
  ipcMain.handle('external:get', () => d.externalView());
  ipcMain.handle('external:set', (_e, enabled) => {
    d.config.set({ externalSessions: !!enabled });
    if (enabled) d.external.start(); else d.external.stop();
    return d.externalView();
  });

  // ---- health
  ipcMain.handle('health:get', () => d.health.view());
  ipcMain.handle('health:set', (_e, patch) => d.health.setSettings(patch && typeof patch === 'object' ? patch : {}));
  ipcMain.handle('health:recheck', () => d.health.recheck());
  ipcMain.handle('health:ask', (_e, checkId) => (d.isStr(checkId) ? d.health.ask(checkId) : { ok: false, error: 'Unknown reading.' }));
  ipcMain.handle('health:hogs', (_e, metric) => d.health.hogs(d.isStr(metric) ? metric : null));
  ipcMain.handle('health:end-task', (_e, pid) => d.health.endTask(Number.isInteger(pid) ? pid : null));
  ipcMain.handle('health:end-group', (_e, name) => d.health.endGroup(d.isStr(name) ? name : null));
  ipcMain.handle('health:ask-processes', () => d.health.askProcesses());
  ipcMain.handle('health:startup', (_e, force) => d.health.startupItems({ force: force === true }));
  ipcMain.handle('health:ask-startup', () => d.health.askStartup());
  ipcMain.handle('health:set-startup', (_e, id, off) => d.health.setStartup(d.isStr(id) ? id : null, off === true));
  ipcMain.handle('health:clear-log', () => { d.config.set({ healthLog: [] }); return d.health.view(); });
  ipcMain.on('health:viewed', () => d.stat('health-viewed'));

  // ---- telling you when you're away (channels.js)
  ipcMain.handle('channels:get', () => d.channelsView());
  ipcMain.handle('channels:set', async (_e, patch) => {
    const next = channels.normalizeChannelSettings(d.channelSettings(), patch && typeof patch === 'object' ? patch : {});
    // ntfy needs nothing but a topic, so Shellby picks one nobody will guess
    // instead of asking you to invent it.
    // A topic Shellby made up himself, with no answering back, needs no
    // question: nobody but him could have chosen it.
    if (next.enabled && next.provider === 'ntfy' && !next.target) {
      next.target = channels.randomTopic();
      if (!next.replies) d.config.set({ channelsConfirmed: d.channelPlace(next) });
    }
    d.config.set({ channels: next });
    await d.confirmChannelPlace();
    d.refreshPhoneTasks(); // somewhere else now: the phone's yes to start tasks doesn't carry over
    return d.channelsView();
  });
  ipcMain.handle('channels:findChat', async () => {
    if (d.channelSettings().provider !== 'telegram') return { ...d.channelsView(), found: { error: 'That only works for Telegram.' } };
    const found = await channels.findTelegramChat(d.channelSecret);
    if (found.chatId) {
      d.config.set({ channels: channels.normalizeChannelSettings(d.channelSettings(), { target: found.chatId }) });
      await d.confirmChannelPlace();
      d.refreshPhoneTasks();
    }
    return { ...d.channelsView(), found };
  });
  ipcMain.handle('channels:secret', async (_e, secret) => {
    d.saveChannelSecret(typeof secret === 'string' ? secret.trim().slice(0, 400) : '');
    await d.confirmChannelPlace();
    d.refreshPhoneTasks();
    return d.channelsView();
  });

  // ---- starting a task from your phone (phone-tasks.js): turning it on asks
  // in the confirmation window, and the folder only comes from the picker.
  ipcMain.handle('phoneTasks:get', () => d.phoneTasksView());
  ipcMain.handle('phoneTasks:set', (_e, patch) => d.setPhoneTasks({
    ...(patch?.enabled === true || patch?.enabled === false ? { enabled: patch.enabled } : {}),
    ...(patch?.newPassphrase === true ? { newPassphrase: true } : {}),
  }));
  ipcMain.handle('phoneTasks:pickFolder', () => d.pickPhoneTasksFolder());
  ipcMain.handle('channels:test', async () => {
    const built = channels.buildRequest(d.channelSettings(), d.channelSecret,
      { kind: 'done', project: 'Shellby', tools: 0, seconds: 0, at: Date.now() });
    if (built.error) return { ok: false, error: built.error };
    // Even a test only goes somewhere you've said yes to.
    if (!(await d.confirmChannelPlace({ testing: true }))) return { ok: false, error: 'Not sent: that destination isn\'t confirmed.' };
    const r = await channels.deliver(built.request);
    // A test that gets through clears the last error in Settings.
    if (r.ok) d.noteDelivery?.(r, d.channelSettings(), d.channelPlace());
    return r;
  });

  // ---- the browser source (obs.js)
  ipcMain.handle('obs:get', () => d.obsView());
  ipcMain.handle('obs:set', (_e, patch) => {
    const prev = d.obsSettings();
    const next = { ...prev };
    if (patch && 'enabled' in patch) next.enabled = !!patch.enabled;
    if (patch && 'port' in patch) {
      const n = Number(patch.port);
      if (Number.isInteger(n) && n >= 1024 && n <= 65535) next.port = n;
    }
    d.config.set({ obs: next });
    if (d.obsServer && (next.port !== prev.port || !next.enabled)) d.obsServer.stop();
    if (next.enabled) { d.obsServer.port = next.port; d.obsServer.start(); }
    return d.obsView();
  });

  // ---- the Stream Deck keys (deck.js)
  ipcMain.handle('deck:get', () => d.deckView());
  ipcMain.handle('deck:set', (_e, patch) => d.setDeck(patch && typeof patch === 'object' ? patch : {}));
  ipcMain.handle('deck:add', () => d.addToStreamDeck());

  // ---- the desk lighting (rgb.js)
  ipcMain.handle('rgb:get', () => d.rgbView());
  ipcMain.handle('rgb:set', (_e, patch) => {
    const prev = d.rgbSettings();
    const next = { ...prev };
    if (patch && 'enabled' in patch) next.enabled = !!patch.enabled;
    if (patch && 'port' in patch) {
      const n = Number(patch.port);
      if (Number.isInteger(n) && n >= 1 && n <= 65535) next.port = n;
    }
    d.config.set({ rgb: next });
    const old = d.rgbClient;
    d.rgbClient = new OpenRgbClient({ port: next.port });
    d.lastRgbColor = '';
    // Switching off hands the user's lighting back, through the port it was painted on.
    if (prev.enabled && !next.enabled) return d.restoreLights(old || d.rgbClient).then(r => ({ ...d.rgbView(), ...(r.ok ? {} : { error: `Couldn't put your lighting back: ${r.error}` }) }));
    // Only switching it on starts OpenRGB; any other change just repaints.
    if (next.enabled && !prev.enabled) return d.ensureOpenRgb().then(r => ({ ...d.rgbView(), ...r }));
    if (next.enabled) d.paintLights();
    return d.rgbView();
  });
  ipcMain.handle('rgb:test', async () => ({ ...d.rgbView(), ...(await d.ensureOpenRgb()) }));
  ipcMain.handle('rgb:install', () => d.confirmAndInstallOpenRgb());

  // ---- on your Discord profile (discord.js)
  ipcMain.handle('discord:get', () => d.presenceView());
  ipcMain.handle('discord:set', (_e, patch) => {
    const prev = d.presenceSettings();
    const next = { ...prev };
    for (const k of ['enabled', 'task']) if (patch && typeof patch === 'object' && k in patch) next[k] = patch[k] === true;
    d.config.set({ discord: next });
    if (next.enabled && !prev.enabled) d.presence.start();
    else if (!next.enabled && prev.enabled) d.presence.stop();
    d.updatePresence();
    return d.presenceView();
  });

  // ---- listening along (media.js)
  ipcMain.handle('nowplaying:get', () => d.mediaView());
  ipcMain.handle('nowplaying:set', (_e, patch) => {
    const next = { ...d.mediaSettings() };
    for (const k of ['enabled', 'headphones', 'remarks']) if (patch && k in patch) next[k] = !!patch[k];
    d.config.set({ nowPlaying: next });
    if (next.enabled && d.media.status === 'off') d.media.start();
    if (!next.enabled && d.media.status !== 'off') { d.media.stop(); d.nowPlaying = null; }
    d.broadcastSkin();
    return d.mediaView();
  });

  // ---- typing along (typing.js)
  ipcMain.handle('typing:get', () => d.typing.view());
  ipcMain.handle('typing:set', (_e, patch) => {
    const next = d.typingSettings();
    for (const k of ['enabled', 'remarks']) if (patch && typeof patch === 'object' && k in patch) next[k] = !!patch[k];
    d.config.set({ typing: next });
    d.typing.sync();
    return d.typing.view();
  });

  // ---- the weather outside (weather/service.js)
  ipcMain.handle('weather:get', () => d.weatherView());
  ipcMain.handle('weather:set', (_e, patch) => {
    const p = patch && typeof patch === 'object' ? patch : {};
    d.weatherSvc.set({
      ...('enabled' in p ? { enabled: !!p.enabled } : {}),
      ...('remarks' in p ? { remarks: !!p.remarks } : {}),
      ...('place' in p ? { place: p.place } : {}), // checked by weather.normalizePlace
    });
    // A town south of the equator moves the seasons; switching off takes the sou'wester off.
    d.wardrobe?.collectSeasonals();
    d.broadcastWardrobe();
    return d.weatherView();
  });
  ipcMain.handle('weather:search', (_e, query) => d.weatherSvc.search(typeof query === 'string' ? query : ''));
  ipcMain.handle('weather:check', async () => { await d.weatherSvc.check(); return d.weatherView(); });

  // ---- the shellby command (clipath.js)
  ipcMain.handle('cli:get', () => d.cliView());
  ipcMain.handle('cli:install', async () => ({ ...(await d.installCli()), ...d.cliView() }));
  ipcMain.handle('cli:remove', async () => ({ ...(await d.removeCli()), ...d.cliView() }));
  ipcMain.on('cli:reveal', () => { try { shell.openPath(d.cliBinDir()); } catch { /* nothing to show */ } });


  // ---- shareable crab card: the renderer draws it; main checks it's a PNG,
  // picks the path itself, saves it and puts it on the clipboard.
  /** @type {string | null} */
  let lastCard = null;
  // What a card may be called after: anything else is just a card. Moments are moment-card.js's.
  const CARD_KINDS = new Set(['week', 'beach', 'shiny', 'medal', 'board', 'egg']);
  // Isolated dev/test runs keep cards in their throwaway profile and never touch the clipboard.
  const isolated = !app.isPackaged && !!process.env.SHELLBY_USER_DATA;
  const cardImage = bytes => {
    const buf = Buffer.from(bytes instanceof Uint8Array ? bytes : []);
    const isPng = buf.length > 8 && buf.length <= d.CARD_MAX_BYTES && buf.subarray(0, 8).equals(d.PNG_SIGNATURE);
    const img = isPng ? nativeImage.createFromBuffer(buf) : null;
    return img && !img.isEmpty() ? { buf, img } : null;
  };
  // Electron 44's clipboard is the W3C one: no writeImage, a ClipboardItem of PNG bytes instead.
  const copyCard = async buf => {
    if (isolated) return true;
    try {
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([buf], { type: 'image/png' }) })]);
      return true;
    } catch (e) { d.log.warn("couldn't copy a crab card", e?.message); return false; }
  };
  ipcMain.handle('card:save', async (_e, bytes, kind) => {
    const card = cardImage(bytes);
    if (!card) return { ok: false, error: "That card didn't come out right." };
    try {
      const dir = path.join(isolated ? app.getPath('userData') : app.getPath('pictures'), 'Shellby');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      lastCard = path.join(dir, `shellby-${CARD_KINDS.has(kind) ? kind : 'card'}-${stamp}.png`);
      fs.writeFileSync(lastCard, card.buf);
    } catch (e) {
      d.log.warn("couldn't save a crab card", e?.message);
      return { ok: false, error: "Couldn't save the card to Pictures." };
    }
    d.stat('card-shared');
    // The file is the save; the clipboard is a bonus. Another app holding the
    // clipboard (clipboard history, a screenshot tool) mustn't turn a saved
    // card into a "couldn't save" — the sheet's Copy button can try again.
    const copied = await copyCard(card.buf);
    return { ok: true, copied, name: path.join('Pictures', 'Shellby', path.basename(lastCard)) };
  });
  ipcMain.handle('card:copy', async (_e, bytes) => {
    const card = cardImage(bytes);
    return { ok: !!card && await copyCard(card.buf) };
  });
  ipcMain.on('card:reveal', () => { if (lastCard && fs.existsSync(lastCard)) shell.showItemInFolder(lastCard); });

  // ---- misc
  ipcMain.on('open-external', (_e, url) => {
    try { if (new URL(url).protocol === 'https:') shell.openExternal(url); } catch { /* ignore bad urls */ }
  });
  ipcMain.on('open-data-folder', () => shell.openPath(app.getPath('userData')));
}

module.exports = { registerSurroundingsIpc };
