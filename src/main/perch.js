// Shellby perches on your windows: he hops up onto a title bar, potters along
// it, hangs on when you drag it, gets flung off when you shake it, and drops
// when it closes. This is the geometry and the judgement calls, all pure: no
// timers, no I/O, no Win32 (see perching.js for the wiring, test/perch.test.js).
//
// Units are DIPs and ms. "Center" x is the middle of his sprite; window
// positions are the critter window's top-left, as in motion.js.
//   geo: { width, height, foot, half, headroom }: his window size, how far his
//        feet sit above its bottom edge, half his sprite's width, and the room
//        he needs above a title bar to fit at all.

const { releaseVelocity, planStroll } = require('./motion');

// The walkable part of a title bar: clear of the min/max/close buttons and the
// app icon, so he never sits on something you're about to click.
const CAPTION_RIGHT = 140;
const CAPTION_LEFT = 30;
const MIN_FRAME_W = 320;
const MIN_FRAME_H = 160;
const MIN_LEDGE = 60;   // anything shorter isn't worth climbing onto
const SINK = 2;         // feet sit this far into the frame's top edge, so he's on it rather than above it

// Holding on while the window moves: a stiff spring sideways (he grips) and a
// bouncy one up and down (he jolts), so he rides it rather than being glued to it.
const SPRING_X = { k: 900, zeta: 0.5 };
const SPRING_Y = { k: 520, zeta: 0.32 };
const MAX_LAG = 28;

// When he lets go.
const LETGO_SPEED = 2600;       // a hard yank
const BRAKE_FROM = 1500;        // ...or a fast drag that stops dead: he keeps going
const BRAKE_TO = 160;
const SHAKE_REVERSALS = 3;      // back-and-forth swings within SHAKE_MS
const SHAKE_MS = 1000;
const MIN_SWING = 18;           // a swing shorter than this is a wobble, not a shake
const CLING_SPEED = 60;         // the window is moving: grip
const CLING_HOLD_MS = 350;      // and keep gripping a moment after it stops
const COYOTE_MS = 420;          // the floor's gone and he hasn't noticed yet
const SAMPLE_KEEP_MS = 1200;

const WALK_SPEED = 42;
const SCRAMBLE_SPEED = 170;     // the bar shrank out from under him

const SKIP_CLASSES = new Set([
  'Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'Windows.UI.Core.CoreWindow',
  'MultitaskingViewFrame', 'XamlExplorerHostIslandWindow', 'ForegroundStaging', 'Ghost', '#32768',
  'tooltips_class32', 'NotifyIconOverflowWindow', 'TopLevelWindowForOverflowXamlIsland',
  'Shell_InputSwitchTopLevelWindow', 'SysShadow', 'Windows.Internal.Shell.TabProxyWindow',
]);

// How keen he is, by setting (chance per idle tick) and by temperament.
const CHANCE = Object.freeze({ off: 0, sometimes: 0.12, often: 0.3 });
const COOLDOWN = Object.freeze({ off: Infinity, sometimes: 90 * 1000, often: 30 * 1000 });
const KEEN = Object.freeze({ cocky: 1.4, chipper: 1.2, fussy: 0.6, sleepy: 0.75 });
const STAY = Object.freeze({ cocky: 1, chipper: 1, fussy: 0.6, sleepy: 1.5 });
const STAY_MIN = 2 * 60 * 1000;
const STAY_MAX = 6 * 60 * 1000;
const SETTINGS = Object.freeze(['off', 'sometimes', 'often']);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------- which windows

/**
 * Can he sit on this window? `info` is native-windows' describe() with `frame`
 * converted to DIPs ({ x, y, width, height }) and the work area it's on.
 */
function perchable(info, { ownPids = new Set(), ignore = new Set(), geo }) {
  if (!info || info.gone || !info.frame || !info.workArea) return false;
  if (!info.visible || info.minimized || info.maximized || info.cloaked || info.hung) return false;
  if (!info.captioned || info.child || info.tool || info.topmost || info.noActivate || info.clickThrough || info.owned) return false;
  if (ownPids.has(info.pid) || SKIP_CLASSES.has(info.cls) || ignore.has(info.exe)) return false;
  const f = info.frame;
  if (f.width < MIN_FRAME_W || f.height < MIN_FRAME_H) return false;
  if (f.y - info.workArea.y < geo.headroom) return false; // no room above it for him
  if (f.y >= info.workArea.y + info.workArea.height - geo.foot) return false; // title bar under the taskbar
  return !!ledgeOf(f, info.workArea, geo);
}

/** Where his center can be along a title bar: { x1, x2, y }, or null if there's no room. */
function ledgeOf(frame, workArea, geo) {
  const x1 = Math.max(frame.x + CAPTION_LEFT, workArea.x) + geo.half;
  const x2 = Math.min(frame.x + frame.width - CAPTION_RIGHT, workArea.x + workArea.width) - geo.half;
  return x2 - x1 >= MIN_LEDGE ? { x1, x2, y: frame.y } : null;
}

/** His window position with his center at `cx` and his feet on `y`. */
function standAt(cx, y, geo) {
  return { x: Math.round(cx - geo.width / 2), y: Math.round(y - geo.height + geo.foot + SINK) };
}

const centerOf = (pos, geo) => pos.x + geo.width / 2;

/** Subtract [a, b] from each interval in `list`. */
function cut(list, a, b) {
  return list.flatMap(([x1, x2]) => {
    if (b <= x1 || a >= x2) return [[x1, x2]];
    return [[x1, a], [b, x2]].filter(([p, q]) => q - p > 0);
  });
}

/**
 * The bits of title bar he could actually land on and be seen: each perchable
 * window's ledge, minus wherever a window above it covers the spot he'd stand
 * in. `windows` is top-first (the z-order), each { hwnd, frame, workArea, ok }.
 * Returns [{ hwnd, x1, x2, y }] in center coordinates.
 */
function visibleLedges(windows, geo) {
  const out = [];
  windows.forEach((w, i) => {
    if (!w.ok) return;
    const ledge = ledgeOf(w.frame, w.workArea, geo);
    if (!ledge) return;
    const top = ledge.y - geo.height * 0.55, bottom = ledge.y + 4;
    let free = [[ledge.x1, ledge.x2]];
    for (const above of windows.slice(0, i)) {
      const f = above.frame;
      if (!f || f.y >= bottom || f.y + f.height <= top) continue;
      free = cut(free, f.x - geo.half, f.x + f.width + geo.half);
    }
    for (const [x1, x2] of free) if (x2 - x1 >= MIN_LEDGE / 2) out.push({ hwnd: w.hwnd, x1, x2, y: ledge.y });
  });
  return out;
}

/** Ledges as motion.js flight wants them: in window coordinates, id = hwnd. */
const flightLedges = (segments, geo) => segments.map(s => {
  const a = standAt(s.x1, s.y, geo), b = standAt(s.x2, s.y, geo);
  return { id: s.hwnd, x1: a.x, x2: b.x, y: a.y };
});

/** The segment his feet are on (or nearly: a drop just above a title bar counts). */
function ledgeUnder(pos, segments, geo, slack = 26) {
  const cx = centerOf(pos, geo);
  return segments.find(s => cx >= s.x1 && cx <= s.x2 && Math.abs(standAt(cx, s.y, geo).y - pos.y) <= slack) || null;
}

/** A landing spot on `seg` near where he's coming from, a little way in from the end. */
function pickSpot(seg, fromX, rand = Math.random) {
  const inward = 20 + rand() * 70;
  const near = clamp(fromX, seg.x1, seg.x2);
  const mid = (seg.x1 + seg.x2) / 2;
  return Math.round(clamp(near + Math.sign(mid - near) * Math.min(inward, Math.abs(mid - near)), seg.x1, seg.x2));
}

// ---------------------------------------------------------------- the hop

/** How long a hop of this size takes (ms). */
const hopDuration = (from, to) => Math.round(clamp(420 + Math.hypot(to.x - from.x, to.y - from.y) * 0.42, 480, 1100));

/** How high above the straight line the arc rises, so he clears the target's lip. */
const hopLift = (from, to) => clamp(Math.abs(to.y - from.y) * 0.45 + 70, 70, 280);

/**
 * Where he is `t` (0..1) of the way through a hop. x moves at a constant speed
 * and y follows a parabola, like a real jump; `to` may move between calls (the
 * window he's aiming at is being dragged), and the arc simply bends to follow.
 */
function hopPoint(from, to, t, lift = hopLift(from, to)) {
  const u = clamp(t, 0, 1);
  return {
    x: Math.round(from.x + (to.x - from.x) * u),
    y: Math.round(from.y + (to.y - from.y) * u - 4 * lift * u * (1 - u)),
  };
}

/** Long hops get a somersault. */
const hopFlips = (from, to) => Math.hypot(to.x - from.x, to.y - from.y) > 420;

// ---------------------------------------------------------------- riding

/** One spring step toward `target`. Returns { p, v }. */
function spring(p, v, target, dtMs, { k, zeta }) {
  const dt = dtMs / 1000;
  const c = 2 * zeta * Math.sqrt(k);
  const nv = v + (-k * (p - target) - c * v) * dt;
  return { p: p + nv * dt, v: nv };
}

/** Back-and-forth swings in the window's recent horizontal movement. */
function reversals(samples, now, windowMs = SHAKE_MS) {
  const recent = samples.filter(s => now - s.t <= windowMs);
  let count = 0, dir = 0, leg = 0;
  for (let i = 1; i < recent.length; i++) {
    const dx = recent[i].x - recent[i - 1].x;
    if (!dx) continue;
    const d = Math.sign(dx);
    if (d === dir || !dir) { leg += Math.abs(dx); dir = d; continue; }
    if (leg >= MIN_SWING) count += 1;
    dir = d;
    leg = Math.abs(dx);
  }
  return count;
}

/** Peak speed in the samples over the last `ms`, with its velocity. */
function peakVelocity(samples, now, ms = 220) {
  let best = { vx: 0, vy: 0, speed: 0 };
  const recent = samples.filter(s => now - s.t <= ms);
  for (let i = 1; i < recent.length; i++) {
    const dt = (recent[i].t - recent[i - 1].t) / 1000;
    if (dt <= 0.004) continue;
    const vx = (recent[i].x - recent[i - 1].x) / dt, vy = (recent[i].y - recent[i - 1].y) / dt;
    const speed = Math.hypot(vx, vy);
    if (speed > best.speed) best = { vx, vy, speed };
  }
  return best;
}

/**
 * Does he let go? From the window's recent positions [{ x, y, t }].
 * { off, dizzy, vx, vy, why: 'yank' | 'brake' | 'shake' }
 */
/**
 * How many sample-to-sample steps in a row the window has been moving, ending
 * at the newest sample (`trailing`), and the longest such run in the last `ms`.
 * A drag is a run; a window snapped across the screen (Win+←) is one big step.
 */
function movingRuns(samples, now, ms = 220) {
  const recent = samples.filter(s => now - s.t <= ms);
  let run = 0, longest = 0;
  for (let i = 1; i < recent.length; i++) {
    const moved = Math.hypot(recent[i].x - recent[i - 1].x, recent[i].y - recent[i - 1].y) >= 2;
    run = moved ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return { trailing: run, longest };
}

function judgeRide(samples, now) {
  const v = releaseVelocity(samples);
  const speed = Math.hypot(v.vx, v.vy);
  const swings = reversals(samples, now);
  if (swings >= SHAKE_REVERSALS) return { off: true, dizzy: true, vx: v.vx * 0.9, vy: Math.min(v.vy, 0) - 650, why: 'shake' };
  // Speed only counts once the window has been moving for a few frames: a
  // snap or a jump is one step, and he just holds on through it.
  const runs = movingRuns(samples, now);
  // Already being swung back and forth when the big yank comes: he lands
  // seeing stars. One clean yank in one direction is just a fling.
  if (speed >= LETGO_SPEED && runs.trailing >= 2) return { off: true, dizzy: swings >= 1, vx: v.vx * 0.85, vy: Math.min(v.vy * 0.85, 0) - 450, why: 'yank' };
  // Fast a moment ago, stopped dead now: the window stops, he doesn't. Only a
  // drag in one direction; mid-shake, every swing "stops" for an instant.
  const peak = peakVelocity(samples, now);
  if (!swings && runs.longest >= 3 && peak.speed >= BRAKE_FROM && speed <= BRAKE_TO) {
    return { off: true, dizzy: false, vx: peak.vx * 0.75, vy: Math.min(peak.vy * 0.5, 0) - 380, why: 'brake' };
  }
  return { off: false, dizzy: false, vx: v.vx, vy: v.vy, why: null, speed };
}

/**
 * What became of the window he's on. `read` is native quick() with `frame` in
 * DIPs and its `workArea`: 'gone' | 'minimized' | 'hidden' | 'maxed' | 'ok'.
 */
function classify(read, geo) {
  if (!read || read.gone || !read.frame) return 'gone';
  if (read.minimized) return 'minimized';
  if (!read.visible || read.cloaked || read.hung) return 'hidden';
  if (read.maximized || (read.workArea && read.frame.y - read.workArea.y < geo.headroom * 0.5)) return 'maxed';
  return 'ok';
}

/** A fresh ride on the window with frame `frame`, his center at `cx`. */
function startRide({ hwnd, frame, cx, now, at }) {
  return {
    hwnd,
    offset: cx - frame.x,
    frame,
    samples: [{ x: frame.x, y: frame.y, t: now }],
    body: { x: at.x, y: at.y, vx: 0, vy: 0 },
    mode: 'sit', // sit | walk | cling | scramble | coyote
    walkTo: null,
    clingUntil: 0,
    coyote: null,
    distance: 0,
    scrambled: false,
  };
}

/** Send him for a little walk along the bar. Returns a new state (or the same one if there's no room). */
function strollOnLedge(state, read, geo, rand = Math.random) {
  if (!read?.frame || state.mode !== 'sit') return state;
  const ledge = ledgeOf(read.frame, read.workArea, geo);
  if (!ledge) return state;
  const box = { minX: ledge.x1 - read.frame.x, maxX: ledge.x2 - read.frame.x };
  const to = planStroll(state.offset, state.offset, box, rand);
  return to == null ? state : { ...state, mode: 'walk', walkTo: to };
}

/**
 * One frame of riding. Returns { state, place, events, release, lean }:
 *   place:   where his window goes this frame
 *   events:  things that just happened, in order ('cling', 'settle', 'walked',
 *            'scramble', 'coyote:<why>', 'fall', 'pop', 'letgo:<why>')
 *   release: { vx, vy, style, dizzy } when he leaves the window this frame
 *   lean:    the window's horizontal speed, for his lean and the wind lines
 */
function rideStep(prev, read, now, dtMs, geo) {
  const dt = Math.min(dtMs, 50);
  const events = [];
  let s = prev;
  const hold = () => ({ x: Math.round(s.body.x), y: Math.round(s.body.y) });

  if (s.coyote) {
    if (now >= s.coyote.until) return { state: s, place: hold(), events: ['fall'], release: { vx: 0, vy: 40, style: 'fall', dizzy: false }, lean: 0 };
    return { state: s, place: hold(), events, release: null, lean: 0 };
  }

  const what = classify(read, geo);
  if (what === 'maxed') {
    return { state: s, place: hold(), events: ['pop'], release: { vx: (s.offset < s.frame.width / 2 ? -1 : 1) * 260, vy: -1100, style: 'pop', dizzy: false }, lean: 0 };
  }
  if (what !== 'ok') {
    s = { ...s, mode: 'coyote', coyote: { until: now + COYOTE_MS, why: what } };
    return { state: s, place: hold(), events: [`coyote:${what}`], release: null, lean: 0 };
  }

  const frame = read.frame;
  const samples = [...s.samples.filter(p => now - p.t <= SAMPLE_KEEP_MS), { x: frame.x, y: frame.y, t: now }];
  const moved = Math.hypot(frame.x - s.frame.x, frame.y - s.frame.y);
  s = { ...s, samples, frame, distance: s.distance + moved };

  const judged = judgeRide(samples, now);
  if (judged.off) {
    return {
      state: s, place: hold(), events: [`letgo:${judged.why}`],
      release: { vx: judged.vx, vy: judged.vy, style: 'fling', dizzy: judged.dizzy }, lean: judged.vx,
    };
  }

  // Where along the bar he wants to be.
  const ledge = ledgeOf(frame, read.workArea, geo);
  let offset = s.offset;
  let mode = s.mode;
  const step = speed => speed * dt / 1000;
  if (mode === 'walk' && s.walkTo != null) {
    const d = s.walkTo - offset;
    if (Math.abs(d) <= step(WALK_SPEED)) { offset = s.walkTo; mode = 'sit'; events.push('walked'); } else offset += Math.sign(d) * step(WALK_SPEED);
  }
  let scrambled = s.scrambled;
  const cx = frame.x + offset;
  const lip = geo.half * 0.35;
  if (cx < frame.x + lip || cx > frame.x + frame.width - lip || !ledge) {
    // Nothing under his feet any more: the window was resized away from him.
    s = { ...s, mode: 'coyote', coyote: { until: now + COYOTE_MS, why: 'edge' } };
    return { state: s, place: hold(), events: [...events, 'coyote:edge'], release: null, lean: 0 };
  }
  if (cx < ledge.x1 || cx > ledge.x2) {
    const want = clamp(cx, ledge.x1, ledge.x2) - frame.x;
    offset += clamp(want - offset, -step(SCRAMBLE_SPEED), step(SCRAMBLE_SPEED));
    if (!scrambled) events.push('scramble');
    scrambled = true;
    mode = mode === 'cling' ? 'cling' : 'scramble';
  } else if (mode === 'scramble') {
    mode = 'sit';
    scrambled = false;
  }

  // Grip while it moves; let go of the grip a beat after it stops.
  const speed = Math.hypot(judged.vx, judged.vy);
  let clingUntil = s.clingUntil;
  if (speed > CLING_SPEED || moved > 2) {
    if (mode !== 'cling') events.push('cling');
    mode = 'cling';
    clingUntil = now + CLING_HOLD_MS;
  } else if (mode === 'cling' && now >= clingUntil) {
    mode = 'sit';
    events.push('settle');
  }

  const target = standAt(frame.x + offset, frame.y, geo);
  const sx = spring(s.body.x, s.body.vx, target.x, dt, SPRING_X);
  const sy = spring(s.body.y, s.body.vy, target.y, dt, SPRING_Y);
  const body = {
    x: clamp(sx.p, target.x - MAX_LAG, target.x + MAX_LAG), vx: sx.v,
    y: clamp(sy.p, target.y - MAX_LAG, target.y + MAX_LAG), vy: sy.v,
  };
  s = { ...s, offset, mode, clingUntil, scrambled, walkTo: mode === 'walk' ? s.walkTo : null, body };
  // Sitting, sprung into place and nothing moving: the caller can look less often.
  const settled = mode === 'sit' && Math.abs(body.x - target.x) < 0.5 && Math.abs(body.y - target.y) < 0.5 && Math.abs(body.vx) < 2 && Math.abs(body.vy) < 2;
  return { state: s, place: hold(), events, release: null, lean: judged.vx, settled };
}

// ---------------------------------------------------------------- his choices

const settingOf = v => (SETTINGS.includes(v) ? v : 'sometimes');

/** Does he fancy going up this idle tick? */
function wantsToPerch({ setting, temperament, sinceLast }, rand = Math.random) {
  const s = settingOf(setting);
  if (s === 'off' || sinceLast < COOLDOWN[s]) return false;
  return rand() < CHANCE[s] * (KEEN[temperament] || 1);
}

/** How long he stays up before hopping down (ms). */
function stayFor(temperament, rand = Math.random) {
  return Math.round((STAY_MIN + rand() * (STAY_MAX - STAY_MIN)) * (STAY[temperament] || 1));
}

/**
 * Which ledge to go for: the window you're using if he can see it, sometimes
 * his favourite app instead. `segments` are visibleLedges() with an `exe`.
 */
function chooseLedge(segments, { foreground, favourite, fromX }, rand = Math.random) {
  if (!segments.length) return null;
  const nearest = list => list.reduce((best, s) => {
    const d = Math.abs(clamp(fromX, s.x1, s.x2) - fromX);
    return !best || d < best.d ? { s, d } : best;
  }, null)?.s || null;
  const fav = favourite ? segments.filter(s => s.exe === favourite) : [];
  if (fav.length && rand() < 0.3) return nearest(fav);
  const fg = segments.filter(s => s.hwnd === foreground);
  return fg.length ? nearest(fg) : null;
}

/** Perch counts per app, capped so it can't grow forever. A new object. */
function recordPerch(stats, exe) {
  const by = stats && typeof stats.byExe === 'object' && stats.byExe ? stats.byExe : {};
  if (typeof exe !== 'string' || !/^[\w .()+-]{1,64}\.exe$/i.test(exe)) return { byExe: { ...by } };
  const next = { ...by, [exe]: (Number(by[exe]) || 0) + 1 };
  const kept = Object.entries(next).sort((a, b) => b[1] - a[1]).slice(0, 30);
  return { byExe: Object.fromEntries(kept) };
}

/** His most-perched app, once he's been up there a few times. */
function favouriteOf(stats) {
  const entries = Object.entries(stats?.byExe || {}).filter(([, n]) => Number(n) >= 3);
  return entries.length ? entries.sort((a, b) => b[1] - a[1])[0][0] : null;
}

/** "Spotify" from "spotify.exe", for the menu. */
const appName = exe => {
  const base = String(exe || '').replace(/\.exe$/i, '');
  return base ? base[0].toUpperCase() + base.slice(1) : 'this app';
};

module.exports = {
  SETTINGS, COYOTE_MS, LETGO_SPEED, SHAKE_REVERSALS, CAPTION_RIGHT, CAPTION_LEFT, SINK,
  perchable, ledgeOf, standAt, centerOf, visibleLedges, flightLedges, ledgeUnder, pickSpot,
  hopDuration, hopLift, hopPoint, hopFlips,
  spring, reversals, peakVelocity, movingRuns, judgeRide, classify, startRide, strollOnLedge, rideStep,
  settingOf, wantsToPerch, stayFor, chooseLedge, recordPerch, favouriteOf, appName,
};
