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
    SB.renderClaudeAccount?.(); // no account row in just-the-crab mode
  }

  const LEDES = {
    health: 'With Claude Code, Shellby can find out why and report back, without changing anything.',
    files: 'With Claude Code, drop files on Shellby and he works on them: sorts, renames, summarizes, converts.',
    ci: 'With Claude Code, Shellby reads the failing logs and tells you why the build is red, without changing anything.',
    fix: "With Claude Code, Shellby hands Claude the failing log or the review comments, in a copy of the project on the pull request's branch, and it pushes the fix there.",
    loose: 'With Claude Code, a TODO left in the code becomes a task: the file, the line and the code around it, ready to send.',
    backlog: 'With Claude Code, anything on Next up becomes a conversation in a copy of the project on its own branch: the issue, task or TODO already in the box, ready to send.',
    release: "With Claude Code, Shellby hands Claude the commits since the last release and it writes the CHANGELOG entry in your project's own voice, for you to read before you cut the release.",
    deps: 'With Claude Code, Shellby bumps the packages in a copy of the project, runs the tests and opens a pull request for you to look over.',
    review: "With Claude Code, Shellby can look over the changes you haven't committed or pushed yet and say what looks risky, without changing anything.",
    lhm: 'With Claude Code, Shellby can install LibreHardwareMonitor and switch on its web server for you. Until then, the steps in the Health view do the same by hand.',
    notes: 'With Claude Code, Shellby can plan a note, build it, or tell you whether it is worth doing.',
    helpers: 'With Claude Code, Shellby can find the commit that broke something, check the docs against the code, or show you around a repository, each one ready for you to read before it goes.',
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
    const snacks = state.settings.needsOn !== false ? ' Focus sessions and games earn him snacks.' : '';
    SB.toast(`Just the crab it is! He's on your desktop now; click him any time.${snacks}`, { ms: 6000 });
  };

  $('claudeModeBtn').addEventListener('click', async () => {
    if (SB.isCrabOnly()) return SB.startClaudeSetup();
    const r = await api.setSettings({ crabOnly: true });
    state.settings = r.settings;
    SB.applyCrabOnly();
    SB.toast('Switched to just the crab. Set up Claude Code again from here any time.');
  });
})();
