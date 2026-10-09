/* Shellby panel — the Tank tab's words and controls around the glass: the
   title line, his favourite and the sets on display, where decor comes from,
   the tray, the size and light switches and the calling-card switch. Each is
   drawn from what tank.js hands it (the tank from main, the draft, whether
   you're decorating) and keeps no state of its own. Loaded before tank.js. */
'use strict';
(function () {
  const { h, $ } = SB;
  const THUMB = 44;          // device px, the tray's pictures

  const plural = (n, one, many) => SB.plural(n, one, many, x => x.toLocaleString());
  const listOf = parts => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`);

  // His favourite and the sets on display, under the tank's name.
  function renderLife({ v, life, editing }) {
    let el = $('tkLife');
    if (!el) {
      el = h('p', { class: 'tk-sub tk-life', id: 'tkLife' });
      $('tkSub').after(el);
    }
    const fav = life.favourite && v?.pieces.find(p => p.uid === life.favourite);
    const parts = [];
    if (fav) parts.push(`His favourite: the ${fav.name.toLowerCase()}`);
    if (life.sets?.length) parts.push(`On display: ${listOf(life.sets.map(x => `${x.icon} ${x.name}`))}`);
    el.textContent = parts.join(' · ');
    el.hidden = !parts.length || editing;
  }

  function renderTitle({ v, lay, names, editing, canvas }) {
    const sz = v.sizes.find(s => s.id === lay.size) || v.size;
    const n = lay.placed.length;
    $('tkSub').textContent = `${sz.name} · ${n} of ${plural(sz.cap, 'piece')}`;
    $('tkEmpty').hidden = n > 0 || editing;
    canvas.setAttribute('aria-label', names.length
      ? `His tank, the ${sz.name.toLowerCase()}: ${listOf(names.length > 6 ? [...names.slice(0, 5), plural(names.length - 5, 'more thing')] : names)}.`
      : `His tank, the ${sz.name.toLowerCase()}. Nothing in it yet.`);
    const missing = v.missing.length;
    $('tkMissing').hidden = !missing || editing;
    $('tkMissing').textContent = missing ? `${plural(missing, 'piece')} in his tank can’t be shown on this PC (its pack was removed, or it’s locked again). ${missing === 1 ? 'It keeps' : 'They keep'} ${missing === 1 ? 'its' : 'their'} place.` : '';
  }

  // ------------------------------------------------------------ what you can point at

  const rowName = (v, p) => (p.category === 'sticker' ? ['high on the glass', 'on the glass', 'low on the glass'][p.row] : p.layer === 'float' ? ['high in the water', 'in the water', 'low in the water'][p.row] : p.layer === 'back' ? 'against the back glass' : `${v.rows[p.row]} row`);

  // A button over each piece (and one over him), so the scene can be pointed at and tabbed through.
  function renderHits({ v, hits, pieces, edit, selected, u, crab }) {
    const buttons = pieces.map(p => h('button', {
      type: 'button',
      class: `tk-hit${selected === p.uid ? ' on' : ''}${edit ? ' edit' : ''}`,
      style: `left:${(p.x - 1) * u}px;top:${(p.y - p.h) * u}px;width:${(p.w + 2) * u}px;height:${(p.h + 2) * u}px`,
      'aria-label': `${p.name}, ${rowName(v, p)}${p.flip ? ', flipped' : ''}`,
      'aria-describedby': edit ? 'tkKeys' : null,
      'aria-pressed': edit ? String(selected === p.uid) : null,
      dataset: { uid: String(p.uid), name: p.name, keep: `hit:${p.uid}` },
    }));
    if (crab) buttons.push(h('button', { type: 'button', class: 'tk-hit tk-hit-crab', 'aria-label': 'Pet Shellby', dataset: { name: 'Shellby', keep: 'crab' }, style: `width:${crab.w * u}px;height:${crab.h * u}px` }));
    hits.replaceChildren(...buttons, h('span', { class: 'tk-tag', id: 'tkTag', 'aria-hidden': 'true', hidden: true }));
  }

  function tag(btn, dragging) {
    const el = $('tkTag');
    if (!el) return;
    if (!btn || dragging) { el.hidden = true; return; }
    el.textContent = btn.dataset.name;
    el.hidden = false;
    el.style.left = `${parseFloat(btn.style.left) + parseFloat(btn.style.width) / 2}px`;
    el.style.top = `${parseFloat(btn.style.top)}px`;
  }

  // ------------------------------------------------------------ words and controls around it

  function renderTools({ edit, history, future, item }) {
    $('tkDecorate').hidden = edit;
    for (const id of ['tkUndo', 'tkRedo', 'tkCancel', 'tkDone']) $(id).hidden = !edit;
    $('tkUndo').disabled = !history.length;
    $('tkRedo').disabled = !future.length;
    $('tkPicked').hidden = !item;
    if (item) $('tkPickedName').textContent = item.name;
    $('tkKeysHint').hidden = !edit;
  }

  // Where more decor comes from, counted from the tray itself.
  function renderKey({ v, editing }) {
    $('tkKeySec').hidden = editing;
    if (editing) return;
    const decor = v.tray.filter(t => t.kind === 'decor');
    const have = decor.filter(t => !t.locked);
    const earned = decor.filter(t => t.unlock?.achievement);
    const nextUp = earned.find(t => t.locked && t.locked.reason === 'achievement');
    const seasonal = decor.filter(t => t.unlock?.season);
    const finds = v.tray.filter(t => t.kind === 'find');
    const jars = v.tray.filter(t => t.kind === 'jar');
    const bar = (n, of) => h('span', { class: 'tk-bar', 'aria-hidden': 'true', style: `--fill: ${of ? n / of : 0}` });
    $('tkKeyMeta').replaceChildren(`${have.length} of ${plural(decor.length, 'piece')} are his`, bar(have.length, decor.length));
    // One source per row: what it is, how many, and a line on how they arrive.
    const row = (name, count, text, meter) => h('li', { class: 'tk-src' },
      h('div', { class: 'tk-src-h' }, h('span', { class: 'tk-src-name', text: name }), h('span', { class: 'tk-src-n', text: count })),
      meter, h('p', {}, text));
    const one = seasonal.length === 1;
    const trophies = earned.filter(t => !t.locked).length;
    const nextText = nextUp && nextUp.locked.text.replace(/^[^:]*: /, '').replace(/^./, c => c.toUpperCase());
    $('tkKey').replaceChildren(
      row('From the start', String(decor.filter(t => t.unlock?.default).length), 'A castle, plants, rocks, a floor and a back wall.'),
      row('Trophies', `${trophies} of ${earned.length}`,
        nextUp ? [h('b', { text: `Next: the ${nextUp.name.toLowerCase()}. ` }), `${nextText}.`] : 'Every trophy piece is his.',
        bar(trophies, earned.length)),
      row('Seasons', `${seasonal.filter(t => !t.locked).length} of ${seasonal.length}`,
        `${one ? 'Turns' : 'Turn'} up in ${one ? 'its' : 'their'} season, then ${one ? 'stays' : 'stay'} for good.`),
      row('His finds', String(finds.length),
        finds.length ? 'Everything he digs up can go in, as many as he’s found.' : 'Whatever he digs up for you can go in. Nothing yet: give him time.'),
      ...(jars.length ? [row('Specimen jars', String(jars.length), 'Every kind of bug Claude has fixed, in a jar from the Bugdex.')] : []));
  }

  function shelves(v) {
    const present = new Set(v.tray.map(t => t.category));
    return v.categories.filter(c => present.has(c.id));
  }

  // The tray's shelves and the items on the open one. Returns the open shelf
  // (the first there is when the one asked for has gone).
  function renderTray({ v, draft, shelf, seen, capacity }) {
    const list = shelves(v);
    if (!list.some(c => c.id === shelf)) shelf = list[0]?.id || null;
    $('tkShelves').replaceChildren(...list.map(c => {
      const fresh = v.tray.some(t => t.category === c.id && t.isNew && !t.locked && t.kind === 'decor' && !seen.has(t.ref));
      return h('button', { type: 'button', role: 'tab', 'aria-selected': String(c.id === shelf), tabindex: c.id === shelf ? '0' : '-1', dataset: { shelf: c.id, keep: `shelf:${c.id}` } },
        c.name, fresh ? h('i', { class: 'dot-badge', 'aria-hidden': 'true' }) : null);
    }));
    const lay = draft;
    const style = shelf === 'substrate' || shelf === 'backdrop';
    const room = capacity - lay.placed.length;
    const items = v.tray.filter(t => t.category === shelf);
    $('tkItems').replaceChildren(...items.map(t => {
      const used = lay.placed.filter(p => p.ref === t.ref).length;
      const chosen = style && (lay.style[shelf] || (v.style[shelf]?.ref)) === t.ref;
      const left = t.max !== null ? t.max - used : null;
      const off = !!t.locked || (!style && (room <= 0 || left === 0));
      const meta = t.locked ? t.locked.text
        : style ? (chosen ? 'In the tank' : '')
          : left !== null ? (left ? `${left} left` : 'All in the tank') : used ? `${used} in the tank` : '';
      return h('button', {
        type: 'button', class: `tk-item${t.locked ? ' locked' : ''}${chosen ? ' chosen' : ''}`,
        disabled: off, 'aria-pressed': style ? String(chosen) : null,
        title: t.locked ? `Locked: ${t.locked.text}` : t.description,
        dataset: style ? { ref: t.ref, style: shelf, keep: `item:${t.ref}` } : { ref: t.ref, keep: `item:${t.ref}` },
      },
      h('span', { class: 'tk-thumb', 'aria-hidden': 'true' }, SB.tankPaint.thumb(t, THUMB)),
      h('span', { class: 'tk-item-name', text: t.name }),
      meta ? h('span', { class: 'tk-item-meta', text: meta }) : null,
      t.isNew && !t.locked && t.kind === 'decor' && !seen.has(t.ref) ? h('i', { class: 'dot-badge', 'aria-label': 'new' }) : null);
    }));
    $('tkItems').setAttribute('aria-label', list.find(c => c.id === shelf)?.name || 'Tray');
    return shelf;
  }

  function renderSettings({ v, draft }) {
    const lay = draft;
    $('tkSizes').replaceChildren(...v.sizes.map(s => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(s.id === lay.size), disabled: !s.unlocked,
      title: s.unlocked ? `${s.w} × ${s.h}, room for ${s.cap}` : `Grows into it at level ${s.level}${s.shipped ? ` with ${s.shipped} projects shipped` : ''}`,
      dataset: { size: s.id },
    }, s.name, s.unlocked ? null : h('span', { class: 'tk-lock', text: ` · L${s.level}` }))));
    $('tkLight').querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.light === lay.style.light)));
  }

  // ------------------------------------------------------------ on your calling card (tank-share.js)

  function renderShare({ v, state }) {
    const f = state.github?.features || {};
    const cards = !!(f.friends?.on || f.profileCard?.on);
    $('tkShare').checked = !!v.shareCard;
    $('tkShareHelp').textContent = !v.shareCard
      ? 'Your calling card and profile card show his outfit and his shell, not his tank. The crab card you share yourself (📸 Share) always shows it.'
      : !cards
        ? 'Visiting crabs and the profile card are both off (Settings → GitHub), so there’s no card for it to go on yet.'
        : 'They show its size, floor, back glass and up to 24 pieces: built-in decor and his finds. Specimen jars and decor from packs stay home.';
  }

  SB.tankRender = { listOf, rowName, renderHits, tag, renderTools, renderLife, renderTitle, renderKey, renderTray, renderSettings, renderShare };
})();
