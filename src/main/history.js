// Local conversation history: an index plus one JSONL transcript of UI items per
// conversation, in %APPDATA%/Shellby/sessions. Never leaves the machine.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// Items worth replaying later. Transient ones (thinking, usage, raw logs) are skipped.
const PERSISTED = new Set(['user', 'text', 'tool', 'tool_result', 'result', 'error', 'decision', 'permission', 'init']);

class History {
  constructor(dir) {
    this.dir = dir;
    this.indexFile = path.join(dir, 'index.json');
    fs.mkdirSync(dir, { recursive: true });
    try { this.index = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')); } catch { this.index = []; }
  }

  saveIndex() {
    fs.writeFileSync(this.indexFile, JSON.stringify(this.index, null, 2));
  }

  create({ title, cwd, mode }) {
    const now = Date.now();
    const entry = { id: randomUUID(), title: titleFrom(title), cwd, mode, claudeSessionId: null, createdAt: now, updatedAt: now };
    this.index.unshift(entry);
    this.index = this.index.slice(0, 200);
    this.saveIndex();
    return entry;
  }

  get(id) { return this.index.find(e => e.id === id) || null; }

  update(id, patch) {
    const e = this.get(id);
    if (!e) return;
    Object.assign(e, patch, { updatedAt: Date.now() });
    this.saveIndex();
  }

  append(id, item) {
    if (!PERSISTED.has(item.kind)) return;
    const rec = item.kind === 'permission' ? { ...item, input: undefined } : item;
    fs.appendFileSync(this.file(id), JSON.stringify({ t: Date.now(), ...rec }) + '\n');
  }

  load(id) {
    try {
      return fs.readFileSync(this.file(id), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    } catch { return []; }
  }

  remove(id) {
    this.index = this.index.filter(e => e.id !== id);
    this.saveIndex();
    fs.rm(this.file(id), { force: true }, () => {});
  }

  list() { return this.index; }

  file(id) {
    if (!/^[\w-]+$/.test(id)) throw new Error('bad session id');
    return path.join(this.dir, `${id}.jsonl`);
  }
}

function titleFrom(text) {
  const t = String(text || 'New task').replace(/\s+/g, ' ').trim();
  return t.length > 70 ? t.slice(0, 67) + '…' : t;
}

module.exports = { History, titleFrom };
