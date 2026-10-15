# Ultracode runs

Claude Code's **ultracode** lets a turn run its Workflow tool: a script of phases
and many agents that goes on in the background. Shellby shows a run as a card in
the conversation, sends its agents out as helper crabs, and keeps a running
total of what it costs. This is not Shellby's own workflows (Automate), which
are a different thing with a similar name.

Code: `src/main/ultracode.js` (the run, pure), `src/main/session/ultra.js` (the
session's side), `src/renderer/shared/ultracode.js` (the keyword and the cost
words), `src/renderer/panel/ultracode.js` (the chip and the card).

## What Claude Code sends (checked against 2.1.299)

Read from the CLI's own schemas and code (`sdk-tools.d.ts` and the stream-json
event schemas in `claude.exe`), and played by `test/fixtures/fake-claude.js`.
No real run was made: one costs many agents' worth of tokens.

- **The keyword.** "ultracode" as a word in a prompt opts that turn into the
  Workflow tool (`workflowKeywordTriggerEnabled`, on by default). Claude Code
  adds a note to the turn; nothing comes back on the stream to say it did. It
  also needs dynamic workflows on and a model that supports them; when they're
  off the word does nothing. (`/effort ultracode` and the `ultracode` setting
  turn it on for a whole session; Shellby doesn't use those.)
- **The run** is a task with `task_type: 'local_workflow'`:
  - `task_started { task_id, tool_use_id, description, workflow_name }`:
    `description` is the script's `meta.description` (or "Dynamic workflow"),
    `workflow_name` its `meta.name`.
  - The Workflow tool's result, in `tool_use_result`:
    `{ status: 'async_launched', taskId, taskType, workflowName, runId }`.
    `runId` (`wf_…`) is what Claude resumes it by (`resumeFromRunId`).
  - `task_progress { usage: { total_tokens, tool_uses }, workflow_progress }`,
    sent at most every few seconds. `workflow_progress` is a snapshot of every
    phase (`{ type: 'workflow_phase', index, title }`) and agent so far
    (`{ type: 'workflow_agent', index, label, phaseIndex, agentType?, model?,
    state: start | progress | done | error, tokens?, toolCalls? }`). Throttled
    events leave it out.
  - `task_notification { status: completed | failed | stopped, summary }`.
- **Stop** is the `stop_task` control request with the run's `task_id`, as
  Claude Code's own TaskStop does.

## What isn't exposed, and what Shellby does about it

- **The agents aren't tasks.** They get no `task_started` of their own, so
  they reach the crew only through `workflow_progress`. Shellby makes a helper
  crab for the first few running ones (`MAX_VISIBLE_CRABS`) and counts the rest
  as "+N more", on the card and on the desktop.
- **No price.** An agent's `tokens` is one number, with no input/output split
  and no cost. So the card says "at least $X": what those tokens cost if every
  one were a cache read, the cheapest a token can be. If Claude Code reports
  real usage under the Workflow call (assistant events whose
  `parent_tool_use_id` is it), that counts instead when it's more. Whether it
  does wasn't verified.
- **The usage meters** get the run's tokens weighted as input, until real
  usage for it arrives; from then on that's what counts. What was estimated
  before it stays counted, so such a run can count a little twice.
- **The word typed by hand** opts a turn in too, chip or no chip, so it asks
  first the same way. A `/command` or `!` command never gets the word added.
- **Phases** only show once an agent in them has started: `meta.phases` is in
  the script, which Shellby doesn't parse.
- **Resume** isn't offered. A run lives inside its Claude Code process, so it
  stops when the conversation closes; Claude can resume it by its run id if
  asked, and the card says so.
