const { test } = require('node:test');
const assert = require('node:assert/strict');
const w = require('../src/main/weather');
const { createWeatherService, getJson, POLL_MS, RETRY_MS } = require('../src/main/weather/service');
const seasons = require('../src/main/wardrobe/seasons');

const HOUR = 60 * 60 * 1000;
const reading = (condition, extra = {}) => ({ condition, code: 0, tempC: 12, windKmh: 10, isDay: true, at: 1000, ...extra });

// ---------------------------------------------------------------- reading the weather

test('WMO codes map onto his handful of conditions', () => {
  const cases = { 0: 'clear', 1: 'clear', 2: 'cloudy', 3: 'cloudy', 45: 'fog', 48: 'fog', 51: 'drizzle', 57: 'drizzle', 61: 'rain', 67: 'rain', 80: 'rain', 82: 'rain', 71: 'snow', 77: 'snow', 85: 'snow', 86: 'snow', 95: 'storm', 99: 'storm' };
  for (const [code, want] of Object.entries(cases)) assert.equal(w.conditionOf(Number(code)), want, `code ${code}`);
  for (const bad of [-1, 4, 50, 100, 1.5, '61', null, undefined]) assert.equal(w.conditionOf(bad), null, `code ${bad}`);
});

test('a town is rounded to about 11 km before it is stored or sent', () => {
  const p = w.normalizePlace({ name: ' Lisbon ', region: 'Lisbon', country: 'Portugal', lat: 38.71667, lon: -9.13333 });
  assert.deepEqual(p, { name: 'Lisbon', region: 'Lisbon', country: 'Portugal', lat: 38.7, lon: -9.1 });
  const url = new URL(w.forecastUrl(p));
  assert.equal(url.origin + url.pathname, w.FORECAST_URL);
  assert.equal(url.searchParams.get('latitude'), '38.7');
  assert.equal(url.searchParams.get('longitude'), '-9.1');
  // Nothing but the position and what to report.
  assert.deepEqual([...url.searchParams.keys()].sort(), ['current', 'latitude', 'longitude']);
});

test('nonsense places are refused', () => {
  for (const bad of [null, 'Paris', {}, { name: '', lat: 1, lon: 1 }, { name: 'x', lat: 91, lon: 0 }, { name: 'x', lat: 0, lon: 181 }, { name: 'x', lat: 'a', lon: 0 }, { name: 'x', lat: NaN, lon: 0 }]) {
    assert.equal(w.normalizePlace(bad), null, JSON.stringify(bad));
  }
  assert.equal(w.forecastUrl(null), null);
});

test('a town search is bounded and encoded', () => {
  assert.equal(w.searchUrl('a'), null);
  assert.equal(w.searchUrl('  '), null);
  assert.equal(w.searchUrl('x'.repeat(81)), null);
  const url = new URL(w.searchUrl('São Paulo & co'));
  assert.equal(url.origin + url.pathname, w.GEOCODE_URL);
  assert.equal(url.searchParams.get('name'), 'São Paulo & co');
  assert.equal(url.searchParams.get('count'), '5');
});

test('search results become tidy towns, junk dropped', () => {
  const places = w.parsePlaces({ results: [
    { name: 'Sydney', admin1: 'New South Wales', country: 'Australia', latitude: -33.86785, longitude: 151.20732 },
    { name: 'Nowhere', latitude: 'x', longitude: 0 },
    null,
  ] });
  assert.deepEqual(places, [{ name: 'Sydney', region: 'New South Wales', country: 'Australia', lat: -33.9, lon: 151.2 }]);
  assert.deepEqual(w.parsePlaces({}), []);
  assert.deepEqual(w.parsePlaces(null), []);
});

test('a forecast reads into a reading, and anything else into null', () => {
  const r = w.parseForecast({ current: { temperature_2m: 11.94, weather_code: 63, wind_speed_10m: 23.4, is_day: 0 } }, 5000);
  assert.deepEqual(r, { condition: 'rain', code: 63, tempC: 11.9, windKmh: 23, isDay: false, at: 5000 });
  assert.equal(w.parseForecast({ current: { temperature_2m: 10, weather_code: 4 } }, 1), null);
  assert.equal(w.parseForecast({ current: { temperature_2m: 'warm', weather_code: 0 } }, 1), null);
  assert.equal(w.parseForecast({}, 1), null);
  assert.equal(w.parseForecast(null, 1), null);
});

// ---------------------------------------------------------------- dressing for it

test('rain: sou\'wester, cape, umbrella and rain', () => {
  assert.deepEqual(w.dress(reading('rain'), 2000), { condition: 'rain', hat: 'sou-wester', neck: 'rain-cape', face: null, held: 'umbrella', effect: 'rain', mood: null });
  assert.equal(w.dress(reading('drizzle'), 2000).effect, 'drizzle');
});

test('a storm or a gale turns the umbrella inside out', () => {
  const storm = w.dress(reading('storm'), 2000);
  assert.equal(storm.held, 'umbrella-flipped');
  assert.equal(storm.mood, 'storm');
  assert.equal(w.dress(reading('rain', { windKmh: w.WINDY_KMH }), 2000).held, 'umbrella-flipped');
});

test('snow and cold: the bobble hat, and a shiver below freezing', () => {
  assert.deepEqual(w.dress(reading('snow', { tempC: -3 }), 2000), { condition: 'snow', hat: 'bobble-hat', neck: null, face: null, held: null, effect: 'snow', mood: 'cold' });
  assert.equal(w.dress(reading('snow', { tempC: 1 }), 2000).mood, null);
  const frost = w.dress(reading('clear', { tempC: -5 }), 2000);
  assert.equal(frost.hat, 'bobble-hat');
  assert.equal(frost.mood, 'cold');
});

test('a hot sunny afternoon: shades and a sweat, but not at night', () => {
  const hot = w.dress(reading('clear', { tempC: 31 }), 2000);
  assert.equal(hot.face, 'beach-shades');
  assert.equal(hot.mood, 'hot');
  assert.equal(w.dress(reading('clear', { tempC: 31, isDay: false }), 2000), null);
});

test('fog brings the mist; a plain day changes nothing', () => {
  assert.equal(w.dress(reading('fog'), 2000).effect, 'mist');
  assert.equal(w.dress(reading('cloudy'), 2000), null);
  assert.equal(w.dress(reading('clear'), 2000), null);
});

test('an old reading is not trusted: the umbrella comes off', () => {
  assert.ok(w.dress(reading('rain', { at: 0 }), w.STALE_MS - 1));
  assert.equal(w.dress(reading('rain', { at: 0 }), w.STALE_MS), null);
  // A reading from the future (a clock change) is not trusted either.
  assert.equal(w.dress(reading('rain', { at: 10 * HOUR }), 0), null);
  assert.equal(w.dress({ condition: 'hail', tempC: 1, at: 0 }, 0), null);
});

// ---------------------------------------------------------------- saying so

test('he remarks when the weather turns, not every half hour', () => {
  assert.equal(w.remarkFor(null, reading('rain')), 'rainStart');
  assert.equal(w.remarkFor(reading('cloudy'), reading('rain')), 'rainStart');
  assert.equal(w.remarkFor(reading('rain'), reading('rain')), null);
  assert.equal(w.remarkFor(reading('drizzle'), reading('rain')), null);
  assert.equal(w.remarkFor(reading('rain'), reading('storm')), 'stormStart');
  assert.equal(w.remarkFor(reading('clear'), reading('snow')), 'snowStart');
  assert.equal(w.remarkFor(reading('rain'), reading('clear')), 'rainStopped');
  assert.equal(w.remarkFor(reading('rain'), reading('fog')), null);
  assert.equal(w.remarkFor(reading('clear'), reading('cloudy')), null);
  assert.equal(w.remarkFor(reading('clear'), null), null);
});

test('Settings shows it in your own units', () => {
  assert.equal(w.describe(reading('rain', { tempC: 12.4 }), 'c'), '🌧️ Rain, 12°C');
  assert.equal(w.describe(reading('rain', { tempC: 12.4 }), 'f'), '🌧️ Rain, 54°F');
  assert.equal(w.describe(null), '');
});

// ---------------------------------------------------------------- real seasons

test('south of the equator, the nature seasons move six months; the holidays stay put', () => {
  const july = new Date(2026, 6, 15);
  const north = seasons.activeSeasons(july).map(s => s.id);
  const south = seasons.activeSeasons(july, { south: true }).map(s => s.id);
  assert.ok(north.includes('summer'));
  assert.ok(!south.includes('summer'));
  assert.ok(!seasons.isActive('summer', new Date(2026, 0, 10)));
  assert.ok(seasons.isActive('summer', new Date(2026, 0, 10), { south: true }));
  assert.ok(seasons.isActive('spring', new Date(2026, 9, 1), { south: true }));
  assert.ok(seasons.isActive('autumn', new Date(2026, 3, 1), { south: true }));
  // Halloween is Halloween everywhere.
  assert.ok(seasons.isActive('halloween', new Date(2026, 9, 20), { south: true }));
  // The featured season carries the dates where you are.
  assert.deepEqual([...seasons.featuredSeason(new Date(2026, 0, 20), { south: true }).start], [12, 21]);
  assert.deepEqual(seasons.nextStart('spring', new Date(2026, 6, 1), { south: true }), new Date(2026, 8, 20));
  assert.ok(w.isSouth({ lat: -33.9 }));
  assert.ok(!w.isSouth({ lat: 51.5 }));
  assert.ok(!w.isSouth(null));
});

// ---------------------------------------------------------------- asking Open-Meteo

function fakeConfig(init = {}) {
  let data = { ...init };
  return { get: k => data[k], set: patch => { data = { ...data, ...patch }; return data; } };
}
const LISBON = { name: 'Lisbon', country: 'Portugal', lat: 38.7, lon: -9.1 };
const okJson = body => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const RAIN = { current: { temperature_2m: 12, weather_code: 63, wind_speed_10m: 10, is_day: 1 } };

function service({ config = fakeConfig({ weather: { enabled: true, place: LISBON } }), fetch = okJson(RAIN), now = () => 50_000 } = {}) {
  const readings = [];
  const urls = [];
  const svc = createWeatherService({ config, now, fetch: async (url, opts) => { urls.push({ url, opts }); return fetch(url, opts); }, onReading: (prev, next) => readings.push({ prev, next }) });
  return { svc, config, readings, urls };
}

test('a check saves the reading and says what changed', async () => {
  const { svc, config, readings, urls } = service();
  const r = await svc.check();
  assert.equal(r.condition, 'rain');
  assert.equal(config.get('weatherNow').condition, 'rain');
  assert.deepEqual(readings.map(x => [x.prev, x.next.condition]), [[null, 'rain']]);
  assert.equal(urls[0].opts.redirect, 'error');
  assert.ok(urls[0].url.includes('latitude=38.7'));
  svc.stop();
});

test('off, or with no town, it never asks', async () => {
  for (const weather of [{ enabled: false, place: LISBON }, { enabled: true, place: null }, null]) {
    const { svc, urls } = service({ config: fakeConfig({ weather }) });
    assert.equal(await svc.check(), null);
    assert.equal(urls.length, 0);
  }
});

test('a failed check is reported in words and keeps the old reading', async () => {
  const config = fakeConfig({ weather: { enabled: true, place: LISBON }, weatherNow: reading('clear', { at: 40_000 }) });
  const { svc, readings } = service({ config, fetch: async () => ({ ok: false, status: 503, text: async () => '' }) });
  assert.equal(await svc.check(), null);
  assert.equal(svc.view().error, 'the weather service said 503');
  assert.equal(config.get('weatherNow').condition, 'clear');
  assert.equal(readings.length, 0);
  svc.stop();
});

test('garbage from the service is not a reading', async () => {
  const { svc } = service({ fetch: async () => ({ ok: true, status: 200, text: async () => '<html>' }) });
  assert.equal(await svc.check(), null);
  assert.ok(svc.view().error);
  svc.stop();
});

test('getJson refuses an oversized answer and names a timeout', async () => {
  const big = await getJson(async () => ({ ok: true, status: 200, text: async () => 'x'.repeat(100) }), 'https://x', { maxBytes: 10 });
  assert.equal(big.error, 'the weather service sent too much');
  const slow = await getJson((_u, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))), 'https://x', { timeoutMs: 5 });
  assert.equal(slow.error, "the weather service didn't answer");
});

test('moving town forgets the old weather; a bad town is ignored', () => {
  const config = fakeConfig({ weather: { enabled: true, place: LISBON }, weatherNow: reading('rain') });
  const { svc } = service({ config });
  svc.set({ place: { name: 'Sydney', country: 'Australia', lat: -33.87, lon: 151.21 } });
  assert.equal(config.get('weather').place.name, 'Sydney');
  assert.equal(config.get('weather').place.lat, -33.9);
  assert.equal(config.get('weatherNow'), null);
  svc.set({ place: { name: 'Bogus', lat: 999, lon: 0 } });
  assert.equal(config.get('weather').place.name, 'Sydney');
  svc.set({ enabled: false });
  assert.equal(config.get('weather').enabled, false);
  svc.stop();
});

test('an answer for a town you have since left is thrown away', async () => {
  const config = fakeConfig({ weather: { enabled: true, place: LISBON } });
  let release;
  const { svc, readings } = service({ config, fetch: () => new Promise(r => { release = r; }) });
  const pending = svc.check();
  svc.set({ place: { name: 'Oslo', country: 'Norway', lat: 59.9, lon: 10.7 } });
  release({ ok: true, status: 200, text: async () => JSON.stringify(RAIN) });
  assert.equal(await pending, null);
  assert.equal(readings.length, 0);
  assert.equal(config.get('weatherNow'), null);
  svc.stop();
});

test('town search: too short, no match, and matches', async () => {
  const { svc } = service({ fetch: okJson({ results: [{ name: 'Lisbon', country: 'Portugal', latitude: 38.7, longitude: -9.1 }] }) });
  assert.match((await svc.search('L')).error, /two letters/);
  assert.equal((await svc.search('Lisbon')).places[0].name, 'Lisbon');
  const none = service({ fetch: okJson({}) }).svc;
  assert.equal((await none.search('Atlantis')).error, 'No town by that name.');
});

test('the schedule: polls every half hour, retries sooner after a failure', () => {
  assert.equal(POLL_MS, 30 * 60 * 1000);
  assert.ok(RETRY_MS.every((ms, i) => ms < POLL_MS && (i === 0 || ms > RETRY_MS[i - 1])));
});

// ---------------------------------------------------------------- review fixes

test('moving town mid-check asks again for the new town, rather than stalling', async () => {
  const config = fakeConfig({ weather: { enabled: true, place: LISBON } });
  const answers = [];
  const urls = [];
  const svc = createWeatherService({
    config, now: () => 50_000,
    fetch: url => { urls.push(url); return new Promise(r => answers.push(r)); },
  });
  const pending = svc.check();
  svc.set({ place: { name: 'Oslo', country: 'Norway', lat: 59.9, lon: 10.7 } });
  answers[0]({ ok: true, status: 200, text: async () => JSON.stringify(RAIN) });
  assert.equal(await pending, null);
  // The stale answer queued a fresh check for Oslo straight away.
  await new Promise(r => setTimeout(r, 20));
  assert.equal(urls.length, 2);
  assert.ok(urls[1].includes('latitude=59.9'));
  answers[1]({ ok: true, status: 200, text: async () => JSON.stringify(RAIN) });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(config.get('weatherNow').condition, 'rain');
  svc.stop();
});

test('a failed check tells main, so stale gear can come off; a throwing listener is contained', async () => {
  let fails = 0;
  const logs = [];
  const svc = createWeatherService({
    config: fakeConfig({ weather: { enabled: true, place: LISBON } }), now: () => 1,
    fetch: async () => ({ ok: false, status: 500, text: async () => '' }),
    onFail: () => { fails++; throw new Error('boom'); }, log: m => logs.push(m),
  });
  assert.equal(await svc.check(), null);
  assert.equal(fails, 1);
  assert.ok(logs.some(m => m.includes('boom')));
  svc.stop();
});

test('an answer that says it is too big is refused before it is read', async () => {
  let read = false;
  const r = await getJson(async () => ({ ok: true, status: 200, headers: { get: () => '999999' }, text: async () => { read = true; return '{}'; } }), 'https://x');
  assert.equal(r.error, 'the weather service sent too much');
  assert.equal(read, false);
});

test('pressing Find twice sends one search', async () => {
  let calls = 0;
  let release;
  const svc = createWeatherService({ config: fakeConfig(), fetch: () => { calls++; return new Promise(r => { release = r; }); } });
  const a = svc.search('Lisbon');
  const b = svc.search('Lisbon');
  await new Promise(r => setTimeout(r, 5));
  release({ ok: true, status: 200, text: async () => JSON.stringify({ results: [{ name: 'Lisbon', latitude: 38.7, longitude: -9.1 }] }) });
  assert.deepEqual(await a, await b);
  assert.equal(calls, 1);
});

test('null or blank coordinates are not the middle of the Atlantic', () => {
  assert.equal(w.normalizePlace({ name: 'x', lat: null, lon: '' }), null);
  assert.equal(w.normalizePlace({ name: 'x', lat: '38.7', lon: -9.1 }), null);
});

test('southern seasons end on days their months have', () => {
  for (const s of seasons.SEASONS) {
    const here = seasons.local(s, { south: true });
    for (const [m, d] of [here.start, here.end]) {
      const date = new Date(2027, m - 1, d); // 2027: not a leap year
      assert.equal(date.getMonth(), m - 1, `${s.id} ${m}/${d}`);
    }
  }
});
