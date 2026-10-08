// Settings → Other computers: its decisions and words (settings-remote.js
// draws them). Each computer is a short row of steps, each either done or
// with the one button that does it. Pure, no DOM. Works in the browser and in
// Node (for tests).
(function (root) {
  // Where ssh goes for a computer, as ssh -G worked it out.
  function whereLine(where) {
    if (!where?.host) return '';
    const port = where.port && where.port !== 22 ? `:${where.port}` : '';
    const at = `${where.user ? `${where.user}@` : ''}${where.host}${port}`;
    return where.jump ? `${at}, through ${where.jump}` : at;
  }

  // Keys in ~/.ssh with a passphrase that the agent isn't holding: ssh asks for these every time.
  const lockedKeys = keys => (keys || []).filter(k => k.locked && !k.loaded);

  /**
   * The way past "it didn't accept the sign-in", best first.
   * agent: { state, startType, reachable } | null; keys: view().keys
   */
  function signInFixes(agent, keys) {
    const fixes = [];
    const locked = lockedKeys(keys);
    if (locked.length && agent?.state !== 'running') fixes.push({ id: 'agent-on', label: "Turn on Windows' ssh agent" });
    if (locked.length && agent?.state === 'running') for (const k of locked) fixes.push({ id: 'unlock', key: k.name, label: `Unlock ${k.name}` });
    fixes.push({ id: 'setup-key', label: 'Sign in with my password, and set up a key' });
    return fixes;
  }

  /**
   * One computer's steps. c: a view().computers row. -> [{ id, state, text, actions }]
   * state: ok | todo | bad | busy
   */
  function steps(c, { agent = null, keys = [] } = {}) {
    const check = c?.check;
    if (c?.busy) return [{ id: 'reach', state: 'busy', text: 'Looking…', actions: [] }];
    if (!check) return [{ id: 'reach', state: 'todo', text: 'Not connected yet.', actions: [{ id: 'check', label: 'Connect' }] }];
    if (!check.ok) {
      const actions = check.kind === 'remote-auth' ? signInFixes(agent, keys) : [];
      return [{ id: 'reach', state: 'bad', text: check.message || "Couldn't connect.", actions: [...actions, { id: 'check', label: 'Try again' }] }];
    }
    const out = [{ id: 'reach', state: 'ok', text: `Connected${check.os ? ` (${check.os})` : ''}.`, actions: [{ id: 'check', label: 'Check again' }] }];
    if (!check.claude) {
      out.push({ id: 'claude', state: 'todo', text: "Claude Code isn't installed there yet.", actions: [{ id: 'install', label: 'Install Claude Code there' }] });
    } else if (!check.loggedIn) {
      out.push({ id: 'claude', state: 'todo', text: `Claude Code${check.version ? ` ${check.version}` : ''} is installed there, but not signed in.`, actions: [{ id: 'sign-in', label: 'Sign in there' }] });
    } else {
      const who = check.email ? ` as ${check.email}` : '';
      const plan = check.subscriptionType ? ` (${check.subscriptionType})` : '';
      const billing = check.authMethod && check.authMethod !== 'claude.ai';
      out.push({
        id: 'claude', state: billing ? 'todo' : 'ok',
        text: billing
          ? `Claude Code there is signed in with "${check.authMethod}", which bills per token, not your Claude plan.`
          : `Claude Code${check.version ? ` ${check.version}` : ''}, signed in${who}${plan}.`,
        actions: billing ? [{ id: 'sign-in', label: 'Sign in with my Claude account' }] : [],
      });
    }
    return out;
  }

  /** Ready to work there: reached, and Claude Code signed in. */
  const ready = c => !!(c?.check?.ok && c.check.claude && c.check.loggedIn);

  /**
   * First run without Claude Code on this PC: the folder to start in, the first
   * one on a computer that's ready, or null until there is one.
   */
  function readyFolder(computers) {
    const c = (computers || []).find(x => ready(x) && x.folders?.length);
    return c ? c.folders[0].anchor : null;
  }

  /** The agent's line, and its button, when it's worth one. */
  function agentLine(agent, keys) {
    if (!agent) return { text: "Windows' ssh agent isn't installed on this PC.", action: null };
    const locked = lockedKeys(keys);
    if (agent.state === 'running') {
      const held = (keys || []).filter(k => k.loaded).map(k => k.name);
      const text = held.length ? `On, holding ${held.join(', ')}.` : 'On, holding no keys yet.';
      return { text, action: locked[0] ? { id: 'unlock', key: locked[0].name, label: `Unlock ${locked[0].name}` } : null };
    }
    return {
      text: locked.length
        ? `Off. Turn it on and unlock ${locked.map(k => k.name).join(', ')} once, and ssh stops asking for the passphrase.`
        : 'Off. It only matters for keys with a passphrase.',
      action: locked.length ? { id: 'agent-on', label: 'Turn it on' } : null,
    };
  }

  /** What the question box says for one of ssh's prompts. */
  function askText({ prompt, kind } = {}) {
    const p = String(prompt || '');
    const key = /key '([^']+)'/.exec(p)?.[1];
    const keyName = key ? key.split(/[\\/]/).pop() : null;
    const host = /^([^@\s]+@[^'\s]+)'s password/.exec(p)?.[1] || null;
    if (kind === 'passphrase') return { title: 'Unlock your key', lede: keyName ? `ssh needs the passphrase for ${keyName}.` : 'ssh needs your key\'s passphrase.', secret: true, button: 'Unlock' };
    if (kind === 'password') return { title: 'Sign in', lede: host ? `ssh needs the password for ${host}.` : 'ssh needs your password.', secret: true, button: 'Sign in' };
    if (kind === 'confirm') return { title: 'Trust this computer?', lede: p, secret: false, button: 'Yes', confirm: true };
    return { title: 'ssh is asking', lede: p || 'ssh needs an answer.', secret: true, button: 'Send' };
  }

  /** The add form: what's wrong with it before it goes, or null. */
  function formProblem({ alias, address, port }) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,62}$/.test(alias || '')) return 'Give it a short name, like homebox: letters, numbers, dots, dashes.';
    if (!address) return 'Its address: a name like homebox.lan or an IP like 192.168.1.20.';
    if (port && !(Number.isInteger(Number(port)) && Number(port) > 0 && Number(port) < 65536)) return 'The port is a number from 1 to 65535.';
    return null;
  }

  // A folder there, the way the panel names it everywhere (the folder chip, Recent).
  function placeName(folders, p) {
    if (!p) return null;
    const low = String(p).toLowerCase();
    const f = (folders || []).find(x => typeof x?.anchor === 'string' && x.anchor.toLowerCase() === low);
    return f ? `${f.host}: ${f.dir}` : null;
  }

  // The folder one step up from a folder there, for the browser's ".." row.
  function parentDir(dir) {
    if (!dir || dir === '~' || dir === '/') return null;
    const cut = dir.replace(/\/+$/, '').replace(/\/[^/]*$/, '');
    return cut || (dir.startsWith('/') ? '/' : '~');
  }

  const joinDir = (dir, name) => (dir === '/' ? `/${name}` : `${dir.replace(/\/+$/, '')}/${name}`);

  const api = { whereLine, lockedKeys, signInFixes, steps, ready, readyFolder, agentLine, askText, formProblem, placeName, parentDir, joinDir };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbyRemoteLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
