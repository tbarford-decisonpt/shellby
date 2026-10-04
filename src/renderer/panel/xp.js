/* Shellby panel — XP and levels: the titlebar badge, the Trophies XP card
   (next unlock, boosts, today's bounties, the last 30 days), and the level-up
   celebration. What earns XP comes from main (xp.js AWARDS), not a copy here. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const KIND_ICON = { trick: '🧠', deploy: '🚀', fixed: '🟢', ship: '⬆️', issue: '🎫', tests: '✅', deps: '🧼', trophy: '🏆', task: '🦀', day: '☀️', focus: '⛑️', bounty: '🎯', pet: '♥', play: '🙈', find: '🐚', treasure: '🏴‍☠️', bond: '💞' };
  const KIND_NAME = { trick: 'Tricks', deploy: 'Deploys', fixed: 'Fixes', flakefix: 'Flaky fixes', issue: 'Issues taken on', tidy: 'Tidying', fresh: 'Fresh starts', ship: 'Pushes', tests: 'Tests', deps: 'Checkups', trophy: 'Trophies', task: 'Tasks', day: 'Days', focus: 'Focus', bounty: 'Bounties', pet: 'Pets', play: 'Games', find: 'Finds', treasure: 'Treasure', bond: 'Bond' };
  const UNLOCK_NAME = { shell: 'shell', title: 'title', rank: '' };
  const TOP_KINDS = 3;   // where the XP came from, under the 30-day chart
  const LOG_ROWS = 5;    // latest XP rows; the chart above covers the rest
  const fmt = n =>Number(n || 0).toLocaleString();
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

  // One line for "what's next": the XP to the next level, then what it unlocks,
  // or the next level that unlocks anything when that's further off.
  function unlockLine(v) {
    const u = v.unlock;
    if (!u) return v.level >= 99 ? '' : ' · everything is unlocked';
    // "Snail Shell" already says shell; "Tidecaller" needs "title".
    const names = u.unlocks.map(x => (UNLOCK_NAME[x.kind] && !x.name.toLowerCase().includes(UNLOCK_NAME[x.kind]) ? `${x.name} ${UNLOCK_NAME[x.kind]}` : x.name)).join(', ');
    return u.level === v.level + 1 ? ` · unlocks ${names}` : ` · ${names} at level ${u.level}, ${fmt(u.xpToGo)} XP to go`;
  }

  // Short pills; the full sentence is on hover and for screen readers.
  function boosts(v) {
    const list = [];
    if (v.streak?.multiplier > 1) list.push({ icon: '🔥', text: `×${v.streak.multiplier.toFixed(2)}`, title: `${v.streak.days}-day streak: ×${v.streak.multiplier.toFixed(2)} XP` });
    else if (v.streak?.days) list.push({ icon: '🔥', text: `${v.streak.days}/7`, title: `${v.streak.days}-day streak. Keep it to 7 days for ×1.05 XP` });
    if (v.rested > 0) list.push({ icon: '😴', text: `2× ${fmt(v.rested)}`, title: `Rested: the next ${fmt(v.rested)} XP counts double` });
    return list;
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
    const kinds = [...(v.byKind || [])].sort((a, b) => b.xp - a.xp).slice(0, TOP_KINDS);
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
    $('xpEyebrow').textContent = v.rank?.name ? `Level · ${v.rank.name}` : 'Level';
    $('xpNext').textContent = v.level >= 99 ? 'Max level. Every shell, title and badge is his!' : `${fmt(v.needed - v.into)} XP to level ${v.level + 1}`;
    const unlock = unlockLine(v);
    $('xpUnlock').hidden = !unlock;
    $('xpUnlock').textContent = unlock;
    const b = boosts(v);
    $('xpBoosts').hidden = !b.length;
    $('xpBoosts').replaceChildren(...b.map(x => h('li', { title: x.title },
      h('span', { 'aria-hidden': 'true', text: `${x.icon} ${x.text}` }), h('span', { class: 'sr-only', text: x.title }))));
    renderBounties(v.bounties);
    renderHistory(v);
    // Just the crab: only the ways that don't need Claude.
    const ways = (v.ways || []).filter(w => !(w.claude && state.settings.crabOnly));
    $('xpWaysCount').textContent = `· ${ways.length}`;
    $('xpWays').replaceChildren(...ways.map(w => h('li', {}, h('span', { text: KIND_ICON[w.kind] || '✦' }), h('span', { text: w.text }), h('b', { text: `+${w.xp}` }))));
    $('xpLog').replaceChildren(...(v.log.length ? v.log.slice(0, LOG_ROWS).map(e => h('li', { title: e.bonus ? `Bonus: ${e.bonus}` : null },
      h('span', { class: 'xp-log-icon', text: KIND_ICON[e.kind] || '✦' }),
      h('span', { class: 'xp-log-label', text: [e.project ? `${e.label} · ${e.project}` : e.label, e.bonus].filter(Boolean).join(' · ') }),
      h('b', { text: `+${e.xp}` }),
      h('time', { text: SB.relTime(e.at) }))) : [h('li', { class: 'xp-empty', text: state.settings.crabOnly ? 'No XP yet. Give him a pet!' : 'No XP yet. Give Shellby a task, or a pet!' })]));
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
