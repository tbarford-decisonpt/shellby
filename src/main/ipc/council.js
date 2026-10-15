// The Council screen (council/*.js): convene it, read back old sessions, say
// how a verdict went, turn one into a plan or a note, and change who sits at
// the table. One council at a time; the read, the seating and each seat's
// progress are pushed to the panel as 'council:progress' so the chamber can
// light them up.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const P = require('../council/prompts');
const { convene, SEAT_MODEL } = require('../council/run');
const { estimate } = require('../council/cost');
const { gather } = require('../council/context');
const { LOOK_BUDGET_USD } = require('../council/look');
const { CouncilStore, summary, records, cleanOutcome } = require('../council/store');
const { run: runCli, skipSettings, signInWithoutSettings } = require('../claude/cli');

const GIT_TIMEOUT_MS = 5000;

function git(cwd, args) {
  return new Promise(resolve => {
    // The project may be someone else's clone: none of its config gets to run anything.
    execFile('git', ['-C', cwd, '-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=NUL', ...args], {
      windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 256 * 1024, encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout) => resolve({ ok: !err, stdout: err ? '' : stdout }));
  });
}

// The start of a project file: never a link (a clone's README could point at a
// secret elsewhere), and never more than READ_BYTES of it.
const READ_BYTES = 8 * 1024;
function readHead(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error('not a plain file');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(READ_BYTES);
    return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, READ_BYTES, 0));
  } finally { fs.closeSync(fd); }
}

const sameDir = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/**
 * @param {Pick<import('electron').IpcMain, 'handle' | 'on'>} ipcMain  main's, behind ipc-guard.js
 * @param d  what main shares with its IPC (main.js ipcDeps)
 */
function registerCouncilIpc(ipcMain, d) {
  const store = new CouncilStore({ dir: app.getPath('userData') });
  const settings = () => P.normalize(d.config.get('council'));
  // The folder a sitting would read: the one you're working in, unless that's your home
  // folder, a folder above it, or a whole drive.
  const projectRoot = () => {
    const cwd = d.currentCwd?.();
    if (!d.isStr(cwd) || !path.isAbsolute(cwd)) return '';
    const abs = path.resolve(cwd), home = path.resolve(os.homedir());
    const above = path.relative(abs, home);
    if (sameDir(abs, path.parse(abs).root) || sameDir(abs, home) || (above && !above.startsWith('..') && !path.isAbsolute(above))) return '';
    return cwd;
  };
  // Why the project can't be read, or '': the read is kept in the folder by --restricted,
  // which an older Claude Code doesn't have, and which ignores settings files you sign in through.
  const readBlocked = () => {
    if (!d.claudeSupports('--restricted')) return 'This Claude Code can’t read a project safely yet. Update it to use this.';
    if (!d.FAKE_CLI && !signInWithoutSettings(os.homedir())) return 'You sign in to Claude Code (or reach it) through its settings file, which a read that can only read has to ignore.';
    return '';
  };
  // The folder a session's plan or note belongs to: the one it read, while it's there.
  const sessionDir = s => (d.isStr(s.root) && fs.existsSync(s.root) ? s.root : d.currentCwd?.() || os.homedir());
  const view = () => {
    const root = projectRoot();
    const s = settings();
    return {
      settings: s, estimate: estimateOf(s, !!root && !readBlocked()), roster: P.ROSTER, defaults: P.DEFAULT_IDS, records: records(store.list()),
      project: root ? { name: path.basename(root), root, blocked: readBlocked() } : null,
      limits: {
        custom: P.MAX_CUSTOM, seated: P.MAX_SEATED, min: P.MIN_SEATED, pickMin: P.MIN_PICK, pickMax: P.MAX_PICK,
        question: P.MAX_QUESTION, budget: LOOK_BUDGET_USD,
      },
    };
  };
  let sitting = false;
  // What a sitting costs counts towards your usage meters, as the Council, for the project it read.
  const recordSpend = (out, root) => {
    if (!out?.weight) return;
    const { project, pk } = root ? d.usageService?.projectKeyOf?.(root) || {} : {};
    d.usageService?.recordSpend?.({ key: 'c:council', kind: 'council', label: 'Council', project, pk }, out.weight);
  };

  ipcMain.handle('council:view', () => view());
  ipcMain.handle('council:save', (_e, raw) => {
    d.config.set({ council: P.normalize(raw) });
    return view();
  });
  ipcMain.handle('council:history', () => store.list().map(summary));
  ipcMain.handle('council:get', (_e, id) => (d.isStr(id) ? store.get(id) : null));
  ipcMain.handle('council:forget', (_e, id) => (d.isStr(id) ? store.remove(id).map(summary) : store.list().map(summary)));

  ipcMain.handle('council:convene', async (_e, req) => {
    const r = req && typeof req === 'object' ? req : {};
    if (d.config.get('crabOnly')) return { ok: false, error: 'The Council needs Claude Code. Turn it on in Settings.' };
    if (sitting) return { ok: false, error: 'The council is already sitting. Wait for its verdict.' };
    const exe = d.FAKE_CLI ? process.env.SHELLBY_NODE || 'node' : d.claudeExe();
    if (!exe) return { ok: false, error: "Claude Code isn't installed. Set it up in Settings." };
    const prefix = d.FAKE_CLI ? [d.FAKE_CLI] : [];
    const s = { ...settings(), ...(P.MODES.includes(r.mode) ? { mode: r.mode } : {}), ...(typeof r.read === 'boolean' ? { read: r.read } : {}) };
    const prior = d.isStr(r.followUp) ? store.get(r.followUp) : null;
    // A follow-up reads the project its sitting read, wherever you're working now.
    const root = !s.read ? '' : d.isStr(prior?.root) && fs.existsSync(prior.root) ? prior.root : projectRoot();
    // When it can't be read safely, the council still gets the few KB Shellby reads itself.
    const blocked = root ? readBlocked() : '';
    const progress = ev => { try { d.send(d.panel, 'council:progress', ev); } catch { /* the panel closed mid-sitting */ } };
    sitting = true;
    let out, context;
    try {
      context = root ? await gather(root, { read: readHead, git: a => git(root, a) }) : '';
      out = await convene({
        question: r.question, settings: s, context, cwd: os.homedir(), root: blocked ? '' : root, lean: skipSettings(os.homedir()),
        prior: priorNote(prior), records: records(store.list()),
      }, (args, timeout, opts) => runCli(exe, [...prefix, ...args], timeout, opts),
      progress);
    } catch (e) {
      d.log.warn(`council: ${e?.message || e}`);
      return { ok: false, error: "The council couldn't sit. Try again." };
    } finally { sitting = false; }
    if (out.detail) d.log.warn(`council: ${out.detail}`);
    recordSpend(out, root);
    if (!out.ok) return { ok: false, error: out.error };
    const session = {
      id: d.randomUUID(), at: Date.now(), question: P.cleanQuestion(r.question),
      project: root ? path.basename(root) : '', root,
      followUp: prior?.id || null, ...out, ...(blocked ? { readError: blocked } : {}), detail: undefined,
    };
    store.add(session);
    d.questDone?.('council');
    return { ok: true, session, records: records(store.list()) };
  });

  // How a verdict went: followed and it worked, followed and it didn't, or not followed.
  // What you say builds each advisor's record, which the chair weighs next time.
  ipcMain.handle('council:outcome', (_e, req) => {
    const r = req && typeof req === 'object' ? req : {};
    if (!d.isStr(r.id)) return { ok: false, error: 'That session has gone.' };
    const session = store.update(r.id, { outcome: cleanOutcome(r.result, Date.now()) });
    if (!session) return { ok: false, error: 'That session has gone.' };
    return { ok: true, session, records: records(store.list()) };
  });

  // Plan the next steps: a new conversation in plan mode, in the project the
  // council read. The verdict could carry words from files the read saw, so it
  // opens as a draft: nothing is sent until you press send.
  ipcMain.handle('council:plan', (_e, id) => {
    const s = d.isStr(id) ? store.get(id) : null;
    if (!s?.chair) return { ok: false, error: 'That verdict has gone.' };
    const r = d.startDraft(sessionDir(s), `Council: ${s.question}`.slice(0, 80), planPrompt(s), { mode: 'plan' });
    if (!r.ok) return r;
    d.manager.modeToStart(r.tabId);
    d.showPanel({ focusInput: false, tabId: r.tabId });
    return r;
  });

  // The verdict and its next steps on the Notes list of the project it was about (else General).
  ipcMain.handle('council:note', (_e, id) => {
    const s = d.isStr(id) ? store.get(id) : null;
    if (!s?.chair) return { ok: false, error: 'That verdict has gone.' };
    return d.addNoteFrom(sessionDir(s), noteText(s));
  });
}

/** What the next sitting should cost, in dollars: { low, high }. canRead: the project can be read. */
function estimateOf(s, canRead) {
  return estimate({
    mode: s.mode, model: s.model, seatModel: SEAT_MODEL[s.model],
    seats: s.pick ? [P.MIN_PICK, P.MAX_PICK] : s.seated.length,
    read: canRead && s.read, pick: s.pick,
  });
}

const DECISION_WORD = { do: 'Do it', dont: "Don't", first: 'Do this first' };
const decided = c => (c.decision ? `${DECISION_WORD[c.decision]}. ` : '');
const bullets = items => items.map(x => `- ${x}`).join('\n');
const factList = facts => bullets(facts.map((f, i) => `[F${i + 1}] ${f.claim} (${f.file}${f.line ? `:${f.line}` : ''})`));

/** What a follow-up tells the council about the last sitting, its open questions included. */
function priorNote(prior) {
  if (!prior?.chair) return '';
  const open = prior.chair.open?.length ? ` Still open: ${prior.chair.open.join('; ')}` : '';
  return `${prior.question} -> ${prior.chair.verdict}${open}`;
}

/** The prompt Plan the next steps opens with. */
function planPrompt(s) {
  const c = s.chair;
  return [
    `A council of advisors looked at this question: "${s.question}"`,
    `Their decision: ${decided(c)}${c.verdict}`,
    c.against ? `The strongest case against: ${c.against}` : '',
    c.next.length ? `Next steps:\n${bullets(c.next)}` : '',
    s.facts?.length ? `Facts they relied on:\n${factList(s.facts)}` : '',
    c.open?.length ? `Still open:\n${bullets(c.open)}` : '',
    "Make a plan for the next steps. First check those facts against the code and answer what is still open from it, and say if anything you find changes the decision. Don't change anything until I approve the plan.",
  ].filter(Boolean).join('\n\n');
}

/** A note's text: the decision on its first line, the next steps under it. */
function noteText(s) {
  const c = s.chair;
  const head = `Council on "${s.question.slice(0, 120)}": ${decided(c)}${c.verdict}`;
  return c.next.length ? `${head}\n${bullets(c.next)}` : head;
}

module.exports = { registerCouncilIpc, planPrompt, noteText, priorNote, estimateOf };
