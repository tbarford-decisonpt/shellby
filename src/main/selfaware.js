// Claude knowing it's in Shellby.
//
// Three parts, all priced against the user's plan, so all kept small:
//   systemNote()  a fixed note appended to Claude Code's system prompt. It never
//                 changes within a session, so it is cached with the rest of the
//                 system prompt and costs a fraction of its size per turn.
//   usageNote()   one bracketed line added to a user message when the plan's
//                 usage crosses 80% or 95%. It rides in the message, not the
//                 system prompt, so it never breaks the cache, and it only shows
//                 up when a threshold is crossed.
//   suggest*()    the rules for the `suggest` tool's one-tap cards. The limits
//                 live here, in code, rather than in the prompt asking nicely.
//
// Pure: callers pass `now` and state (test/selfaware.test.js).

const { scheduleError, describeSchedule } = require('./routines');

// What Claude can point people at. `where` is how a person finds it by hand;
// the card's button does the same thing in one tap.
const FEATURES = Object.freeze({
  routine: { name: 'Routines', where: 'the Routines screen', what: 'run a prompt on a schedule', title: 'Make this a routine?', button: 'Set it up' },
  focus: { name: 'Guard my focus', where: 'right-click the crab', what: '15, 25 or 50 minutes with notifications held back', title: 'Guard your focus?', button: 'Start' },
  review: { name: 'Look over my changes', where: 'Trophies & XP, the shield next to a project', what: 'a read-only security review of uncommitted and unpushed changes', title: 'Look over these changes?', button: 'Start a review' },
  notify: { name: "Tell me when I'm away", where: 'Settings, Elsewhere', what: 'a phone notification when Claude needs permission or a task finishes', title: 'Get pinged on your phone?', button: 'Open settings' },
});
const FEATURE_IDS = Object.keys(FEATURES);

const MAX_WHY = 120;
const MAX_NAME = 60;
const MAX_PROMPT = 2000;
const MAX_PER_CONVERSATION = 2;
const FOCUS_MINUTES = [15, 25, 50];

const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * The note appended to Claude Code's system prompt. Same input, same bytes:
 * anything that changes turn to turn belongs in usageNote, never here.
 *   { suggestions }: whether the `suggest` tool is offered
 */
function systemNote({ suggestions = true } = {}) {
  const lines = [
    "You are running inside Shellby, a Windows desktop app where a pixel hermit crab runs Claude Code on the user's own Claude plan. The user talks to you in Shellby's panel, not a terminal: permission prompts and your questions appear there as cards, files dropped on the crab arrive as \"Attached files\", and each subagent you start walks out as a helper crab.",
    'A line in a user message that starts with "[Shellby:" was added by the app, not typed by the user.',
    'The mcp__shellby__ tools make the crab say a short line, celebrate a real milestone, wear an accessory, or report his status and this PC\'s temperatures. Use them sparingly; never celebrate routine steps.',
    'When the user asks you to note something for later, mcp__shellby__note puts it on their Notes list for this project.',
  ];
  if (suggestions) {
    lines.push(
      'Shellby features you can offer:',
      ...FEATURE_IDS.map(id => `- ${FEATURES[id].name} (${FEATURES[id].where}): ${FEATURES[id].what}.`),
      'Offer one only when it directly solves what the user asked for, and only with mcp__shellby__suggest, which shows a card they can tap or ignore. Do not describe the feature in prose as well, and do not repeat an offer.',
    );
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ usage

const THRESHOLDS = [80, 95];
const WINDOW_NAMES = { fiveHour: '5-hour', sevenDay: 'weekly' };

// 0, 80 or 95: the highest threshold this percentage has crossed.
const levelOf = pct => THRESHOLDS.filter(t => Number.isFinite(pct) && pct >= t).pop() || 0;

function resetText(window, resetsAt, now) {
  if (!Number.isFinite(resetsAt) || resetsAt <= now) return null;
  const d = new Date(resetsAt);
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (window === 'fiveHour' || resetsAt - now < 20 * 3600000) return `resets ${time}`;
  return `resets ${d.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
}

/**
 * The usage line for the next user message, if one is due.
 *   usage: { fiveHour: { pct, resetsAt }, sevenDay } (config.lastUsage)
 *   told:  the level this conversation was last told about (0 = none)
 * -> { told, text }. `text` is null when there is nothing new to say. A window
 * that reset brings `told` back down, so the next climb is reported again.
 */
function usageNote(usage, told = 0, now = Date.now()) {
  const live = Object.keys(WINDOW_NAMES)
    .map(window => ({ window, ...(usage?.[window] || {}) }))
    .filter(w => Number.isFinite(w.pct) && !(Number.isFinite(w.resetsAt) && w.resetsAt <= now));
  const worst = live.sort((a, b) => b.pct - a.pct)[0];
  const level = worst ? levelOf(worst.pct) : 0;
  if (level <= told) return { told: level, text: null };
  const reset = resetText(worst.window, worst.resetsAt, now);
  const head = `[Shellby: the user's ${WINDOW_NAMES[worst.window]} Claude usage is at ${Math.min(100, Math.round(worst.pct))}%${reset ? ` (${reset})` : ''}.`;
  const advice = level >= 95
    ? ' Do only what is essential, skip helpers, and say where you stopped if you run out.]'
    : ' Keep this lean: targeted reads over broad searches, and ask before sending out helpers.]';
  return { told: level, text: head + advice };
}

/**
 * The prompt Claude receives: the user's own text, then the usage line if any.
 * A prompt with pictures is a list of blocks, and the line is one more.
 */
function withUsageNote(prompt, note) {
  if (!note) return prompt;
  return Array.isArray(prompt) ? [...prompt, { type: 'text', text: note }] : `${prompt}\n\n${note}`;
}

/** A /command has to reach Claude Code as typed: anything after it becomes its arguments. */
const isSlashCommand = prompt => typeof prompt === 'string' && prompt.trimStart().startsWith('/');

// ------------------------------------------------------------------ suggest

const DAY = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/**
 * The tool's compact schedule ("daily 08:30", "weekly mon,fri 17:00",
 * "every 4h") -> a routines.js schedule, or null. Compact on purpose: it is
 * one string in the tool schema instead of a nested object, which is fewer
 * tokens on every turn of every conversation.
 */
function parseSchedule(text) {
  const s = clip(text, 60).toLowerCase();
  const pad = t => t.padStart(5, '0');  // the routine editor's time field wants 08:30, not 8:30
  let m = /^daily (\d{1,2}:\d{2})$/.exec(s);
  let out = null;
  if (m) out = { type: 'daily', time: pad(m[1]) };
  m = /^weekly ([a-z, ]+?) (\d{1,2}:\d{2})$/.exec(s);
  if (m) {
    const days = [...new Set(m[1].split(/[ ,]+/).filter(Boolean).map(d => DAY[d.slice(0, 3)]))];
    if (days.every(d => d != null)) out = { type: 'weekly', time: pad(m[2]), days: days.sort() };
  }
  m = /^every (\d{1,2}) ?h(ours?)?$/.exec(s);
  if (m) out = { type: 'interval', everyHours: Number(m[1]) };
  return out && !scheduleError(out) ? out : null;
}

/**
 * Check a `suggest` call against the user's settings and this conversation.
 *   args:  the tool's input
 *   state: { enabled, muted: [feature], offered: Set<feature>, focusOn, notifyOn, inRepo }
 * -> { ok: true, card } | { ok: false, reason }. The reason goes back to
 * Claude as the tool result, so it says plainly that nothing was shown.
 */
function checkSuggestion(args, state = {}) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const feature = typeof a.feature === 'string' ? a.feature : '';
  const no = reason => ({ ok: false, reason: `Not shown: ${reason} Carry on without it.` });
  if (!FEATURES[feature]) return no(`there is no Shellby feature called "${clip(feature, 30)}".`);
  if (!state.enabled) return no('the user has turned suggestions off.');
  if ((state.muted || []).includes(feature)) return no(`the user asked not to be offered ${FEATURES[feature].name}.`);
  const offered = state.offered || new Set();
  if (offered.has(feature)) return no('it was already offered in this conversation.');
  if (offered.size >= MAX_PER_CONVERSATION) return no('this conversation has had enough suggestions.');
  const why = clip(a.why, MAX_WHY);
  if (!why) return no('say in a few words why it helps (`why`).');

  const card = { feature, why, title: FEATURES[feature].title, button: FEATURES[feature].button };
  switch (feature) {
    case 'routine': {
      const prompt = clip(a.prompt, MAX_PROMPT);
      const schedule = parseSchedule(a.schedule);
      if (!prompt) return no('a routine needs the `prompt` it would run.');
      if (!schedule) return no('`schedule` must look like "daily 08:30", "weekly mon,fri 17:00" or "every 4h".');
      card.draft = { name: clip(a.name, MAX_NAME) || prompt.slice(0, 40), prompt, schedule, when: describeSchedule(schedule) };
      break;
    }
    case 'focus':
      if (state.focusOn) return no('a focus session is already running.');
      card.minutes = FOCUS_MINUTES.includes(a.minutes) ? a.minutes : 25;
      card.button = `Guard it for ${card.minutes} min`;
      break;
    case 'review':
      if (!state.inRepo) return no('this folder is not a git repository.');
      break;
    case 'notify':
      if (state.notifyOn) return no('phone notifications are already set up.');
      break;
  }
  return { ok: true, card };
}

/** What Claude reads back after a card went up. */
function suggestReply(card) {
  return `Shown to the user as a card ("${card.title}"). It only happens if they tap it, so don't wait on it or mention it again.`;
}

module.exports = {
  FEATURES, FEATURE_IDS, FOCUS_MINUTES, MAX_PER_CONVERSATION, THRESHOLDS,
  systemNote, usageNote, withUsageNote, isSlashCommand, parseSchedule, checkSuggestion, suggestReply,
};
