/* Shellby panel — streaks and nudges: the streak card on Time, the streak
   badge on Trophies, and nudges shown in the panel when it's open. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;

  // The words (quiet, late, the card and badge) live in shared/streaks-format.js.
  const W = window.ShellbyStreaksFormat;

  // A read-only look over what's pending in one project. Deliberately never a
  // verdict, and never a fix: see src/main/review.js for why.
  async function review(key) {
    const r = await api.reviewProject(key);
    if (r?.needsClaude) return SB.claudeUpsell('review');
    if (!r?.ok) return SB.toast(r?.error || "Couldn't start that.");
    SB.toast('Shellby is looking over your changes');
  }

  // Trophies keeps just the count, as a badge in the XP card that links here.
  function renderBadge(v) {
    const badge = $('xpStreak');
    const words = W.badge(v);
    badge.hidden = words.hidden;
    badge.textContent = words.text;
    badge.title = words.title;
    badge.setAttribute('aria-label', words.label);
  }

  function render(v) {
    if (!v) return;
    state.streaks = v;
    if (state.view === 'trophies') renderBadge(v);
    if (state.view !== 'time') return;
    const words = W.card(v);
    $('streakCard').classList.toggle('cold', !words.on);
    $('streakTitle').textContent = words.title;
    $('streakBest').textContent = words.best;
    $('streakSub').textContent = words.sub;
    $('nudgeToggle').checked = !!v.nudges;
    const days = $('nudgeDays');
    if (![...days.options].some(o => o.value === String(v.afterDays))) days.append(h('option', { value: String(v.afterDays), text: `${v.afterDays} days` }));
    days.value = String(v.afterDays);
    $('streakProjects').replaceChildren(...(v.projects.length ? v.projects.slice(0, 8).map(p => {
      const late = W.isLate(p, v.afterDays);
      return h('li', { class: `streak-project${late ? ' late' : ''}${p.muted ? ' muted' : ''}` },
        h('button', { class: 'sp-name', type: 'button', title: 'Open a new conversation in this project', onclick: () => api.openProject(p.key) }, p.name),
        h('span', { class: 'sp-quiet', text: W.quiet(p) }),
        h('button', { class: 'sp-review icon-btn', type: 'button', title: 'Have Shellby look over the changes here for security problems. He reads and reports back, and changes nothing',
          'aria-label': `Look over the changes in ${p.name}`, onclick: () => review(p.key) }, SB.icon(SB.ICONS.shield)),
        h('button', { class: 'sp-mute icon-btn', type: 'button', title: p.muted ? 'Nudges are off for this project. Click to turn them back on' : 'Stop nudging me about this project',
          'aria-label': p.muted ? `Unmute ${p.name}` : `Mute ${p.name}`, onclick: async () => render(await api.muteProject(p.key, !p.muted)) }, p.muted ? '🔕' : '🔔'));
    }) : [h('li', { class: 'xp-empty', text: 'Projects show up here once Shellby sees you working in a git repo.' })]));
  }

  $('xpStreak').addEventListener('click', () => SB.setView('time'));
  $('nudgeToggle').addEventListener('change', async e => render(await api.setStreaks({ nudges: e.target.checked })));
  $('nudgeDays').addEventListener('change', async e => render(await api.setStreaks({ afterDays: Number(e.target.value) })));
  api.onStreaks(render);
  api.onNudge(n => SB.toast(n.text, { action: 'Pick it up', ms: 9000, onAction: () => api.openProject(n.key) }));

  const renderTrophies = SB.views.trophies.render;
  SB.views.trophies.render = () => { renderTrophies(); api.getStreaks().then(render); };
  const renderTime = SB.views.time.render;
  SB.views.time.render = () => { renderTime(); api.getStreaks().then(render); };
})();
