// Particle effects around Shellby (snow, bats, leaves, hearts, fireflies,
// sparkles, confetti). Data-driven: an effect is { motion, count, speed,
// sprites[] } from a wardrobe pack. Motion is pure CSS (see effects.css); this
// file only places particles and sets per-particle CSS variables, which the
// strict CSP allows (no inline <style>).
(function (root) {
  const MOTIONS = ['fall', 'rise', 'float', 'orbit', 'twinkle', 'burst'];
  const rand = (a, b) => a + Math.random() * (b - a);

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

  // mount(container, effect|null, { px }) -> { set(effect), burst(effect?), destroy() }
  function mount(container, effect, { px = 3 } = {}) {
    const layer = document.createElement('div');
    layer.className = 'fx-layer';
    layer.setAttribute('aria-hidden', 'true');
    container.append(layer);
    let current = null;

    function set(next) {
      current = next && MOTIONS.includes(next.motion) && next.sprites?.length ? next : null;
      layer.replaceChildren();
      layer.dataset.motion = current ? current.motion : '';
      if (!current || current.motion === 'burst') return; // bursts only play on demand
      const n = Math.max(1, Math.min(24, current.count || 10));
      for (let i = 0; i < n; i++) layer.append(particle(current, i, px));
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
    return { set, burst, destroy: () => layer.remove(), get effect() { return current; } };
  }

  root.ShellbyFx = { mount, MOTIONS };
})(typeof window !== 'undefined' ? window : globalThis);
