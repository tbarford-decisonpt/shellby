// Asking Open-Meteo about the weather (see weather.js for what it means). Off
// until you turn it on and pick a town; then every 30 minutes, and once when
// the PC wakes. The last reading is kept, so a restart doesn't need the network
// to know it was raining. A failed check backs off rather than hammering away.
//
// Settings live in config.weather: { enabled, place, remarks }; the reading in
// config.weatherNow. No Electron here: `fetch` is passed in (main gives it
// net.fetch, so a proxy set in Windows applies), which keeps this testable.

const weather = require('../weather');

const MINUTE = 60 * 1000;
const POLL_MS = 30 * MINUTE;
const RETRY_MS = [2 * MINUTE, 5 * MINUTE, 15 * MINUTE];  // after 1, 2, then 3 or more failures in a row
const TIMEOUT_MS = 10 * 1000;
const MAX_BYTES = 64 * 1024;     // a forecast is ~600 bytes, a search ~3 KB

function normalizeSettings(raw) {
  return {
    enabled: !!raw?.enabled,
    place: weather.normalizePlace(raw?.place),
    remarks: raw?.remarks !== false,
  };
}

/** GET a small JSON document. -> { json } or { error } (a short reason for Settings). */
async function getJson(fetchImpl, url, { timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, redirect: 'error', headers: { accept: 'application/json' } });
    if (!res.ok) return { error: `the weather service said ${res.status}` };
    const tooMuch = { error: 'the weather service sent too much' };
    if (Number(res.headers?.get?.('content-length')) > maxBytes) return tooMuch;
    const body = await res.text();
    if (Buffer.byteLength(body) > maxBytes) return tooMuch;
    return { json: JSON.parse(body) };
  } catch (e) {
    return { error: e?.name === 'AbortError' ? "the weather service didn't answer" : "couldn't reach the weather service" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * deps: { config, fetch, now?, onReading(prev, next), onFail?(), log? }
 * onReading fires after every successful check (prev may be null), so main can
 * redress him and let him remark on a change (weather.remarkFor). onFail fires
 * after a failed one, so main can take the umbrella off once the last reading
 * is too old to trust (weather.dress).
 */
function createWeatherService(d) {
  const now = () => d.now?.() ?? Date.now();
  let timer = null;
  let failures = 0;
  let lastError = null;
  let checking = null;
  let searching = null;
  const tell = (fn, ...args) => { try { fn?.(...args); } catch (e) { d.log?.(`Weather: ${e.message}`); } };

  const settings = () => normalizeSettings(d.config.get('weather'));
  const reading = () => weather.normalizeReading(d.config.get('weatherNow'));
  const active = () => { const s = settings(); return s.enabled && !!s.place; };

  function schedule(ms) {
    clearTimeout(timer);
    timer = active() ? setTimeout(() => { check().catch(e => d.log?.(`Weather check: ${e.message}`)); }, Math.max(0, ms)) : null;
    timer?.unref?.();
  }

  async function check() {
    if (!active()) return null;
    if (checking) return checking;
    checking = (async () => {
      const { place } = settings();
      const r = await getJson(d.fetch, weather.forecastUrl(place));
      const next = r.json ? weather.parseForecast(r.json, now()) : null;
      if (!next) {
        failures += 1;
        lastError = r.error || 'the weather service sent something odd';
        d.log?.(`Weather check failed: ${lastError}`);
        schedule(RETRY_MS[Math.min(failures, RETRY_MS.length) - 1]);
        tell(d.onFail);
        return null;
      }
      // Switched off or moved town while it was asking: this answer is for
      // nobody. The new town's check was swallowed by this one, so ask again.
      const here = settings().place;
      if (!active() || here?.name !== place.name || here.lat !== place.lat || here.lon !== place.lon) {
        if (active()) schedule(0);
        return null;
      }
      failures = 0;
      lastError = null;
      const prev = reading();
      d.config.set({ weatherNow: next });
      schedule(POLL_MS);
      tell(d.onReading, prev, next);
      return next;
    })();
    try { return await checking; } finally { checking = null; }
  }

  // How long until the next check is due: none if the last reading is old.
  const dueIn = () => { const r = reading(); return r ? Math.max(0, POLL_MS - (now() - r.at)) : 0; };

  /** Begin (or carry on) checking: straight away if the last reading is old. */
  function start() { schedule(dueIn()); }

  function stop() { clearTimeout(timer); timer = null; }

  /** Apply a Settings change. A new town forgets the old town's weather and asks again. */
  function set(patch = {}) {
    const prev = settings();
    const next = { ...prev };
    if ('enabled' in patch) next.enabled = !!patch.enabled;
    if ('remarks' in patch) next.remarks = !!patch.remarks;
    if ('place' in patch) next.place = patch.place === null ? null : weather.normalizePlace(patch.place) || prev.place;
    const moved = JSON.stringify(next.place) !== JSON.stringify(prev.place);
    d.config.set({ weather: next, ...(moved ? { weatherNow: null } : {}) });
    if (moved) { failures = 0; lastError = null; }
    // Switching back on reuses a reading that's still fresh rather than asking again.
    if (active()) schedule(moved ? 0 : dueIn()); else stop();
    return next;
  }

  /** Towns matching what you typed. -> { places } or { error } */
  // One search at a time: a second Find while one is out waits for its answer.
  async function search(query) {
    const url = weather.searchUrl(query);
    if (!url) return { error: 'Type at least two letters of a town.' };
    if (searching) return searching;
    searching = (async () => {
      const r = await getJson(d.fetch, url);
      if (r.error) return { error: `Couldn't search: ${r.error}.` };
      const places = weather.parsePlaces(r.json);
      return places.length ? { places } : { places, error: 'No town by that name.' };
    })();
    try { return await searching; } finally { searching = null; }
  }

  const view = () => ({ ...settings(), reading: reading(), error: lastError, checking: !!checking });

  return { start, stop, check, set, search, settings, reading, view };
}

module.exports = { createWeatherService, normalizeSettings, getJson, POLL_MS, RETRY_MS };
