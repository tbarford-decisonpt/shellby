// Shellby Wrapped's slides (docs/WRAPPED.md): a year from the yearbook
// (yearbook.js summary) as an ordered list of slides with their words, for the
// panel to show one at a time (wrapped.js). A slide with nothing to say is left
// out, so a quiet year is a short Wrapped, never a row of zeros. The first slide,
// the days together and the card are always there.
//
// Pure: no I/O, no clock. See test/yearbook.test.js.

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const KIND_WORDS = Object.freeze({
  task: 'finishing tasks', ship: 'pushing code', fixed: 'turning tests green', tests: 'passing tests', catch: 'catching bugs',
  merged: 'merging pull requests', deploy: 'deploying', trophy: 'earning trophies', quest: 'quests', day: 'just showing up',
  medal: 'tide events', trick: 'new tricks', newbug: 'new bugs', cleanfix: 'clean fixes', nest: 'clearing nests', review: 'review',
  caught: 'catching things in review', quiz: 'quizzes', focus: 'focus sessions', find: 'his finds', pet: 'pets',
});

const n = v => Number(v || 0).toLocaleString('en-US');
const plural = (v, one, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;
const dayName = day => {
  const [, m, d] = day.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
};
const hourName = h => (h === 0 ? 'midnight' : h === 12 ? 'noon' : h < 12 ? `${h} AM` : `${h - 12} PM`);

/**
 * The slides for one year.
 *   sum: yearbook.summary(state, year)
 *   ctx: { speciesName(id) -> string|null, pieceName(key) -> string|null,
 *          trophyName(id) -> string|null, deepCuts: boolean, reef: { project, signal, from, to } | null }
 * Each slide: { id, eyebrow, title, big?, unit?, lines: [string], ...extras }.
 */
function slides(sum, ctx = {}) {
  if (!sum) return [];
  const name = (fn, v) => (typeof fn === 'function' && fn(v)) || null;
  const out = [];
  const since = sum.partial && sum.since ? `since ${dayName(sum.since)}` : null;

  // 1. The year in one number.
  out.push({
    id: 'year', eyebrow: `Shellby Wrapped ${sum.year}`, title: 'Your year in one number', big: n(sum.xp), unit: 'XP',
    lines: [
      sum.levelsGained ? `${plural(sum.levelsGained, 'level')} gained, up to level ${n(sum.endLevel)}.` : `He's level ${n(sum.endLevel || sum.startLevel || 1)}.`,
      sum.molts ? `And he molted ${sum.molts === 1 ? 'once' : `${n(sum.molts)} times`}.` : null,
      since ? `Counted ${since}: Shellby started keeping a yearbook then.` : null,
    ].filter(Boolean),
  });

  // 2. Days together.
  out.push({
    id: 'days', eyebrow: 'Days together', title: `${plural(sum.activeDays, 'day')} with you`, big: n(sum.activeDays), unit: sum.activeDays === 1 ? 'day' : 'days',
    lines: [
      sum.longestStreak > 1 ? `Your longest run: ${plural(sum.longestStreak, 'day')} in a row.` : null,
      sum.tideOuts ? `${plural(sum.tideOuts, 'tide-out day')} used, and the streak held.` : null,
      sum.tasks ? `${plural(sum.tasks, 'task')} finished.` : null,
    ].filter(Boolean),
  });

  // 3. When: busiest hour and weekday, and a heatmap.
  if (sum.busiestHour !== null || sum.busiestWeekday !== null) {
    out.push({
      id: 'when', eyebrow: 'When you worked', title: sum.busiestWeekday !== null ? `${WEEKDAYS[sum.busiestWeekday]}s were yours` : 'Your busiest hours',
      lines: [
        sum.busiestHour !== null ? `Busiest around ${hourName(sum.busiestHour)}.` : null,
        sum.busiestDay ? `The biggest day: ${dayName(sum.busiestDay.day)}, ${n(sum.busiestDay.xp)} XP.` : null,
        sum.topKinds[0] ? `Most of the XP came from ${KIND_WORDS[sum.topKinds[0].kind] || sum.topKinds[0].kind}.` : null,
      ].filter(Boolean),
      heat: { hours: [...sum.hours], weekdays: [...sum.weekdays] },
    });
  }

  // 4. What you shipped.
  if (sum.ships || sum.deploys || sum.merged) {
    out.push({
      id: 'shipped', eyebrow: 'What you shipped', title: sum.topProjects[0] ? `${sum.topProjects[0].name} came first` : 'Out the door',
      big: n(sum.ships), unit: sum.ships === 1 ? 'push' : 'pushes',
      lines: [
        ...sum.topProjects.map((p, i) => `${i + 1}. ${p.name}: ${plural(p.n, 'push', 'pushes')}`),
        sum.deploys ? `${plural(sum.deploys, 'deploy')}.` : null,
        sum.merged ? `${plural(sum.merged, 'pull request')} merged.` : null,
      ].filter(Boolean),
      list: sum.topProjects.map(p => ({ name: p.name, n: p.n })),
    });
  }

  // 5. The Bugdex.
  if (sum.catches) {
    const nemesis = sum.nemesis && (name(ctx.speciesName, sum.nemesis.id) || sum.nemesis.id);
    out.push({
      id: 'bugdex', eyebrow: 'The Bugdex', title: `${plural(sum.catches, 'bug')} caught`, big: n(sum.catches), unit: sum.catches === 1 ? 'bug' : 'bugs',
      lines: [
        sum.newSpecies ? `${plural(sum.newSpecies, 'new kind')} for the Bugdex.` : null,
        nemesis ? `Your nemesis: the ${nemesis}, caught ${plural(sum.nemesis.n, 'time')}.` : null,
        sum.shiny ? `${plural(sum.shiny, 'sparkly one')}.` : null,
      ].filter(Boolean),
      nemesis: sum.nemesis ? { id: sum.nemesis.id, name: nemesis, n: sum.nemesis.n } : null,
    });
  }

  // 6. Nests and fixes that held.
  if (sum.nestsCleared || sum.held || sum.cleanFixes || sum.rematchesWon) {
    out.push({
      id: 'fixes', eyebrow: 'Fixes that stuck', title: sum.held ? `${plural(sum.held, 'fix', 'fixes')} held for 2+ weeks` : 'Bugs that stayed fixed',
      lines: [
        sum.nestsCleared ? `${plural(sum.nestsCleared, 'bug nest')} cleared.` : null,
        sum.cleanFixes ? `${plural(sum.cleanFixes, 'clean fix', 'clean fixes')}, each with a test that proves it.` : null,
        sum.rematchesWon ? `${plural(sum.rematchesWon, 'rematch', 'rematches')} won against bugs that came back.` : null,
      ].filter(Boolean),
    });
  }

  // 7. The reef.
  const reef = ctx.reef && ctx.reef.project ? ctx.reef : null;
  if (reef || sum.reefBests || sum.thrivingMax) {
    out.push({
      id: 'reef', eyebrow: 'The reef', title: sum.thrivingMax ? `${plural(sum.thrivingMax, 'reef')} thriving` : 'Your reefs grew',
      lines: [
        reef ? `Biggest improvement: ${reef.signal} ${n(reef.from)} → ${n(reef.to)} in ${reef.project}.` : null,
        sum.reefBests ? `${plural(sum.reefBests, 'new best')} across your projects.` : null,
      ].filter(Boolean),
    });
  }

  // 8. Reviewer.
  if (sum.quizzes || sum.reviewCaught || sum.reviewTier) {
    out.push({
      id: 'review', eyebrow: 'Reviewer', title: sum.reviewCaught ? `${plural(sum.reviewCaught, 'catch', 'catches')} before merge` : 'You read the diffs',
      lines: [
        sum.quizzes ? `${plural(sum.quizzes, 'quiz', 'quizzes')} passed on Claude's work.` : null,
        sum.reviewTier ? `Review tier ${n(sum.reviewTier)} reached.` : null,
      ].filter(Boolean),
    });
  }

  // 9. Tides.
  if (sum.medals || sum.tidePerfect) {
    out.push({
      id: 'tides', eyebrow: 'Tides', title: `${plural(sum.medals, 'medal')} won`, big: n(sum.medals), unit: sum.medals === 1 ? 'medal' : 'medals',
      lines: [sum.tidePerfect ? `${plural(sum.tidePerfect, 'perfect tide')}: every goal in the first half.` : null].filter(Boolean),
    });
  }

  // 10. New tank pieces and trophies.
  if (sum.piecesEarned.length || sum.trophies.length) {
    const pieces = sum.piecesEarned.map(k => ({ key: k, name: name(ctx.pieceName, k) || k }));
    out.push({
      id: 'pieces', eyebrow: 'New for his tank', title: pieces.length ? `${plural(pieces.length, 'new piece')} for the tank` : `${plural(sum.trophies.length, 'trophy', 'trophies')}`,
      lines: [
        sum.trophies.length ? `${plural(sum.trophies.length, 'trophy', 'trophies')} earned.` : null,
        ...pieces.slice(0, 3).map(p => p.name),
      ].filter(Boolean),
      pieces,
    });
  }

  // 11. Deep cuts (the wrapped-extra perk, docs/GAMIFICATION-PLAN.md 2.3).
  if (ctx.deepCuts) {
    const first = sum.firstTaskAt ? new Date(sum.firstTaskAt) : null;
    out.push({
      id: 'deep', eyebrow: 'Deep cuts', title: 'For the completionists',
      lines: [
        first ? `Your first task of the year: ${MONTHS[first.getMonth()]} ${first.getDate()}, at ${hourName(first.getHours())}.` : null,
        sum.focusSessions ? `${plural(sum.focusSessions, 'focus session')}.` : null,
        sum.finds ? `He dug you up ${plural(sum.finds, 'gift')}.` : null,
        ...sum.topKinds.slice(1).map(k => `${n(k.xp)} XP from ${KIND_WORDS[k.kind] || k.kind}.`),
      ].filter(Boolean),
    });
  }

  // 12. The card.
  out.push({ id: 'card', eyebrow: `Shellby Wrapped ${sum.year}`, title: 'Your year, on a card', lines: ['Save it, copy it, post it.'] });
  return out;
}

/** The six tiles on the Wrapped card: the year's biggest numbers, by how much there is to say. */
function cardTiles(sum) {
  if (!sum) return [];
  const all = [
    ['XP', sum.xp], ['days together', sum.activeDays], ['bugs caught', sum.catches], ['pushes', sum.ships],
    ['tasks', sum.tasks], ['levels gained', sum.levelsGained], ['fixes held', sum.held], ['nests cleared', sum.nestsCleared],
    ['medals', sum.medals], ['caught in review', sum.reviewCaught], ['day streak', sum.longestStreak], ['new pieces', sum.piecesEarned.length],
  ];
  const fixed = all.slice(0, 2);
  const rest = all.slice(2).filter(([, v]) => v > 0);
  return [...fixed, ...rest].slice(0, 6).map(([label, v]) => [label, n(v)]);
}

module.exports = { slides, cardTiles, WEEKDAYS };
