/* Shellby panel — XP and levels: the titlebar badge, the Trophies XP card,
   and the level-up celebration. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  // [icon, what, xp, needs Claude]. Just-the-crab mode lists only the ones that don't.
  const WAYS = [
    ['🧠', 'Writes himself a new skill or agent', 150, true],
    ['💞', 'The two of you grow closer', 50],
    ['🚀', 'Deploys or publishes', 50, true],
    ['⬆️', 'Pushes code', 40, true],
    ['🏴‍☠️', 'Digs up something rare', 30],
    ['✅', 'Tests pass', 25, true],
    ['🏆', 'Earns a trophy', 20],
    ['⛑️', 'Finishes a focus session', 15],
    ['🦀', 'Finishes a task', 10, true],
    ['🙈', 'Plays hide and seek or fetch with you', 10],
    ['🐚', 'Digs you up a gift', 8],
    ['☀️', 'Each day you use him', 5],
    ['♥', 'You pet him', 2],
  ];
  const KIND_ICON = { trick: '🧠', deploy: '🚀', ship: '⬆️', tests: '✅', trophy: '🏆', task: '🦀', day: '☀️', focus: '⛑️', pet: '♥', play: '🙈', find: '🐚', treasure: '🏴‍☠️', bond: '💞' };

  function apply(v) {
    if (!v) return;
    state.xp = v;
    $('brandLevel').hidden = false;
    $('brandLevel').textContent = String(v.level);
    $('brandXp').style.transform = `scaleX(${v.progress.toFixed(3)})`;
    const progress = `Level ${v.level} ${v.title} · ${v.into}/${v.needed} XP to level ${v.level + 1}`;
    $('brandLevel').title = `${progress}. Open Trophies & XP`;
    $('brandLevel').setAttribute('aria-label', `Level ${v.level}: open Trophies and XP`);
    if (state.view === 'trophies') render();
  }

  function render() {
    const v = state.xp;
    if (!v) return;
    $('xpLevel').textContent = v.level;
    $('xpTitle').textContent = v.title;
    $('xpTotal').textContent = `${v.xp.toLocaleString()} XP`;
    $('xpBar').style.transform = `scaleX(${v.progress.toFixed(3)})`;
    $('xpBarWrap').setAttribute('aria-valuenow', Math.round(v.progress * 100));
    $('xpNext').textContent = `${(v.needed - v.into).toLocaleString()} XP to level ${v.level + 1}`;
    const ways = WAYS.filter(w => !(w[3] && state.settings.crabOnly));
    $('xpWays').replaceChildren(...ways.map(([icon, text, xp]) => h('li', {}, h('span', { text: icon }), h('span', { text }), h('b', { text: `+${xp}` }))));
    $('xpLog').replaceChildren(...(v.log.length ? v.log.slice(0, 8).map(e => h('li', {},
      h('span', { class: 'xp-log-icon', text: KIND_ICON[e.kind] || '✦' }),
      h('span', { class: 'xp-log-label', text: e.project ? `${e.label} · ${e.project}` : e.label }),
      h('b', { text: `+${e.xp}` }),
      h('time', { text: SB.relTime(e.at) }))) : [h('li', { class: 'xp-empty', text: state.settings.crabOnly ? 'No XP yet. Give him a pet!' : 'No XP yet. Give Shellby a task, or a pet!' })]));
  }

  api.onXp(apply);
  api.onLevelUp(e => SB.celebrate({
    eyebrow: 'Level up', icon: e.shell ? '🐚' : '⭐', title: `Level ${e.level} · ${e.title}`,
    text: e.shell ? `He outgrew his shell and moved into a ${e.shell.name}. Swap homes any time in Outfits → Homes.` : e.text,
    rewards: e.shell ? [e.shell] : [],
  }));
  const renderTrophies = SB.views.trophies.render;
  SB.views.trophies.render = () => { renderTrophies(); render(); };
  api.getXp().then(apply);
})();
