/* Shellby panel — the right-click menu for text: spelling fixes for the word
   under the pointer, then cut/copy/paste. Main works out the items and runs the
   one you pick (src/main/context-menu.js); this draws them as one of the
   panel's own popovers instead of the OS's plain white menu.

   Mouse: the menu never takes focus, so the field keeps its caret and
   selection for the fix or paste to land in. Keyboard (the Menu key or
   Shift+F10): focus moves into the menu, and goes back to the field before
   the picked item runs. */
'use strict';
(function () {
  const { h, api, $ } = SB;
  const menu = $('textMenu');
  let returnTo = null; // the field the menu was opened on

  function restoreFocus() {
    if (returnTo?.isConnected && menu.contains(document.activeElement)) returnTo.focus();
  }

  function close({ refocus = true } = {}) {
    if (menu.hidden) return;
    if (refocus) restoreFocus();
    menu.hidden = true;
  }

  function pick(index) {
    restoreFocus();
    menu.hidden = true;
    api.pickTextMenu(index);
  }

  function itemEl(item, index) {
    if (item.separator) return h('div', { class: 'menu-sep', role: 'separator' });
    return h('button', {
      type: 'button', class: `menu-item${item.fix ? ' tm-fix' : ''}`, role: 'menuitem', disabled: !item.enabled,
      onclick: () => pick(index),
    },
    h('span', { class: 'mi-title', text: item.label }),
    item.keys ? h('span', { class: 'tm-keys', text: item.keys }) : null);
  }

  function open({ x, y, items, source }) {
    SB.closeMenus();
    returnTo = document.activeElement !== document.body ? document.activeElement : null;
    const fixes = items.some(i => i.fix);
    menu.replaceChildren(
      fixes ? h('div', { class: 'menu-label', text: 'Did you mean' }) : null,
      ...items.map(itemEl),
    );
    menu.hidden = false;
    // At the pointer, flipped left or up when it would run off the panel.
    const w = menu.offsetWidth, ht = menu.offsetHeight;
    menu.style.left = `${Math.max(8, x + w + 8 > window.innerWidth ? x - w : x)}px`;
    menu.style.top = `${Math.max(8, y + ht + 8 > window.innerHeight ? y - ht : y)}px`;
    if (source !== 'mouse') menu.querySelector('.menu-item:not(:disabled)')?.focus();
  }

  // Keeps the field's caret and selection while you click an item.
  menu.addEventListener('mousedown', e => e.preventDefault());

  menu.addEventListener('keydown', e => {
    const items = [...menu.querySelectorAll('.menu-item:not(:disabled)')];
    const i = items.indexOf(document.activeElement);
    let to = null;
    if (e.key === 'ArrowDown') to = items[(i + 1) % items.length];
    else if (e.key === 'ArrowUp') to = items[(i - 1 + items.length) % items.length];
    else if (e.key === 'Home') to = items[0];
    else if (e.key === 'End') to = items[items.length - 1];
    else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation(); // Esc closes the menu, not the panel
      return close();
    } else return;
    e.preventDefault();
    to?.focus();
  });

  // Mouse users keep focus in the field, so Esc arrives there, not in the menu.
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !menu.hidden && !menu.contains(e.target)) { e.stopPropagation(); close(); }
  }, true);

  for (const type of ['blur', 'resize']) window.addEventListener(type, () => close({ refocus: false }));
  document.addEventListener('scroll', () => close({ refocus: false }), true);

  api.onTextMenu(open);
})();
