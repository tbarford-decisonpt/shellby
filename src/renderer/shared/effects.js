// Particle effects around Shellby (snow, bats, leaves, hearts, fireflies,
// sparkles, confetti). Data-driven: an effect is { motion, count, speed, ink,
// fps, sprites[] } from a wardrobe pack, each sprite { palette, pixels, frames? }.
//
// Drawn the way he is: a particle moves in whole art pixels and never turns,
// squashes or blurs. Each one's path is worked out here as a list of holds
// (where it sits, shown or not, for how many ticks of the 12 fps clock his
// window already runs on, shared/framecap.js) and played as a Web Animation
// with step easing. The strict CSP allows that where an inline <style> would
// not, and framecap only presents a frame when a particle actually steps. Wings
// flap, sparkles twinkle and fireflies glow through the sprite's own frames,
// laid side by side in one strip that steps along behind a window.
(function (root) {
  const MOTIONS = ['fall', 'rise', 'float', 'orbit', 'twinkle', 'burst'];
  const TICK = 1000 / 12; // ms, framecap's clock
  // Seconds one pass takes at speed 1.
  const BASE = { fall: 5.5, rise: 4.5, float: 6, orbit: 5, twinkle: 2.6, burst: 1.1 };
  // Passes baked into one loop of a falling or rising particle, each in its own
  // column, so the loop doesn't read as one flake on rails.
  const LANES = 3;
  const TAU = Math.PI * 2;
  const RESIZE_SETTLE_MS = 200;
  // A burst's whole run: its flight, its start up to a tick late, and slack.
  const BURST_MS = Math.ceil(BASE.burst * 1000 + 2 * TICK + 300);

  const between = (r, a, b) => a + r() * (b - a);
  const pick = (r, a, b) => Math.min(b, a + Math.floor(r() * (b - a + 1))); // an integer a..b
  const ticksOf = s => Math.max(1, Math.round(s * 1000 / TICK));

  // How `cells` of travel fit in `seconds`: a step of `jump` cells every `per`
  // ticks. Slow things move a pixel at a time; rain moves several.
  function pace(cells, seconds) {
    const ticks = ticksOf(seconds);
    if (ticks >= cells) return { per: Math.max(1, Math.round(ticks / cells)), jump: 1 };
    return { per: 1, jump: Math.ceil(cells / ticks) };
  }

  // A hold is { x, y, on, t }: top-left in cells, shown or not, for t ticks.
  // One that sits where the last one did just lengthens it.
  function push(holds, x, y, on, t) {
    const last = holds[holds.length - 1];
    if (last && last.x === x && last.y === y && last.on === on) last.t += t;
    else holds.push({ x, y, on, t });
  }
  // Blinks in place: `pattern` is ticks shown, hidden, shown... (the old
  // consoles' way out, where a fade would need colours the sprite hasn't got).
  function blink(holds, x, y, pattern) {
    pattern.forEach((t, i) => push(holds, x, y, i % 2 === 0, t));
  }

  // Each path gets the field { wc, hc, sw, sh, rc, speed }: the layer and the
  // sprite in cells, the orbit's radius in cells, and the effect's speed; then
  // the random source and { i, n, frames, fpt, px }: which particle of how many,
  // the sprite's pictures, ticks per picture and the size of a cell.

  function fall(o, r) {
    const holds = [];
    const top = -o.sh;
    const floor = Math.max(top + 4, o.hc - o.sh);
    const lands = o.speed < 2; // snow and leaves settle and blink away; rain just ends
    for (let lane = 0; lane < LANES; lane++) {
      const x0 = pick(r, 0, Math.max(0, o.wc - o.sw));
      const amp = pick(r, 0, 2), wave = pick(r, 10, 18), phase = between(r, 0, TAU);
      const { per, jump } = pace(floor - top, BASE.fall / o.speed * between(r, 0.8, 1.25));
      let x = x0;
      for (let y = top, i = 0; y < floor; y += jump, i++) {
        x = x0 + Math.round(amp * Math.sin(i / wave * TAU + phase));
        push(holds, x, y, true, per);
      }
      if (lands) blink(holds, x, floor, [8, 2, 2, 2, 2]);
      push(holds, x, floor, false, pick(r, 1, 6));
    }
    return { holds };
  }

  function rise(o, r) {
    const holds = [];
    for (let lane = 0; lane < LANES; lane++) {
      const x0 = pick(r, 0, Math.max(0, o.wc - o.sw));
      const y0 = Math.round(o.hc * 0.8) - o.sh + pick(r, -2, 2);
      const cells = Math.max(6, Math.round(o.hc * 0.55) + pick(r, -3, 3));
      const amp = pick(r, 0, 2), wave = pick(r, 8, 14), phase = between(r, 0, TAU);
      const { per, jump } = pace(cells, BASE.rise / o.speed * between(r, 0.8, 1.25));
      let x = x0, y = y0;
      for (let i = 0; i * jump < cells; i++) {
        x = x0 + Math.round(amp * Math.sin(i / wave * TAU + phase));
        y = y0 - i * jump;
        push(holds, x, y, true, per);
      }
      blink(holds, x, y, [2, 1, 1, 1, 1]); // pops
      push(holds, x, y, false, pick(r, 2, 8));
    }
    return { holds };
  }

  // A slow figure of eight round a spot, a tick at a time.
  function float(o, r) {
    const holds = [];
    const ax = pick(r, 2, 5), ay = pick(r, 1, 3), phase = between(r, 0, TAU);
    const x0 = pick(r, ax, Math.max(ax, o.wc - o.sw - ax));
    const y0 = pick(r, Math.round(o.hc * 0.08) + ay, Math.max(ay, Math.round(o.hc * 0.92) - o.sh - ay));
    const period = ticksOf(BASE.float * 2 / o.speed * between(r, 0.8, 1.25));
    const every = Math.max(1, Math.round(period / 120)); // a slow one samples less often, not more keyframes
    for (let t = 0; t < period; t += every) {
      const a = t / period * TAU;
      push(holds, x0 + Math.round(ax * Math.sin(a)), y0 + Math.round(ay * Math.sin(2 * a + phase)), true, Math.min(every, period - t));
    }
    return { holds };
  }

  // Round his middle on a flattened ring, the n of them evenly spaced; the ring
  // isn't squashed, only the path, so the sprites stay square.
  function orbit(o, r, { i, n }) {
    const holds = [];
    const cx = o.wc / 2, cy = o.hc * 0.52;
    const rc = Math.max(4, o.rc + pick(r, -1, 1));
    const lap = ticksOf(BASE.orbit / o.speed);
    // About two cells a step; fewer when a fast lap has fewer ticks than that.
    const steps = Math.min(96, lap, Math.max(12, Math.round(TAU * rc / 2)));
    const per = Math.max(1, Math.round(lap / steps));
    for (let k = 0; k < steps; k++) {
      const a = k / steps * TAU;
      const bob = Math.round(Math.sin(a * 4 + i));
      push(holds, Math.round(cx + rc * Math.cos(a) - o.sw / 2), Math.round(cy + rc * 0.62 * Math.sin(a) - o.sh / 2) + bob, true, per);
    }
    const total = holds.reduce((s, h) => s + h.t, 0);
    return { holds, delay: -Math.round(total * i / n) };
  }

  // Shows up somewhere, plays its frames there and back, goes; the next one is
  // somewhere else. With no frames it just shows for a moment.
  function twinkle(o, r, { frames, fpt }) {
    const seq = frames > 1 ? [...Array(frames).keys(), ...[...Array(frames - 1).keys()].reverse()] : [0];
    const shown = frames > 1 ? seq.length * fpt : 6;
    const hidden = Math.max(2, ticksOf(BASE.twinkle / o.speed * between(r, 0.8, 1.25)) - shown);
    const holds = [];
    for (let lane = 0; lane < LANES; lane++) {
      const x = pick(r, 0, Math.max(0, o.wc - o.sw));
      const y = pick(r, Math.round(o.hc * 0.08), Math.max(0, Math.round(o.hc * 0.92) - o.sh));
      push(holds, x, y, true, shown);
      push(holds, x, y, false, hidden);
    }
    const strip = frames > 1 ? [...seq.map(f => ({ f, t: fpt })), { f: 0, t: hidden }] : null;
    return { holds, strip, delay: -pick(r, 0, (shown + hidden) * LANES - 1) };
  }

  // Thrown out of him and pulled back down: drag eases it out, gravity bends it.
  // Pixels here, cells at the end, so the arc keeps its size at any px.
  function burst(o, r, { i, n, px }) {
    const DRAG = 3, GRAVITY = 300, KICK = 120; // per s, px/s², px/s upward
    const a = TAU * i / n + between(r, -0.3, 0.3);
    const d = between(r, 38, 78);
    const vx = Math.cos(a) * d * 3.1, vy = Math.sin(a) * d * 0.7 * 3.1 - KICK;
    const ticks = ticksOf(BASE.burst);
    const holds = [];
    for (let k = 0; k <= ticks; k++) {
      const t = k * TICK / 1000, ease = (1 - Math.exp(-DRAG * t)) / DRAG;
      const x = vx * ease, y = (vy - GRAVITY / DRAG) * ease + GRAVITY * t / DRAG;
      const on = k < ticks - 4 || k % 2 === 0; // blinks out over its last ticks
      push(holds, Math.round(x / px - o.sw / 2), Math.round(y / px - o.sh / 2), on, 1);
    }
    holds[holds.length - 1].on = false;
    return { holds, delay: pick(r, 0, 1), once: true };
  }

  const PATHS = { fall, rise, float, orbit, twinkle, burst };

  // plan(motion, field, { i, n, frames, fps, px, random }) -> { holds, strip, delay, once }
  // strip is the frame holds [{ f, t }] (null: loop the frames in order) and
  // delay is in ticks, negative to start partway through.
  function plan(motion, o, { i = 0, n = 1, frames = 1, fps = 4, px = 3, random = Math.random } = {}) {
    const fpt = Math.max(1, Math.round(12 / (fps || 4))); // ticks per frame
    const out = PATHS[motion](o, random, { i, n, frames, fpt, px });
    const strip = out.strip !== undefined && out.strip !== null ? out.strip
      : frames > 1 ? [...Array(frames).keys()].map(f => ({ f, t: fpt })) : null;
    const total = out.holds.reduce((s, h) => s + h.t, 0);
    const delay = out.delay ?? -pick(random, 0, total - 1);
    return { holds: out.holds, strip, delay, once: !!out.once };
  }

  // Holds as Web Animation keyframes: each a step that lasts until the next.
  function keyframesOf(holds, value) {
    const total = holds.reduce((s, h) => s + h.t, 0);
    const kf = [];
    let at = 0;
    for (const h of holds) {
      kf.push({ offset: at / total, easing: 'step-end', ...value(h) });
      at += h.t;
    }
    kf.push({ offset: 1, ...value(holds[holds.length - 1]) });
    return { keyframes: kf, duration: total * TICK };
  }

  // A sprite's pictures side by side, as pixel rows, with room between them for
  // the ink line when it has one.
  function stripRows(sprite, ink) {
    const pics = [sprite.pixels, ...(sprite.frames || [])];
    const w = Math.max(...pics.flat().map(row => row.length));
    const gap = ink ? '..' : '';
    const rows = sprite.pixels.map((_, y) => pics.map(p => (p[y] || '').padEnd(w, '.')).join(gap));
    const pad = ink ? 1 : 0;
    return { rows, frames: pics.length, cw: w + 2 * pad, ch: sprite.pixels.length + 2 * pad };
  }

  function particle(effect, i, n, field, px, random) {
    const sprite = effect.sprites[i % effect.sprites.length];
    const s = stripRows(sprite, !!effect.ink);
    const p = plan(effect.motion, { ...field, sw: s.cw, sh: s.ch, speed: effect.speed || 1 }, { i, n, frames: s.frames, fps: effect.fps, px, random });
    const el = document.createElement('div');
    el.className = `fx-p fx-${effect.motion}`;
    const win = document.createElement('div');
    win.className = 'fx-i';
    win.style.setProperty('--fw', `${s.cw * px}px`);
    win.style.setProperty('--fh', `${s.ch * px}px`);
    const svg = root.ShellbySprite.grid(s.rows, sprite.palette, { px, ink: !!effect.ink });
    win.append(svg);
    el.append(win);
    const timing = { delay: p.delay * TICK, iterations: p.once ? 1 : Infinity, fill: p.once ? 'both' : 'auto' };
    const path = keyframesOf(p.holds, h => ({ transform: `translate(${h.x * px}px, ${h.y * px}px)`, opacity: h.on ? 1 : 0 }));
    el.animate(path.keyframes, { ...timing, duration: path.duration });
    if (p.strip) {
      const flip = keyframesOf(p.strip, h => ({ transform: `translateX(${-h.f * s.cw * px}px)` }));
      svg.animate(flip.keyframes, { ...timing, duration: flip.duration });
    }
    return el;
  }

  // How a continuous effect plays on the crab's window: a flight now and then,
  // not all day. A transparent window pays the GPU for every frame it presents
  // (shared/framecap.js), and bats circling him all October drew every frame of
  // the clock, about 2 points of a core on their own. Between flights the
  // particles are removed, which frees the work; pausing them would not.
  const FLIGHT = { on: 8000, off: 172000, fade: 600 }; // 8 s every 3 min

  // flights({ on, off, fade, setTimeout, clearTimeout }, { show, leave, hide }) -> { stop() }
  // show() now; leave() `fade` ms before the end of each flight (time to fade
  // out); hide() at its end; show() again `off` ms later, and so on until stop().
  function flights(opts, { show, leave = () => {}, hide }) {
    const later = opts.setTimeout || setTimeout;
    const cancel = opts.clearTimeout || clearTimeout;
    const fade = Math.min(opts.fade || 0, opts.on);
    let timer = null;
    let stopped = false;
    const at = (ms, fn) => { timer = later(() => { if (!stopped) fn(); }, ms); };
    function fly() {
      show();
      at(opts.on - fade, () => { leave(); at(fade, rest); });
    }
    function rest() {
      hide();
      at(opts.off, fly);
    }
    fly();
    return { stop() { stopped = true; cancel(timer); } };
  }

  // mount(container, effect|null, { px, flights }) -> { set(effect), burst(effect?), destroy() }
  // `flights` ({ on, off, fade } or true for FLIGHT) plays a continuous effect
  // in flights instead of all the time: the crab's window wants it, a preview doesn't.
  function mount(container, effect, { px = 3, flights: rhythm = null, random = Math.random } = {}) {
    const layer = document.createElement('div');
    layer.className = 'fx-layer';
    layer.setAttribute('aria-hidden', 'true');
    container.append(layer);
    let current = null;
    let flying = null;
    let live = false; // continuous particles are up
    let size = '';

    // The layer in cells. A hidden layer (a preview not on screen yet) has no
    // size, so it gets the wardrobe stage's until it shows.
    function field() {
      const w = layer.clientWidth || 240, h = layer.clientHeight || 200;
      const r = parseFloat(getComputedStyle(layer).getPropertyValue('--orbit-r')) || 58;
      return { wc: Math.floor(w / px), hc: Math.floor(h / px), rc: Math.round(r / px) };
    }

    function particles() {
      const n = Math.max(1, Math.min(24, current.count || 10));
      const f = field();
      size = `${f.wc}x${f.hc}`;
      return Array.from({ length: n }, (_, i) => particle(current, i, n, f, px, random));
    }

    // The continuous particles go; a burst playing alongside stays.
    const clear = () => { for (const el of [...layer.children]) if (!el.classList.contains('fx-burst')) el.remove(); };
    const fill = () => { clear(); layer.append(...particles()); live = true; };

    // Paths are cut to the layer, so a new size (he grew, a preview came on
    // screen) lays them out again, once it settles.
    let settle = null;
    const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
      clearTimeout(settle);
      settle = setTimeout(() => {
        const f = field();
        if (live && current && `${f.wc}x${f.hc}` !== size) fill();
      }, RESIZE_SETTLE_MS);
    }) : null;
    resized?.observe(layer);

    function set(next) {
      current = next && MOTIONS.includes(next.motion) && next.sprites?.length ? next : null;
      flying?.stop();
      flying = null;
      live = false;
      layer.replaceChildren();
      layer.classList.remove('fx-arriving', 'fx-leaving');
      layer.dataset.motion = current ? current.motion : '';
      if (!current || current.motion === 'burst') return; // bursts only play on demand
      if (!rhythm) { fill(); return; }
      flying = flights(rhythm === true ? FLIGHT : rhythm, {
        show: () => { layer.classList.remove('fx-leaving'); layer.classList.add('fx-arriving'); fill(); },
        leave: () => layer.classList.replace('fx-arriving', 'fx-leaving'),
        hide: () => { clear(); live = false; layer.classList.remove('fx-arriving', 'fx-leaving'); },
      });
    }

    // One-shot celebration; uses the equipped burst effect or the fallback given.
    function burst(fallback) {
      const fx = current?.motion === 'burst' ? current : fallback;
      if (!fx?.sprites?.length) return;
      const n = Math.max(6, Math.min(24, fx.count || 16));
      const wrap = document.createElement('div');
      wrap.className = 'fx-burst';
      const f = field();
      for (let i = 0; i < n; i++) wrap.append(particle({ ...fx, motion: 'burst' }, i, n, f, px, random));
      layer.append(wrap);
      setTimeout(() => wrap.remove(), BURST_MS);
    }

    set(effect);
    return {
      set, burst,
      destroy: () => { flying?.stop(); clearTimeout(settle); resized?.disconnect(); layer.remove(); },
      get effect() { return current; },
    };
  }

  root.ShellbyFx = { mount, flights, plan, keyframesOf, stripRows, MOTIONS, FLIGHT, TICK };
  if (typeof module !== 'undefined') module.exports = root.ShellbyFx;
})(typeof window !== 'undefined' ? window : globalThis);
