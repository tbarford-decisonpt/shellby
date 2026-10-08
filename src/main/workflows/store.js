// Where workflow runs and secrets live on disk. Runs are one JSON file each
// under <userData>/workflows/runs, written atomically (temp file, then rename)
// and coalesced, since a busy run changes many times a second. Secrets are one
// blob encrypted with Windows' own store (safeStorage, passed in), the same way
// Shellby keeps the GitHub token; their values never leave the main process.
const fs = require('fs');
const path = require('path');
const { SECRET } = require('./schema');

const KEEP_PER_WORKFLOW = 30;
const KEEP_TOTAL = 500;
const WRITE_DELAY_MS = 250;
const MAX_SECRETS = 50;
const MAX_SECRET_VALUE = 8192;
const RUN_ID = /^run-[\w-]{1,64}$/;

/** The part of a run the lists show. */
function summary(rec) {
  if (!rec) return null;
  const steps = Object.values(rec.steps || {});
  return {
    id: rec.id, workflowId: rec.workflowId, workflowName: rec.workflowName,
    status: rec.status, startedAt: rec.startedAt, endedAt: rec.endedAt ?? null,
    trigger: { type: rec.trigger?.type || 'manual' }, error: rec.error ?? null,
    waiting: rec.waiting && rec.waiting.choices ? { key: rec.waiting.key, question: rec.waiting.question, choices: rec.waiting.choices, file: rec.waiting.file }
      : rec.waiting?.until ? { key: rec.waiting.key, until: rec.waiting.until }
        // A Claude step held up by a permission prompt in its tab.
        : rec.attention?.tabId ? { key: null, permission: true, tabId: rec.attention.tabId } : null,
    steps: steps.length, done: steps.filter(s => s.status === 'ok' || s.status === 'skipped').length,
    parentRunId: rec.parentRunId || null,
  };
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

class RunStore {
  constructor({ dir, log = () => {} }) {
    this.dir = dir;
    this.log = log;
    this.index = new Map();   // id -> summary
    this.records = new Map(); // id -> full record, for runs not yet finished (and recently read)
    this.pending = new Map(); // id -> timer
  }

  file(id) { return path.join(this.dir, `${id}.json`); }

  /** Read every run file once at startup. Broken files are set aside, not fatal. */
  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.json')) {
        if (name.endsWith('.tmp')) fs.rmSync(path.join(this.dir, name), { force: true });
        continue;
      }
      const id = name.slice(0, -5);
      if (!RUN_ID.test(id)) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(this.file(id), 'utf8'));
        if (rec?.id !== id) throw new Error('id mismatch');
        this.index.set(id, summary(rec));
        if (['running', 'waiting'].includes(rec.status)) this.records.set(id, rec);
      } catch (e) {
        this.log(`workflow run ${id} unreadable: ${e.message}`);
        try { fs.renameSync(this.file(id), `${this.file(id)}.broken`); } catch { /* leave it */ }
      }
    }
    return [...this.records.values()];
  }

  /** Keep the record in memory and write it soon. */
  save(rec) {
    this.records.set(rec.id, rec);
    this.index.set(rec.id, summary(rec));
    if (this.pending.has(rec.id)) return;
    const t = setTimeout(() => this.flushOne(rec.id), WRITE_DELAY_MS);
    t.unref?.();
    this.pending.set(rec.id, t);
  }

  flushOne(id) {
    clearTimeout(this.pending.get(id));
    this.pending.delete(id);
    const rec = this.records.get(id);
    if (!rec) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      writeAtomic(this.file(id), JSON.stringify(rec));
    } catch (e) {
      this.log(`workflow run ${id} not saved: ${e.message}`);
    }
    // Finished runs needn't stay in memory; get() reads them back on demand.
    if (!['running', 'waiting'].includes(rec.status)) this.records.delete(id);
  }

  flush() { for (const id of [...this.pending.keys()]) this.flushOne(id); }

  get(id) {
    if (typeof id !== 'string' || !RUN_ID.test(id)) return null;
    if (this.records.has(id)) return this.records.get(id);
    if (!this.index.has(id)) return null;
    try { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')); } catch { return null; }
  }

  /** Newest first, optionally for one workflow. */
  list(workflowId = null, limit = 50) {
    return [...this.index.values()]
      .filter(s => !workflowId || s.workflowId === workflowId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
  }

  last(workflowId) { return this.list(workflowId, 1)[0] || null; }

  /** Drop old finished runs: 30 per workflow, 500 in all. */
  prune() {
    const done = [...this.index.values()].filter(s => !['running', 'waiting'].includes(s.status)).sort((a, b) => b.startedAt - a.startedAt);
    const perWf = new Map();
    const drop = [];
    done.forEach((s, i) => {
      const n = (perWf.get(s.workflowId) || 0) + 1;
      perWf.set(s.workflowId, n);
      if (n > KEEP_PER_WORKFLOW || i >= KEEP_TOTAL) drop.push(s.id);
    });
    for (const id of drop) this.remove(id);
    return drop.length;
  }

  remove(id) {
    clearTimeout(this.pending.get(id));
    this.pending.delete(id);
    this.index.delete(id);
    this.records.delete(id);
    try { fs.rmSync(this.file(id), { force: true }); } catch { /* gone */ }
  }

  /** Every run of a workflow, e.g. when it's deleted. Ongoing ones are the caller's to stop first. */
  removeWorkflow(workflowId) {
    for (const s of this.list(workflowId, Infinity)) this.remove(s.id);
  }
}

class SecretStore {
  /** crypto: { available(), encrypt(text) -> Buffer, decrypt(Buffer) -> text } */
  constructor({ file, crypto, log = () => {} }) {
    Object.assign(this, { file, crypto, log });
    this.values = null;
  }

  read() {
    if (this.values) return this.values;
    this.values = {};
    try {
      if (fs.existsSync(this.file) && this.crypto.available()) {
        const parsed = JSON.parse(this.crypto.decrypt(fs.readFileSync(this.file)));
        for (const [k, v] of Object.entries(parsed || {})) if (SECRET.test(k) && typeof v === 'string') this.values[k] = v;
      }
    } catch (e) {
      this.log(`workflow secrets unreadable: ${e.message}`);
    }
    return this.values;
  }

  names() { return Object.keys(this.read()).sort(); }

  all() { return { ...this.read() }; }

  set(name, value) {
    if (typeof name !== 'string' || !SECRET.test(name)) return { ok: false, error: 'Names are capitals, digits and _ (like GITHUB_TOKEN).' };
    if (typeof value !== 'string' || !value || value.length > MAX_SECRET_VALUE) return { ok: false, error: 'The value is empty or too long.' };
    if (!this.crypto.available()) return { ok: false, error: "Windows' encrypted storage isn't available, so secrets can't be kept safely." };
    const next = { ...this.read(), [name]: value };
    if (Object.keys(next).length > MAX_SECRETS) return { ok: false, error: `At most ${MAX_SECRETS} secrets.` };
    return this.write(next);
  }

  delete(name) {
    const next = { ...this.read() };
    delete next[name];
    return this.write(next);
  }

  write(next) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeAtomic(this.file, this.crypto.encrypt(JSON.stringify(next)));
      this.values = next;
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `Couldn't save it: ${e.message}` };
    }
  }
}

module.exports = { RunStore, SecretStore, summary, RUN_ID, KEEP_PER_WORKFLOW, KEEP_TOTAL };
