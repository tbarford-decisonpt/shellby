// A classic script that shares critter.js's top-level scope (critter.html
// loads it right after critter.js). A new sticker slapped on his shell, the
// glint, the "+XP" float and a surprise's badge.
/* global api:writable, drawSelf:writable, flags:writable, paintBody:writable, px:writable, skin:writable, slap:writable, spriteHost:writable */

// ---- a new sticker (src/main/stickers.js): the first time a project ships,
// he holds its sticker up in his claw, turns his shell to you and slaps it on,
// with a little puff of sand. Main says where it goes, in sprite pixels.
const stickerFly = document.getElementById('stickerFly');
const sandHost = document.getElementById('sand');
const SLAP_HOLD_MS = 1300;
const SLAP_TURN_MS = 450;
const SLAP_FLY_MS = 380;
const SLAP_LAND_MS = 900;
let slapTimers = [];

function endSlap() {
  slapTimers.forEach(clearTimeout);
  slapTimers = [];
  for (const f of ['sticker-hold', 'sticker-turn', 'sticker-land']) flags.delete(f);
  stickerFly.getAnimations().forEach(a => a.cancel());
  stickerFly.replaceChildren();
  slap = null;
  drawSelf();
  paintBody();
}

function sandPuff(at) {
  const cx = (at.x + 1.5) * px, cy = (at.y + 1.5) * px;
  for (let i = 0; i < 6; i++) {
    const el = document.createElement('i');
    const a = (i / 6) * Math.PI * 2 + 0.4;
    el.style.left = `${cx}px`;
    el.style.top = `${cy}px`;
    el.style.setProperty('--dx', `${Math.cos(a) * px * 3.2}px`);
    el.style.setProperty('--dy', `${Math.sin(a) * px * 2.4 - px}px`);
    sandHost.append(el);
    setTimeout(() => el.remove(), 700);
  }
}

// A sticker on his shell catches the light (a tier-up, a new mark, a re-press).
function glint(id) {
  const g = typeof id === 'string' && [...spriteHost.querySelectorAll('[data-sticker]')].find(el => el.dataset.sticker === id);
  if (!g) return;
  g.classList.remove('glint');
  void g.getBoundingClientRect(); // restart the animation
  g.classList.add('glint');
}
api.onStickerGlint(msg => glint(msg?.id));

api.onSticker(msg => {
  if (!skin || typeof msg?.id !== 'string' || !Array.isArray(msg.small?.pixels) || !msg.small.palette) return;
  if (slap) endSlap();
  // Without motion it's simply there, which main has already drawn.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const size = msg.small.pixels.length;
  slap = {
    id: msg.id, holding: true,
    held: { slot: 'held', anchor: 'claw', follows: 'claw', pivot: [Math.floor(size / 2), size], pixels: msg.small.pixels, palette: msg.small.palette },
  };
  flags.add('sticker-hold');
  drawSelf();
  paintBody();
  const at = msg.at && Number.isFinite(msg.at.x) && Number.isFinite(msg.at.y) ? msg.at : null;
  const landAt = SLAP_HOLD_MS + SLAP_TURN_MS + SLAP_FLY_MS;
  slapTimers = [
    setTimeout(() => { flags.delete('sticker-hold'); flags.add('sticker-turn'); paintBody(); }, SLAP_HOLD_MS),
    setTimeout(() => {
      slap.holding = false;
      drawSelf();
      if (!at) return; // it went in the Sticker Book, not on the shell
      const [cx, cy] = skin.anchors?.claw || window.ShellbySprite.DEFAULT_ANCHORS.claw;
      const sx = (cx - slap.held.pivot[0]) * px, sy = (cy - slap.held.pivot[1]) * px;
      stickerFly.replaceChildren(window.ShellbySprite.grid(msg.small.pixels, msg.small.palette, { px }));
      stickerFly.style.left = `${sx}px`;
      stickerFly.style.top = `${sy}px`;
      stickerFly.animate([
        { transform: 'translate(0, 0) scale(1) rotate(0deg)' },
        { transform: `translate(${at.x * px - sx}px, ${at.y * px - sy}px) scale(${3 / size}) rotate(-20deg)`, offset: 0.85 },
        { transform: `translate(${at.x * px - sx}px, ${at.y * px - sy}px) scale(${3 / size}) rotate(0deg)` },
      ], { duration: SLAP_FLY_MS, easing: 'cubic-bezier(.55, 0, .8, .45)', fill: 'forwards' });
    }, SLAP_HOLD_MS + SLAP_TURN_MS),
    setTimeout(() => {
      stickerFly.getAnimations().forEach(a => a.cancel());
      stickerFly.replaceChildren();
      flags.delete('sticker-turn');
      flags.add('sticker-land');
      slap = null;
      drawSelf();
      paintBody();
      if (at) { sandPuff(at); glint(msg.id); window.ShellbySound.cue('slap'); }
    }, landAt),
    setTimeout(endSlap, landAt + SLAP_LAND_MS),
  ];
});

// "+25 XP" rises out of Shellby whenever he earns XP.
const xpHost = document.getElementById('xpFloat');
api.onXp(({ amount }) => {
  const el = document.createElement('span');
  el.textContent = `+${amount} XP`;
  el.className = amount >= 100 ? 'big' : '';
  xpHost.append(el);
  setTimeout(() => el.remove(), 1800);
});

// A crit hit or a clean landing (src/main/surprises.js): rare, so it gets a
// little show of its own. The badge pops up over him and he jumps (a crit) or
// comes in to land (a clean landing); main sends the line, sound and confetti.
const SURPRISE_MS = { crit: 2200, landing: 2400 };
const surpriseHost = document.getElementById('surprise');
let surpriseTimer = null;
api.onSurprise(msg => {
  const kind = msg?.kind === 'landing' ? 'landing' : 'crit';
  const badge = typeof msg?.badge === 'string' ? msg.badge.slice(0, 20) : '';
  if (!badge) return;
  clearTimeout(surpriseTimer);
  flags.delete('surprise-crit');
  flags.delete('surprise-landing');
  const el = document.createElement('span');
  el.className = `surprise-${kind}${msg.big ? ' big' : ''}`;
  el.textContent = badge;
  surpriseHost.replaceChildren(el);
  flags.add(`surprise-${kind}`);
  paintBody();
  surpriseTimer = setTimeout(() => { el.remove(); flags.delete(`surprise-${kind}`); paintBody(); }, SURPRISE_MS[kind]);
});
