/* Shellby panel — his tank's saved layouts (src/main/tank-layouts.js): keep
   the tank under a name, put one up, tag one to a season, forget one. Main
   checks the seasons each time this asks for the list, so opening the Tank
   tab in a new season is what puts its layout up. Loaded after tank.js. */
'use strict';
(function () {
  const { h, api, $ } = SB;

  let lv = null; // { max, list, seasons } from main
  let busy = false;

  const plural = (n, one, many) => SB.plural(n, one, many, x => x.toLocaleString());
  const sizeName = id => SB.tankView?.()?.sizes.find(s => s.id === id)?.name || id;

  function render() {
    if (!lv) return;
    const editing = !!SB.tankEditing?.();
    $('tkLayoutsMeta').textContent = `${lv.list.length} of ${lv.max}`;
    $('tkLayouts').replaceChildren(...lv.list.map(l => h('li', { class: 'tk-layout', dataset: { id: l.id } },
      h('span', { class: 'tk-layout-name', text: l.name }),
      h('span', { class: 'muted small', text: ` ${sizeName(l.size)}, ${plural(l.pieces, 'piece')}${l.up ? ' · up for the season' : ''}` }),
      h('label', { class: 'sr-only', for: `tkLayoutSeason-${l.id}`, text: `Season for ${l.name}` }),
      h('select', { id: `tkLayoutSeason-${l.id}`, class: 'field slim tk-layout-season', dataset: { act: 'season' } },
        h('option', { value: '', text: 'Any time', selected: !l.season }),
        ...lv.seasons.map(s => h('option', { value: s.id, text: `${s.emoji} ${s.name}`, selected: l.season === s.id }))),
      h('button', { type: 'button', class: 'btn ghost slim-btn', dataset: { act: 'use' }, disabled: editing, title: editing ? 'Finish decorating first' : null, 'aria-label': `Put up ${l.name}` }, 'Put up'),
      h('button', { type: 'button', class: 'btn ghost slim-btn', dataset: { act: 'remove' }, 'aria-label': `Remove ${l.name}` }, 'Remove'))));
    const full = lv.list.length >= lv.max;
    $('tkLayoutSave').disabled = editing;
    $('tkLayoutName').placeholder = full ? 'A name you already have, to replace it' : 'Name this layout';
  }

  function take(r) {
    if (r?.layouts) lv = r.layouts;
    if (r?.view) SB.tankApply?.(r.view);
    render();
  }

  async function call(fn, arg, done) {
    if (busy) return null;
    busy = true;
    const r = await fn(arg).catch(() => null);
    busy = false;
    if (!r) { SB.toast('Couldn’t do that. Try again in a moment.'); return null; }
    take(r);
    if (!r.ok) { SB.toast(r.error || 'Couldn’t do that.'); return r; }
    const msg = typeof done === 'function' ? done(r) : done;
    if (msg) SB.toast(msg);
    return r;
  }

  $('tkLayoutForm').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('tkLayoutName').value;
    const r = await call(api.saveTankLayout, { name }, `Saved as “${name.trim()}”.`);
    if (r?.ok) $('tkLayoutName').value = '';
  });

  $('tkLayouts').addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    const li = e.target.closest('.tk-layout');
    if (!b || !li || b.tagName === 'SELECT') return;
    const l = lv.list.find(x => x.id === li.dataset.id);
    if (!l) return;
    if (b.dataset.act === 'use') {
      call(api.useTankLayout, l.id, r => (r.dropped?.length ? `${l.name} is up. ${plural(r.dropped.length, 'piece')} he doesn’t have here stayed out.` : `${l.name} is up.`));
    } else if (b.dataset.act === 'remove') {
      call(api.removeTankLayout, l.id, `${l.name} is gone. The tank stays as it is.`);
    }
  });

  $('tkLayouts').addEventListener('change', e => {
    const sel = e.target.closest('select[data-act="season"]');
    const li = e.target.closest('.tk-layout');
    if (!sel || !li) return;
    call(api.seasonTankLayout, { id: li.dataset.id, season: sel.value || null });
  });

  SB.tankLayouts = {
    open: () => call(api.tankLayouts, undefined, r => (r.changed ? 'The season changed his tank.' : null)).then(() => {}),
    render,
  };
})();
