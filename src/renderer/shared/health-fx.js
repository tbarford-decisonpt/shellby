// Health moods drawn over Shellby: sweat when a part runs hot, heat shimmer when
// it's scorching, orbiting stars when RAM is nearly full, and junk spilling out
// of his shell when a drive is full. Shared by the desktop critter and the
// panel's Health view so they always match.
//
//   const fx = ShellbyHealthFx.mount(layer, moodHost);  // layer sits on the crab box
//   fx.set('hot' | 'scorching' | 'dizzy' | 'stuffed' | null);
//
// `moodHost` gets data-health=<mood> so CSS can also animate the crab's own
// parts (fanning claw, panting, wobbly eyes). Positions are in sprite pixels on
// the 22x13 crab (see skins/classic.json) and scale with --px.
(function (root) {
  const SPRITES = {
    drop: { palette: { a: '#5fc8ff', b: '#e6f7ff' }, pixels: ['.a.', 'aba', 'aaa', '.a.'] },
    blush: { palette: { p: '#ff4f6d' }, pixels: ['pp'] },
    wave: { palette: { w: '#ffb38a' }, pixels: ['w.', '.w', '.w', 'w.', 'w.', '.w'] },
    star: { palette: { y: '#ffd23f', Y: '#fff4c2' }, pixels: ['.y.', 'yYy', '.y.'] },
    crate: { palette: { b: '#a0693a', B: '#6b4423' }, pixels: ['BBBB', 'BbbB', 'BBBB'] },
    paper: { palette: { w: '#f8f9fa', l: '#adb5bd' }, pixels: ['www', 'wlw', 'www', 'wlw'] },
    floppy: { palette: { k: '#3a86ff', s: '#dee2e6', d: '#1d3557' }, pixels: ['kssk', 'kkkk', 'kddk'] },
    sock: { palette: { r: '#e63946', w: '#f1faee' }, pixels: ['w.', 'r.', 'rr'] },
  };

  // [sprite, x, y, class, delay(s)] in sprite pixels, relative to the crab's top-left.
  const LAYOUT = {
    hot: [
      ['drop', 11, 0, 'hfx-face hfx-drip', 0], ['drop', 18, 1, 'hfx-face hfx-drip', 0.9],
      ['blush', 13, 5, 'hfx-face hfx-blush', 0], ['blush', 16, 5, 'hfx-face hfx-blush', 0],
    ],
    scorching: [
      ['drop', 11, 0, 'hfx-face hfx-drip fast', 0], ['drop', 18, 1, 'hfx-face hfx-drip fast', 0.45],
      ['drop', 12, 3, 'hfx-face hfx-drip fast', 0.8], ['drop', 19, 2, 'hfx-face hfx-drip fast', 0.25],
      ['blush', 13, 5, 'hfx-face hfx-blush', 0], ['blush', 16, 5, 'hfx-face hfx-blush', 0],
      ['wave', 4, -4, 'hfx-wave', 0], ['wave', 8, -5, 'hfx-wave', 0.7], ['wave', 15, -6, 'hfx-wave', 1.3],
    ],
    dizzy: [
      ['star', 0, 0, 'hfx-face hfx-orbit', 0], ['star', 0, 0, 'hfx-face hfx-orbit', -0.8], ['star', 0, 0, 'hfx-face hfx-orbit', -1.6],
    ],
    stuffed: [
      ['crate', 3, -2, 'hfx-junk', 0], ['paper', 7, -3, 'hfx-junk', 0.35], ['floppy', 9, -1, 'hfx-junk', 0.7],
      ['sock', 1, 0, 'hfx-junk', 0.2], ['paper', 5, 1, 'hfx-pop', 0],
    ],
  };

  function mount(layer, moodHost = layer) {
    let current = null;
    const build = (name, x, y, cls, delay) => {
      const s = SPRITES[name];
      const el = document.createElement('i');
      el.className = `hfx ${cls}`;
      el.style.setProperty('--x', x);
      el.style.setProperty('--y', y);
      el.style.animationDelay = `${delay}s`;
      el.append(root.ShellbySprite.grid(s.pixels, s.palette));
      el.style.setProperty('--w', s.pixels[0].length);
      el.style.setProperty('--h', s.pixels.length);
      return el;
    };
    return {
      set(mood) {
        mood = LAYOUT[mood] ? mood : null;
        if (mood === current) return;
        current = mood;
        if (mood) moodHost.dataset.health = mood; else delete moodHost.dataset.health;
        layer.replaceChildren(...(mood ? LAYOUT[mood].map(a => build(...a)) : []));
      },
      get mood() { return current; },
    };
  }

  root.ShellbyHealthFx = { mount, MOODS: Object.keys(LAYOUT) };
})(typeof window !== 'undefined' ? window : globalThis);
