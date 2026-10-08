// Before anything leaves the PC: what looks like a secret in the commits a
// push would send (secretscan.js). Every push Shellby makes asks it: bringing
// a checkout home (ipc/repo.js), a release (projects/release-git.js) and a
// pull request (github/pullrequest.js).
//
// Nothing found: null, push on. Found: ask, with "Push anyway", "Ask Claude
// to take them out" (a draft in a new tab, for you to send) and "Don't push"
// as the safe default. A scan git couldn't run lets the push go, as before.
const path = require('path');
const secretscan = require('./secretscan');

/**
 * @param d  what main shares: panel, dialogLook(), config, log, bugdex, showPanel(), send()
 * @param {string} root  the checkout or copy being pushed
 * @param {{ rev?: string, remote?: string, scan?: Function, ask?: Function }} [opts]
 *   rev and remote: what's pushed and where (secretscan.outgoing). scan, ask: tests pass fakes.
 * -> null (push on) | { ok: false, cancelled: true, secrets, error }
 */
async function secretGate(d, root, { rev, remote, scan = secretscan.outgoing, ask } = {}) {
  const found = await scan(root, undefined, { rev, remote });
  if (!found.ok) { d.log.warn('secret scan: git could not list what this push sends'); return null; }
  if (!found.findings.length) return null;
  const list = found.findings.map(secretscan.describe);
  const more = found.more ? `\n…and ${found.more} more` : '';
  const canFix = !d.config.get('crabOnly');
  const buttons = [{ label: 'Push anyway', style: 'danger' }, ...(canFix ? [{ label: 'Ask Claude to take them out' }] : []), { label: "Don't push" }];
  const cancelId = buttons.length - 1;
  const n = found.findings.length + found.more;
  const asking = ask || (spec => require('./confirm').ask(d.panel, spec));
  const response = await asking({
    ...d.dialogLook(), icon: '🔑', danger: true,
    title: n === 1 ? 'This push has something that looks like a secret' : `This push has ${n} things that look like secrets`,
    message: `Once it's on ${path.basename(root)}'s remote, anyone who can see the repository can copy it, and deleting it later doesn't take it back out of history.`,
    detail: list.join('\n') + more,
    note: found.partial ? 'The changes were too big to check all of it, so there may be more.' : 'Shellby only shows where it is, never the value. A real key that has been pushed should be rotated.',
    buttons, defaultId: cancelId, cancelId,
  });
  if (response === 0) { d.log.info(`push: sent anyway past ${n} possible secret(s)`); d.bugdex?.secretIgnored(root); return null; }
  if (canFix && response === 1) {
    d.bugdex?.secretSpotted(root, found.findings.map(f => f.kind)); // a Leaky Clam, caught when the next push goes out clean
    d.showPanel();
    d.send(d.panel, 'tab:new-in', { cwd: root, draft: `Before I push: Shellby found what look like secrets in commits that haven't been pushed yet: ${list.join('; ')}. Take them out of the code (an environment variable, or a .env file that .gitignore covers), and since they're in commits that haven't left this PC, rewrite those commits so the secret isn't in the history either. Don't push. Ask me before anything destructive, and tell me which keys I should rotate.` });
  }
  return { ok: false, cancelled: true, secrets: n, error: 'Not pushed: it had something that looks like a secret.' };
}

module.exports = { secretGate };
