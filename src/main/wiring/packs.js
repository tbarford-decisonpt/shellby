// Installing packs: shellby:// links, the registry, and the confirmation each
// install asks for first.
// Kept out of main.js, which only wires it up.
const fs = require('fs');
const os = require('os');
const path = require('path');
const confirm = require('../confirm');
const { fetchRegistryPack, parseDeepLink } = require('../registry');
const { KNOWN_ACHIEVEMENTS } = require('../wardrobe/achievements');
const { validatePack } = require('../wardrobe/catalog');
const { KNOWN_SEASONS } = require('../wardrobe/seasons');

/** d: what main shares (main.js `shared`). */
function wirePacks(d) {
  // ---- pack installs

  // Preview a pack's text, ask in a native dialog (which renderer code can't click
  // through), then install exactly the previewed bytes. Shared by "Install pack…",
  // drag and drop, and the community gallery. Never echoes JSON parse errors.
  // opts: { sourceLabel?: shown in the dialog, expectId?: the pack id we asked for }
  async function confirmAndInstallPackText(text, { sourceLabel = null, expectId = null } = {}) {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 512 * 1024) return { ok: false, errors: ['That pack is too big (max 512 KB).'] };
    let preview;
    try {
      preview = validatePack(JSON.parse(text.replace(/^﻿/, '')), { source: 'user', knownAchievements: KNOWN_ACHIEVEMENTS, knownSeasons: KNOWN_SEASONS });
    } catch {
      return { ok: false, errors: ["That file isn't valid JSON, so it isn't a Shellby pack."] };
    }
    if (!preview.pack) return { ok: false, errors: preview.errors };
    const p = preview.pack;
    if (expectId && p.id !== expectId) return { ok: false, errors: [`The downloaded pack's id (${p.id}) doesn't match the link (${expectId}), so it was not installed.`] };
    const SLOT_LABEL = { hat: 'Hat', face: 'Face', neck: 'Neck', held: 'Held', shell: 'Shell' };
    const response = await confirm.ask(d.panel, {
      ...d.dialogLook(), icon: '📦',
      title: 'Install wardrobe pack?',
      message: `"${p.name}" ${p.version} by ${p.author}${sourceLabel ? `, ${sourceLabel}` : ''}`,
      detail: p.description || '',
      items: [
        ...p.accessories.map(a => ({ kind: a.slot, label: SLOT_LABEL[a.slot] || a.slot, name: a.name, pixels: a.pixels, palette: { ...a.palette } })),
        ...p.effects.map(e => ({ kind: 'effect', label: 'Effect', name: e.name, sprites: e.sprites.map(sp => ({ pixels: sp.pixels, palette: { ...sp.palette } })) })),
        ...p.skins.map(k => ({ kind: 'skin', label: 'Colors', name: k.name, pixels: k.pixels, palette: { ...k.palette }, parts: { ...k.parts } })),
        ...p.voices.map(v => ({ kind: 'voice', label: v.lang ? `Voice · ${v.lang}` : 'Voice', name: v.name, glyph: '💬' })),
        ...p.scenes.map(sc => ({ kind: 'scene', label: 'Scene', name: sc.name, glyph: '🎬' })),
      ],
      note: "Packs are pixel art, lines and settings only. They can't run code.",
      buttons: [{ label: 'Install', style: 'primary' }, { label: 'Cancel' }], defaultId: 0, cancelId: 1,
    });
    if (response !== 0) return { ok: false, canceled: true };
    // Install from a private temp copy of the previewed text, so what was shown is
    // exactly what gets installed (installPack re-validates and picks the final name).
    let dir = null;
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-pack-'));
      const tmp = path.join(dir, 'pack.json');
      fs.writeFileSync(tmp, text);
      const r = d.wardrobe.install(tmp);
      return { ok: r.ok, errors: r.errors || [], warnings: r.warnings || [], pack: r.pack ? { id: r.pack.id, name: r.pack.name } : null };
    } catch {
      return { ok: false, errors: ["Couldn't save the pack. Try again."] };
    } finally {
      if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
    }
  }

  // A shellby:// link from the community gallery. Queued until boot has finished.
  // The link only ever supplies a pack id; everything else comes from the registry.
  function onDeepLink(link) {
    if (d.CAPTURE || !link) return;
    if (!d.booted) { d.pendingLink = link; return; }
    const parsed = parseDeepLink(link);
    if (!parsed) {
      d.showPanel({ focusInput: false });
      reportPackResult({ ok: false, error: "That Shellby link isn't one this version understands." });
      return;
    }
    // The panel must be loaded to switch views and hear the result.
    const go = parsed.action === 'hatch' ? () => hatchFromLink(parsed.code) : () => installFromRegistry(parsed.packId);
    if (d.panel.webContents.isLoading()) d.panel.webContents.once('did-finish-load', go);
    else go();
  }

  // A crab egg (eggs.js): the Us page, with the code in the hatch box. A link
  // never hatches by itself: hatching adds a friend and writes on their card
  // as you, so it waits for you to press Hatch it.
  function hatchFromLink(code) {
    d.startView = 'us';
    d.showPanel({ focusInput: false });
    d.send(d.panel, 'panel:view', 'us');
    d.send(d.panel, 'social:prefill', code);
  }

  async function installFromRegistry(packId) {
    d.startView = 'wardrobe'; // survives a panel that is still booting (its init would otherwise reset to chat)
    d.showPanel({ focusInput: false });
    d.send(d.panel, 'panel:view', 'wardrobe');
    if (d.linkBusy) return reportPackResult({ ok: false, error: 'Shellby is already installing a pack. Try again when it finishes.' });
    d.linkBusy = true;
    try {
      const got = await fetchRegistryPack(packId, { baseUrl: d.registryUrl() });
      if (!got.ok) return reportPackResult({ ok: false, error: got.errors[0] || 'Download failed.' });
      const have = d.wardrobe.catalog.packs.find(p => p.id === packId && p.source === 'user');
      if (have && got.entry.version && have.version === got.entry.version) {
        return reportPackResult({ ok: true, already: true, name: have.name, version: have.version });
      }
      const r = await confirmAndInstallPackText(got.text, { sourceLabel: 'from the Shellby community registry', expectId: packId });
      if (r.canceled) return reportPackResult({ ok: false, canceled: true });
      if (!r.ok) return reportPackResult({ ok: false, error: r.errors[0] || 'Install failed.' });
      return reportPackResult({ ok: true, name: r.pack.name, warnings: r.warnings.length });
    } catch (e) {
      console.warn('[shellby] registry install failed:', e.message);
      return reportPackResult({ ok: false, error: 'Something went wrong installing that pack.' });
    } finally {
      d.linkBusy = false;
    }
  }

  // Tell the panel (it toasts); if nobody is looking, a failure also gets a native box.
  function reportPackResult(result) {
    d.send(d.panel, 'wardrobe:installed', result);
    if (!result.ok && !result.canceled && !(d.panel?.isVisible() && d.panel.isFocused())) {
      confirm.ask(d.panel, { ...d.dialogLook(), icon: '😕', title: "Couldn't install that pack", message: result.error || 'Something went wrong.', buttons: [{ label: 'OK', style: 'primary' }], defaultId: 0, cancelId: 0 }).catch(() => {});
    }
    return result;
  }

  function setFolder(dir) {
    d.config.set({ cwd: dir });
    d.config.addRecentFolder(dir);
    d.toolbox?.rescan({ plugins: false });
    // Another repo, other team snippets; and a pack there you haven't seen gets a word.
    d.send(d.panel, 'snippets', d.snippetsView());
    d.teamIpc?.folderChanged(dir);
    return { cwd: dir, settings: d.panelSettings() };
  }

  return { confirmAndInstallPackText, installFromRegistry, onDeepLink, setFolder };
}

module.exports = { wirePacks };
