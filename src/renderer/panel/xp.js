/* Shellby panel — XP and levels: the titlebar badge, the Trophies XP card
   (next unlock, boosts, today's bounties, the last 30 days), and the level-up
   celebration. What earns XP comes from main (xp.js AWARDS), not a copy here. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const KIND_ICON = { trick: '🧠', deploy: '🚀', fixed: '🟢', ship: '⬆️', tests: '✅', deps: '🧼', trophy: '🏆', task: '🦀', day: '☀️', focus: '⛑️', bounty: '🎯' };
  const KIND_NAME = { trick: 'Tricks', deploy: 'Deploys', fixed: 'Fixes', ship: 'Pushes', tests: 'Tests', deps: 'Checkups', trophy: 'Trophies', task: 'Tasks', day: 'Days', focus: 'Focus', bounty: 'Bounties' };
  const UNLOCK_NAME = { shell: 'shell', title: 'title', rank: '' };
  const fmt = n => Number(n || 0).toLocaleString();
  const shortDay = key => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };

  function apply(v) {
    if (!v) return;
    state.xp = v;
    if (v.rank?.color) document.documentElement.style.setProperty('--rank', v.rank.color);
    $('brandLevel').hidden = false;
    $('brandLevel').textContent = String(v.level);
    $('brandXp').style.transform = `scaleX(${v.progress.toFixed(3)})`;
    const progress = v.level >= 99 ? `Level 99 ${v.title}` : `Level ${v.level} ${v.title} · ${v.into}/${v.needed} XP to level ${v.level + 1}`;
    $('brandLevel').title = `${progress}. Open Trophies & XP`;
    $('brandLevel').setAttribute('aria-label', `Level ${v.level}: open Trophies and XP`);
    if (state.view === 'trophies') render();
  }

  function unlockLine(u) {
    if (!u) return 'Every shell, title and badge is his. Shellby Supreme!';
    // "Snail Shell" already says shell; "Tidecaller" needs "title".
    const names = u.unlocks.map(x => (UNLOCK_NAME[x.kind] && !x.name.toLowerCase().includes(UNLOCK_NAME[x.kind]) ? `${x.name} ${UNLOCK_NAME[x.kind]}` : x.name)).join(', ');
    return `Next at level ${u.level}: ${names} · ${fmt(u.xpToGo)} XP to go`;
  }

  function boosts(v) {
    const list = [];
    if (v.streak?.multiplier > 1) list.push(`🔥 ${v.streak.days}-day streak: ×${v.streak.multiplier.toFixed(2)} XP`);
    else if (v.streak?.days) list.push(`🔥 ${v.streak.days}-day streak · keep it to 7 days for ×1.05 XP`);
    if (v.rested > 0) list.push(`😴 Rested: the next ${v.rested} XP counts double`);
    return list.join(' · ');
  }

  function renderBounties(b) {
    $('xpBounties').hidden = !b?.list?.length;
    if (!b?.list?.length) return;
    $('xpBountyBonus').textContent = b.cleared ? '· all done!' : `· +${b.bonus} for all three`;
    $('xpBountyList').replaceChildren(...b.list.map(x => h('li', { class: x.done ? 'done' : '' },
      h('span', { class: 'xp-bounty-check', 'aria-hidden': 'true', text: x.done ? '✓' : '' }),
      h('span', { text: x.text }),
      h('small', { text: x.goal > 1 ? `${x.count}/${x.goal}` : '' }),
      h('b', { text: `+${x.xp}` }),
      h('span', { class: 'sr-only', text: x.done ? 'done' : 'not done yet' }))));
  }

  function renderHistory(v) {
    const days = v.daily || [];
    const top = Math.max(1, ...days.map(d => d.xp));
    const sum = days.reduce((n, d) => n + d.xp, 0);
    $('xpHistoryTotal').textContent = `· ${fmt(sum)} XP`;
    const spark = $('xpSpark');
    spark.setAttribute('aria-label', `XP per day for the last 30 days: ${fmt(sum)} in total, best day ${fmt(top === 1 && !sum ? 0 : top)}`);
    spark.replaceChildren(...days.map(d => h('i', {
      class: d.xp ? '' : 'zero', title: `${shortDay(d.day)}: ${fmt(d.xp)} XP`,
      style: `height:${d.xp ? Math.max(8, Math.round((d.xp / top) * 100)) : 4}%`,
    })));
    const kinds = [...(v.byKind || [])].sort((a, b) => b.xp - a.xp).slice(0, 6);
    $('xpKinds').replaceChildren(...kinds.map(k => h('li', { title: `${KIND_NAME[k.kind] || k.kind}: ${fmt(k.xp)} XP` },
      h('span', { text: KIND_ICON[k.kind] || '✦' }), h('span', { text: KIND_NAME[k.kind] || k.kind }), h('b', { text: fmt(k.xp) }))));
  }

  function render() {
    const v = state.xp;
    if (!v) return;
    $('xpLevel').textContent = v.level;
    $('xpTitle').textContent = v.title;
    $('xpTotal').textContent = `${fmt(v.xp)} XP`;
    $('xpCard').dataset.rank = v.rank?.name || '';
    $('xpBar').style.transform = `scaleX(${v.progress.toFixed(3)})`;
    $('xpBarWrap').setAttribute('aria-valuenow', Math.round(v.progress * 100));
    $('xpNext').textContent = v.level >= 99 ? `${v.rank?.name || ''} badge · max level` : `${fmt(v.needed - v.into)} XP to level ${v.level + 1} · ${v.rank?.name || ''} badge`;
    $('xpUnlock').hidden = false;
    $('xpUnlock').textContent = unlockLine(v.unlock);
    const b = boosts(v);
    $('xpBoosts').hidden = !b;
    $('xpBoosts').textContent = b;
    renderBounties(v.bounties);
    renderHistory(v);
    $('xpWays').replaceChildren(...(v.ways || []).map(w => h('li', {}, h('span', { text: KIND_ICON[w.kind] || '✦' }), h('span', { text: w.text }), h('b', { text: `+${w.xp}` }))));
    $('xpLog').replaceChildren(...(v.log.length ? v.log.slice(0, 8).map(e => h('li', { title: e.bonus ? `Bonus: ${e.bonus}` : null },
      h('span', { class: 'xp-log-icon', text: KIND_ICON[e.kind] || '✦' }),
      h('span', { class: 'xp-log-label', text: [e.project ? `${e.label} · ${e.project}` : e.label, e.bonus].filter(Boolean).join(' · ') }),
      h('b', { text: `+${e.xp}` }),
      h('time', { text: SB.relTime(e.at) }))) : [h('li', { class: 'xp-empty', text: 'No XP yet. Give Shellby a task!' })]));
  }

  api.onXp(apply);
  api.onXpBounty(b => SB.toast(`🎯 ${b.id === 'all' ? "All of today's bounties" : `Bounty done: ${b.text}`} · +${b.xp} XP`, { ms: 4000 }));
  api.onLevelUp(e => SB.celebrate({
    eyebrow: 'Level up', icon: e.shell ? '🐚' : '⭐', title: `Level ${e.level} · ${e.title}`,
    text: [e.shell ? `He outgrew his shell and moved into a ${e.shell.name}. Swap homes any time in Outfits → Homes.` : e.text, e.unlocked].filter(Boolean).join(' '),
    rewards: e.shell ? [e.shell] : [],
  }));
  const renderTrophies = SB.views.trophies.render;
  SB.views.trophies.render = () => { renderTrophies(); render(); };
  api.getXp().then(apply);
})();
