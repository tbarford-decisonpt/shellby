/* Shellby panel — the Sticker Book: a sticker for every project shipped
   (src/main/stickers.js), and his shell to decorate with them. Pick a sticker,
   then a spot on his shell (or drag it there); keys work on the spots too. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const BENCH_PX = 10;   // the crab on the bench, in screen pixels per sprite pixel
  const SPOT = 3;        // a sticker is 3x3 on his shell
  const DRAG_TYPE = 'application/x-shellby-sticker';
  let shellId = null;    // the shell being decorated (null: the one he's wearing)
  let selected = null;   // the sticker whose page is open
  let holding = null;    // the sticker about to go on a spot

  const book = () => state.stickers;
  const projectOf = id => book()?.projects.find(p => p.id === id) || null;
  const currentShell = () => {
    const shells = book()?.shells || [];
    return shells.find(s => s.id === shellId) || shells.find(s => s.worn) || shells[0] || null;
  };
  const onSpot = (sh, i) => (sh?.stickers || []).filter(s => s.slot % (sh.slots.length || 1) === i).sort((a, b) => b.z - a.z);
  const art = (p, k) => SB.Sprite.grid(p.art.pixels, p.art.palette, { px: k });
  const when = t => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  function hint(text) { $('stHint').textContent = text || ''; }

  // ------------------------------------------------------------ the bench (his shell, big)
  function renderBench() {
    const sh = currentShell();
    const bench = $('stBench');
    bench.classList.toggle('holding', !!holding);
    if (!sh || !state.skin) { $('stCrab').replaceChildren(); $('stSpots').replaceChildren(); return; }
    const svg = SB.Sprite.build(state.skin, { shell: sh.render, stickers: sh.stickers, accessories: [], px: BENCH_PX });
    $('stCrab').replaceChildren(svg);
    const spots = sh.slots.map(([x, y], i) => {
      const on = onSpot(sh, i);
      const names = on.map(s => projectOf(s.id)?.name).filter(Boolean);
      const label = on.length ? `Spot ${i + 1}: ${names.join(', then ')}${on.length > 1 ? ' underneath' : ''}` : `Spot ${i + 1}: empty`;
      const btn = h('button', {
        type: 'button', class: `st-spot${on.length ? ' has' : ''}${holding ? ' ready' : ''}`, 'aria-label': holding ? `${label}. Press Enter to put ${projectOf(holding)?.name} here.` : label,
        title: names.length ? names.join(' · ') : 'Empty spot',
        style: `left:${x * BENCH_PX}px;top:${y * BENCH_PX}px;width:${SPOT * BENCH_PX}px;height:${SPOT * BENCH_PX}px`,
        draggable: on.length ? 'true' : null,
        onclick: () => spotClick(i, on),
        onkeydown: e => spotKey(e, i, on),
        ondragstart: e => { if (on[0]) startDrag(e, on[0].id); },
        ondragover: e => { if (dragging(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; btn.classList.add('over'); } },
        ondragleave: () => btn.classList.remove('over'),
        ondrop: e => { const id = dragging(e); btn.classList.remove('over'); if (id) { e.preventDefault(); e.stopPropagation(); place(id, i); } },
      });
      return btn;
    });
    $('stSpots').replaceChildren(...spots);
    $('stSpots').style.width = `${svg.getAttribute('width')}px`;
    $('stSpots').style.height = `${svg.getAttribute('height')}px`;
  }

  function spotClick(i, on) {
    if (holding) return place(holding, i);
    if (on[0]) return select(on[0].id);
    hint('Pick a sticker below, then a spot. Or drag one up here.');
  }

  function spotKey(e, i, on) {
    const top = on[0];
    if (e.key === 'Escape' && holding) { e.preventDefault(); return drop(); }
    if (!top) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); edit(api.removeSticker(top.id, currentShell().id), `Peeled off ${projectOf(top.id)?.name}.`, i); }
    else if (e.key === ']') { e.preventDefault(); edit(api.restackSticker(top.id, 'up', currentShell().id), null, i); }
    else if (e.key === '[') { e.preventDefault(); edit(api.restackSticker(top.id, 'down', currentShell().id), `${projectOf(top.id)?.name} went underneath.`, i); }
    else if (e.key.toLowerCase() === 'f') { e.preventDefault(); edit(api.flipSticker(top.id, currentShell().id), null, i); }
  }

  // ------------------------------------------------------------ dragging
  function startDrag(e, id) {
    e.dataTransfer.setData(DRAG_TYPE, id);
    e.dataTransfer.effectAllowed = 'move';
    holding = id;
    $('stBench').classList.add('holding');
  }
  const dragging = e => (e.dataTransfer.types.includes(DRAG_TYPE) ? e.dataTransfer.getData(DRAG_TYPE) || holding : null);

  // ------------------------------------------------------------ edits
  async function edit(promise, said, focusSpot = null) {
    const r = await promise;
    if (r?.view) apply(r.view);
    if (r && !r.ok && r.error) SB.toast(r.error);
    else if (said) hint(said);
    if (focusSpot !== null) $('stSpots').children[focusSpot]?.focus();
  }

  function place(id, slot) {
    const name = projectOf(id)?.name;
    holding = null;
    edit(api.placeSticker(id, slot, currentShell().id), `${name} is on spot ${slot + 1}. [ and ] change which is on top; F flips it.`, slot);
  }

  function hold(id) {
    holding = id;
    renderBench();
    hint(`Now pick a spot on his shell for ${projectOf(id)?.name}. Esc to cancel.`);
    $('stSpots').querySelector('.st-spot')?.focus();
  }

  function drop() {
    holding = null;
    renderBench();
    hint('');
  }

  // ------------------------------------------------------------ the shells he can decorate
  function renderShells() {
    const list = book()?.shells || [];
    const cur = currentShell();
    $('stShells').hidden = list.length < 2;
    $('stShells').replaceChildren(...list.map(sh => h('button', {
      type: 'button', role: 'radio', class: `st-shell-chip${sh.id === cur?.id ? ' on' : ''}`, 'aria-checked': String(sh.id === cur?.id),
      title: sh.worn ? `${sh.name} (wearing it)` : `${sh.name}: decorate it for when he moves back in`,
      onclick: () => { shellId = sh.id; holding = null; render(); },
    }, sh.name, sh.stickers.length ? h('span', { class: 'n', text: String(sh.stickers.length) }) : null, sh.worn ? h('span', { class: 'st-worn', text: '●', 'aria-label': 'wearing' }) : null)));
  }

  // ------------------------------------------------------------ the book
  function tile(p) {
    const on = currentShell()?.stickers.some(s => s.id === p.id);
    return h('li', { role: 'presentation' }, h('button', {
      type: 'button', role: 'option', 'aria-selected': String(selected === p.id),
      class: `st-tile tier-${p.tier} weather-${p.weather}${selected === p.id ? ' on' : ''}${on ? ' placed' : ''}`,
      'aria-label': `${p.name}, ${p.tierName} sticker, ${p.from ? `from @${p.from}` : plural(p.ships, 'ship')}${on ? ', on this shell' : ''}${p.isNew ? ', new' : ''}`,
      draggable: 'true',
      ondragstart: e => startDrag(e, p.id),
      ondragend: () => { if (holding === p.id) drop(); },
      onclick: () => select(p.id),
      ondblclick: () => hold(p.id),
    },
    h('span', { class: 'st-art' }, art(p, 3)),
    h('span', { class: 'st-name', text: p.name }),
    h('span', { class: 'st-tier', text: p.from ? `@${p.from}` : p.tierName }),
    p.isNew ? h('span', { class: 'new-pill', text: 'new' }) : null,
    p.marks.length ? h('span', { class: 'st-marks', 'aria-hidden': 'true', text: p.marks.map(m => m.icon).join('') }) : null,
    on ? h('span', { class: 'st-on', 'aria-hidden': 'true', title: 'On this shell', text: '🐚' }) : null));
  }

  function renderGrid() {
    const list = book()?.projects || [];
    $('stGrid').replaceChildren(...list.map(tile));
    $('stGrid').hidden = !list.length;
    const waiting = book()?.waiting || [];
    $('stWaitingWrap').hidden = !waiting.length;
    $('stWaiting').replaceChildren(...waiting.map(w => h('li', { class: 'st-ghost' },
      h('span', { class: 'st-ghost-art', 'aria-hidden': 'true', text: '?' }),
      h('span', { class: 'st-name', text: w.name }))));
  }

  // Its last dependency checkup (checkup.js), in a line.
  function depsText(d) {
    if (!d) return '🧼 Dependencies never checked. A clean audit earns this sticker the Fresh mark.';
    const a = d.audit, o = d.outdated;
    const parts = [];
    if (a?.status === 'clean') parts.push(d.fresh ? '🧼 Fresh: no known vulnerabilities' : 'No known vulnerabilities, but it’s been a while');
    else if (a?.status === 'issues') parts.push(`⚠️ ${a.count ? plural(a.count, 'known vulnerability', 'known vulnerabilities') : 'Known vulnerabilities'}`);
    if (o?.status === 'issues') parts.push(o.count ? `${plural(o.count, 'outdated package')}` : 'some packages outdated');
    else if (o?.status === 'clean') parts.push('everything up to date');
    const at = Math.max(a?.at || 0, o?.at || 0);
    return `${parts.join(' · ') || 'Last checkup couldn’t be read'} · checked ${SB.relTime(at)}`;
  }

  function renderDetail() {
    const p = selected && projectOf(selected);
    const box = $('stDetail');
    box.hidden = !p;
    if (!p) return box.replaceChildren();
    const sh = currentShell();
    const placed = sh?.stickers.find(s => s.id === p.id);
    const nextLine = p.from ? `from @${p.from}` : p.next ? `${plural(p.next.left, 'more ship')} to ${p.next.name}` : 'As shiny as it gets';
    const weather = p.weather === 'faded' ? 'Faded: it hasn’t shipped in six months. Ship it again to press it back down.'
      : p.weather === 'peeling' ? 'Peeling at one corner: it hasn’t shipped in two months.' : null;
    const stats = [
      plural(p.ships, 'ship'),
      p.deploys ? plural(p.deploys, 'deploy') : null,
      p.releases ? `${plural(p.releases, 'release')}${p.lastVersion ? ` (latest v${p.lastVersion})` : ''}` : null,
      p.merges ? plural(p.merges, 'merged PR', 'merged PRs') : null,
      p.lang,
    ].filter(Boolean);
    box.replaceChildren(
      h('div', { class: `st-big tier-${p.tier} weather-${p.weather}` }, art(p, 8), p.years ? h('span', { class: 'st-ribbon', text: `${p.years} yr` }) : null),
      h('div', { class: 'st-info' },
        h('p', { class: 'xp-eyebrow st-eyebrow', text: `${p.tierName} sticker · ${nextLine}` }),
        h('h3', { text: p.name }),
        h('p', { class: 'st-when', text: p.from ? `@${p.from}'s crab left it on ${when(p.firstShipAt)}` : `First shipped ${when(p.firstShipAt)} · last ${SB.relTime(p.lastShipAt)}` }),
        p.from ? null : h('p', { class: 'st-stats', text: stats.join(' · ') }),
        weather ? h('p', { class: 'st-weather', text: weather }) : null,
        p.from ? null : h('p', { class: 'st-deps', text: depsText(p.deps) }),
        p.marks.length ? h('ul', { class: 'st-mark-list', 'aria-label': 'Marks' }, p.marks.map(m => h('li', { title: m.description }, h('span', { 'aria-hidden': 'true', text: m.icon }), m.name))) : null,
        h('div', { class: 'st-actions' },
          placed
            ? [
              h('button', { type: 'button', class: 'btn slim-btn', onclick: () => edit(api.removeSticker(p.id, sh.id), `Peeled ${p.name} off. It stays in the book.`) }, 'Take off'),
              h('button', { type: 'button', class: 'btn ghost slim-btn', title: 'Bring to the top of the pile', onclick: () => edit(api.restackSticker(p.id, 'up', sh.id)) }, 'To front'),
              h('button', { type: 'button', class: 'btn ghost slim-btn', title: 'Slip under the others', onclick: () => edit(api.restackSticker(p.id, 'down', sh.id)) }, 'To back'),
              h('button', { type: 'button', class: 'btn ghost slim-btn', title: 'Mirror it', onclick: () => edit(api.flipSticker(p.id, sh.id)) }, 'Flip'),
            ]
            : h('button', { type: 'button', class: 'btn primary slim-btn', disabled: !sh?.slots.length, onclick: () => hold(p.id) }, sh?.slots.length ? 'Put on shell' : 'No room on this shell'),
          p.canOpen ? h('button', { type: 'button', class: 'btn ghost slim-btn', onclick: () => { api.openStickerProject(p.id); SB.setView('chat'); } }, 'Pick up where we left off') : null,
          p.canOpen ? h('button', { type: 'button', class: 'btn ghost slim-btn', title: 'Look for outdated and vulnerable packages', onclick: async () => {
            const res = await api.checkupSticker(p.id);
            if (!res.ok) return SB.toast(res.error);
            SB.setView('chat');
            SB.toast('Press Enter to run the checkup');
          } }, 'Check dependencies') : null),
        h('label', { class: 'toggle st-hide' },
          h('input', { type: 'checkbox', checked: p.hidden, onchange: async e => apply(await api.hideSticker(p.id, e.target.checked)) }),
          h('span', { class: 'switch' }), 'Keep off my calling card')),
      h('button', { class: 'cel-close icon-btn st-close', type: 'button', 'aria-label': 'Close', onclick: () => { selected = null; render(); } },
        SB.icon('M4.5 4.5l7 7M11.5 4.5l-7 7', { width: 1.5 })));
  }

  function select(id) {
    selected = id;
    render();
    $('stDetail').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function renderHead() {
    const v = book();
    const n = v?.totals.projects || 0;
    $('stTotal').textContent = n ? `${plural(n, 'project')} shipped` : 'No stickers yet';
    const t = v?.totals.byTier || {};
    $('stSub').textContent = n
      ? [`${plural(v.totals.ships, 'ship')} in all`, t.foil ? `${t.foil} foil` : null, t.holo ? `${t.holo} holo` : null, t.vinyl ? `${t.vinyl} vinyl` : null].filter(Boolean).join(' · ')
      : 'Push, deploy or release a project and Shellby slaps its sticker on his shell. Ship it again and the sticker gets shinier.';
    $('stAuto').checked = !!v?.auto;
    $('stArrange').disabled = !n;
    const mode = v?.card || 'off';
    $('stCardHelp').textContent = {
      off: 'Friends see his shell without stickers.',
      art: 'Friends see the stickers on his shell as little patches of colour: no names or letters.',
      names: 'Friends also see your three most-shipped stickers, names included (private repos too), and a visit may swap one of them for one of theirs.',
    }[mode];
    document.querySelectorAll('#stCardMode [data-card]').forEach(b => {
      const on = b.dataset.card === mode;
      b.setAttribute('aria-checked', String(on));
      b.setAttribute('aria-selected', String(on));
    });
  }

  function render() {
    if (!book()) return;
    renderHead();
    renderShells();
    renderBench();
    renderGrid();
    renderDetail();
    // Seen: new badges clear once the book has been opened.
    if (book().unseen.length) {
      api.stickersSeen(book().unseen);
      state.stickers = { ...book(), unseen: [], projects: book().projects.map(p => ({ ...p, isNew: false })) };
      refreshBadges();
    }
  }

  function refreshBadges() {
    const v = book();
    document.querySelectorAll('.st-count').forEach(el => { el.textContent = v?.totals.projects ? String(v.totals.projects) : ''; });
    document.querySelectorAll('.st-badge').forEach(el => { el.hidden = !v?.unseen.length; });
    SB.refreshShellbyBadge?.();
  }

  function apply(view) {
    if (!view) return;
    state.stickers = view;
    if (selected && !projectOf(selected)) selected = null;
    if (shellId && !view.shells.some(s => s.id === shellId)) shellId = null;
    refreshBadges();
    if (state.view === 'stickers') render();
  }
  SB.applyStickers = apply;

  // ------------------------------------------------------------ wiring
  $('stArrange').addEventListener('click', () => edit(api.arrangeStickers(currentShell()?.id), 'Tidied up: the most shipped are in the middle, on top.'));
  $('stAuto').addEventListener('change', async e => apply(await api.setStickerOptions({ auto: e.target.checked })));
  document.querySelectorAll('#stCardMode [data-card]').forEach(b => b.addEventListener('click', async () => apply(await api.setStickerOptions({ card: b.dataset.card }))));
  // Dropped back on the book: peeled off the shell.
  $('stGrid').addEventListener('dragover', e => { if (dragging(e)) e.preventDefault(); });
  $('stGrid').addEventListener('drop', e => {
    const id = dragging(e);
    const sh = currentShell();
    if (!id || !sh?.stickers.some(s => s.id === id)) return;
    e.preventDefault();
    e.stopPropagation();
    holding = null;
    edit(api.removeSticker(id, sh.id), `Peeled ${projectOf(id)?.name} off. It stays in the book.`);
  });
  document.addEventListener('dragend', () => { if (holding && state.view === 'stickers') { holding = null; $('stBench').classList.remove('holding'); } });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && holding && state.view === 'stickers') drop(); });

  api.onStickers(apply);
  // A redrawn crab (new skin, new shell) moves the spots.
  api.onSkin(() => { if (state.view === 'stickers') api.getStickers().then(apply); });

  // ------------------------------------------------------------ celebrations
  api.onStickerNew(p => {
    if (!p?.art) return;
    api.getStickers().then(apply);
    SB.celebrate({
      eyebrow: p.from ? 'Sticker swap' : 'New sticker', icon: p.from ? '🤝' : '🏷️', title: p.name,
      text: p.from ? `@${p.from}'s crab left it when they visited. Put it on his shell from the Sticker Book.`
        : p.shells.length ? 'You shipped it, so he slapped its sticker on his shell. Ship it again to make it shinier.' : 'You shipped it. Its sticker is in the Sticker Book.',
      rewards: [{ name: p.name, pixels: p.art.pixels, palette: p.art.palette, kind: 'sticker' }],
      action: { label: 'Open Sticker Book', run: () => { selected = p.id; SB.setView('stickers'); } },
    });
  });
  api.onStickerNews(n => {
    if (!n) return;
    const text = n.tier ? `${n.name} went ${n.tier.name.toLowerCase()} ✨` : n.pressed ? `${n.name} shipped again: its sticker is pressed back down` : `${n.marks.map(m => `${m.icon} ${m.name}`).join(', ')} on ${n.name}`;
    SB.toast(text, { action: 'Sticker Book', ms: 5000, onAction: () => { selected = n.id; SB.setView('stickers'); } });
  });

  // Fresh on the way in: a new skin or a molt since last time moves the spots.
  SB.views.stickers = { render: () => { render(); api.getStickers().then(apply); } };
  if (state.stickers) apply(state.stickers);
})();
