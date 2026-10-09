/* Shellby panel — outfit codes: your look as SHB-XXXX-XXXX to share, and a
   sheet to paste someone else's, preview it on your crab, and wear it. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const ACC_SLOTS = new Set(['hat', 'face', 'neck', 'held', 'shell']);
  const SLOT_LABEL = { hat: 'Hat', face: 'Face', neck: 'Neck', held: 'Held', shell: 'Shell', effect: 'Effect', skin: 'Colors' };
  let current = '';
  let preview = null;
  let timer = null;

  // ------------------------------------------------------------ your code

  async function refreshCode() {
    const r = await api.outfitCode();
    current = r.code;
    $('outfitCode').textContent = current;
  }
  SB.outfitCode = () => current;

  const applyWardrobe = SB.applyWardrobe;
  SB.applyWardrobe = view => { applyWardrobe(view); refreshCode(); };
  api.onSkin(() => refreshCode());
  const renderWardrobe = SB.views.wardrobe.render;
  SB.views.wardrobe.render = () => { renderWardrobe(); refreshCode(); };

  $('copyCodeBtn').addEventListener('click', () => {
    api.copyText(current);
    SB.toast("Copied! Anyone with Shellby can paste it to wear your look.");
  });

  // ------------------------------------------------------------ wear a code

  const sheet = $('codeSheet');
  const input = $('codeInput');

  function open() {
    input.value = '';
    preview = null;
    render();
    sheet.hidden = false;
    input.focus();
  }
  function close() { sheet.hidden = true; }

  function thumb(f) {
    const art = f.item?.pixels ? { pixels: f.item.pixels, palette: f.item.palette } : f.item?.sprites?.[0];
    if (f.slot === 'skin') {
      const skin = state.skins.find(s => s.id === f.key);
      return h('span', { class: 'cel-thumb' }, skin ? SB.sprite(skin, { plain: true }) : '🎨');
    }
    if (!art) return h('span', { class: 'cel-thumb', text: '✦' });
    const w = Math.max(...art.pixels.map(r => r.length)), hgt = art.pixels.length;
    return h('span', { class: 'cel-thumb' }, SB.Sprite.grid(art.pixels, art.palette, { px: Math.max(2, Math.floor(26 / Math.max(w, hgt))), ink: !f.item?.sprites }));
  }

  function render() {
    const err = $('codeError');
    const box = $('codePreview');
    $('codeWear').disabled = !preview?.ok;
    err.hidden = !(preview && !preview.ok);
    if (preview && !preview.ok) err.textContent = preview.error;
    box.hidden = !preview?.ok;
    if (!preview?.ok) return;

    // The crab as he'd look (only what you can actually wear).
    const wearable = preview.found.filter(f => !f.locked);
    const skinHit = wearable.find(f => f.slot === 'skin');
    const skin = (skinHit && state.skins.find(s => s.id === skinHit.key)) || state.skin;
    const accessories = wearable.filter(f => ACC_SLOTS.has(f.slot) && f.item).map(f => f.item);
    $('codeCrab').replaceChildren(SB.Sprite.build(skin, { fit: accessories.length > 0, accessories }));

    const rows = [
      ...preview.found.map(f => h('li', { class: `code-row ${f.locked ? 'locked' : 'ok'}` },
        thumb(f),
        h('span', { class: 'cel-rname' }, h('b', { text: f.name }), h('small', { text: SLOT_LABEL[f.slot] })),
        h('span', { class: 'code-state', text: f.locked ? `🔒 ${f.locked.text.replace(/^🔒\s*/, '')}` : '✓' }))),
      ...(preview.packs || []).map(p => h('li', { class: 'code-row pack' },
        h('span', { class: 'cel-thumb', text: '📦' }),
        h('span', { class: 'cel-rname' }, h('b', { text: p.items.map(i => i.name).join(', ') }), h('small', { text: `From ${p.name} · a community pack` })),
        h('button', { class: 'btn primary slim-btn', type: 'button', onclick: () => getPack(p) }, 'Get pack'))),
      (preview.unknown || []).length ? h('li', { class: 'code-row unknown' },
        h('span', { class: 'cel-thumb', text: '?' }),
        h('span', { class: 'cel-rname' },
          h('b', { text: `${preview.unknown.length} item${preview.unknown.length === 1 ? '' : 's'} you don't have` }),
          h('small', { text: preview.catalogError ? "Couldn't check the community gallery" : 'From a pack outside the community gallery' }))) : null,
    ].filter(Boolean);
    $('codeItems').replaceChildren(...(rows.length ? rows : [h('li', { class: 'code-row ok' }, h('span', { class: 'cel-thumb', text: '🐚' }), h('span', { class: 'cel-rname' }, h('b', { text: 'Just the crab' }), h('small', { text: 'No outfit: everything comes off' })))]));
    $('codeWear').textContent = wearable.length || !preview.found.length ? 'Wear it' : 'Nothing to wear yet';
    $('codeWear').disabled = !!preview.found.length && !wearable.length;
  }

  async function check() {
    const text = input.value.trim();
    if (text.replace(/[^0-9a-z]/gi, '').length < 7) { preview = null; return render(); }
    const asked = text;
    const r = await api.previewOutfitCode(text);
    if (input.value.trim() !== asked) return; // typed on since
    preview = r;
    render();
  }

  async function getPack(p) {
    const text = input.value;
    close();
    await api.installFromRegistry(p.id); // the usual "Install pack?" confirmation
    open();
    input.value = text; // same code, now with the pack (if it was installed)
    check();
  }

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(check, 250); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !$('codeWear').disabled) $('codeWear').click(); });
  $('wearCodeBtn').addEventListener('click', open);
  $('codeCancel').addEventListener('click', close);
  $('codeClose').addEventListener('click', close);
  sheet.addEventListener('click', e => { if (e.target === sheet) close(); });
  sheet.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  $('codeWear').addEventListener('click', async () => {
    const r = await api.wearOutfitCode(input.value.trim());
    if (!r.ok) { preview = r; return render(); }
    SB.applyWardrobe(r.view);
    close();
    const notes = [r.skipped.length && `${r.skipped.length} still locked`, r.missing.length && `${r.missing.length} from packs you don't have`].filter(Boolean);
    SB.toast(`Wearing their look${notes.length ? ` (${notes.join(', ')})` : '!'}`, { ms: 4000 });
  });
})();
