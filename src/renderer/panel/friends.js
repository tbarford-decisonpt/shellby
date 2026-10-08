/* Shellby panel — Settings → GitHub → Visiting crabs: add friends by GitHub
   username, have their crab over, wave, and keep a guestbook of who dropped by. */
'use strict';
(function () {
  const { h, api, $ } = SB;
  let view = null;
  // Tide events' emoji, for the medals on a friend's row (src/main/events.js).
  const MEDAL_EMOJI = { harvest: '🌾', haunting: '🎃', frostbite: '❄️', penpal: '💌', 'spring-clean': '🌸', 'low-tide': '🌊' };

  const crab = look => {
    const svg = window.ShellbySprite.build(look.skin, { px: 2, accessories: look.accessories || [], shell: look.shell || undefined, stickers: look.stickers || [], fit: true });
    svg.classList.add('fr-crab');
    return svg;
  };
  const keepsake = s => {
    const svg = window.ShellbySprite.grid(s.pixels, s.palette, { px: 3 });
    svg.classList.add('fr-keepsake');
    return svg;
  };

  // ------------------------------------------------------------ peek at their tank (tank-share.js)

  const PEEK_W = 360;        // css px, the most a friend's tank is drawn across
  const peeking = new Set(); // lowercased logins whose tank is open, kept across re-renders
  const drawn = new Map();   // lowercased login -> the last picture of their tank, so a re-render doesn't blank it
  const peekId = login => `frPeek-${login.toLowerCase()}`;

  // Their crab, standing in his own tank: art pixels, like the tank's.
  async function guest(look, world) {
    if (!look || !SB.cardKit) return null;
    try {
      const svg = window.ShellbySprite.build(look.skin, { accessories: look.accessories || [], shell: look.shell || undefined, stickers: look.stickers || [], fit: true });
      const [, , vw, vh] = (svg.getAttribute('viewBox') || '0 0 22 13').split(' ').map(Number);
      const w = Math.ceil(vw), hh = Math.ceil(vh);
      return { img: await SB.cardKit.svgImage(svg, w, hh), w, h: hh, x: Math.max(0, Math.round(world.w * 0.55 - w / 2)), flip: true };
    } catch {
      return null; // their tank still stands without him
    }
  }

  // What's in it, in words: the canvas is only a picture.
  function describe(login, v) {
    const counts = new Map();
    for (const p of v.pieces) counts.set(p.name, (counts.get(p.name) || 0) + 1);
    const names = [...counts].map(([name, n]) => (n > 1 ? `${n} × ${name}` : name));
    const list = names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
    const stranger = v.strangers ? ` ${v.strangers === 1 ? 'One piece isn’t' : `${v.strangers} pieces aren’t`} in your Shellby yet, so ${v.strangers === 1 ? 'it’s' : 'they’re'} drawn as a rock.` : '';
    return `@${login}’s ${v.size.name.toLowerCase()}: ${list || 'nothing in it yet'}.${stranger}`;
  }

  async function fillPeek(region, f) {
    const key = f.login.toLowerCase();
    // What was there last time stays up while it's redrawn; the first time, a word.
    region.replaceChildren(...(drawn.get(key) || [h('p', { class: 'small muted', text: 'Looking in…' })]));
    const r = await api.peekTank(f.login).catch(() => null);
    if (!r?.ok) {
      drawn.delete(key);
      region.replaceChildren(h('p', { class: 'small muted', text: r?.error || 'Couldn’t open their tank. Try again in a moment.' }));
      return;
    }
    const v = r.view;
    const pic = SB.tankPaint.still({ world: v.world, style: v.style, pieces: v.pieces }, await guest(f.look, v.world));
    const dpr = window.devicePixelRatio || 1;
    const K = Math.max(1, Math.floor((PEEK_W * dpr) / v.world.w));
    const canvas = h('canvas', { class: 'fr-peek-tank', role: 'img', 'aria-label': `@${f.login}’s tank`, 'aria-describedby': `${region.id}-text` });
    canvas.width = v.world.w * K;
    canvas.height = v.world.h * K;
    canvas.style.width = `${(v.world.w * K) / dpr}px`;
    const g = canvas.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(pic, 0, 0, canvas.width, canvas.height);
    const nodes = [canvas, h('p', { class: 'small muted', id: `${region.id}-text`, text: describe(f.login, v) })];
    drawn.set(key, nodes);
    region.replaceChildren(...nodes);
  }

  function togglePeek(f, btn, region) {
    const open = region.hidden;
    region.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) { peeking.add(f.login.toLowerCase()); fillPeek(region, f); } else peeking.delete(f.login.toLowerCase());
  }

  function friendRow(f) {
    const seen = f.card?.updatedAt ? `around ${SB.relTime(f.card.updatedAt)}` : '';
    const status = !f.card ? "No calling card yet. They'll need Visiting crabs on." : [`Level ${f.card.level}`, seen].filter(Boolean).join(' · ');
    const waves = h('select', { class: 'field fr-wave', 'aria-label': `Wave to @${f.login}`, disabled: !f.card },
      ...view.waves.map(w => h('option', { value: w.id, text: w.text })));
    const hasTank = !!f.card?.tank;
    const open = hasTank && peeking.has(f.login.toLowerCase());
    const region = h('div', { class: 'fr-peek', id: peekId(f.login), hidden: !open });
    const peekBtn = hasTank ? h('button', {
      type: 'button', class: 'btn ghost slim-btn', 'aria-expanded': String(open), 'aria-controls': region.id, 'aria-label': `Peek at @${f.login}’s tank`,
      onclick: e => togglePeek(f, e.currentTarget, region),
    }, 'Peek at their tank') : null;
    if (open) fillPeek(region, f);
    const swap = SB.social?.swapFor(f) || null;
    const medals = (f.card?.medals || []).slice(-6).map(k => k.split('@')).map(([id, y]) => `${MEDAL_EMOJI[id] || '🏅'}${y.slice(2)}`).join(' ');
    return h('li', { class: 'fr-friend' },
      f.look ? crab(f.look) : h('span', { class: 'fr-crab fr-crab-none', 'aria-hidden': 'true', text: '?' }),
      h('div', { class: 'fr-who' }, h('b', { text: `@${f.login}` }), h('span', { class: 'small muted', text: status }), medals ? h('span', { class: 'small fr-medals', title: 'Tide event medals', text: medals }) : null),
      h('div', { class: 'fr-actions' },
        h('button', { type: 'button', class: 'btn ghost slim-btn', disabled: !f.card, onclick: () => invite(f.login) }, 'Invite over'),
        waves,
        h('button', { type: 'button', class: 'btn ghost slim-btn', disabled: !f.card, onclick: e => wave(f.login, waves.value, e.currentTarget) }, 'Wave'),
        peekBtn,
        swap?.btn || null,
        h('button', { type: 'button', class: 'btn ghost slim-btn fr-remove', 'aria-label': `Remove @${f.login}`, onclick: () => remove(f.login) }, '×')),
      region,
      swap?.region || null);
  }

  function render(v) {
    if (!v) return;
    view = v;
    $('ghFriendsRow').hidden = !v.enabled;
    if (!v.enabled) return;
    const n = v.friends.length;
    $('frStatus').textContent = v.refreshing ? 'Checking on your friends…'
      : v.error || (v.visiting ? `@${v.visiting.login} is visiting right now.`
        : `${n ? `${n} friend${n === 1 ? '' : 's'}` : 'No friends added yet'}. Your crab's calling card is public as @${v.me || '?'}.`);
    $('frStatus').classList.toggle('bad', !!v.error && !v.refreshing);
    $('frRefresh').disabled = !!v.refreshing;
    $('frList').replaceChildren(...v.friends.map(friendRow));

    $('frInboxHead').hidden = !v.inbox.length;
    $('frInbox').replaceChildren(...v.inbox.slice(0, 6).map(m =>
      h('li', {}, h('b', { text: `@${m.from}` }), ` ${m.text}`, h('span', { class: 'small muted', text: ` · ${SB.relTime(m.at)}` }))));

    const got = v.souvenirs.filter(s => s.count);
    $('frSouvenirs').replaceChildren(...(got.length
      ? got.map(s => h('span', { class: 'fr-souvenir', title: `${s.name} ×${s.count}` }, keepsake(s), s.count > 1 ? h('i', { text: `×${s.count}` }) : null))
      : [h('p', { class: 'small muted', text: 'Every visitor leaves a little something. Nobody has dropped by yet.' })]));
    const byId = new Map(v.souvenirs.map(s => [s.id, s]));
    $('frGuestbook').replaceChildren(...v.guestbook.slice(0, 8).map(g =>
      h('li', {}, keepsake(byId.get(g.souvenir)), h('span', {}, h('b', { text: `@${g.login}` }), ` dropped by and left ${byId.get(g.souvenir).name.toLowerCase()}`),
        h('span', { class: 'small muted', text: ` · ${SB.relTime(g.at)}` }))));
  }

  const toastResult = (r, ok) => SB.toast(r.ok ? ok : r.error || 'That didn\'t work.', { ms: r.ok ? 3000 : 6000 });

  async function invite(login) {
    const r = await api.friendsInvite(login);
    toastResult(r, `@${login}'s crab is on the way.`);
  }
  async function wave(login, waveId, btn) {
    btn.disabled = true;
    const r = await api.friendsWave(login, waveId);
    btn.disabled = false;
    toastResult(r, `Waved at @${login}.`);
  }
  async function remove(login) {
    const r = await api.friendsRemove(login);
    render(r.view);
  }

  $('frAddForm').addEventListener('submit', async e => {
    e.preventDefault();
    const input = $('frAddInput');
    if (!input.value.trim()) return;
    $('frAdd').disabled = true;
    const r = await api.friendsAdd(input.value);
    $('frAdd').disabled = false;
    if (r.view) render(r.view);
    if (r.ok) input.value = '';
    toastResult(r, r.hasCard ? 'Friend added. Their crab may drop by when he\'s free.' : "Friend added. They haven't turned on Visiting crabs yet, so there's no crab to visit.");
  });
  $('frRefresh').addEventListener('click', async () => {
    const r = await api.friendsRefresh();
    if (r.view) render(r.view);
    if (!r.ok && r.error) SB.toast(r.error, { ms: 6000 });
  });
  api.onFriends(render);

  SB.friends = { render, load: () => api.getFriends().then(render) };
  SB.friends.load();
})();
