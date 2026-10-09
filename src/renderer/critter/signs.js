// A classic script that shares critter.js's top-level scope (critter.html
// loads it right after critter.js). The signs he holds up (red CI, a crashed
// server, a call) and throwing his own held item out of the way for them.
/* global ciFailing:writable, drawSelf:writable, flags:writable, flinging:writable, onCall:writable, outfit:writable, paintBody:writable, px:writable, serversDown:writable, skin:writable, state:writable, tossed:writable */
/* exported SIGNS, catchHeld, clawLoad, throwHeld */

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
  // Lined as it was in his claw; the line is a pixel all round, so it starts a pixel up and left.
  tossHost.replaceChildren(window.ShellbySprite.grid(item.pixels, item.palette, { px, ink: true }));
  tossHost.style.left = `${(cx - item.pivot[0] - 1) * px}px`;
  tossHost.style.top = `${(cy - item.pivot[1] - 1) * px}px`;
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
