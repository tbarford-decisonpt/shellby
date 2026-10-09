/* Shellby panel — the slash menu: skills, commands and snippets as you type
   "/" in the box (tab-send.js asks it). The ranking is tab-logic.js's. */
'use strict';
(function () {
  const { h, state, $ } = SB;
  const L = window.ShellbyTabLogic;
  const input = $('input');
  const autosize = () => SB.autosize();

  // ------------------------------------------------------------ slash menu (skills + commands)

  let slashItems = [];
  let slashIndex = 0;

  function slashCandidates(q) {
    const tb = state.toolbox || { skills: [], commands: [] };
    return L.slashCandidates(q, {
      local: SB.LOCAL_COMMANDS || [], snippets: state.snippets || [],
      skills: tb.skills, commands: tb.commands, builtins: tb.builtins || [], pinned: state.pinned || [],
    });
  }

  function updateSlash() {
    const m = input.value.match(/^\/([\w:.-]*)$/);
    if (!m) return SB.hideSlash();
    slashItems = slashCandidates(m[1].toLowerCase());
    slashIndex = 0;
    renderSlash();
  }

  function renderSlash() {
    const menu = $('slashMenu');
    if (!slashItems.length) return SB.hideSlash();
    menu.hidden = false;
    SB.fitMenu(menu);
    menu.replaceChildren(...slashItems.map((t, i) => h('button', {
      type: 'button', role: 'option', class: `slash-item${i === slashIndex ? ' on' : ''}`, 'aria-selected': String(i === slashIndex),
      onmousedown: e => { e.preventDefault(); pickSlash(i); },
    }, h('span', { class: 'slash-name' }, '/', t.name, t.hint ? h('span', { class: 'slash-hint', text: ` <${t.hint}>` }) : null), h('span', { class: `kind-pill k-${t.pill ? 'cc' : t.kind}`, text: t.pill || t.kind }), h('span', { class: 'slash-desc', text: t.description || '' }))));
  }

  function pickSlash(i) {
    const t = slashItems[i];
    if (!t) return;
    input.value = `/${t.name} `;
    SB.hideSlash();
    autosize();
    input.focus();
  }

  function slashKeydown(e) {
    if ($('slashMenu').hidden) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      slashIndex = (slashIndex + (e.key === 'ArrowDown' ? 1 : -1) + slashItems.length) % slashItems.length;
      renderSlash();
      return true;
    }
    // Typed out in full, Enter runs it, like the terminal; otherwise it completes the name.
    if (e.key === 'Enter' && input.value.trim().toLowerCase() === `/${slashItems[slashIndex]?.name}`.toLowerCase()) { SB.hideSlash(); return false; }
    // Nor does Enter swap what you typed for a name that only matched on its
    // description: /compact is Claude Code's own, not /handoff that mentions it.
    if (e.key === 'Enter' && !slashItems[slashIndex]?.name.toLowerCase().includes(input.value.trim().slice(1).toLowerCase())) { SB.hideSlash(); return false; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickSlash(slashIndex); return true; }
    return false;
  }

  SB.hideSlash = () => { $('slashMenu').hidden = true; };

  // The slash and pick menus open upward out of the box, which may sit in a
  // short pane at the top of the chat (tab-panes.js): no taller than the room
  // above it, so the top isn't cut off by the view's edge. It scrolls.
  SB.fitMenu = (menu) => {
    const room = $('composer').getBoundingClientRect().top - $('chatView').getBoundingClientRect().top;
    menu.style.setProperty('--room', `${Math.max(40, Math.round(room))}px`);
  };
  SB.updateSlash = updateSlash;
  SB.slashKeydown = slashKeydown;
})();
