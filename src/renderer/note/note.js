// A note Shellby hauled onto your screen (src/main/pranks.js). It's told what
// it says; click it and it crumples up and goes. Nothing else.
'use strict';
(function () {
  const note = document.getElementById('note');
  const text = document.getElementById('text');
  const bridge = window.note;
  const CRUMPLE_MS = 420;
  window.ShellbyFrameCap.cap(document); // a transparent window: every frame costs the GPU

  // A slightly different tilt each time, so a few of them look scattered.
  note.style.setProperty('--tilt', `${(Math.random() * 8 - 4).toFixed(1)}deg`);

  bridge.onLook(look => {
    if (typeof look?.text !== 'string') return;
    text.textContent = look.text.slice(0, 120);
  });
  bridge.onSettle(msg => {
    document.body.classList.add(msg?.rise ? 'rise' : 'settle');
  });

  let gone = false;
  note.addEventListener('click', () => {
    if (gone) return;
    gone = true;
    document.body.classList.add('crumple');
    setTimeout(() => bridge.close(), window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : CRUMPLE_MS);
  });
})();
