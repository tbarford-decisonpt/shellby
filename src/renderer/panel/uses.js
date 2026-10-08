/* Shellby panel — what you use. Each screen you go to is counted in main
   (feature-use.js), on this PC only. Settings → General → What you use reads it
   back: the screens you live in, then the ones you've never opened or haven't
   for a month, each with a line on what it's for and Take a look. A screen
   that isn't on your bar yet (rooms.js) or that your mode hides isn't
   suggested. */
'use strict';
(function () {
  const { api, state, $, h } = SB;
  const TOP = 5;

  // Count each arrival, not each re-render of the same screen.
  const setView = SB.setView;
  SB.setView = target => {
    const was = state.view;
    setView(target);
    if (state.view !== was && !SB.solo) api.featureUsed(state.view);
  };

  // A screen's way in: its button on the bar, its tab on his screen, or the
  // bar button of the screen it lives under. Shown means you could get there.
  function doorShown(x) {
    const door = document.querySelector(`.dock [data-view-btn="${x.id}"]`)
      || document.querySelector(`#wardrobeView .shellby-tabs [data-goto="${x.id}"]`)
      || (x.in && document.querySelector(`.dock [data-view-btn="${x.in}"]`));
    return !!door && !door.hidden && getComputedStyle(door).display !== 'none';
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function row(x, note) {
    return h('div', { class: 'uses-row' },
      h('div', { class: 'uses-what' }, h('b', { text: x.name }), h('span', { class: 'small muted', text: note ? `${x.text} ${note}` : x.text })),
      h('button', { type: 'button', class: 'btn ghost slim-btn', text: 'Take a look', 'aria-label': `Take a look at ${x.name}`, onclick: () => SB.setView(x.id) }));
  }

  function list(el, title, items, note) {
    el.replaceChildren();
    el.hidden = !items.length;
    if (!items.length) return;
    el.append(h('p', { class: 'uses-head', text: title }), ...items.map(x => row(x, note?.(x))));
  }

  async function render() {
    const r = await api.featureReport().catch(() => null);
    if (!r) return;
    const top = r.used.slice(0, TOP);
    $('usesTop').hidden = !top.length;
    $('usesTop').textContent = top.length ? `Most: ${top.map(x => `${x.name} ${x.n}`).join(' · ')}` : '';
    $('usesLede').textContent = r.since
      ? `Which screens you open, counted on this PC since ${new Date(r.since).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })} and never sent anywhere.`
      : 'Which screens you open, counted on this PC and never sent anywhere.';
    list($('usesNever'), 'Not opened yet', r.never.filter(doorShown));
    list($('usesQuiet'), 'Not for a month', r.quiet.filter(doorShown), x => `(${plural(x.n, 'visit')}, last ${SB.relTime(x.last)})`);
  }

  SB.onSettingsOpen(render);
})();
