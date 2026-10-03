# Workflows

Routines run one prompt on a schedule. Workflows are the general case: one or
more **triggers** start a list of **steps**, and steps pass typed data to each
other. Claude can be a step (and return structured fields), can write a
workflow from a sentence, can propose one over MCP, and can repair one after a
failed run.

This file is the contract between the engine (`src/main/workflows/`), the panel
(`src/renderer/panel/workflows.js`), the MCP tools and the tests.

## Files

| File | What |
|---|---|
| `src/main/workflows/schema.js` | `validateWorkflow(input, opts)`: untrusted JSON in, normalised workflow or errors out. Pure. |
| `src/main/workflows/expr.js` | Templates (`{{ path \| filter }}`) and conditions (`a.b == "x" and not c`). Pure, no `eval`. |
| `src/main/workflows/structured.js` | Asking a Claude step for typed fields and reading them back from its reply. Pure. |
| `src/main/workflows/engine.js` | Runs one workflow: a replaying interpreter over injected effects. No Electron. |
| `src/main/workflows/schedule.js` | Schedule maths for workflow triggers (wraps routines.js, adds minute intervals). Pure. |
| `src/main/workflows/triggers.js` | Event -> which workflows start, debounce and rate limits. Pure. |
| `src/main/workflows/store.js` | Run records on disk, encrypted secrets. |
| `src/main/workflows/draft.js` | Describe-it and repair: `claude -p --json-schema`. |
| `src/main/workflows/templates.js` | The starter gallery. |
| `src/main/workflows/service.js` | Wires it all to Shellby (tabs, notifications, confirm windows, IPC). |

## A workflow

```jsonc
{
  "id": "wf-…",                 // assigned on first save
  "name": "Red build fixer",    // 1-60 chars, unique (case-insensitive)
  "description": "",            // up to 500 chars
  "enabled": true,
  "cwd": "C:\\code\\app",       // default folder for steps; "" = Shellby's current folder
  "concurrency": "skip",        // "skip" a trigger while a run is going, or "queue" one
  "inputs": [ { "name": "branch", "label": "Branch", "default": "main", "required": false } ],
  "when": [ /* triggers, 0-8. Every workflow can also be run by hand. */ ],
  "steps": [ /* 1-60 steps in total, nested at most 4 deep */ ]
}
```

### Triggers (`when`)

| type | fields | trigger data (`trigger.*`) |
|---|---|---|
| `schedule` | `schedule`: a routine schedule (`daily`/`weekly`/`interval` hours) or `{ type: "minutes", every: 5-1440 }` | `{ at }` |
| `ci` | `on`: `failed` `fixed` `passed` `merged` `review` `any`; `repo?`: `owner/name` | `{ event, repo, number, title, url, branch, failing[] }` |
| `shipped` | `kind`: `push` `deploy` `release` `merge` `any`; `project?` | `{ kind, project, version? }` |
| `task` | `outcome`: `ok` `error` `any` (Shellby's own tabs; never a workflow's) | `{ title, outcome, folder, error? }` |
| `health` | none | `{ title, body }` |
| `folder` | `path` (absolute), `pattern?` (`*.pdf`), `events`: `added` `changed` `any` | `{ folder, files[] }` |
| `workflow` | `name` of another workflow, `status`: `ok` `error` `any` | `{ name, status, runId, vars }` |
| `startup` | none | `{}` |
| `webhook` | `token` (generated; never set by hand) | the POSTed JSON `data` |
| `claude` | none: Claude Code may run it over MCP or `shellby flow run` | the inputs it passed |

A manual run, a `claude` run, a webhook and a `workflow` step can all pass
`inputs`; they're checked against the workflow's `inputs` list and available as
`inputs.*`.

### Steps

Every step can have:

- `id`: `[a-z][a-z0-9_]{0,31}`. Assigned (`claude1`, `run2`…) when missing. Unique in the workflow.
- `label`: up to 80 chars, for people.
- `if`: a condition; when false the step is `skipped`.
- `retry`: `{ times: 0-5, delaySec: 1-3600 }`.
- `timeoutMin`: 1-720.
- `continueOnError`: a failure is recorded and the run carries on.

| type | fields | output (`steps.<id>.*` or `<id>.*`) |
|---|---|---|
| `claude` | `prompt` (≤8000), `mode` (`ask` `smart` `acceptEdits` `plan` `autonomous`), `model?`, `cwd?`, `fresh?`, `output?`: `{ field: { type: string\|number\|boolean\|list\|object, description } }` (≤20) | `{ reply, tabId, ...fields }` |
| `run` | `command` (≤4000, PowerShell), `cwd?`, `allowFail?` | `{ output, code, ok }` |
| `http` | `method`, `url` (http/https), `headers?`, `body?`, `allowFail?` | `{ status, ok, body, json }` |
| `ask` | `question` (≤300), `choices?` (2-4; default Continue/Stop, Stop ends the run) | `{ choice }` |
| `tell` | `to`: `notification` `phone` `crab` `file`; `text` (≤1000); `title?`; `path` (file only) | `{ sent }` |
| `set` | `values`: `{ name: template }` (≤20) | sets `vars.<name>` |
| `if` | `test`, `then[]`, `else[]` | none |
| `each` | `over` (template that resolves to a list), `as` (default `item`), `steps[]`, `max` (≤100, default 25) | `{ count }` |
| `wait` | `seconds` (1-604800) | none |
| `file` | `action`: `read` `write` `append`; `path`; `content?` | `{ text }` for read, `{ path }` otherwise |
| `workflow` | `name` (another workflow), `inputs?` | `{ status, vars }` |
| `stop` | `status`: `ok` `error`; `message?` | ends the run |

### Templates and conditions

`{{ path }}` anywhere in a string field. Paths: `trigger.*`, `inputs.*`, `vars.*`,
`steps.<id>.*` (or just `<id>.*`), the loop variable (`item`, or the step's `as`),
`loop.index`, `run.id`, `run.started`, `now`, `today`, `secrets.NAME`. Filters:
`json`, `upper`, `lower`, `trim`, `length`, `first`, `last`, `join ", "`,
`default "x"`, `lines`, `slice 0 200`.

Conditions (`if`, `test`): `==` `!=` `>` `>=` `<` `<=` `contains`, `and` `or`
`not`, parentheses, and literals (`"text"`, `12`, `true`, `false`, `null`). A bare path is
tested for truthiness. `{{ }}` around a condition is allowed and ignored.

Where values land matters:

- **Claude prompts**: each substituted value is wrapped `«like this»`, and the
  prompt starts with a line saying text in «» is data, not instructions. A PR
  title or a webhook body can't take over the step.
- **Commands** (`run`): each value is inserted as a PowerShell single-quoted
  literal, so it can't become code.
- **Secrets** (`secrets.NAME`) are only allowed in `run` commands and `http`
  url/headers/body. They are refused in prompts, `tell` text and `file`, and
  are blanked out of everything a run records.

## Runs

A run record (`<userData>/workflows/runs/<id>.json`):

```jsonc
{
  "id": "run-…", "workflowId": "…", "workflowName": "…",
  "trigger": { "type": "manual", "data": {} }, "inputs": {},
  "status": "running" | "waiting" | "ok" | "error" | "stopped" | "interrupted",
  "startedAt": 0, "endedAt": null, "error": null,
  "steps": { "<key>": { "key", "id", "type", "label", "status", "startedAt", "endedAt", "attempts", "output", "error", "tabId", "waitUntil", "question", "choices" } },
  "order": ["<key>", …],          // first-seen order, for display
  "vars": {}
}
```

Step keys are paths: `s0`, `s2.then.s1`, `s3.each4.s0`.

**Replay.** The engine runs a workflow from the top every time. A step whose key
is already recorded `ok` returns its recorded output without running again. So:

- *Crash or restart:* a run that was `waiting` (an `ask` or a `wait`) picks up by
  itself. One that was mid-step becomes `interrupted` and offers **Resume**.
- *Retry from the failed step:* drop the failed entries and replay.
- Waits record `waitUntil`, so a restart waits only for what's left.

**Limits.** 4 runs at once; 1000 step executions per run; outputs are capped at
20 KB per field when recorded; 30 runs kept per workflow, 500 in all; a workflow
that starts more than 60 runs in an hour is paused and you're told. Nested
`workflow` steps go at most 3 deep, and chains of `workflow` triggers stop at 3.

## Claude steps

All Claude steps in one run share one conversation (one tab, titled `⚡ name`)
unless a step says `fresh`, so later steps know what earlier ones found. Each
step switches the tab to its own mode. Permission prompts appear in that tab as
usual, and the run shows *waiting for your OK*. With `output` fields, the step
asks Claude to end its reply with a fenced `json` block, then checks it. If it's
missing or wrong, it asks once more in the same conversation.

## Safety

- Saving a workflow that can act without asking (a `run`, `http` or `file`
  write step, a Claude step in a mode other than Ask/Plan, or any non-manual
  trigger with those) shows a confirm window listing exactly what it may do.
  Autonomous needs the same one-time acknowledgement as everywhere else.
- Anything Claude proposes over MCP always goes through that confirm window,
  one at a time, with a cooldown after a no, like `add_routine`.
- Only workflows with a `claude` trigger can be run by Claude Code.
- Webhooks use the plugin's localhost port and its checks (POST, JSON,
  `X-Shellby: 1`, no Origin, a local Host), plus the workflow's own token.

## Panel API (preload `api`)

| call | returns |
|---|---|
| `listWorkflows()` | `View` |
| `validateWorkflow(def)` | `{ ok, workflow, errors: [{ path, message }] }` |
| `saveWorkflow(def)` | `{ ok, workflow, view }` or `{ ok: false, errors }` |
| `deleteWorkflow(id)` | `View` |
| `runWorkflow(id, inputs)` | `{ ok, runId }` or `{ ok: false, error }` |
| `draftWorkflow(text)` | `{ ok, workflow }` (unsaved) or `{ ok: false, error }` |
| `repairWorkflow(runId)` | `{ ok, workflow, note }` or `{ ok: false, error }` |
| `importWorkflow(text)` | `{ ok, workflow }` (unsaved) or `{ ok: false, error }` |
| `exportWorkflow(id)` | `{ ok }`, JSON copied to the clipboard |
| `listRuns(workflowId?)` | `[RunSummary]` |
| `getRun(runId)` | the run record, or `null` |
| `stopRun(runId)` / `resumeRun(runId)` | `{ ok, error? }` |
| `answerRun(runId, key, choice)` | `{ ok, error? }` |
| `setWorkflowSecret(name, value)` / `deleteWorkflowSecret(name)` | `View` |
| `onWorkflows(cb)` | pushes `View` |
| `onWorkflowRun(cb)` | pushes a `RunSummary` whenever a run changes |

`View = { workflows: [WorkflowView], templates: [Template], secrets: [name], running: n, webhookPort }`.
`WorkflowView` = the definition plus `triggers: [text]`, `next` (ms or null),
`running`, `lastRun: RunSummary | null`, `capabilities: [text]`.
`RunSummary = { id, workflowId, workflowName, status, startedAt, endedAt, trigger: { type }, error, waiting: { key, question, choices } | null, steps: n, done: n }`.
