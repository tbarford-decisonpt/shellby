// What the Settings screen says (src/renderer/panel/settings-text.js): the
// shortcut recorder, the billing guard, update lines and connection statuses.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/renderer/panel/settings-text');

const key = (o) => ({ key: '', code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...o });
const relTime = at => `at ${at}`;

test('accelerator joins the modifiers held with a letter, digit, F-key or Space', () => {
  assert.deepEqual(T.accelerator(key({ key: 's', code: 'KeyS', ctrlKey: true, shiftKey: true })), { accel: 'Control+Shift+S' });
  assert.deepEqual(T.accelerator(key({ key: '1', code: 'Digit1', altKey: true })), { accel: 'Alt+1' });
  assert.deepEqual(T.accelerator(key({ key: 'F12', code: 'F12', metaKey: true })), { accel: 'Super+F12' });
  assert.deepEqual(T.accelerator(key({ key: ' ', code: 'Space', ctrlKey: true })), { accel: 'Control+Space' });
});

test('accelerator clears on Backspace and waits while only a modifier is down', () => {
  assert.deepEqual(T.accelerator(key({ key: 'Backspace', code: 'Backspace' })), { accel: '' });
  assert.equal(T.accelerator(key({ key: 'Control', code: 'ControlLeft', ctrlKey: true })), null);
  assert.equal(T.accelerator(key({ key: 'Meta', code: 'MetaLeft', metaKey: true })), null);
});

test('accelerator says what is wrong with a key it cannot use', () => {
  assert.deepEqual(T.accelerator(key({ key: 's', code: 'KeyS' })), { error: 'Add at least one modifier key.' });
  assert.deepEqual(T.accelerator(key({ key: '[', code: 'BracketLeft', ctrlKey: true })), { error: 'Use a letter, number, F-key or Space.' });
});

test('billingState is safe with plan only, risky with a billing variable set, else off', () => {
  assert.equal(T.billingState(true, ['ANTHROPIC_API_KEY']), 'safe');
  assert.equal(T.billingState(false, ['ANTHROPIC_API_KEY']), 'risk');
  assert.equal(T.billingState(false, []), 'off');
  for (const s of ['safe', 'risk', 'off']) assert.ok(T.BILLING_GUARD[s].title && T.BILLING_GUARD[s].pill, s);
});

test('planLabel names the plan, falls back to the sign-in method, and asks to sign in', () => {
  assert.equal(T.planLabel({ loggedIn: true, subscriptionType: 'max' }), 'Max plan');
  assert.equal(T.planLabel({ loggedIn: true, authMethod: 'console' }), 'console');
  assert.equal(T.planLabel({ loggedIn: true }), 'claude.ai');
  assert.equal(T.planLabel({ loggedIn: false, subscriptionType: 'pro' }), 'Sign in with your Claude account to give Shellby tasks.');
});

test('claudeUpdateTitle shows the version being updated, the new one, or the one installed', () => {
  assert.equal(T.claudeUpdateTitle({ updating: true }, '2.1.0'), 'Updating Claude Code v2.1.0…');
  assert.equal(T.claudeUpdateTitle({ available: true, latest: '2.2.0' }, '2.1.0'), 'Claude Code v2.2.0 is out');
  assert.equal(T.claudeUpdateTitle({}, undefined), 'Claude Code v?');
});

test('claudeUpdateNote puts an error first, then what is happening, then the mode', () => {
  assert.equal(T.claudeUpdateNote({ error: 'Offline', updating: true }, '1', relTime), 'Offline');
  assert.match(T.claudeUpdateNote({ updating: true }, '1', relTime), /fetching it/);
  assert.equal(T.claudeUpdateNote({ checking: true }, '1', relTime), 'Asking the npm registry…');
  assert.equal(T.claudeUpdateNote({ available: true, mode: 'auto' }, '1.0', relTime), 'You have v1.0. He updates it once nothing is running.');
  assert.equal(T.claudeUpdateNote({ available: true, mode: 'tell' }, '1.0', relTime), 'You have v1.0. Update takes a minute; new conversations get it.');
  assert.match(T.claudeUpdateNote({ mode: 'off' }, '1', relTime), /never asks/);
  assert.equal(T.claudeUpdateNote({ lastCheckAt: 5 }, '1', relTime), 'The latest, checked at 5. He looks once a day.');
  assert.equal(T.claudeUpdateNote({}, '1', relTime), 'He looks once a day.');
});

test('updateStatus and updateButton follow the updater, with idle for anything unknown', () => {
  assert.equal(T.updateStatus({ state: 'downloading', version: '1.2.3' }, relTime), 'Downloading v1.2.3…');
  assert.equal(T.updateStatus({ state: 'downloading' }, relTime), 'Downloading the update…');
  assert.equal(T.updateStatus({ state: 'current', checkedAt: 7 }, relTime), "You're on the latest version, checked at 7.");
  assert.equal(T.updateStatus({ state: 'current' }, relTime), "You're on the latest version.");
  assert.equal(T.updateStatus({ state: 'error' }, relTime), "Couldn't check for updates.");
  assert.equal(T.updateStatus({ state: 'mystery' }, relTime), 'Shellby updates himself from GitHub Releases.');
  assert.equal(T.updateButton({ state: 'downloading', percent: 42 }), '42%');
  assert.equal(T.updateButton({ state: 'ready' }), 'Restart and update');
  assert.equal(T.updateButton({ state: 'idle' }), 'Check for updates');
});

test('sessionState names what an outside session is doing, and its tool while working', () => {
  assert.equal(T.sessionState({ state: 'working', tool: 'Bash' }), 'working · Bash');
  assert.equal(T.sessionState({ state: 'working' }), 'working');
  assert.equal(T.sessionState({ state: 'asking' }), 'needs your OK');
  assert.equal(T.sessionState({ state: 'odd' }), 'odd');
});

test('externalStatus counts sessions while listening and warns when the port is taken', () => {
  assert.deepEqual(T.externalStatus({ enabled: true, status: 'listening', sessions: [{}, {}] }), { text: '2 sessions connected.', tone: 'ok' });
  assert.equal(T.externalStatus({ enabled: true, status: 'listening', sessions: [{}] }).text, '1 session connected.');
  assert.match(T.externalStatus({ enabled: true, status: 'listening' }).text, /^Listening\./);
  assert.deepEqual(T.externalStatus({ enabled: true, status: 'busy', port: 4777 }), { text: "Another app is using port 4777, so outside sessions can't reach Shellby.", tone: 'warn' });
  assert.deepEqual(T.externalStatus({ enabled: true, status: 'stopped' }), { text: 'Not listening right now.', tone: '' });
  assert.equal(T.externalStatus({ enabled: false, status: 'listening' }).tone, '');
});

test('cliStatus is ready only when installed and listening', () => {
  assert.deepEqual(T.cliStatus({ available: false }), { text: 'Windows only for now.', tone: '' });
  assert.equal(T.cliStatus({ available: true, installed: true, listening: true }).tone, 'ok');
  assert.match(T.cliStatus({ available: true, installed: true, listening: false }).text, /^Turn on/);
  assert.deepEqual(T.cliStatus({ available: true, installed: false }), { text: '', tone: '' });
});

test('deckStatus says whether the Stream Deck is listening, or what is in the way', () => {
  const on = { status: 'listening', port: 47915, installed: true, connected: 0 };
  assert.deepEqual(T.deckStatus({ ...on, connected: 1 }), { text: 'Stream Deck is connected.', tone: 'ok' });
  assert.equal(T.deckStatus(on).text, 'Add the keys to start.');
  assert.equal(T.deckStatus({ ...on, added: true }).text, 'Waiting for Stream Deck.');
  assert.equal(T.deckStatus({ ...on, installed: false }).tone, 'warn');
  assert.equal(T.deckStatus({ ...on, status: 'busy' }).text, 'Another app is using port 47915.');
  assert.equal(T.deckStatus({ ...on, error: 'Nope.' }).text, 'Nope.');
  assert.equal(T.deckStatus({ status: 'off', installed: true }).text, '');
});

test('obsStatus counts connected sources', () => {
  assert.deepEqual(T.obsStatus({ status: 'listening', viewers: 1 }), { text: '1 source connected.', tone: 'ok' });
  assert.equal(T.obsStatus({ status: 'listening' }).text, 'Waiting for OBS to connect.');
  assert.deepEqual(T.obsStatus({ status: 'busy', port: 1 }), { text: 'Another app is using port 1.', tone: 'warn' });
  assert.deepEqual(T.obsStatus({ status: 'off' }), { text: '', tone: '' });
});

test('rgbStatus says the step it is on before any error or device count', () => {
  assert.deepEqual(T.rgbStatus({ setup: 'starting', error: 'x', devices: [{}] }), { text: 'Starting OpenRGB…', tone: '' });
  assert.deepEqual(T.rgbStatus({ error: 'No server' }), { text: 'No server', tone: 'warn' });
  assert.deepEqual(T.rgbStatus({ devices: [{}, {}] }), { text: '2 devices.', tone: 'ok' });
  assert.deepEqual(T.rgbStatus({}), { text: '', tone: '' });
});

test('nowPlayingStatus shows the track, paused or playing, with the app', () => {
  assert.deepEqual(T.nowPlayingStatus({ available: true, track: { playing: true, title: 'Song', artist: 'Band', app: 'Spotify' } }), { text: '♪ Song — Band (Spotify)', tone: 'ok' });
  assert.deepEqual(T.nowPlayingStatus({ available: true, track: { playing: false, title: 'Song' } }), { text: 'Paused: Song', tone: '' });
  assert.equal(T.nowPlayingStatus({ available: true }).text, 'Nothing playing.');
  assert.equal(T.nowPlayingStatus({ available: true, status: 'unavailable' }).text, "Windows isn't answering about media here.");
  assert.equal(T.nowPlayingStatus({ available: false }).text, 'Windows only.');
});

test('typingStatus reports the best burst once there is one', () => {
  assert.deepEqual(T.typingStatus({ available: true, best: 92 }), { text: 'Your fastest burst so far: 92 words a minute.', tone: 'ok' });
  assert.equal(T.typingStatus({ available: true }).tone, '');
  assert.match(T.typingStatus({ available: false, best: 92 }).text, /isn't letting him hear/);
});

test('minutesAgo rounds to minutes, then hours past an hour and a half', () => {
  const now = 10 * 3600000;
  assert.equal(T.minutesAgo(now - 20000, now), 'just now');
  assert.equal(T.minutesAgo(now - 60000, now), 'a minute ago');
  assert.equal(T.minutesAgo(now - 89 * 60000, now), '89 minutes ago');
  assert.equal(T.minutesAgo(now - 90 * 60000, now), '2 hours ago');
});

test('weatherStatus asks for a town, then shows the reading, an error or that it is checking', () => {
  const now = 1000 * 60000;
  assert.deepEqual(T.weatherStatus({}, now), { text: 'Find your town to begin.', tone: '' });
  assert.deepEqual(T.weatherStatus({ place: {}, label: 'Leeds', summary: 'Rain', reading: { at: now - 120000 } }, now), { text: 'Rain in Leeds, checked 2 minutes ago.', tone: 'ok' });
  assert.deepEqual(T.weatherStatus({ place: {}, label: 'Leeds', error: 'no answer' }, now), { text: "Leeds: No answer. He'll try again shortly.", tone: '' });
  assert.equal(T.weatherStatus({ place: {}, label: 'Leeds' }, now).text, 'Checking the weather in Leeds…');
});
