// The Logbook: every game system on one page, each card saying what to do
// next, where it lives, and what it feeds ("catch it with a test → its nest
// clears → coral grows"). It composes the views the other systems already
// make (XP and bounties, the quest line, the tide event, battles, nests, the
// reef, review mastery, the next unlock, the week, the streak, molting,
// Wrapped). Any part can be missing (not built yet, or turned off) and its
// card says "not yet" instead of breaking. Pure: no I/O, no clock (callers
// pass `now`). See test/logbook.test.js and docs/LOGBOOK.md.

// The panel views a card or a feed may point at (feature-use.js SCREENS ids).
const KNOWN_VIEWS = Object.freeze([
  'chat', 'logbook', 'wardrobe', 'trophies', 'finds', 'stickers', 'bugdex', 'tank', 'us', 'crew', 'council',
  'projects', 'history', 'notes', 'health', 'toolbox', 'workflows', 'routines', 'time', 'shop',
]);
const KNOWN = new Set(KNOWN_VIEWS);

// Every card, in the order they show when nothing is more urgent.
const CARD_IDS = Object.freeze(['loose', 'tide', 'today', 'quest', 'next-unlock', 'reef', 'review', 'week', 'streak', 'molt', 'wrapped']);
const CARDS = new Set(CARD_IDS);
const MAX_KEPT = CARD_IDS.length;

// What a card says when the system behind it hasn't arrived.
const NOT_YET = Object.freeze({
  today: 'Bounties show up with your first XP of the day.',
  quest: 'The quest line starts once he has finished a task.',
  loose: 'Bugs show up here once the Bugdex is on.',
  'next-unlock': 'What your next level brings shows up with your first XP.',
  reef: 'Not yet: reef health for each project is on its way.',
  review: 'Not yet: review mastery is on its way.',
  week: 'Your week shows up after a few days together.',
  streak: 'Your streak starts with the first day you work together.',
});

// One line per screen, for a quest's "feeds" links.
const LINK_TEXT = Object.freeze({
  chat: 'Happens in the chat, with Claude.',
  projects: 'Shows on the project’s page.',
  bugdex: 'Fills the Bugdex.',
  tank: 'Ends up in his tank.',
  trophies: 'Counts toward a trophy and your level.',
  routines: 'Runs from Automate → Routines.',
  workflows: 'Runs from Automate.',
  council: 'Sits in the Council.',
  crew: 'Comes from his crew.',
  us: 'Shows on the Us page.',
  finds: 'Goes on the Finds shelf.',
  wardrobe: 'Shows in his Outfits.',
});

// What the next unlock is for, by kind (progression/levels.js / progression/xp.js unlock kinds).
const UNLOCK_FEEDS = Object.freeze({
  decor: { to: 'tank', text: 'Goes in your tank.' },
  tank: { to: 'tank', text: 'More room in his tank.' },
  shell: { to: 'wardrobe', text: 'A new home for him, in Outfits → Homes.' },
  home: { to: 'wardrobe', text: 'A new home for him, in Outfits → Homes.' },
  title: { to: 'trophies', text: 'A new title on his card.' },
  chapter: { to: 'logbook', text: 'Opens a new quest chapter.' },
  perk: { to: 'trophies', text: 'A perk that stays, even after a molt.' },
});
const WEAR_FEED = Object.freeze({ to: 'wardrobe', text: 'Something new to wear.' });

// The reef signal most worth fixing, in words (reef/signals.js names).
const SIGNAL_TEXT = Object.freeze({
  flaky: 'Fixing a flaky test pays Fixed a flaky test and lifts the reef.',
  lint: 'Clearing lint warnings lifts the reef.',
  any: 'Typing out the `any`s lifts the reef.',
  ci: 'A green build lifts the reef.',
  deps: 'Patching dependencies lifts the reef.',
  coverage: 'More test coverage lifts the reef.',
});

// Urgency: what needs doing now comes first (docs/GAMIFICATION-PLAN.md section 2.4).
const URGENT = Object.freeze({ looseHere: 100, tide: 80, looseElsewhere: 65, bountyClose: 60, quest: 50, low: 10 });

const num = n => (Number.isFinite(Number(n)) ? Number(n) : 0);
const arr = v => (Array.isArray(v) ? v : []);
const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const stamp = n => (Number.isFinite(Number(n)) && Number(n) > 0 ? Math.floor(Number(n)) : null);
const feed = (to, text) => (KNOWN.has(to) && text ? { to, text } : null);
const go = (view, focus) => ({ view: KNOWN.has(view) ? view : 'logbook', ...(focus ? { focus } : {}) });

function card(id, fields) {
  return { id, icon: '', title: '', text: '', missing: false, rows: [], progress: null, urgency: URGENT.low, ...fields, feeds: arr(fields.feeds).filter(Boolean) };
}
const notYet = (id, icon, title, view) => card(id, { icon, title, text: NOT_YET[id], missing: true, go: go(view), urgency: 0 });

// ------------------------------------------------------------------ cards

function todayCard(xp) {
  const b = obj(obj(xp)?.bounties);
  if (!b) return notYet('today', '🎯', 'Today’s bounties', 'trophies');
  const list = arr(b.list);
  const done = list.filter(x => x.done).length;
  const close = list.some(x => !x.done && num(x.goal) - num(x.count) <= 1);
  const unlock = obj(xp.unlock);
  return card('today', {
    icon: '🎯', title: 'Today’s bounties',
    text: !list.length ? 'New bounties come with your first XP today.'
      : b.cleared ? `All cleared: +${num(b.bonus)} XP paid.` : `${done} of ${list.length} done. Clear them all for +${num(b.bonus)} XP.`,
    rows: list.map(x => ({ text: x.text, n: num(x.count), of: num(x.goal), done: !!x.done, xp: num(x.xp) })),
    progress: list.length ? { n: done, of: list.length } : null,
    urgency: !b.cleared && close ? URGENT.bountyClose : URGENT.low + 20,
    go: go('trophies', 'xpCard'),
    feeds: [list.length && !b.cleared && feed('trophies', `Bounty XP counts toward ${unlock ? `level ${unlock.level}: ${unlock.name}` : 'your next level'}.`)],
  });
}

function questCard(q) {
  const v = obj(q);
  if (!v || !obj(v.chapter)) return notYet('quest', '🗺️', 'Quest', 'logbook');
  const ch = v.chapter;
  const cur = arr(v.list).find(x => x.id === v.current) || null;
  const next = obj(v.nextLocked);
  const text = cur ? `${cur.title}. ${cur.why}`
    : next ? `Chapter ${ch.n} is done. ${next.title} is next: ${next.unlockText.charAt(0).toLowerCase()}${next.unlockText.slice(1)}`
      : 'Every chapter is done. He has nothing left to teach you.';
  const target = cur && KNOWN.has(cur.go) ? cur.go : 'chat';
  return card('quest', {
    icon: ch.icon || '🗺️', title: `Chapter ${ch.n}: ${ch.title}`, text,
    isNew: !!ch.isNew,
    rows: arr(v.list).map(x => ({ id: x.id, icon: x.icon, text: x.title, done: !!x.done, now: x.id === v.current })),
    progress: { n: num(ch.doneCount), of: num(ch.total) },
    chapters: { done: num(v.chaptersDone), of: num(v.totalChapters) },
    urgency: cur ? URGENT.quest : URGENT.low,
    go: go(cur ? target : 'logbook', cur ? null : 'lbChapters'),
    feeds: [
      ch.teaches && feed('logbook', ch.teaches),
      ...arr(cur?.links).filter(l => l !== 'chat').map(l => feed(l, LINK_TEXT[l])),
    ],
  });
}

function tideCard(eventPart, now) {
  const e = obj(eventPart);
  const active = e && 'active' in e ? obj(e.active) : e && e.goals ? e : null;
  if (!active) {
    const nx = obj(e?.next);
    return card('tide', {
      icon: '🌊', title: 'Tide event', text: nx ? `${nx.emoji || ''} ${nx.name} ${nx.when}.`.trim() : 'No tide event on right now.',
      urgency: 0, go: go('us'), quiet: true,
    });
  }
  const goals = arr(active.goals);
  const done = goals.filter(g => g.done).length;
  const daysLeft = active.endsAt ? Math.max(0, Math.ceil((num(active.endsAt) - num(now)) / 86400000)) : num(active.daysLeft);
  const bug = obj(active.bug);
  return card('tide', {
    icon: active.emoji || '🌊', title: active.name || 'Tide event',
    text: active.done ? `Every goal done: the medal is yours. ${active.left || ''}`.trim() : `${done} of ${goals.length} goals. ${active.left || plural(daysLeft, 'day') + ' left'}.`,
    rows: goals.map(g => ({ text: g.text, n: num(g.n), of: num(g.goal), done: !!g.done })),
    progress: goals.length ? { n: done, of: goals.length } : null,
    endsAt: num(active.endsAt) || null,
    urgency: active.done ? URGENT.low : URGENT.tide + (active.lastDay ? 15 : Math.max(0, 10 - daysLeft)),
    go: go('us'),
    feeds: [
      bug && feed('bugdex', `${bug.name || 'Its bug'} is this event’s bug${active.twist ? `: ${active.twist.charAt(0).toLowerCase()}${active.twist.slice(1)}` : '.'}`),
      !active.done && feed('trophies', 'Every goal while it’s on earns the medal and its trophy.'),
    ],
  });
}

// The nest a battle's bug belongs to, if any.
const nestOf = (b, nests) => arr(nests).find(n => n.species === b.species && (!n.project || !b.project || n.project === b.project)) || null;

function looseCard(battles, nestsPart, eventPart, activeProject) {
  if (!Array.isArray(battles)) return notYet('loose', '🪲', 'Bugs on the loose', 'bugdex');
  const live = battles.filter(b => b && !b.over);
  const np = obj(nestsPart);
  const nests = arr(np?.open || np?.nests);
  const active = obj(obj(eventPart)?.active) || null;
  if (!live.length) {
    return card('loose', {
      icon: '🪲', title: 'Bugs on the loose', text: nests.length ? `None loose. ${plural(nests.length, 'nest')} still to clear.` : 'No bugs on the loose. Nice.',
      urgency: nests.length ? URGENT.low + 5 : 0, go: go('bugdex'), quiet: !nests.length,
      feeds: [nests.length && feed('projects', 'A cleared nest lifts its project’s reef.')],
    });
  }
  const here = activeProject ? live.filter(b => b.project === activeProject) : [];
  const nested = live.map(b => ({ b, n: nestOf(b, nests) })).find(x => x.n);
  const eventBug = active && live.find(b => b.species === active.bug?.id);
  return card('loose', {
    icon: '🪲', title: 'Bugs on the loose',
    text: `${plural(live.length, 'bug')} loose${here.length ? `, ${here.length} in ${activeProject}` : ''}.`,
    rows: live.map(b => ({ text: b.name || b.species, hp: num(b.hp), max: num(b.max), project: b.project || '', nest: !!nestOf(b, nests) })),
    urgency: here.length ? URGENT.looseHere : URGENT.looseElsewhere,
    go: go('bugdex'),
    feeds: [
      nested && feed('projects', `Catch ${nested.b.name || 'it'} with a test → its nest clears in 14 days → coral${nested.b.project ? ` in ${nested.b.project}` : ''} grows.`),
      eventBug && feed('us', `${eventBug.name || 'It'} is this event’s bug${active.twist ? `: ${active.twist.charAt(0).toLowerCase()}${active.twist.slice(1)}` : '.'}`),
      !nested && feed('tank', 'Each catch fills the Bugdex, and its jar can go in your tank.'),
    ],
  });
}

function unlockCard(unlocks, xp) {
  const nx = obj(obj(unlocks)?.next) || obj(obj(xp)?.unlock);
  if (!nx) {
    if (!obj(xp) && !obj(unlocks)) return notYet('next-unlock', '🔓', 'Next unlock', 'trophies');
    return card('next-unlock', { icon: '🔓', title: 'Next unlock', text: 'Everything’s unlocked. Past 99, every level earns a star.', go: go('trophies', 'xpCard') });
  }
  const toGo = num(nx.xpToGo);
  return card('next-unlock', {
    icon: '🔓', title: 'Next unlock',
    text: `Level ${num(nx.level)}: ${nx.name}${toGo ? `, ${toGo.toLocaleString('en-US')} XP to go` : ''}.`,
    urgency: URGENT.low + 10,
    go: go('trophies', 'xpCard'),
    feeds: [Object.hasOwn(UNLOCK_FEEDS, nx.kind) ? feed(UNLOCK_FEEDS[nx.kind].to, UNLOCK_FEEDS[nx.kind].text) : feed(WEAR_FEED.to, WEAR_FEED.text)],
  });
}

function reefCard(reefPart) {
  const r = obj(reefPart);
  if (!r) return notYet('reef', '🪸', 'Reef', 'projects');
  const list = arr(r.projects).filter(p => p && p.project);
  if (!list.length) {
    return card('reef', { icon: '🪸', title: 'Reef', text: 'No reefs yet. Turn on reef watch on a project and its coral starts to grow.', go: go('projects'), feeds: [feed('tank', 'A reef’s coral grows in his tank.')] });
  }
  const sorted = [...list].sort((a, b) => num(b.stage) - num(a.stage) || a.project.localeCompare(b.project));
  const best = sorted[0], worst = sorted[sorted.length - 1];
  const worstSig = Object.entries(obj(worst.signals) || {}).filter(([, v]) => num(v) > 0).sort((a, b) => num(b[1]) - num(a[1]))[0];
  // The reef view gives each project its next step; a plain { signal: count } map is the fallback.
  const fix = obj(worst.next)?.text ? `${worst.next.text}.` : worstSig && (Object.hasOwn(SIGNAL_TEXT, worstSig[0]) ? SIGNAL_TEXT[worstSig[0]] : `Bringing down ${worstSig[0]} lifts the reef.`);
  return card('reef', {
    icon: '🪸', title: 'Reef',
    text: list.length === 1 ? `${best.project}: stage ${num(best.stage)}${best.fading ? ', fading' : ''}.`
      : `Best: ${best.project} (stage ${num(best.stage)}). Needs care: ${worst.project} (stage ${num(worst.stage)}).`,
    rows: sorted.map(p => ({ text: p.project, n: num(p.stage), of: 5, fading: !!p.fading })),
    urgency: URGENT.low + (worst.fading ? 15 : 5),
    go: go('projects'),
    feeds: [fix && feed('projects', `${worst.project}: ${fix}`), feed('tank', 'A new best grows coral in his tank.')],
  });
}

// The review view says what's left per goal ({ points, caught, quizBest }); older views sent one number of catches.
const needTotal = n => (typeof n === 'object' && n ? num(n.points) + num(n.caught) + num(n.quizBest) : num(n));
function needText(n) {
  if (!n || typeof n !== 'object') return `${num(n)} more caught in review`;
  const parts = [num(n.caught) && `${num(n.caught)} more caught in review`, num(n.points) && `${num(n.points)} more points`, num(n.quizBest) && `a quiz run ${num(n.quizBest)} longer`].filter(Boolean);
  return parts.join(', ') || 'Nearly there';
}
function reviewCard(reviewPart) {
  const r = obj(reviewPart);
  if (!r) return notYet('review', '🦅', 'Review track', 'trophies');
  const nx = obj(r.next);
  const need = nx ? needTotal(nx.need) : 0;
  return card('review', {
    icon: '🦅', title: 'Review track',
    text: `${r.tierName || `Tier ${num(r.tier)}`}. ${num(r.caught)} caught in review, quiz streak ${num(r.quizStreak)}.`,
    progress: nx ? { n: Math.max(0, num(r.points ?? r.caught)), of: Math.max(1, num(r.points ?? r.caught) + (typeof nx.need === 'object' ? num(nx.need?.points) : need)) } : null,
    urgency: URGENT.low + (nx && need <= 1 ? 20 : 5),
    go: go('trophies'),
    feeds: [
      nx && feed('trophies', `${needText(nx.need)} → ${nx.name || `tier ${num(nx.tier)}`}${nx.reward ? ` → ${nx.reward}` : ''}.`),
      feed('bugdex', 'What’s caught in review never becomes a nest.'),
    ],
  });
}

function weekCard(week, xp) {
  const w = obj(week);
  if (!w) return notYet('week', '📅', 'Your week', 'trophies');
  const mult = num(obj(obj(xp)?.streak)?.multiplier);
  const away = num(obj(w.counts)?.awayRuns);
  return card('week', {
    icon: '📅', title: 'Your week', text: w.headline || `${num(w.xp)} XP this week.`,
    chart: arr(w.days).map(d => ({ day: d.day, xp: num(d.xp) })),
    urgency: URGENT.low,
    go: go('trophies'),
    feeds: [mult > 1 && feed('trophies', `Your streak keeps XP at ×${Math.round(mult * 100) / 100}.`), away > 0 && feed('routines', `Routines ran ${plural(away, 'time')} while you were away.`)],
  });
}

function streakCard(streak, xp) {
  const s = obj(streak);
  const days = s ? num(s.current) : num(obj(obj(xp)?.streak)?.days);
  if (!s && !obj(xp)) return notYet('streak', '🔥', 'Streak', 'trophies');
  const left = s && s.tideOutsLeft != null ? num(s.tideOutsLeft) : null;
  return card('streak', {
    icon: '🔥', title: 'Streak',
    text: `${plural(days, 'day')} in a row.${left != null ? ` ${plural(left, 'tide-out')} left this week.` : ''}`,
    urgency: URGENT.low - 2,
    go: go('trophies'),
    feeds: [feed('trophies', 'A streak raises the XP everything pays.')],
  });
}

function moltCard(molt, xp) {
  const m = obj(molt);
  const level = num(m?.level ?? obj(xp)?.level);
  if (!(m?.canMolt || level >= 99)) return null;
  return card('molt', {
    icon: '🐚', title: 'Molt', text: m?.canMolt ? 'Level 99. He can molt: a new climb, a tier shell, and every unlock kept.' : 'Level 99. Molting is coming.',
    urgency: URGENT.quest - 5, go: go('wardrobe', 'molt'),
    feeds: [feed('wardrobe', 'Molting keeps every unlock and starts a new climb with a tier shell.')],
  });
}

function wrappedCard(wrapped) {
  const w = obj(wrapped);
  if (!w?.due) return null;
  return card('wrapped', {
    icon: '🎁', title: `Your ${w.year || 'year'}, wrapped`, text: 'Your year with Shellby, in slides.',
    urgency: URGENT.tide + 5, go: go('trophies', 'wrapped'),
    feeds: [feed('tank', 'Watching it can earn a rare tank piece.')],
  });
}

// ------------------------------------------------------------------ the view

/** A stored logbook value made safe: { pinned, collapsed, lastOpenAt }. */
function normalizeLogbook(v) {
  const s = obj(v) || {};
  const ids = list => [...new Set(arr(list).filter(id => CARDS.has(id)))].slice(0, MAX_KEPT);
  return { pinned: ids(s.pinned), collapsed: ids(s.collapsed), lastOpenAt: stamp(s.lastOpenAt) };
}

const toggle = (list, id, on) => (on ? [...new Set([...list, id])] : list.filter(x => x !== id));

/** Pin a card to the top, or unpin it. Unknown cards change nothing. */
function setPinned(v, id, on) {
  const s = normalizeLogbook(v);
  return CARDS.has(id) ? { ...s, pinned: toggle(s.pinned, id, on) } : s;
}

/** Fold a card down to its title, or open it. */
function setCollapsed(v, id, on) {
  const s = normalizeLogbook(v);
  return CARDS.has(id) ? { ...s, collapsed: toggle(s.collapsed, id, on) } : s;
}

/** The Logbook was opened at `now`. */
function opened(v, now) {
  return { ...normalizeLogbook(v), lastOpenAt: stamp(now) };
}

/** Cards in order: pinned first, then what needs action now, then the usual order. */
function priority(cards, pinned = []) {
  const at = id => CARD_IDS.indexOf(id);
  const pin = id => (pinned.includes(id) ? 1 : 0);
  return [...cards].sort((a, b) => pin(b.id) - pin(a.id) || b.urgency - a.urgency || at(a.id) - at(b.id));
}

/**
 * Every card, ordered, and every cross-link.
 *   parts: { xp, quests, event, battles, nests, reef, review, unlocks, week,
 *            streak, molt, wrapped, activeProject, state }, any of them null.
 * -> { cards: [{ id, icon, title, text, missing, rows, progress, urgency,
 *      go: { view, focus? }, feeds: [{ to, text }], pinned, collapsed }],
 *      links: [{ from, to, text }], missing: [card ids], lastOpenAt }
 */
function logbookView(partsIn, now) {
  const p = obj(partsIn) || {};
  const s = normalizeLogbook(p.state);
  const cards = [
    looseCard(p.battles, p.nests, p.event, typeof p.activeProject === 'string' ? p.activeProject : ''),
    tideCard(p.event, now),
    todayCard(p.xp),
    questCard(p.quests),
    unlockCard(p.unlocks, p.xp),
    reefCard(p.reef),
    reviewCard(p.review),
    weekCard(p.week, p.xp),
    streakCard(p.streak, p.xp),
    moltCard(p.molt, p.xp),
    wrappedCard(p.wrapped),
  ].filter(Boolean).map(c => ({ ...c, pinned: s.pinned.includes(c.id), collapsed: s.collapsed.includes(c.id) }));
  const ordered = priority(cards, s.pinned);
  const links = [];
  const seen = new Set();
  for (const c of ordered) {
    for (const f of c.feeds) {
      const key = `${c.id}>${f.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ from: c.id, to: f.to, text: f.text });
    }
  }
  return { cards: ordered, links, missing: ordered.filter(c => c.missing).map(c => c.id), lastOpenAt: s.lastOpenAt };
}

module.exports = {
  KNOWN_VIEWS, CARD_IDS, NOT_YET,
  normalizeLogbook, setPinned, setCollapsed, opened, priority, logbookView,
};
