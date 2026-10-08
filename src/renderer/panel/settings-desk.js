/* Shellby panel — Settings: what he picks up around your desk. On a stream
   (OBS), desk lighting (OpenRGB), the music playing, your typing and the
   weather outside. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const T = window.ShellbySettingsText;

  // ---------------------------------------------------------------- on a stream
  function renderObs(v) {
    $('obsEnabled').checked = !!v.enabled;
    $('obsBody').hidden = !v.enabled;
    $('obsUrl').textContent = v.url || `http://127.0.0.1:${v.port}/`;
    const said = T.obsStatus(v);
    $('obsStatus').textContent = said.text;
    $('obsStatus').className = `small ext-status ${said.tone}`;
  }
  $('obsEnabled').addEventListener('change', async e => renderObs(await api.setObs({ enabled: e.target.checked })));

  // ---------------------------------------------------------------- desk lighting
  let rgbLast = null;
  function renderRgb(v) {
    rgbLast = v;
    $('rgbEnabled').checked = !!v.enabled;
    $('rgbBody').hidden = !v.enabled;
    const devices = v.devices || [];
    const said = T.rgbStatus(v);
    $('rgbStatus').textContent = said.text;
    $('rgbStatus').className = `small ext-status ${said.tone}`;
    // Not installed and nothing answering: installing is the only useful step.
    // (A portable copy running from elsewhere answers, so it counts as there.)
    const absent = !v.installed && !devices.length;
    $('rgbInstall').hidden = !absent;
    $('rgbTest').hidden = absent;
    $('rgbInstall').disabled = $('rgbTest').disabled = !!v.setup;
    $('rgbList').replaceChildren(...devices.map(d => h('li', { class: 'ext-session' },
      h('b', { text: d.name }),
      h('span', { class: 'ext-state', text: `${d.numLeds} LED${d.numLeds === 1 ? '' : 's'}` }))));
  }
  // Starting or installing OpenRGB takes a while. Main says which step it's on
  // (an install only begins once the confirm window says yes), so ask it
  // until the call comes back.
  const rgbBusy = async (setup, call) => {
    if (setup) renderRgb({ ...(rgbLast || {}), enabled: true, setup });
    let done = false;
    const poll = setInterval(() => {
      api.getRgb().then(v => { if (!done && v.setup) renderRgb(v); }).catch(() => { /* the final answer still comes */ });
    }, 1500);
    try {
      const v = await call();
      done = true;
      renderRgb(v);
      if (v.noWinget) {
        SB.toast("winget isn't on this PC, so here's OpenRGB's site to download it from.", { ms: 6000 });
        api.openExternal('https://openrgb.org/');
      }
    } catch {
      done = true;
      renderRgb({ ...(await api.getRgb().catch(() => rgbLast || {})), setup: null, error: "That didn't work. Try again?" });
    } finally {
      clearInterval(poll);
    }
  };
  $('rgbEnabled').addEventListener('change', e => (e.target.checked
    ? rgbBusy('starting', () => api.setRgb({ enabled: true }))
    // Off hides the status line, so a failed hand-back is said out loud.
    : api.setRgb({ enabled: false }).then(v => { renderRgb(v); if (v.error) SB.toast(v.error, { ms: 6000 }); })));
  $('rgbTest').addEventListener('click', () => rgbBusy('starting', api.testRgb));
  $('rgbInstall').addEventListener('click', () => rgbBusy(null, api.installOpenRgb));

  // ---------------------------------------------------------------- listening along
  function renderNowPlaying(v) {
    $('npEnabled').checked = !!v.enabled;
    $('npEnabled').disabled = !v.available;
    $('npBody').hidden = !v.enabled;
    $('npHeadphones').checked = v.headphones !== false;
    $('npRemarks').checked = v.remarks !== false;
    const said = T.nowPlayingStatus(v);
    $('npStatus').textContent = said.text;
    $('npStatus').className = `small ext-status ${said.tone}`;
  }
  const setNp = patch => api.setNowPlaying(patch).then(renderNowPlaying);
  $('npEnabled').addEventListener('change', e => setNp({ enabled: e.target.checked }));
  $('npHeadphones').addEventListener('change', e => setNp({ headphones: e.target.checked }));
  $('npRemarks').addEventListener('change', e => setNp({ remarks: e.target.checked }));
  api.onNowPlaying(v => { if (state.view === 'settings') renderNowPlaying(v); });

  // ---------------------------------------------------------------- typing along
  function renderTyping(v) {
    $('typingEnabled').checked = !!v.enabled;
    $('typingBody').hidden = !v.enabled;
    $('typingRemarks').checked = v.remarks !== false;
    const said = T.typingStatus(v);
    $('typingStatus').textContent = said.text;
    $('typingStatus').className = `small ext-status ${said.tone}`;
  }
  const setTyping = patch => api.setTyping(patch).then(renderTyping);
  $('typingEnabled').addEventListener('change', e => setTyping({ enabled: e.target.checked }));
  $('typingRemarks').addEventListener('change', e => setTyping({ remarks: e.target.checked }));

  // ---------------------------------------------------------------- the weather outside
  function renderWeather(v) {
    $('weatherEnabled').checked = !!v.enabled;
    $('weatherBody').hidden = !v.enabled;
    $('weatherRemarks').checked = v.remarks !== false;
    if (v.label && document.activeElement !== $('weatherQuery')) $('weatherQuery').value = v.place?.name || '';
    const status = $('weatherStatus');
    const said = T.weatherStatus(v);
    status.className = 'small ext-status';
    status.textContent = said.text;
    if (said.tone) status.classList.add(said.tone);
  }
  const setWeather = patch => api.setWeather(patch).then(renderWeather);
  $('weatherEnabled').addEventListener('change', e => setWeather({ enabled: e.target.checked }));
  $('weatherRemarks').addEventListener('change', e => setWeather({ remarks: e.target.checked }));

  function showPlaces(places) {
    const host = $('weatherPlaces');
    host.replaceChildren(...places.map(p => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ghost slim-btn';
      b.textContent = [p.name, p.region, p.country].filter(Boolean).join(', ');
      b.addEventListener('click', () => {
        host.hidden = true;
        host.replaceChildren();
        setWeather({ place: p });
      });
      return b;
    }));
    host.hidden = !places.length;
    host.querySelector('button')?.focus();
  }
  $('weatherSearch').addEventListener('submit', async e => {
    e.preventDefault();
    const find = $('weatherFind');
    find.disabled = true;
    $('weatherStatus').textContent = 'Looking…';
    try {
      const r = await api.searchWeather($('weatherQuery').value);
      showPlaces(r.places || []);
      $('weatherStatus').textContent = r.error || (r.places.length === 1 ? 'Is this the one?' : 'Which one?');
    } catch {
      $('weatherStatus').textContent = "Couldn't search just now.";
    } finally {
      find.disabled = false;
    }
  });
  api.onWeather(v => { if (state.view === 'settings') renderWeather(v); });
  api.onObs(v => { if (state.view === 'settings') renderObs(v); });

  SB.onSettingsOpen(() => {
    api.getObs().then(renderObs);
    api.getRgb().then(renderRgb);
    api.getNowPlaying().then(renderNowPlaying);
    api.getTyping().then(renderTyping);
    api.getWeather().then(renderWeather);
  });
})();
