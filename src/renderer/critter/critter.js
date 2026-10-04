const crab = document.getElementById('crab');
const spriteHost = document.getElementById('sprite');
const bubbleText = document.getElementById('bubbleText');
const crewHost = document.getElementById('crew');
const countEl = document.getElementById('count');
const bgBadge = document.getElementById('bgBadge');
const api = window.shellby.critter;

const BUBBLES = { working: '', asking: '?', success: '✓', error: '!', learned: '✦', unlocked: '★', levelup: 'LV', molting: '', petted: '♥', cheer: 'green!', refreshed: 'ready!', stickered: '✦' };
// Health readings show in the bubble only when nothing more important is.
const HEALTH_BUBBLE_STATES = new Set(['idle', 'sleeping']);
// Each helper gets its own shell colour so parallel agents are easy to tell apart.
const HUES = [0, 145, 250, 60, 300, 200];

let skin = null;
let outfit = { accessories: [], effect: null, crewAccessories: [], home: null };
let fx = null;
let px = 4;
let state = 'idle';
let health = null;
let ciFailing = 0; // pull requests with red CI (src/main/github/ci.js)
let servers = null; // { up, upPort, down }: your dev servers (src/main/devservers/service.js)
const serversDown = () => servers?.down || 0;
let focusing = null; // { phase: 'focus' | 'break', endsAt } (src/main/focus.js)
let limit = null;    // { resetsAt }: napping until the usage limit resets (src/main/limits.js)
let say = null;      // { text, occasion, until }: what he's saying (src/main/voice.js)
let onCall = false;  // you're on a call: he holds up his "shh" sign (src/main/surroundings.js)
// Things a scene or a game puts on him for a moment, by slot (src/renderer/critter/life.js).
const overrides = new Map();
// The sign he holds up while CI is red. It goes in the held slot like any other
// prop, so the post lands in the claw pinch and the whole thing swings with his
// arm instead of hanging in the air beside it.
const CI_SIGN = {
  slot: 'held', anchor: 'claw', follows: 'claw', pivot: [2, 9],
  palette: { K: '#3d2a00', w: '#fff4e4', r: '#e63946', p: '#a0693a' },
  pixels: [
    'KKKKKKKK', 'KrrwwrrK', 'KwrrrrwK', 'KwwrrwwK', 'KwrrrrwK', 'KrrwwrrK', 'KKKKKKKK',
    '.pp.....', '.pp.....', '.pp.....',
  ],
};
// ...and the one he holds up while you're on a call: a finger to his lips.
const CALL_SIGN = {
  slot: 'held', anchor: 'claw', follows: 'claw', pivot: [2, 9],
  palette: { K: '#2b2d42', w: '#fff4e4', r: '#e63946', s: '#f4c095', p: '#a0693a' },
  pixels: [
    'KKKKKKKKK', 'KwwwswwwK', 'KwwwswwwK', 'KwrrsrrwK', 'KwwrsrwwK', 'KwwwwwwwK', 'KKKKKKKKK',
    '..pp.....', '..pp.....', '..pp.....',
  ],
};
// ...and the one he holds up when a dev server crashed: a pulled plug.
const SERVER_SIGN = {
  slot: 'held', anchor: 'claw', follows: 'claw', pivot: [2, 9],
  palette: { K: '#3d2a00', w: '#fff4e4', r: '#e63946', y: '#ffd23f', p: '#a0693a' },
  pixels: [
    'KKKKKKKK', 'KrrrwrrK', 'KrrwwwrK', 'KrrrwrrK', 'KryrrrrK', 'KrryrrrK', 'KKKKKKKK',
    '.pp.....', '.pp.....', '.pp.....',
  ],
};
const TOSS_MS = 620;  // how long what he was carrying stays in the air
const GRAB_MS = 560;  // ...and when the sign takes its place, once it is clear
const CATCH_MS = 520; // the drop back down once the build is green
let tossed = false;   // his own held item is out of his claw, from throw to catch
let flinging = false; // mid-throw: he has not got a claw on the sign yet
// He only holds the sign up on his feet: a nap, a molt or a throw has his claws busy.
const settled = () => state === 'idle' || state === 'working';
// Something worth putting his own things down for: red CI or a crashed server.
const wantsSign = () => ciFailing > 0 || serversDown() > 0;
const holdingSign = () => (wantsSign() || onCall) && !flinging && settled();
// Which sign, most urgent first: CI, then a server, then the call.
const signKind = () => (ciFailing > 0 ? 'ci' : serversDown() > 0 ? 'server' : 'call');
const SIGNS = { ci: CI_SIGN, server: SERVER_SIGN, call: CALL_SIGN };
// Everything his claw can be carrying, so that a change of load triggers a redraw.
const clawLoad = () => (holdingSign() ? signKind() : tossed ? 'empty' : 'own');
const healthFx = window.ShellbyHealthFx.mount(document.getElementById('healthFx'), document.getElementById('self'));
const helpers = new Map(); // task id -> element

api.onSkin(msg => {
  skin = msg.skin;
  px = msg.px;
  outfit = msg.outfit || outfit;
  document.documentElement.style.setProperty('--px', `${px}px`);
  document.documentElement.style.setProperty('--self-w', `${22 * px + 72}px`);
  drawSelf();
  for (const el of helpers.values()) el.querySelector('svg')?.replaceWith(helperSprite(el.dataset.hue));
  // Equipped effect (snow, bats, ...) plays around Shellby; burst effects wait for a finished task.
  if (!fx) fx = window.ShellbyFx.mount(document.getElementById('fx'), null, { px: Math.max(2, Math.round(px * 0.75)) });
  fx.set(outfit.effect);
});

api.onBurst(effect => { if (fx && effect) fx.burst(effect); });

// Shellby himself. While he molts, the molt decides which shell he's in.
let molt = null; // { shell, bubble, stickers } during a molt
let slap = null; // { id, holding, held } while a new sticker goes on (see onSticker)
function drawSelf() {
  if (!skin) return;
  const shell = molt ? molt.shell : outfit.home;
  // Between shells, whatever sits on the shell (a flag, bat wings) has nowhere to go.
  let accessories = molt?.shell === 'none' ? outfit.accessories.filter(a => a.slot !== 'shell') : outfit.accessories;
  // On guard: the helmet goes on instead of whatever hat he wears.
  if (focusing?.phase === 'focus' && outfit.focusHelmet) accessories = [...accessories.filter(a => a.slot !== 'hat'), outfit.focusHelmet];
  // Something is playing: headphones on, unless he's already wearing the helmet.
  else if (outfit.musicHeadphones) accessories = [...accessories.filter(a => a.slot !== 'hat'), outfit.musicHeadphones];
  // Red CI wants the claw he carries things in: his own held item is in the air
  // (see throwHeld) and the sign goes in once he has let go of it.
  // A scene's prop or a find to show off takes its slot for a moment.
  for (const [slot, item] of overrides) accessories = [...accessories.filter(a => a.slot !== slot), item];
  if (tossed || holdingSign() || slap?.holding) accessories = accessories.filter(a => a.slot !== 'held');
  if (holdingSign()) accessories = [...accessories, SIGNS[signKind()]];
  if (slap?.holding) accessories = [...accessories, slap.held];
  spriteHost.replaceChildren(window.ShellbySprite.build(skin, { px, accessories, shell, stickers: stickersFor(shell) }));
}

// The stickers on his shell (src/main/stickers.js). A molt brings the new
// shell's own; one he's about to slap on stays off until his claw gets there.
function stickersFor(shell) {
  if (shell === 'none') return [];
  const list = (molt ? molt.stickers : outfit.stickers) || [];
  return slap ? list.filter(s => s.id !== slap.id) : list;
}

// A level-up unlocked a new shell: crawl out of the old one, shiver for a
// moment with no shell at all, then the new one drops onto his back.
let moltTimers = [];
// The old shell's stickers leave with it; the new one arrives with the ones he
// carried over (src/main/stickers.js carryOnMolt).
api.onMolt(({ from, to, ms = 5200, fromStickers = [], toStickers = [] }) => {
  moltTimers.forEach(clearTimeout); // a second level-up mid-molt starts over
  const beat = ms / 5;
  const step = (cls, shell, bubble, stickers = []) => {
    molt = { shell, bubble, cls, stickers };
    drawSelf();
    paintBody();
  };
  step('molt-out', from, '…', fromStickers);
  moltTimers = [
    setTimeout(() => step('molt-bare', 'none', 'eep!'), beat * 1.2),
    setTimeout(() => step('molt-in', to, 'new home!', toStickers), beat * 2.6),
    setTimeout(() => {
    molt = null;
    drawSelf();
    paintBody();
  }, ms),
  ];
});

// Uh oh: a red build needs the claw he carries things in, so whatever is in it
// goes up in the air, the sign takes its place, and it drops back down once the
// build is green and he has stopped celebrating.
const tossHost = document.getElementById('toss');
let tossTimers = [];
const heldItem = () => (outfit.accessories || []).find(a => a.slot === 'held') || null;

// Puts the item where his claw was holding it and lets `cls` fly it from there.
function flyItem(item, cls, ms, done) {
  tossTimers.forEach(clearTimeout);
  const [cx, cy] = skin?.anchors?.claw || window.ShellbySprite.DEFAULT_ANCHORS.claw;
  tossHost.replaceChildren(window.ShellbySprite.grid(item.pixels, item.palette, { px }));
  tossHost.style.left = `${(cx - item.pivot[0]) * px}px`;
  tossHost.style.top = `${(cy - item.pivot[1]) * px}px`;
  tossHost.className = cls;
  tossTimers = [setTimeout(() => {
    tossHost.className = '';
    tossHost.replaceChildren();
    done?.();
  }, ms)];
}

function throwHeld() {
  const item = heldItem();
  tossed = true;
  flinging = true;
  flags.add('tossing');
  flyItem(item, 'toss-out', TOSS_MS);
  // flyItem resets the timer list, so the sign's cue is queued after it.
  tossTimers.push(setTimeout(() => {
    flinging = false;
    flags.delete('tossing');
    drawSelf();
    paintBody();
  }, GRAB_MS));
}

function catchHeld() {
  const item = heldItem();
  flinging = false;
  // `tossed` stays set until it lands, so his claw reads as empty until then.
  if (!item) { tossed = false; drawSelf(); return; }
  flyItem(item, 'toss-in', CATCH_MS, () => { tossed = false; drawSelf(); });
}

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
      if (at) { sandPuff(at); glint(msg.id); }
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

function helperSprite(hue) {
  // Helpers wear the same hat as Shellby when "crew outfits" is on.
  const svg = window.ShellbySprite.build(skin, { px: Math.max(1, px * 0.5), accessories: outfit.crewAccessories || [] });
  svg.style.filter = `hue-rotate(${hue}deg) saturate(1.1)`;
  return svg;
}

function renderCrew(crew, more) {
  const live = new Set(crew.map(c => c.id));
  // Helpers whose task finished walk back into Shellby, then disappear.
  for (const [id, el] of helpers) {
    if (!live.has(id) && !el.classList.contains('leaving')) {
      // Out of the row where it stands, so a helper arriving in the same moment
      // takes its slot instead of being pushed past the window's left edge.
      el.style.left = `${el.offsetLeft}px`;
      el.classList.add('leaving');
      setTimeout(() => { el.remove(); helpers.delete(id); }, 900);
    }
  }
  crew.forEach((c, i) => {
    let el = helpers.get(c.id);
    if (!el) {
      const hue = HUES[helpers.size % HUES.length];
      el = document.createElement('div');
      el.className = 'helper fresh';
      el.dataset.hue = hue;
      el.dataset.tab = c.tabId;
      el.style.animationDelay = `${i * 80}ms`;
      const tag = document.createElement('span');
      tag.className = 'tag';
      el.append(tag, helperSprite(hue));
      el.addEventListener('click', () => api.crewClick(el.dataset.tab));
      setTimeout(() => el.classList.remove('fresh'), 2500);
      helpers.set(c.id, el);
      crewHost.append(el);
    }
    // Themed name tag only: a native `title` would pop an unstyled OS tooltip.
    el.querySelector('.tag').textContent = c.type && c.type !== c.label ? `${c.label} · ${c.type}` : c.label;
    el.setAttribute('aria-label', `Helper ${c.type}: ${c.label}`);
  });
  crewHost.querySelector('.more')?.remove();
  if (more > 0) {
    const m = document.createElement('span');
    m.className = 'more';
    m.textContent = `+${more}`;
    crewHost.append(m);
  }
}

let level = 1;
function bubbleFor() {
  if (state === 'levelup') return `LV ${level}`;
  if (molt) return molt.bubble;
  if (health && HEALTH_BUBBLE_STATES.has(state)) return health.text;
  if (limit && state === 'sleeping') return `⏳ ${timeLeft(limit.resetsAt)}`;
  if (focusing && state === 'idle') return `${focusing.phase === 'break' ? 'break ' : ''}${minutesLeft()}`;
  if (ciFailing && state === 'idle') return ciFailing > 1 ? `CI ✗${ciFailing}` : 'CI ✗';
  if (serversDown() && state === 'idle') return 'server ✗';
  if (onCall && state === 'idle') return '🤫';
  // His own voice comes last of the things that mean something, and still beats
  // the bare mood glyph it replaces.
  if (saying()) return say.text;
  return BUBBLES[state] ?? '';
}
const saying = () => !!say && say.until > Date.now();
const bubbleOn = () => state in BUBBLES || saying() || (health && HEALTH_BUBBLE_STATES.has(state)) || ((wantsSign() || !!focusing || onCall) && state === 'idle') || (!!limit && state === 'sleeping');
const timeLeft = t => {
  const ms = Math.max(0, t - Date.now());
  if (ms >= 3600000) return `${Math.floor(ms / 3600000)}h${String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0')}`;
  return ms >= 60000 ? `${Math.ceil(ms / 60000)}m` : `${Math.ceil(ms / 1000)}s`;
};
const minutesLeft = () => timeLeft(focusing?.endsAt || 0);

// Every body class in one place: the mood, plus anything that outlasts a state
// message (a molt in progress, a throw, a walk). Drop-over toggles its own.
const flags = new Set();
function paintBody() {
  const dropping = document.body.classList.contains('dropping');
  document.body.className = [
    `state-${state}`, bubbleOn() || dropping ? 'bubble-on' : '', health ? `health-${health.level}` : '',
    molt?.cls, dropping ? 'dropping' : '', ciFailing && state !== 'sleeping' ? 'ci-red' : '',
    focusing ? `focus-${focusing.phase}` : '', limit ? 'limited' : '', saying() ? 'saying' : '', onCall ? 'on-call' : '', ...flags,
  ].filter(Boolean).join(' ');
  bubbleText.textContent = dropping ? 'drop it!' : bubbleFor();
}

api.onState(msg => {
  const wasLoad = clawLoad();
  state = msg.state;
  health = msg.health || null;
  level = msg.level || level;
  ciFailing = msg.ci?.failing || 0;
  servers = msg.servers || null;
  limit = msg.limit || null;
  say = msg.say || null;
  onCall = !!msg.call;
  const wasGuarding = focusing?.phase === 'focus';
  focusing = msg.focus || null;
  // The throw waits for him to settle, so that it runs into the sign going up
  // rather than happening somewhere behind the 'error' flash a red build sets off.
  if (wantsSign() && !tossed && settled() && heldItem()) throwHeld();
  if (!wantsSign() && tossed && settled()) catchHeld();
  if (wasGuarding !== (focusing?.phase === 'focus') || wasLoad !== clawLoad()) drawSelf();
  healthFx.set(health?.mood);
  paintBody();
  // Work a turn backgrounded and never came back to. It outlasts his moods, so
  // it is the one thing on him that stays up while he is idle or asleep.
  const bg = msg.background || 0;
  bgBadge.hidden = !bg;
  bgBadge.textContent = String(bg);
  // No title attribute: a native tooltip over the transparent pet window looks
  // like the OS barged in (scripts/ui-regressions.js guards this).
  bgBadge.setAttribute('aria-label', `${bg} background command${bg === 1 ? '' : 's'} left running. Click to see them.`);
  renderServers();
  countEl.textContent = msg.busy;
  countEl.classList.toggle('on', msg.busy > 1);
  countEl.setAttribute('aria-label', `${msg.busy} conversations running`);
  if (skin) renderCrew(msg.crew || [], msg.moreCrew || 0);
});

// ---- click vs drag (pointer capture keeps drags alive past the window edge)
let down = null;
let dragging = false;
bgBadge.addEventListener('click', () => api.bgClick());

// Your dev servers: ":5173" while one is up, red when one fell over. Like the
// background badge, it stays up whatever his mood (he can nap with a server
// running). Asleep, only a crash shows.
const srvPill = document.getElementById('srvPill');
function renderServers() {
  const down = serversDown();
  const up = servers?.up || 0;
  const show = down > 0 || (up > 0 && state !== 'sleeping');
  srvPill.hidden = !show;
  if (!show) return;
  srvPill.classList.toggle('down', down > 0);
  srvPill.textContent = down > 0 ? (down > 1 ? `${down} down` : 'down') : up === 1 && servers.upPort ? `:${servers.upPort}` : `${up} up`;
  srvPill.setAttribute('aria-label', down > 0
    ? `${down} dev server${down === 1 ? '' : 's'} crashed. Click to see the error.`
    : up === 1 && servers.upPort ? `Dev server running on port ${servers.upPort}. Click to see it.` : `${up} dev servers running. Click to see them.`);
}
srvPill.addEventListener('click', () => api.serversClick());
crab.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  crab.setPointerCapture(e.pointerId);
  down = { x: e.screenX, y: e.screenY };
  dragging = false;
});
crab.addEventListener('pointermove', e => {
  if (!down) return;
  const dx = e.screenX - down.x, dy = e.screenY - down.y;
  if (!dragging && Math.hypot(dx, dy) > 4) { dragging = true; api.dragStart(); }
  if (dragging) api.dragMove(dx, dy);
});
crab.addEventListener('pointerup', e => {
  if (!down || e.button !== 0) return;
  if (dragging) api.dragEnd(); else api.click();
  down = null;
  dragging = false;
});
crab.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') api.click(); });

// ---- petting: rub the mouse back and forth over him (no click needed)
const PET_TURNS = 5;        // direction changes...
const PET_WINDOW_MS = 1400; // ...within this long
const heartsHost = document.getElementById('hearts');
let rub = { x: null, dir: 0, turns: [] };
crab.addEventListener('pointermove', e => {
  if (down) return;
  if (rub.x === null) { rub.x = e.screenX; return; }
  const dx = e.screenX - rub.x;
  if (Math.abs(dx) < 3) return;
  rub.x = e.screenX;
  if (Math.sign(dx) === rub.dir) return;
  rub.dir = Math.sign(dx);
  const now = performance.now();
  rub.turns = [...rub.turns.filter(t => now - t < PET_WINDOW_MS), now];
  if (rub.turns.length < PET_TURNS) return;
  rub.turns = [];
  hearts();
  api.pet();
  document.dispatchEvent(new Event('shellby:petted')); // charm.js counts these for a belly-up
});
crab.addEventListener('pointerleave', () => { rub = { x: null, dir: 0, turns: [] }; });
function hearts(n = 3) {
  for (let i = 0; i < n; i++) {
    const el = document.createElement('span');
    el.textContent = '♥';
    el.style.setProperty('--dx', `${(i - (n - 1) / 2) * 14}px`);
    el.style.animationDelay = `${i * 140}ms`;
    heartsHost.append(el);
    setTimeout(() => el.remove(), 1700);
  }
}

// ---- on the move: thrown, landing, strolling, and up on your windows. Main
// moves the window (src/main/motion.js, perching.js); this is how he looks
// while it does: one body class per beat, all of it in critter.css.
const MOTION_FLAGS = [
  'flying', 'fly-left', 'fly-fall', 'fly-fling', 'fly-pop', 'landed', 'walking', 'walk-left',
  'eyeing', 'crouch', 'hopping', 'hop-flip', 'cling', 'scramble', 'coyote', 'wheee', 'windy',
];
const FLY_STYLES = new Set(['fall', 'fling', 'pop']); // 'tumble' is the plain throw
const DIZZY_MS = 2600;
const WHEEE_MS = 1800;
const root = document.documentElement.style;
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));
let landedTimer = null;
let dizzyTimer = null;
let wheeeTimer = null;
const dustHost = document.getElementById('dust');

// Which way he's going, for anything that leans, flips or trails behind him.
const setDir = v => root.setProperty('--dir', v < 0 ? '-1' : '1');

// Riding a window that's moving: lean back against it, and the faster it goes
// the harder the wind streams past.
function setLean(vx) {
  const v = clampN(vx, -4000, 4000);
  const wind = clampN(Math.abs(v) / 1400, 0, 1);
  root.setProperty('--lean', `${clampN(-v / 90, -16, 16).toFixed(1)}deg`);
  root.setProperty('--wind', wind.toFixed(2));
  root.setProperty('--wdir', v < 0 ? '-1' : '1');
  if (wind > 0.15) flags.add('windy'); else flags.delete('windy');
}

// A puff of dust where his feet touch down.
function puff(n = 7) {
  for (let i = 0; i < n; i++) {
    const el = document.createElement('i');
    const side = i % 2 ? 1 : -1;
    const spread = 6 + (i * 37 % 19);
    el.style.setProperty('--dx', `${side * spread * 1.6}px`);
    el.style.setProperty('--dy', `${-4 - (i * 23 % 11)}px`);
    el.style.animationDelay = `${i * 12}ms`;
    dustHost.append(el);
    setTimeout(() => el.remove(), 800);
  }
}

function dizzy(ms = DIZZY_MS) {
  clearTimeout(dizzyTimer);
  flags.add('dizzy');
  paintBody();
  dizzyTimer = setTimeout(() => { flags.delete('dizzy'); paintBody(); }, clampN(ms, 600, 6000));
}

// A move takes over his body, so whatever little habit he was in the middle of stops.
function endBit() {
  clearTimeout(bitTimer);
  if (bit) flags.delete(`bit-${bit}`);
  bit = null;
}

api.onMotion(msg => {
  const { kind, vx = 0 } = msg || {};
  // Beats that layer on top of whatever he's doing rather than replacing it.
  if (kind === 'lean') { setLean(vx); paintBody(); return; }
  if (kind === 'dizzy') { dizzy(msg.ms); return; }
  if (kind === 'wheee') {
    clearTimeout(wheeeTimer);
    flags.add('wheee');
    wheeeTimer = setTimeout(() => { flags.delete('wheee'); paintBody(); }, WHEEE_MS);
    paintBody();
    return;
  }
  for (const f of MOTION_FLAGS) flags.delete(f);
  clearTimeout(landedTimer);
  if (kind !== 'perched' && kind !== null) endBit();
  if (kind !== 'cling') setLean(0);
  if (kind === 'flying') {
    flags.add('flying');
    if (vx < 0) flags.add('fly-left');
    if (FLY_STYLES.has(msg.style)) flags.add(`fly-${msg.style}`);
    setDir(vx);
  }
  if (kind === 'walking') { flags.add('walking'); if (msg.dir < 0) flags.add('walk-left'); setDir(msg.dir); }
  if (kind === 'eyeing') { flags.add('eyeing'); setDir(msg.dx); }
  if (kind === 'crouch') { flags.add('crouch'); setDir(vx); }
  if (kind === 'hopping') {
    flags.add('hopping');
    if (msg.flip) flags.add('hop-flip');
    root.setProperty('--hop-ms', `${clampN(msg.ms, 200, 2000)}ms`);
    setDir(vx);
  }
  if (kind === 'landed') {
    flags.add('landed');
    puff();
    landedTimer = setTimeout(() => { flags.delete('landed'); paintBody(); }, 700);
    if (msg.dizzy) dizzy();
  }
  if (kind === 'cling') flags.add('cling');
  if (kind === 'scramble') flags.add('scramble');
  if (kind === 'coyote') flags.add('coyote');
  paintBody();
});

// ---- up on a window. Perched, everything but the crab himself lets the mouse
// through to the title bar under him, so main needs to know when the pointer
// is over him (the moves are forwarded even while the window ignores clicks).
let perched = false;
let overMe = false;
const setOver = over => { if (over !== overMe) { overMe = over; api.hit(over); } };
api.onPerch(msg => {
  perched = !!msg?.up;
  if (perched) flags.add('on-perch'); else flags.delete('on-perch');
  if (!perched) overMe = false;
  paintBody();
});
document.addEventListener('mousemove', e => {
  if (perched) setOver(!!e.target.closest?.('#crab, #bgBadge, #srvPill, .helper'));
});
document.addEventListener('mouseleave', () => { if (perched) setOver(false); });
window.addEventListener('contextmenu', e => { e.preventDefault(); api.menu(); });

// ---- drop files onto Shellby to attach them to a task
let dragDepth = 0;
const setDropping = on => {
  document.body.classList.toggle('dropping', on);
  document.body.classList.toggle('bubble-on', on || bubbleOn());
  bubbleText.textContent = on ? 'drop it!' : bubbleFor();
};
window.addEventListener('dragenter', e => { e.preventDefault(); if (dragDepth++ === 0) setDropping(true); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; setDropping(false); } });
window.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
window.addEventListener('drop', async e => {
  e.preventDefault();
  dragDepth = 0;
  setDropping(false);
  // A picture with no file behind it (dragged out of a browser) is saved first.
  const { paths } = await window.shellby.attachFiles([...e.dataTransfer.files]);
  if (paths.length) api.drop(paths);
});

// The focus countdown in his bubble ticks on its own between state updates.
// (So does the usage-limit countdown while he naps.) A file held over him keeps "drop it!".
setInterval(() => {
  if (molt || document.body.classList.contains('dropping')) return;
  // A line that has run out takes the bubble down with it, without waiting for
  // the next state push.
  if (say && !saying()) { say = null; paintBody(); return; }
  if ((focusing && state === 'idle') || (limit && state === 'sleeping')) bubbleText.textContent = bubbleFor();
}, 1000);

// ---- idle habits: he digs, polishes his shell, peeks about, flops over, and
// up on a window, sits on the edge or peers down over it. Which habit it is
// comes from main (src/main/voice.js, perching.js); the animation is one class
// per habit in critter.css, so an unknown one simply does nothing.
const BIT_MS = 2600;
let bitTimer = null;
let bit = null;
api.onBit(msg => {
  if (typeof msg?.bit !== 'string' || !/^[a-z]{2,12}$/.test(msg.bit)) return;
  endBit();
  if (msg.bit === 'none') return void paintBody(); // a scene was cut short
  if (msg.dir === 1 || msg.dir === -1) setDir(msg.dir); // a pounce goes toward your cursor
  bit = msg.bit;
  flags.add(`bit-${bit}`);
  paintBody();
  const ms = Number.isFinite(msg.ms) ? clampN(msg.ms, 400, 10000) : BIT_MS; // a scene's beats can be short
  bitTimer = setTimeout(() => { flags.delete(`bit-${bit}`); bit = null; paintBody(); }, ms);
});

// ---- a little chirp when he speaks (off by default; see chirp.js)
api.onChirp(msg => window.ShellbyChirp.play(msg?.occasion));

// ---- the screen is locked (or the machine is suspending): stop animating.
// He is on the wallpaper, so he animates all day; while the screen is off there
// is nothing to see and it is pure drain. Paused, not stopped, so unlocking
// picks up mid-breath. See watchIdleCost in src/main/main.js.
api.onCalm(msg => document.body.classList.toggle('calm-deep', !!msg?.calm));

// ---- and while you can see him, he moves at a pixel-art frame rate, not the
// screen's: a transparent window pays the GPU for every frame (shared/framecap.js).
window.ShellbyFrameCap.cap(document);

// ---- a friend's crab, visiting (src/main/friends.js). It stands closest to
// him, ahead of any helpers, and walks back off to the left when it's time.
const VISITOR_SCALE = 0.7; // must match VISITOR_SCALE in src/main/main.js
let visitorEl = null;
let visitorLook = null;
function visitorSprite() {
  return window.ShellbySprite.build(visitorLook.skin, { px: Math.max(1, px * VISITOR_SCALE), accessories: visitorLook.accessories || [], shell: visitorLook.shell || undefined, stickers: visitorLook.stickers || [] });
}
function visitorLeaves() {
  endTogether();
  const el = visitorEl;
  visitorEl = null;
  visitorLook = null;
  if (!el) return;
  el.style.left = `${el.offsetLeft}px`;
  el.classList.add('leaving');
  setTimeout(() => el.remove(), 900);
}
api.onVisitor(v => {
  if (!v?.look?.skin) return visitorLeaves();
  if (visitorEl?.dataset.login === v.login) return;
  visitorLeaves();
  visitorLook = v.look;
  const el = document.createElement('div');
  el.className = 'helper visitor';
  el.dataset.login = v.login;
  el.setAttribute('aria-label', `@${v.login}'s crab, visiting`);
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = `@${v.login}`;
  // What the visitor says back when the two of them talk (src/main/banter.js).
  const vbubble = document.createElement('span');
  vbubble.className = 'vbubble';
  vbubble.setAttribute('aria-hidden', 'true');
  el.append(tag, vbubble, visitorSprite());
  crewHost.prepend(el);
  visitorEl = el;
});
// A new size (Settings → Look) redraws the visitor along with everyone else.
api.onSkin(() => { if (visitorEl && visitorLook) visitorEl.querySelector('svg')?.replaceWith(visitorSprite()); });

// ---- the two of them doing something together: dance, party, high-five, sing.
// Main picks what and when (src/main/friends.js); the moves are one body class
// each in critter.css, and the notes and sparks float up from both crabs here.
const TOGETHER_BITS = { dance: ['♪', '♫'], sing: ['♪', '♫', '♪'], party: ['✦', '★'], highfive: ['✦'] };
let together = null;
let togetherTimers = [];
function endTogether() {
  togetherTimers.forEach(clearTimeout);
  togetherTimers = [];
  if (together) flags.delete(together);
  together = null;
  paintBody();
}
// A note or spark rising from a point in the window (fixed, so it can sit between the two).
function floatBit(text, x, y, delay) {
  const el = document.createElement('span');
  el.className = 'together-bit';
  el.textContent = text;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.animationDelay = `${delay}ms`;
  document.body.append(el);
  setTimeout(() => el.remove(), delay + 1600);
}
api.onTogether(msg => {
  const activity = typeof msg?.activity === 'string' && /^[a-z]{2,12}$/.test(msg.activity) ? msg.activity : null;
  if (!activity || !visitorEl) return;
  endTogether();
  together = `together-${activity}`;
  flags.add(together);
  paintBody();
  const me = crab.getBoundingClientRect(), them = visitorEl.getBoundingClientRect();
  const bits = TOGETHER_BITS[activity] || [];
  if (activity === 'highfive') {
    // A spark where they meet, each time the claws touch.
    const x = (them.right + me.left) / 2, y = me.top + me.height * 0.35;
    for (const d of [700, 2200, 3700]) floatBit(bits[0], x, y, d);
  } else {
    bits.forEach((b, i) => {
      floatBit(b, me.left + me.width * (0.3 + 0.2 * i), me.top + 4, i * 600);
      floatBit(bits[(i + 1) % bits.length], them.left + them.width * (0.3 + 0.2 * i), them.top + 4, 300 + i * 600);
    });
  }
  togetherTimers.push(setTimeout(endTogether, Math.min(Math.max(Number(msg.ms) || 5000, 1000), 10000)));
});

// ---- what src/renderer/critter/life.js needs from in here: his slots, a
// redraw, his body classes, and where the visitor is.
window.ShellbyCritter = {
  wear(slot, item) { if (item) overrides.set(slot, item); else overrides.delete(slot); drawSelf(); },
  flags, paint: paintBody, setDir, hearts,
  px: () => px,
  claw: () => skin?.anchors?.claw || window.ShellbySprite.DEFAULT_ANCHORS.claw,
  visitor: () => visitorEl,
};
