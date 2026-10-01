// Publish a Wardrobe pack to the community gallery (x-salmon/shellby-packs) the
// way CONTRIBUTING.md asks: fork, add packs/<id>/pack.json on a new branch, open
// a pull request. The repo's Pack check reviews it from there. The owner of the
// gallery repo (no fork of their own repo) branches in it directly.
const UPSTREAM = 'x-salmon/shellby-packs';
const FORK_WAIT_MS = 30000;

const b64 = text => Buffer.from(text, 'utf8').toString('base64');
const unb64 = text => Buffer.from(String(text || ''), 'base64').toString('utf8');
const canonical = json => JSON.stringify(json);
const packText = json => `${JSON.stringify(json, null, 2)}\n`;
const enc = s => s.split('/').map(encodeURIComponent).join('/');

/** The published pack.json on the default branch, or null. */
async function publishedPack(gh, upstream, id, ref) {
  try {
    const f = await gh.get(`/repos/${enc(upstream)}/contents/packs/${encodeURIComponent(id)}/pack.json?ref=${encodeURIComponent(ref)}`);
    let json = null;
    try { json = JSON.parse(unb64(f?.content)); } catch { /* unreadable: treat as a replacement */ }
    return { sha: f?.sha, json };
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

/** Fork (idempotent on GitHub's side) and wait until the fork answers. */
async function ensureFork(gh, upstream, { sleep, waitMs = FORK_WAIT_MS }) {
  const fork = await gh.post(`/repos/${enc(upstream)}/forks`, { default_branch_only: true });
  const name = fork?.full_name;
  if (!name) throw new Error("GitHub didn't make a copy (fork) of the gallery.");
  for (let waited = 0; ; waited += 2000) {
    try { await gh.get(`/repos/${enc(name)}`); return name; } catch (e) {
      if (e.status !== 404 || waited >= waitMs) throw new Error('GitHub is still making your copy of the gallery. Try again in a minute.');
    }
    await sleep(2000);
  }
}

/**
 * Open the pull request. pack: the validated pack JSON (as on disk).
 * Returns { ok, url, number, update } or { ok: false, error, same?/needsBump? }.
 */
async function publishPack(gh, { login, pack, upstream = UPSTREAM, now = Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const id = pack.id;
  const repo = await gh.get(`/repos/${enc(upstream)}`);
  const base = repo.default_branch || 'main';
  const head = await gh.get(`/repos/${enc(upstream)}/git/ref/heads/${encodeURIComponent(base)}`);
  const baseSha = head?.object?.sha;
  if (!baseSha) throw new Error("Couldn't read the gallery's latest version.");

  const existing = await publishedPack(gh, upstream, id, base);
  if (existing?.json) {
    if (canonical(existing.json) === canonical(pack)) return { ok: false, same: true, error: 'This exact version is already in the gallery.' };
    if (existing.json.version === pack.version) return { ok: false, needsBump: true, error: `The gallery already has v${pack.version} of this pack. Raise "version" in the pack (for example to the next number) and publish again.` };
  }

  const own = login.toLowerCase() === upstream.split('/')[0].toLowerCase();
  const target = own ? upstream : await ensureFork(gh, upstream, { sleep });
  const branch = `pack-${id}-${now.toString(36)}`;
  try {
    await gh.post(`/repos/${enc(target)}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseSha });
  } catch (e) {
    if (own || e.status !== 422) throw e;
    // An old fork may not know the newest commit yet: catch it up, then retry.
    await gh.post(`/repos/${enc(target)}/merge-upstream`, { branch: base });
    await gh.post(`/repos/${enc(target)}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseSha });
  }
  const update = !!existing;
  await gh.put(`/repos/${enc(target)}/contents/packs/${encodeURIComponent(id)}/pack.json`, {
    message: `${update ? 'Update' : 'Add'} pack: ${pack.name} v${pack.version}`,
    content: b64(packText(pack)),
    branch,
    ...(existing?.sha ? { sha: existing.sha } : {}),
  });
  const pr = await gh.post(`/repos/${enc(upstream)}/pulls`, {
    title: `${update ? 'Update' : 'Add'} pack: ${pack.name} v${pack.version}`,
    head: own ? branch : `${target.split('/')[0]}:${branch}`,
    base,
    body: [
      `${update ? 'Updates' : 'Adds'} **${pack.name}** (\`${id}\`) v${pack.version} by ${pack.author}.`,
      pack.description ? `\n> ${String(pack.description).slice(0, 300)}` : '',
      '\nPublished from the Shellby app. I agree to publish this pack under CC BY 4.0.',
    ].join('\n'),
    maintainer_can_modify: true,
  });
  return { ok: true, url: pr.html_url, number: pr.number, update };
}

module.exports = { publishPack, packText, UPSTREAM };
