/* Shellby panel — him tidying his tank (src/main/tank/tidy.js). Opening the
   Tank tab asks main once whether he's moved a find; if he has, a note says
   which, with "Put it back" (Ctrl+Z works too while you're not decorating).
   Ctrl+Z on the Tank tab is one slot, SB.tankUndo, shared with the saved
   layouts (tank-layouts.js): it takes back whichever was offered last.
   Loaded after tank.js. */
'use strict';
(function () {
  const { api, state, $ } = SB;

  let undoable = false;
  let lastUndo = null; // what Ctrl+Z takes back: the latest offered, his tidy or a layout's

  function show(name) {
    undoable = !!name;
    if (name) lastUndo = undo;
    else if (lastUndo === undo) lastUndo = null;
    $('tkTidyNote').hidden = !name;
    $('tkTidyText').textContent = name ? `He moved the ${name.toLowerCase()} a little. He likes it there.` : '';
  }

  async function open() {
    const r = await api.tankTidy().catch(() => null);
    if (!r) return;
    $('tkTidyOn').checked = r.on !== false;
    if (r.view) SB.tankApply?.(r.view);
    if (r.moved) show(r.moved.name);
  }

  async function undo() {
    if (!undoable) return;
    show(null);
    const r = await api.undoTankTidy().catch(() => null);
    if (r?.view) SB.tankApply?.(r.view);
    SB.toast(r?.ok ? 'Put back where you had it.' : 'It’s been moved since, so it stays where it is.');
  }

  $('tkTidyUndo').addEventListener('click', undo);
  document.addEventListener('keydown', e => {
    if (!lastUndo || state.view !== 'tank' || SB.tankEditing?.() || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || e.shiftKey) return;
    if (e.target.closest?.('input, textarea, select')) return;
    e.preventDefault();
    const fn = lastUndo;
    lastUndo = null;
    fn();
  });
  $('tkTidyOn').addEventListener('change', async e => {
    const on = e.target.checked;
    const r = await api.setTankTidy(on).catch(() => null);
    if (!r?.ok) { e.target.checked = !on; SB.toast('Couldn’t change that. Try again in a moment.'); return; }
    if (!on) show(null);
  });

  SB.tankTidy = { open };
  // offer(fn): Ctrl+Z now takes back fn. drop(fn): unless something newer took the slot, it's gone.
  SB.tankUndo = {
    offer: fn => { lastUndo = fn; },
    drop: fn => { if (lastUndo === fn) lastUndo = null; },
  };
})();
