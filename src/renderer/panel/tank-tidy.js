/* Shellby panel — him tidying his tank (src/main/tank-tidy.js). Opening the
   Tank tab asks main once whether he's moved a find; if he has, a note says
   which, with "Put it back" (Ctrl+Z works too while you're not decorating).
   Loaded after tank.js. */
'use strict';
(function () {
  const { api, state, $ } = SB;

  let undoable = false;

  function show(name) {
    undoable = !!name;
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
    if (!undoable || state.view !== 'tank' || SB.tankEditing?.() || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || e.shiftKey) return;
    if (e.target.closest?.('input, textarea, select')) return;
    e.preventDefault();
    undo();
  });
  $('tkTidyOn').addEventListener('change', async e => {
    const on = e.target.checked;
    const r = await api.setTankTidy(on).catch(() => null);
    if (!r?.ok) { e.target.checked = !on; SB.toast('Couldn’t change that. Try again in a moment.'); return; }
    if (!on) show(null);
  });

  SB.tankTidy = { open };
})();
