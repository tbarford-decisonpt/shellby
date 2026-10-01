/* Shellby panel — "just the crab" mode: Shellby without Claude Code. Health is
   home; the wardrobe, trophies and crab card all work; anything that needs
   Claude shows what it would add and how to set it up. */
'use strict';
(function () {
  const { api, state, $ } = SB;

  SB.isCrabOnly = () => !!state.settings.crabOnly;

  SB.applyCrabOnly = () => {
    const on = SB.isCrabOnly();
    document.body.classList.toggle('crab-only', on);
    $('hlClaude').hidden = !on;
    renderSettingsSection();
  };

  function renderSettingsSection() {
    const on = SB.isCrabOnly();
    $('claudeModeText').textContent = on
      ? "Shellby is in just-the-crab mode: Health, the Wardrobe and trophies, no Claude needed. Set up Claude Code to give him tasks too."
      : 'Shellby does tasks for you with Claude Code. You can switch to just the crab (Health, Wardrobe and trophies) any time; your conversations stay saved.';
    $('claudeModeBtn').textContent = on ? 'Set up Claude Code' : 'Switch to just the crab';
    $('claudeModeBtn').className = on ? 'btn primary' : 'btn';
  }

  const LEDES = {
    health: 'With Claude Code, Shellby can find out why and report back, without changing anything.',
    files: 'With Claude Code, drop files on Shellby and he works on them: sorts, renames, summarizes, converts.',
  };

  SB.claudeUpsell = (reason = 'health') => {
    $('upsellLede').textContent = LEDES[reason] || LEDES.health;
    $('upsellSheet').hidden = false;
    $('upsellLater').focus();
  };
  const closeUpsell = () => { $('upsellSheet').hidden = true; };
  $('upsellClose').addEventListener('click', closeUpsell);
  $('upsellLater').addEventListener('click', closeUpsell);
  $('upsellSheet').addEventListener('click', e => { if (e.target === $('upsellSheet')) closeUpsell(); });
  $('upsellSheet').addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); closeUpsell(); } });

  SB.startClaudeSetup = () => {
    closeUpsell();
    SB.onboardPath = 'claude';
    SB.setView('onboarding');
  };
  document.querySelectorAll('[data-claude-setup]').forEach(b => b.addEventListener('click', SB.startClaudeSetup));

  SB.chooseCrabOnly = async () => {
    const r = await api.setSettings({ crabOnly: true, onboarded: true });
    state.settings = r.settings;
    SB.onboardPath = null;
    SB.applyCrabOnly();
    SB.setView('health');
    SB.toast("Just the crab it is! He's on your desktop now; click him any time.", { ms: 5000 });
  };

  $('claudeModeBtn').addEventListener('click', async () => {
    if (SB.isCrabOnly()) return SB.startClaudeSetup();
    const r = await api.setSettings({ crabOnly: true });
    state.settings = r.settings;
    SB.applyCrabOnly();
    SB.toast('Switched to just the crab. Set up Claude Code again from here any time.');
  });
})();
