// The real effects behind a run's steps: Claude conversations, MCP tools,
// questions, messages and workflows run by other workflows. Mixed into
// WorkflowService (service.js); `this` is the service.
const path = require('path');
const { randomUUID } = require('crypto');
const fx = require('./effects');
const mcpServers = require('../mcpservers');
const mcpClient = require('../mcpclient');
const { clean } = require('./util');

class Steps {
  effectsFor(run) {
    const d = this.deps;
    return {
      claude: args => this.claudeStep(run, args),
      mcp: args => this.mcpStep(args),
      run: ({ command, env, cwd, timeoutMs, signal }) => d.runCommand(cwd || d.currentCwd(), command, { timeoutMs, signal, env, maxCommand: 12000 }),
      http: args => fx.http({ ...args, fetchImpl: d.fetchImpl || fetch, blockedPorts: [d.webhookPort()].filter(Boolean) }),
      ask: args => this.askStep(run, args),
      tell: args => this.tellStep(run, args),
      readFile: (p, signal) => fx.readFile(p, signal),
      writeFile: (p, content, opts) => fx.writeFile(p, content, { ...opts, forbidden: d.forbiddenDirs?.() || [] }),
      runWorkflow: args => this.childRun(run, args),
      copy: ({ repo, slug }) => (d.makeCopy ? d.makeCopy({ repo, slug }) : Promise.resolve({ ok: false, error: 'Copies need a repository cloned on this PC.' })),
      pullRequest: ({ folder, title, body, draft, workflow }) => (d.openPullRequest ? d.openPullRequest({ folder, title, body, draft, workflow }) : Promise.resolve({ ok: false, error: 'Pull requests need GitHub sign-in.' })),
      sleep: (ms, signal) => fx.sleep(ms, signal),
    };
  }

  async claudeStep(run, { prompt, followUp, tabId: replyTo, mode, model, cwd, fresh, label, workflow, signal, onTab, mcp = [], mcpOnly = false }) {
    const d = this.deps;
    if (!d.claudeReady()) throw new Error('Claude Code isn\'t set up and signed in. Set it up in Settings first.');
    const folder = cwd || d.currentCwd();
    // A follow-up ("you forgot the JSON") goes to the conversation that answered.
    if (followUp) {
      const own = replyTo && d.manager.tabs.get(replyTo);
      if (!own) throw new Error('Its conversation was closed before it finished.');
      return fx.claudeTurn(d.manager, own.id, prompt, { kind: 'user', text: prompt, title: `⚡ ${workflow}`, workflow: { runId: run.record.id, step: label } }, signal);
    }
    // The servers a step may use are fixed when its conversation starts, so a
    // step that wants different ones gets a conversation of its own.
    const tools = this.stepTools(mcp, mcpOnly, folder);
    // One conversation per run for each set of servers, unless a step wants a
    // fresh one or works in another folder.
    const sharedId = run.convos.get(tools.key);
    const shared = sharedId && d.manager.tabs.has(sharedId) ? d.manager.tabs.get(sharedId) : null;
    let tab = !fresh && shared && path.resolve(shared.session.cwd) === path.resolve(folder) ? shared : null;
    if (!tab) {
      this.makeRoom();
      const tabId = randomUUID();
      tab = d.openTab({ tabId, cwd: folder, mode, workflowRunId: run.record.id, title: `⚡ ${workflow}`, allowedTools: tools.allowedTools, mcpConfig: tools.mcpConfig });
      run.tabs.add(tabId);
      this.tabRuns.set(tabId, run.record.id);
      if (!fresh && !shared) run.convos.set(tools.key, tabId);
      d.toPanel('tab:opened', { tabId, entry: null, items: [], background: true });
    }
    onTab(tab.id);
    if (tab.session.mode !== mode) tab.session.setMode(mode);
    if (model && !tab.session.proc) tab.session.model = model;
    const userItem = { kind: 'user', text: prompt, title: `⚡ ${workflow}`, workflow: { runId: run.record.id, step: label } };
    return fx.claudeTurn(d.manager, tab.id, prompt, userItem, signal);
  }

  /**
   * A Claude step's MCP servers -> what its conversation starts with: the
   * rules that let Claude use them unasked, and with "only these", their
   * definitions alone. Throws when one of them can't be loaded on its own.
   */
  stepTools(mcp, mcpOnly, folder) {
    const key = JSON.stringify([mcp, !!mcpOnly]);
    if (!mcp.length) return { key, allowedTools: [], mcpConfig: null };
    let mcpConfig = null;
    if (mcpOnly) {
      const r = mcpServers.configFor(mcp, { home: this.deps.home, cwd: folder });
      if (!r.ok) throw new Error(r.error);
      mcpConfig = r.config;
    }
    return { key, allowedTools: mcpServers.allowRules(mcp), mcpConfig };
  }

  /** An "MCP tool" step: start the server, call the one tool, shut it down. */
  async mcpStep({ server, tool, args, cwd, timeoutMs, signal }) {
    const folder = cwd || this.deps.currentCwd();
    const r = mcpServers.resolveServer(server, { home: this.deps.home, cwd: folder });
    if (!r.ok) throw new Error(r.error);
    const call = this.deps.callMcpTool || mcpClient.callTool;
    return call(r.def, tool, args, { cwd: folder, timeoutMs, signal });
  }

  /** The servers a step could pick, for the editor. live: the Toolbox's list. */
  mcpServerList(cwd, live = this.deps.liveMcp?.() || []) {
    return mcpServers.listServers({ home: this.deps.home, cwd: cwd || this.deps.currentCwd(), live });
  }

  /**
   * A server's tools, for the editor's tool picker. Starts the server for a
   * moment; asking again while it's still answering waits for that answer.
   */
  mcpTools(server, cwd) {
    const folder = cwd || this.deps.currentCwd();
    const key = `${server}\n${path.resolve(folder).toLowerCase()}`;
    if (this.toolReads.has(key)) return this.toolReads.get(key);
    const read = (async () => {
      const r = mcpServers.resolveServer(server, { home: this.deps.home, cwd: folder });
      if (!r.ok) return { ok: false, error: r.error };
      try {
        const list = this.deps.listMcpTools ? this.deps.listMcpTools(r.def, { cwd: folder }) : mcpClient.listTools(r.def, { cwd: folder, timeoutMs: 60000 });
        return { ok: true, tools: await list };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    })().finally(() => this.toolReads.delete(key));
    this.toolReads.set(key, read);
    return read;
  }

  // A workflow needs a free conversation slot: the oldest idle tab a finished
  // run left behind makes way. Yours are never closed for it.
  makeRoom() {
    const m = this.deps.manager;
    if (m.tabs.size < this.deps.maxTabs) return;
    // An idle tab of a finished run first; then an idle extra one (a fresh
    // conversation) of a run still going, never the one it's sharing.
    const idle = id => this.tabRuns.has(id) && !m.isBusy(id) && !m.tabs.get(id)?.session.pending?.size;
    const shared = new Set([...this.active.values()].map(r => r.tabId).filter(Boolean));
    const spare = [...m.tabs.keys()].find(id => idle(id) && !this.active.has(this.tabRuns.get(id)))
      || [...m.tabs.keys()].find(id => idle(id) && !shared.has(id));
    if (!spare) throw new Error(`All ${this.deps.maxTabs} conversations are open. Close one so the workflow can start Claude.`);
    this.deps.closeTab(spare);
    this.tabRuns.delete(spare);
  }

  askStep(run, { key, question, choices, workflow, signal }) {
    const id = `${run.record.id}:${key}`;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(fx.abortError()); return; }
      this.asks.set(id, { resolve, choices });
      signal?.addEventListener('abort', () => { this.asks.delete(id); reject(fx.abortError()); }, { once: true });
      this.deps.notify(`${workflow} needs you`, question.slice(0, 200), () => this.deps.showWorkflows(run.record.id), { urgent: true, action: 'Answer' });
      this.deps.tellPhone({ kind: 'asking', project: workflow, message: question, deskOnly: 'Answer it on the Automate page.' });
      this.pushView();
    });
  }

  async tellStep(run, { to, title, text, path: file, workflow }) {
    const d = this.deps;
    if (to === 'notification') d.notify(title.slice(0, 80), text.slice(0, 250), () => d.showWorkflows(run.record.id));
    else if (to === 'phone') d.tellPhone({ kind: 'workflow', project: workflow, title, body: text });
    else if (to === 'crab') d.say(clean(text).slice(0, 140));
    else if (to === 'file') await fx.writeFile(file, `${text}\n`, { append: true, forbidden: d.forbiddenDirs?.() || [] });
  }

  async childRun(parent, { name, inputs, depth, signal }) {
    const wf = this.byName(name);
    if (!wf) throw new Error(`There's no workflow called “${name}”.`);
    if (!wf.enabled) throw new Error(`“${wf.name}” is paused.`);
    if (parent.origin === 'claude' && !wf.when.some(t => t.type === 'claude')) {
      throw new Error(`Claude Code started this run, and “${wf.name}” doesn't allow being started by Claude Code. Add the Claude Code trigger to it if it should.`);
    }
    const ins = this.resolveInputs(wf, inputs);
    if (!ins.ok) throw new Error(ins.error);
    const child = this.launch(wf, { type: 'workflow', data: { name: parent.record.workflowName, runId: parent.record.id } }, ins.inputs, { depth, parentRunId: parent.record.id, origin: parent.origin, budget: parent.budget });
    const onAbort = () => child.engine.stop();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const rec = await child.done;
      return { status: rec.status, vars: rec.vars, runId: rec.id, error: rec.error };
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

module.exports = { Steps };
