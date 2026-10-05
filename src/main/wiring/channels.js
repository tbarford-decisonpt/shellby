// Telling you when you're not at the PC (channels.js: your phone, with Allow
// and Deny for permission prompts), and the stream overlay (obs.js).
// Kept out of main.js, which only wires it up.
const crypto = require('crypto');
const { safeStorage } = require('electron');
const path = require('path');
const channels = require('../channels');
const confirm = require('../confirm');
const focus = require('../focus');
const { ObsServer } = require('../obs');
const { qrRows } = require('../qr');
const { RemoteAnswers, deskOnlyReason } = require('../replies');

/** d: what main shares (main.js `shared`). */
function wireChannels(d) {
  // ---- telling you elsewhere

  const channelSettings = () => channels.normalizeChannelSettings(d.config.get('channels'));

  // Where things go, as one string: the place, whether it may answer, and which
  // token (hashed) sends them. Nothing goes out unless you said yes to exactly
  // this in the confirmation window, so a panel that changes any part of it
  // (another topic, a bot of someone else's, replies on) can't quietly get your
  // permission prompts, let alone answer them.
  function channelPlace(s = channelSettings(), secret = d.channelSecret) {
    const key = secret ? crypto.createHash('sha256').update(secret).digest('hex').slice(0, 16) : '';
    return `${s.provider}|${s.target}|${s.replies ? 'replies' : 'tell'}|${key}`;
  }
  const channelConfirmed = (s = channelSettings()) => d.config.get('channelsConfirmed') === channelPlace(s);

  /**
   * After any change: a destination you haven't confirmed is asked about, or
   * switched off. testing: asked for the Test button, which works while it's off
   * (a no then leaves it as it was). Resolves whether it's confirmed now.
   */
  async function confirmChannelPlace({ testing = false } = {}) {
    const s = channelSettings();
    if ((!s.enabled && !testing) || !s.target || channelConfirmed(s)) return channelConfirmed(s);
    // From here on the startup grandfathering (0.46.1) never applies: a question
    // left open when Shellby quit must not count as a yes next time.
    if (d.config.get('channelsConfirmed') == null) d.config.set({ channelsConfirmed: '' });
    const label = channels.PROVIDERS[s.provider]?.label || s.provider;
    const response = await confirm.ask(d.panel, {
      ...d.dialogLook(), icon: '📱', danger: s.replies,
      title: 'Send notifications here?',
      message: `${label}: ${s.target}`.slice(0, 200),
      detail: s.replies
        ? 'Shellby will send what he is doing there, including his permission prompts, and take Allow or Deny answers back from it.'
        : 'Shellby will send what he is doing there, including what his permission prompts ask.',
      note: 'Only say yes if you set this up yourself.',
      buttons: [{ label: 'Send them there', ...(s.replies ? { style: 'danger' } : {}) }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
    });
    if (response === 0) { d.config.set({ channelsConfirmed: channelPlace(s) }); return true; }
    if (!testing) d.config.set({ channels: { ...s, enabled: false } });
    return false;
  }

  function loadChannelSecret() {
    const raw = d.config.get('channelSecret');
    if (!raw || !safeStorage.isEncryptionAvailable()) return '';
    try { return safeStorage.decryptString(Buffer.from(raw, 'base64')); } catch { return ''; }
  }

  function saveChannelSecret(secret) {
    if (!secret) { d.config.set({ channelSecret: null }); d.channelSecret = ''; return; }
    d.channelSecret = secret;
    // Encrypted by Windows, exactly like the GitHub token: never in settings.json
    // in the clear.
    if (safeStorage.isEncryptionAvailable()) d.config.set({ channelSecret: safeStorage.encryptString(secret).toString('base64') });
  }

  /**
   * Send one event, if the user asked for that kind. Never throws, never waits.
   * onSent(result, message) hears how it went, when it went at all.
   * always: about a task the phone started (channels.shouldSend).
   */
  function tellChannel(event, onSent = () => {}, { always = false } = {}) {
    if (!d.config) return false;
    const settings = channelSettings();
    if (!channels.shouldSend(event, settings, { focused: focus.guarding(d.config.get('focus'), Date.now()), always })) return false;
    if (!channelConfirmed(settings)) { d.log.info('channel: destination not confirmed, nothing sent'); return false; }
    const built = channels.buildRequest(settings, d.channelSecret, event);
    if (built.error) { d.log.info(`channel: ${built.error}`); return false; }
    channels.deliver(built.request)
      .then(r => { if (!r.ok) d.log.info(`channel: ${r.error}`); onSent(r, built.message); })
      .catch(() => onSent({ ok: false }, built.message));
    return true;
  }

  // A permission prompt goes to the phone, with Allow / Deny on it when you've
  // said it may and the prompt is one the phone is allowed to answer (replies.js).
  function askOnPhone(tabId, item, tab) {
    const event = { kind: 'asking', project: tab.title, message: `${item.label || ''} ${item.detail || ''}`.trim() };
    // A task the phone started always asks there: it's where you are.
    const opts = { always: !!tab.fromPhone };
    const settings = channelSettings();
    if (!settings.replies || channels.replyProblem(settings, { hasSecret: !!d.channelSecret })) return tellChannel(event, undefined, opts);
    const deskOnly = deskOnlyReason(item);
    if (deskOnly) return tellChannel({ ...event, deskOnly }, undefined, opts);
    const nonce = d.remote.register({ tabId, requestId: item.requestId, provider: settings.provider });
    const went = tellChannel({ ...event, reply: { nonce } }, (r, m) => {
      if (r.ok) d.remote.sent(nonce, { data: r.data, text: `${m.emoji} ${m.title}\n${m.body}` });
      else d.remote.forget(nonce);
    }, opts);
    if (!went) d.remote.forget(nonce);
    return went;
  }

  // The one way a permission prompt gets answered, from the card or the phone.
  function answerPermission(tabId, requestId, decision, { message, answers, via } = {}) {
    const pending = d.manager.tabs.get(tabId)?.session.pending.get(requestId);
    if (pending) {
      d.stat('permission-answered');
      if (decision !== 'deny' && pending.runsCreated?.length) d.stat('created-script-approved');
      if (decision !== 'deny' && pending.toolName === 'ExitPlanMode') d.stat('plan-approved');
    }
    return d.manager.respond(tabId, requestId, decision, message, answers, via);
  }

  function createRemote() {
    d.remote = new RemoteAnswers({
      getChannel: () => ({ settings: channelSettings(), secret: d.channelSecret }),
      // Belt and braces: replies.js already refuses these, but the phone never
      // gets to answer anything the card would have warned about.
      onAnswer: (tabId, requestId, decision) => {
        const pending = d.manager.tabs.get(tabId)?.session.pending.get(requestId);
        if (!pending || deskOnlyReason(pending) || !['allow', 'deny'].includes(decision)) return false;
        d.log.info(`replies: ${decision} from the phone for ${pending.toolName}`);
        return answerPermission(tabId, requestId, decision, { via: 'phone' });
      },
      log: m => d.log.info(`replies: ${m}`),
    });
  }

  function channelsView() {
    const v = channels.view(channelSettings(), { hasSecret: !!d.channelSecret });
    return v.subscribeUrl ? { ...v, qr: qrRows(v.subscribeUrl) } : v;
  }

  // ---- on a stream

  function obsSettings() {
    const raw = d.config.get('obs');
    const port = Number(raw?.port);
    return { enabled: !!raw?.enabled, port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 47914 };
  }

  function createObs() {
    d.obsServer = new ObsServer({
      srcDir: path.join(__dirname, '..', '..'),
      assetsDir: path.join(d.ROOT, 'assets'),
      port: obsSettings().port,
      getState: obsState,
    });
    d.obsServer.on('status', v => d.send(d.panel, 'obs', { ...v, ...obsSettings() }));
    d.obsServer.on('viewers', () => d.send(d.panel, 'obs', obsView()));
    if (obsSettings().enabled) d.obsServer.start();
  }

  // What the browser source draws: the same skin, outfit and state the desktop
  // critter is given.
  function obsState() {
    if (!d.config) return null;
    const own = d.manager?.aggregate || { state: 'idle', busy: 0, crew: [] };
    const ext = d.external?.summary || { state: 'idle', busy: 0, crew: [] };
    return {
      skin: d.activeSkin(),
      outfit: d.outfit(),
      px: d.px(),
      state: d.lastStatus.state,
      busy: own.busy + ext.busy,
      crew: [...own.crew, ...ext.crew].slice(0, d.MAX_CREW_SHOWN),
      say: d.said,
    };
  }

  const obsView = () => ({ ...(d.obsServer ? d.obsServer.view() : { status: 'off', viewers: 0 }), ...obsSettings() });

  return {
    answerPermission, askOnPhone, channelConfirmed, channelPlace, channelSettings, channelsView, confirmChannelPlace,
    createObs, createRemote, loadChannelSecret, obsSettings, obsState, obsView, saveChannelSecret,
    tellChannel,
  };
}

module.exports = { wireChannels };
