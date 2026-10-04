/* Shellby panel — the profile card: a 480x200 SVG of your crab, level, streak
   and latest stickers for your GitHub profile README. Drawn here from the same
   pixel data as the crab card; main publishes it to a public gist when it
   changed, and an Action in your profile repo copies it in. Plain SVG only:
   GitHub shows it as an image, so no web fonts, scripts or links. */
'use strict';
(function () {
  const { api, state, $ } = SB;
  const W = 480, H = 200;
  const C = { abyss: '#061316', water: '#0f3039', sand: '#f3e6cc', sandDim: '#b3a892', sandFaint: '#7d7566', glass: '#7fd6c2', coral: '#ff7a5c', amber: '#ffc15e' };
  const FONT = "'Segoe UI', Ubuntu, 'Helvetica Neue', Arial, sans-serif";
  const MONO = "ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace";
  const MAX_STICKERS = 5;
  const CHECK_EVERY_MS = 30 * 60 * 1000; // main skips the upload when nothing changed
  const FIRST_CHECK_MS = 20 * 1000;
  const SOON_MS = 15 * 1000;             // after an outfit, sticker or XP change

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const serializer = new XMLSerializer();

  // A sprite <svg> placed in the card: nested, with its own view box.
  function place(svg, x, y, w, h) {
    svg.setAttribute('x', Math.round(x));
    svg.setAttribute('y', Math.round(y));
    svg.setAttribute('width', Math.round(w));
    svg.setAttribute('height', Math.round(h));
    svg.removeAttribute('class');
    svg.removeAttribute('style');
    // Animation pivots mean nothing out here, and sticker ids are project ids.
    svg.querySelectorAll('[style]').forEach(el => el.removeAttribute('style'));
    svg.querySelectorAll('[data-sticker]').forEach(el => el.removeAttribute('data-sticker'));
    return serializer.serializeToString(svg);
  }

  function crab(box) {
    // His shell stickers, only from projects known to be on show (an unknown id stays off).
    const shown = new Set((state.stickers?.projects || []).filter(p => !p.hidden).map(p => p.id));
    const onShell = (state.outfit?.stickers || []).filter(st => shown.has(st.id));
    const svg = SB.sprite(state.skin, { fit: true, shell: state.outfit?.home ?? null, stickers: onShell });
    if (!(svg instanceof SVGElement)) return '';
    const [, , vw, vh] = (svg.getAttribute('viewBox') || '0 0 22 13').split(' ').map(Number);
    const k = Math.min(box.w / vw, box.h / vh);
    return place(svg, box.x + (box.w - vw * k) / 2, box.y + box.h - vh * k, vw * k, vh * k);
  }

  // Your own latest stickers, minus hidden projects and friends' swaps. Pictures only.
  const latestStickers = () => (state.stickers?.projects || [])
    .filter(p => !p.hidden && !p.from && p.art?.pixels?.length)
    .sort((a, b) => (b.lastShipAt || 0) - (a.lastShipAt || 0))
    .slice(0, MAX_STICKERS);

  function stickerRow(list, x, y, size, gap) {
    return list.map((p, i) => {
      const n = Math.max(...p.art.pixels.map(r => r.length));
      const k = size / Math.max(n, p.art.pixels.length);
      const sx = x + i * (size + gap);
      const tilt = [-6, 4, -3, 5, -4][i];
      const art = place(SB.Sprite.grid(p.art.pixels, p.art.palette), sx, y, n * k, p.art.pixels.length * k);
      return `<g transform="rotate(${tilt} ${sx + size / 2} ${y + size / 2})">${art}</g>`;
    }).join('');
  }

  // Plain ASCII out: however the file ends up served, the emoji and punctuation survive.
  const ascii = s => s.replace(/[^\x00-\x7f]/gu, c => `&#${c.codePointAt(0)};`);

  /** The card as an SVG string. */
  const build = (now = new Date()) => ascii(draw(now));

  function draw(now) {
    const xp = state.xp || { level: 1, title: '', progress: 0, streak: { days: 0 } };
    const login = state.github?.login;
    const whose = login ? `@${login}’s Shellby` : 'My Shellby';
    const days = xp.streak?.days || 0;
    const streak = days ? `🔥 ${days}-day streak` : 'Starting a fresh streak';
    const stickers = latestStickers();
    const updated = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const x0 = 196, colW = W - x0 - 20;
    const barW = Math.round(colW * Math.max(0, Math.min(1, xp.progress || 0)));
    const tank = { x: 16, y: 16, w: 164, h: H - 32 };
    const sandY = tank.y + tank.h - 30;
    const alt = `${whose}: level ${xp.level}${xp.title ? ` ${xp.title}` : ''}, ${days ? `${days}-day streak` : 'no streak yet'}, ${stickers.length} recent sticker${stickers.length === 1 ? '' : 's'}`;

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t">
<title id="t">${esc(alt)}</title>
<style>
.mono{font-family:${MONO}}.sans{font-family:${FONT}}
@media (prefers-reduced-motion: no-preference){
.crab{animation:bob 2.6s ease-in-out infinite}
.bubble{animation:rise 5s linear infinite;opacity:0}
.bubble.b2{animation-delay:1.7s}.bubble.b3{animation-delay:3.3s}
@keyframes bob{50%{transform:translateY(-3px)}}
@keyframes rise{0%{transform:translateY(0);opacity:0}15%{opacity:.6}100%{transform:translateY(-110px);opacity:0}}
}
</style>
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.water}"/><stop offset="1" stop-color="${C.abyss}"/></linearGradient>
<clipPath id="tank"><rect x="${tank.x}" y="${tank.y}" width="${tank.w}" height="${tank.h}" rx="12"/></clipPath>
</defs>
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="14" fill="url(#bg)" stroke="${C.glass}" stroke-opacity=".25"/>
<g clip-path="url(#tank)">
<rect x="${tank.x}" y="${tank.y}" width="${tank.w}" height="${tank.h}" fill="${C.abyss}" fill-opacity=".7"/>
<rect x="${tank.x}" y="${sandY}" width="${tank.w}" height="30" fill="#7a6a4b"/>
<rect x="${tank.x}" y="${sandY}" width="${tank.w}" height="5" fill="#a8946c"/>
<circle class="bubble" cx="${tank.x + 30}" cy="${sandY - 8}" r="3" fill="none" stroke="${C.glass}"/>
<circle class="bubble b2" cx="${tank.x + tank.w - 34}" cy="${sandY - 4}" r="2.5" fill="none" stroke="${C.glass}"/>
<circle class="bubble b3" cx="${tank.x + tank.w / 2 + 20}" cy="${sandY - 10}" r="2" fill="none" stroke="${C.glass}"/>
<ellipse cx="${tank.x + tank.w / 2}" cy="${sandY + 6}" rx="52" ry="5" fill="#000" fill-opacity=".3"/>
<g class="crab" shape-rendering="crispEdges">${crab({ x: tank.x + 14, y: tank.y + 16, w: tank.w - 28, h: sandY + 8 - tank.y - 16 })}</g>
</g>
<rect x="${tank.x}" y="${tank.y}" width="${tank.w}" height="${tank.h}" rx="12" fill="none" stroke="${C.glass}" stroke-opacity=".18"/>
<text x="${x0}" y="38" class="mono" font-size="11" font-weight="600" letter-spacing="1" fill="${C.coral}">${esc(whose.toUpperCase())}</text>
<text x="${x0}" y="72" class="sans" fill="${C.sand}"><tspan font-size="28" font-weight="700">Lv ${xp.level}</tspan><tspan dx="10" font-size="16" fill="${C.sandDim}">${esc(xp.title || '')}</tspan></text>
<rect x="${x0}" y="82" width="${colW}" height="5" rx="2.5" fill="${C.glass}" fill-opacity=".15"/>
<rect x="${x0}" y="82" width="${barW}" height="5" rx="2.5" fill="${C.glass}"/>
<text x="${x0}" y="110" class="sans" font-size="14" fill="${days ? C.amber : C.sandDim}">${esc(streak)}</text>
<text x="${x0}" y="134" class="mono" font-size="10" font-weight="600" letter-spacing="1" fill="${C.sandFaint}">${stickers.length ? 'LATEST STICKERS' : 'NO STICKERS YET'}</text>
${stickers.length ? stickerRow(stickers, x0, 142, 30, 10) : `<text x="${x0}" y="156" class="sans" font-size="12" fill="${C.sandDim}">Ship a project to earn the first one</text>`}
<text x="${W - 20}" y="${H - 14}" text-anchor="end" class="mono" font-size="9" fill="${C.sandFaint}">shellby · ${esc(updated)}</text>
</svg>`;
  }

  // ------------------------------------------------------------ settings + publishing

  let timer = null;
  let soon = null;     // the next one-off check (first check, or after a change)
  let current = null;  // the last profile-card view from main
  let preview = null;  // the last SVG drawn, shown in Settings

  const isOn = () => !!(state.github?.signedIn && state.github.features.profileCard?.on && state.github.features.profileCard?.granted);

  // Everything on the card has arrived (stickers especially: hidden ones are filtered by them).
  const ready = () => !!(state.skin && state.xp && state.stickers?.projects);

  async function publish(force = false) {
    if (!isOn() || !ready()) return null;
    preview = build();
    const r = await api.publishProfileCard(preview, force);
    render(r.view);
    return r;
  }

  function render(v) {
    if (!v) return;
    current = v;
    const row = $('ghProfileCardRow');
    row.hidden = !isOn();
    if (row.hidden) return;
    if (!preview && ready()) preview = build();
    if (preview) $('pcPreview').src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview)}`;
    $('pcStatus').textContent = v.error || (v.publishedAt ? `Card updated ${SB.relTime(v.publishedAt)}. Shellby refreshes it when your crab changes.` : 'Putting the card up…');
    $('pcStatus').classList.toggle('bad', !!v.error);
    $('pcSteps').hidden = !v.workflow;
  }

  // Called on every GitHub view change: only turning on or off starts or stops the checks.
  function checkSoon(ms = SOON_MS) {
    if (!timer) return;
    clearTimeout(soon);
    soon = setTimeout(() => { soon = null; publish().catch(() => {}); }, ms);
  }

  async function load() {
    const on = isOn();
    if (!on && timer) { clearInterval(timer); clearTimeout(soon); timer = soon = null; preview = null; }
    const v = await api.getProfileCard();
    if (on !== isOn()) return; // turned on or off while we asked: that newer load wins
    render(v);
    if (!on || timer) return;
    timer = setInterval(() => publish().catch(() => {}), CHECK_EVERY_MS);
    checkSoon(current?.gistId ? FIRST_CHECK_MS : 0);
  }

  // What's on the card changed: hiding a sticker, especially, shouldn't wait half an hour.
  api.onStickers(() => checkSoon());
  api.onWardrobe(() => checkSoon());
  api.onXp(() => checkSoon());

  const copy = (text, what) => { if (!text) return; api.copyText(text); SB.toast(`${what} copied.`); };

  $('pcPublish').addEventListener('click', async () => {
    $('pcPublish').disabled = true;
    const r = await publish(true);
    $('pcPublish').disabled = false;
    if (r) SB.toast(r.ok ? 'Card updated. Your profile picks it up on the Action\'s next run.' : r.error, { ms: r.ok ? 3000 : 6000 });
  });
  $('pcOpenRepo').addEventListener('click', () => { if (current?.profileRepo) api.openExternal(current.profileRepo); });
  $('pcCopyWorkflow').addEventListener('click', () => copy(current?.workflow, 'Action'));
  $('pcCopyReadme').addEventListener('click', () => copy(current?.readme, 'README line'));

  SB.profileCard = { build, load, publish };
})();
