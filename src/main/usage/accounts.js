// Whose plan a conversation spends (pure: no Electron, no I/O).
//
// A conversation in a folder on another computer runs that computer's Claude
// Code, signed in there (remote/service.js). When that's another Claude
// account, its rate-limit events say how full *that* plan is: they must not
// move this PC's meter, limit nap, forecast or guard. They're kept per
// computer here instead, and the meter shows them while you're in one of its
// tabs (renderer tab-meters.js).
//
// Treated as your own plan (null): a folder on this PC, a computer signed in
// with the same email or one whose sign-in Shellby hasn't seen yet, and any
// computer while this PC itself isn't signed in (Claude Code only over there:
// that computer's plan is the only one you use).

const sameEmail = (a, b) => typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * place: remote/service placeOf(cwd) or null; computer: its remoteComputers row;
 * local: claude auth status on this PC ({ loggedIn, email }).
 * -> null (this PC's plan) | { host, email, plan }
 */
function accountFor({ place, computer, local }) {
  if (!place?.host) return null;
  if (!local?.loggedIn) return null;
  const check = computer?.check || null;
  if (typeof check?.email !== 'string' || !check.email || sameEmail(check.email, local.email)) return null;
  return { host: place.host, email: check.email, plan: check.subscriptionType || null };
}

const hostKey = host => String(host).toLowerCase();

/**
 * A reading for another account, merged into the per-computer map (a new map).
 * A window the event doesn't mention keeps its last value, so a bare
 * "allowed" event never empties the meter.
 */
function withReading(byHost, account, item, now) {
  const map = byHost && typeof byHost === 'object' ? byHost : {};
  const prev = readingFor(map, account) || {}; // never another account's, from before a new sign-in there
  return {
    ...map,
    [hostKey(account.host)]: {
      host: account.host, email: account.email, plan: account.plan,
      status: item.status ?? prev.status ?? null,
      fiveHour: item.fiveHour || prev.fiveHour || null,
      sevenDay: item.sevenDay || prev.sevenDay || null,
      at: now,
    },
  };
}

/**
 * The reading a conversation on `account` sees: its computer's, or null. One
 * taken while that computer was signed in to someone else is no longer theirs.
 */
function readingFor(byHost, account) {
  const r = account && byHost ? byHost[hostKey(account.host)] || null : null;
  return r && sameEmail(r.email, account.email) ? r : null;
}

/**
 * What the panel needs: every computer that's on another account, with its
 * last reading when there is one. computers: remoteComputers; byHost: withReading's map.
 */
function othersView(computers, byHost, local) {
  return (computers || [])
    .map(c => accountFor({ place: { host: c?.alias }, computer: c, local }))
    .filter(Boolean)
    .map(a => {
      const r = readingFor(byHost, a);
      return { host: a.host, email: a.email, plan: a.plan, status: r?.status || null, fiveHour: r?.fiveHour || null, sevenDay: r?.sevenDay || null, at: r?.at || null };
    });
}

module.exports = { accountFor, withReading, readingFor, othersView, hostKey };
