/* Shellby panel — XP and levels: the titlebar badge, the Trophies XP card
   (next unlock, boosts, today's bounties, the last 30 days), and the level-up
   celebration. What earns XP comes from main (xp.js AWARDS), not a copy here. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const KIND_ICON = { trick: '🧠', deploy: '🚀', fixed: '🟢', cifix: '🟢', merged: '🔀', home: '🏠', helped: '🤝', flakefix: '👻', crit: '💥', landing: '🛬', tidy: '🧹', fresh: '🌱', quest: '🗺️', questline: '🗺️', care: '🫧', feed: '🦐', newbug: '🫙', catch: '🫙', ship: '⬆️', issue: '🎫', tests: '✅', deps: '🧼', trophy: '🏆', task: '🦀', day: '☀️', focus: '⛑️', bounty: '🎯', pet: '♥', play: '🙈', find: '🐚', treasure: '🏴‍☠️', bond: '💞', medal: '🏅', hatch: '🐣', sparkle: '✨', swap: '🤝' };
  const KIND_NAME = { trick: 'Tricks', deploy: 'Deploys', fixed: 'Fixes', cifix: 'CI fixes', merged: 'Merges', home: 'Brought home', helped: "Helpers' finds", quest: 'Quests', questline: 'Quest line', care: 'Care', feed: 'Snacks', flakefix: 'Flaky fixes', crit: 'Critical hits', landing: 'Clean landings', newbug: 'New bugs', catch: 'Bugs caught', issue: 'Issues taken on', tidy: 'Tidying', fresh: 'Fresh starts', ship: 'Pushes', tests: 'Tests', deps: 'Checkups', trophy: 'Trophies', task: 'Tasks', day: 'Days', focus: 'Focus', bounty: 'Bounties', pet: 'Pets', play: 'Games', find: 'Finds', treasure: 'Treasure', bond: 'Bond', medal: 'Tide events', hatch: 'Eggs hatched', sparkle: 'Sparklies', swap: 'Swaps' };
  const UNLOCK_NAME = { shell: 'shell', title: 'title', rank: '' };
  const TOP_KINDS = 3;   // where the XP came from, under the 30-day chart
  const LOG_ROWS = 5;    // latest XP rows; the chart above covers the rest
  const fmt = n =>Number(n || 0).toLocaleString();
  const shortDay = key => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };

  // Past level 99 the XP goes to marks (★, xp.js), so "next" is the next mark.
  const markWord = n => (n === 1 ? '1 mark' : `${n} marks`);
  const levelLine = v => `Level ${v.level} ${v.title}${v.marks ? `, ${markWord(v.marks)}` : ''}`;
  const nextName = v => (v.level >= 99 ? `★${(v.marks || 0) + 1}` : `level ${v.level + 1}`);

  function apply(v) {
    if (!v) return;
    state.xp = v;
    if (v.rank?.color) document.documentElement.style.setProperty('--rank', v.rank.color);
    const marks = v.marks || 0;
    $('brandLevel').hidden = false;
    $('brandLevel').textContent = marks ? `${v.level}★${marks}` : String(v.level);
    $('brandXp').style.transform = `scaleX(${v.progress.toFixed(3)})`;
    $('brandLevel').title = `${levelLine(v)}${v.needed ? ` · ${fmt(v.into)}/${fmt(v.needed)} XP to ${nextName(v)}` : ''}. Open Trophies & XP`;
    $('brandLevel').setAttribute('aria-label', `${levelLine(v)}: open Trophies and XP`);
    moltRing($('brandLevel'), v);
    if (state.view === 'trophies') render();
  }

  // After a molt, a ring round the level badge in the tier's colour, with its numeral (molting.js moltBadge).
  function moltRing(el, v) {
    const b = v.molts ? v.moltBadge || { text: String(v.molts) } : null;
    el.classList.toggle('molted', !!b);
    if (b) { el.dataset.molt = b.text; el.style.setProperty('--molt', b.color || 'var(--rank)'); } else delete el.dataset.molt;
  }

  // One line for "what's next" when levels-ui.js isn't drawing its bar: what the next level unlocks.
  function unlockLine(v) {
    if (SB.levelsUi) return '';
    const u = v.unlock;
    if (!u) return v.level >= 99 ? '' : ' · everything is unlocked';
    // "Snail Shell" already says shell; "Tidecaller" needs "title".
    const names = u.unlocks.map(x => (UNLOCK_NAME[x.kind] && !x.name.toLowerCase().includes(UNLOCK_NAME[x.kind]) ? `${x.name} ${UNLOCK_NAME[x.kind]}` : x.name)).join(', ');
    return u.level === v.level + 1 ? ` · unlocks ${names}` : ` · ${names} at level ${u.level}, ${fmt(u.xpToGo)} XP to go`;
  }

  const WEEKEND = [0, 6];
  const weekendsOff = s => WEEKEND.every(d => (s?.restDays || []).includes(d));

  // Short pills; the full sentence is on hover and for screen readers. The streak
  // never punishes: rest days and a tide-out a week hold it, and the bonus eases off.
  function boosts(v) {
    const list = [];
    const s = v.streak || {};
    const weeks = s.weeks ? `${s.weeks} full week${s.weeks === 1 ? '' : 's'}` : 'no full week yet';
    if (s.multiplier > 1) list.push({ icon: '🔥', text: `×${s.multiplier.toFixed(2)}`, title: `${s.days} worked days, ${weeks}: ×${s.multiplier.toFixed(2)} XP. After a break it eases off 5% a missed day, never all at once` });
    else if (s.days) list.push({ icon: '🔥', text: `${s.days}`, title: `${s.days} worked days. A week with 3 or more worked days adds ×0.05 XP` });
    if (s.tideOutsLeft != null && s.days) {
      list.push({ icon: '🌊', text: `${s.tideOutsLeft}`, title: s.tideOutsLeft ? `${s.tideOutsLeft} tide-out day${s.tideOutsLeft === 1 ? '' : 's'} left this week: miss a working day and the streak holds` : 'This week\'s tide-out is used: it held your streak' });
    }
    if (s.restToday) list.push({ icon: '🏖️', text: 'day off', title: 'A rest day: the streak holds without you' });
    if (v.rested > 0) list.push({ icon: '😴', text: `2× ${fmt(v.rested)}`, title: `Rested: the next ${fmt(v.rested)} XP counts double` });
    return list;
  }

  // Weekends off (the default) or not: rest days hold the streak, from today on.
  async function toggleWeekends() {
    const off = weekendsOff(state.xp?.streak);
    const next = off ? (state.xp.streak.restDays || []).filter(d => !WEEKEND.includes(d)) : [...new Set([...(state.xp?.streak?.restDays || []), ...WEEKEND])];
    await api.setStreaks({ restDays: next });
    SB.toast(off ? 'Weekends count as working days now (from today)' : 'Weekends off: Saturday and Sunday hold the streak');
  }

  function renderBounties(b) {
    $('xpBounties').hidden = !b?.list?.length;
    if (!b?.list?.length) return;
    $('xpBountyBonus').textContent = b.cleared ? '· all done!' : `· +${b.bonus} for all ${b.list.length === 4 ? 'four' : 'three'}`;
    // The bounty-reroll perk: swap one not yet done, once a day.
    const reroll = async id => { const r = await api.gameAct('unlocks', 'reroll', { id }); if (!r?.ok) SB.toast('Today\'s reroll is used'); };
    $('xpBountyList').replaceChildren(...b.list.map(x => h('li', { class: x.done ? 'done' : '' },
      h('span', { class: 'xp-bounty-check', 'aria-hidden': 'true', text: x.done ? '✓' : '' }),
      h('span', { text: x.text }),
      h('small', { text: x.goal > 1 ? `${x.count}/${x.goal}` : '' }),
      b.canReroll && !x.done ? h('button', { type: 'button', class: 'icon-btn xp-reroll', title: 'Swap this bounty for another (once a day)', 'aria-label': `Swap "${x.text}" for another bounty`, onclick: () => reroll(x.id) }, '🎲') : null,
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

  // The character sheet: his class and four stats, each with what this week added.
  // Every stat is Claude Code work, so just the crab leaves it off.
  function renderSheet(c) {
    $('xpSheet').hidden = !c || !!state.settings.crabOnly;
    if ($('xpSheet').hidden) return;
    $('xpClassIcon').textContent = c.cls.icon;
    $('xpClassName').textContent = c.cls.name;
    $('xpClassBlurb').textContent = c.cls.blurb;
    $('xpSheetWeek').textContent = c.weekCls && c.weekCls.id !== c.cls.id ? `· played as a ${c.weekCls.name} this week` : '';
    // Bars against the top stat, so their shape is what picks the class.
    const top = Math.max(10, ...c.stats.map(s => s.value));
    $('xpStats').replaceChildren(...c.stats.map(s => {
      const next = s.next ? `${fmt(s.next)} XP to ${s.value + 1}` : 'maxed out';
      const week = s.week ? ` · +${fmt(s.week)} XP this week` : '';
      const title = `${s.name} ${s.value}: ${s.what}. ${fmt(s.xp)} XP${week} · ${next}`;
      return h('li', { class: c.cls.stats.includes(s.id) ? 'top' : '', title },
        h('span', { 'aria-hidden': 'true', text: s.icon }),
        h('span', { class: 'xp-stat-name', text: s.name }),
        h('span', { class: 'xp-stat-bar', 'aria-hidden': 'true' }, h('i', { style: `transform:scaleX(${(s.value / top).toFixed(3)})` })),
        h('b', { text: String(s.value) }),
        h('span', { class: 'xp-stat-gain', text: s.gain ? `+${s.gain}` : '' }),
        h('span', { class: 'sr-only', text: title }));
    }));
    // The classes he has been, once there's more than the one he is.
    const met = c.seen.filter(x => x.id !== c.cls.id);
    $('xpClasses').hidden = !met.length;
    $('xpClasses').textContent = met.length ? `Has also been: ${met.map(x => `${x.icon} ${x.name}`).join(', ')}` : '';
  }

  function render() {
    const v = state.xp;
    if (!v) return;
    renderSheet(v.character);
    $('xpLevel').textContent = v.level;
    moltRing($('xpLevel'), v);
    $('xpTitle').textContent = v.title;
    $('xpTotal').textContent = `${fmt(v.xp)} XP`;
    $('xpCard').dataset.rank = v.rank?.name || '';
    $('xpBar').style.transform = `scaleX(${v.progress.toFixed(3)})`;
    $('xpBarWrap').setAttribute('aria-valuenow', Math.round(v.progress * 100));
    $('xpEyebrow').textContent = ['Level', v.rank?.name, v.marks ? `★${v.marks}` : ''].filter(Boolean).join(' · ');
    const toGo = v.needed ? `${fmt(v.needed - v.into)} XP to ${nextName(v)}` : 'Every mark there is!';
    $('xpNext').textContent = v.level >= 99 && !v.marks ? `Every shell, title and badge is his! ${toGo}` : toGo;
    const unlock = unlockLine(v);
    $('xpUnlock').hidden = !unlock;
    $('xpUnlock').textContent = unlock;
    const b = boosts(v);
    const off = weekendsOff(v.streak);
    $('xpBoosts').hidden = false;
    $('xpBoosts').replaceChildren(...b.map(x => h('li', { title: x.title },
      h('span', { 'aria-hidden': 'true', text: `${x.icon} ${x.text}` }), h('span', { class: 'sr-only', text: x.title }))),
    h('li', { class: 'xp-rest' }, h('button', {
      type: 'button', class: 'xp-rest-btn', 'aria-pressed': String(off), onclick: toggleWeekends,
      title: off ? 'Weekends off: Saturday and Sunday hold the streak. Click to count them as working days' : 'Weekends count as working days. Click to take them off',
    }, off ? '🏖️ weekends off' : '🗓️ 7-day weeks')));
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
  // A milestone level (levels.js milestone: 20, 30 … 99) gets the full ceremony (levels-ui.js).
  api.onLevelUp(e => (e.milestone && e.milestone.tier !== 'minor' && SB.levelCeremony ? SB.levelCeremony(e) : SB.celebrate(e.marks && !e.shell ? {
    eyebrow: 'New mark', icon: '★', title: `★${e.marks} · ${e.title}`,
    text: `${markWord(e.marks)} past level 99. ${e.text}`,
  } : {
    eyebrow: 'Level up', icon: e.shell ? '🐚' : '⭐', title: `Level ${e.level} · ${e.title}`,
    text: [e.shell ? `He outgrew his shell and moved into a ${e.shell.name}. Swap homes any time in Outfits → Homes.` : e.text, e.unlocked].filter(Boolean).join(' '),
    rewards: e.shell ? [e.shell] : [],
    action: e.canMolt && SB.openMolt ? { label: '🐚 Molt…', run: () => SB.openMolt() } : undefined,
  })));
  api.onXpClass(c => SB.celebrate({
    eyebrow: 'New class', icon: c.icon, title: c.name,
    text: `${c.blurb} That's what his stats say now.`,
    action: { label: 'See his stats', run: () => SB.setView('trophies') },
  }));
  const renderTrophies = SB.views.trophies.render;
  SB.views.trophies.render = () => { renderTrophies(); render(); };
  api.getXp().then(apply);
})();
