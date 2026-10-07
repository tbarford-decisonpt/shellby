/* Shellby notification window: one notice, clicked or dismissed once. */
(function () {
  'use strict';
  const api = window.shellbyToast;
  const $ = id => document.getElementById(id);
  const LIFE_MS = 7000;
  let finished = false;
  let timer = null;
  let left = LIFE_MS;
  let startedAt = 0;

  function finish(clicked) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    $('toast').classList.add('leaving');
    const go = () => (clicked ? api.click() : api.dismiss());
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) go();
    else setTimeout(go, 170);
  }

  function run() {
    startedAt = Date.now();
    timer = setTimeout(() => finish(false), left);
  }

  function hold() {
    clearTimeout(timer);
    left = Math.max(800, left - (Date.now() - startedAt));
  }

  api.onShow(s => {
    document.title = s.title;
    const t = $('toast');
    t.classList.add(s.tone || 'info');
    $('title').textContent = s.title;
    $('body').textContent = s.body || '';
    if (s.skin) $('crab').replaceChildren(window.ShellbySprite.build(s.skin, { accessories: s.accessories || [], shell: s.shell || null, fit: (s.accessories || []).length > 0 }));
    t.addEventListener('click', () => finish(true));
    $('close').addEventListener('click', e => { e.stopPropagation(); finish(false); });
    if (!s.sticky) {
      t.style.setProperty('--life', `${LIFE_MS}ms`);
      $('timer').classList.add('run');
      t.addEventListener('mouseenter', hold);
      t.addEventListener('mouseleave', () => { if (!finished) run(); });
      run();
    } else {
      $('timer').hidden = true;
    }
    requestAnimationFrame(() => api.resize(Math.ceil(document.body.getBoundingClientRect().height)));
  });
})();
