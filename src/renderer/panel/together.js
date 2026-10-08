/* Shellby panel — Finds and Us, two tabs of Shellby's screen about the two of
   you, none of which needs Claude. Finds is the shelf of everything he's dug up
   (src/main/gifts.js); Us is how close you are, his temperament, games, your
   birthday, the scenes you've caught him in and the moments he remembers
   (bond.js, playtime.js, scenes.js). Main sends one view for both (life.js). */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const RARITY_ORDER = { legendary: 0, special: 1, rare: 2, uncommon: 3, common: 4 };
  let selected = null; // the find whose card is open
  let seenTimer = null;

  const life = () => state.life;
  const when = t => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  const { plural } = SB;
  const until = t => {
    const m = Math.max(1, Math.ceil((t - Date.now()) / 60000));
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
  };
  const clock = ms => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

  // A find's pixels, or its silhouette when it isn't on the shelf yet.
  function art(f, k, { owned = f.owned } = {}) {
    const palette = owned ? f.palette : Object.fromEntries(Object.keys(f.palette).map(c => [c, '#2b4650']));
    return SB.Sprite.grid(f.pixels, palette, { px: k });
  }
  const fit = (f, box) => Math.max(2, Math.floor(box / Math.max(f.pixels.length, ...f.pixels.map(r => r.length))));

  // ------------------------------------------------------------ Finds
  function renderFinds() {
    const v = life()?.finds;
    if (!v) return;
    $('fdTotal').textContent = v.kinds ? `${v.kinds} of ${v.of} finds${v.total > v.kinds ? ` · ${v.total} dug up` : ''}` : 'Nothing on the shelf yet';
    const fav = v.finds.find(f => f.id === v.favourite);
    $('fdFav').replaceChildren(fav
      ? h('div', { class: `fd-fav-art rarity-${fav.rarity}`, title: fav.name }, art(fav, fit(fav, 84)), h('span', { class: 'fd-fav-cap', text: 'showing off' }))
      : h('div', { class: 'fd-fav-art empty', 'aria-hidden': 'true' }, h('span', { text: '?' })));
    $('fdDig').disabled = !v.canDig;
    $('fdDigNote').textContent = v.canDig ? 'Ready when you are.' : `He can dig again in ${until(v.nextDigAt)}.`;

    $('fdSets').replaceChildren(...v.sets.map(set => h('li', { class: `fd-set${set.done ? ' done' : ''}`, title: set.members.map(id => v.finds.find(f => f.id === id)?.name).join(', ') },
      h('span', { class: 'fd-set-icon', 'aria-hidden': 'true', text: set.icon }),
      h('span', { class: 'fd-set-name', text: set.name }),
      h('span', { class: 'fd-set-dots', 'aria-label': `${set.have} of ${set.of}` }, set.members.map(id => h('i', { class: v.finds.find(f => f.id === id)?.owned ? 'on' : '' }))),
      set.done ? h('span', { class: 'fd-set-done', text: '✓' }) : null)));

    const unseen = new Set(v.unseen);
    const sorted = [...v.finds].sort((a, b) => (b.owned - a.owned) || RARITY_ORDER[a.rarity] - RARITY_ORDER[b.rarity]);
    $('fdGrid').replaceChildren(...sorted.map(f => h('li', {},
      h('button', {
        type: 'button', class: `fd-tile rarity-${f.rarity}${f.owned ? '' : ' locked'}${selected === f.id ? ' on' : ''}`,
        'aria-label': f.owned ? `${f.name}, ${f.rarityLabel}${f.count > 1 ? `, ${f.count} of them` : ''}` : `Not found yet. ${f.blurb}`,
        onclick: () => select(f.id),
      },
      h('span', { class: 'fd-art' }, art(f, fit(f, 40))),
      h('span', { class: 'fd-name', text: f.name }),
      h('span', { class: 'fd-rarity', text: f.owned ? f.rarityLabel : f.special ? 'Keepsake' : f.season ? 'Seasonal' : f.night ? 'Night only' : '' }),
      f.count > 1 ? h('span', { class: 'fd-count-pill', text: `×${f.count}` }) : null,
      unseen.has(f.id) ? h('span', { class: 'new-pill', text: 'new' }) : null))));
    renderDetail();
  }

  function renderDetail() {
    const v = life()?.finds;
    const f = v?.finds.find(x => x.id === selected);
    const box = $('fdDetail');
    if (!f) { box.hidden = true; box.replaceChildren(); return; }
    const set = v.sets.find(s => s.id === f.set);
    const isFav = v.favourite === f.id;
    box.hidden = false;
    box.className = `fd-detail rarity-${f.rarity}`;
    box.replaceChildren(
      h('div', { class: 'fd-big' }, art(f, fit(f, 110))),
      h('div', { class: 'fd-info' },
        h('p', { class: 'fd-rarity-line', text: f.owned ? f.rarityLabel : 'Not found yet' }),
        h('h3', { text: f.name }),
        h('p', { class: 'fd-blurb', text: f.blurb }),
        f.owned ? h('p', { class: 'fd-when', text: `First found ${when(f.first)}${f.count > 1 ? ` · found ${plural(f.count, 'time')}` : ''}` }) : null,
        set ? h('p', { class: 'fd-in-set', text: `Part of ${set.icon} ${set.name} (${set.have} of ${set.of})` }) : null,
        f.owned ? h('div', { class: 'fd-actions' },
          isFav
            ? h('button', { type: 'button', class: 'btn ghost slim-btn', onclick: () => favourite(null) }, '★ His favourite (let him choose)')
            : h('button', { type: 'button', class: 'btn primary slim-btn', onclick: () => favourite(f.id) }, 'Make this his favourite')) : null),
      h('button', { type: 'button', class: 'icon-btn fd-close', 'aria-label': 'Close', onclick: () => select(null) }, '×'));
  }

  function select(id) {
    selected = selected === id ? null : id;
    renderFinds();
  }

  async function favourite(id) {
    apply(await api.setFavouriteFind(id));
    SB.toast(id ? 'He’ll show that one off, and take it when he visits friends.' : 'He’ll pick his own favourite again.');
  }

  // ------------------------------------------------------------ Us
  // The hero is a little diorama: him on the sand at the tide line, under a sky
  // that follows your clock. What he's unlocked shows up in it (hearts drawn in
  // the sand, his favourite find beside him). It's patched, not rebuilt, so his
  // breathing and the waves don't restart every time life sends an update.
  const PIX = {
    drawn: ['.11.11.', '1..1..1', '1.....1', '.1...1.', '..1.1..', '...1...'],
    heart: ['.11.11.', '1221111', '1211111', '.11111.', '..111..', '...1...'],
    orb: ['..1111..', '.111111.', '11121111', '11111211', '11211111', '11111111', '.111121.', '..1111..'],
  };
  const ORB = { night: ['#f3e6cc', '#cdbf9f'], dawn: ['#ff9a6b', '#ffc39e'], day: ['#ffc15e', '#ffe0a3'], dusk: ['#ff7a5c', '#ffb08f'] };
  const HEARTS_AT = 3;     // bond.js UNLOCKS: he draws you hearts in the sand
  const SHOWS_FIND_AT = 2; // ...and shows off his favourite find
  const GOLDEN_AT = 5;     // ...and golden hearts when you pet him
  const MAX_POPS = 6;
  let crabKey = null, propsKey = null;

  const timeOfDay = (hour = new Date().getHours()) => (hour >= 21 || hour < 5 ? 'night' : hour < 8 ? 'dawn' : hour < 17 ? 'day' : 'dusk');
  const pix = (rows, a, b, px) => SB.Sprite.grid(rows, { 1: a, 2: b || a }, { px });

  function renderStage(v) {
    const b = v.bond;
    const stage = $('usStage');
    const time = timeOfDay();
    if (stage.dataset.time !== time || !$('usOrb').firstChild) {
      stage.dataset.time = time;
      $('usOrb').replaceChildren(pix(PIX.orb, ...ORB[time], 3));
    }
    const look = `${state.skin?.name}|${JSON.stringify(state.outfit || {})}`;
    if (look !== crabKey && state.skin) { crabKey = look; $('usCrab').replaceChildren(SB.sprite()); }

    const fav = b.level.index >= SHOWS_FIND_AT ? v.finds.finds.find(f => f.id === v.finds.favourite && f.owned) : null;
    const key = `${b.level.index}|${fav?.id || ''}`;
    if (key === propsKey) return;
    propsKey = key;
    const hearts = b.level.index >= HEARTS_AT ? [['h1', 3], ['h2', 2]].map(([cls, px]) => h('span', { class: `us-drawn ${cls}` }, pix(PIX.drawn, 'currentColor', null, px))) : [];
    $('usProps').replaceChildren(...hearts, fav ? h('span', { class: `us-fav rarity-${fav.rarity}`, title: `${fav.name}, his favourite` }, art(fav, fit(fav, 30))) : '');
  }

  // A heart floats up from him; main counts the pet (and ignores spam).
  function pet() {
    api.critter.pet();
    const crab = $('usCrab');
    crab.classList.remove('petted');
    void crab.offsetWidth; // restart the hop
    crab.classList.add('petted');
    const pops = $('usPops');
    if (pops.childElementCount >= MAX_POPS) return;
    const gold = (life()?.bond.level.index ?? 0) >= GOLDEN_AT;
    const pop = h('span', { class: 'us-pop', style: `--dx:${Math.round(Math.random() * 36 - 18)}px` },
      pix(PIX.heart, gold ? '#ffd23f' : '#ff8fab', gold ? '#fff2b8' : '#ffd1dc', 3));
    pop.addEventListener('animationend', () => pop.remove());
    pops.append(pop);
  }

  function renderBond(v) {
    const b = v.bond;
    const t = v.temperament;
    const last = b.levels.length - 1;
    $('usLevelName').textContent = b.level.name;
    $('usSub').textContent = [b.days ? `${plural(b.days, 'day')} together` : 'Your first day together', b.hatchedAt ? `moved in ${when(b.hatchedAt)}` : null].filter(Boolean).join(' · ');

    const path = $('usPath');
    path.style.setProperty('--fill', String(Math.min(1, (b.level.index + b.level.progress) / last)));
    path.setAttribute('aria-valuenow', String(Math.round(b.level.progress * 100)));
    path.setAttribute('aria-valuetext', b.level.next != null ? `${b.level.name}, ${Math.round(b.level.progress * 100)}% of the way to ${b.levels[b.level.index + 1].name}` : b.level.name);
    path.replaceChildren(...b.levels.map((l, i) => h('li', { class: `us-stone${l.reached ? ' reached' : ''}${i === b.level.index ? ' here' : ''}`, style: `--at:${i / last}` },
      h('span', { class: 'us-stone-icon', 'aria-hidden': 'true', text: l.icon }),
      h('span', { class: 'us-stone-name', text: l.name }))));

    const next = b.level.next != null ? `${(b.level.next - b.level.points).toLocaleString()} to ${b.levels[b.level.index + 1].name}` : 'As close as it gets';
    $('usNext').textContent = b.nextMilestone ? `${next} · ${b.nextMilestone - b.days} days to ${b.nextMilestone} together` : next;
    $('usTemper').replaceChildren(
      h('span', { class: 'us-temper-emoji', 'aria-hidden': 'true', text: t.emoji }),
      h('span', {}, h('b', { text: `Your crab is ${t.name.toLowerCase()}.` }), ' ', t.blurb, h('span', { class: 'us-faint', text: ' Every crab is one of four, picked when he moved in, and he stays that way.' })));
  }

  function renderPlay(v) {
    const p = v.play;
    const playing = !!p?.playing;
    document.querySelectorAll('.us-play [data-play]').forEach(btn => {
      const k = btn.dataset.play;
      if (k === 'stop') { btn.hidden = !playing; return; }
      btn.disabled = playing || (k === 'dig' && !v.finds.canDig);
    });
    $('usStatHide').textContent = p?.hide.games ? `Found him ${plural(p.hide.found, 'time')}${p.hide.best ? `, best ${clock(p.hide.best)}` : ''}${p.hide.won ? `. He won ${p.hide.won}.` : ''}` : 'He hides behind your windows';
    $('usStatFetch').textContent = p?.fetch.fetched ? `${plural(p.fetch.fetched, 'fetch', 'fetches')}${p.fetch.longest ? `, longest ${p.fetch.longest.toLocaleString()} px` : ''}` : 'Throw him a pebble';
    $('usStatDig').textContent = !v.finds.canDig ? `He can dig again in ${until(v.finds.nextDigAt)}` : v.finds.total ? `${plural(v.finds.total, 'find')} dug up` : 'See what turns up';
  }

  function renderUnlocks(b) {
    $('usUnlocks').replaceChildren(...b.unlocks.map(u => h('li', { class: `us-unlock${u.open ? ' open' : ''}` },
      h('span', { class: 'us-unlock-icon', 'aria-hidden': 'true', text: b.levels[u.level].icon }),
      h('span', { class: 'us-unlock-text' }, u.text),
      h('span', { class: 'us-unlock-at', text: u.open ? `${u.levelName} ✓` : `at ${u.levelName}` }))));
  }

  function renderScenes(s) {
    $('usScenesCount').textContent = `${s.seen} of ${s.of} caught`;
    $('usScenes').style.setProperty('--seen', String(s.of ? s.seen / s.of : 0));
    $('usScenes').replaceChildren(...s.list.map(x => h('li', x.name ? { class: 'seen', text: x.name } : { 'aria-label': 'Not caught yet', text: '?' })));
  }

  // Newest first, with the month marked where it changes.
  function renderStory(journal) {
    if (!journal.length) {
      $('usStory').replaceChildren(h('li', { class: 'us-story-empty', text: 'Nothing yet. Click him up there to give him a pet.' }));
      return;
    }
    const monthOf = t => new Date(t).toLocaleDateString([], { month: 'long', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
    $('usStory').replaceChildren(...journal.map((e, i) => {
      const month = monthOf(e.at);
      return h('li', { class: i === 0 ? 'latest' : '' },
        month !== (i && monthOf(journal[i - 1].at)) ? h('span', { class: 'us-story-month', text: month }) : null,
        h('span', { class: 'us-story-icon', 'aria-hidden': 'true', text: e.icon }),
        h('span', { class: 'us-story-text', text: e.text }),
        h('time', { datetime: new Date(e.at).toISOString(), text: when(e.at) }));
    }));
  }

  function renderUs() {
    const v = life();
    if (!v) return;
    renderStage(v);
    renderBond(v);
    SB.renderNeeds?.(v); // How he's doing (needs.js)
    renderPlay(v);
    renderUnlocks(v.bond);
    renderBirthday(v.bond.birthday);
    renderScenes(v.scenes);
    renderStory(v.bond.journal);
  }

  // How long until the next one, counted in whole days.
  function birthdayIn(bd) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    let next = new Date(today.getFullYear(), bd.m - 1, bd.d);
    if (next < today) next = new Date(today.getFullYear() + 1, bd.m - 1, bd.d);
    return Math.round((next - today) / 86400000);
  }

  function renderBirthday(bd) {
    const n = bd ? birthdayIn(bd) : null;
    $('usBdWhen').textContent = bd ? `🎂 ${bd.d} ${MONTHS[bd.m - 1]} · ${n === 0 ? 'today!' : n === 1 ? 'tomorrow' : `in ${n} days`}` : '';
    const m = $('usBdMonth'), d = $('usBdDay');
    if (!m.options.length) {
      m.append(h('option', { value: '' }, 'Month'), ...MONTHS.map((name, i) => h('option', { value: String(i + 1) }, name)));
      m.addEventListener('change', () => fillDays());
    }
    if (document.activeElement !== m && document.activeElement !== d) {
      m.value = bd ? String(bd.m) : '';
      fillDays(bd?.d);
    }
    $('usBdForget').hidden = !bd;
    $('usBdSave').textContent = bd ? 'Change' : 'Save';
  }

  function fillDays(pick = Number($('usBdDay').value) || null) {
    const m = Number($('usBdMonth').value);
    const n = m ? new Date(2024, m, 0).getDate() : 31; // 2024: a leap year, so 29 February is there
    $('usBdDay').replaceChildren(h('option', { value: '' }, 'Day'), ...Array.from({ length: n }, (_, i) => h('option', { value: String(i + 1) }, String(i + 1))));
    if (pick && pick <= n) $('usBdDay').value = String(pick);
  }

  // ------------------------------------------------------------ data in
  function apply(v) {
    if (!v) return;
    state.life = v;
    document.querySelectorAll('.fd-count').forEach(el => { el.textContent = v.finds.kinds ? String(v.finds.kinds) : ''; });
    document.querySelectorAll('.fd-badge').forEach(el => { el.hidden = !v.finds.unseen.length; });
    SB.refreshShellbyBadge?.();
    if (state.view === 'finds') renderFinds();
    if (state.view === 'us') renderUs();
  }
  SB.applyLife = apply;
  SB.play = kind => play(kind); // the command palette's games (nav.js)

  // Looking at the shelf counts as seeing what's new on it, after a moment to notice.
  function noticeFinds() {
    clearTimeout(seenTimer);
    if (!life()?.finds.unseen.length) return;
    seenTimer = setTimeout(() => { if (state.view === 'finds') api.findsSeen(); }, 2500);
  }

  // ------------------------------------------------------------ wiring
  $('fdDig').addEventListener('click', () => play('dig'));
  document.querySelectorAll('.us-play [data-play]').forEach(b => b.addEventListener('click', () => play(b.dataset.play)));
  $('usCrab').addEventListener('click', pet);
  async function play(kind) {
    const r = await api.play(kind);
    if (!r?.ok) return SB.toast(r?.error || 'He can’t right now.');
    if (kind === 'hide') SB.toast('Close your eyes… he’s hiding behind your windows. Click him when you find him.', { ms: 5000 });
    if (kind === 'fetch') SB.toast('A pebble’s next to him on the desktop. Drag it and throw it.', { ms: 5000 });
    if (kind === 'dig') SB.toast('He’s digging…');
    if (kind !== 'stop' && kind !== 'dig') outOfTheWay();
  }
  // The game is on your desktop, so the panel gets out of the way, but only once
  // the toast above has been read: hiding at once took the how-to-play with it.
  // Reaching back into the panel meanwhile means you want it, so it stays.
  const READ_MS = 2500;
  function outOfTheWay() {
    const keep = () => clearTimeout(t);
    const t = setTimeout(() => { document.removeEventListener('pointerdown', keep, true); api.hide(); }, READ_MS);
    document.addEventListener('pointerdown', keep, { capture: true, once: true });
  }
  $('usBdSave').addEventListener('click', async () => {
    const m = Number($('usBdMonth').value), d = Number($('usBdDay').value);
    if (!m || !d) return SB.toast('Pick a month and a day.');
    apply(await api.setBirthday({ m, d }));
    SB.toast(`Got it: ${d} ${MONTHS[m - 1]}. He won’t forget.`);
  });
  $('usBdForget').addEventListener('click', async () => { apply(await api.setBirthday(null)); SB.toast('Forgotten.'); });

  api.onLife(apply);

  // He dug something up: a toast, or a proper card for a first rare one.
  api.onLifeFound(f => {
    if (!f) return;
    api.getLife().then(apply);
    const big = f.isNew && (f.rarity === 'rare' || f.rarity === 'legendary');
    if (big) {
      SB.celebrate({
        eyebrow: f.rarity === 'legendary' ? 'Legendary find' : 'Rare find', icon: f.rarity === 'legendary' ? '🏴‍☠️' : '✨', title: f.name, text: f.blurb,
        rewards: [{ name: f.name, pixels: f.pixels, palette: f.palette, kind: 'find' }],
        action: { label: 'See the shelf', run: () => { selected = f.id; SB.setView('finds'); } },
      });
    } else {
      SB.toast(`He found you ${/^[aeiou]/i.test(f.name) ? 'an' : 'a'} ${f.name.toLowerCase()}${f.isNew ? ' (new!)' : ''}`, { action: 'Finds', ms: 4500, onAction: () => { selected = f.id; SB.setView('finds'); } });
    }
  });

  // A day worth marking, a closer bond, a finished set.
  api.onLifeMoment(m => {
    if (!m?.title) return;
    api.getLife().then(apply);
    SB.celebrate({
      eyebrow: m.eyebrow, icon: m.icon, title: m.title, text: m.text,
      rewards: m.find ? [{ name: m.find.name, pixels: m.find.pixels, palette: m.find.palette, kind: 'find' }] : [],
      action: { label: 'Open', run: () => SB.setView(m.find ? 'finds' : 'us') },
    });
  });

  SB.views.finds = { render: () => { renderFinds(); noticeFinds(); api.getLife().then(v => { apply(v); noticeFinds(); }); } };
  SB.views.us = { render: () => { renderUs(); api.getLife().then(apply); } };
  api.getLife().then(apply);
})();
