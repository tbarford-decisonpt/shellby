// What a workflow may be. Everything that reaches the engine (the editor, a
// pasted import, Claude's draft, an MCP proposal, settings.json itself) comes
// through validateWorkflow first, and only known fields come out. See
// docs/plans/workflows.md for the format.
const path = require('path');
const { randomUUID } = require('crypto');
const { MODES } = require('../config');
const { isModel } = require('../models');
const { scheduleError, normaliseSchedule } = require('../routines');
const { minutesError, describe: describeSchedule } = require('./schedule');
const expr = require('./expr');
const mcpServers = require('../mcpservers');

const LIMITS = Object.freeze({
  name: 60, description: 500, steps: 60, depth: 4, triggers: 8, inputs: 10,
  prompt: 8000, command: 4000, url: 2000, header: 2000, headers: 20, body: 100000,
  question: 300, choice: 40, tool: 128, slug: 60, text: 1000, title: 100, label: 80, values: 20, fields: 20,
  fieldDescription: 200, eachMax: 100, waitSeconds: 604800, retries: 5, retryDelay: 3600, timeoutMin: 720,
});

const ID = /^[a-z][a-z0-9_]{0,31}$/;
const WF_ID = /^[\w-]{1,64}$/;
const SECRET = /^[A-Z][A-Z0-9_]{0,39}$/;
const STEP_TYPES = ['claude', 'mcp', 'run', 'http', 'ask', 'tell', 'set', 'if', 'each', 'wait', 'file', 'workflow', 'stop', 'worktree', 'pr'];
const TRIGGER_TYPES = ['schedule', 'ci', 'issue', 'shipped', 'task', 'health', 'folder', 'workflow', 'startup', 'webhook', 'claude'];
const CI_EVENTS = ['failed', 'fixed', 'passed', 'merged', 'review', 'any'];
const ISSUE_EVENTS = ['assigned', 'labelled', 'any'];
const SHIP_KINDS = ['push', 'deploy', 'release', 'merge', 'any'];
const OUTCOMES = ['ok', 'error', 'any'];
const FOLDER_EVENTS = ['added', 'changed', 'any'];
const TELL_TO = ['notification', 'phone', 'crab', 'file'];
const FILE_ACTIONS = ['read', 'write', 'append'];
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
const FIELD_TYPES = ['string', 'number', 'boolean', 'list', 'object'];
const CONTAINERS = { if: ['then', 'else'], each: ['steps'] };
// Where a secret may be used: only places that go to a command or a request,
// never into a prompt, a message or a file.
const SECRET_FIELDS = { run: ['command'], http: ['url', 'headers', 'body'] };
// An MCP tool's name: what servers use in practice, and nothing that could break out of one.
const TOOL_NAME = /^[A-Za-z0-9_][\w./-]{0,127}$/;
const UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g;

// ---------------------------------------------------------------- helpers

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const line = (v, max) => (typeof v === 'string' ? v.replace(UNSAFE, '').replace(/\s+/g, ' ').trim().slice(0, max + 1) : '');
const block = v => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(UNSAFE, '').trim() : '');

function absPath(v) {
  const p = typeof v === 'string' ? v.trim() : '';
  if (!p) return '';
  if (p.length > 1024 || p.includes('\0')) return null;
  // A templated path is checked once rendered (engine), but must still look absolute.
  if (expr.hasTemplate(p) && /^\{\{/.test(p)) return p;
  if (!path.isAbsolute(p)) return null;
  // Network shares are refused everywhere in Shellby: opening one signs in to that machine.
  if (/^[\\/]{2}/.test(p)) return null;
  return p;
}

function isJsonObject(text) {
  try { return isObj(JSON.parse(text)); } catch { return false; }
}

function intIn(v, min, max) {
  return Number.isInteger(v) && v >= min && v <= max;
}

// ---------------------------------------------------------------- triggers

function checkTrigger(t, at, err) {
  if (!isObj(t) || !TRIGGER_TYPES.includes(t.type)) { err(at, 'Unknown trigger'); return null; }
  switch (t.type) {
    case 'schedule': {
      const s = t.schedule?.type === 'minutes' ? { type: 'minutes', every: t.schedule.every } : normaliseSchedule(t.schedule);
      const e = s?.type === 'minutes' ? minutesError(s) : scheduleError(s);
      if (e) { err(`${at}.schedule`, e); return null; }
      return { type: 'schedule', schedule: s };
    }
    case 'ci': {
      const on = t.on ?? 'failed';
      if (!CI_EVENTS.includes(on)) { err(`${at}.on`, 'Pick which build event'); return null; }
      const repo = line(t.repo, 140);
      // GitLab projects can sit in nested groups: group/sub/project.
      if (repo && !/^[\w.-]+(?:\/[\w.+-]+)+$/.test(repo)) { err(`${at}.repo`, 'Repository must look like owner/name (or group/project on GitLab)'); return null; }
      return { type: 'ci', on, repo };
    }
    case 'issue': {
      const on = t.on ?? 'any';
      if (!ISSUE_EVENTS.includes(on)) { err(`${at}.on`, 'Pick assigned, labelled or any'); return null; }
      const repo = line(t.repo, 140);
      if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) { err(`${at}.repo`, 'Repository must look like owner/name'); return null; }
      return { type: 'issue', on, repo };
    }
    case 'shipped': {
      const kind = t.kind ?? 'any';
      if (!SHIP_KINDS.includes(kind)) { err(`${at}.kind`, 'Pick push, deploy, release, merge or any'); return null; }
      return { type: 'shipped', kind, project: line(t.project, 100) };
    }
    case 'task':
    case 'workflow': {
      const outcome = (t.type === 'task' ? t.outcome : t.status) ?? 'any';
      if (!OUTCOMES.includes(outcome)) { err(`${at}.${t.type === 'task' ? 'outcome' : 'status'}`, 'Pick ok, error or any'); return null; }
      if (t.type === 'task') return { type: 'task', outcome };
      const name = line(t.name, LIMITS.name);
      if (!name) { err(`${at}.name`, 'Name the workflow to follow'); return null; }
      return { type: 'workflow', name, status: outcome };
    }
    case 'folder': {
      const p = absPath(t.path);
      if (!p || expr.hasTemplate(p)) { err(`${at}.path`, 'Pick a folder to watch'); return null; }
      const pattern = line(t.pattern, 100);
      if (pattern && !/^[\w\s.*?,()[\]-]+$/.test(pattern)) { err(`${at}.pattern`, 'Use a simple pattern like *.pdf or report-*.csv'); return null; }
      const events = t.events ?? 'added';
      if (!FOLDER_EVENTS.includes(events)) { err(`${at}.events`, 'Pick added, changed or any'); return null; }
      return { type: 'folder', path: p, pattern, events };
    }
    case 'webhook': {
      const token = typeof t.token === 'string' && /^[a-f0-9]{32,64}$/.test(t.token) ? t.token : require('crypto').randomBytes(24).toString('hex');
      return { type: 'webhook', token };
    }
    default:
      return { type: t.type };
  }
}

function describeTrigger(t) {
  switch (t.type) {
    case 'schedule': return describeSchedule(t.schedule);
    case 'ci': return `When a build ${t.on === 'any' ? 'changes' : { failed: 'fails', fixed: 'goes green again', passed: 'passes', merged: 'is merged', review: 'needs your review' }[t.on]}${t.repo ? ` on ${t.repo}` : ''}`;
    case 'issue': return `When an issue is ${{ assigned: 'assigned to you', labelled: 'labelled shellby', any: 'assigned to you or labelled shellby' }[t.on]}${t.repo ? ` on ${t.repo}` : ''}`;
    case 'shipped': return `When ${t.project || 'a project'} ${t.kind === 'any' ? 'ships' : { push: 'is pushed', deploy: 'is deployed', release: 'is released', merge: 'has a pull request merged' }[t.kind]}`;
    case 'task': return `When a task ${t.outcome === 'any' ? 'finishes' : t.outcome === 'ok' ? 'succeeds' : 'fails'}`;
    case 'health': return 'When something overheats or fills up';
    case 'folder': return `When files are ${t.events === 'any' ? 'added or changed' : t.events} in ${path.basename(t.path) || t.path}${t.pattern ? ` (${t.pattern})` : ''}`;
    case 'workflow': return `After “${t.name}” ${t.status === 'any' ? 'runs' : t.status === 'ok' ? 'succeeds' : 'fails'}`;
    case 'startup': return 'When Shellby starts';
    case 'webhook': return 'When a script calls its web hook';
    case 'claude': return 'When Claude Code asks';
    default: return t.type;
  }
}

// ---------------------------------------------------------------- inputs

function checkInputs(list, err) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) { err('inputs', 'Inputs must be a list'); return []; }
  if (list.length > LIMITS.inputs) err('inputs', `At most ${LIMITS.inputs} inputs`);
  const seen = new Set();
  return list.slice(0, LIMITS.inputs).map((i, n) => {
    const at = `inputs[${n}]`;
    if (!isObj(i)) { err(at, 'Each input needs a name'); return null; }
    const name = typeof i.name === 'string' ? i.name.trim() : '';
    if (!ID.test(name)) { err(`${at}.name`, 'Input names are lowercase letters, digits and _'); return null; }
    if (seen.has(name)) { err(`${at}.name`, `Two inputs are called “${name}”`); return null; }
    seen.add(name);
    return {
      name,
      label: line(i.label, LIMITS.label) || name,
      default: typeof i.default === 'string' ? i.default.slice(0, 2000) : '',
      required: i.required === true,
    };
  }).filter(Boolean);
}

// ---------------------------------------------------------------- steps

function checkCommon(s, at, err) {
  const out = {};
  const label = line(s.label, LIMITS.label);
  if (label.length > LIMITS.label) err(`${at}.label`, `Labels are at most ${LIMITS.label} characters`);
  if (label) out.label = label.slice(0, LIMITS.label);
  if (s.if !== undefined && s.if !== null && s.if !== '') {
    const p = expr.parseCondition(s.if);
    if (!p.ok) err(`${at}.if`, p.error); else out.if = String(s.if).trim();
  }
  if (s.retry !== undefined && s.retry !== null && (s.type === 'if' || s.type === 'each')) err(`${at}.retry`, 'Give the steps inside a retry instead');
  else if (s.retry !== undefined && s.retry !== null) {
    const times = s.retry.times ?? 0;
    const delaySec = s.retry.delaySec ?? 30;
    if (!intIn(times, 0, LIMITS.retries)) err(`${at}.retry.times`, `Retry 0-${LIMITS.retries} times`);
    else if (!intIn(delaySec, 1, LIMITS.retryDelay)) err(`${at}.retry.delaySec`, `Wait 1-${LIMITS.retryDelay} seconds between tries`);
    else if (times > 0) out.retry = { times, delaySec };
  }
  if (s.timeoutMin !== undefined && s.timeoutMin !== null) {
    if (s.type === 'if' || s.type === 'each') err(`${at}.timeoutMin`, 'Give the steps inside a time limit instead');
    else if (!intIn(s.timeoutMin, 1, LIMITS.timeoutMin)) err(`${at}.timeoutMin`, `Time limit is 1-${LIMITS.timeoutMin} minutes`);
    else out.timeoutMin = s.timeoutMin;
  }
  if (s.continueOnError === true) out.continueOnError = true;
  return out;
}

function text(s, key, at, err, { max, required = true, multiline = true, what = key }) {
  const v = multiline ? block(s[key]) : line(s[key], max);
  if (!v && required) { err(`${at}.${key}`, `Fill in ${what}`); return ''; }
  if (v.length > max) { err(`${at}.${key}`, `${what[0].toUpperCase()}${what.slice(1)} is at most ${max.toLocaleString('en-US')} characters`); return ''; }
  if (v && expr.hasTemplate(v)) {
    const p = expr.parseTemplate(v);
    if (!p.ok) err(`${at}.${key}`, p.error);
  }
  return v;
}

function checkOutputFields(o, at, err) {
  if (o === undefined || o === null) return null;
  if (!isObj(o)) { err(at, 'Output fields must be a set of names'); return null; }
  const names = Object.keys(o);
  if (!names.length) return null;
  if (names.length > LIMITS.fields) { err(at, `At most ${LIMITS.fields} output fields`); return null; }
  const out = {};
  for (const n of names) {
    if (!ID.test(n) || n === 'reply' || n === 'tabId') { err(`${at}.${n}`, `“${n.slice(0, 32)}” can't be a field name`); continue; }
    const f = isObj(o[n]) ? o[n] : { type: o[n] };
    if (!FIELD_TYPES.includes(f.type)) { err(`${at}.${n}`, 'Field type is string, number, boolean, list or object'); continue; }
    out[n] = { type: f.type, description: line(f.description, LIMITS.fieldDescription).slice(0, LIMITS.fieldDescription) };
  }
  return Object.keys(out).length ? out : null;
}

function checkStep(s, at, depth, ctx) {
  const { err } = ctx;
  if (!isObj(s) || !STEP_TYPES.includes(s.type)) { err(at, 'Unknown step'); return null; }
  if (++ctx.count > LIMITS.steps) { if (ctx.count === LIMITS.steps + 1) err(at, `A workflow has at most ${LIMITS.steps} steps`); return null; }
  const id = typeof s.id === 'string' && s.id.trim() ? s.id.trim() : null;
  if (id !== null && (!ID.test(id) || expr.ROOTS.includes(id))) err(`${at}.id`, `“${id.slice(0, 32)}” can't be a step name: use lowercase letters, digits and _`);
  const step = { id: id && ID.test(id) && !expr.ROOTS.includes(id) ? id : null, type: s.type, ...checkCommon(s, at, err) };

  switch (s.type) {
    case 'claude': {
      step.prompt = text(s, 'prompt', at, err, { max: LIMITS.prompt, what: 'what Claude should do' });
      const mode = s.mode ?? 'smart';
      if (!MODES.includes(mode)) err(`${at}.mode`, 'Unknown permission mode');
      else if (mode === 'autonomous' && !ctx.allowAutonomous) err(`${at}.mode`, 'Autonomous needs turning on in Settings first');
      step.mode = mode;
      if (s.model) { if (typeof s.model === 'string' && isModel(s.model)) step.model = s.model; else err(`${at}.model`, 'Unknown model'); }
      if (s.cwd) { const c = absPath(s.cwd); if (c === null) err(`${at}.cwd`, 'Folder must be a full path'); else if (c) step.cwd = c; }
      if (s.fresh === true) step.fresh = true;
      // MCP servers whose tools Claude may use here without asking, and
      // whether they're the only ones it gets.
      const servers = mcpServers.checkNames(s.mcp);
      if (servers.error) err(`${at}.mcp`, servers.error);
      else if (servers.list.length) {
        step.mcp = servers.list;
        if (s.mcpOnly === true) step.mcpOnly = true;
      }
      const output = checkOutputFields(s.output, `${at}.output`, err);
      if (output) step.output = output;
      break;
    }
    case 'mcp': {
      step.server = line(s.server, 100);
      if (!step.server) err(`${at}.server`, 'Pick the MCP server');
      else if (!mcpServers.NAME.test(step.server)) err(`${at}.server`, `“${step.server.slice(0, 40)}” isn't an MCP server name`);
      step.tool = line(s.tool, LIMITS.tool);
      if (!step.tool) err(`${at}.tool`, 'Pick the tool to call');
      else if (!TOOL_NAME.test(step.tool)) err(`${at}.tool`, `“${step.tool.slice(0, 40)}” isn't a tool name`);
      if (s.args !== undefined && s.args !== null && s.args !== '') {
        const args = typeof s.args === 'string' ? s.args.trim() : JSON.stringify(s.args);
        if (args.length > LIMITS.body) err(`${at}.args`, 'The arguments are too long');
        else if (!/^\{/.test(args)) err(`${at}.args`, 'Arguments are a JSON object, like { "title": "{{ diagnose.cause }}" }');
        else if (expr.hasTemplate(args) && !expr.parseTemplate(args).ok) err(`${at}.args`, expr.parseTemplate(args).error);
        else if (!expr.hasTemplate(args) && !isJsonObject(args)) err(`${at}.args`, 'The arguments aren\'t valid JSON');
        else step.args = args;
      }
      // Written out, never a {{ value }}: the folder decides which project's
      // servers count, and that mustn't be up to whatever started the run.
      if (s.cwd) {
        const c = absPath(s.cwd);
        if (c === null || (c && expr.hasTemplate(c))) err(`${at}.cwd`, 'The folder must be a full path, written out');
        else if (c) step.cwd = c;
      }
      if (s.allowFail === true) step.allowFail = true;
      break;
    }
    case 'run': {
      step.command = text(s, 'command', at, err, { max: LIMITS.command, what: 'the command' });
      if (step.command && expr.valuesInSingleQuotes(step.command)) err(`${at}.command`, 'A {{ value }} inside \'single quotes\' stays as text. Put it in "double quotes", or on its own.');
      if (s.cwd) { const c = absPath(s.cwd); if (c === null) err(`${at}.cwd`, 'Folder must be a full path'); else if (c) step.cwd = c; }
      if (s.allowFail === true) step.allowFail = true;
      break;
    }
    case 'http': {
      const method = typeof s.method === 'string' ? s.method.toUpperCase() : 'GET';
      if (!HTTP_METHODS.includes(method)) err(`${at}.method`, 'Unknown method');
      step.method = method;
      step.url = text(s, 'url', at, err, { max: LIMITS.url, multiline: false, what: 'the address' });
      if (step.url && !expr.hasTemplate(step.url.split('/').slice(0, 3).join('/')) && !/^https?:\/\/[^\s/]+/i.test(step.url)) err(`${at}.url`, 'The address must start with http:// or https://');
      if (s.headers !== undefined && s.headers !== null) {
        if (!isObj(s.headers)) err(`${at}.headers`, 'Headers must be a set of names and values');
        else {
          const entries = Object.entries(s.headers);
          if (entries.length > LIMITS.headers) err(`${at}.headers`, `At most ${LIMITS.headers} headers`);
          const headers = {};
          for (const [k, v] of entries.slice(0, LIMITS.headers)) {
            if (!/^[A-Za-z0-9-]{1,64}$/.test(k)) { err(`${at}.headers`, `“${k.slice(0, 30)}” isn't a header name`); continue; }
            const val = line(v, LIMITS.header);
            if (val.length > LIMITS.header) { err(`${at}.headers.${k}`, 'Header is too long'); continue; }
            if (expr.hasTemplate(val) && !expr.parseTemplate(val).ok) { err(`${at}.headers.${k}`, expr.parseTemplate(val).error); continue; }
            headers[k] = val;
          }
          if (Object.keys(headers).length) step.headers = headers;
        }
      }
      if (s.body !== undefined && s.body !== null && s.body !== '') {
        const body = typeof s.body === 'string' ? s.body : JSON.stringify(s.body);
        if (body.length > LIMITS.body) err(`${at}.body`, 'The body is too long');
        else if (expr.hasTemplate(body) && !expr.parseTemplate(body).ok) err(`${at}.body`, expr.parseTemplate(body).error);
        else step.body = body;
      }
      if (s.allowFail === true) step.allowFail = true;
      break;
    }
    case 'ask': {
      step.question = text(s, 'question', at, err, { max: LIMITS.question, multiline: false, what: 'the question' });
      if (s.choices !== undefined && s.choices !== null) {
        const c = Array.isArray(s.choices) ? s.choices.map(x => line(x, LIMITS.choice)).filter(Boolean) : [];
        if (c.length < 2 || c.length > 4) err(`${at}.choices`, 'Give 2 to 4 choices');
        else if (c.some(x => x.length > LIMITS.choice)) err(`${at}.choices`, `Choices are at most ${LIMITS.choice} characters`);
        else if (new Set(c.map(x => x.toLowerCase())).size !== c.length) err(`${at}.choices`, 'Choices must all be different');
        else step.choices = c;
      }
      break;
    }
    case 'tell': {
      const to = s.to ?? 'notification';
      if (!TELL_TO.includes(to)) err(`${at}.to`, 'Pick where to send it');
      step.to = to;
      step.text = text(s, 'text', at, err, { max: LIMITS.text, what: 'the message' });
      const title = line(s.title, LIMITS.title);
      if (title) step.title = title.slice(0, LIMITS.title);
      if (to === 'file') {
        const p = absPath(s.path);
        if (!p) err(`${at}.path`, 'Pick the file to write to (a full path)'); else step.path = p;
      }
      break;
    }
    case 'set': {
      if (!isObj(s.values) || !Object.keys(s.values).length) { err(`${at}.values`, 'Set at least one value'); break; }
      const values = {};
      const entries = Object.entries(s.values);
      if (entries.length > LIMITS.values) err(`${at}.values`, `At most ${LIMITS.values} values`);
      for (const [k, v] of entries.slice(0, LIMITS.values)) {
        if (!ID.test(k)) { err(`${at}.values`, `“${k.slice(0, 32)}” can't be a value name`); continue; }
        const t = typeof v === 'string' ? v : JSON.stringify(v ?? '');
        if (t.length > LIMITS.prompt) { err(`${at}.values.${k}`, 'Too long'); continue; }
        if (expr.hasTemplate(t) && !expr.parseTemplate(t).ok) { err(`${at}.values.${k}`, expr.parseTemplate(t).error); continue; }
        values[k] = t;
      }
      step.values = values;
      break;
    }
    case 'if': {
      const p = expr.parseCondition(s.test);
      if (!p.ok) err(`${at}.test`, p.error);
      step.test = typeof s.test === 'string' ? s.test.trim() : '';
      break;
    }
    case 'each': {
      step.over = text(s, 'over', at, err, { max: 300, multiline: false, what: 'the list to go through' });
      if (step.over && !expr.hasTemplate(step.over)) err(`${at}.over`, 'Name a list, like {{ find.files }}');
      const as = s.as === undefined || s.as === null || s.as === '' ? 'item' : String(s.as).trim();
      if (!ID.test(as) || expr.ROOTS.includes(as)) err(`${at}.as`, `“${as.slice(0, 32)}” can't be a name for each item`);
      step.as = as;
      const max = s.max ?? 25;
      if (!intIn(max, 1, LIMITS.eachMax)) err(`${at}.max`, `Go through 1-${LIMITS.eachMax} items`);
      step.max = intIn(max, 1, LIMITS.eachMax) ? max : 25;
      break;
    }
    case 'wait': {
      const sec = s.seconds ?? (Number.isFinite(s.minutes) ? Math.round(s.minutes * 60) : undefined);
      if (!intIn(sec, 1, LIMITS.waitSeconds)) err(`${at}.seconds`, 'Wait between 1 second and 7 days');
      step.seconds = intIn(sec, 1, LIMITS.waitSeconds) ? sec : 60;
      break;
    }
    case 'file': {
      const action = s.action ?? 'read';
      if (!FILE_ACTIONS.includes(action)) err(`${at}.action`, 'Pick read, write or append');
      step.action = action;
      const p = absPath(s.path);
      if (!p) err(`${at}.path`, 'Pick the file (a full path)'); else step.path = p;
      if (action !== 'read') step.content = text(s, 'content', at, err, { max: LIMITS.body, required: false, what: 'what to write' });
      break;
    }
    case 'workflow': {
      step.name = line(s.name, LIMITS.name);
      if (!step.name) err(`${at}.name`, 'Pick the workflow to run');
      if (s.inputs !== undefined && s.inputs !== null) {
        if (!isObj(s.inputs)) err(`${at}.inputs`, 'Inputs must be a set of names and values');
        else {
          const inputs = {};
          for (const [k, v] of Object.entries(s.inputs).slice(0, LIMITS.inputs)) {
            if (!ID.test(k)) { err(`${at}.inputs`, `“${k.slice(0, 32)}” can't be an input name`); continue; }
            inputs[k] = typeof v === 'string' ? v.slice(0, 2000) : JSON.stringify(v ?? '');
          }
          step.inputs = inputs;
        }
      }
      break;
    }
    case 'worktree': {
      step.repo = text(s, 'repo', at, err, { max: 140, multiline: false, what: 'the repository' });
      if (step.repo && !expr.hasTemplate(step.repo) && !/^[\w.-]+\/[\w.-]+$/.test(step.repo)) err(`${at}.repo`, 'Repository must look like owner/name');
      const branch = text(s, 'branch', at, err, { max: LIMITS.slug, required: false, multiline: false, what: 'the branch name' });
      if (branch) step.branch = branch;
      break;
    }
    case 'pr': {
      step.folder = text(s, 'folder', at, err, { max: 1024, multiline: false, what: 'the copy to propose' });
      if (step.folder && !expr.hasTemplate(step.folder)) err(`${at}.folder`, 'Name the copy from a “Make a copy” step, like {{ copy.path }}');
      step.title = text(s, 'title', at, err, { max: 250, multiline: false, what: 'the title' });
      const body = text(s, 'body', at, err, { max: LIMITS.text * 8, required: false, what: 'the description' });
      if (body) step.body = body;
      step.draft = s.draft !== false;
      break;
    }
    case 'stop': {
      const status = s.status ?? 'ok';
      if (!['ok', 'error'].includes(status)) err(`${at}.status`, 'Stop as ok or error');
      step.status = status;
      const message = line(s.message, LIMITS.text);
      if (message) step.message = message.slice(0, LIMITS.text);
      break;
    }
  }

  const kids = CONTAINERS[s.type] || [];
  if (kids.length && depth >= LIMITS.depth) err(at, `Steps nest at most ${LIMITS.depth} deep`);
  for (const k of kids) {
    const list = s[k];
    if (list === undefined || list === null) { step[k] = []; continue; }
    if (!Array.isArray(list)) { err(`${at}.${k}`, 'Must be a list of steps'); step[k] = []; continue; }
    step[k] = depth >= LIMITS.depth ? [] : list.map((c, i) => checkStep(c, `${at}.${k}[${i}]`, depth + 1, ctx)).filter(Boolean);
  }
  if (s.type === 'each' && !step.steps.length) err(`${at}.steps`, 'Add a step to repeat');
  if (s.type === 'if' && !step.then.length && !step.else.length) err(`${at}.then`, 'Add a step for when it is true or false');
  return step;
}

// Every step, depth first, with where it sits.
function walkSteps(steps, fn, at = 'steps', scope = []) {
  steps.forEach((s, i) => {
    const here = `${at}[${i}]`;
    fn(s, here, scope);
    for (const k of CONTAINERS[s.type] || []) walkSteps(s[k] || [], fn, `${here}.${k}`, s.type === 'each' ? [...scope, s.as] : scope);
  });
}

// Missing ids become claude1, run2…: unique, and stable for the order they're in.
function assignIds(steps) {
  const taken = new Set();
  walkSteps(steps, s => { if (s.id) taken.add(s.id); });
  const counts = {};
  walkSteps(steps, s => {
    if (s.id) return;
    let n = counts[s.type] || 0;
    let id;
    do { id = `${s.type}${++n}`; } while (taken.has(id));
    counts[s.type] = n;
    taken.add(id);
    s.id = id;
  });
}

// Every {{ value }} and condition must name something that exists, and secrets
// only go where they're allowed. Typos are far cheaper here than mid-run.
function checkRefs(wf, err) {
  const ids = new Set();
  const dupes = new Set();
  walkSteps(wf.steps, s => { if (ids.has(s.id)) dupes.add(s.id); ids.add(s.id); });
  for (const d of dupes) err('steps', `Two steps are called “${d}”`);
  // A loop's name for each item can't also be a step's name: one would hide the other.
  walkSteps(wf.steps, (s, at) => { if (s.type === 'each' && ids.has(s.as)) err(`${at}.as`, `“${s.as}” is already a step's name`); });
  if (wf.cwd && expr.hasTemplate(wf.cwd)) err('cwd', 'The default folder can\'t use {{ values }}: give the step its own folder instead');
  const inputNames = new Set(wf.inputs.map(i => i.name));

  walkSteps(wf.steps, (s, at, scope) => {
    const fields = [];
    const add = (key, value, kind = 'template') => { if (typeof value === 'string' && value) fields.push({ key, value, kind }); };
    for (const k of ['prompt', 'command', 'url', 'body', 'args', 'question', 'text', 'title', 'message', 'path', 'content', 'over', 'cwd', 'repo', 'branch', 'folder']) add(k, s[k]);
    for (const [k, v] of Object.entries(s.headers || {})) add(`headers.${k}`, v);
    for (const [k, v] of Object.entries(s.values || {})) add(`values.${k}`, v);
    for (const [k, v] of Object.entries(s.inputs || {})) add(`inputs.${k}`, v);
    add('if', s.if, 'condition');
    add('test', s.test, 'condition');
    const allowed = SECRET_FIELDS[s.type] || [];
    for (const f of fields) {
      if (f.kind !== 'condition') { const p = expr.parseTemplate(f.value); if (!p.ok) { err(`${at}.${f.key}`, p.error); continue; } }
      const refs = f.kind === 'condition' ? expr.conditionRefs(f.value) : expr.templateRefs(f.value);
      for (const segs of refs) {
        const head = segs[0];
        if (head === 'secrets') {
          const base = f.key.split('.')[0];
          if (f.kind === 'condition' || !allowed.includes(base)) err(`${at}.${f.key}`, 'Secrets can only go in a command or a web request');
          else if (typeof segs[1] !== 'string' || !SECRET.test(segs[1])) err(`${at}.${f.key}`, 'Secret names are capitals, digits and _ (like GITHUB_TOKEN)');
          continue;
        }
        if (head === 'inputs' && typeof segs[1] === 'string' && !inputNames.has(segs[1])) { err(`${at}.${f.key}`, `There's no input called “${segs[1]}”`); continue; }
        if (head === 'steps' && typeof segs[1] === 'string' && !ids.has(segs[1])) { err(`${at}.${f.key}`, `There's no step called “${segs[1]}”`); continue; }
        if (expr.ROOTS.includes(head) || scope.includes(head) || ids.has(head)) continue;
        err(`${at}.${f.key}`, `“${head}” isn't a step, an input or a value Shellby knows`);
      }
    }
  });
}

/**
 * Untrusted input -> { ok, workflow, errors: [{ path, message }] }.
 * opts.allowAutonomous: the user has acknowledged Autonomous.
 */
function validateWorkflow(input, { allowAutonomous = false, now = Date.now() } = {}) {
  const errors = [];
  const err = (p, message) => { if (errors.length < 50) errors.push({ path: p, message }); };
  if (!isObj(input)) return { ok: false, workflow: null, errors: [{ path: '', message: 'A workflow must be an object' }] };

  let id = input.id;
  if (id === undefined || id === null || id === '') id = `wf-${randomUUID()}`;
  else if (typeof id !== 'string' || !WF_ID.test(id)) { err('id', 'Invalid id'); id = null; }

  const name = line(input.name, LIMITS.name);
  if (!name) err('name', 'Give it a name');
  else if (name.length > LIMITS.name) err('name', `Names are at most ${LIMITS.name} characters`);
  const description = line(input.description, LIMITS.description).slice(0, LIMITS.description);

  let cwd = '';
  if (input.cwd) { const c = absPath(input.cwd); if (c === null || (c && expr.hasTemplate(c))) err('cwd', 'Folder must be a full path'); else cwd = c; }

  const concurrency = input.concurrency ?? 'skip';
  if (!['skip', 'queue'].includes(concurrency)) err('concurrency', 'Pick skip or queue');

  const inputs = checkInputs(input.inputs, err);

  let when = [];
  if (input.when !== undefined && input.when !== null) {
    if (!Array.isArray(input.when)) err('when', 'Triggers must be a list');
    else {
      if (input.when.length > LIMITS.triggers) err('when', `At most ${LIMITS.triggers} triggers`);
      when = input.when.slice(0, LIMITS.triggers).map((t, i) => checkTrigger(t, `when[${i}]`, err)).filter(Boolean);
      const once = when.filter(t => ['claude', 'startup', 'health', 'webhook'].includes(t.type)).map(t => t.type);
      if (new Set(once).size !== once.length) err('when', 'That trigger is already there');
    }
  }

  const ctx = { err, count: 0, allowAutonomous };
  let steps = [];
  if (!Array.isArray(input.steps) || !input.steps.length) err('steps', 'Add at least one step');
  else steps = input.steps.map((s, i) => checkStep(s, `steps[${i}]`, 1, ctx)).filter(Boolean);

  const bool = (k, d) => (typeof input[k] === 'boolean' ? input[k] : d);
  const time = (k, d) => (Number.isFinite(input[k]) && input[k] > 0 ? input[k] : d);
  const workflow = {
    id, name: name.slice(0, LIMITS.name), description, enabled: bool('enabled', true), cwd, concurrency,
    inputs, when, steps,
    createdAt: time('createdAt', now), updatedAt: now,
  };
  if (!errors.length) {
    assignIds(workflow.steps);
    checkRefs(workflow, err);
  }
  return errors.length ? { ok: false, workflow: null, errors } : { ok: true, workflow, errors: [] };
}

// ---------------------------------------------------------------- what it may do

const listOf = names => (names.length === 1 ? `the ${names[0]} MCP server` : `the ${names.slice(0, -1).join(', ')} and ${names.at(-1)} MCP servers`);

/**
 * Plain sentences for the confirm window and the list: everything this
 * workflow can do without asking first. Empty means nothing risky.
 */
function capabilities(wf) {
  const out = [];
  const seen = new Set();
  const say = s => { if (!seen.has(s)) { seen.add(s); out.push(s); } };
  const MODE = { smart: 'Smart', acceptEdits: 'Auto-edit', autonomous: 'Autonomous' };
  walkSteps(wf.steps || [], s => {
    if (s.type === 'claude' && s.mcp?.length) say(`Let Claude use ${listOf(s.mcp)} without asking`);
    if (s.type === 'mcp') say(`Call ${s.tool} on the ${s.server} MCP server`);
    if (s.type === 'claude' && MODE[s.mode]) say(`Let Claude work in ${MODE[s.mode]} mode${s.mode === 'autonomous' ? ', with no permission prompts at all' : ''} in ${s.cwd || wf.cwd || 'your current folder'}`);
    if (s.type === 'run') say(`Run a command: ${s.command.split('\n')[0].slice(0, 120)}${s.command.includes('\n') || s.command.length > 120 ? '…' : ''}`);
    if (s.type === 'http') {
      let host = s.url;
      try { host = new URL(s.url).host || s.url; } catch { /* templated */ }
      say(`Send ${s.method} requests to ${host.slice(0, 80)}`);
    }
    if (s.type === 'file' && s.action !== 'read') say(`${s.action === 'write' ? 'Write' : 'Add to'} ${s.path}`);
    if (s.type === 'tell' && s.to === 'file') say(`Add to ${s.path}`);
    if (s.type === 'workflow') say(`Run the workflow “${s.name}”`);
    if (s.type === 'pr') say(`Push a branch and open ${s.draft ? 'a draft' : 'a'} pull request on GitHub`);
  });
  return out;
}

/**
 * Everything a yes would allow, in full and unabridged, for the confirmation
 * window: every command, every Claude prompt that may act unasked, every
 * request's method, address, header names and body, every file written and
 * what goes in it. Secrets used are named. Nothing here is shortened: a tail
 * left off is a tail that could hide something.
 */
function riskDetail(wf) {
  const MODE = { smart: 'Smart', acceptEdits: 'Auto-edit', autonomous: 'Autonomous' };
  const blocks = [];
  walkSteps(wf.steps || [], s => {
    const name = s.label || s.id;
    // In Smart and up the block below shows the prompt; in Plan or Ask this one does.
    if (s.type === 'claude' && s.mcp?.length) blocks.push(`▸ ${name}: Claude may use every tool of ${listOf(s.mcp)} without asking${s.mcpOnly ? ', and no other MCP servers' : ''}${MODE[s.mode] ? '' : `\n${s.prompt}`}`);
    if (s.type === 'mcp') blocks.push(`▸ ${name}: calls ${s.tool} on the ${s.server} MCP server, in ${s.cwd || wf.cwd || 'your current folder'}${s.args ? `\nArguments:\n${s.args}` : ''}`);
    if (s.type === 'claude' && MODE[s.mode]) blocks.push(`▸ ${name}: Claude in ${MODE[s.mode]} mode, in ${s.cwd || wf.cwd || 'your current folder'}\n${s.prompt}`);
    if (s.type === 'run') blocks.push(`▸ ${name}: runs in ${s.cwd || wf.cwd || 'your current folder'}\n${s.command}`);
    if (s.type === 'http') {
      const headers = Object.entries(s.headers || {}).map(([k, v]) => `${k}: ${v}`);
      blocks.push(`▸ ${name}: ${s.method} ${s.url}${headers.length ? `\nHeaders:\n${headers.join('\n')}` : ''}${s.body ? `\nBody:\n${s.body}` : ''}`);
    }
    if (s.type === 'file' && s.action !== 'read') blocks.push(`▸ ${name}: ${s.action === 'write' ? 'writes' : 'adds to'} ${s.path}${s.content ? `\n${s.content}` : ''}`);
    if (s.type === 'tell' && s.to === 'file') blocks.push(`▸ ${name}: adds a line to ${s.path}`);
    // Another workflow can do anything that one may: say which, and with what.
    if (s.type === 'workflow') blocks.push(`▸ ${name}: runs the workflow “${s.name}”, and everything it does${Object.keys(s.inputs || {}).length ? `\nInputs: ${JSON.stringify(s.inputs)}` : ''}`);
    if (s.type === 'pr') blocks.push(`▸ ${name}: commits what's in ${s.folder}, pushes its branch to GitHub and opens ${s.draft ? 'a draft' : 'a'} pull request\nTitle: ${s.title}${s.body ? `\n${s.body}` : ''}`);
  });
  const secrets = new Set();
  walkSteps(wf.steps || [], s => {
    for (const v of [s.command, s.url, s.body, ...Object.values(s.headers || {})]) {
      for (const m of String(v || '').matchAll(/\{\{\s*secrets\.([A-Z][A-Z0-9_]*)/g)) secrets.add(m[1]);
    }
  });
  if (secrets.size) blocks.push(`Uses these secrets: ${[...secrets].join(', ')}`);
  return blocks.join('\n\n');
}

// The parts a yes in the confirm window was a yes to. A change to any of them
// asks again; renaming or re-labelling doesn't.
function riskSignature(wf) {
  if (!wf) return '';
  const parts = [];
  walkSteps(wf.steps || [], s => {
    if (s.type === 'claude' && s.mode !== 'ask' && s.mode !== 'plan') parts.push(['claude', s.mode, s.prompt, s.cwd || wf.cwd || '']);
    // The prompt too, whatever the mode: in Plan or Ask it's what steers the servers' tools.
    if (s.type === 'claude' && s.mcp?.length) parts.push(['claude-mcp', s.mcp, !!s.mcpOnly, s.prompt, s.cwd || wf.cwd || '']);
    if (s.type === 'mcp') parts.push(['mcp', s.server, s.tool, s.args || '', s.cwd || wf.cwd || '']);
    if (s.type === 'run') parts.push(['run', s.command, s.cwd || wf.cwd || '']);
    if (s.type === 'http') parts.push(['http', s.method, s.url, s.headers || {}, s.body || '']);
    if (s.type === 'file' && s.action !== 'read') parts.push(['file', s.action, s.path, s.content || '']);
    if (s.type === 'tell' && s.to === 'file') parts.push(['tell', s.path]);
    if (s.type === 'workflow') parts.push(['workflow', s.name.toLowerCase(), s.inputs || {}]);
    if (s.type === 'pr') parts.push(['pr', s.folder, s.title, s.body || '', s.draft]);
  });
  if (!parts.length) return '';
  return JSON.stringify({ parts, when: (wf.when || []).map(t => ({ ...t, token: undefined })) });
}

module.exports = {
  LIMITS, STEP_TYPES, TRIGGER_TYPES, CONTAINERS, ID, SECRET,
  validateWorkflow, walkSteps, describeTrigger, capabilities, riskSignature, riskDetail,
};
