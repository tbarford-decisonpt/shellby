// Quests (quests.js): the features worth finding, one at a time. Moved here
// from progress.js unchanged, so the quest chapters (docs/GAMIFICATION-PLAN.md)
// grow in a file of their own. Kept out of main.js, which only wires it up.
const quests = require('../quests');

/** d: what main shares (main.js `shared`); needs d.awardXp from progress.js. */
function wireQuestLine(d) {
  // Quests (quests.js): the features worth finding, done the first time each
  // really succeeds. The scripted screenshots show a fresh line.
  function questsPanelView() {
    return quests.questsView(d.CAPTURE ? null : d.config.get('quests'));
  }

  function setQuests(next) {
    if (next && !d.CAPTURE) d.config.set({ quests: next });
    const v = questsPanelView();
    d.send(d.panel, 'quests', { view: v });
    return v;
  }

  // Called where each feature succeeds (a review sent, a branch made, a copy
  // merged home, work held for the reset). Only the first time counts.
  function questDone(id) {
    if (d.CAPTURE || !d.config) return;
    const r = quests.completeQuest(d.config.get('quests'), id, Date.now());
    if (!r.quest) return;
    d.config.set({ quests: r.state });
    const pick = q => q && { id: q.id, icon: q.icon, title: q.title, why: q.why, go: q.go };
    // The card first, so a level-up the XP brings lands after it.
    d.send(d.panel, 'quests', { view: questsPanelView(), done: pick(r.quest), next: pick(r.next), finished: r.finished });
    d.awardXp('quest', { label: r.quest.title });
    if (r.finished) d.awardXp('questline');
  }

  return { questDone, questsPanelView, setQuests };
}

module.exports = { wireQuestLine };
