// The weather outside his window: what it's doing where you are, and what he
// puts on for it (a sou'wester and an umbrella in the rain, a bobble hat in the
// snow, shades on a hot sunny day). weather-service.js does the asking; this is
// the pure part: the addresses, reading the answers, and dressing for them.
//
// Open-Meteo (open-meteo.com) is free, needs no account or key, and is asked
// only for a town's coordinates, rounded to about 11 km.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const COORD_STEP = 10;           // coordinates go out to one decimal place (~11 km)
const MAX_RESULTS = 5;           // towns offered for a search
const QUERY_MAX = 80;
const NAME_MAX = 80;
const STALE_MS = 3 * HOUR;       // older than this and he takes the umbrella off
const HOT_C = 28;                // sunny and this warm: shades and a sweat
const COLD_C = 0;                // this cold and dry: bobble hat and a shiver
const WINDY_KMH = 40;            // the umbrella turns inside out

const CONDITIONS = Object.freeze(['clear', 'cloudy', 'fog', 'drizzle', 'rain', 'snow', 'storm']);
const WET = new Set(['drizzle', 'rain', 'storm']);
const LABEL = Object.freeze({ clear: 'Clear', cloudy: 'Cloudy', fog: 'Foggy', drizzle: 'Drizzle', rain: 'Rain', snow: 'Snow', storm: 'Thunderstorm' });
const EMOJI = Object.freeze({ clear: '☀️', cloudy: '☁️', fog: '🌫️', drizzle: '🌦️', rain: '🌧️', snow: '🌨️', storm: '⛈️' });

/** A WMO weather code (what Open-Meteo reports) as one of CONDITIONS, or null. */
function conditionOf(code) {
  if (!Number.isInteger(code)) return null;
  if (code <= 1) return code >= 0 ? 'clear' : null;
  if (code <= 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return 'drizzle';
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95 && code <= 99) return 'storm';
  return null;
}

const round = n => Math.round(n * COORD_STEP) / COORD_STEP;
const finite = n => typeof n === 'number' && Number.isFinite(n);
const text = (s, max) => (typeof s === 'string' ? s.trim().slice(0, max) : '');

/** A town as stored and sent: { name, region, country, lat, lon }, coordinates rounded. Null if unusable. */
function normalizePlace(p) {
  if (!p || typeof p !== 'object') return null;
  // Numbers only: Number(null) and Number('') are 0, which is somewhere in the Atlantic.
  const lat = typeof p.lat === 'number' ? p.lat : NaN, lon = typeof p.lon === 'number' ? p.lon : NaN;
  const name = text(p.name, NAME_MAX);
  if (!name || !finite(lat) || !finite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { name, region: text(p.region, NAME_MAX), country: text(p.country, NAME_MAX), lat: round(lat), lon: round(lon) };
}

const placeLabel = p => (p ? [p.name, p.country].filter(Boolean).join(', ') : '');

/** Is the town south of the equator? (Spring comes in September there; see wardrobe/seasons.js.) */
const isSouth = p => !!p && p.lat < 0;

function forecastUrl(place) {
  const p = normalizePlace(place);
  if (!p) return null;
  const q = new URLSearchParams({ latitude: String(p.lat), longitude: String(p.lon), current: 'temperature_2m,weather_code,wind_speed_10m,is_day' });
  return `${FORECAST_URL}?${q}`;
}

/** The address for a town search, or null for a query too short or too long to send. */
function searchUrl(query) {
  const q = text(query, QUERY_MAX + 1);
  if (q.length < 2 || q.length > QUERY_MAX) return null;
  return `${GEOCODE_URL}?${new URLSearchParams({ name: q, count: String(MAX_RESULTS), language: 'en', format: 'json' })}`;
}

/** Open-Meteo's search answer -> up to MAX_RESULTS towns. */
function parsePlaces(json) {
  const rows = Array.isArray(json?.results) ? json.results : [];
  return rows.slice(0, MAX_RESULTS)
    .map(r => normalizePlace({ name: r?.name, region: r?.admin1, country: r?.country, lat: r?.latitude, lon: r?.longitude }))
    .filter(Boolean);
}

/** Open-Meteo's forecast answer -> { condition, code, tempC, windKmh, isDay, at }, or null if it isn't one. */
function parseForecast(json, at) {
  const c = json?.current;
  if (!c || typeof c !== 'object') return null;
  const code = c.weather_code;
  const condition = conditionOf(code);
  if (!condition || !finite(c.temperature_2m)) return null;
  return {
    condition, code,
    tempC: Math.round(c.temperature_2m * 10) / 10,
    windKmh: finite(c.wind_speed_10m) ? Math.round(c.wind_speed_10m) : 0,
    isDay: c.is_day !== 0,
    at,
  };
}

/** A saved reading, if it still looks like one (config is user-editable). */
function normalizeReading(r) {
  if (!r || typeof r !== 'object' || !CONDITIONS.includes(r.condition) || !finite(r.tempC) || !finite(r.at)) return null;
  return { condition: r.condition, code: Number.isInteger(r.code) ? r.code : null, tempC: r.tempC, windKmh: finite(r.windKmh) ? r.windKmh : 0, isDay: r.isDay !== false, at: r.at };
}

const fresh = (r, now) => !!r && now - r.at < STALE_MS && now >= r.at - HOUR;

/**
 * What he wears for it, as wardrobe item ids by slot, plus a mood for the
 * renderer (a shiver, a sweat, a flinch at thunder). Null when there's nothing
 * to dress for, or the reading is too old to trust.
 *   -> { condition, hat, neck, face, held, effect, mood }
 */
function dress(reading, now) {
  const r = normalizeReading(reading);
  if (!r || !fresh(r, now)) return null;
  const windy = r.windKmh >= WINDY_KMH;
  const out = { condition: r.condition, hat: null, neck: null, face: null, held: null, effect: null, mood: null };
  if (WET.has(r.condition)) {
    Object.assign(out, {
      hat: 'sou-wester', neck: 'rain-cape',
      held: windy || r.condition === 'storm' ? 'umbrella-flipped' : 'umbrella',
      effect: r.condition === 'drizzle' ? 'drizzle' : 'rain',
      mood: r.condition === 'storm' ? 'storm' : null,
    });
  } else if (r.condition === 'snow') {
    Object.assign(out, { hat: 'bobble-hat', effect: 'snow', mood: r.tempC <= COLD_C ? 'cold' : null });
  } else if (r.tempC <= COLD_C) {
    Object.assign(out, { hat: 'bobble-hat', mood: 'cold' });
  } else if (r.condition === 'clear' && r.isDay && r.tempC >= HOT_C) {
    Object.assign(out, { face: 'beach-shades', mood: 'hot' });
  } else if (r.condition === 'fog') {
    out.effect = 'mist';
  } else {
    return null; // a plain day: his own outfit
  }
  return out;
}

/**
 * Worth a word when the weather turns: it starts raining or snowing, a storm
 * rolls in, or the rain stops. The first reading counts as a change from
 * nothing, so he mentions the rain he wakes up to. -> a voice occasion, or null.
 */
function remarkFor(prev, next) {
  if (!next) return null;
  const was = prev?.condition || null;
  const is = next.condition;
  if (is === was) return null;
  if (is === 'storm') return 'stormStart';
  if (WET.has(is)) return WET.has(was) ? null : 'rainStart';
  if (is === 'snow') return 'snowStart';
  if (WET.has(was) && (is === 'clear' || is === 'cloudy')) return 'rainStopped';
  return null;
}

/** "Rain, 12°C" (or °F), for Settings. */
function describe(r, unit = 'c') {
  if (!r) return '';
  const t = unit === 'f' ? `${Math.round(r.tempC * 9 / 5 + 32)}°F` : `${Math.round(r.tempC)}°C`;
  return `${EMOJI[r.condition]} ${LABEL[r.condition]}, ${t}`;
}

module.exports = {
  CONDITIONS, STALE_MS, HOT_C, COLD_C, WINDY_KMH, FORECAST_URL, GEOCODE_URL,
  conditionOf, normalizePlace, placeLabel, isSouth, forecastUrl, searchUrl, parsePlaces, parseForecast,
  normalizeReading, fresh, dress, remarkFor, describe,
};
