/* Shellby panel — Claude Code's own slash commands that print mode can't run.
   main's cli-commands.js says how each is handled and sends the list with the
   toolbox (state.toolbox.builtins). 'cli' ones go to Claude Code as they are;
   'shellby' ones open what Shellby has for them (ACTIONS below); 'terminal'
   ones say why and offer to carry the conversation on in a terminal.
   composer.js's SB.runLocal asks here after Shellby's own commands. */
'use strict';
(function () {
  const { api, state, $ } = SB;

  const CLAUDE_ISSUES = 'https://github.com/anthropics/claude-code/issues';

  // A setting, in view; or the Settings tab it lives on when it's not showing.
  const setting = (id, tab) => () => {
    if ($(id)?.closest('.setting-group')) return SB.showSetting(id);
    SB.setView('settings');
    if (tab) SB.showSettingsTab?.(tab);
  };

  const usage = () => {
    const meters = $('usage');
    if (meters && !meters.hidden) return meters.click();
    SB.toast('Your plan usage shows here once Claude Code has reported it, after your first message.', { ms: 5000 });
  };

  const ACTIONS = {
    agents: () => SB.showToolbox?.('agent'),
    bug: () => api.openExternal(CLAUDE_ISSUES),
    feedback: () => api.openExternal(CLAUDE_ISSUES),
    config: () => SB.setView('settings'),
    diff: tab => SB.showChanges?.(tab),
    doctor: () => SB.setView('health'),
    help: () => SB.showToolbox?.('command'),
    hooks: () => SB.showToolbox?.('hook'),
    install: setting('claudeUpdateCheck', 'general'),
    restart: setting('claudeUpdateCheck', 'general'),
    keybindings: () => SB.openShortcuts?.(),
    login: async () => { if (await api.claudeLogin()) SB.toast('Finish signing in in the window that opened. Shellby notices when you’re done.', { ms: 6000 }); },
    logout: setting('claudeSignOut', 'claude'),
    memory: () => SB.showToolbox?.('memory'),
    plan: () => SB.chooseMode?.('plan'),
    plugin: () => SB.openShop?.(),
    resume: () => SB.setView('history'),
    skills: () => SB.showToolbox?.('skill'),
    status: setting('claudeModeBtn', 'claude'),
    usage,
  };

  // The entry for a name or alias, from what main sent. Your own command or
  // skill of the same name isn't in the list, so it goes to Claude as yours.
  function entryOf(name) {
    const tb = state.toolbox || {};
    const list = tb.builtins || [];
    const hit = list.find(c => c.name === name) || list.find(c => (c.aliases || []).includes(name));
    if (hit) return hit;
    const mine = [...(tb.commands || []), ...(tb.skills || [])].some(t => t.name === name);
    return !mine && ACTIONS[name] ? { name, handling: 'shellby' } : null;
  }

  function offerTerminal(tab, c) {
    const msg = `/${c.name} only works in Claude Code's own terminal. ${c.reason || ''}`.trim();
    if (!tab?.saved) return SB.toast(msg, { ms: 6000 });
    SB.toast(msg, { ms: 8000, action: 'Open in a terminal', onAction: () => SB.continueInTerminal(tab.id) });
  }

  /** text: what was sent. true = handled here, false = send it to Claude Code. */
  SB.runBuiltin = (text, tab) => {
    const m = /^\/([\w:.-]+)(?:\s|$)/.exec(text);
    const c = m && entryOf(m[1].toLowerCase());
    if (!c || c.handling === 'cli' || (c.handling === 'shellby' && !ACTIONS[c.name])) return false;
    SB.notePrompt?.(text);
    if (c.handling === 'terminal') offerTerminal(tab, c);
    else ACTIONS[c.name]?.(tab);
    return true;
  };
})();
