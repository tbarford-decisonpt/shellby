// Starting a task from your phone (phone-tasks.js): what a message turns into,
// and the settings that let it. Off until you turn it on in the confirmation
// window, and only for the Telegram chat or ntfy topic you said yes to.
//
// Listening is replies.js's: one poller per bot reads both the Allow / Deny
// presses and these messages, and hands the messages here.
const { dialog, safeStorage } = require('electron');
const path = require('path');
const attach = require('../attachments');
const channels = require('../channels');
const confirm = require('../confirm');
const guard = require('../guard');
const pt = require('../phone-tasks');

const MAX_REMEMBERED = 200; // message ids already acted on, against a replay

/** d: what main shares (main.js `shared`). */
function wirePhoneTasks(d) {
  let passphrase = '';
  let starts = [];       // when phone tasks started, for the hourly cap
  let seen = [];         // when messages arrived, for the message cap
  let done = [];         // ids already handled
  let refused = 0;       // ntfy posts without the passphrase, since the last log line
  let chain = Promise.resolve();
  const mine = new Set(); // tabs the phone started

  function settings() {
    const r = d.config.get('phoneTasks') || {};
    return {
      enabled: r.enabled === true,
      folder: typeof r.folder === 'string' && path.isAbsolute(r.folder) && attach.isLocalPath(r.folder) ? r.folder : null,
      enabledAt: Number.isFinite(r.enabledAt) ? r.enabledAt : 0,
    };
  }
  const save = patch => d.config.set({ phoneTasks: { ...settings(), ...patch } });

  // ---- the passphrase (ntfy): encrypted by Windows, like the channel token

  function loadPassphrase() {
    const raw = d.config.get('phoneTasksSecret');
    passphrase = '';
    if (!raw || !safeStorage.isEncryptionAvailable()) return;
    try { passphrase = safeStorage.decryptString(Buffer.from(raw, 'base64')); } catch { passphrase = ''; }
    if (!pt.PASSPHRASE.test(passphrase)) passphrase = '';
  }

  function newPassphrase() {
    if (!safeStorage.isEncryptionAvailable()) return null;
    passphrase = pt.newPassphrase();
    d.config.set({ phoneTasksSecret: safeStorage.encryptString(passphrase).toString('base64') });
    return passphrase;
  }

  // ---- may it be on?

  const consentKey = () => pt.consentKey(d.channelSettings(), d.channelSecret);

  function problem() {
    const ch = d.channelSettings();
    const { folder } = settings();
    return pt.tasksProblem(ch, {
      hasSecret: !!d.channelSecret,
      confirmed: d.channelConfirmed(ch),
      hasFolder: !!folder && d.isFolder(folder),
      canEncrypt: safeStorage.isEncryptionAvailable(),
    });
  }

  /** On, for exactly the destination you said yes to, and nothing missing. */
  function active() {
    // Shellby on his way out (before-quit shuts the poller): nothing new starts.
    if (!d.config || d.remote?.closed || d.config.get('crabOnly')) return false;
    if (!settings().enabled || d.config.get('phoneTasksConfirmed') !== consentKey()) return false;
    if (problem()) return false;
    return d.channelSettings().provider !== 'ntfy' || !!passphrase;
  }

  /**
   * After the channel settings change: a different bot, chat or topic means
   * the yes no longer counts, so it goes off (and says so in Settings).
   */
  function refreshPhoneTasks() {
    const s = settings();
    if (s.enabled && d.config.get('phoneTasksConfirmed') !== consentKey()) {
      save({ enabled: false });
      d.config.set({ phoneTasksConfirmed: null, phoneTasksCursor: null });
      d.log.info('phone tasks: the destination changed, so they are off');
    }
    d.remote?.listen();
  }

  function phoneTasksView() {
    const s = settings();
    const ch = d.channelSettings();
    return {
      available: channels.REPLY_PROVIDERS.has(ch.provider),
      provider: ch.provider,
      on: active(),
      wanted: s.enabled,
      problem: problem(),
      folder: s.folder,
      folderName: s.folder ? path.basename(s.folder) : null,
      tasksTopic: ch.provider === 'ntfy' ? pt.ntfyTasksUrl(ch.target) : null,
      hasPassphrase: !!passphrase,
      perHour: pt.MAX_STARTS_PER_HOUR,
      atOnce: pt.MAX_OPEN,
    };
  }

  // ---- turning it on and off (the panel asks; the confirmation window decides)

  async function setPhoneTasks(patch = {}) {
    if (patch.enabled === false) {
      save({ enabled: false });
      d.config.set({ phoneTasksConfirmed: null, phoneTasksCursor: null });
      return phoneTasksView();
    }
    if (patch.newPassphrase === true) {
      if (d.channelSettings().provider !== 'ntfy') return { ...phoneTasksView(), error: 'Only ntfy uses a passphrase.' };
      // The panel only ever sees a passphrase after a yes in the isolated window,
      // so a compromised panel can't quietly read one while phone tasks are on.
      d.wake();
      const response = await confirm.ask(d.panel, {
        ...d.dialogLook(), icon: '📱',
        title: 'Make a new passphrase?',
        message: 'The old one stops working straight away.',
        detail: 'Shellby shows the new one once. Put it at the start of every post to your tasks topic.',
        buttons: [{ label: 'Make a new one' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
      });
      if (response !== 0) return { ...phoneTasksView(), cancelled: true };
      const fresh = newPassphrase();
      if (!fresh) return { ...phoneTasksView(), error: "Windows can't keep a passphrase safe on this PC." };
      return { ...phoneTasksView(), passphrase: fresh };
    }
    if (patch.enabled === true) return enable();
    return phoneTasksView();
  }

  async function enable() {
    const why = problem();
    if (why) return { ...phoneTasksView(), error: why };
    const key = consentKey();
    const ch = d.channelSettings();
    const ntfy = ch.provider === 'ntfy';
    const { folder } = settings();
    d.wake();
    const response = await confirm.ask(d.panel, {
      ...d.dialogLook(), icon: '📱', danger: true,
      title: 'Let your phone start tasks?',
      message: (ntfy ? `ntfy: posts to ${pt.ntfyTasksUrl(ch.target)} that start with your passphrase` : 'Telegram: messages you send the bot in your private chat with it').slice(0, 200),
      detail: [
        `Each message becomes a Claude Code task, in ${folder} or another of your projects you name. It's only ever the words of a task: never a ! command, a / command, a mode or a setting.`,
        'Every one runs in Ask first, whatever mode you use here: each edit and command comes to your phone, or to this PC, for Allow or Deny first.',
        ntfy
          ? 'Anyone who knows an ntfy topic can post to it and read what is posted there, so keep the topic and the passphrase to yourself.'
          : 'Anyone with your bot token could send tasks too, so keep it to yourself.',
        `At most ${pt.MAX_STARTS_PER_HOUR} an hour and ${pt.MAX_OPEN} at once.`,
      ].join('\n\n'),
      note: 'Only say yes if you set this up yourself.',
      buttons: [{ label: 'Let it start tasks', style: 'danger' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
    });
    if (response !== 0) return { ...phoneTasksView(), cancelled: true };
    // Changed while the window was open: the yes was for somewhere else.
    if (consentKey() !== key || problem()) return { ...phoneTasksView(), error: problem() || 'Where notifications go changed. Try again.' };
    let shown = null;
    if (ntfy && !passphrase) {
      shown = newPassphrase();
      if (!shown) return { ...phoneTasksView(), error: "Windows can't keep a passphrase safe on this PC." };
    }
    // From now: nothing sent before you said yes ever counts.
    save({ enabled: true, enabledAt: Date.now() });
    d.config.set({ phoneTasksConfirmed: key, phoneTasksCursor: null });
    d.log.info(`phone tasks: on (${ch.provider})`);
    d.remote?.listen();
    sayOnPhone(`Phone tasks are on. ${pt.helpReply({ provider: ch.provider, folderName: path.basename(folder) })}`);
    return { ...phoneTasksView(), passphrase: shown };
  }

  async function pickPhoneTasksFolder() {
    const r = await dialog.showOpenDialog(d.panel, { title: 'Where should tasks from your phone go?', defaultPath: settings().folder || d.currentCwd(), properties: ['openDirectory'] });
    const dir = r.canceled ? null : r.filePaths[0];
    if (!dir) return phoneTasksView();
    if (!attach.isLocalPath(dir) || !d.isFolder(dir)) return { ...phoneTasksView(), error: 'That needs to be a folder on this PC.' };
    save({ folder: dir });
    return phoneTasksView();
  }

  // ---- what arrives

  function inbox() {
    return {
      active,
      onTelegram: update => {
        const got = pt.parseTelegramMessage(update, d.channelSettings().target, { since: settings().enabledAt, now: Date.now() });
        if (got?.late) tooLate(got);
        else if (got) take(got.messageId != null ? `tg:${got.messageId}` : null, got.text);
      },
      ntfyUrl: () => pt.ntfyTasksUrl(d.channelSettings().target),
      ntfySince: () => d.config.get('phoneTasksCursor') || String(Math.floor(settings().enabledAt / 1000)),
      onNtfy: msg => {
        const got = pt.parseNtfyTask(msg, passphrase, { since: settings().enabledAt, now: Date.now() });
        if (!got) return;
        if (got.refused) {
          // Never answered: a reply would tell whoever it is the topic is live.
          if (refused++ % 20 === 0) d.log.warn('phone tasks: an ntfy post without the passphrase was ignored');
          return;
        }
        take(got.id ? `ntfy:${got.id}` : null, got.text);
      },
      onNtfyCursor: id => { if (d.config.get('phoneTasksCursor') !== id) d.config.set({ phoneTasksCursor: id }); },
    };
  }

  // One at a time, in the order they came: the caps count what's already started.
  function take(id, text) {
    if (id) {
      if (done.includes(id)) return;
      done = [...done, id].slice(-MAX_REMEMBERED);
    }
    const now = Date.now();
    if (!pt.messageGate(seen, now)) { d.log.warn('phone tasks: too many messages this hour, ignoring the rest'); return; }
    seen = [...pt.recent(seen, now), now];
    chain = chain.then(() => handle(text)).catch(err => d.log.warn('phone task failed', err.message));
  }

  // Sent while this PC was off or asleep: it doesn't start, but you hear why,
  // once. Only Telegram: it is your own private chat with the bot, where a
  // reply tells nobody else anything. ntfy stays silent.
  function tooLate(got) {
    const id = got.messageId != null ? `tg:${got.messageId}` : null;
    if (!id || done.includes(id)) return;
    done = [...done, id].slice(-MAX_REMEMBERED);
    const now = Date.now();
    if (!pt.messageGate(seen, now)) return;
    seen = [...pt.recent(seen, now), now];
    d.log.info(`phone tasks: a message ${got.minutes} minutes late was not started`);
    chain = chain.then(() => (active() ? sayOnPhone(pt.lateReply(got.minutes)) : null)).catch(err => d.log.warn('phone task failed', err.message));
  }

  function projects() {
    const out = new Map();
    const add = (dir, name) => {
      if (typeof dir !== 'string' || !path.isAbsolute(dir) || !attach.isLocalPath(dir)) return;
      const key = dir.toLowerCase();
      if (out.has(key) || !d.isFolder(dir)) return;
      out.set(key, { name: name || path.basename(dir), path: dir });
    };
    add(settings().folder);
    for (const p of d.knownProjects()) add(p.key, p.name);
    for (const dir of d.config.get('projects')?.added || []) add(dir);
    return [...out.values()].slice(0, 300);
  }

  function openCount() {
    for (const id of mine) {
      const tab = d.manager.tabs.get(id);
      if (!tab || (!d.manager.isBusy(id) && !tab.session.pending.size)) mine.delete(id);
    }
    return mine.size;
  }

  function statusNow() {
    const tabs = [...d.manager.tabs.values()].map(t => ({ title: t.title, busy: d.manager.isBusy(t.id), waiting: t.session.pending.size > 0 }));
    return pt.statusReply(tabs, { held: d.heldList().filter(h => h.kind === 'task').length });
  }

  async function handle(text) {
    if (!active()) return;
    const ch = d.channelSettings();
    const list = projects();
    const home = list[0];
    const cmd = pt.parseCommand(text, { projects: list });
    if (cmd.kind === 'help') return sayOnPhone(pt.helpReply({ provider: ch.provider, folderName: home?.name, projects: list }));
    if (cmd.kind === 'status') return sayOnPhone(statusNow());
    if (cmd.kind === 'reply') return sayOnPhone(cmd.reply);
    const project = cmd.project || home;
    if (!project) return sayOnPhone("The folder phone tasks go to isn't there any more. Pick it again in Settings.");
    const now = Date.now();
    const gate = pt.startGate({ starts, open: openCount(), now });
    if (!gate.ok) return sayOnPhone(gate.reply);
    starts = [...pt.recent(starts, now), now];
    if (holdIt(cmd.prompt, project)) return;
    await start(cmd.prompt, project);
  }

  // At the limit, or past the share of the window you keep for yourself: it
  // waits for the reset like a task you queued (spending guard, guard.js).
  function holdIt(prompt, project) {
    const w = d.usageService.limitWait();
    const usage = d.config.get('lastUsage');
    const saving = !w && guard.holdBeforeStart(guard.settingsOf(k => d.config.get(k)), usage, Date.now());
    if (!w && !saving) return false;
    const res = d.holdForReset({ kind: 'task', prompt, cwd: project.path, mode: pt.MODE, fromPhone: true });
    if (!res.ok) { sayOnPhone(`Couldn't queue it: ${res.error}`); return true; }
    d.sendOutlook();
    const why = w ? "You're at your usage limit" : `Your 5-hour window is at ${usage.fiveHour.pct}%, past what you keep for yourself`;
    sayOnPhone(`${why}, so it waits for the reset and starts at ${res.atText}, in ${project.name}.`);
    d.log.info('phone tasks: held for the reset', project.name);
    return true;
  }

  async function start(prompt, project) {
    const title = pt.titleFor(prompt);
    // Its own copy when it's a repository, so your checkout is untouched;
    // otherwise the folder itself. Ask first either way.
    if (!active()) return null;
    let r = await d.startTaskInCopy(project.path, title, () => prompt, { mode: pt.MODE });
    if (!r.ok && r.noCopy) r = d.startTask(prompt, title, { mode: pt.MODE, cwd: project.path });
    if (!r.ok) return sayOnPhone(`Couldn't start it: ${r.error || 'something went wrong'}`);
    adoptPhoneTab(r.tabId);
    d.log.info('phone tasks: started', project.name);
    return sayOnPhone(`On it: ${title.slice(pt.TITLE_PREFIX.length + 1)} in ${project.name}. He'll ask here before he changes anything.`);
  }

  // A tab the phone started, now or held for the reset (main.js releaseTask):
  // its prompts and its "done" go to the phone, and it counts towards the cap.
  function adoptPhoneTab(tabId) {
    const tab = d.manager.tabs.get(tabId);
    if (tab) tab.fromPhone = true;
    mine.add(tabId);
    d.manager.note(tabId, { kind: 'phone' });
    d.history.update(tabId, { fromPhone: true });
  }

  /** A few lines back to the phone, to the confirmed destination only. */
  function sayOnPhone(body) {
    const ch = d.channelSettings();
    if (!d.channelConfirmed(ch)) return null;
    const built = channels.buildRequest(ch, d.channelSecret, { kind: 'phone', title: 'Shellby', body });
    if (built.error) { d.log.info(`phone tasks: ${built.error}`); return null; }
    const place = d.channelPlace(ch);
    return channels.deliver(built.request).then(r => {
      if (!r.ok) d.log.info(`phone tasks: reply failed: ${r.error}`);
      d.noteDelivery?.(r, ch, place);
    });
  }

  function createPhoneTasks() {
    loadPassphrase();
    refreshPhoneTasks();
    d.remote.setInbox(inbox());
  }

  return { adoptPhoneTab, createPhoneTasks, phoneTasksView, pickPhoneTasksFolder, refreshPhoneTasks, setPhoneTasks };
}

module.exports = { wirePhoneTasks };
