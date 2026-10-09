// Learning from corrections (corrections.js spots them, learned-rules.js
// writes them): the corrections noted as they happen, the card offered in the
// conversation once one comes up twice, and the rules it added, for the
// Toolbox to list. Kept out of main.js, which only wires it up.
const os = require('os');
const path = require('path');
const corrections = require('../corrections');
const correctionDraft = require('../correction-draft');
const learnedRules = require('../learned-rules');
const denyRules = require('../deny-rules');
const gitinfo = require('../gitinfo');

const MAX_WAITING = 20;

/** d: what main shares (main.js `shared`). */
function wireCorrections(d) {
  // tabId -> cards found while that tab was working: shown once it stops
  // (finished, stopped or failed), so they don't land in the middle of Claude's steps.
  const waiting = new Map();
  let drafting = false;

  const store = () => d.config.get('corrections');
  const save = s => d.config.set({ corrections: s });
  const home = path.resolve(os.homedir()).toLowerCase();

  // The project a tab works on: the repository (a copy resolves to the one it
  // was made from), or the folder itself when it isn't one. Never the home folder.
  async function projectOf(dir) {
    if (!d.isStr(dir) || path.resolve(dir).toLowerCase() === home) return null;
    const p = await gitinfo.projectOf(dir).catch(() => null);
    return p ? { root: p.root, name: p.name } : { root: path.resolve(dir), name: path.basename(dir) };
  }

  const cardOf = o => ({ kind: 'lesson', id: o.id, project: o.project, type: o.type, headline: o.headline, rule: o.rule });

  function offer(tabId, o) {
    const tab = d.manager.tabs.get(tabId);
    if (!tab) return;
    if (tab.session.busy) {
      waiting.set(tabId, [...(waiting.get(tabId) || []), o].slice(-MAX_WAITING));
      return;
    }
    d.manager.note(tabId, cardOf(o));
    d.stat('lesson-offered');
  }

  /**
   * One correction in a tab: { kind, text?, files?, refs?, batch?, toolName?, input? }.
   * Routines and workflows run without you, so what happens there isn't you correcting Claude.
   */
  async function noteCorrection(tabId, event) {
    try {
      const tab = d.isStr(tabId) ? d.manager.tabs.get(tabId) : null;
      if (!tab || tab.routineId || tab.workflowRunId || d.CAPTURE || !event) return null;
      const dir = tab.session.cwd;
      const project = await projectOf(dir);
      if (!project) return null;
      let e = { ...event, root: project.root, project: project.name };
      if (event.kind === 'deny') {
        // Paths in the request are in the tab's own folder, which may be a copy.
        const here = (await gitinfo.repoOf(dir).catch(() => null))?.root || dir;
        // One turn is one occasion: Claude asking twice in a row, and two nos, is still one correction.
        const batch = tab.turnId ? `${tab.id}:${tab.turnId}` : undefined;
        e = { kind: 'deny', root: project.root, project: project.name, batch, ...corrections.denySubject(event.toolName, event.input, here) };
      }
      const r = corrections.record(store(), e, { id: d.randomUUID() });
      save(r.store);
      if (r.offer) offer(tabId, r.offer);
      return r.offer;
    } catch (err) {
      d.log.warn('corrections', err.message);
      return null;
    }
  }

  /**
   * An undo, rewind or retry as a correction, read from the tab's transcript
   * before it's cut: the files those turns changed and what you'd asked for.
   * afters: the turns' change ids; turnIds: your messages.
   */
  function correctionFromTurns(tabId, kind, { afters = [], turnIds = [] } = {}) {
    const items = d.history.load(tabId);
    const changed = items.filter(i => i.kind === 'changes' && (afters.includes(i.after) || (i.turnId && turnIds.includes(i.turnId))));
    const turns = new Set([...turnIds, ...changed.map(c => c.turnId).filter(Boolean)]);
    return {
      kind,
      files: changed.flatMap(c => (Array.isArray(c.files) ? c.files.map(f => f?.path).filter(d.isStr) : [])),
      refs: changed.map(c => c.after).filter(d.isStr),
      text: items.filter(i => i.kind === 'user' && turns.has(i.turnId) && d.isStr(i.text)).map(i => i.text).join(' / '),
    };
  }

  // Every tab that has stopped working gets its cards; a closed tab's are let go.
  function release() {
    for (const [tabId, list] of [...waiting]) {
      const tab = d.manager.tabs.get(tabId);
      if (tab?.session.busy) continue;
      waiting.delete(tabId);
      if (!tab) continue;
      // Answered somewhere else in the meantime (another tab's card for the same thing).
      for (const o of list) if (corrections.offerOf(store(), o.id)?.state === 'open') offer(tabId, o);
    }
  }

  function createCorrections() {
    // 'tabs' goes out whenever a tab starts or stops working, however its turn ended.
    d.manager.on('tabs', () => { if (waiting.size) release(); });
  }

  // ---- the card

  const shortFile = f => f.replace(os.homedir(), '~');

  function lessonState(id) {
    const o = corrections.offerOf(store(), id);
    return o ? { state: o.state, project: o.project } : null;
  }

  function lessonPreview(id, rule) {
    const o = corrections.offerOf(store(), id);
    if (!o) return { ok: false, error: 'Shellby has forgotten that one.' };
    const r = o.type === 'deny-rule' ? denyRules.preview(denyRules.fileFor(o.scope, o.root), rule) : learnedRules.preview(o.root, rule);
    return r.ok ? { ...r, where: shortFile(r.file) } : r;
  }

  function addLesson(id, rule, added) {
    const o = corrections.offerOf(store(), id);
    if (!o) return { ok: false, error: 'Shellby has forgotten that one.' };
    if (o.state !== 'open') return { ok: false, state: o.state, error: o.state === 'added' ? 'Already added.' : 'You said not this one.' };
    const r = o.type === 'deny-rule' ? denyRules.add(denyRules.fileFor(o.scope, o.root), rule, added) : learnedRules.add(o.root, rule, added);
    if (!r.ok) return r.preview ? { ...r, preview: { ...r.preview, where: shortFile(r.preview.file) } } : r;
    save(corrections.resolve(store(), id, 'added'));
    // He picked something up: the same little beat as a trick he taught himself.
    d.flashState('learned', 5000);
    d.stat('lesson-added');
    return { ok: true, where: shortFile(r.file), rule: r.rule };
  }

  function dismissLesson(id) {
    if (!corrections.offerOf(store(), id)) return { ok: false };
    save(corrections.resolve(store(), id, 'dismissed'));
    d.stat('lesson-dismissed');
    return { ok: true };
  }

  async function draftLesson(id) {
    const o = corrections.offerOf(store(), id);
    if (!o) return { ok: false, error: 'Shellby has forgotten that one.' };
    if (o.type === 'deny-rule') return { ok: false, error: 'A permission rule has its own form. Edit it by hand.' };
    if (d.config.get('crabOnly') || !d.claudeStatus?.installed || !d.claudeStatus?.loggedIn) return { ok: false, error: 'Wording it with Claude needs Claude Code set up and signed in, in Settings.' };
    if (drafting) return { ok: false, error: 'Claude is already wording one. Give it a moment.' };
    drafting = true;
    try {
      return await correctionDraft.askClaude(o, { runClaude: d.runClaudeOnce, log: d.log });
    } finally { drafting = false; }
  }

  // ---- Toolbox → Memory: what he's learned, per project

  // The projects listed: every one a card added a rule to, and the one Shellby's
  // folder is in if its CLAUDE.md has the section. The panel may only change these.
  async function learnedProjects() {
    const list = corrections.learnedRoots(store()).map(p => ({ root: p.root, name: p.project || path.basename(p.root) }));
    const here = await projectOf(d.currentCwd());
    const key = r => r.toLowerCase();
    if (here && !list.some(p => key(p.root) === key(here.root))) list.push({ root: here.root, name: here.name, current: true });
    else if (here) list.find(p => key(p.root) === key(here.root)).current = true;
    return list;
  }

  async function learnedView() {
    const out = [];
    for (const p of await learnedProjects()) {
      const r = learnedRules.list(p.root);
      if (!r.ok || (!r.rules.length && !p.current)) continue;
      out.push({ root: p.root, name: p.name, current: !!p.current, file: r.file, where: shortFile(r.file), rules: r.rules });
    }
    return out;
  }

  async function changeLearned({ root, index, was, text } = {}) {
    const known = (await learnedProjects()).find(p => d.isStr(root) && p.root === root);
    if (!known) return { ok: false, error: "Shellby doesn't edit that project's CLAUDE.md." };
    if (!d.isStr(was) || (text != null && typeof text !== 'string')) return { ok: false, error: 'Pick a rule first.' };
    const r = learnedRules.change(root, index, was, text);
    if (r.ok) d.stat(text == null ? 'lesson-removed' : 'lesson-edited');
    return { ...r, view: await learnedView() };
  }

  return {
    addLesson, changeLearned, correctionFromTurns, createCorrections, dismissLesson, draftLesson,
    learnedView, lessonPreview, lessonState, noteCorrection,
  };
}

module.exports = { wireCorrections };
