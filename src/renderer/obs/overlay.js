// The browser-source crab. Listens to Shellby over Server-Sent Events and draws
// the same sprite the desktop critter draws, with the same body state class, so
// critter.css gives him the same walk, the same sleep and the same claw raise.
//
// Deliberately not critter.js: that one owns dragging, petting, tossing, the
// helper lane layout and the desktop window. A stream wants the crab, his
// outfit, what he is doing and what he is saying.
(function () {
  const spriteHost = document.getElementById('sprite');
  const bubble = document.getElementById('bubble');
  const bubbleText = document.getElementById('bubbleText');
  const countEl = document.getElementById('count');
  const crewHost = document.getElementById('crew');

  // The bubble glyphs the desktop crab uses, so the two read the same.
  const BUBBLES = { working: '', asking: '?', success: '✓', error: '!', learned: '✦', unlocked: '★', levelup: 'LV', petted: '♥' };
  const STATES = new Set(['idle', 'working', 'asking', 'success', 'error', 'sleeping', 'learned', 'unlocked', 'levelup', 'petted']);
  const HUES = [0, 145, 250, 60, 300, 200];
  const MAX_CREW = 6;

  let skin = null;
  let outfit = { accessories: [], effect: null, crewAccessories: [], home: null };
  let px = 4;
  let fx = null;
  let state = 'idle';

  // His work pose, held long enough to read, like the desktop crab's
  // (shared/workposes.js; the moves are critter/beats.css).
  const W = window.ShellbyWorkPoses;
  const poses = W.holder(() => { draw(); paint(); });

  function draw() {
    if (!skin) return;
    const tool = W.ITEMS[poses.shown()] || null;
    const own = outfit.accessories || [];
    spriteHost.replaceChildren(window.ShellbySprite.build(skin, {
      px,
      accessories: tool ? [...own.filter(a => a.slot !== 'held'), tool] : own,
      shell: outfit.home,
    }));
  }

  // One state-* class at a time, exactly as the desktop critter does it, and his pose.
  function paint() {
    const pose = poses.shown();
    document.body.className = [`state-${state}`, pose ? `pose-${pose}` : '', document.body.classList.contains('connected') ? 'connected' : ''].filter(Boolean).join(' ');
  }

  function drawCrew(crew) {
    const list = Array.isArray(crew) ? crew.slice(0, MAX_CREW) : [];
    crewHost.replaceChildren(...list.map((member, i) => {
      const el = document.createElement('div');
      el.className = 'helper';
      const hue = HUES[i % HUES.length];
      el.style.setProperty('--hue', hue);
      const svg = window.ShellbySprite.build(skin, {
        px: Math.max(1, px * 0.5),
        accessories: outfit.crewAccessories || [],
      });
      svg.style.filter = `hue-rotate(${hue}deg)`;
      el.append(svg);
      return el;
    }));
  }

  function apply(msg) {
    if (!msg || typeof msg !== 'object') return;
    document.body.classList.add('connected');

    if (msg.skin) {
      skin = msg.skin;
      if (Number.isFinite(msg.px)) px = msg.px;
      if (msg.outfit) outfit = msg.outfit;
      document.documentElement.style.setProperty('--px', `${px}px`);
      document.documentElement.style.setProperty('--self-w', `${22 * px + 72}px`);
      draw();
      if (!fx && window.ShellbyFx) fx = window.ShellbyFx.mount(document.getElementById('fx'), null, { px: Math.max(2, Math.round(px * 0.75)) });
      fx?.set(outfit.effect);
    }

    if (typeof msg.state === 'string') {
      state = STATES.has(msg.state) ? msg.state : 'idle';
      poses.set(msg.work, state === 'working'); // redraws and repaints when the pose changes
      paint();
      const glyph = BUBBLES[state] ?? '';
      // What he says wins over the state glyph, same as on the desktop.
      const text = msg.say?.text || glyph;
      bubbleText.textContent = text;
      bubble.classList.toggle('show', !!text);
    }

    if ('busy' in msg) {
      const n = Number(msg.busy) || 0;
      countEl.textContent = n > 1 ? String(n) : '';
      countEl.classList.toggle('show', n > 1);
    }

    if ('crew' in msg && skin) drawCrew(msg.crew);
    if (msg.burst && fx) fx.burst(msg.burst);
  }

  // EventSource reconnects on its own (the server sends a retry interval), so
  // closing Shellby and opening it again puts the crab back without touching OBS.
  const events = new EventSource('/events');
  events.onmessage = e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    apply(msg);
  };
  events.onerror = () => {
    // Mid-reconnect: keep the last crab on screen rather than flashing empty.
    document.body.classList.remove('connected');
  };
})();
