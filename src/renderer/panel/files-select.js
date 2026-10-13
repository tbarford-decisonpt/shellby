/* Shellby panel — the file picked in All files (files-dock.js), sent along with the messages you type:
   a chip above the box with its name and an ×, and one line main adds to the prompt once it has
   checked the file is in the conversation's folder (ipc/tabs.js task:send). The pick belongs to
   the conversation and stays after a send, until cleared or another is picked. Also @path in
   the box, which finds its row in the tree without picking it. */
'use strict';
(function () {
  const { h, $, state } = SB;
  const F = window.ShellbyFiles;
  const chip = $('pickChip');
  const input = $('input');

  /** A conversation's pick: { rel } (its path in the tree, as the tree spells it), or null. */
  SB.treePick = tab => tab?.treePick || null;

  /** Pick a file, or none. */
  SB.setTreePick = (tab, pick) => {
    if (!tab) return;
    tab.treePick = typeof pick?.rel === 'string' && pick.rel ? { rel: pick.rel } : null;
    if (tab.id === state.activeTab) renderPickChip();
    SB.filesRedraw?.();
  };

  /**
   * What task:send carries for it, taken when you press Enter (tab-send.js): its path in the tree, which main resolves in the
   * conversation's folder (so a conversation moved into its own worktree keeps it), or nothing.
   */
  SB.treePickOpts = tab => {
    const p = tab?.treePick;
    return p ? { selected: p.rel } : undefined;
  };

  function renderPickChip() {
    const p = SB.activeTab()?.treePick || null;
    chip.hidden = !p;
    if (!p) { chip.replaceChildren(); return; }
    const name = p.rel.slice(p.rel.lastIndexOf('/') + 1);
    chip.replaceChildren(h('span', { class: 'att pick', title: `Goes with your message: Claude is told you have ${p.rel} selected. Nothing is read from it.` },
      h('span', { class: 'pick-label', text: 'Picked' }),
      h('span', { text: name }),
      h('button', { type: 'button', 'aria-label': `Stop sending ${name} along`, onclick: () => SB.setTreePick(SB.activeTab(), null) }, '×')));
  }
  SB.renderPickChip = renderPickChip;

  // @path in the box: its row in All files comes into view and takes the keyboard.
  input.addEventListener('input', () => {
    const p = F.mentionAt(input.value, input.selectionStart ?? input.value.length);
    if (p) SB.filesReveal?.(p);
  });
})();
