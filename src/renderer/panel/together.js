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
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
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
  function renderUs() {
    const v = life();
    if (!v) return;
    const b = v.bond;
    const t = v.temperament;
    const next = b.level.next != null ? `${b.level.next - b.level.points} to ${b.levels[b.level.index + 1].name}` : 'As close as it gets';
    $('usHero').replaceChildren(
      h('div', { class: 'us-level' },
        h('span', { class: 'us-level-icon', 'aria-hidden': 'true', text: b.level.icon }),
        h('div', {},
          h('p', { class: 'xp-eyebrow us-eyebrow', text: 'You and Shellby' }),
          h('h3', { text: b.level.name }),
          h('p', { class: 'us-sub', text: [b.days ? `${plural(b.days, 'day')} together` : 'Your first day together', b.hatchedAt ? `moved in ${when(b.hatchedAt)}` : null].filter(Boolean).join(' · ') }))),
      h('div', { class: 'xp-bar us-bar', role: 'progressbar', 'aria-label': 'How close you are', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(b.level.progress * 100)) },
        h('i', { style: `transform:scaleX(${b.level.progress.toFixed(3)})` })),
      h('p', { class: 'us-next', text: b.nextMilestone ? `${next} · ${b.nextMilestone - b.days} days to ${b.nextMilestone} together` : next }),
      h('div', { class: 'us-temper' },
        h('span', { class: 'us-temper-emoji', 'aria-hidden': 'true', text: t.emoji }),
        h('p', {}, h('b', { text: `Your crab is ${t.name.toLowerCase()}.` }), ' ', t.blurb, h('span', { class: 'muted', text: ' Every crab is one of four, picked when he first moved in, and he stays that way.' }))));

    const p = v.play;
    const playing = p?.playing;
    document.querySelectorAll('.us-play [data-play]').forEach(btn => {
      const k = btn.dataset.play;
      btn.hidden = k === 'stop' ? !playing : !!playing;
      if (k === 'dig') { btn.disabled = !v.finds.canDig; btn.title = v.finds.canDig ? '' : `Again in ${until(v.finds.nextDigAt)}`; }
    });
    const scores = [];
    if (p?.hide.games) scores.push(`🙈 Found him ${plural(p.hide.found, 'time')}${p.hide.best ? `, best ${clock(p.hide.best)}` : ''}${p.hide.won ? ` · he won ${p.hide.won}` : ''}`);
    if (p?.fetch.fetched) scores.push(`🎾 Fetched ${plural(p.fetch.fetched, 'time')}${p.fetch.longest ? `, longest throw ${p.fetch.longest.toLocaleString()} px` : ''}`);
    if (v.finds.total) scores.push(`🐚 ${plural(v.finds.total, 'find')} dug up`);
    $('usScores').replaceChildren(...scores.map(s => h('li', { text: s })));

    renderBirthday(b.birthday);

    $('usUnlocks').replaceChildren(...b.unlocks.map(u => h('li', { class: u.open ? 'open' : '' },
      h('span', { class: 'us-lock', 'aria-hidden': 'true', text: u.open ? '✓' : '🔒' }),
      h('span', {}, h('b', { text: u.levelName }), ' ', u.text))));

    $('usScenesTitle').textContent = `His little scenes · ${v.scenes.seen} of ${v.scenes.of}`;
    $('usScenes').replaceChildren(...v.scenes.list.map(s => h('li', { class: s.name ? 'seen' : '', text: s.name || '???' })));

    const story = b.journal;
    $('usStory').replaceChildren(...(story.length ? story.map(e => h('li', {},
      h('span', { class: 'us-story-icon', 'aria-hidden': 'true', text: e.icon }),
      h('span', { class: 'us-story-text', text: e.text }),
      h('time', { datetime: new Date(e.at).toISOString(), text: when(e.at) }))) : [h('li', { class: 'muted', text: 'Nothing yet. Give him a pet.' })]));
  }

  function renderBirthday(bd) {
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

  // Looking at the shelf counts as seeing what's new on it, after a moment to notice.
  function noticeFinds() {
    clearTimeout(seenTimer);
    if (!life()?.finds.unseen.length) return;
    seenTimer = setTimeout(() => { if (state.view === 'finds') api.findsSeen(); }, 2500);
  }

  // ------------------------------------------------------------ wiring
  $('fdDig').addEventListener('click', () => play('dig'));
  document.querySelectorAll('.us-play [data-play]').forEach(b => b.addEventListener('click', () => play(b.dataset.play)));
  async function play(kind) {
    const r = await api.play(kind);
    if (!r?.ok) return SB.toast(r?.error || 'He can’t right now.');
    if (kind === 'hide') SB.toast('Close your eyes… he’s hiding behind your windows. Click him when you find him.', { ms: 5000 });
    if (kind === 'fetch') SB.toast('A pebble’s next to him on the desktop. Drag it and throw it.', { ms: 5000 });
    if (kind === 'dig') SB.toast('He’s digging…');
    if (kind !== 'stop' && kind !== 'dig') api.hide(); // out of the way: the game is on your desktop
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
