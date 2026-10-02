const crab = document.getElementById('crab');
const spriteHost = document.getElementById('sprite');
const bubbleText = document.getElementById('bubbleText');
const crewHost = document.getElementById('crew');
const countEl = document.getElementById('count');
const bgBadge = document.getElementById('bgBadge');
const api = window.shellby.critter;

const BUBBLES = { working: '', asking: '?', success: '✓', error: '!', learned: '✦', unlocked: '★', levelup: 'LV', molting: '', petted: '♥', cheer: 'green!', refreshed: 'ready!' };
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
let focusing = null; // { phase: 'focus' | 'break', endsAt } (src/main/focus.js)
let limit = null;    // { resetsAt }: napping until the usage limit resets (src/main/limits.js)
let say = null;      // { text, occasion, until }: what he's saying (src/main/voice.js)
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
const TOSS_MS = 620;  // how long what he was carrying stays in the air
const GRAB_MS = 560;  // ...and when the sign takes its place, once it is clear
const CATCH_MS = 520; // the drop back down once the build is green
let tossed = false;   // his own held item is out of his claw, from throw to catch
let flinging = false; // mid-throw: he has not got a claw on the sign yet
// He only holds the sign up on his feet: a nap, a molt or a throw has his claws busy.
const settled = () => state === 'idle' || state === 'working';
const holdingSign = () => ciFailing > 0 && !flinging && settled();
// Everything his claw can be carrying, so that a change of load triggers a redraw.
const clawLoad = () => (holdingSign() ? 'sign' : tossed ? 'empty' : 'own');
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
let molt = null; // { shell, bubble } during a molt
function drawSelf() {
  if (!skin) return;
  const shell = molt ? molt.shell : outfit.home;
  // Between shells, whatever sits on the shell (a flag, bat wings) has nowhere to go.
  let accessories = molt?.shell === 'none' ? outfit.accessories.filter(a => a.slot !== 'shell') : outfit.accessories;
  // On guard: the helmet goes on instead of whatever hat he wears.
  if (focusing?.phase === 'focus' && outfit.focusHelmet) accessories = [...accessories.filter(a => a.slot !== 'hat'), outfit.focusHelmet];
  // Red CI wants the claw he carries things in: his own held item is in the air
  // (see throwHeld) and the sign goes in once he has let go of it.
  if (tossed || holdingSign()) accessories = accessories.filter(a => a.slot !== 'held');
  if (holdingSign()) accessories = [...accessories, CI_SIGN];
  spriteHost.replaceChildren(window.ShellbySprite.build(skin, { px, accessories, shell }));
}

// A level-up unlocked a new shell: crawl out of the old one, shiver for a
// moment with no shell at all, then the new one drops onto his back.
let moltTimers = [];
api.onMolt(({ from, to, ms = 5200 }) => {
  moltTimers.forEach(clearTimeout); // a second level-up mid-molt starts over
  const beat = ms / 5;
  const step = (cls, shell, bubble) => {
    molt = { shell, bubble, cls };
    drawSelf();
    paintBody();
  };
  step('molt-out', from, '…');
  moltTimers = [
    setTimeout(() => step('molt-bare', 'none', 'eep!'), beat * 1.2),
    setTimeout(() => step('molt-in', to, 'new home!'), beat * 2.6),
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
  // His own voice comes last of the things that mean something, and still beats
  // the bare mood glyph it replaces.
  if (saying()) return say.text;
  return BUBBLES[state] ?? '';
}
const saying = () => !!say && say.until > Date.now();
const bubbleOn = () => state in BUBBLES || saying() || (health && HEALTH_BUBBLE_STATES.has(state)) || ((ciFailing > 0 || !!focusing) && state === 'idle') || (!!limit && state === 'sleeping');
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
    focusing ? `focus-${focusing.phase}` : '', limit ? 'limited' : '', saying() ? 'saying' : '', ...flags,
  ].filter(Boolean).join(' ');
  bubbleText.textContent = dropping ? 'drop it!' : bubbleFor();
}

api.onState(msg => {
  const wasLoad = clawLoad();
  state = msg.state;
  health = msg.health || null;
  level = msg.level || level;
  ciFailing = msg.ci?.failing || 0;
  limit = msg.limit || null;
  say = msg.say || null;
  const wasGuarding = focusing?.phase === 'focus';
  focusing = msg.focus || null;
  // The throw waits for him to settle, so that it runs into the sign going up
  // rather than happening somewhere behind the 'error' flash a red build sets off.
  if (ciFailing > 0 && !tossed && settled() && heldItem()) throwHeld();
  if (!ciFailing && tossed && settled()) catchHeld();
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
  countEl.textContent = msg.busy;
  countEl.classList.toggle('on', msg.busy > 1);
  countEl.setAttribute('aria-label', `${msg.busy} conversations running`);
  if (skin) renderCrew(msg.crew || [], msg.moreCrew || 0);
});

// ---- click vs drag (pointer capture keeps drags alive past the window edge)
let down = null;
let dragging = false;
bgBadge.addEventListener('click', () => api.bgClick());
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
});
crab.addEventListener('pointerleave', () => { rub = { x: null, dir: 0, turns: [] }; });
function hearts() {
  for (let i = 0; i < 3; i++) {
    const el = document.createElement('span');
    el.textContent = '♥';
    el.style.setProperty('--dx', `${(i - 1) * 14}px`);
    el.style.animationDelay = `${i * 140}ms`;
    heartsHost.append(el);
    setTimeout(() => el.remove(), 1700);
  }
}

// ---- thrown, landing, strolling (main moves the window; see src/main/motion.js)
const MOTION_FLAGS = ['flying', 'fly-left', 'landed', 'walking'];
let landedTimer = null;
api.onMotion(({ kind, vx = 0 }) => {
  for (const f of MOTION_FLAGS) flags.delete(f);
  clearTimeout(landedTimer);
  if (kind === 'flying') { flags.add('flying'); if (vx < 0) flags.add('fly-left'); }
  if (kind === 'walking') flags.add('walking');
  if (kind === 'landed') { flags.add('landed'); landedTimer = setTimeout(() => { flags.delete('landed'); paintBody(); }, 700); }
  paintBody();
});
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
window.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  setDropping(false);
  const paths = window.shellby.pathsForFiles(e.dataTransfer.files);
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

// ---- idle habits: he digs, polishes his shell, peeks about, flops over.
// Which habit it is comes from main (src/main/voice.js); the animation is one
// class per habit in critter.css, so an unknown one simply does nothing.
const BIT_MS = 2600;
let bitTimer = null;
let bit = null;
api.onBit(msg => {
  if (typeof msg?.bit !== 'string' || !/^[a-z]{2,12}$/.test(msg.bit)) return;
  clearTimeout(bitTimer);
  if (bit) flags.delete(`bit-${bit}`);
  bit = msg.bit;
  flags.add(`bit-${bit}`);
  paintBody();
  bitTimer = setTimeout(() => { flags.delete(`bit-${bit}`); bit = null; paintBody(); }, BIT_MS);
});

// ---- a little chirp when he speaks (off by default; see chirp.js)
api.onChirp(msg => window.ShellbyChirp.play(msg?.occasion));

// ---- the screen is locked (or the machine is suspending): stop animating.
// He is on the wallpaper, so he animates all day; while the screen is off there
// is nothing to see and it is pure drain. Paused, not stopped, so unlocking
// picks up mid-breath. See watchIdleCost in src/main/main.js.
api.onCalm(msg => document.body.classList.toggle('calm-deep', !!msg?.calm));
