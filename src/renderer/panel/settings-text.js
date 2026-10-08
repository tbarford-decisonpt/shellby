// What the Settings screen says (settings.js and the files beside it draw it):
// the shortcut recorder's accelerator, the billing guard, update lines for
// Shellby and Claude Code, and the status line under each connection. Each
// status is { text, tone }, tone being 'ok', 'warn' or ''. Pure, no DOM. Works
// in the browser and in Node (for tests).
(function (root) {
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const capital = s => `${s[0].toUpperCase()}${s.slice(1)}`;

  // ------------------------------------------------------------ the shortcut recorder

  const MODIFIER_KEYS = ['Control', 'Alt', 'Shift', 'Meta'];

  // A key press while recording: { accel } to save ('' clears it), { error } to
  // say what's wrong, or null to keep waiting (a modifier on its own).
  function accelerator(e) {
    if (e.key === 'Backspace') return { accel: '' };
    if (MODIFIER_KEYS.includes(e.key)) return null;
    const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
    if (!mods.length) return { error: 'Add at least one modifier key.' };
    const key = e.code === 'Space' ? 'Space' : /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : /^F\d{1,2}$/.test(e.key) ? e.key : null;
    if (!key) return { error: 'Use a letter, number, F-key or Space.' };
    return { accel: [...mods, key].join('+') };
  }

  // ------------------------------------------------------------ Claude Code's account

  // Off with an API key or provider set on this PC means per-token billing,
  // so that case gets the loudest look (see .billing-guard in panel.css).
  const BILLING_GUARD = {
    safe: { title: 'Billing: your Claude plan', pill: 'Protected' },
    off: { title: 'Billing: Claude Code decides', pill: 'Not protected' },
    risk: { title: 'Heads up: this may bill your API key', pill: 'Pay per token' },
  };
  const billingState = (planOnly, billingEnv) => (planOnly ? 'safe' : billingEnv.length ? 'risk' : 'off');

  // The line under who's signed in.
  function planLabel(st) {
    if (!st.loggedIn) return 'Sign in with your Claude account to give Shellby tasks.';
    return st.subscriptionType ? `${capital(st.subscriptionType)} plan` : st.authMethod || 'claude.ai';
  }

  // ------------------------------------------------------------ updates

  // Claude Code's update row in About. installed: the version found, or a guess.
  function claudeUpdateTitle(u, installed) {
    if (u.updating) return `Updating Claude Code v${installed || '?'}…`;
    return u.available ? `Claude Code v${u.latest} is out` : `Claude Code v${installed || '?'}`;
  }

  function claudeUpdateNote(u, installed, relTime) {
    if (u.error) return u.error;
    if (u.updating) return 'Claude Code is fetching it. Conversations already running keep the old one.';
    if (u.checking) return 'Asking the npm registry…';
    if (u.available) return `You have v${installed}. ${u.mode === 'auto' ? 'He updates it once nothing is running.' : 'Update takes a minute; new conversations get it.'}`;
    if (u.mode === 'off') return 'He never asks the registry. Update it yourself with claude update.';
    if (u.lastCheckAt) return `The latest, checked ${relTime(u.lastCheckAt)}. He looks once a day.`;
    return 'He looks once a day.';
  }

  // Shellby's own update, by the updater's state.
  const UPDATE_STATUS = {
    checking: () => 'Looking for a new version…',
    downloading: u => `Downloading ${u.version ? `v${u.version}` : 'the update'}…`,
    ready: u => `Version ${u.version} is downloaded and ready.`,
    current: (u, relTime) => `You're on the latest version${u.checkedAt ? `, checked ${relTime(u.checkedAt)}` : ''}.`,
    error: u => u.error || "Couldn't check for updates.",
    idle: () => 'Shellby updates himself from GitHub Releases.',
    off: () => 'Updates run in the installed app.',
    scoop: () => 'Scoop keeps Shellby up to date: run scoop update shellby.',
  };
  const UPDATE_BUTTON = { checking: () => 'Checking…', downloading: u => `${u.percent}%`, ready: () => 'Restart and update' };
  const updateStatus = (u, relTime) => (UPDATE_STATUS[u.state] || UPDATE_STATUS.idle)(u, relTime);
  const updateButton = u => (UPDATE_BUTTON[u.state] || (() => 'Check for updates'))(u);

  // ------------------------------------------------------------ connections

  const SESSION_STATE = { working: 'working', asking: 'needs your OK', idle: 'idle' };
  const sessionState = s => (s.state === 'working' && s.tool ? `working · ${s.tool}` : SESSION_STATE[s.state] || s.state);

  // Claude Code sessions outside Shellby.
  function externalStatus(v) {
    const n = v.sessions?.length || 0;
    const text = !v.enabled ? 'Off. Turn it on to see your other Claude Code sessions here.'
      : v.status === 'listening' ? (n ? `${plural(n, 'session')} connected.` : 'Listening. Start Claude Code anywhere with the plugin installed and it shows up here.')
        : v.status === 'busy' ? `Another app is using port ${v.port}, so outside sessions can't reach Shellby.`
          : 'Not listening right now.';
    return { text, tone: v.enabled && v.status === 'listening' ? 'ok' : v.status === 'busy' ? 'warn' : '' };
  }

  // The shellby command on your PATH.
  function cliStatus(v) {
    const on = !!v.installed;
    const ready = on && v.listening;
    const text = !v.available ? 'Windows only for now.'
      : ready ? 'Ready. Open a new terminal and try: shellby do "tidy my Downloads"'
        : on ? 'Turn on "React to Claude Code sessions outside Shellby" above; the command talks to him through it.'
          : '';
    return { text, tone: ready ? 'ok' : '' };
  }

  // The OBS browser source.
  function obsStatus(v) {
    const viewers = v.viewers || 0;
    const text = v.status === 'listening'
      ? (viewers ? `${plural(viewers, 'source')} connected.` : 'Waiting for OBS to connect.')
      : v.status === 'busy' ? `Another app is using port ${v.port}.` : '';
    return { text, tone: v.status === 'listening' ? 'ok' : v.status === 'busy' ? 'warn' : '' };
  }

  // Desk lighting through OpenRGB: the step it's on, what went wrong, or what it found.
  const RGB_STEP = { installing: 'Installing OpenRGB… say yes if Windows asks.', starting: 'Starting OpenRGB…' };
  function rgbStatus(v) {
    const devices = v.devices || [];
    const busy = RGB_STEP[v.setup];
    const text = busy || (v.error ? v.error : devices.length ? `${plural(devices.length, 'device')}.` : '');
    return { text, tone: busy ? '' : v.error ? 'warn' : devices.length ? 'ok' : '' };
  }

  // On your Discord profile: showing, waiting for Discord, or turned down.
  function discordStatus(v) {
    if (!v.enabled) return { text: '', tone: '' };
    if (v.configured === false) return { text: "This build of Shellby has no Discord app set up.", tone: 'warn' };
    const text = v.status === 'on' ? (v.user ? `Showing on ${v.user}'s profile.` : 'Showing on your profile.')
      : v.status === 'refused' ? `Discord said no: ${v.error || 'no reason given'}`
        : v.status === 'looking' ? "Discord isn't open. He'll show up when it is."
          : 'Looking for Discord…';
    return { text, tone: v.status === 'on' ? 'ok' : v.status === 'refused' ? 'warn' : '' };
  }

  // What's playing, as Windows tells it.
  function nowPlayingStatus(v) {
    const t = v.track;
    const text = !v.available ? 'Windows only.'
      : v.status === 'unavailable' ? "Windows isn't answering about media here."
        : t ? `${t.playing ? '♪ ' : 'Paused: '}${[t.title, t.artist].filter(Boolean).join(' — ')}${t.app ? ` (${t.app})` : ''}`
          : 'Nothing playing.';
    return { text, tone: t?.playing ? 'ok' : '' };
  }

  function typingStatus(v) {
    const text = !v.available ? "Windows isn't letting him hear the keyboard here."
      : v.best ? `Your fastest burst so far: ${v.best} words a minute.` : 'Type fast for a few seconds and see what he thinks.';
    return { text, tone: v.available && v.best ? 'ok' : '' };
  }

  const minutesAgo = (at, now = Date.now()) => {
    const m = Math.round((now - at) / 60000);
    return m < 1 ? 'just now' : m === 1 ? 'a minute ago' : m < 90 ? `${m} minutes ago` : `${Math.round(m / 60)} hours ago`;
  };

  function weatherStatus(v, now = Date.now()) {
    if (!v.place) return { text: 'Find your town to begin.', tone: '' };
    if (v.reading) return { text: `${v.summary} in ${v.label}, checked ${minutesAgo(v.reading.at, now)}.`, tone: 'ok' };
    if (v.error) return { text: `${v.label}: ${capital(v.error)}. He'll try again shortly.`, tone: '' };
    return { text: `Checking the weather in ${v.label}…`, tone: '' };
  }

  const api = {
    accelerator, BILLING_GUARD, billingState, planLabel, claudeUpdateTitle, claudeUpdateNote, updateStatus, updateButton,
    sessionState, externalStatus, cliStatus, obsStatus, rgbStatus, discordStatus, nowPlayingStatus, typingStatus, minutesAgo, weatherStatus,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbySettingsText = api;
})(typeof window !== 'undefined' ? window : globalThis);
