// "Describe it" on the Routines page: one short, tool-less `claude -p` call
// turns "every weekday at 8:30, list what changed in my Documents" into the
// fields of the routine editor. Nothing is saved here; the draft opens in the
// editor and the user presses Save themselves, so the editor is the review.
const { validateRoutine } = require('./routines');

const MAX_DESCRIPTION = 500;
const DRAFT_TIMEOUT_MS = 90000;
// Fast and cheap: it only has to fill in a form.
const DRAFT_MODEL = 'haiku';
// Autonomous is never offered: a routine only gets it from the user's own hand.
const DRAFT_MODES = ['smart', 'ask', 'acceptEdits', 'plan'];
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;

const SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Short title, at most 60 characters' },
    prompt: { type: 'string', description: 'The instruction Claude Code will be given on every run' },
    schedule: {
      type: 'object',
      properties: {
        type: { enum: ['daily', 'weekly', 'interval'] },
        time: { type: 'string', description: 'HH:MM, 24-hour; daily and weekly only' },
        days: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 }, description: '0 = Sunday ... 6 = Saturday; weekly only' },
        everyHours: { type: 'integer', minimum: 1, maximum: 168, description: 'interval only' },
      },
      required: ['type'],
    },
    mode: { enum: DRAFT_MODES },
    folder: { type: 'string', description: 'Absolute path the task should run in, or "" for the default' },
  },
  required: ['name', 'prompt', 'schedule', 'mode', 'folder'],
};

function systemPrompt({ home, defaultFolder }) {
  return [
    'You turn a person\'s description of a recurring chore into a scheduled Claude Code task for the Shellby app. Reply only with the structured output.',
    'name: a short title. prompt: a clear, self-contained instruction for Claude Code, written to it, under 1000 characters. Never tell it to delete anything unless the person asked for that.',
    'schedule: "daily" with time, "weekly" with time and days (0 = Sunday ... 6 = Saturday; weekdays are 1-5), or "interval" with everyHours. Use 24-hour HH:MM. If no time is given, pick a sensible one.',
    'mode: "plan" if it should only look and report, "acceptEdits" if it edits files in its folder, "ask" if it does something risky, otherwise "smart".',
    `folder: the absolute path to work in if the description names one, else "". The person's home folder is ${home}; the default folder is ${defaultFolder || home}.`,
  ].join('\n');
}

/** CLI arguments for one draft. The description goes in as a single argument, never through a shell. */
function draftArgs(description, { home, defaultFolder } = {}) {
  return [
    '-p', `Describe this as a routine: ${description}`,
    '--output-format', 'json',
    '--json-schema', JSON.stringify(SCHEMA),
    '--system-prompt', systemPrompt({ home, defaultFolder }),
    '--model', DRAFT_MODEL,
    // A form-filler needs no tools, no MCP servers and no history entry.
    '--tools', '',
    '--strict-mcp-config',
    '--no-session-persistence',
  ];
}

/** What the user typed -> cleaned text, or an error to show beside the box. */
function checkDescription(text) {
  const clean = typeof text === 'string' ? text.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim() : '';
  if (!clean) return { ok: false, error: 'Say what you want done and when.' };
  if (clean.length > MAX_DESCRIPTION) return { ok: false, error: `Keep it under ${MAX_DESCRIPTION} characters.` };
  return { ok: true, text: clean };
}

/**
 * The CLI's JSON reply -> editor fields { name, prompt, schedule, mode, cwd },
 * or an error. Only those fields come through: never an id, never enabled,
 * never Autonomous. `folderOk(path)` decides whether a suggested folder is kept.
 */
function parseDraft(stdout, { folderOk = () => false } = {}) {
  let reply;
  try { reply = JSON.parse(String(stdout).trim()); } catch { return { ok: false, error: "Claude's answer didn't come through. Try again." }; }
  if (!reply || typeof reply !== 'object') return { ok: false, error: "Claude's answer didn't come through. Try again." };
  if (reply.is_error) {
    const why = typeof reply.result === 'string' && /log ?in|sign ?in|auth/i.test(reply.result) ? ' Sign in to Claude Code in Settings first.' : '';
    return { ok: false, error: `Claude couldn't draft it.${why}` };
  }
  const out = reply.structured_output;
  if (!out || typeof out !== 'object' || Array.isArray(out)) return { ok: false, error: "Claude didn't fill in the routine. Try saying it another way." };

  const s = out.schedule && typeof out.schedule === 'object' && !Array.isArray(out.schedule) ? out.schedule : null;
  const folder = typeof out.folder === 'string' ? out.folder.trim() : '';
  const { routine, errors } = validateRoutine({
    name: typeof out.name === 'string' ? out.name.replace(UNSAFE, ' ').slice(0, 60) : out.name,
    prompt: typeof out.prompt === 'string' ? out.prompt.replace(UNSAFE, '') : out.prompt,
    mode: DRAFT_MODES.includes(out.mode) ? out.mode : 'smart',
    cwd: folder && folderOk(folder) ? folder : null,
    schedule: s && { type: s.type, time: s.time, days: s.days, everyHours: s.everyHours },
  }, { allowAutonomous: false });
  if (!routine) return { ok: false, error: `Claude's draft didn't fit: ${errors.join(' ')}` };
  const { name, prompt, schedule, mode, cwd } = routine;
  return { ok: true, draft: { name, prompt, schedule, mode, cwd } };
}

module.exports = { draftArgs, checkDescription, parseDraft, SCHEMA, DRAFT_MODES, MAX_DESCRIPTION, DRAFT_TIMEOUT_MS };
