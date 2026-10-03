/* Shellby panel — the Wardrobe (outfits, effects, colors, packs) and Trophies. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const SLOT_LABEL = { hat: 'hat', face: 'face item', neck: 'neck item', held: 'held item', shell: 'shell item', effect: 'effect', skin: 'color', home: 'home' };
  const HOME = 'home'; // his own shell (see src/main/shells.js)
  const RARITY = { common: 'Common', rare: 'Rare', epic: 'Epic', legendary: 'Legendary' };
  let slot = 'hat';
  let mood = 'idle';
  let tryOn = null;      // { slot, key } while hovering a tile
  let stageFx = null;

  const wd = () => state.wardrobe;

  // ------------------------------------------------------------ helpers
  function itemsFor(s) {
    const w = wd();
    if (!w) return [];
    if (s === 'effect') return w.effects;
    if (s === 'skin') return state.skins;
    if (s === 'home') return homes();
    return w.accessories.filter(a => a.slot === s);
  }

  // Shells he grows into: locked ones show the level that unlocks them.
  const homes = () => (state.homes?.shells || []).map(sh => ({
    ...sh, key: sh.id, locked: sh.locked ? { reason: 'level', text: `Grows into it at level ${sh.level}`, level: sh.level } : null,
  }));
  const shellFor = key => (key && key !== HOME ? (state.homes?.shells || []).find(sh => sh.id === key) || null : null);

  function lockText(l) {
    if (!l) return '';
    if (l.reason === 'achievement') return `🔒 ${l.text} (${l.current}/${l.goal})`;
    if (l.reason === 'level') return `🔒 ${l.text}`;
    if (l.reason === 'season') {
      const back = l.back ? new Date(l.back).toLocaleDateString([], { month: 'long', day: 'numeric' }) : 'next season';
      return `🔒 ${l.text}, back ${back}`;
    }
    return '🔒 Locked';
  }

  function outfitWith(override) {
    const o = { ...(wd()?.outfit || {}) };
    if (override && override.slot !== 'skin' && override.slot !== 'home') o[override.slot] = override.key;
    return o;
  }

  function renderedAccessories(outfit) {
    const w = wd();
    if (!w) return [];
    return ['shell', 'neck', 'hat', 'face', 'held'].map(s => outfit[s] && w.accessories.find(a => a.key === outfit[s])).filter(Boolean);
  }

  // An effect is shown by its most detailed sprite (a snowflake, not a lone pixel).
  const bigSprite = fx => [...fx.sprites].sort((a, b) => b.pixels.join('').length - a.pixels.join('').length)[0];

  // ------------------------------------------------------------ stage
  function renderStage() {
    const w = wd();
    const outfit = outfitWith(tryOn);
    const skin = tryOn?.slot === 'skin' ? state.skins.find(s => s.id === tryOn.key) || state.skin : state.skin;
    const shell = tryOn?.slot === 'home' ? shellFor(tryOn.key) : state.outfit?.home || null;
    // Stickers belong to the shell (and skin) he's wearing, so trying on another goes bare.
    const stickers = tryOn?.slot === 'home' || tryOn?.slot === 'skin' ? [] : state.outfit?.stickers || [];
    const svg = SB.Sprite.build(skin, { accessories: renderedAccessories(outfit), shell, stickers, fit: false });
    $('wdCrab').replaceChildren(svg);
    const stage = $('wdStage');
    stage.className = `stage state-${mood}`;
    const effect = outfit.effect && w?.effects.find(e => e.key === outfit.effect);
    if (!stageFx) stageFx = window.ShellbyFx.mount($('wdFx'), null, { px: 4 });
    stageFx.set(effect || null); // locked effects can still be previewed
    const bits = ['hat', 'face', 'neck', 'held', 'shell'].map(s => outfit[s]).filter(Boolean).map(k => w.accessories.find(a => a.key === k)?.name).filter(Boolean);
    if (effect) bits.push(effect.name);
    const home = shellFor(state.homes?.worn);
    if (home) bits.unshift(home.name);
    $('wdCaption').textContent = tryOn ? `Trying on: ${(itemsFor(tryOn.slot).find(i => (i.key || i.id) === tryOn.key) || {}).name || 'nothing'}` : bits.length ? bits.join(' · ') : 'Just the shell';
  }

  // ------------------------------------------------------------ grid
  function tile(item) {
    const isSkin = slot === 'skin';
    const key = isSkin ? item.id : item.key;
    const equipped = isSkin ? state.skin?.id === key : slot === 'home' ? state.homes?.worn === key : wd().outfit[slot] === key;
    const locked = item.locked;
    let art;
    if (isSkin) art = SB.sprite(item, { plain: true });
    else if (item.sprites) { const sp = bigSprite(item); art = SB.Sprite.grid(sp.pixels, sp.palette); }
    else art = SB.Sprite.grid(item.pixels, item.palette);
    const tipLines = [item.name, item.description, locked ? lockText(locked) : null, item.rarity && item.rarity !== 'common' ? RARITY[item.rarity] : null].filter(Boolean);
    // Hovering (or tabbing to) a new item is looking at it: the pill fades out.
    const look = e => {
      tryOn = { slot, key };
      renderStage();
      if (!item.isNew || locked) return;
      acknowledge([key]);
      e.currentTarget.classList.remove('is-new');
      e.currentTarget.querySelector('.new-pill')?.classList.add('leaving');
    };
    return h('button', {
      type: 'button', role: 'option', 'aria-selected': String(equipped), dataset: { key },
      class: `wd-tile rarity-${item.rarity || 'common'}${equipped ? ' on' : ''}${locked ? ' locked' : ''}${item.isNew ? ' is-new' : ''}`,
      title: tipLines.join('\n'),
      onmouseenter: look,
      onmouseleave: () => { tryOn = null; renderStage(); },
      onfocus: look,
      onblur: () => { tryOn = null; renderStage(); },
      onclick: () => equip(item, key, equipped),
    },
    h('span', { class: 'wd-art' }, art),
    h('span', { class: 'wd-name', text: item.name }),
    item.isNew && !locked ? h('span', { class: 'new-pill', text: 'new' }) : null,
    locked ? h('span', { class: 'wd-lock', 'aria-hidden': 'true', text: locked.reason === 'season' ? '⏳' : '🔒' }) : null,
    locked?.reason === 'achievement' ? h('span', { class: 'wd-progress' }, h('span', { style: `transform:scaleX(${Math.min(1, locked.current / locked.goal)})` })) : null);
  }

  function renderGrid() {
    const items = itemsFor(slot);
    const grid = $('wdGrid');
    const none = slot === 'skin' ? null : slot === 'home' ? ownShellTile() : h('button', {
      type: 'button', role: 'option', class: `wd-tile none${!wd().outfit[slot] ? ' on' : ''}`, title: `No ${SLOT_LABEL[slot]}`,
      onmouseenter: () => { tryOn = { slot, key: null }; renderStage(); },
      onmouseleave: () => { tryOn = null; renderStage(); },
      onclick: () => equip(null, null, false),
    }, h('span', { class: 'wd-art none-art', text: '∅' }), h('span', { class: 'wd-name', text: 'None' }));
    // Unlocked first, then by rarity; locked items stay visible as goals.
    const order = { common: 0, rare: 1, epic: 2, legendary: 3 };
    const sorted = [...items].sort((a, b) => (!!a.locked - !!b.locked) || (order[a.rarity] ?? 0) - (order[b.rarity] ?? 0));
    grid.replaceChildren(...[none, ...sorted.map(tile)].filter(Boolean));
    document.querySelectorAll('#wdSlots [data-slot]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.slot === slot)));
    refreshBadge();
  }

  // The shell he hatched with: always there, first in the Homes tab.
  function ownShellTile() {
    const on = (state.homes?.worn || HOME) === HOME;
    return h('button', {
      type: 'button', role: 'option', 'aria-selected': String(on), class: `wd-tile${on ? ' on' : ''}`, title: ['His own shell', 'The one he hatched with.'].join('\n'),
      onmouseenter: () => { tryOn = { slot, key: HOME }; renderStage(); },
      onmouseleave: () => { tryOn = null; renderStage(); },
      onfocus: () => { tryOn = { slot, key: HOME }; renderStage(); },
      onblur: () => { tryOn = null; renderStage(); },
      onclick: () => equip(null, HOME, on),
    }, h('span', { class: 'wd-art' }, SB.sprite(state.skin, { plain: true })), h('span', { class: 'wd-name', text: 'His own' }));
  }

  async function equip(item, key, equipped) {
    if (item?.locked) return SB.toast(lockText(item.locked).replace('🔒 ', ''));
    if (slot === 'skin') {
      const r = await api.setSettings({ skin: key });
      state.settings = r.settings;
      return;
    }
    if (slot === 'home') {
      const r = await api.wearHome(key || HOME);
      applyHomes(r.view);
      if (!r.ok) SB.toast(r.error);
      return;
    }
    const r = await api.setOutfit({ [slot]: equipped ? null : key });
    if (!r.ok) return SB.toast(r.error);
    applyView(r.view);
  }

  // ------------------------------------------------------------ season + options + packs
  function renderSeason() {
    const s = wd()?.season;
    const b = $('seasonBanner');
    b.hidden = !s;
    if (!s) return;
    const ends = new Date(s.endsAt).toLocaleDateString([], { month: 'short', day: 'numeric' });
    b.replaceChildren(
      h('span', { class: 'sb-emoji', text: s.emoji }),
      h('span', { class: 'sb-text' }, h('b', { text: `${s.name} is here!` }), ` Limited items are yours to keep if you're around before ${ends}.`),
      s.wearing ? h('span', { class: 'sb-on', text: 'Wearing it' }) : h('button', { type: 'button', class: 'btn slim-btn', onclick: async () => { const r = await api.wearSeason(); applyView(r.view); } }, 'Wear the look'));
  }

  function renderOptions() {
    const o = wd()?.options || {};
    $('seasonalToggle').checked = !!o.seasonalAuto;
    $('crewToggle').checked = !!o.crewOutfits;
    $('unlockAllToggle').checked = !!o.unlockAll;
  }

  const canPublish = () => { const g = state.github; return !!(g?.signedIn && g.features.publish.on && g.features.publish.granted); };
  async function publish(p, btn) {
    btn.disabled = true;
    btn.textContent = 'Publishing…';
    const r = await api.publishPack(p.id);
    btn.disabled = false;
    btn.textContent = 'Publish';
    if (r.ok) SB.toast(`Pull request opened for ${p.name}. The gallery's Pack check reviews it next.`, { action: 'View', onAction: () => api.openExternal(r.url), ms: 7000 });
    else if (!r.canceled) SB.toast(r.error || "Couldn't publish that pack.", { ms: 7000 });
  }

  function renderPacks() {
    const packs = wd()?.packs || [];
    $('packList').replaceChildren(...packs.map(p => h('li', { class: 'pack' },
      h('div', { class: 'pack-main' },
        h('b', { text: p.name }), h('span', { class: 'pack-meta', text: ` v${p.version} · by ${p.author}` }),
        h('div', { class: 'pack-counts', text: [`${p.counts.accessories} accessories`, `${p.counts.effects} effects`, `${p.counts.skins} colors`].join(' · ') + (p.warnings ? ` · ${p.warnings} skipped` : '') })),
      p.source === 'builtin' ? h('span', { class: 'src-pill', text: 'built in' }) : null,
      p.source !== 'builtin' && canPublish() ? h('button', { class: 'btn ghost slim-btn publish-btn', type: 'button', title: 'Open a pull request to the community gallery', onclick: e => publish(p, e.currentTarget) }, 'Publish') : null,
      p.source !== 'builtin' ? h('button', { class: 'btn ghost slim-btn', type: 'button', onclick: async () => { applyView(await api.removePack(p.id)); SB.toast(`Removed ${p.name}`); } }, 'Remove') : null)));
    for (const err of wd()?.errors || []) $('packList').append(h('li', { class: 'pack bad', text: `⚠ ${err}` }));
  }

  function applyView(view) {
    if (!view) return;
    state.wardrobe = view;
    $('wdCount').textContent = `${view.totals.unlocked}/${view.totals.all}`;
    refreshBadge();
    if (state.view === 'wardrobe') render();
    if (state.view === 'trophies') renderTrophies();
  }
  SB.applyWardrobe = applyView;

  const freshItems = () => [...(wd()?.accessories || []), ...(wd()?.effects || []), ...homes()].filter(i => i.isNew && !i.locked);
  const refreshBadge = () => {
    const fresh = freshItems().length > 0;
    $('wardrobeBadge').hidden = !fresh && !state.stickers?.unseen?.length; // new stickers too (stickers.js)
    $('markSeenBtn').hidden = !fresh;
    document.querySelectorAll('#wdSlots [data-slot]').forEach(b => b.classList.toggle('has-new', itemsFor(b.dataset.slot).some(i => i.isNew && !i.locked)));
  };

  // Acknowledge new items (by key; homes by shell id): hovering one, "Mark all
  // seen", or closing the card that announced them. Clears here at once, then
  // tells main so it sticks.
  function acknowledge(keys) {
    const fresh = new Set(keys);
    const w = wd();
    const items = [...(w?.accessories || []), ...(w?.effects || [])].filter(i => i.isNew && fresh.has(i.key)).map(i => i.key);
    const shells = (state.homes?.shells || []).filter(s => s.isNew && fresh.has(s.id)).map(s => s.id);
    if (items.length) {
      const clear = i => (fresh.has(i.key) ? { ...i, isNew: false } : i);
      state.wardrobe = { ...w, accessories: w.accessories.map(clear), effects: w.effects.map(clear) };
      api.markSeen(items);
    }
    if (shells.length) {
      state.homes = { ...state.homes, shells: state.homes.shells.map(s => (fresh.has(s.id) ? { ...s, isNew: false } : s)) };
      api.homesSeen(shells);
    }
    if (items.length || shells.length) refreshBadge();
  }
  SB.acknowledge = acknowledge;
  SB.refreshShellbyBadge = refreshBadge;
  function applyHomes(view) {
    if (!view) return;
    state.homes = view;
    refreshBadge();
    if (state.view === 'wardrobe' && wd()) render();
  }
  SB.applyHomes = applyHomes;

  function render() {
    if (!wd()) return;
    renderSeason();
    renderStage();
    renderGrid();
    renderOptions();
    renderPacks();
  }

  // ------------------------------------------------------------ trophies
  function renderTrophies() {
    const list = wd()?.achievements || [];
    $('trophyCount').textContent = `${list.filter(a => a.done).length}/${list.length}`;
    $('trophyList').replaceChildren(...list.map(a => h('li', { class: `trophy${a.done ? ' done' : ''}${a.hidden && !a.done ? ' secret' : ''}` },
      h('span', { class: 'trophy-icon', text: a.hidden && !a.done ? '❔' : a.icon }),
      h('div', { class: 'trophy-main' },
        h('div', { class: 'trophy-name' }, a.name, a.done ? h('span', { class: 'trophy-check', text: '✓' }) : null),
        h('div', { class: 'trophy-desc', text: a.description }),
        a.done ? null : h('div', { class: 'trophy-bar' }, h('span', { style: `transform:scaleX(${Math.min(1, a.current / a.goal)})` }), h('em', { text: `${a.current}/${a.goal}` }))),
      h('div', { class: 'trophy-rewards' }, a.rewards.map(r => h('span', { class: 'reward', title: r.name },
        r.sprites ? SB.Sprite.grid(bigSprite(r).pixels, bigSprite(r).palette) : SB.Sprite.grid(r.pixels, r.palette)))))));
  }

  // ------------------------------------------------------------ wiring
  document.querySelectorAll('#wdSlots [data-slot]').forEach(b => b.addEventListener('click', () => { slot = b.dataset.slot; tryOn = null; renderGrid(); renderStage(); }));
  document.querySelectorAll('.stage-moods [data-mood]').forEach(b => b.addEventListener('click', () => {
    mood = b.dataset.mood;
    document.querySelectorAll('.stage-moods [data-mood]').forEach(x => x.classList.toggle('on', x === b));
    renderStage();
  }));
  $('randomizeBtn').addEventListener('click', async () => { const r = await api.randomizeOutfit(); applyView(r.view); });
  $('markSeenBtn').addEventListener('click', () => {
    acknowledge(freshItems().map(i => i.key));
    if (state.view === 'wardrobe') renderGrid();
  });
  $('brandBtn').addEventListener('click', () => SB.setView('wardrobe'));
  $('brandLevel').addEventListener('click', () => SB.setView('trophies'));
  document.querySelectorAll('.shellby-tabs [data-goto]').forEach(b => b.addEventListener('click', () => SB.setView(b.dataset.goto)));
  $('seasonalToggle').addEventListener('change', async e => applyView(await api.setWardrobeOptions({ seasonalAuto: e.target.checked })));
  $('crewToggle').addEventListener('change', async e => applyView(await api.setWardrobeOptions({ crewOutfits: e.target.checked })));
  $('unlockAllToggle').addEventListener('change', async e => applyView(await api.setWardrobeOptions({ unlockAll: e.target.checked })));
  $('installPackBtn').addEventListener('click', () => install());
  $('packsFolderBtn').addEventListener('click', () => api.openPacksFolder());
  $('reloadPacksBtn').addEventListener('click', async () => {
    state.skins = await api.reloadSkins();
    applyView(await api.wardrobeView());
    SB.toast(`Reloaded ${state.wardrobe.packs.length} pack${state.wardrobe.packs.length === 1 ? '' : 's'}`);
  });
  $('packGuideBtn').addEventListener('click', () => api.openExternal('https://github.com/x-salmon/shellby/blob/main/docs/ADDONS.md'));
  // The gallery's "Add to Shellby" buttons come back as shellby:// links (see src/main/registry.js).
  $('browsePacksBtn').addEventListener('click', () => api.openExternal(state.registryUrl || 'https://x-salmon.github.io/shellby-packs/'));

  async function install(file) {
    const r = await api.installPack(file);
    if (r.canceled) return;
    if (!r.ok) return SB.toast(`Couldn't install: ${(r.errors || ['unknown error'])[0]}`, { ms: 5000 });
    applyView(r.view);
    SB.toast(`Installed ${r.pack.name}${r.warnings.length ? ` (${r.warnings.length} items skipped)` : ''}`);
  }

  // Drop a pack .json onto the Wardrobe to install it (instead of attaching it to a task).
  window.addEventListener('drop', e => {
    if (!['wardrobe', 'trophies'].includes(state.view)) return;
    const paths = api.pathsForFiles(e.dataTransfer.files).filter(p => /\.json$/i.test(p));
    if (!paths.length) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    document.body.classList.remove('dropping');
    install(paths[0]);
  }, true);

  // ------------------------------------------------------------ celebrations
  SB.onUnlocked = e => {
    SB.celebrate({ icon: e.achievement.icon, title: e.achievement.name, text: e.achievement.description, rewards: e.rewards });
  };
  // Result of a one-click install from the community gallery (main already
  // broadcast the refreshed wardrobe view on success).
  SB.onPackInstalled = r => {
    if (!r || r.canceled) return;
    if (!r.ok) return SB.toast(`Couldn't install: ${r.error || 'unknown error'}`, { ms: 6000 });
    if (r.already) return SB.toast(`${r.name} ${r.version} is already installed.`, { ms: 4000 });
    const skipped = r.warnings ? ` (${r.warnings} items skipped)` : '';
    SB.toast(`Installed ${r.name}${skipped}. Find the new items in the Wardrobe`, { action: state.view === 'wardrobe' ? null : 'Open Wardrobe', ms: 5000, onAction: () => SB.setView('wardrobe') });
  };
  SB.onCollected = items => {
    if (!items.length) return;
    SB.toast(`✨ New seasonal items: ${items.map(i => i.name).join(', ')}`, { action: 'Open Wardrobe', ms: 6000, onAction: () => SB.setView('wardrobe') });
  };

  SB.views.wardrobe = { render, refreshPublish: () => { if (state.view === 'wardrobe') renderPacks(); } };
  SB.views.trophies = { render: renderTrophies };
})();
