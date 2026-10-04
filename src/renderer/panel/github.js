/* Shellby panel — GitHub: sign in with a device code, then turn on sync,
   pack publishing and Claude's git access. The token never reaches the panel. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const wanted = new Set(['sync']); // what a sign-in asks for (signed out)

  const ago = t => (t ? SB.relTime(t) : 'not yet');
  const TOGGLES = [['sync', 'ghSync'], ['friends', 'ghFriends'], ['profileCard', 'ghProfileCard'], ['ci', 'ghCi'], ['issues', 'ghIssues'], ['projects', 'ghProjects'], ['publish', 'ghPublish'], ['claude', 'ghClaude'], ['workflows', 'ghWorkflows']];

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
    const claudeOn = signedIn && v.features.claude.on && v.features.claude.granted;
    for (const [f, id] of TOGGLES) {
      const el = $(id);
      // ?. : a view from before a feature existed simply has it off.
      el.checked = signedIn ? !!(v.features[f]?.on && v.features[f]?.granted) : wanted.has(f);
      // Pushing workflow files is only meaningful once tasks can push at all.
      el.disabled = !!v.flow || ((f === 'claude' || f === 'friends' || f === 'profileCard') && !signedIn) || (f === 'workflows' && !claudeOn);
    }
    $('ghClaudeNote').textContent = signedIn
      ? 'Shellby tabs get your GitHub sign-in (git push, gh). Claude Code in your terminal is unchanged.'
      : 'Sign in first. Shellby asks again before turning this on.';
    $('ghWorkflowsNote').textContent = !claudeOn
      ? 'Needs "Let Claude tasks push" first.'
      : v.features.workflows.on && v.features.workflows.granted
        ? 'Pushes that touch .github/workflows will go through. A workflow runs with your repository\'s secrets, so keep an eye on tasks that edit one.'
        : 'Without this, GitHub refuses any push that changes a file in .github/workflows — even a one-line fix.';

    const syncOn = signedIn && v.features.sync.on && v.features.sync.granted;
    $('ghSyncRow').hidden = !syncOn;
    $('ghSyncStatus').textContent = v.syncing ? 'Syncing…' : v.lastSyncError || `Last synced ${ago(v.lastSyncAt)}. Sign in on your other PCs to share trophies, XP, outfit and streak.`;
    $('ghSyncStatus').classList.toggle('bad', !!v.lastSyncError && !v.syncing);
    $('ghSyncNow').disabled = !!v.syncing;

    $('ghCode').hidden = !v.flow;
    if (v.flow) $('ghCodeText').textContent = v.flow.code;
    $('ghNoCrypto').hidden = v.encryption !== false;
    SB.views.wardrobe?.refreshPublish?.();
    SB.friends?.load();
    SB.profileCard?.load();
    api.getCi().then(renderCi);
  }

  // ------------------------------------------------------------ CI on your pull requests
  const CI_LABEL = { failing: 'Failing', pending: 'Running', passing: 'Passing', none: 'No checks' };
  function renderCi(v) {
    if (!v) return;
    $('ghCiRow').hidden = !v.enabled;
    if (!v.enabled) return;
    const n = v.prs.length;
    $('ghCiStatus').textContent = v.error || (v.lastPollAt
      ? `${n ? `${n} open pull request${n === 1 ? '' : 's'}` : 'No open pull requests'}${v.failing ? `, ${v.failing} failing` : ''}. Checked ${SB.relTime(v.lastPollAt)}. Private repos need "Let Claude tasks push" too.`
      : 'Checking your pull requests shortly…');
    $('ghCiStatus').classList.toggle('bad', !!v.error);
    const row = (pr, review) => h('li', { class: `gh-ci-pr ci-${review ? 'review' : pr.state}` },
      h('span', { class: 'gh-ci-dot', title: review ? 'Review requested' : CI_LABEL[pr.state] || '' }),
      h('button', { type: 'button', class: 'gh-ci-link', title: `Open ${pr.repo}#${pr.number} on GitHub`, onclick: () => api.openPr(pr.key) },
        h('b', { text: `${pr.repo}#${pr.number}` }), h('span', { text: pr.title })),
      review ? h('span', { class: 'gh-ci-tag', text: 'Review' })
        : pr.state === 'failing' ? h('button', { type: 'button', class: 'btn ghost slim-btn', title: pr.failing.join(', '), onclick: () => askWhy(pr) }, 'Ask Shellby why')
          : h('span', { class: 'gh-ci-tag', text: CI_LABEL[pr.state] || '' }));
    $('ghCiList').replaceChildren(...v.prs.map(pr => row(pr, false)), ...v.reviews.map(pr => row(pr, true)));
  }
  async function askWhy(pr) {
    if (SB.isCrabOnly()) return SB.claudeUpsell('ci');
    const r = await api.askAboutCi(pr.key);
    if (!r.ok) SB.toast(r.error || "Couldn't start that task.", { ms: 5000 });
  }
  $('ghCiCheck').addEventListener('click', async () => {
    $('ghCiCheck').disabled = true;
    renderCi(await api.pollCi());
    $('ghCiCheck').disabled = false;
  });
  api.onCi(v => renderCi({ ...v, enabled: !!(state.github?.signedIn && state.github.features.ci?.on) }));

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

  for (const [f, id] of TOGGLES) {
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
