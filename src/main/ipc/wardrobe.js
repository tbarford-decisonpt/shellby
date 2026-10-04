// The Wardrobe's IPC: outfits, voices, packs from a file or the gallery, and
// outfit codes (SHB-XXXX-XXXX). Kept out of main.js, which only wires it up.
const fs = require('fs');
const attach = require('../attachments');
const { fetchRegistryCatalog } = require('../registry');
const { itemHash } = require('../wardrobe/codes');

const isStr = s => typeof s === 'string' && s.length > 0 && s.length < 10000;
const PACK_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
const MAX_PACK_BYTES = 512 * 1024;
const MAX_CODE = 120;
const NOT_A_CODE = "That doesn't look like an outfit code.";

/**
 * d: {
 *   wardrobe()                       the Wardrobe (made at boot)
 *   builtinSkins()                   -> [{ id, name }] for outfit codes
 *   allSkins(), activeSkin()
 *   reloadSkins()                    -> allSkins(), after reading the skins folder again
 *   config, voice                    settings, and voice.js (for normalize)
 *   clearBackground()                -> externalView()
 *   pickPackFile()                   -> Promise<string | null>   the open dialog
 *   confirmAndInstallPackText(text)  -> Promise<{ ok, ... }>
 *   installFromRegistry(packId)
 *   registryUrl()
 *   broadcastSkin()
 *   openPath(p), userSkinsDir()
 * }
 */
function registerWardrobeIpc(ipcMain, d) {
  const W = () => d.wardrobe();
  const withView = r => ({ ...r, view: W().view() });

  ipcMain.handle('skins:reload', () => d.reloadSkins());

  ipcMain.handle('wardrobe:view', () => W().view());
  ipcMain.handle('external:clear-background', () => d.clearBackground());
  ipcMain.handle('wardrobe:set-outfit', (_e, patch) => withView(W().setOutfit(patch && typeof patch === 'object' ? patch : {})));
  ipcMain.handle('wardrobe:wear-season', () => withView(W().wearSeason()));
  ipcMain.handle('wardrobe:randomize', () => withView(W().randomize()));
  ipcMain.handle('wardrobe:set-voice', (_e, key) => {
    const r = W().setVoice(isStr(key) ? key : null);
    // His don't-repeat memory points into the old voice's lines: start it afresh.
    if (r.ok) d.config.set({ voice: { ...d.voice.normalize(d.config.get('voice')), recent: {} } });
    return withView(r);
  });
  ipcMain.handle('wardrobe:options', (_e, opts) => { W().setOptions(opts || {}); return W().view(); });
  ipcMain.on('wardrobe:seen', (_e, keys) => { if (Array.isArray(keys)) W().markSeen(keys.filter(isStr)); });
  ipcMain.handle('wardrobe:install', async (_e, filePath) => {
    const file = isStr(filePath) ? filePath : await d.pickPackFile();
    if (!file) return { ok: false, canceled: true };
    const text = readPack(file);
    if (text.errors) return { ok: false, errors: text.errors };
    return withView(await d.confirmAndInstallPackText(text.ok));
  });
  ipcMain.handle('wardrobe:remove-pack', (_e, packId) => { if (isStr(packId)) W().remove(packId); return W().view(); });

  // ---- outfit codes: a whole look as a pasteable string
  ipcMain.handle('wardrobe:code', () => ({ code: W().outfitCode(d.activeSkin()?.id) }));
  ipcMain.handle('wardrobe:code-preview', async (_e, text) => {
    if (!isStr(text) || text.length > MAX_CODE) return { ok: false, error: NOT_A_CODE };
    const p = W().previewCode(text, d.builtinSkins());
    if (!p.ok || !p.missing.length) return { ...p, packs: [] };
    // Items from community packs you don't have: find them in the gallery's catalog.
    const cat = await fetchRegistryCatalog({ baseUrl: d.registryUrl() });
    return { ...p, ...packsFor(p.missing, cat), catalogError: cat.ok ? null : cat.errors[0] };
  });
  ipcMain.handle('wardrobe:code-wear', (_e, text) => {
    if (!isStr(text) || text.length > MAX_CODE) return { ok: false, error: NOT_A_CODE };
    const r = W().wearCode(text, d.builtinSkins());
    if (!r.ok) return r;
    if (r.skin && r.skin !== d.config.get('skin')) {
      const sk = d.allSkins().find(x => x.id === r.skin);
      if (sk && !sk.locked) { d.config.set({ skin: r.skin }); d.broadcastSkin(); }
    }
    return withView(r);
  });
  // "Get the pack" from an outfit code: the same confirmed install as a gallery link.
  ipcMain.handle('wardrobe:install-registry', (_e, packId) => (isStr(packId) && PACK_ID.test(packId) ? d.installFromRegistry(packId) : { ok: false }));
  ipcMain.on('wardrobe:open-folder', () => { fs.mkdirSync(W().userDir, { recursive: true }); d.openPath(W().userDir); });
  ipcMain.on('skins:open-folder', () => d.openPath(d.userSkinsDir()));
}

/**
 * A pack file's text, or why not. Only .json files on this PC under the size
 * cap, and never echo parse errors: V8's messages quote file contents, which
 * would let a renderer peek at any file.
 *   -> { ok: text } | { errors: [string] }
 */
function readPack(file) {
  if (!/\.json$/i.test(file)) return { errors: ['Packs are .json files.'] };
  if (!attach.isLocalPath(file)) return { errors: ['Packs install from a file on this PC.'] };
  try {
    if (fs.statSync(file).size > MAX_PACK_BYTES) return { errors: ['That pack is too big (max 512 KB).'] };
    return { ok: fs.readFileSync(file, 'utf8') };
  } catch {
    return { errors: ['File not found.'] };
  }
}

/** An outfit code's missing items, grouped by the gallery pack that has them. */
function packsFor(missing, cat) {
  const packs = new Map();
  const unknown = [];
  for (const m of missing) {
    const hit = cat.ok && cat.items.find(it => it.slot === m.slot && itemHash(it.key) === m.hash);
    if (!hit) { unknown.push(m); continue; }
    const entry = packs.get(hit.packId) || { id: hit.packId, name: hit.packName, items: [] };
    packs.set(hit.packId, { ...entry, items: [...entry.items, { slot: m.slot, name: hit.name }] });
  }
  return { packs: [...packs.values()], unknown };
}

module.exports = { registerWardrobeIpc, readPack, packsFor };
