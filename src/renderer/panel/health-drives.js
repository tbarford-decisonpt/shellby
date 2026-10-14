/* Shellby panel — Health: the machine itself. Fans, drives, developer
   clutter, and where each sensor reading comes from. health.js holds the
   snapshot from main. */
'use strict';
(function () {
  const { h, api, $ } = SB;
  const L = window.ShellbyHealthLogic;
  const H = SB.health;
  const { levelOf, setText, smooth, changed, ask } = H;
  const { gb } = L;

  let sensorsOpened = false;         // the Sensors fold opens itself once, when setup is needed
  let lhmUpdate = null;              // main's lhmUpdate(): LHM's installed and latest versions

  // ------------------------------------------------------------ fans

  function renderFans() {
    const fans = H.view()?.sample?.fans || [];
    $('hlFansBlock').hidden = !fans.length;
    if (!changed('fans', JSON.stringify(fans))) return;
    $('hlFans').replaceChildren(...fans.map(f => h('li', { class: `hl-fan${f.rpm ? '' : ' stopped'}` },
      h('span', { class: 'hl-fan-name', text: f.name }),
      h('b', { text: f.rpm ? `${f.rpm.toLocaleString()} rpm` : 'stopped' }))));
  }

  // ------------------------------------------------------------ drives

  function renderDisks() {
    const view = H.view();
    const disks = view?.sample?.disks || [];
    if (!disks.length) {
      if (changed('disks', view?.sample ? 'none' : 'reading')) {
        $('hlDisks').replaceChildren(h('li', { class: 'hl-empty', text: view?.sample ? 'No local drives found.' : 'Reading drives…' }));
      }
      return;
    }
    if (!changed('disks', JSON.stringify(disks.map(d => [d.id, d.label, d.free, d.total, levelOf(`disk:${d.id}`)])))) return;
    $('hlDisks').replaceChildren(...disks.map(d => {
      const id = `disk:${d.id}`;
      const level = levelOf(id);
      const used = d.total ? 1 - d.free / d.total : 0;
      return h('li', { class: `hl-disk lvl-${level}`, dataset: { id } },
        h('div', { class: 'hl-disk-top' },
          h('b', { text: d.id }), h('span', { class: 'hl-disk-label', text: d.label || 'Local disk' }),
          h('span', { class: 'hl-disk-free' }, h('b', { text: gb(d.free) }), ` free of ${gb(d.total)}`)),
        h('div', { class: 'hl-bar', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(used * 100), 'aria-label': `${d.id} ${Math.round(used * 100)}% full` },
          h('span', { style: `transform: scaleX(${used.toFixed(4)})` })),
        level !== 'ok' ? h('button', { class: 'hl-mini', type: 'button', onclick: () => ask(id) }, 'Ask Shellby what to clean up') : null);
    }));
  }

  // ------------------------------------------------------------ developer clutter

  function renderSpace() {
    const view = H.view();
    const sp = view?.space;
    const on = !!(view?.settings?.enabled && view?.settings?.space && sp);
    $('hlSpace').hidden = !on;
    if (!on) return;
    const level = levelOf('reclaim');
    $('hlSpace').dataset.level = level;
    $('hlAskSpace').disabled = !view.checks?.reclaim;
    if (!changed('space', `${sp.at}|${level}`)) return;
    const rows = L.spaceRows(sp, SB.shortPath);
    const max = Math.max(1, ...rows.map(r => r.size));
    $('hlSpaceTotal').textContent = sp.reclaimable > 0 ? `${gb(sp.reclaimable)} could come back` : 'Nothing to reclaim';
    $('hlSpaceList').replaceChildren(...(rows.length ? rows.map(r => h('li', { class: `hl-space-row${r.image ? ' image' : ''}`, title: r.title },
      h('div', { class: 'hl-hog-top' },
        h('b', { class: 'hl-hog-name', text: r.name }),
        h('span', { class: 'hl-hog-rest', text: r.detail }),
        h('span', { class: 'hl-hog-val', text: `${r.partial ? '≥ ' : ''}${gb(r.size)}` })),
      h('div', { class: 'hl-hog-bar', 'aria-hidden': 'true' }, h('span', { style: `transform: scaleX(${(r.size / max).toFixed(4)})` }))))
      : [h('li', { class: 'hl-empty', text: 'No Docker, WSL or package caches worth mentioning.' })]));
    $('hlSpaceFine').textContent = [
      sp.vmMemory ? `WSL's virtual machine is holding ${gb(sp.vmMemory)} of memory.` : null,
      `Measured ${SB.relTime(sp.at)}. Shellby only reads these; nothing is pruned or deleted.`,
    ].filter(Boolean).join(' ');
  }

  // ------------------------------------------------------------ sensors

  function renderSources() {
    const view = H.view();
    const src = view?.sources || {};
    const row = (ok, title, detail) => h('li', { class: `hl-src ${ok === true ? 'ok' : ok === false ? 'off' : 'na'}` },
      h('span', { class: 'hl-src-dot', 'aria-hidden': 'true' }), h('div', {}, h('b', { text: title }), h('span', { text: detail })));
    const { rows, needsSetup, summary } = L.sources(view);
    if (changed('sources', JSON.stringify(rows))) $('hlSources').replaceChildren(...rows.map(r => row(...r)));
    $('hlSetup').hidden = !needsSetup;
    $('hlAuth').hidden = src.lhm !== 'auth';
    const lhmSum = L.lhmVersion(lhmUpdate, SB.relTime)?.summary;
    setText($('hlSensorsSum'), [summary, lhmSum].filter(Boolean).join(' · '));
    // Open the fold the first time setup is needed; after that it's the user's.
    if (needsSetup && !sensorsOpened) { sensorsOpened = true; $('hlSensorsFold').open = true; }
    if (document.activeElement !== $('hlPort')) $('hlPort').value = view?.settings?.lhmPort || 8085;
  }

  function openSensors() {
    $('hlSensorsFold').open = true;
    $('hlSetup').scrollIntoView({ behavior: smooth(), block: 'center' });
  }

  // ------------------------------------------------------------ LHM's version

  // Main reads the installed exe and asks GitHub at most once a day, so this
  // runs each time the view opens; the button asks GitHub now.
  async function loadLhm(force = false) {
    const btn = $('hlLhmCheck');
    if (force) { btn.disabled = true; setText(btn, 'Checking…'); }
    try {
      lhmUpdate = await api.getLhmUpdate(force);
    } catch {
      lhmUpdate = null;
    } finally {
      btn.disabled = false;
      setText(btn, 'Check for updates');
    }
    renderLhm();
    renderSources();
    return lhmUpdate;
  }

  function renderLhm() {
    const words = L.lhmVersion(lhmUpdate, SB.relTime);
    $('hlLhmVer').hidden = !words;
    if (!words) return;
    setText($('hlLhmVerText'), words.text);
    $('hlLhmUpdate').hidden = !words.update;
  }

  $('hlLhmCheck').addEventListener('click', async () => {
    const u = await loadLhm(true);
    if (!u) return SB.toast("Couldn't check for a newer LibreHardwareMonitor");
    if (!u.installed) return SB.toast("Shellby couldn't find LibreHardwareMonitor on this PC");
    if (u.error) return SB.toast("Couldn't check for a newer LibreHardwareMonitor");
    SB.toast(u?.available ? `LibreHardwareMonitor ${u.latest} is out` : 'LibreHardwareMonitor is up to date');
  });
  // Filled in, not sent: it stops a program running as administrator and runs
  // winget, so you read what you're agreeing to first.
  $('hlLhmUpdate').addEventListener('click', () => {
    if (SB.isCrabOnly() || !lhmUpdate?.prompt) return api.openExternal('https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases/latest');
    SB.prefillNew(lhmUpdate.prompt);
  });

  Object.assign(H, { renderFans, renderDisks, renderSpace, renderSources, openSensors, loadLhm });
})();
