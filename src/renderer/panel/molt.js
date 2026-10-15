/* Shellby panel — the Molt sheet (src/main/progression/molting.js): at level 99 he can molt,
   starting again at level 1 with everything kept, for a tier shell of his own.
   The sheet shows the shell he'll move into (with its frames, colour cycle, glow
   and sparkles, drawn by shared/sprite.js), what he keeps, and the tier shells
   he has already earned, any of which he can wear. The molt itself is asked
   about in Shellby's own confirm window, then played here: the old shell rolls
   aside, the new one drops in, the badge stamps. Reads the 'molt' view through
   api.getGame / api.gameAct / api.onGame. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const fmt = n => Number(n || 0).toLocaleString();
  const CRAB_PX = 7;
  const TIER_PX = 3;
  const CEREMONY_MS = 2600;
  let view = null;
  let lastFocus = null;

  const sheet = () => $('moltSheet');
  const open = () => !!sheet() && !sheet().hidden;

  // His shell alone, effects and all: an empty skin under it, so only the shell is drawn.
  const EMPTY_SKIN = { pixels: Array.from({ length: 12 }, () => '.'.repeat(13)), palette: {}, parts: {} };
  const shellArt = (shell, px) => SB.Sprite.build(EMPTY_SKIN, { shell, px, ink: true });

  function render(v) {
    if (!v || !sheet()) return;
    view = v;
    const next = v.next;
    $('moltEyebrow').textContent = v.count ? `Molt ${v.badge?.text} · climbing again` : 'The Molt';
    $('moltTitle').textContent = v.canMolt ? `Molt into the ${next.name}?` : v.count ? `He's on his molt ${v.badge?.text} climb` : 'Molting opens at level 99';
    $('moltCrab').replaceChildren(state.skin ? SB.sprite(state.skin, { shell: next, stickers: [], px: CRAB_PX, accessories: [] }) : shellArt(next, CRAB_PX));
    $('moltOld').replaceChildren();
    $('moltStamp').textContent = v.nextBadge?.text || '';
    $('moltStamp').style.setProperty('--molt', v.nextBadge?.color || 'var(--rank)');
    $('moltStamp').classList.remove('stamped');
    $('moltShellName').textContent = `${next.name}${next.molt > 12 ? ' (one of a kind)' : ''}: ${next.description || ''}`;
    $('moltText').textContent = v.canMolt
      ? `He'll be level 1 again and keep everything. The climb back is ${Math.round(v.nextCurve * 100)}% as long as the first, and he can molt again at 99.`
      : `${fmt(v.xpTo99)} XP to level 99, then the ${next.name} is his. Molting is never required: staying at 99 earns ★ marks.`;
    $('moltGo').disabled = !v.canMolt || !!v.busy;
    $('moltGo').textContent = v.canMolt ? `🐚 Molt ${v.nextBadge?.text || ''}`.trim() : 'Molt at level 99';
    renderTiers(v);
  }

  function renderTiers(v) {
    const tiers = v.tiers || [];
    $('moltTiersHead').hidden = !tiers.length;
    $('moltTiers').replaceChildren(...tiers.map(s => {
      const worn = v.worn === s.id;
      return h('li', {}, h('button', {
        type: 'button', class: `molt-tier${worn ? ' worn' : ''}`, 'aria-pressed': String(worn),
        title: worn ? `He lives in the ${s.name}` : `Wear the ${s.name}`,
        onclick: () => wear(s.id),
      }, h('span', { class: 'molt-tier-art' }, shellArt(s, TIER_PX)), h('small', { text: `#${s.molt}` })));
    }));
  }

  async function wear(id) {
    const r = await api.gameAct('molt', 'wear', { id });
    if (!r?.ok) { SB.toast(r?.error || "He couldn't move into that one."); return; }
    render(r.view);
  }

  async function go() {
    if (!view?.canMolt) return;
    $('moltGo').disabled = true;
    const r = await api.gameAct('molt', 'molt');
    if (!r) { $('moltGo').disabled = false; return; }
    if (!r.ok) {
      if (!r.canceled) SB.toast(r.error || "He couldn't molt just now.");
      render(r.view);
      return;
    }
    ceremony(r);
  }

  // The panel's half of it (the crab plays his on the desktop): old shell aside, new one in, the stamp.
  function ceremony(r) {
    const stage = $('moltStage');
    const was = view?.current || state.outfit?.home || null;
    if (was) $('moltOld').replaceChildren(shellArt(was, CRAB_PX));
    stage.classList.remove('molting');
    void stage.offsetWidth; // restart the animation
    stage.classList.add('molting');
    $('moltStamp').textContent = r.view.badge?.text || '';
    $('moltStamp').style.setProperty('--molt', r.view.badge?.color || 'var(--rank)');
    $('moltStamp').classList.add('stamped');
    $('moltTitle').textContent = `Molt ${r.view.badge?.text}: the ${r.view.current?.name}`;
    $('moltEyebrow').textContent = 'He molted!';
    $('moltText').textContent = 'Level 1 again, with everything he had. Every level from here is the climb to his next tier shell.';
    $('moltGo').disabled = true;
    setTimeout(() => { stage.classList.remove('molting'); render(r.view); }, CEREMONY_MS);
  }

  /** Open the sheet (from the XP card's Molt button, a level-99 celebration, or the Logbook). */
  SB.openMolt = async () => {
    const v = await api.getGame('molt');
    if (!v) { SB.toast('Molting wakes up with him: try again in a moment.'); return; }
    lastFocus = document.activeElement;
    render(v);
    sheet().hidden = false;
    document.body.classList.add('molt-open');
    $('moltGo').disabled ? $('moltLater').focus() : $('moltGo').focus();
  };

  function close() {
    if (!open()) return;
    sheet().hidden = true;
    document.body.classList.remove('molt-open');
    lastFocus?.focus?.();
  }

  $('moltClose')?.addEventListener('click', close);
  $('moltLater')?.addEventListener('click', close);
  $('moltGo')?.addEventListener('click', go);
  sheet()?.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  sheet()?.addEventListener('click', e => { if (e.target === sheet()) close(); });

  api.onGame(e => {
    if (e?.what !== 'molt') return;
    if (open()) render(e.view);
    if (e.event?.kind === 'ready' && !open()) {
      SB.celebrate({
        eyebrow: 'Level 99', icon: '🐚', title: `The ${e.view?.next?.name || 'tier shell'} is waiting`,
        text: 'He can molt now: level 1 again, everything kept, and a tier shell of his own. Or stay at 99 and earn ★ marks.',
        action: { label: '🐚 See the Molt', run: () => SB.openMolt() },
      });
    }
  });
})();
