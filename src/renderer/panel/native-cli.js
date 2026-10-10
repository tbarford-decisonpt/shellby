/* Shellby panel — by the box, for the conversation on screen: the goal Claude
   checks before it stops (/goal, pinned until it's met or cleared), and what
   Claude Code guesses you'll ask next (its prompt suggestions), which Tab or a
   click puts in the box, unsent. Shellby makes neither: both are Claude Code's. */
'use strict';
(function () {
  const { h, $ } = SB;
  const input = $('input');

  function renderGoal(tab) {
    const box = $('goalPin');
    const goal = tab && SB.activeTab() === tab ? tab.goal : null;
    box.hidden = !goal;
    if (!goal) { box.replaceChildren(); return; }
    box.replaceChildren(
      h('span', { class: 'goal-icon', 'aria-hidden': 'true', text: '🎯' }),
      h('span', { class: 'goal-text', title: goal }, h('b', { text: 'Goal ' }), goal),
      h('button', { class: 'icon-btn goal-clear', type: 'button', title: 'Clear the goal (/goal clear)', 'aria-label': 'Clear the goal',
        disabled: !!tab.busy, onclick: () => clearGoal(tab) }, '×'));
  }

  async function clearGoal(tab) {
    if (tab.busy) return SB.toast('Claude is working. Clear the goal once this turn ends.');
    await SB.sendNow(tab, '/goal clear', []); // it says itself if it couldn't
  }

  function renderNextPrompt(tab) {
    const box = $('nextPrompt');
    const text = tab && SB.activeTab() === tab && !tab.busy ? tab.nextPrompt : null;
    box.hidden = !text;
    if (!text) { box.replaceChildren(); return; }
    box.replaceChildren(h('button', { class: 'suggestion next-chip', type: 'button', title: 'Put it in the box (Tab). Nothing is sent until you press Enter.', onclick: () => take(tab) },
      h('span', { class: 'glyph', text: '›' }), text, h('kbd', { class: 'next-key', text: 'Tab' })));
  }

  function take(tab) {
    if (!tab?.nextPrompt || tab.busy) return false;
    input.value = tab.nextPrompt;
    tab.nextPrompt = null;
    renderNextPrompt(tab);
    SB.autosize?.();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    return true;
  }

  SB.renderGoal = renderGoal;
  SB.renderNextPrompt = renderNextPrompt;
  SB.takeNextPrompt = () => take(SB.activeTab());
})();
