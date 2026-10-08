// Shell stickers (stickers.js): the first time a project ships, Shellby gets a
// sticker for it and slaps it on his shell; shipping it again makes the sticker
// better. The drawing is generated from the project (sticker-art.js), so only
// the counts and where each one sits are stored.
// Moved out of main.js.
const fs = require('fs');
const shells = require('./shells');
const stickerArt = require('./sticker-art');
const stickers = require('./stickers');
const streaks = require('./streaks');
const { projectOf, trackedFiles, stickerFile } = require('./gitinfo');
const { shellMask, stickerSlots, STICKER } = require('./sticker-slots');

const SLAP_MS = 3200;                 // the critter's slap, from holding it up to the squash
const TROPHY_AFTER_SLAP_MS = 900;     // a trophy it earns waits for the slap to land
const GLINT_MS = 120;
const FACTS_MS = 24 * 60 * 60 * 1000; // a project's language and own sticker, looked up at most daily
const MAX_DRAWINGS = 400;
const MAX_FACTS = 100;
const MERGE_LOOKUP_MAX = 50;          // known projects checked for a merged PR's clone

/**
 * d: what this needs from main, read when it's used.
 *   config, critter, panel, workflows: getters
 *   CAPTURE, log, send, notify, showPanel, flashState, sayText, broadcastSkin,
 *   currentLevel, activeSkin, githubEndpoints, noteWeek, stickersView, stickerStats
 */
function createStickers(d) {
  const drawings = new Map();     // look -> drawing (sticker-art.js)
  const projectFacts = new Map(); // repo root -> { lang, custom, at }

  const shellIdOf = shell => (shell ? shell.id : stickers.HOME);
  const wornShellObj = () => shells.wornShell(d.config?.get('home'), d.currentLevel());
  const stickerState = () => stickers.normalize(d.config.get('stickers'));

  function drawSticker(p) {
    const key = JSON.stringify([p.id, p.name, p.lang, p.custom]);
    let drawn = drawings.get(key);
    if (!drawn) {
      drawn = stickerArt.draw(p);
      drawings.set(key, drawn);
      if (drawings.size > MAX_DRAWINGS) drawings.delete(drawings.keys().next().value);
    }
    return drawn;
  }

  // Where stickers can go on a shell, for whichever skin he's wearing.
  const shellSpots = (skin, shell) => {
    const mask = shellMask(skin, shell);
    return { mask, slots: stickerSlots(mask) };
  };
  const covers = (mask, x, y) => {
    for (let dy = 0; dy < STICKER; dy++) for (let dx = 0; dx < STICKER; dx++) if (!mask[y + dy]?.[x + dx]) return false;
    return true;
  };

  /** The stickers on a shell, placed in sprite pixels and stacked, for sprite.js. */
  function shellStickers(skin, shell, state = stickerState()) {
    const layout = state.layouts[shellIdOf(shell)] || [];
    const now = Date.now();
    return placeStickers(skin, shell, layout.map(e => {
      const p = state.projects[e.id];
      const tier = stickers.tierFor(p.ships).id;
      const weather = stickers.weathering(p, now);
      return { id: p.id, tier, weather, slot: e.slot, z: e.z, flip: e.flip, nudge: e.nudge, ...stickerArt.onShell(drawSticker(p), { tier, weather, flip: e.flip }) };
    }));
  }

  // Stickers by spot number onto this skin's shell, in sprite pixels: the same
  // spot means the same place on any crab (a visiting friend's too).
  function placeStickers(skin, shell, list) {
    if (!list.length || !skin) return [];
    const { mask, slots } = shellSpots(skin, shell);
    if (!slots.length) return [];
    return list.map(e => {
      let [x, y] = slots[e.slot % slots.length];
      // Shifted a pixel so the one underneath peeks out, unless that would hang off the shell.
      if (covers(mask, x + e.nudge[0], y + e.nudge[1])) { x += e.nudge[0]; y += e.nudge[1]; }
      return { ...e, x, y };
    });
  }

  // What the repo itself says about its sticker: its main language, and its own
  // drawing if it ships one (.shellby/sticker.json, validated in stickers.js).
  async function factsOf(root) {
    const f = projectFacts.get(root);
    if (f && Date.now() - f.at < FACTS_MS) return f;
    const [files, custom] = await Promise.all([trackedFiles(root), stickerFile(root)]);
    const next = { lang: stickerArt.languageOf(files), custom: stickers.cleanCustom(custom), at: Date.now() };
    projectFacts.set(root, next);
    if (projectFacts.size > MAX_FACTS) projectFacts.delete(projectFacts.keys().next().value);
    return next;
  }

  /** Something in `dir` shipped: 'ship' | 'deploy' | 'release' | 'merge'. */
  async function shipped(dir, kind, meta = {}) {
    if (d.CAPTURE || !d.config || typeof dir !== 'string' || !dir) return;
    try {
      const project = await projectOf(dir);
      if (!project) return;
      const facts = await factsOf(project.root);
      recordShipped({ ...project, lang: facts.lang, custom: facts.custom }, kind, meta);
    } catch (e) {
      d.log.error('sticker', e);
    }
  }

  // A pull request merged on GitHub (ci.js). It's the project's sticker whether
  // or not it's cloned here; if it is (Shellby has seen you work in it), the
  // sticker learns its language and folder from that copy.
  async function shippedMerge(pr) {
    if (d.CAPTURE || !d.config) return;
    try {
      const remote = stickers.normalizeRemote(pr.forge === 'gitlab' ? `https://${pr.host}/${pr.repo}` : `${d.githubEndpoints().web}/${pr.repo}`);
      if (!remote) return;
      const id = stickers.projectId(remote);
      const known = stickerState().projects[id];
      let root = known?.root && fs.existsSync(known.root) ? known.root : null;
      for (const key of root ? [] : Object.keys(streaks.normalize(d.config.get('streaks')).projects).slice(0, MERGE_LOOKUP_MAX)) {
        if ((await projectOf(key))?.id === id) { root = key; break; }
      }
      if (root) return shipped(root, 'merge', { fixed: !!pr.fixed });
      recordShipped({ id, name: remote.split('/').pop(), remote }, 'merge', { fixed: !!pr.fixed });
    } catch (e) {
      d.log.error('sticker (merge)', e);
    }
  }

  function recordShipped(project, kind, meta) {
    const shell = wornShellObj();
    // Known by its folder until it got a remote: it keeps its sticker under the new id.
    let state = d.config.get('stickers');
    if (project.remote && project.root) state = stickers.rekey(state, stickers.projectId(null, project.root), project.id);
    const before = stickers.normalize(state).projects[project.id] || null;
    const r = stickers.recordShip(state, project, kind, Date.now(), meta,
      { shell: shellIdOf(shell), slots: shellSpots(d.activeSkin(), shell).slots.length });
    d.workflows?.event('shipped', { kind: kind === 'ship' ? 'push' : kind, project: project.name || '', version: meta?.version || null });
    if (!r.project) return;
    d.config.set({ stickers: r.state });
    d.noteWeek(kind, r.project);
    if (r.minted) d.noteWeek('minted', r.project);
    if (r.minted) slapSticker(r.project);
    else stickerNews(r, before);
    d.send(d.panel, 'stickers', d.stickersView());
    // A trophy this earns waits for the slap to land, so the two don't talk over each other.
    setTimeout(() => d.stickerStats(d.config.get('stickers')), r.minted ? SLAP_MS + TROPHY_AFTER_SLAP_MS : 0);
  }

  // A brand-new sticker: he holds it up, turns his shell to you and slaps it on.
  function slapSticker(p) {
    const drawn = drawSticker(p);
    const placed = shellStickers(d.activeSkin(), wornShellObj()).find(s => s.id === p.id);
    d.flashState('stickered', SLAP_MS + 600);
    d.sayText(`shipped ${p.name}!`, 'sticker', SLAP_MS + 1200);
    d.send(d.critter, 'critter:sticker', { id: p.id, small: drawn.small, at: placed ? { x: placed.x, y: placed.y } : null });
    d.broadcastSkin(); // already includes it; the critter keeps it off until the slap lands
    const view = d.stickersView().projects.find(x => x.id === p.id);
    if (view) d.send(d.panel, 'stickers:new', view);
    if (!(d.panel?.isVisible() && d.panel.isFocused())) {
      d.notify(`New sticker: ${p.name}`, placed ? 'You shipped it, so Shellby slapped its sticker on his shell.' : 'You shipped it. Its sticker is in the Sticker Book.',
        () => { d.showPanel({ focusInput: false }); d.send(d.panel, 'panel:view', 'stickers'); }, { tone: 'celebrate', pet: true });
    }
  }

  // One he already had got better: a tier, a mark, or pressed back down after peeling.
  function stickerNews(r, before) {
    const p = r.project;
    const pressed = before && stickers.weathering(before, Date.now()) !== 'fresh';
    if (!r.tierUp && !r.newMarks.length && !pressed) return;
    d.broadcastSkin();
    setTimeout(() => d.send(d.critter, 'critter:sticker-glint', { id: p.id }), GLINT_MS);
    const marks = stickers.MARKS.filter(m => r.newMarks.includes(m.id));
    const line = r.tierUp ? `${p.name} went ${r.tierUp.name.toLowerCase()}!` : pressed ? `${p.name}, good as new` : `${marks[0].icon} ${p.name}`;
    d.sayText(line, 'sticker', 6000);
    d.send(d.panel, 'stickers:news', { id: p.id, name: p.name, tier: r.tierUp && { id: r.tierUp.id, name: r.tierUp.name }, marks: marks.map(m => ({ id: m.id, name: m.name, icon: m.icon })), pressed });
  }

  return {
    drawSticker, placeStickers, shellIdOf, shellSpots, shellStickers, shipped, shippedMerge,
    stickerState, wornShellObj,
  };
}

module.exports = { createStickers, SLAP_MS };
