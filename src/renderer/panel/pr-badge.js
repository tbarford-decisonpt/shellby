/* Shellby panel — "Built with Shellby" on pull requests: a small SVG of your
   crab as he's dressed now, handed to main whenever his look changes. Main
   only uploads it (to <you>/shellby-badge) when a tab opens a pull request,
   and puts your level and the link beside it in the description. Plain SVG,
   for the same reasons as the profile card (profile-card.js). */
'use strict';
(function () {
  const { api, state, $ } = SB;
  const W = 96, H = 64;
  const SOON_MS = 2000; // outfit changes come in bursts while you try things on

  let soon = null;
  let current = null; // the last view from main
  let preview = null; // the last SVG drawn

  const isOn = () => !!(state.github?.signedIn && state.github.features.prBadge?.on && state.github.features.prBadge?.granted);

  const build = () => SB.profileCard.ascii(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Shellby, a pixel hermit crab">
<g shape-rendering="crispEdges">${SB.profileCard.crab({ x: 2, y: 2, w: W - 4, h: H - 4 })}</g>
</svg>`);

  async function send() {
    if (!isOn() || !SB.profileCard?.ready()) return;
    preview = build();
    const r = await api.setPrBadgePicture(preview);
    render(r.view);
  }

  function render(v) {
    if (v) current = v;
    const row = $('ghPrBadgeRow');
    row.hidden = !isOn();
    if (row.hidden || !current) return;
    if (!preview && SB.profileCard?.ready()) preview = build();
    if (preview) $('pbPreview').src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview)}`;
    $('pbStatus').textContent = current.error || 'Pull requests your tabs open get him at the bottom, with your level and a link to Shellby.';
    $('pbStatus').classList.toggle('bad', !!current.error);
  }

  function sendSoon() {
    if (!isOn()) return;
    clearTimeout(soon);
    soon = setTimeout(() => { soon = null; send().catch(() => {}); }, SOON_MS);
  }

  async function load() {
    const on = isOn();
    if (!on) { clearTimeout(soon); preview = null; }
    const v = await api.getPrBadge();
    if (on !== isOn()) return; // turned on or off while we asked: that newer load wins
    render(v);
    if (on) send().catch(() => {});
  }

  // Stickers count too: a hidden project's sticker comes off his shell in the picture.
  api.onWardrobe(() => sendSoon());
  api.onStickers(() => sendSoon());
  api.onPrBadge(v => render(v));
  $('pbOpenRepo').addEventListener('click', () => { if (current?.repoUrl) api.openExternal(current.repoUrl); });

  SB.prBadge = { build, load };
})();
