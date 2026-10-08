/* Shellby panel — GitLab: watch your merge requests through the glab CLI,
   and name any self-managed hosts. glab keeps the sign-in; main only ever
   runs `glab api` (src/main/wiring/gitlab.js). The merge requests themselves
   arrive with the CI watcher's view, alongside GitHub's pull requests. */
'use strict';
(function () {
  const { h, api, $ } = SB;
  const CI_LABEL = { failing: 'Failing', pending: 'Running', passing: 'Passing', none: 'No pipeline' };

  let view = null;

  function render(v) {
    if (!v) return;
    view = v;
    $('glMissing').hidden = v.glab?.installed !== false;
    $('glCi').checked = !!v.on;
    if (document.activeElement !== $('glHosts')) $('glHosts').value = (v.hosts || []).join(', ');
    $('glCiRow').hidden = !v.on;
    if (!v.on) return;
    const signedIn = (v.watched || []).filter(w => w.login).map(w => `@${w.login} on ${w.host}`);
    const n = v.prs.length;
    const failing = v.prs.filter(p => p.state === 'failing').length;
    $('glStatus').textContent = v.error || (v.lastPollAt
      ? `${signedIn.length ? `${signedIn.join(', ')}. ` : ''}${n ? `${n} open merge request${n === 1 ? '' : 's'}` : 'No open merge requests'}${failing ? `, ${failing} failing` : ''}. Checked ${SB.relTime(v.lastPollAt)}.`
      : 'Checking your merge requests shortly…');
    $('glStatus').classList.toggle('bad', !!v.error);
    const row = (mr, review) => h('li', { class: `gh-ci-pr ci-${review ? 'review' : mr.state}` },
      h('span', { class: 'gh-ci-dot', title: review ? 'Review requested' : CI_LABEL[mr.state] || '' }),
      h('button', { type: 'button', class: 'gh-ci-link', title: `Open ${mr.ref} on ${mr.host}`, onclick: () => api.openPr(mr.key) },
        h('b', { text: mr.ref }), h('span', { text: mr.title })),
      review ? h('span', { class: 'gh-ci-tag', text: 'Review' })
        : h('span', { class: 'gh-ci-acts' },
          mr.state === 'failing' && h('button', { type: 'button', class: 'btn slim-btn', title: `Failing: ${mr.failing.join(', ')}`, onclick: () => SB.startFrom.open('build', mr.key) }, 'Fix this build'),
          mr.state === 'failing' && h('button', { type: 'button', class: 'btn ghost slim-btn', title: mr.failing.join(', '), onclick: () => askWhy(mr) }, 'Ask Shellby why'),
          mr.reviewComments > 0 && h('button', { type: 'button', class: 'btn ghost slim-btn', onclick: () => SB.startFrom.open('review', mr.key) }, 'Address the review'),
          mr.state !== 'failing' && h('span', { class: 'gh-ci-tag', text: CI_LABEL[mr.state] || '' })));
    $('glList').replaceChildren(...v.prs.map(mr => row(mr, false)), ...v.reviews.map(mr => row(mr, true)));
  }

  async function askWhy(mr) {
    if (SB.isCrabOnly()) return SB.claudeUpsell('ci');
    const r = await api.askAboutCi(mr.key);
    if (!r.ok) SB.toast(r.error || "Couldn't start that task.", { ms: 5000 });
  }

  async function set(patch) {
    const r = await api.setGitLab(patch);
    render(r?.view);
    if (r && !r.ok && r.error) SB.toast(r.error, { ms: 6000 });
    return r;
  }

  $('glCi').addEventListener('change', e => set({ ci: e.target.checked }));
  $('glHostsForm').addEventListener('submit', async e => {
    e.preventDefault();
    const hosts = $('glHosts').value.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    $('glHostsSave').disabled = true;
    const r = await set({ hosts });
    $('glHostsSave').disabled = false;
    if (r?.ok) SB.toast(hosts.length ? 'Saved. Shellby asks those hosts too.' : 'Saved. Only gitlab.com and your clones\' hosts now.');
  });
  $('glCheck').addEventListener('click', async () => {
    $('glCheck').disabled = true;
    render(await api.checkGitLab());
    $('glCheck').disabled = false;
  });
  $('glGet').addEventListener('click', () => api.openExternal('https://gitlab.com/gitlab-org/cli#installation'));
  // Each CI poll brings GitLab's merge requests too: redraw from main's own view of them.
  api.onCi(v => { if (view?.on && v?.gitlab) api.getGitLab().then(render); });

  SB.gitlab = { render, load: () => api.getGitLab().then(render) };
  api.getGitLab().then(render);
})();
