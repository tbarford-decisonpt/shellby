/* Shellby panel — Projects: adding one repository, scanning a folder for
   them, and cloning one from GitHub. projects.js draws the rest. */
'use strict';
(function () {
  const { h, api, $ } = SB;
  const L = window.ShellbyProjectsLogic;
  const P = SB.pj;
  const { load, showScreen } = P;

  let scan = null;            // { candidates, picked: Set }
  let cloneRepo = null;
  let cloning = false;

  // ------------------------------------------------------------------ adding: one repo, or a scan

  $('pjAdd').addEventListener('click', async () => {
    const r = await api.addProject();
    if (r?.cancelled) return;
    if (!r?.ok) return SB.toast(r?.error || "Couldn't add that folder.");
    SB.toast(`Added ${r.name}`);
    load({ refresh: true });
  });

  $('pjScan').addEventListener('click', async () => {
    showScreen('scan');
    $('pjScanLede').textContent = 'Choose a folder to look through…';
    $('pjScanList').replaceChildren();
    $('pjScanAdd').disabled = true;
    scan = null;
    const r = await api.scanForProjects();
    if (!r?.ok) { if (!r?.cancelled) SB.toast(r?.error || "Couldn't look through that folder."); return showScreen('list'); }
    scan = { ...r, picked: new Set() };
    renderScan();
  });

  function renderScan() {
    const { candidates, parent, truncated, picked } = scan;
    $('pjScanLede').textContent = L.scanLede({ candidates, parent, truncated }, SB.shortPath);
    $('pjScanList').replaceChildren(...candidates.map(c => {
      const box = h('input', { type: 'checkbox', disabled: c.listed });
      box.checked = c.listed || picked.has(c.root);
      box.addEventListener('change', () => { if (box.checked) picked.add(c.root); else picked.delete(c.root); updateScanButtons(); });
      return h('li', {}, h('label', { class: 'pj-check' }, box,
        h('span', {}, h('b', { text: c.name }), c.remote && h('span', { class: 'muted small', text: ` ${c.remote}` }), c.listed && h('span', { class: 'pj-tag', text: 'already listed' }),
          h('span', { class: 'pj-check-path', text: SB.shortPath(c.root, 50) }))));
    }));
    updateScanButtons();
  }

  function updateScanButtons() {
    const n = scan?.picked.size || 0;
    $('pjScanAdd').disabled = !n;
    $('pjScanAdd').textContent = n ? `Add ${n} selected` : 'Add selected';
  }

  $('pjScanAll').addEventListener('click', () => {
    if (!scan) return;
    for (const c of scan.candidates) if (!c.listed) scan.picked.add(c.root);
    renderScan();
  });
  $('pjScanAdd').addEventListener('click', async () => {
    const r = await api.addProjects([...scan.picked]);
    SB.toast(L.addedLine(r?.added));
    scan = null;
    showScreen('list');
    load({ refresh: true });
  });
  $('pjScanCancel').addEventListener('click', () => { api.cancelProjectScan(); scan = null; showScreen('list'); });

  // ------------------------------------------------------------------ cloning

  function openClone(repo) {
    cloneRepo = repo;
    showScreen('clone');
    $('pjCloneTitle').textContent = `Clone ${repo}`;
    $('pjCloneWhere').textContent = 'No folder chosen';
    $('pjCloneDest').textContent = '';
    $('pjCloneError').hidden = true;
    $('pjCloneStatus').textContent = '';
    $('pjCloneProgress').hidden = true;
    $('pjCloneGo').disabled = true;
    const again = $('pjCloneAgain');
    const data = P.data();
    again.hidden = !data?.lastCloneParent;
    if (data?.lastCloneParent) again.textContent = `Use ${SB.shortPath(data.lastCloneParent, 30)} again`;
  }

  async function chose(r) {
    if (!r?.ok) return;
    $('pjCloneWhere').textContent = SB.tildify(r.parent);
    const t = await api.cloneTarget(cloneRepo);
    const err = $('pjCloneError');
    err.hidden = !t?.error;
    err.textContent = t?.error || '';
    $('pjCloneDest').textContent = t?.dest ? `It will be cloned to ${t.dest}` : '';
    $('pjCloneGo').disabled = !t?.dest;
  }
  $('pjCloneChoose').addEventListener('click', async () => chose(await api.chooseCloneFolder()));
  $('pjCloneAgain').addEventListener('click', async () => chose(await api.cloneFolderAgain()));

  $('pjCloneGo').addEventListener('click', async () => {
    cloning = true;
    $('pjCloneGo').disabled = true;
    $('pjCloneChoose').disabled = true;
    $('pjCloneAgain').disabled = true;
    $('pjCloneProgress').hidden = false;
    $('pjCloneBar').style.width = '0%';
    $('pjCloneStatus').textContent = 'Cloning…';
    const r = await api.cloneProject(cloneRepo);
    cloning = false;
    $('pjCloneChoose').disabled = false;
    $('pjCloneAgain').disabled = false;
    $('pjCloneProgress').hidden = true;
    if (!r?.ok) {
      $('pjCloneStatus').textContent = '';
      if (r?.cancelled) return showScreen('detail');
      $('pjCloneError').hidden = false;
      $('pjCloneError').textContent = r?.error || 'The clone failed.';
      $('pjCloneGo').disabled = false;
      return;
    }
    SB.toast(`Cloned to ${r.root}`);
    await load({ refresh: true });
    showScreen('detail');
  });
  $('pjCloneCancel').addEventListener('click', () => {
    if (cloning) { api.cancelClone(); return; }
    showScreen(P.openKey() ? 'detail' : 'list');
  });
  api.onCloneProgress(p => {
    if (!cloning || p.repo !== cloneRepo) return;
    $('pjCloneBar').style.width = `${p.percent}%`;
    $('pjCloneStatus').textContent = `${p.phase}: ${p.percent}%`;
  });

  Object.assign(P, { openClone });
})();
