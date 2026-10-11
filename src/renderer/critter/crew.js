// A classic script that shares critter.js's top-level scope (critter.html
// loads it right after critter.js). His helpers (crew) beside him, and a
// friend's crab visiting and doing things together with him.
/* global HUES:writable, api:writable, crab:writable, crewHost:writable, drawBuddy:writable, flags:writable, helpers:writable, outfit:writable, paintBody:writable, px:writable, skin:writable */
/* exported renderCrew */

// A crew member's own hat (src/main/wiring/crew.js) for each helper on the desktop.
const helperHats = new WeakMap();

function helperSprite(hue, hats) {
  // A crew member wears its own hat; a helper from another app wears Shellby's
  // when "crew outfits" is on.
  const svg = window.ShellbySprite.build(skin, { px: Math.max(1, px * 0.5), accessories: hats || outfit.crewAccessories || [] });
  svg.style.filter = `hue-rotate(${hue}deg) saturate(1.1)`;
  return svg;
}

const lookKey = c => (c.accessories || []).map(a => a.key).join(',');
// "Clawdia Lv 4 · Review the diff", or, for a helper with no crew record, its job and type.
function helperTag(c) {
  if (c.name) return `${c.name} Lv ${c.level} · ${c.label}`;
  return c.type && c.type !== c.label ? `${c.label} · ${c.type}` : c.label;
}

// "📨 check the tests" for a message it got, "→ scout: done" for one it sent,
// "💬 found it" for what it's saying as it works.
function helperTalk(b) {
  if (b.kind === 'said') return b.to ? `→ ${b.to}: ${b.text}` : `💬 ${b.text}`;
  return `📨 ${b.text}`;
}

function renderCrew(crew, more, ended = []) {
  const live = new Set(crew.map(c => c.id));
  const how = new Map(ended.map(e => [e.id, !!e.ok]));
  // Helpers whose task finished walk back into Shellby, then disappear: one that
  // did its job holds it up first (a scroll), one that failed trudges home.
  for (const [id, el] of helpers) {
    if (!live.has(id) && !el.classList.contains('leaving')) {
      // Out of the row where it stands, so a helper arriving in the same moment
      // takes its slot instead of being pushed past the window's left edge.
      el.style.left = `${el.offsetLeft}px`;
      const ok = how.get(id);
      if (ok === true) {
        const loot = document.createElement('span');
        loot.className = 'loot';
        el.append(loot);
      }
      el.classList.add('leaving', ...(ok === true ? ['home-ok'] : ok === false ? ['home-sad'] : []));
      setTimeout(() => { el.remove(); helpers.delete(id); }, ok === undefined ? 900 : 1500);
    }
  }
  crew.forEach((c, i) => {
    let el = helpers.get(c.id);
    if (!el) {
      // A crew member keeps its colour run after run; anyone else takes the next one.
      const hue = Number.isFinite(c.hue) ? c.hue : HUES[helpers.size % HUES.length];
      el = document.createElement('div');
      el.className = 'helper fresh';
      el.dataset.hue = hue;
      el.dataset.tab = c.tabId;
      el.style.animationDelay = `${i * 80}ms`;
      const tag = document.createElement('span');
      tag.className = 'tag';
      helperHats.set(el, c.accessories);
      el.dataset.look = lookKey(c);
      el.append(tag, helperSprite(hue, c.accessories));
      el.addEventListener('click', () => api.crewClick(el.dataset.tab));
      setTimeout(() => el.classList.remove('fresh'), 2500);
      helpers.set(c.id, el);
      crewHost.append(el);
    }
    // A level reached or a hat changed mid-run: redraw it.
    if (el.dataset.look !== lookKey(c) && !el.classList.contains('leaving')) {
      el.dataset.look = lookKey(c);
      helperHats.set(el, c.accessories);
      el.querySelector('svg')?.replaceWith(helperSprite(el.dataset.hue, c.accessories));
    }
    // Themed name tag only: a native `title` would pop an unstyled OS tooltip.
    // While a helper is sent a message, or sends one, the tag shows it (session.js noteMessage).
    el.querySelector('.tag').textContent = c.bubble ? helperTalk(c.bubble) : helperTag(c);
    el.classList.toggle('talking', !!c.bubble);
    el.classList.toggle('heard', c.bubble?.kind === 'heard');
    el.setAttribute('aria-label', c.name ? `${c.name}, level ${c.level} ${c.type}: ${c.label}` : `Helper ${c.type}: ${c.label}`);
  });
  crewHost.querySelector('.more')?.remove();
  if (more > 0) {
    const m = document.createElement('span');
    m.className = 'more';
    m.textContent = `+${more}`;
    crewHost.append(m);
  }
}

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
// A new size (Settings → Look) redraws the visitor and his buddy along with everyone else.
api.onSkin(() => { if (visitorEl && visitorLook) visitorEl.querySelector('svg')?.replaceWith(visitorSprite()); drawBuddy(); });

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
