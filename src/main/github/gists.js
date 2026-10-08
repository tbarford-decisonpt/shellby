// Finding one of your own gists by the file it holds: the sync gist, your
// calling card, your profile card. Its own module so card.js and sync.js can
// both use it (sync.js needs friends.js, which needs card.js).

/** Find one of your own gists by the file it holds; returns its id or null. */
async function findGist(gh, knownId, file) {
  if (knownId) {
    try { await gh.get(`/gists/${encodeURIComponent(knownId)}`); return knownId; } catch (e) { if (e.status !== 404) throw e; }
  }
  for (let page = 1; page <= 5; page++) {
    const list = await gh.get(`/gists?per_page=100&page=${page}`);
    const hit = (list || []).find(g => g.files && g.files[file]);
    if (hit) return hit.id;
    if (!list || list.length < 100) break;
  }
  return null;
}

module.exports = { findGist };
