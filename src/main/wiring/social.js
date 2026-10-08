// Swaps (swaps.js) and crab eggs (eggs.js), wired up. Both ride on Visiting
// crabs: what you'd swap and your open eggs go on your calling card, and the
// offers, answers and hatches are letters on each other's cards (friends.js
// letter, github/mail.js). This keeps the books, makes the shelf moves, and
// celebrates. See docs/plans/viral.md §3 and §4.
const crypto = require('crypto');
const gifts = require('../gifts');
const swaps = require('../swaps');
const eggs = require('../eggs');

const EXPIRE_EVERY_MS = 6 * 60 * 60 * 1000;
const newId = () => crypto.randomBytes(6).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(8, '0').slice(0, 8);

/** d: what main shares (main.js `shared`). */
function wireSocial(d) {
  const on = () => !!d.friends && d.github?.can('friends');
  const now = () => Date.now();
  const login = () => d.github?.view().login || null;
  const finds = () => gifts.normalize(d.config.get('finds'));
  const swapState = () => swaps.normalize(d.config.get('swaps'));
  const eggState = () => eggs.normalize(d.config.get('eggs'));
  const cardOf = who => d.friends?.friend(who)?.card || null;
  const theirSwap = who => cardOf(who)?.swap || { offers: [], wants: [] };

  function socialView() {
    return {
      on: !!on(),
      swaps: swaps.view(swapState(), now()),
      eggs: eggs.view(eggState(), { login: login(), level: d.currentLevel?.() || 1, cardOn: !!on() }, now()),
    };
  }
  const push = () => { d.send(d.panel, 'social', socialView()); d.life?.refreshFinds?.(); };
  // What's on your card changed (spares, eggs): publish it.
  const republish = () => d.friends?.republish?.().catch(() => {});

  async function send(letter, to) {
    const r = await d.friends.letter(to, letter.marker, letter.words);
    if (!r.ok) d.log.warn('social: a letter didn\'t go', r.error);
    return r;
  }

  // ---------------------------------------------------------------- swaps

  function swapOptions(who) {
    if (!on()) return { ok: false, error: 'Turn on Visiting crabs first.' };
    const f = d.friends.friend(who);
    if (!f) return { ok: false, error: 'Add them as a friend first.' };
    if (!f.card?.swap) return { ok: false, error: `@${f.login}'s Shellby doesn't do swaps yet.` };
    return { ok: true, login: f.login, ...swaps.options(finds(), f.card.swap) };
  }

  async function swapOffer({ to, give, get }) {
    if (!on()) return { ok: false, error: 'Turn on Visiting crabs first.' };
    const f = d.friends.friend(to);
    if (!f?.cardId) return { ok: false, error: `@${to} hasn't turned on Visiting crabs yet.` };
    const r = swaps.offer(swapState(), finds(), { sid: newId(), to: f.login, give, get, theirCard: theirSwap(f.login) }, now());
    if (!r.ok) return r;
    const sent = await send(r.letter, f.login);
    if (!sent.ok) return sent;
    d.config.set({ swaps: r.swaps, finds: r.finds });
    push();
    republish();
    return { ok: true, view: socialView() };
  }

  async function swapCancel(sid) {
    const r = swaps.cancel(swapState(), finds(), sid);
    if (!r.letter) return { ok: false, error: 'That swap is already done or gone.' };
    d.config.set({ swaps: r.swaps, finds: r.finds });
    push();
    republish();
    send(r.letter, r.letter.to).catch(() => {});
    return { ok: true, view: socialView() };
  }

  async function swapAnswer(sid, yes) {
    const r = swaps.answer(swapState(), finds(), sid, !!yes, now());
    if (!r.ok) return r;
    const sent = await send(r.letter, r.letter.to);
    if (!sent.ok) return sent; // nothing moved: try again
    d.config.set({ swaps: r.swaps, finds: r.finds });
    if (r.done) swapDone(r.done);
    push();
    republish();
    return { ok: true, view: socialView() };
  }

  // A swap went through, on your side: the find arrives, and it counts.
  function swapDone(done) {
    const got = gifts.findById(done.got.id);
    const twice = d.eventBoosts?.().swaps || 1; // Pen Pal Week: swaps count double toward the trophies
    for (let i = 0; i < twice; i++) d.stat('swap-made');
    if (done.completed?.length) d.stat('swap-set');
    d.stat('find-made', { id: got.id, event: got.event });
    d.awardXp('swap', { label: `Swapped with @${done.with}` });
    d.life?.remember?.('first-swap', { login: done.with });
    const set = done.completed?.length ? gifts.SETS.find(s => s.id === done.completed[0]) : null;
    const look = done.got.shiny ? gifts.sparkly(got) : got;
    d.send(d.panel, 'life:moment', {
      eyebrow: set ? 'Swap: set complete!' : 'Swap done', icon: '🤝', title: `${done.got.shiny ? '✨ ' : ''}${got.name}`,
      text: set ? `From @${done.with}. That finishes ${set.name}!` : `From @${done.with}, for your ${gifts.findById(done.gave.id).name.toLowerCase()}.`,
      rewards: [{ name: got.name, pixels: look.pixels, palette: look.palette, kind: 'find' }],
    });
    d.sayText(set ? 'set complete!!' : `a swap from @${done.with}!`.slice(0, 40), 'found', 6000);
  }

  function onSwapLetter(l) {
    const r = swaps.onLetter(swapState(), finds(), l, { friend: l.friend, theirCard: theirSwap(l.from) }, now());
    if (!r.done && !r.news) return;
    d.config.set({ swaps: r.swaps, finds: r.finds });
    if (r.done) swapDone(r.done);
    if (r.news === 'offer') {
      d.sayText(`@${l.from} wants to swap!`, 'wave', 8000);
      d.notify(`@${l.from} would like to swap`, 'Open Visiting crabs to see what for.', () => openFriends(), { pet: true, action: 'See it' });
    }
    if (r.news === 'declined') d.send(d.panel, 'toast', `@${l.from} said no thanks to the swap. Yours is back on the shelf.`);
    push();
    republish();
  }

  function expireSwaps() {
    const r = swaps.expire(swapState(), finds(), now());
    if (!r.expired) return;
    d.config.set({ swaps: r.swaps, finds: r.finds });
    push();
    republish();
  }

  function openFriends() {
    d.showPanel({ focusInput: false });
    d.send(d.panel, 'panel:view', 'settings');
    d.send(d.panel, 'settings:section', 'github');
  }

  // ---------------------------------------------------------------- eggs

  function layEgg() {
    const r = eggs.lay(eggState(), eggs.newEggId(), { level: d.currentLevel?.() || 1, cardOn: !!on(), login: login() }, now());
    if (!r.ok) return r;
    d.config.set({ eggs: r.state });
    d.log.info('eggs: laid one');
    d.sayText('I laid an egg!! 🥚', 'found', 6000);
    push();
    republish();
    return { ok: true, egg: r.egg, view: socialView() };
  }

  /** A code pasted, or a shellby://hatch link opened. Hatches now, or as soon as GitHub's ready. */
  async function hatchEgg(text) {
    const code = eggs.parseCode(text);
    if (!code) return { ok: false, error: 'That doesn\'t look like an egg code. It starts with EGG-.' };
    if (!on()) {
      d.config.set({ eggs: eggs.keepPending(eggState(), code, now()) });
      push();
      return { ok: false, pending: true, error: `Keep it safe: sign in to GitHub and turn on Visiting crabs, and @${code.from}'s egg hatches by itself.` };
    }
    let parent = cardOf(code.from);
    if (!parent) {
      const added = await d.friends.add(code.from);
      if (!added.ok && !/already a friend/.test(added.error || '')) return added;
      parent = cardOf(code.from);
    }
    const r = eggs.hatch(eggState(), code, parent, login(), now());
    if (!r.ok) return r;
    const sent = await send(r.letter, code.from);
    if (!sent.ok) return sent;
    let shelf = d.config.get('finds');
    if (r.gift && gifts.findById(r.gift) && !gifts.findById(r.gift).special) shelf = gifts.receive(shelf, r.gift, false, now()).state;
    d.config.set({ eggs: r.state, finds: shelf });
    d.stat('hatched-from-egg');
    d.awardXp('hatch', { label: `Hatched from @${code.from}'s egg` });
    d.life?.remember?.('egg-hatched', { from: code.from });
    hatchMoment(r.baby, { from: code.from, gift: r.gift });
    push();
    return { ok: true, baby: { name: r.baby.name }, view: socialView() };
  }

  function onHatchLetter(l) {
    const r = eggs.onHatch(eggState(), l, now());
    if (!r.baby) return;
    d.config.set({ eggs: r.state });
    d.log.info('eggs: one hatched');
    d.stat('egg-hatched');
    d.awardXp('hatch', { label: `@${l.from} hatched one of his eggs` });
    d.life?.remember?.('egg-hatched', { login: l.from, name: r.baby.name });
    // The friend who hatched it is a friend now.
    if (!d.friends.friend(l.from)) d.friends.add(l.from).catch(() => {});
    hatchMoment(r.baby, { by: l.from });
    push();
    republish();
  }

  function hatchMoment(baby, { from = null, by = null, gift = null }) {
    d.send(d.critter, 'critter:burst', d.outfit().confetti);
    d.sayText(by ? `@${by} hatched ${baby.name}!` : `hi ${baby.name.toLowerCase()}!`, 'found', 8000);
    d.send(d.panel, 'social:hatched', { name: baby.name, pixels: baby.pixels, palette: baby.palette, by, from, gift: gift ? gifts.findById(gift)?.name || null : null });
    if (!(d.panel?.isVisible() && d.panel.isFocused())) {
      d.notify(by ? `🐣 @${by} hatched one of your eggs!` : `🐣 ${baby.name} hatched!`, by ? `Say hi to ${baby.name}. You're friends now, and it's in your clutch on the Us page.` : `From @${from}'s egg. It's on the Us page, with your clutch.`, () => { d.showPanel({ focusInput: false }); d.send(d.panel, 'panel:view', 'us'); }, { tone: 'celebrate', pet: true });
    }
  }

  // A pasted code waiting for GitHub: hatch it once Visiting crabs is on.
  function hatchPending() {
    const p = eggState().pending;
    if (p && on()) hatchEgg(`EGG-${p.from}-${p.egg}`).catch(() => {});
  }

  function setBabyFollower(id) {
    d.config.set({ eggs: eggs.setFollower(eggState(), id) });
    d.bugdex?.sendBuddy?.();
    push();
    return socialView();
  }

  /** The baby following him round the desk instead of his favourite catch, or null. */
  function babyBuddy() {
    const s = eggState();
    const b = s.follower && s.clutch.find(x => x.id === s.follower);
    return b ? { id: `egg-${b.id}`, name: eggs.hatchling(b.id).name, ghost: false, ...eggs.hatchling(b.id) } : null;
  }

  // ---------------------------------------------------------------- letters

  function onLetter(l) {
    try {
      if (l.kind === 'swap') onSwapLetter(l);
      else if (l.kind === 'hatch') onHatchLetter(l);
    } catch (e) { d.log.warn('social: a letter failed', e.message); }
  }

  function startSocial() {
    d.friends?.on('letter', onLetter);
    d.github?.on('change', hatchPending);
    d.every(expireSwaps, EXPIRE_EVERY_MS);
    setTimeout(() => { expireSwaps(); hatchPending(); }, 20 * 1000);
  }

  return {
    socialView, swapOptions, swapOffer, swapCancel, swapAnswer, layEgg, hatchEgg, setBabyFollower, babyBuddy, startSocial,
  };
}

module.exports = { wireSocial };
