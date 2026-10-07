// Particle effects around Shellby (snow, bats, leaves, hearts, fireflies,
// sparkles, confetti). Data-driven: an effect is { motion, count, speed,
// sprites[] } from a wardrobe pack. Motion is pure CSS (see effects.css); this
// file only places particles and sets per-particle CSS variables, which the
// strict CSP allows (no inline <style>).
(function (root) {
  const MOTIONS = ['fall', 'rise', 'float', 'orbit', 'twinkle', 'burst'];
  const rand = (a, b) => a + Math.random() * (b - a);

  // How the crab's window plays a continuous effect: a flight now and then, not
  // all day. A transparent window pays the GPU for every frame it presents
  // (shared/framecap.js), and bats circling him all October drew every frame
  // of the clock, about 2 points of a core on their own. Between flights the
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

  function particle(effect, i, px) {
    const sprite = effect.sprites[i % effect.sprites.length];
    const el = document.createElement('div');
    el.className = `fx-p fx-${effect.motion}`;
    const inner = document.createElement('div');
    inner.className = 'fx-i';
    inner.append(root.ShellbySprite.grid(sprite.pixels, sprite.palette, { px }));
    el.append(inner);
    const speed = effect.speed || 1;
    const base = { fall: 5.5, rise: 4.5, float: 6, orbit: 5, twinkle: 2.6, burst: 1.1 }[effect.motion] || 4;
    const dur = base / speed * rand(0.8, 1.25);
    el.style.setProperty('--dur', `${dur.toFixed(2)}s`);
    el.style.setProperty('--delay', `${(-rand(0, dur)).toFixed(2)}s`);
    el.style.setProperty('--x', `${rand(0, 100).toFixed(1)}%`);
    el.style.setProperty('--y', `${rand(8, 92).toFixed(1)}%`);
    el.style.setProperty('--drift', `${rand(-18, 18).toFixed(0)}px`);
    el.style.setProperty('--spin', `${rand(-240, 240).toFixed(0)}deg`);
    if (effect.motion === 'orbit') {
      el.style.setProperty('--delay', `${(-(dur / effect.count) * i).toFixed(2)}s`);
      el.style.setProperty('--ry', `${rand(0.32, 0.5).toFixed(2)}`);
    }
    if (effect.motion === 'burst') {
      const a = (Math.PI * 2 * i) / effect.count + rand(-0.3, 0.3);
      const d = rand(38, 78);
      el.style.setProperty('--bx', `${(Math.cos(a) * d).toFixed(0)}px`);
      el.style.setProperty('--by', `${(Math.sin(a) * d * 0.7 - 30).toFixed(0)}px`);
      el.style.setProperty('--delay', `${rand(0, 0.12).toFixed(2)}s`);
    }
    return el;
  }

  // mount(container, effect|null, { px, flights }) -> { set(effect), burst(effect?), destroy() }
  // `flights` ({ on, off, fade } or true for FLIGHT) plays a continuous effect
  // in flights instead of all the time: the crab's window wants it, a preview doesn't.
  function mount(container, effect, { px = 3, flights: rhythm = null } = {}) {
    const layer = document.createElement('div');
    layer.className = 'fx-layer';
    layer.setAttribute('aria-hidden', 'true');
    container.append(layer);
    let current = null;
    let flying = null;

    function particles() {
      const n = Math.max(1, Math.min(24, current.count || 10));
      return Array.from({ length: n }, (_, i) => particle(current, i, px));
    }

    // The continuous particles go; a burst playing alongside stays.
    const clear = () => { for (const el of [...layer.children]) if (!el.classList.contains('fx-burst')) el.remove(); };

    function set(next) {
      current = next && MOTIONS.includes(next.motion) && next.sprites?.length ? next : null;
      flying?.stop();
      flying = null;
      layer.replaceChildren();
      layer.classList.remove('fx-arriving', 'fx-leaving');
      layer.dataset.motion = current ? current.motion : '';
      if (!current || current.motion === 'burst') return; // bursts only play on demand
      if (!rhythm) { layer.append(...particles()); return; }
      flying = flights(rhythm === true ? FLIGHT : rhythm, {
        show: () => { layer.classList.remove('fx-leaving'); layer.classList.add('fx-arriving'); layer.append(...particles()); },
        leave: () => layer.classList.replace('fx-arriving', 'fx-leaving'),
        hide: () => { clear(); layer.classList.remove('fx-arriving', 'fx-leaving'); },
      });
    }

    // One-shot celebration; uses the equipped burst effect or the fallback given.
    function burst(fallback) {
      const fx = current?.motion === 'burst' ? current : fallback;
      if (!fx?.sprites?.length) return;
      const n = Math.max(6, Math.min(24, fx.count || 16));
      const wrap = document.createElement('div');
      wrap.className = 'fx-burst';
      for (let i = 0; i < n; i++) wrap.append(particle({ ...fx, motion: 'burst', count: n }, i, px));
      layer.append(wrap);
      setTimeout(() => wrap.remove(), 1600);
    }

    set(effect);
    return { set, burst, destroy: () => { flying?.stop(); layer.remove(); }, get effect() { return current; } };
  }

  root.ShellbyFx = { mount, flights, MOTIONS, FLIGHT };
  if (typeof module !== 'undefined') module.exports = root.ShellbyFx;
})(typeof window !== 'undefined' ? window : globalThis);
