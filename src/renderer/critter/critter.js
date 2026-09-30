const crab = document.getElementById('crab');
const spriteHost = document.getElementById('sprite');
const bubbleText = document.getElementById('bubbleText');
const api = window.shellby.critter;

const BUBBLES = { working: '', asking: '?', success: '✓', error: '!' };
let state = 'idle';

api.onSkin(({ skin, px }) => {
  document.documentElement.style.setProperty('--px', `${px}px`);
  spriteHost.replaceChildren(window.ShellbySprite.build(skin, { px }));
});

api.onState(next => {
  state = next;
  document.body.className = `state-${next}` + (next in BUBBLES ? ' bubble-on' : '');
  bubbleText.textContent = BUBBLES[next] ?? '';
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
