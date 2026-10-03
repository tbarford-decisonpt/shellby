/* Shellby panel — Settings → GitHub → Visiting crabs: add friends by GitHub
   username, have their crab over, wave, and keep a guestbook of who dropped by. */
'use strict';
(function () {
  const { h, api, $ } = SB;
  let view = null;

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

  function friendRow(f) {
    const seen = f.card?.updatedAt ? `around ${SB.relTime(f.card.updatedAt)}` : '';
    const status = !f.card ? "No calling card yet. They'll need Visiting crabs on." : [`Level ${f.card.level}`, seen].filter(Boolean).join(' · ');
    const waves = h('select', { class: 'field fr-wave', 'aria-label': `Wave to @${f.login}`, disabled: !f.card },
      ...view.waves.map(w => h('option', { value: w.id, text: w.text })));
    return h('li', { class: 'fr-friend' },
      f.look ? crab(f.look) : h('span', { class: 'fr-crab fr-crab-none', 'aria-hidden': 'true', text: '?' }),
      h('div', { class: 'fr-who' }, h('b', { text: `@${f.login}` }), h('span', { class: 'small muted', text: status })),
      h('div', { class: 'fr-actions' },
        h('button', { type: 'button', class: 'btn ghost slim-btn', disabled: !f.card, onclick: () => invite(f.login) }, 'Invite over'),
        waves,
        h('button', { type: 'button', class: 'btn ghost slim-btn', disabled: !f.card, onclick: e => wave(f.login, waves.value, e.currentTarget) }, 'Wave'),
        h('button', { type: 'button', class: 'btn ghost slim-btn fr-remove', 'aria-label': `Remove @${f.login}`, onclick: () => remove(f.login) }, '×')));
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
