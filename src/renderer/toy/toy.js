// The pebble for fetch (src/main/playtime.js). Drag it and let go: main measures
// how fast it was moving and throws it. It looks like his favourite find, or a
// plain pebble before he has one.
'use strict';
(function () {
  const toy = document.getElementById('toy');
  const bridge = window.toy;
  const PX = 6; // screen pixels per sprite pixel
  window.ShellbyFrameCap.cap(document); // a transparent window: every frame costs the GPU

  bridge.onLook(look => {
    if (!Array.isArray(look?.pixels) || !look.palette) return;
    toy.replaceChildren(window.ShellbySprite.grid(look.pixels, look.palette, { px: PX }));
  });

  // Same as dragging him (critter.js): pointer capture keeps the drag alive past
  // the window edge; main moves the window by how far the pointer has gone.
  let down = null;
  toy.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    toy.setPointerCapture(e.pointerId);
    down = { x: e.screenX, y: e.screenY };
    bridge.dragStart();
  });
  toy.addEventListener('pointermove', e => {
    if (down) bridge.dragMove(e.screenX - down.x, e.screenY - down.y);
  });
  const release = e => {
    if (!down || (e.button !== undefined && e.button !== 0)) return;
    down = null;
    bridge.dragEnd();
  };
  toy.addEventListener('pointerup', release);
  toy.addEventListener('pointercancel', release);
})();
