/* Shellby panel — levels and what they unlock (src/main/progression/levels.js): a thin bar
   under the XP bar toward the next unlock ("Next: 🐚 Ammonite at Lv 32, 1,240 XP
   to go", everything at that level on hover), the whole ladder from 2 to 99, the
   Molt button at 99, and the ceremony a milestone level gets (20, 30 … 99).
   Reads the 'unlocks' view through api.getGame; the XP view comes from xp.js.
   Styles are in molt.css. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const fmt = n => Number(n || 0).toLocaleString();
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const KIND_WORD = { title: 'title', rank: 'badge', shell: 'shell', decor: 'for his tank', effect: 'effect', perk: 'perk', chapter: 'quest chapter', size: 'tank size' };
  const TITLE_MS = 55;   // per letter of the new title
  const CARD_MS = 260;   // between unlock cards flipping in

  const unlockText = u => `${u.icon || '✦'} ${u.name}`;
  const unlockTip = list => list.map(u => `${unlockText(u)} (${KIND_WORD[u.kind] || u.kind})${u.text ? `: ${u.text}` : ''}`).join('\n');

  // ---- the bar under the XP bar

  let box = null;
  function mount() {
    if (box || !$('xpBarWrap')) return box;
    box = h('div', { class: 'lv-next', id: 'lvNext' },
      h('div', { class: 'lv-next-bar', role: 'progressbar', 'aria-label': 'Progress to the next unlock', 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('i')),
      h('div', { class: 'lv-next-row' },
        h('span', { class: 'lv-next-text', tabindex: '0' }),
        h('button', { type: 'button', class: 'btn ghost slim-btn lv-ladder-btn', 'aria-expanded': 'false', onclick: toggleLadder }, 'Every level'),
        h('button', { type: 'button', class: 'btn primary slim-btn lv-molt-btn', hidden: true, onclick: () => SB.openMolt?.() }, '🐚 Molt')),
      h('div', { class: 'lv-ladder', hidden: true }));
    $('xpBarWrap').after(box);
    return box;
  }

  function render(v) {
    if (!v || !mount()) return;
    const u = v.unlock;
    const text = box.querySelector('.lv-next-text');
    const bar = box.querySelector('.lv-next-bar');
    if (!u) {
      text.textContent = v.molts ? `Every unlock is his. ★ marks from here.` : 'Every title, shell, badge and perk is his!';
      text.title = '';
      bar.firstChild.style.transform = 'scaleX(1)';
      bar.setAttribute('aria-valuenow', '100');
    } else {
      const lead = u.unlocks[0];
      const more = u.unlocks.length > 1 ? ` +${u.unlocks.length - 1} more` : '';
      text.textContent = `Next: ${unlockText(lead)}${more} at Lv ${u.level}, ${fmt(u.xpToGo)} XP to go`;
      text.title = `Level ${u.level}:\n${unlockTip(u.unlocks)}`;
      text.setAttribute('aria-label', `Next unlock at level ${u.level}, ${fmt(u.xpToGo)} XP to go: ${u.unlocks.map(x => x.name).join(', ')}`);
      const p = Math.max(0, Math.min(1, u.progress ?? 0));
      bar.firstChild.style.transform = `scaleX(${p.toFixed(3)})`;
      bar.setAttribute('aria-valuenow', String(Math.round(p * 100)));
    }
    const molt = box.querySelector('.lv-molt-btn');
    molt.hidden = !(v.canMolt || v.molts);
    molt.textContent = v.canMolt ? '🐚 Molt' : `🐚 Molt ${v.moltBadge?.text || ''}`.trim();
    molt.classList.toggle('ready', !!v.canMolt);
  }

  // ---- the ladder: every level from 2 to 99

  async function toggleLadder() {
    const list = box.querySelector('.lv-ladder');
    const btn = box.querySelector('.lv-ladder-btn');
    const open = list.hidden;
    list.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (!open) return;
    const view = await api.getGame('unlocks');
    if (!view) { list.replaceChildren(h('p', { class: 'xp-empty', text: 'The level list will be here once he wakes up.' })); return; }
    list.replaceChildren(
      h('ul', { class: 'lv-perks', 'aria-label': 'Perks' }, view.perks.map(p => h('li', { class: p.owned ? 'owned' : '', title: p.text },
        h('b', { text: `⭐ ${p.name}` }), h('small', { text: p.owned ? p.text : `Level ${p.level}` })))),
      h('ol', { class: 'lv-rungs', 'aria-label': 'What every level unlocks' }, view.ladder.filter(r => r.unlocks.length).map(r => h('li', {
        class: ['lv-rung', r.owned ? 'owned' : '', r.isNew ? 'new' : '', `tier-${r.tier}`].filter(Boolean).join(' '),
        title: unlockTip(r.unlocks),
      }, h('span', { class: 'lv-rung-level', text: String(r.level) }),
      h('span', { class: 'lv-rung-items', text: r.unlocks.map(unlockText).join(' · ') })))));
    const at = list.querySelector('.lv-rung:not(.owned)');
    if (at) at.scrollIntoView({ block: 'nearest' });
    if (view.everLevel > view.seenLevel) api.gameAct('unlocks', 'seen');
  }

  // ---- the ceremony for a milestone level

  let sheet = null;
  function closeCeremony() {
    if (!sheet) return;
    sheet.remove();
    sheet = null;
  }

  function cardFor(u) {
    const art = u.pixels ? SB.Sprite.grid(u.pixels, u.palette, { px: 3, ink: true }) : h('span', { class: 'lv-card-icon', text: u.icon || '✦' });
    return h('li', { class: `lv-card kind-${u.kind}` }, art, h('b', { text: u.name }), h('small', { text: KIND_WORD[u.kind] || u.kind }));
  }

  /** e: the xp:levelup payload ({ level, title, rank, milestone: { tier, fanfare }, unlocks, shell, canMolt }). */
  SB.levelCeremony = e => {
    closeCeremony();
    const legend = e.milestone?.tier === 'legend';
    const unlocks = [...(e.shell ? [{ ...e.shell, kind: 'shell' }] : []), ...(e.unlocks || []).filter(u => !(e.shell && u.kind === 'shell'))];
    const title = h('h2', { class: 'lv-cer-title', 'aria-label': e.title });
    const cards = h('ul', { class: 'lv-cards' });
    const hasDecor = unlocks.some(u => u.kind === 'decor');
    sheet = h('div', { class: `lv-ceremony${legend ? ' legend' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': `Level ${e.level}: ${e.title}`, style: `--cer:${e.rank?.color || 'var(--rank)'}` },
      h('div', { class: 'lv-cer-sweep', 'aria-hidden': 'true' }),
      h('div', { class: 'lv-cer-body' },
        h('p', { class: 'lv-cer-eyebrow', text: `${legend ? 'Legendary' : 'Milestone'} · Level ${e.level} · ${e.rank?.name || ''} rank` }),
        title,
        h('p', { class: 'lv-cer-text', text: e.text || '' }),
        cards,
        h('div', { class: 'lv-cer-actions' },
          e.shell ? h('button', { type: 'button', class: 'btn primary', onclick: async () => { await api.wearHome(e.shell.id); closeCeremony(); } }, 'Wear it now') : null,
          hasDecor ? h('button', { type: 'button', class: 'btn', onclick: () => { closeCeremony(); SB.setView('tank'); } }, 'Put it in the tank') : null,
          e.canMolt && SB.openMolt ? h('button', { type: 'button', class: 'btn', onclick: () => { closeCeremony(); SB.openMolt(); } }, '🐚 Molt…') : null,
          legend ? h('button', { type: 'button', class: 'btn ghost', onclick: () => { closeCeremony(); SB.crabCard?.share(); } }, '📸 Share') : null,
          h('button', { type: 'button', class: 'btn ghost', onclick: closeCeremony }, 'Lovely'))));
    sheet.addEventListener('keydown', ev => { if (ev.key === 'Escape') { ev.stopPropagation(); closeCeremony(); } });
    document.body.append(sheet);
    sheet.querySelector('.lv-cer-actions .btn')?.focus();
    // The title writes itself letter by letter, then the cards flip in; with reduced motion, all at once.
    const still = reduced();
    if (still) title.textContent = e.title; else [...e.title].forEach((ch, i) => setTimeout(() => { title.textContent += ch; }, i * TITLE_MS));
    const start = still ? 0 : e.title.length * TITLE_MS;
    unlocks.forEach((u, i) => {
      const add = () => { if (sheet) cards.append(cardFor(u)); };
      if (still) add(); else setTimeout(add, start + i * CARD_MS);
    });
  };

  SB.levelsUi = { render };
  api.onXp(render);
  const renderTrophies = SB.views.trophies.render;
  SB.views.trophies.render = () => { renderTrophies(); render(state.xp); };
})();
