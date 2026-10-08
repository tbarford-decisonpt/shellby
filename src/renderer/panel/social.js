/* Shellby panel — swaps with friends (src/main/swaps.js) and crab eggs
   (src/main/eggs.js). Swaps live under Settings → GitHub → Visiting crabs: a
   Swap… button on each friend, the offers waiting either way, the last few
   done. Eggs live on the Us page: lay one, send its code, hatch one you were
   sent, and the clutch of babies. Main sends the whole view ('social');
   nothing here is ever put in as HTML. */
'use strict';
(function () {
  const { h, api, state, $, plural } = SB;
  const DOWNLOAD = 'https://github.com/x-salmon/shellby/releases/latest';
  const picking = new Map(); // lowercased login -> { theirs, mine } chosen in an open picker

  const v = () => state.social;
  const art = (a, px = 3) => (a?.pixels?.length && a.palette ? SB.Sprite.grid(a.pixels, a.palette, { px }) : null);
  const toast = (r, ok) => SB.toast(r?.ok ? ok : r?.error || 'That didn’t work.', { ms: r?.ok ? 3500 : 6500 });
  const itemChip = (it, extra = null) => h('span', { class: `sw-item rarity-${it.rarity}${it.shiny ? ' sparkly' : ''}`, title: it.name }, art(it, 3), h('span', { text: it.name }), extra);

  // ------------------------------------------------------------ swaps

  /** The Swap… button and its picker, for a friend's row (friends.js). */
  function swapFor(f) {
    if (!f.card?.swap) return null;
    const key = f.login.toLowerCase();
    const region = h('div', { class: 'sw-picker', id: `swPick-${key}`, hidden: !picking.has(key) });
    const btn = h('button', {
      type: 'button', class: 'btn ghost slim-btn', 'aria-expanded': String(picking.has(key)), 'aria-controls': region.id,
      onclick: () => togglePicker(f, btn, region),
    }, 'Swap…');
    if (picking.has(key)) fillPicker(f, region);
    return { btn, region };
  }

  function togglePicker(f, btn, region) {
    const key = f.login.toLowerCase();
    const open = region.hidden;
    region.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) { picking.set(key, picking.get(key) || {}); fillPicker(f, region); } else picking.delete(key);
  }

  async function fillPicker(f, region) {
    region.replaceChildren(h('p', { class: 'small muted', text: 'Looking at what you could swap…' }));
    const r = await api.swapOptions(f.login).catch(() => null);
    if (!r?.ok) { region.replaceChildren(h('p', { class: 'small muted', text: r?.error || 'Couldn’t look just now.' })); return; }
    const key = f.login.toLowerCase();
    const pick = picking.get(key) || {};
    const choice = (list, side) => h('ul', { class: 'sw-choices', role: 'radiogroup', 'aria-label': side === 'theirs' ? `What @${f.login} would swap` : 'What you could swap' },
      list.map(it => {
        const on = pick[side] && pick[side].id === it.id && pick[side].shiny === it.shiny;
        const note = side === 'theirs'
          ? (it.finishes ? `finishes ${it.finishes}!` : it.haveIt ? 'you have one' : 'new to you')
          : (it.wanted ? 'they’re after this' : '');
        return h('li', {}, h('button', {
          type: 'button', role: 'radio', 'aria-checked': String(!!on), class: `sw-choice${on ? ' on' : ''}${it.finishes ? ' finishes' : ''}${it.wanted ? ' wanted' : ''}`,
          onclick: () => { picking.set(key, { ...pick, [side]: { id: it.id, shiny: it.shiny } }); fillPicker(f, region); },
        }, itemChip(it), note ? h('small', { text: note }) : null));
      }));
    const ready = pick.theirs && pick.mine;
    region.replaceChildren(
      h('div', { class: 'sw-cols' },
        h('div', {}, h('h5', { text: `@${f.login} would swap` }), r.theirs.length ? choice(r.theirs, 'theirs') : h('p', { class: 'small muted', text: 'Nothing spare on their shelf right now.' })),
        h('div', {}, h('h5', { text: 'You could swap' }), r.mine.length ? choice(r.mine, 'mine') : h('p', { class: 'small muted', text: 'You need two of something to swap one. You always keep one of everything.' }))),
      h('div', { class: 'sw-go' },
        h('button', { type: 'button', class: 'btn primary slim-btn', disabled: !ready, onclick: e => offer(f.login, pick, e.currentTarget) }, 'Offer the swap'),
        h('span', { class: 'small muted', text: 'Yours is set aside until they answer. No answer in a week, and it comes back.' })));
  }

  async function offer(login, pick, btn) {
    btn.disabled = true;
    const r = await api.swapOffer({ to: login, give: pick.mine, get: pick.theirs }).catch(() => null);
    btn.disabled = false;
    toast(r, `Offered. @${login}’s Shellby will see it next time it checks.`);
    if (r?.ok) { picking.delete(login.toLowerCase()); apply(r.view); SB.friends?.load(); }
  }

  function renderSwaps() {
    const s = v()?.swaps;
    const box = $('frSwaps');
    if (!box) return;
    const rows = [];
    for (const o of s?.in || []) {
      rows.push(h('li', { class: 'sw-row in' },
        h('span', {}, h('b', { text: `@${o.from}` }), ' offers ', itemChip(o.give), ' for your ', itemChip(o.get)),
        h('span', { class: 'sw-actions' },
          h('button', { type: 'button', class: 'btn primary slim-btn', onclick: e => answer(o.sid, true, e.currentTarget) }, 'Swap'),
          h('button', { type: 'button', class: 'btn ghost slim-btn', onclick: e => answer(o.sid, false, e.currentTarget) }, 'No thanks'))));
    }
    for (const o of s?.out || []) {
      rows.push(h('li', { class: 'sw-row out' },
        h('span', {}, 'Your ', itemChip(o.give), ' for ', h('b', { text: `@${o.to}` }), '’s ', itemChip(o.get), h('small', { class: 'muted', text: ` · waiting, ${plural(o.daysLeft, 'day')} left` })),
        h('span', { class: 'sw-actions' }, h('button', { type: 'button', class: 'btn ghost slim-btn', onclick: e => cancel(o.sid, e.currentTarget) }, 'Call it off'))));
    }
    for (const d of (s?.done || []).slice(0, 4)) {
      rows.push(h('li', { class: 'sw-row done' }, h('span', {}, '🤝 ', itemChip(d.got), ' from ', h('b', { text: `@${d.with}` }), ' for your ', itemChip(d.gave), h('small', { class: 'muted', text: ` · ${SB.relTime(d.at)}` }))));
    }
    $('frSwapsHead').hidden = !rows.length;
    box.replaceChildren(...rows);
  }

  async function answer(sid, yes, btn) {
    btn.disabled = true;
    const r = await api.swapAnswer(sid, yes).catch(() => null);
    btn.disabled = false;
    toast(r, yes ? 'Swapped! It’s on your shelf.' : 'Said no thanks.');
    if (r?.ok) apply(r.view);
  }
  async function cancel(sid, btn) {
    btn.disabled = true;
    const r = await api.swapCancel(sid).catch(() => null);
    toast(r, 'Called off. Yours is back on the shelf.');
    if (r?.ok) apply(r.view);
  }

  // ------------------------------------------------------------ eggs

  const eggMessage = e => `My Shellby laid you an egg 🥚 Get Shellby (a pixel hermit crab that runs Claude Code on your desktop): ${DOWNLOAD} then paste this on his Us page to hatch it: ${e.code}`;

  async function copyEgg(e) {
    try {
      await navigator.clipboard.writeText(eggMessage(e));
      SB.toast('Copied: the download link and the egg code. Send it to whoever it’s for.', { ms: 4500 });
    } catch {
      SB.toast(`Couldn’t copy. The code is ${e.code}`, { ms: 9000 });
    }
  }

  function shareEgg(e) {
    SB.momentCard.share('egg', {
      eyebrow: '🥚 An egg, for you', title: 'Hatch my crab’s egg', sub: e.code, art: { pixels: e.pixels, palette: e.palette },
      accent: '#ffb3c6', glints: true, badge: 'Get Shellby, then paste the code',
      stats: [['to hatch it', 'paste the code'], ['where', 'his Us page']],
    }, {
      title: 'Your egg card', alt: `A crab egg with its code, ${e.code}`,
      post: `🥚 My Shellby laid an egg. First to hatch it gets a baby crab: install Shellby and paste ${e.code}`,
    });
  }

  function renderEggs() {
    const s = v();
    const box = $('usClutch');
    if (!box || !s) return;
    const e = s.eggs;
    box.hidden = false;
    const meta = [e.clutch.length ? plural(e.clutch.length, 'baby', 'babies') : '', e.open.length ? plural(e.open.length, 'egg') + ' waiting' : ''].filter(Boolean).join(' · ');
    $('usClutchMeta').textContent = meta;
    // Laying: the button, or why not yet.
    const lay = s.on
      ? h('div', { class: 'eg-lay' },
        h('button', { type: 'button', class: 'btn primary slim-btn', disabled: !e.canLay, onclick: ev => layEgg(ev.currentTarget) }, '🥚 Lay an egg'),
        h('span', { class: 'small muted', text: e.canLay ? 'For someone who doesn’t have Shellby yet. One a week.' : e.nextAt ? `${e.why} The next one ${new Date(e.nextAt).toLocaleDateString([], { weekday: 'long' })}.` : e.why }))
      : h('p', { class: 'small muted', text: 'Turn on Visiting crabs (Settings → GitHub) and he can lay eggs for friends who don’t have Shellby yet.' });
    const open = e.open.map(x => h('li', { class: 'eg-egg' },
      h('span', { class: 'eg-art', 'aria-hidden': 'true' }, art(x, 4)),
      h('span', { class: 'eg-code' }, h('code', { text: x.code }), h('small', { class: 'muted', text: `laid ${SB.relTime(x.laidAt)}` })),
      h('span', { class: 'eg-actions' },
        h('button', { type: 'button', class: 'btn ghost slim-btn', onclick: () => copyEgg(x) }, 'Copy invite'),
        h('button', { type: 'button', class: 'btn ghost slim-btn', dataset: { shareMoment: '1' }, onclick: () => shareEgg(x) }, '📸 Card'))));
    $('usEggs').replaceChildren(lay, open.length ? h('ul', { class: 'eg-open' }, open) : '');
    // The clutch: every baby, the one following him marked.
    $('usBabies').replaceChildren(...e.clutch.map(b => h('li', { class: `eg-baby${e.follower === b.id ? ' following' : ''}` },
      art(b, 4),
      h('b', { text: b.name }),
      h('small', { class: 'muted', text: b.mine ? `hatched by @${b.with}` : `from @${b.with}’s egg` }),
      h('button', { type: 'button', class: 'btn ghost slim-btn', 'aria-pressed': String(e.follower === b.id), onclick: () => follow(e.follower === b.id ? null : b.id) },
        e.follower === b.id ? 'Following him' : 'Follow him'))));
    $('usHatchRow').hidden = !!e.hatchedFrom;
    $('usHatchNote').textContent = e.pending ? `@${e.pending.from}’s egg is waiting. It hatches once Visiting crabs is on.` : e.hatchedFrom ? '' : 'Someone sent you an egg? Paste its code. Hatching adds them as a friend and leaves a note on their calling card.';
  }

  async function layEgg(btn) {
    btn.disabled = true;
    const r = await api.layEgg().catch(() => null);
    if (!r?.ok) { btn.disabled = false; toast(r); return; }
    apply(r.view);
    SB.celebrate({
      eyebrow: 'A new egg', icon: '🥚', title: 'He laid an egg!',
      text: 'Send it to someone who doesn’t have Shellby yet. When they hatch it, you both get the baby.',
      rewards: [{ name: 'An egg', pixels: r.view.eggs.open[0]?.pixels, palette: r.view.eggs.open[0]?.palette, kind: 'egg' }].filter(x => x.pixels),
      action: { label: 'Copy the invite', run: () => copyEgg(r.egg) },
    });
  }

  async function follow(id) {
    apply(await api.followBaby(id));
  }

  $('usHatchForm')?.addEventListener('submit', async ev => {
    ev.preventDefault();
    const input = $('usHatchInput');
    if (!input.value.trim()) return;
    $('usHatchGo').disabled = true;
    const r = await api.hatchEgg(input.value).catch(() => null);
    $('usHatchGo').disabled = false;
    if (r?.ok) { input.value = ''; apply(r.view); return; }
    SB.toast(r?.error || 'That egg wouldn’t hatch.', { ms: 8000 });
    api.getSocial().then(apply).catch(() => {});
  });

  // An egg hatched, either way round: the baby, big, and a card to show it off.
  api.onHatched(b => {
    if (!b?.name) return;
    api.getSocial().then(apply).catch(() => {});
    SB.celebrate({
      eyebrow: b.by ? 'Your egg hatched!' : 'Hatched!', icon: '🐣', title: b.name,
      text: b.by ? `@${b.by} hatched it. You’re friends now, and ${b.name} is in your clutch.` : `From @${b.from}’s egg.${b.gift ? ` They sent a ${b.gift.toLowerCase()} along with it.` : ''} You’re friends now.`,
      rewards: [{ name: b.name, pixels: b.pixels, palette: b.palette, kind: 'baby' }],
      action: { label: '📸 Share', run: () => SB.momentCard.share('egg', {
        eyebrow: '🐣 Hatched', title: b.name, sub: b.by ? `Hatched by @${b.by}` : `From @${b.from}’s egg`, art: { pixels: b.pixels, palette: b.palette },
        accent: '#ffb3c6', glints: true, stats: [],
      }, { title: `${b.name} hatched`, alt: `${b.name}, a baby crab`, post: `🐣 ${b.name} hatched! ${b.by ? `@${b.by} hatched my Shellby’s egg.` : `I hatched @${b.from}’s Shellby egg.`}` }) },
    });
  });

  // ------------------------------------------------------------ data in

  function apply(next) {
    if (!next) return;
    state.social = next;
    if (next.notice) SB.toast(next.notice, { ms: 6000 });
    renderSwaps();
    renderEggs();
  }

  api.onSocial(apply);
  api.onSocialFocus(() => {
    SB.setView('settings');
    requestAnimationFrame(() => $('ghFriendsRow')?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));
  });
  // A shellby://hatch link: the code waits in the box for you to press Hatch it.
  api.onHatchPrefill(code => {
    if (typeof code !== 'string' || !/^EGG-/.test(code)) return;
    const input = $('usHatchInput');
    if (!input) return;
    input.value = code.slice(0, 300);
    requestAnimationFrame(() => { $('usClutch')?.scrollIntoView({ block: 'center' }); $('usHatchGo')?.focus(); });
    SB.toast('An egg! Press Hatch it to hatch it.', { ms: 6000 });
  });
  api.getSocial().then(apply).catch(() => {});
  SB.social = { swapFor, refresh: () => api.getSocial().then(apply).catch(() => {}) };
})();
