// GitHub and what hangs off it: CI on your pull requests, issues he could
// take on, and visiting crabs (friends.js).
// Kept out of main.js, which only wires it up.
const { app, safeStorage, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const focus = require('../focus');
const workmode = require('../workmode');
const { Friends, TOGETHER_EVERY_MS, TOGETHER_FIRST_MS, VISIT_MS, syncable: friendsSyncable } = require('../friends');
const bugdex = require('../bugdex');
const gifts = require('../gifts');
const { TokenStore } = require('../github/auth');
const { CiHub } = require('../ci-hub');
const { CiWatcher } = require('../github/ci');
const { IssueWatcher } = require('../github/issues');
const prBadges = require('../github/pr-badge');
const { ProfileCard } = require('../github/profile-card');
const { UPSTREAM: PACKS_REPO, publishPack } = require('../github/publish');
const issueWork = require('../github/pullrequest');
const { GitHubService } = require('../github/service');
const { secretGate } = require('../secret-gate');
const { SUGGESTED: SUGGESTED_MARKETPLACES, normalizeSource } = require('../marketplace');
const shells = require('../shells');
const stickers = require('../stickers');
const syncPrefs = require('../sync-prefs');
const tankShare = require('../tank-share');
const voice = require('../voice');
const { KNOWN_ACHIEVEMENTS } = require('../wardrobe/achievements');
const { validatePack } = require('../wardrobe/catalog');
const { KNOWN_SEASONS } = require('../wardrobe/seasons');
const { publicItem } = require('../wardrobe/service');
const worktrees = require('../worktrees');

/** d: what main shares (main.js `shared`). */
function wireGithub(d) {
  // ---- GitHub

  // Dev/test builds can point at a mock GitHub; the installed app always uses github.com.
  function githubEndpoints() {
    const dev = !app.isPackaged;
    return {
      web: (dev && process.env.SHELLBY_GITHUB_WEB) || 'https://github.com',
      api: (dev && process.env.SHELLBY_GITHUB_API) || 'https://api.github.com',
      clientId: (dev && process.env.SHELLBY_GITHUB_CLIENT_ID) || undefined,
    };
  }

  function createGitHub() {
    d.github = new GitHubService({
      config: d.config,
      store: new TokenStore(path.join(app.getPath('userData'), 'github.bin'), safeStorage),
      ...githubEndpoints(),
      onSynced: before => {
        d.broadcastWardrobe(); d.send(d.panel, 'xp', d.xpView()); d.send(d.panel, 'homes', d.homesView()); d.send(d.panel, 'stickers', d.stickersView()); d.refreshStatusLine();
        d.settingsSynced?.(before);
        // A friend added on another PC needs their card fetched here.
        if (d.friends && friendsChanged(d.config.data, before)) { d.friends.emit('change', d.friends.view()); d.friends.refresh().catch(() => {}); }
      },
    });
    d.github.on('change', v => d.send(d.panel, 'github', v));
    d.github.on('signed-in', v => d.send(d.panel, 'github:signed-in', v));
    d.github.on('error', message => d.send(d.panel, 'github:error', message));
    // Outfit, color and settings changes are stamped so sync keeps the newest, and shared soon.
    d.config.onSet = (patch, prev) => {
      if ('syncStamps' in patch) return; // a sync writing back, not you
      const stamps = { ...(prev.syncStamps || {}) };
      let changed = false;
      if ('skin' in patch && patch.skin !== prev.skin) { stamps.skinAt = Date.now(); changed = true; }
      if (patch.wardrobe && JSON.stringify(patch.wardrobe.outfit) !== JSON.stringify(prev.wardrobe?.outfit)) { stamps.outfitAt = Date.now(); changed = true; }
      // Snippets and pins are stamped one by one, with a marker for each one deleted.
      const prefStamps = syncPrefs.restamp(patch, prev, stamps.prefs, Date.now());
      if (prefStamps) { stamps.prefs = prefStamps; changed = true; }
      if (changed) d.config.set({ syncStamps: stamps });
      const stickersMoved = 'stickers' in patch && JSON.stringify(stickers.syncable(patch.stickers)) !== JSON.stringify(stickers.syncable(prev.stickers));
      const tankMoved = 'tank' in patch && JSON.stringify(tankShare.syncable(patch.tank)) !== JSON.stringify(tankShare.syncable(prev.tank));
      const friendsMoved = 'friends' in patch && friendsChanged(patch, prev);
      if (changed || stickersMoved || tankMoved || friendsMoved || (patch.wardrobe && JSON.stringify(patch.wardrobe.unlocked) !== JSON.stringify(prev.wardrobe?.unlocked))) d.github?.changedSoon();
    };
    d.github.schedule();
    if (d.github.can('sync')) setTimeout(() => d.github.sync().catch(() => {}), 30 * 1000);
    d.profileCard = new ProfileCard({ config: d.config, github: d.github });
    d.prBadge = new prBadges.PrBadge({ config: d.config, github: d.github, level: d.currentLevel, web: githubEndpoints().web });
  }

  // Who's on the friends list (or was removed) differs: not a card fetch or a visit.
  const friendsChanged = (now, before) => JSON.stringify(friendsSyncable(now.friends)) !== JSON.stringify(friendsSyncable(before.friends));

  // ---- CI on your pull requests (and merge requests on GitLab: wiring/gitlab.js)

  function createCi() {
    const ep = githubEndpoints();
    d.ciGithub = new CiWatcher({
      gh: () => d.github.gh(), login: () => d.github.view().login, web: ep.web, api: ep.api,
      seen: { load: () => d.config.get('ciSeen'), save: v => d.config.set({ ciSeen: v }) },
    });
    // One watcher for both, so everything that reads d.ci takes GitLab's merge requests too (ci-hub.js).
    d.ci = new CiHub({ github: d.ciGithub, gitlab: d.createGitLabWatcher?.() || null });
    d.ci.on('change', () => { d.send(d.panel, 'ci', ciView()); d.refreshCritter(); d.refreshStatusLine(); });
    d.ci.on('event', onCiEvent);
    // GitHub's follows its toggle and sign-in; GitLab's its own toggle.
    const follow = () => { if (d.github.can('ci')) d.ciGithub.start(); else if (d.ciGithub.running) d.ciGithub.stop(); };
    d.github.on('change', follow);
    follow();
    d.followGitLab?.();
  }

  // ---- issues he could take on

  // Issues assigned to you, or labelled shellby where you decide who labels
  // (github/issues.js). A new one starts the workflows with an Issue trigger:
  // the Issue helper template offers to take a crack at it and turns a yes into
  // a draft pull request (github/pullrequest.js).
  function createIssues() {
    const ep = githubEndpoints();
    d.issues = new IssueWatcher({
      gh: () => d.github.gh(), login: () => d.github.view().login, web: ep.web, api: ep.api,
      repos: async () => (d.projects ? (await d.projects.localRepos()).map(r => r.remote).filter(Boolean) : []),
      load: () => d.config.get('issueWatch'),
      save: v => d.config.set({ issueWatch: v }),
    });
    d.issues.on('event', ({ type, issue }) => {
      d.workflows?.event('issue', {
        event: type, reasons: issue.reasons, repo: issue.repo, number: issue.number, title: issue.title,
        body: issue.body, labels: issue.labels, author: issue.author, url: issue.url,
      });
    });
    const follow = () => { if (d.github.can('issues')) d.issues.start(); else if (d.issues.running) d.issues.stop(); };
    d.github.on('change', follow);
    follow();
  }

  // The clone on this PC of a GitHub repository, for a copy to start from.
  async function cloneOf(repo) {
    if (!d.projects) return null;
    const want = String(repo).toLowerCase();
    return (await d.projects.localRepos()).find(r => r.remote && r.remote.toLowerCase() === want)?.root || null;
  }

  function makeIssueCopy({ repo, slug }) {
    if (!d.github?.signedIn) return Promise.resolve({ ok: false, error: 'Sign in with GitHub first (Settings → GitHub).' });
    return issueWork.makeCopy({ repo, slug }, {
      findRoot: cloneOf, gh: d.github.gh(), git: worktrees.git, create: worktrees.create, home: d.worktreeHome(), env: d.github.claudeEnv(),
    });
  }

  // "Built with Shellby" on a pull request a tab just opened, when that's on.
  // Best effort: a badge that didn't make it is noted in Settings, nothing more.
  function badgePr(output) {
    if (d.CAPTURE || !d.github?.can('prBadge')) return;
    const pr = prBadges.prFromOutput(output, githubEndpoints().web);
    if (!pr) return;
    d.prBadge.addTo(pr)
      .then(r => { if (!r.ok) d.log.warn('PR badge', r.error); d.send(d.panel, 'pr-badge', d.prBadge.view()); })
      .catch(e => d.log.warn('PR badge', e.message));
  }

  async function openIssuePr({ folder, title, body: asked, draft }) {
    if (!d.github?.can('claude')) return { ok: false, error: 'Opening pull requests needs “Let Claude tasks push code and open pull requests” on in Settings → GitHub.' };
    // The badge goes in the body it opens with, rather than an edit after.
    const badge = d.github.can('prBadge') ? await d.prBadge.block() : null;
    const body = badge ? prBadges.withBadge(asked, badge) : asked;
    const r = await issueWork.openPullRequest({ folder, title, body, draft }, {
      gh: d.github.gh(), git: worktrees.git, home: d.worktreeHome(), env: d.github.claudeEnv(), web: githubEndpoints().web,
      gate: (root, o) => secretGate(d, root, o), // what it pushes is looked over for secrets first
    });
    if (!r.ok || r.existing) return r; // a retried step found its pull request already open: paid already
    // Shipping it pays now; the sticker comes when it merges (ci.js sees it, shippedMerge).
    d.flashState('success', 4000);
    d.noteWeek('pr');
    d.awardXp('issue', { project: r.repo.split('/')[1], label: `Opened ${r.repo}#${r.number}` });
    if (d.github.can('ci')) d.ci?.poll().catch(() => {});
    return r;
  }

  // ---- visiting crabs

  // How a card looks on this PC: skins and accessories this PC doesn't know are
  // simply left off, so a friend with a pack you haven't got still visits.
  function lookFor(card) {
    const list = d.allSkins();
    const skin = list.find(s => s.id === card.skin) || list.find(s => s.id === 'classic') || list[0];
    const accessories = ['shell', 'neck', 'hat', 'face', 'held']
      .map(slot => card.outfit[slot] && d.wardrobe?.catalog.accessories.get(card.outfit[slot]))
      .filter(a => a && SLOT_OK.has(a.slot)).map(publicItem);
    const home = card.home && shells.SHELLS.find(s => s.id === card.home) || null;
    // Their stickers by spot, onto however their crab looks here.
    const onShell = d.stickerService.placeStickers(skin, home, (card.stickers?.shell || []).map((e, i) => ({ ...e, id: `guest-${i}`, weather: 'fresh' })));
    return { skin, accessories, shell: shells.renderShell(home), level: card.level, stickers: onShell };
  }
  const SLOT_OK = new Set(['shell', 'neck', 'hat', 'face', 'held']);

  // A swap: when you both share your stickers by name, a friend's visit leaves
  // one of theirs (stickers.js receiveGuest). It goes in the book; the shell is yours to decide.
  function stickerSwap(v) {
    if (d.CAPTURE || !d.config || !d.visitor || d.visitor.login !== v.login) return; // gone already
    if (d.stickerState().card !== 'names') return; // a swap goes both ways
    const gift = stickers.pickTrade(v.card?.stickers?.trade, v.login, Date.now());
    if (!gift) return;
    const r = stickers.receiveGuest(d.config.get('stickers'), v.login, gift, Date.now());
    if (!r.project) return;
    d.config.set({ stickers: r.state });
    d.stickerStats(r.state);
    d.send(d.panel, 'stickers', d.stickersView());
    if (!r.fresh) return;
    const gifted = d.stickersView().projects.find(p => p.id === r.project.id);
    if (!gifted) return; // made room for itself and lost (stickers.js caps friends' gifts)
    d.sayText(`@${v.login} left me a sticker!`, 'visit', 7000);
    d.send(d.panel, 'stickers:new', gifted);
    if (!(d.panel?.isVisible() && d.panel.isFocused())) {
      d.notify(`@${v.login} left a sticker`, `Their ${gift.name} sticker is in your Sticker Book. Put it on his shell if you like.`,
        () => { d.showPanel({ focusInput: false }); d.send(d.panel, 'panel:view', 'stickers'); }, { tone: 'celebrate', pet: true });
    }
  }

  const friendsView = () => {
    const v = d.friends.view();
    return { ...v, friends: v.friends.map(f => ({ ...f, look: f.card ? lookFor(f.card) : null })) };
  };

  function sendVisitor() {
    d.send(d.critter, 'critter:visitor', d.visitor ? { login: d.visitor.login, look: d.visitor.look, until: d.visitor.until } : null);
  }

  function createFriends() {
    d.friends = new Friends({
      config: d.config,
      github: d.github,
      myCard: () => {
        const worn = shells.wornShell(d.config.get('home'), d.currentLevel());
        return {
          skin: d.activeSkin().id, home: worn ? worn.id : null, level: d.currentLevel(), outfit: d.wardrobe.effectiveOutfit(),
          stickers: stickers.forCard(d.config.get('stickers'), d.shellIdOf(worn), Date.now()), // as much as you chose to share
          // What his crab and yours talk about when they meet (banter.js).
          temperament: voice.temperamentOf(voice.normalize(d.config.get('voice')).seed),
          find: gifts.favourite(d.config.get('finds'))?.id || null,
          tank: tankShare.forCard(d.config.get('tank')), // only if you share it
          bugdex: d.config.get('shareBugdex') ? bugdex.shared(d.config.get('bugdex')) : null, // only if you share it
        };
      },
      sharesTank: () => !!tankShare.forCard(d.config.get('tank')), // a visit then counts for House Guest
      // Company only when he's free: not working, not guarding your focus, no helpers out.
      canVisit: () => d.lastStatus.state === 'idle' && !d.lastStatus.crew && !focus.guarding(d.config.get('focus'), Date.now()) && !d.playtime?.busy(),
      dropIns: () => workmode.behaviourOf(d.config).dropIns, // Work mode: only when you invite them
    });
    // A refresh saves several times; the panel only needs the last one.
    let viewTimer = null;
    d.friends.on('change', () => {
      clearTimeout(viewTimer);
      viewTimer = setTimeout(() => d.send(d.panel, 'friends', friendsView()), 150);
    });
    d.friends.on('record', event => d.stat(event));
    d.friends.on('visit', v => {
      d.visitor = v ? { login: v.login, look: lookFor(v.card), until: v.until } : null;
      sendVisitor();
      d.refreshCritter();
      if (v) d.sayText(`@${v.login} dropped by!`, 'visit', 4000);
      if (v?.card?.bugdex) setTimeout(() => d.bugdex?.friendVisited(v.login, v.card.bugdex.caught), 8 * 1000); // a jar for you, once they've said hello
      if (v?.signed) setTimeout(() => stickerSwap(v), 20 * 1000); // once they've said hello
      // ...and then the two of them talk (banter.js, through life.js).
      const togetherAt = [];
      for (let at = TOGETHER_FIRST_MS; at < VISIT_MS; at += TOGETHER_EVERY_MS) togetherAt.push(at);
      d.life?.visit(v, { visitMs: VISIT_MS, togetherAt, myCard: d.friends.myCard() });
    });
    // The two of them dance, party, high-five or sing (critter.css: body.together-*).
    d.friends.on('together', t => {
      d.send(d.critter, 'critter:together', { activity: t.id, ms: t.ms });
      if (t.id === 'party') d.send(d.critter, 'critter:burst', d.outfit().confetti);
      d.sayText(t.line, 'together', t.ms - 500);
    });
    d.friends.on('wave', w => d.sayText(w.text, 'wave', 10000));
    // Follows the GitHub toggle and sign-in, like CI.
    const follow = () => { if (d.github.can('friends')) { if (!d.friends.timer) d.friends.start(); } else if (d.friends.timer) d.friends.stop(); };
    d.github.on('change', follow);
    follow();
    // Turned off, but the card couldn't be deleted then: try again soon after
    // starting and on later GitHub changes (a sign-in, coming back online),
    // every few minutes at most, and say so once if it still can't.
    let triedAt = 0;
    let told = false;
    const retry = () => setImmediate(() => {
      if (Date.now() - triedAt < CARD_RETRY_MS) return;
      // Turning it off takes it down itself, and says so if that fails.
      if (d.friends.takingDown) { triedAt = Date.now(); return; }
      const p = d.friends.retryTakeDown();
      if (!p) return;
      triedAt = Date.now();
      p.then(r => { if (!r.ok && !told) { told = true; d.send(d.panel, 'github:error', `Your calling card is still up. ${r.error}`); } }).catch(() => {});
    });
    d.github.on('change', retry);
    setTimeout(retry, 30 * 1000);
  }
  const CARD_RETRY_MS = 10 * 60 * 1000;

  function onCiEvent({ type, pr }) {
    if (!pr) return;
    const where = pr.ref || `${pr.repo}#${pr.number}`;
    // New comments are for the inbox and a nudge, not a workflow trigger (schema.js CI_EVENTS has no 'comment').
    if (type !== 'comment') d.workflows?.event('ci', { event: type, forge: pr.forge || 'github', ref: where, repo: pr.repo, number: pr.number, title: pr.title || '', url: pr.url || '', branch: pr.branch || '', failing: pr.failing || [] });
    const open = () => openPrUrl(pr);
    if (type === 'failed') d.noteRed(`ci:${where}`);
    if (type === 'fixed') d.noteFix(`ci:${where}`);
    // A Red Tide (or a Kraken...) on the loose; caught when it goes green with Shellby's help.
    if (type === 'failed') d.bugdex?.ciFailed(pr);
    if (type === 'fixed') d.bugdex?.ciFixed(pr);
    if (type === 'failed') {
      d.flashState('error', 5000);
      d.tellChannel({ kind: 'ci', project: where, passing: false, body: `${pr.title}${pr.failing?.length ? `: ${pr.failing.join(', ')}` : ''}`, url: pr.url });
      // With Claude set up, a click opens "Fix this build" (what would be sent, to read first); without, the pull request.
      const canFix = !d.config.get('crabOnly') && !!d.claudeStatus?.installed && !!d.claudeStatus?.loggedIn;
      d.notify(`CI failed on ${where}`, `${pr.title}${pr.failing?.length ? `: ${pr.failing.join(', ')}` : ''}`.slice(0, 160),
        canFix ? () => d.showBuildFix(pr.key) : open, { tone: 'problem', action: canFix ? 'Fix this build' : null });
    } else if (type === 'fixed') {
      d.stat('ci-fixed');
      d.awardXp('cifix', { project: pr.repo, label: `CI back to green on ${where}` });
      d.flashState('cheer', 6500);
      d.tellChannel({ kind: 'ci', project: where, passing: true, body: `${pr.title}. Every check passes now.`, url: pr.url });
      d.send(d.critter, 'critter:burst', d.outfit().confetti);
      d.notify(`Back to green: ${where}`, `${pr.title}. Every check passes now.`.slice(0, 160), open, { tone: 'celebrate' });
    } else if (type === 'passed') {
      d.flashState('success', 4000);
    } else if (type === 'review') {
      d.flashState('asking', 5000);
      d.notify(`Review requested: ${where}`, pr.title, open);
    } else if (type === 'comment') {
      d.flashState('asking', 4000);
      const who = pr.talk?.people?.length ? pr.talk.people.join(', ') : 'Someone';
      d.notify(`New on ${where}`, `${who} on "${pr.title}"`.slice(0, 160), () => { d.ci?.markSeen(pr.key); open(); });
    } else if (type === 'merged') {
      // Your pull request is in: XP, a line and a little dance.
      d.awardXp('merged', { project: pr.repo, label: `Merged ${where}` });
      d.flashState('success', 4500);
      d.speak('merged');
      d.stickerService.shippedMerge(pr); // a merge ships the project: its sticker (stickers.js)
      d.backlogMerged?.(pr); // one opened from Next up: offer to tick its task off (wiring/backlog.js)
    }
  }

  // Only GitHub's own pages (or the dev mock's) for PRs the watcher reported.
  function openGitHubUrl(url) {
    const web = githubEndpoints().web;
    if (typeof url === 'string' && url.startsWith(`${web}/`) && (url.startsWith('https:') || !app.isPackaged)) shell.openExternal(url);
  }

  // A pull request's page on GitHub, or a merge request's on its GitLab.
  function openPrUrl(pr) {
    if (pr?.forge === 'gitlab') d.openGitLabUrl?.(pr.url);
    else openGitHubUrl(pr?.url);
  }

  // enabled: either forge is watched. githubEnabled / gitlab.enabled say which.
  const ciView = () => {
    const github = !!d.github?.can('ci');
    const gitlab = !!d.gitlabOn?.();
    const v = d.ci ? d.ci.view() : { prs: [], reviews: [], reviewsTotal: 0, failing: 0, unread: 0, gitlab: {} };
    return { ...v, enabled: github || gitlab, githubEnabled: github, gitlab: { ...v.gitlab, enabled: gitlab } };
  };

  // Claude tasks with your GitHub sign-in can push anywhere you can: ask, with the risk spelled out.
  async function confirmGitHubFeature(feature, on) {
    if (feature === 'claude' && on) {
      const response = await d.askOnce({
        icon: '🔑', danger: true,
        title: 'Let Claude tasks use your GitHub?',
        message: 'Claude Code tasks you run in Shellby get your GitHub sign-in, so they can push commits and open pull requests, including in private repos.',
        detail: 'Claude can also read the sign-in itself, so a task could use it for anything your GitHub account can do. Only turn this on if you check what your tasks do (Ask mode asks before every command).',
        note: 'Only Shellby\'s own tabs get it. Claude Code in your terminal is unchanged. Turn it off here any time.',
        buttons: [{ label: 'Allow', style: 'primary' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
      });
      if (response !== 0) return { ok: false, canceled: true, view: d.github.view() };
    }
    // A workflow file decides what runs in CI, on GitHub's machines, with whatever
    // secrets the repository holds. GitHub keeps it behind its own scope for that
    // reason, and so does Shellby.
    if (feature === 'workflows' && on) {
      const response = await d.askOnce({
        icon: '⚙️', danger: true,
        title: 'Let Claude tasks change your CI workflows?',
        message: 'Tasks will be able to push changes to .github/workflows — the files that decide what GitHub runs on every push.',
        detail: 'A workflow runs on GitHub with access to that repository\'s secrets, so a task that edits one can make them run anything, in any repo you can push to. Without this, pushes that touch a workflow file are refused by GitHub.',
        note: 'Needs "Let Claude tasks push" as well. Shellby will ask GitHub for the extra permission, which means signing in again.',
        buttons: [{ label: 'Allow', style: 'danger' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
      });
      if (response !== 0) return { ok: false, canceled: true, view: d.github.view() };
    }
    // The calling card is a public gist, so say what's on it before it goes up.
    if (feature === 'friends' && on) {
      const response = await d.askOnce({
        icon: '🦀',
        title: 'Let friends\' crabs visit?',
        message: 'Shellby puts a small calling card on your GitHub as a public gist: your crab\'s outfit, colors, shell and level, under your GitHub username. His stickers and his tank only go on it if you choose to share them.',
        detail: 'Friends you add by GitHub username can then have your crab over, and you theirs. Waves arrive as comments on the card, and only from friends you added. No stats, projects or history go on it, though anyone can see when it was last updated (about once a day while Shellby runs).',
        note: 'Turning this off deletes the card again.',
        buttons: [{ label: 'Turn on', style: 'primary' }, { label: 'Cancel' }], defaultId: 0, cancelId: 1,
      });
      if (response !== 0) return { ok: false, canceled: true, view: d.github.view() };
    }
    // The profile card is a public gist too, and it shows your level and streak.
    if (feature === 'profileCard' && on) {
      const response = await d.askOnce({
        icon: '🪪',
        title: 'Put your crab on your GitHub profile?',
        message: 'Shellby keeps an image of your crab in a public gist: his outfit, your level, your streak and your five latest stickers (pictures only, no project names).',
        detail: 'A small GitHub Action in your profile repository copies it in every few hours, so your profile README can show it. Shellby gives you the Action and the README line to paste; it never touches your repositories itself.',
        note: 'Turning this off deletes the gist. The last copy stays in your profile repo until you remove it.',
        buttons: [{ label: 'Turn on', style: 'primary' }, { label: 'Cancel' }], defaultId: 0, cancelId: 1,
      });
      if (response !== 0) return { ok: false, canceled: true, view: d.github.view() };
    }
    // The badge makes a public repository on your account and edits your pull requests: say so first.
    if (feature === 'prBadge' && on) {
      const response = await d.askOnce({
        icon: '🦀',
        title: 'Put your crab on your pull requests?',
        message: 'When a Shellby tab opens a pull request, Shellby adds a small picture of your crab (dressed as he is now), your level and a link to Shellby at the bottom of its description.',
        detail: `The picture has to live in a public repository for GitHub to show it, so Shellby makes one on your account, ${d.github.view().login || 'you'}/${prBadges.REPO}, holding only that picture (each new look is a commit, so earlier looks stay in its history). Only pull requests you open from Shellby get it, and you can delete it from any of them like any other text.\n\nGitHub has no permission for just one repository, so this asks for access to your public repositories (public_repo), the same one publishing Wardrobe packs uses. Shellby only ever writes to ${prBadges.REPO} and your own pull requests with it.`,
        note: 'Turning this off stops new badges. The repository stays, so the pictures on pull requests you already opened keep working. The permission lasts until you sign out.',
        buttons: [{ label: 'Turn on', style: 'primary' }, { label: 'Cancel' }], defaultId: 0, cancelId: 1,
      });
      if (response !== 0) return { ok: false, canceled: true, view: d.github.view() };
    }
    const r = await d.github.setFeature(feature, on);
    if (feature === 'profileCard' && r.ok && !r.needsApproval && !on) {
      const down = await d.profileCard.takeDown();
      if (!down.ok) return { ...r, error: down.error, view: d.github.view() };
    }
    if (feature === 'friends' && r.ok && !r.needsApproval) {
      if (on) d.friends?.start();
      else if (d.friends) {
        const down = await d.friends.takeDown();
        if (!down.ok) return { ...r, error: down.error, view: d.github.view() };
      }
    }
    return { ...r, view: d.github.view() };
  }

  async function confirmAndPublishPack(packId) {
    if (!d.github?.can('publish')) return { ok: false, error: 'Turn on "Publish Wardrobe packs" in Settings → GitHub first.' };
    const p = d.wardrobe.catalog.packs.find(x => x.id === packId && x.source === 'user');
    if (!p?.file) return { ok: false, error: "That pack isn't one of yours." };
    let json;
    try { json = JSON.parse(fs.readFileSync(p.file, 'utf8')); } catch { return { ok: false, error: "Couldn't read that pack's file." }; }
    const { pack, errors, warnings } = validatePack(json, { source: 'user', knownAchievements: KNOWN_ACHIEVEMENTS, knownSeasons: KNOWN_SEASONS });
    if (!pack) return { ok: false, error: `The pack has problems: ${errors[0]}` };
    if (warnings.length) return { ok: false, error: `The gallery needs every item to work. Fix this first: ${warnings[0]}` };
    if (d.wardrobe.catalog.packs.some(x => x.source === 'builtin' && x.id === pack.id)) return { ok: false, error: 'That id belongs to a built-in pack.' };
    const login = d.github.view().login;
    const response = await d.askOnce({
      icon: '🎁',
      title: 'Publish to the gallery?',
      message: `"${pack.name}" v${pack.version} by ${pack.author}, as @${login}`,
      detail: `This opens a public pull request on github.com/${PACKS_REPO}. Once it's reviewed and merged, anyone can add your pack from the gallery.\n\nPacks are published under CC BY 4.0, credited to "${pack.author}".`,
      note: 'Original art only: no copyrighted characters, logos or brands. Keep it friendly.',
      buttons: [{ label: 'Publish', style: 'primary' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
    });
    if (response === null) return { ok: false, canceled: true, busy: true };
    if (response !== 0) return { ok: false, canceled: true };
    try {
      return await publishPack(d.github.gh(), { login, pack: json });
    } catch (e) {
      console.warn('[shellby] publish failed:', e.message);
      return { ok: false, error: e.status === 401 ? 'GitHub signed Shellby out. Sign in again in Settings.' : `GitHub said: ${String(e.message).slice(0, 200)}` };
    }
  }

  async function confirmAndAddMarketplace(input) {
    const blocked = d.shopBlocked();
    if (blocked) return blocked;
    // Normalize first: the dialog shows exactly what Claude Code will be given.
    const source = normalizeSource(input);
    if (!source) return { ok: false, error: 'Use a GitHub repo like owner/repo, or a public https:// link.' };
    const suggested = SUGGESTED_MARKETPLACES.find(m => m.source === source);
    const response = await d.askOnce({
      icon: '🏪', danger: !suggested,
      title: 'Add marketplace?',
      message: suggested ? `${suggested.label} by ${suggested.by} (${suggested.source})` : source,
      detail: suggested ? '' : "Anyone can publish a marketplace. Its plugins haven't been reviewed by Anthropic or by Shellby.",
      note: 'Adding it only lists its plugins. Nothing is installed until you choose to.',
      buttons: [{ label: 'Add marketplace', style: 'primary' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
    });
    if (response === null) return { ok: false, canceled: true, busy: true };
    if (response !== 0) return { ok: false, canceled: true };
    const r = await d.shop.addMarketplace(source);
    if (!r.ok) return r;
    await d.shop.list().catch(() => {});
    return { ...r, view: d.shop.view() };
  }

  // Snippets pin to the start screen like skills do, as long as they still exist.
  function pinnedTools() {
    const names = new Set(d.snippetList().map(s => s.name));
    return (d.config.get('pinnedTools') || []).filter(p => p && typeof p.name === 'string'
      && (d.TRICKS_KIND.has(p.kind) || (p.kind === 'snippet' && names.has(p.name))));
  }

  return {
    badgePr, ciView, confirmAndAddMarketplace, confirmAndPublishPack, confirmGitHubFeature,
    createCi, createFriends, createGitHub, createIssues, friendsView, githubEndpoints,
    makeIssueCopy, openGitHubUrl, openIssuePr, openPrUrl, pinnedTools, sendVisitor,
  };
}

module.exports = { wireGithub };
