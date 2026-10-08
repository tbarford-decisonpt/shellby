// Fewer processes for the same work. Chromium runs its network service as a
// process of its own, about 50 MB resident while Shellby sits idle on the
// wallpaper all day, for the few requests he makes (GitHub, updates, the
// registry). Run inside main instead, it costs a few MB there. Measured with
// scripts/idle-cost.js --closed: 5 processes and ~537 MB, then 4 and ~485-513.
// SHELLBY_NETWORK_PROCESS=1 puts it back in its own process, to compare.
const SWITCHES = [
  ['enable-features', 'NetworkServiceInProcess2'],
];

/** Before the app is ready. -> true if the switches were added. */
function lighten(app, env = process.env) {
  if (env.SHELLBY_NETWORK_PROCESS === '1') return false;
  for (const sw of SWITCHES) app.commandLine.appendSwitch(...sw);
  return true;
}

module.exports = { SWITCHES, lighten };
