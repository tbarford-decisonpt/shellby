/* Shellby confirmation window. It lives in its own isolated window: the panel
   can't script it, and main only accepts an answer from this window. */
(function () {
  'use strict';
  const api = window.shellbyDialog;
  const $ = id => document.getElementById(id);
  let answered = false;
  let spec = null;

  function answer(index) {
    if (answered) return;
    answered = true;
    api.respond(index);
  }

  function art(item) {
    if (item.sprites) {
      const sp = [...item.sprites].sort((a, b) => b.pixels.join('').length - a.pixels.join('').length)[0];
      return window.ShellbySprite.grid(sp.pixels, sp.palette);
    }
    if (item.kind === 'skin' && spec.skin) {
      return window.ShellbySprite.build({ ...spec.skin, ...item, parts: item.parts || spec.skin.parts });
    }
    return window.ShellbySprite.grid(item.pixels, item.palette);
  }

  api.onShow(s => {
    spec = s;
    document.title = s.title;
    const d = $('dialog');
    d.classList.toggle('danger', !!s.danger);
    $('badge').textContent = s.icon || '';
    $('title').textContent = s.title;
    $('message').textContent = s.message || '';
    $('detail').textContent = s.detail || '';
    $('detail').hidden = !s.detail;
    $('note').textContent = s.note || '';
    $('note').hidden = !s.note;
    if (s.skin) $('crab').replaceChildren(window.ShellbySprite.build(s.skin, { accessories: s.accessories || [], fit: (s.accessories || []).length > 0 }));
    const items = s.items || [];
    $('preview').hidden = !items.length;
    $('preview').replaceChildren(...items.map(it => {
      const el = document.createElement('div');
      el.className = 'item';
      const a = document.createElement('span'); a.className = 'art'; a.append(art(it));
      const n = document.createElement('span'); n.className = 'nm'; n.textContent = it.name;
      const k = document.createElement('span'); k.className = 'kd'; k.textContent = it.label || it.kind;
      el.append(a, n, k);
      return el;
    }));
    const actions = $('actions');
    actions.replaceChildren(...s.buttons.map((b, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = b.label;
      if (b.style) btn.className = b.style;
      btn.addEventListener('click', () => answer(i));
      return btn;
    }));
    const def = actions.children[s.defaultId ?? 0];
    requestAnimationFrame(() => {
      def?.focus();
      api.resize(Math.ceil(document.body.getBoundingClientRect().height));
    });
  });

  document.addEventListener('keydown', e => {
    if (!spec) return;
    if (e.key === 'Escape') { e.preventDefault(); answer(spec.cancelId ?? spec.buttons.length - 1); }
  });
})();
