// The Stream Deck keys (deck.js): the server the plugin listens to, its token,
// what each press does, and packing the plugin for Stream Deck to install
// (deck-pack.js). Kept out of main.js, which only wires it up.
const { app, safeStorage, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const deck = require('../deck');
const { pack, FOLDER, FILE_NAME } = require('../deck-pack');
const { deskOnlyReason } = require('../replies');

const PLUGIN_DIR = path.join(__dirname, '..', '..', 'streamdeck', FOLDER);

/** d: what main shares (main.js `shared`). */
function wireDeck(d) {
  const deckSettings = () => ({ enabled: !!d.config.get('streamDeck')?.enabled });

  // The plugin's way in. Made once and kept, encrypted by Windows like the
  // other secrets, so the keys still work after a restart. Without encryption
  // it lasts the run, and the keys need adding again next time.
  let token = null;
  function deckToken() {
    if (token) return token;
    const raw = d.config.get('streamDeckToken');
    if (raw && safeStorage.isEncryptionAvailable()) {
      try { token = safeStorage.decryptString(Buffer.from(raw, 'base64')); } catch { token = null; }
    }
    if (!token) {
      token = deck.newToken();
      if (safeStorage.isEncryptionAvailable()) d.config.set({ streamDeckToken: safeStorage.encryptString(token).toString('base64') });
    }
    return token;
  }

  // Waiting prompts, oldest first across every conversation. A session keeps its
  // own in arrival order; between conversations, this is the order they were
  // first seen here.
  const firstSeen = new Map();   // `${tabId}\n${requestId}` -> order
  let order = 0;
  function waitingPrompts() {
    if (!d.manager) return [];
    const out = [];
    const live = new Set();
    for (const [tabId, tab] of d.manager.tabs) {
      for (const item of tab.session.pending.values()) {
        const k = `${tabId}\n${item.requestId}`;
        live.add(k);
        if (!firstSeen.has(k)) firstSeen.set(k, order++);
        out.push({ ...item, tabId, order: firstSeen.get(k) });
      }
    }
    for (const k of [...firstSeen.keys()]) if (!live.has(k)) firstSeen.delete(k);
    return out.sort((a, b) => a.order - b.order);
  }

  const deckKeys = () => deck.keys({ prompts: waitingPrompts(), tabs: d.manager?.summary || [], shown: d.deckShown });

  // Every tab change reaches here; the keys only go out when they look different.
  let lastSent = '';
  function pushDeck() {
    if (!d.deck || d.deck.status !== 'listening' || !d.deck.connected) return;
    const keys = deckKeys();
    const said = JSON.stringify(keys);
    if (said === lastSent) return;
    lastSent = said;
    d.deck.broadcast(keys);
  }

  /** The panel shows this conversation now: Stop and Bring it home follow it. */
  function deckShownTab(tabId) {
    if (d.deckShown === tabId) return;
    d.deckShown = tabId;
    pushDeck();
  }

  async function onDeckPress(action, ref) {
    const r = deck.resolvePress(action, ref, deckKeys());
    if (r.error) return { ok: false, error: r.error };
    if (r.do === 'answer') {
      const pending = d.manager.tabs.get(r.tabId)?.session.pending.get(r.requestId);
      // Belt and braces, as for the phone: nothing the card would have warned about.
      if (!pending || deskOnlyReason(pending)) return { ok: false, error: 'changed' };
      d.log.info(`deck: ${r.decision} for ${pending.toolName}`);
      return { ok: !!d.answerPermission(r.tabId, r.requestId, r.decision, { via: 'deck' }) };
    }
    if (r.do === 'stop') {
      if (!d.manager.isBusy(r.tabId)) return { ok: false, error: 'changed' };
      d.manager.interrupt(r.tabId);
      return { ok: true };
    }
    // The rest happen in the panel, where their answers (red checks, a clash)
    // can be read and acted on.
    d.showPanel({ focusInput: false, tabId: r.tabId || null });
    if (r.do === 'home') d.send(d.panel, 'deck:press', { what: 'home', tabId: r.tabId });
    if (r.do === 'review') d.send(d.panel, 'deck:press', { what: 'review' });
    return { ok: true };
  }

  function createDeck() {
    d.deck = new deck.DeckServer({ token: deckToken(), getKeys: deckKeys, onPress: onDeckPress });
    d.deck.on('status', () => {
      lastSent = '';
      pushDeck();
      d.send(d.panel, 'deck', deckView());
    });
    d.manager.on('tabs', pushDeck);
    if (deckSettings().enabled) d.deck.start();
  }

  const streamDeckInstalled = () => [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Elgato', 'StreamDeck', 'StreamDeck.exe'),
    path.join(process.env.APPDATA || '', 'Elgato', 'StreamDeck'),
  ].some(p => p && fs.existsSync(p));

  const deckView = () => ({
    ...deckSettings(),
    ...(d.deck ? d.deck.view() : { status: 'off', port: deck.DEFAULT_PORT, connected: 0 }),
    installed: streamDeckInstalled(),
    added: !!d.config.get('streamDeckAdded'),
  });

  function setDeck(patch) {
    const next = { ...deckSettings() };
    if (patch && 'enabled' in patch) next.enabled = !!patch.enabled;
    d.config.set({ streamDeck: next });
    if (next.enabled) d.deck.start(); else d.deck.stop();
    return deckView();
  }

  /**
   * Pack the plugin with this PC's port and token, and open it: Stream Deck's
   * installer takes it from there (and asks first). Turns the keys on.
   */
  async function addToStreamDeck() {
    if (!streamDeckInstalled()) return { ...deckView(), error: "Stream Deck isn't on this PC yet." };
    if (!deckSettings().enabled) setDeck({ enabled: true });
    const bytes = pack({ srcDir: PLUGIN_DIR, icon: d.ICON, pair: { port: d.deck.port, token: deckToken() } });
    const file = path.join(app.getPath('userData'), 'streamdeck', FILE_NAME);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
    } catch (err) {
      d.log.warn('deck: could not write the plugin', err.message);
      return { ...deckView(), error: "Couldn't write the plugin file." };
    }
    const failed = await shell.openPath(file);
    if (failed) { d.log.warn('deck: Stream Deck did not take the plugin', failed); return { ...deckView(), error: failed }; }
    d.config.set({ streamDeckAdded: true });
    return deckView();
  }

  return { addToStreamDeck, createDeck, deckKeys, deckShownTab, deckView, onDeckPress, pushDeck, setDeck };
}

module.exports = { wireDeck, PLUGIN_DIR };
