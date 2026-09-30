const crab = document.getElementById('crab');
const spriteHost = document.getElementById('sprite');
const bubbleText = document.getElementById('bubbleText');
const crewHost = document.getElementById('crew');
const countEl = document.getElementById('count');
const api = window.shellby.critter;

const BUBBLES = { working: '', asking: '?', success: '✓', error: '!', learned: '✦' };
// Each helper gets its own shell colour so parallel agents are easy to tell apart.
const HUES = [0, 145, 250, 60, 300, 200];

let skin = null;
let px = 4;
let state = 'idle';
const helpers = new Map(); // task id -> element

api.onSkin(msg => {
  skin = msg.skin;
  px = msg.px;
  document.documentElement.style.setProperty('--px', `${px}px`);
  document.documentElement.style.setProperty('--self-w', `${22 * px + 72}px`);
  spriteHost.replaceChildren(window.ShellbySprite.build(skin, { px }));
  for (const el of helpers.values()) el.querySelector('svg')?.replaceWith(helperSprite(el.dataset.hue));
});

function helperSprite(hue) {
  const svg = window.ShellbySprite.build(skin, { px: Math.max(1, px * 0.5) });
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
    el.querySelector('.tag').textContent = c.label;
    el.title = `${c.type}: ${c.label}`;
  });
  crewHost.querySelector('.more')?.remove();
  if (more > 0) {
    const m = document.createElement('span');
    m.className = 'more';
    m.textContent = `+${more}`;
    crewHost.append(m);
  }
}

api.onState(msg => {
  state = msg.state;
  document.body.className = `state-${state}` + (state in BUBBLES ? ' bubble-on' : '');
  bubbleText.textContent = BUBBLES[state] ?? '';
  countEl.textContent = msg.busy;
  countEl.classList.toggle('on', msg.busy > 1);
  countEl.title = `${msg.busy} conversations running`;
  if (skin) renderCrew(msg.crew || [], msg.moreCrew || 0);
});

// ---- click vs drag (pointer capture keeps drags alive past the window edge)
let down = null;
let dragging = false;
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
window.addEventListener('contextmenu', e => { e.preventDefault(); api.menu(); });

// ---- drop files onto Shellby to attach them to a task
let dragDepth = 0;
const setDropping = on => {
  document.body.classList.toggle('dropping', on);
  document.body.classList.toggle('bubble-on', on || state in BUBBLES);
  bubbleText.textContent = on ? 'drop it!' : (BUBBLES[state] ?? '');
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
