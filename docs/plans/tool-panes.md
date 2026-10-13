# Panes that aren't conversations: a dev server, a copy's changes, a file

Partly built. It follows on from [split-panes.md](split-panes.md) and changes
that plan's central rule: "every pane is a group of conversation tabs".

**Built:** the model (tool ids in `shared/panes.js`) and the dev server log
(`renderer/panel/tool-tabs.js`), opened from a server's card. The open
questions were settled as follows: a tool is a tab id in a pane's slot; a tool
pane holds that tool alone; the log came first. The approval sheet on the
server's card stays the only way its error goes to Claude, so the pane's
button takes you there. Tool panes aren't kept over a restart, because the
servers they show stop with Shellby.

**Not built, on purpose:** Changes and File. The file viewer (0.83.0) already
shows a copy's changes and its files, one click away. Add them as kinds in
`tool-tabs.js` if docking them beside the chat turns out to be missed.

## What it's for

With several conversations side by side you often want something that isn't a
conversation next to them: the dev server's log while Claude fixes the crash,
what a copy has changed so far while it's still working, or the file under
discussion. Each of these already exists somewhere in Shellby (Projects →
dev servers, a turn's changes, the editor link), but only one screen or click
away from the chat.

## The three kinds

- **Dev server log** (`server:<id>`): the live log of one running server
  (`projects-servers.js` already streams it, with error lines marked), and its
  Restart and **Send the error to Claude** buttons. Follows the server across
  restarts; shows "stopped" once it's gone.
- **Changes** (`changes:<tabId>`): everything a conversation's copy has
  changed against where it started, file by file with diffs (the same
  renderer as a turn's changes, `feed-changes.js`), refreshed as turns end.
  Read-only: Undo stays on the turns.
- **File** (`file:<path>`): one file, read-only, refreshed when it changes on
  disk, with **Open in editor**. Never an editor: Shellby shows off Claude
  Code and your own editor, and doesn't become one.

## The model

The smallest change to `shared/panes.js`: a tab id can be a *tool id*, a
string with a kind prefix (`server:`, `changes:`, `file:`), and those tabs
live in panes like any other. So the grid, the sizes, dragging, zoom,
Alt+arrows, layouts and saving all keep working untouched.

What has to learn about them:

- `state.tabs` holds conversations only. A tool tab needs its own small
  record (`state.tools`: id -> { kind, el, title, destroy }) and every place
  that looks a pane's tab up in `state.tabs` (feeds, stand-ins, the strip,
  `paneTo`, the box) has to handle a tool. This is the bulk of the work.
- **The box.** A pane showing a tool has no conversation to talk to: no box
  and no stand-in. Focusing it leaves the box where it was (the last
  conversation pane focused). `focusedPane()` keeps meaning "the pane the
  box is in".
- **Saving.** `clean()` keeps a tool id if what it points at still exists
  (the server is configured, the conversation is open, the file is there),
  and drops it otherwise. Main's `openTabs` never gets tool ids.
- **Every conversation** (Ctrl+Shift+A) lists conversations only.

## Ways in

- Projects → a running server's card: **Show beside the chat**.
- A conversation's subbar, when it works in a copy: **Changes beside it**.
- A file path in the feed: right-click → **Show beside the chat**.
- Ctrl+K: each of the above for what's open now.

Each opens to the right of the focused pane, with the same room rules and
growing as Split.

## Open questions

1. Is the tool-id-in-a-tab-slot model acceptable, or should a pane have a
   `kind` of its own? (The former is far less code; the latter is cleaner if
   more kinds follow.)
2. Should a tool tab be able to share a pane with conversations, or should
   tool panes hold tools only?
3. Which of the three first? The dev server log is the most asked-for and the
   least new code.

## Tests

As split-panes.md: unit tests for `clean` with tool ids, e2e in
`e2e-panes.js` for opening each kind beside a conversation, the box staying
put when a tool pane is clicked, and a restart bringing a server pane back
(and dropping one whose server is gone).
