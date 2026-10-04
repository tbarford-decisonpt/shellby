# Workflows

A workflow is a list of steps that something starts: a schedule, a red build, a
release, a new file in a folder, another workflow, a script, Claude Code, or
you. Steps hand each other data, so "Claude, find out why this failed" can
decide whether the next step fixes it or tells you about it.

They live on the **Automate** page (the bottom bar, or <kbd>Ctrl</kbd>+<kbd>4</kbd>).

## Three ways to make one

- **Describe it.** Type what should happen and when ("when a pull request
  goes red, find out why, and if it's simple fix it and ask me before
  pushing") and press **Draft it**. Claude writes the workflow and it opens
  in the editor for you to check. Nothing is saved until you press Save.
- **Start from a template:** red build fixer, morning brief, site watch,
  downloads sorter, release notes, disk space guard.
- **Build it** step by step in the editor, or paste one someone shared
  (**Import**).

Claude Code can also propose one from any session with the Shellby plugin
(`add_workflow`). You see the whole thing in Shellby's confirmation window
first.

## The map

The editor shows a workflow as a **map**: its triggers along the top, then
every step as a node, joined by wires in the order they run. An **If** splits
into a Then lane and an Otherwise lane side by side, and they join again
below. A **For each** wraps the steps it repeats in a loop.

- **Press a node** to change it. Its fields open beside the map (or under it,
  when the panel is narrow). <kbd>Esc</kbd> closes them.
- **Press a +** on a wire to add a step there, or **+ Trigger** to add a trigger.
- **Drag a step** onto any + to move it, into or out of an If or a loop. A +
  where it can't go doesn't light up.
- **Drag the background** or scroll to look around. <kbd>Ctrl</kbd>+scroll
  zooms, and **⛶** fits the whole workflow. With the map focused,
  <kbd>+</kbd>, <kbd>-</kbd> and <kbd>0</kbd> do the same, and <kbd>Delete</kbd>
  removes the node you're on.
- **Make room** (the arrows in the map's toolbar) widens the panel while a map
  is open and puts it back when you leave. Shellby remembers that you like it.
- **Settings** holds the description, default folder and what happens if it's
  already running. **Run by hand** holds the inputs.

**List** shows the same workflow as a list of cards, and **JSON** as text.
Shellby remembers which you used last.

## Triggers

| Trigger | Starts it… |
|---|---|
| Schedule | every day, on certain days, every few hours, or every 5-1440 minutes |
| Build | when a pull request's checks fail, go green again, pass, merge, or ask for your review (needs GitHub CI turned on) |
| Shipped | when a project is pushed, deployed, released or has a pull request merged |
| Task finished | when one of your Shellby tasks finishes (never a workflow's own) |
| Health | when something overheats or a drive fills up |
| Folder | when files arrive in (or change in) a folder, optionally matching a pattern like `*.pdf` |
| After a workflow | when another workflow succeeds, fails or either |
| Shellby starts | each time Shellby starts |
| Web hook | when a script calls its address (see below) |
| Claude Code | lets Claude Code (`run_workflow`) and `shellby flow run` start it |

Every workflow can also be run by hand with **Run**.

## Steps

| Step | Does |
|---|---|
| **Claude** | gives Claude Code a task, in a mode you pick. Add **output fields** and Claude hands back data (text, numbers, true/false, lists) for the steps after it. |
| **Command** | runs a PowerShell command and keeps its output and exit code |
| **Web request** | calls a web address (GET, POST…) and keeps the answer, parsed as JSON when it is |
| **Ask me** | stops and asks you, with your own choices or Continue / Stop. A notification and your phone say it's waiting. |
| **Tell me** | a notification, a message on your phone, a line from the crab, or a line added to a file |
| **Set values** | names a value for later steps |
| **If** | runs one list of steps or another |
| **For each** | repeats steps for every item in a list (up to 100) |
| **Wait** | for up to 7 days, even across a restart |
| **File** | reads, writes or adds to a file |
| **Run workflow** | runs another workflow and waits for it |
| **Stop** | ends the run, as done or as failed |

Every step can also retry, have a time limit, run only if a condition holds,
or carry on when it fails.

### Using values

Put `{{ … }}` in any text to use a value. The **{ }** button next to a field
lists what's available there, so you rarely need to type one.

```
{{ trigger.title }}               what started it (a PR's title, the files that arrived…)
{{ inputs.branch }}               an input you asked for when it ran
{{ diagnose.cause }}              a field from the step called "diagnose"
{{ check.json.items | length }}   with a filter: json, upper, lower, trim, length,
                                  first, last, join ", ", default "x", lines, slice 0 100
{{ item }}  {{ loop.number }}     inside For each
{{ now }}  {{ today }}  {{ secrets.API_KEY }}
```

Conditions read like `diagnose.fixable and check.status != 200`, with
`== != > >= < <= contains and or not` and brackets.

## Claude steps

All the Claude steps in one run share a conversation (a tab titled ⚡ and the
workflow's name), so a later step knows what an earlier one found. Tick
**Fresh conversation** to start a new one. If Claude needs your permission, it
asks in that tab as usual. When the run ends, its Claude Code process stops, and
the tab stays so you can read it or reply.

Values from outside (a PR title, a web page, a file) reach Claude marked as
data, with a note saying they're data, not instructions.

## Runs

**Runs** shows every run: what started it, each step's status, how long it
took, what it returned and any error. A run opens as a map of its workflow,
with every node coloured by how its step went, the wires lit along the way it
took, and the lane an If didn't take dimmed. It opens on whatever needs you: a
question waiting for an answer, or the step that failed. Press any node for
its output (each pass of a loop is listed), the first node for what started
it, and the last for the values it ended with. **List** shows the timeline
instead. From there you can:

- answer a step that's asking you,
- **Stop** a run,
- **Retry from the failed step**: what already finished isn't done again,
- **Fix with Claude**: Claude reads the workflow and the failed run, and
  proposes a corrected version in the editor.

A run waiting on you (or on a timer) when Shellby closes carries on when it
starts again. One that was in the middle of a step waits for you to resume it,
since Shellby can't know how far that step got.

## Secrets

Keep API keys and tokens in **Secrets** at the bottom of the Automate page, and
use them as `{{ secrets.NAME }}`. They're encrypted by Windows, never shown
again, only allowed in commands and web requests (never in a prompt, a message
or a file), and blanked out of everything a run records.

## Web hooks

Add the **Web hook** trigger and save, and the workflow gets an address on
Shellby's local port (it needs **Settings → Claude Code everywhere** turned on):

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:47913/v1/flow `
  -Headers @{ 'X-Shellby' = '1' } -ContentType 'application/json' `
  -Body '{"hook":"<the token shown in the editor>","data":{"version":"1.2.0"}}'
```

`data` arrives as `{{ trigger.* }}`, and any field named like one of the
workflow's inputs fills that input. Only programs on this PC can reach the port.
Web pages can't, and the token is the workflow's own.

## From the terminal and from Claude

```powershell
shellby flow list
shellby flow run "Release notes" version=1.2.0
```

From a Claude Code session with the plugin: `list_workflows`, `run_workflow`
and `add_workflow`. Only workflows with the **Claude Code** trigger can be run
this way, and Claude can't pick Autonomous for a step.

## Safety

- Saving a workflow that can act without asking (a command, a web request, a
  file write, a Claude step in Smart, Auto-edit or Autonomous) shows exactly
  what it may do in Shellby's confirmation window. It asks again only when one
  of those things changes.
- At most 4 runs go at once, and the rest wait their turn. A workflow that
  starts more than 60 times in an hour is paused, and you're told.
- A folder workflow only watches the top level of its folder, and ignores
  changes for a moment after its own run, so tidying files into subfolders
  can't set it off again.
- Workflows can call each other at most 3 deep, and "after a workflow" chains
  stop after 3 hops.

## Sharing

**Export** copies a workflow as JSON, without its id or web hook token. Anyone
can **Import** it, and it opens in their editor to check before saving.
