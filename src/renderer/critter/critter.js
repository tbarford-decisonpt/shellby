// signs.js, stickers.js, crew.js and motion.js are classic scripts loaded right
// after this one; they share its top-level scope (see critter.html).
/* global SIGNS:writable, catchHeld:writable, clawLoad:writable, heldItem:writable, helperHats:writable, helperSprite:writable, holdingSign:writable, renderCrew:writable, settled:writable, signKind:writable, throwHeld:writable, visitorEl:writable, wantsSign:writable */
/* exported HUES, clampN, crewHost, flinging */

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
let planning = false; // Claude is planning, not changing anything yet (plan mode)
let planReady = false; // ...and has a plan for you to read
// Things a scene or a game puts on him for a moment, by slot (src/renderer/critter/life.js).
const overrides = new Map();
// What he works with while Claude uses a tool, a scroll or a wrench (see
// "how he works" below). It beats his own held item and a scene's, and gives
// way to a sign or a sticker.
let tool = null;
const holdTool = item => { if (item === tool) return; tool = item || null; drawSelf(); };
// eslint-disable-next-line prefer-const -- signs.js sets it
let tossed = false;   // his own held item is out of his claw, from throw to catch
let flinging = false; // mid-throw: he has not got a claw on the sign yet
const healthFx = window.ShellbyHealthFx.mount(document.getElementById('healthFx'), document.getElementById('self'));
const helpers = new Map(); // task id -> element

api.onSkin(msg => {
  skin = msg.skin;
  px = msg.px;
  outfit = msg.outfit || outfit;
  document.documentElement.style.setProperty('--px', `${px}px`);
  document.documentElement.style.setProperty('--self-w', `${22 * px + 72}px`);
  drawSelf();
  for (const el of helpers.values()) el.querySelector('svg')?.replaceWith(helperSprite(el.dataset.hue, helperHats.get(el)));
  // Equipped effect (snow, bats, ...) plays around Shellby in flights now and then (effects.js FLIGHT); burst effects wait for a finished task.
  if (!fx) fx = window.ShellbyFx.mount(document.getElementById('fx'), null, { px: Math.max(2, Math.round(px * 0.75)), flights: true });
  // Real rain outside beats the snow he chose to wear.
  const effect = outfit.weather?.effect || outfit.effect;
  if (effect?.key !== shownEffect) { shownEffect = effect?.key ?? null; fx.set(effect); }
  // A shiver in the cold, a sweat in the heat, a flinch at thunder (critter.css, life.js).
  for (const m of WEATHER_MOODS) flags.delete(`weather-${m}`);
  if (WEATHER_MOODS.includes(outfit.weather?.mood)) flags.add(`weather-${outfit.weather.mood}`);
  paintBody();
  // The frame after his first drawing is when you can see him: what
  // scripts/perf-budget.js times a cold start to. One entry, never cleared.
  if (!performance.getEntriesByName('shellby:crab-painted').length) requestAnimationFrame(() => performance.mark('shellby:crab-painted'));
});
const WEATHER_MOODS = ['storm', 'cold', 'hot'];
let shownEffect; // the effect playing, so a skin broadcast that didn't change it doesn't restart the particles

// Work mode turns the confetti off; the moment still gets his mood and his line.
let confetti = true;
api.onBurst(effect => { if (fx && effect && confetti) fx.burst(effect); });

// Shellby himself. While he molts, the molt decides which shell he's in.
let molt = null; // { shell, bubble, stickers } during a molt
// eslint-disable-next-line prefer-const -- stickers.js sets it
let slap = null; // { id, holding, held } while a new sticker goes on (see onSticker)
function drawSelf() {
  if (!skin) return;
  const shell = molt ? molt.shell : outfit.home;
  // Between shells, whatever sits on the shell (a flag, bat wings) has nowhere to go.
  let accessories = molt?.shell === 'none' ? outfit.accessories.filter(a => a.slot !== 'shell') : outfit.accessories;
  // Dressed for the weather outside (src/main/weather.js): the sou'wester and
  // umbrella go over his own things, and everything below still outranks them.
  const gear = outfit.weather?.accessories || [];
  if (gear.length) accessories = [...accessories.filter(a => !gear.some(g => g.slot === a.slot)), ...gear];
  // On guard: the helmet goes on instead of whatever hat he wears.
  if (focusing?.phase === 'focus' && outfit.focusHelmet) accessories = [...accessories.filter(a => a.slot !== 'hat'), outfit.focusHelmet];
  // Something is playing: headphones on, unless he's already wearing the helmet.
  else if (outfit.musicHeadphones) accessories = [...accessories.filter(a => a.slot !== 'hat'), outfit.musicHeadphones];
  // Red CI wants the claw he carries things in: his own held item is in the air
  // (see throwHeld) and the sign goes in once he has let go of it.
  // A scene's prop or a find to show off takes its slot for a moment.
  for (const [slot, item] of overrides) accessories = [...accessories.filter(a => a.slot !== slot), item];
  if (tool) accessories = [...accessories.filter(a => a.slot !== 'held'), tool];
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
  // Planning reads differently from working, and a plan waiting differently from a yes/no.
  if (state === 'asking' && planReady) return 'plan?';
  if (state === 'working' && planning) return 'plan…';
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
// His needs (src/main/needs.js): the mood that shows and every meter that's low.
// Main only sends them while he's idle or asleep; needs.css draws them.
const NEED_MOODS = new Set(['happy', 'content', 'peckish', 'sandy', 'sleepy', 'mopey']);
const NEED_METERS = new Set(['fullness', 'tidiness', 'energy', 'cheer']);
let needs = null;
const needClasses = () => (needs ? [NEED_MOODS.has(needs.mood) ? `need-${needs.mood}` : '', ...(needs.low || []).filter(k => NEED_METERS.has(k)).map(k => `low-${k}`)] : []);
let stillNow = false; // calm from main (locked, covered, nobody at the desk): see api.onCalm

// ---- how he works (src/main/work-pose.js): reading, editing, running a
// command, thinking... one body class per pose in critter.css, and for most
// of them something in his claw (a scroll, a pencil, a wrench...). How long a
// pose holds, and what he holds, is shared/workposes.js (the OBS overlay works
// the same way). Anything else that has his body (a throw, a walk, a habit,
// typing along) outranks it, and he scuttles as he always did.
const WORK = window.ShellbyWorkPoses;
const SWAP_MS = 332; // into his shell for the next thing, and back out (two steps of the work beat)
// The claw dipping for the next tool is part of the pose, not something that takes it over.
const SHARES_BODY = f => f.startsWith('weather-') || f.startsWith('surface-') || f === 'on-perch' || f === 'tool-swap';
let swapTimers = [];
const poses = WORK.holder((shown, was) => {
  const item = shown ? WORK.ITEMS[shown] : null;
  swapTimers.forEach(clearTimeout);
  swapTimers = [];
  flags.delete('tool-swap');
  // From one thing in his claw to another while he works: the claw dips into
  // his shell, and comes back out with it.
  if (state === 'working' && was && WORK.ITEMS[was] !== item &&!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    flags.add('tool-swap');
    swapTimers = [
      setTimeout(() => holdTool(item), SWAP_MS / 2),
      setTimeout(() => { flags.delete('tool-swap'); paintBody(); }, SWAP_MS),
    ];
  } else {
    holdTool(item);
  }
  paintBody();
});
const poseClass = dropping => {
  const pose = poses.shown();
  return state === 'working' && pose && pose !== 'busy' && !molt && !dropping && ![...flags].some(f => !SHARES_BODY(f)) ? `work-${pose}` : '';
};

function paintBody() {
  const dropping = document.body.classList.contains('dropping');
  document.body.className = [
    `state-${state}`, bubbleOn() || dropping ? 'bubble-on' : '', health ? `health-${health.level}` : '',
    molt?.cls, dropping ? 'dropping' : '', ciFailing && state !== 'sleeping' ? 'ci-red' : '',
    focusing ? `focus-${focusing.phase}` : '', limit ? 'limited' : '', saying() ? 'saying' : '', onCall ? 'on-call' : '',
    planning && state === 'working' ? 'planning' : '', planReady && state === 'asking' ? 'plan-ready' : '',
    poseClass(dropping),
    stillNow ? 'calm-deep' : '', // kept through every repaint, or the next state push would wake him
    ...needClasses(), ...flags,
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
  planning = !!msg.planning;
  planReady = !!msg.plan;
  confetti = msg.confetti !== false;
  window.ShellbySound.setMix(msg.sound);
  needs = msg.needs && typeof msg.needs === 'object' ? msg.needs : null;
  const wasGuarding = focusing?.phase === 'focus';
  focusing = msg.focus || null;
  // The throw waits for him to settle, so that it runs into the sign going up
  // rather than happening somewhere behind the 'error' flash a red build sets off.
  if (wantsSign() && !tossed && settled() && heldItem()) throwHeld();
  if (!wantsSign() && tossed && settled()) catchHeld();
  if (wasGuarding !== (focusing?.phase === 'focus') || wasLoad !== clawLoad()) drawSelf();
  poses.set(msg.work, state === 'working'); // how he works, and what's in his claw for it
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
  if (skin) renderCrew(msg.crew || [], msg.moreCrew || 0, Array.isArray(msg.crewEnded) ? msg.crewEnded : []);
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

const root = document.documentElement.style;
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));
// Which way he's going, for anything that leans, flips or trails behind him.
const setDir = v => root.setProperty('--dir', v < 0 ? '-1' : '1');
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

// ---- a little chirp when he speaks, a ta-da for a big moment (off by default;
// see chirp.js and sound.js). Main decides whether; this only plays.
api.onChirp(msg => window.ShellbyChirp.play(msg?.occasion));
api.onSound(msg => { if (typeof msg?.cue === 'string') window.ShellbySound.cue(msg.cue, { data: msg }); });

// ---- the screen is locked (or the machine is suspending): stop animating.
// He is on the wallpaper, so he animates all day; while the screen is off there
// is nothing to see and it is pure drain. Paused, not stopped, so unlocking
// picks up mid-breath. See watchIdleCost in src/main/main.js.
api.onCalm(msg => {
  stillNow = !!msg?.calm;
  document.body.classList.toggle('calm-deep', stillNow);
  // Behind a window you can still hear him; only a locked screen fades the sea out.
  window.ShellbySound.setCalm(!!msg?.locked);
});

// ---- and while you can see him, he moves at a pixel-art frame rate, not the
// screen's: a transparent window pays the GPU for every frame (shared/framecap.js).
window.ShellbyFrameCap.cap(document);

// ---- Windows' animation effects off: critter.css stills his sprite, and main
// is told so his window holds still too (no strolls, climbs or flights).
const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const tellReduced = () => api.reducedMotion?.(reducedQuery.matches);
reducedQuery.addEventListener?.('change', tellReduced);
tellReduced();

// ---- his favourite Bugdex catch follows him round the desk, a step behind
// whichever way he faces, and bobs along faster when he walks. Its Bugdex
// portrait is drawn in finer pixels than his, so it stays the size the little
// 8×8 sprites were; small art (a hatchling) keeps his chunky pixels.
const buddyEl = document.getElementById('buddy');
const BUDDY_BOX = 8; // its longer side, in his pixels: at any size it stays in his slot, clear of the helpers (critter.css #buddy)
let buddyArt = null;
function drawBuddy() {
  const b = buddyArt;
  if (!b) { buddyEl.hidden = true; buddyEl.replaceChildren(); return; }
  const side = Math.max(b.pixels.length, ...b.pixels.map(r => r.length));
  const dpr = window.devicePixelRatio || 1;
  const fit = Math.max(1, Math.round(px * BUDDY_BOX * dpr / side)) / dpr; // whole screen pixels, so it stays crisp
  buddyEl.hidden = false;
  buddyEl.classList.toggle('ghost', !!b.ghost);
  buddyEl.replaceChildren(window.ShellbySprite.grid(b.pixels, b.palette, { px: Math.min(Math.max(2, Math.round(px * 0.85)), fit) }));
}
api.onBuddy(b => {
  buddyArt = b && Array.isArray(b.pixels) && b.pixels.length && b.palette ? b : null;
  drawBuddy();
});

// ---- what src/renderer/critter/life.js needs from in here: his slots, a
// redraw, his body classes, and where the visitor is.
window.ShellbyCritter = {
  // Clearing a slot that's already empty (a scene cancelled as a nap or a task
  // starts) leaves him be: a redraw would cut short the parts moving into the new mood.
  wear(slot, item) { if (!item && !overrides.has(slot)) return; if (item) overrides.set(slot, item); else overrides.delete(slot); drawSelf(); },
  flags, paint: paintBody, setDir, hearts,
  px: () => px,
  claw: () => skin?.anchors?.claw || window.ShellbySprite.DEFAULT_ANCHORS.claw,
  rows: () => skin?.pixels?.length || 0, // his height in sprite pixels, to put things on the ground beside him
  visitor: () => visitorEl,
};
