/* Shellby panel — GitHub: sign in with a device code, then turn on sync,
   pack publishing and Claude's git access. The token never reaches the panel. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const wanted = new Set(['sync']); // what a sign-in asks for (signed out)

  const ago = t => (t ? SB.relTime(t) : 'not yet');

  function render(v) {
    if (!v) return;
    state.github = v;
    const signedIn = v.signedIn;
    $('ghAccount').hidden = !signedIn;
    $('ghLede').hidden = signedIn;
    $('ghSignIn').hidden = signedIn || !!v.flow;
    if (signedIn) {
      $('ghAvatar').hidden = !v.avatar;
      if (v.avatar) $('ghAvatar').src = v.avatar; // a data: URL made in main
      $('ghName').textContent = v.name || v.login || 'GitHub';
      $('ghLogin').textContent = v.login ? `@${v.login}` : '';
    }

    // Toggles: signed in → the real state; signed out → what to ask for.
    for (const [f, id] of [['sync', 'ghSync'], ['publish', 'ghPublish'], ['claude', 'ghClaude']]) {
      const el = $(id);
      el.checked = signedIn ? v.features[f].on && v.features[f].granted : wanted.has(f);
      el.disabled = !!v.flow || (f === 'claude' && !signedIn);
    }
    $('ghClaudeNote').textContent = signedIn
      ? 'Shellby tabs get your GitHub sign-in (git push, gh). Claude Code in your terminal is unchanged.'
      : 'Sign in first. Shellby asks again before turning this on.';

    const syncOn = signedIn && v.features.sync.on && v.features.sync.granted;
    $('ghSyncRow').hidden = !syncOn;
    $('ghSyncStatus').textContent = v.syncing ? 'Syncing…' : v.lastSyncError || `Last synced ${ago(v.lastSyncAt)}. Sign in on your other PCs to share trophies, XP, outfit and streak.`;
    $('ghSyncStatus').classList.toggle('bad', !!v.lastSyncError && !v.syncing);
    $('ghSyncNow').disabled = !!v.syncing;

    $('ghCode').hidden = !v.flow;
    if (v.flow) $('ghCodeText').textContent = v.flow.code;
    $('ghNoCrypto').hidden = v.encryption !== false;
    SB.views.wardrobe?.refreshPublish?.();
  }

  $('ghSignIn').addEventListener('click', async () => {
    $('ghSignIn').disabled = true;
    const r = await api.githubSignIn([...wanted]);
    $('ghSignIn').disabled = false;
    render(r.view);
    if (!r.ok) SB.toast(r.error || "Couldn't start GitHub sign-in.", { ms: 6000 });
    else SB.toast('Code copied. Paste it on the GitHub page that just opened.', { ms: 5000 });
  });
  $('ghOpenCode').addEventListener('click', () => { api.githubOpenCode(); SB.toast('Code copied. Paste it on GitHub.'); });
  $('ghCancel').addEventListener('click', () => api.githubCancel());
  $('ghSignOut').addEventListener('click', async () => {
    render(await api.githubSignOut());
    SB.toast('Signed out. To revoke Shellby on GitHub too, use Manage on github.com.', { action: 'Manage', onAction: () => api.githubManage(), ms: 5000 });
  });
  $('ghSyncNow').addEventListener('click', async () => {
    const r = await api.githubSync();
    render(r.view);
    SB.toast(r.ok ? (r.pulled ? 'Synced: picked up progress from your other PCs.' : 'Synced.') : r.error, { ms: r.ok ? 2800 : 6000 });
  });

  for (const [f, id] of [['sync', 'ghSync'], ['publish', 'ghPublish'], ['claude', 'ghClaude']]) {
    $(id).addEventListener('change', async e => {
      const on = e.target.checked;
      if (!state.github?.signedIn) { on ? wanted.add(f) : wanted.delete(f); return; }
      const r = await api.githubSetFeature(f, on);
      render(r.view);
      if (r.needsApproval && r.ok) SB.toast('GitHub needs your OK for that. Code copied: approve it on the page that opened.', { ms: 6000 });
      else if (r.ok === false && r.error) SB.toast(r.error, { ms: 6000 });
    });
  }
  // Widening a sign-in opens the device page the same way.
  api.onGitHub(v => {
    const hadFlow = !!state.github?.flow;
    render(v);
    if (v.flow && !hadFlow) api.githubOpenCode();
  });
  api.onGitHubSignedIn(v => { render(v); SB.toast(`Signed in to GitHub as @${v.login || '?'}.`); });
  api.onGitHubError(message => SB.toast(message, { ms: 6000 }));

  SB.github = { render, load: () => api.getGitHub().then(render) };
  api.getGitHub().then(render);
})();
