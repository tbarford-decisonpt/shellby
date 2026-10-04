# Why Shellby, if you already use Claude Code?

**Same Claude, more around it.** Shellby doesn't have a model of its own, and it isn't a fork. Each conversation is the official `claude` you installed and signed in to, on your own Pro or Max plan, driven over the same stream-json protocol the Claude Agent SDK uses. Your skills, agents, hooks, MCP servers, `CLAUDE.md` files and permission rules all carry over, and anything you set up in Shellby works in your terminal too.

So the question isn't "is Shellby smarter than Claude Code?" It isn't. It's "do I want to build the tooling around Claude Code myself?" This page is the honest answer to that.

[Back to the README](../README.md)

## What you'd do yourself, and what he does

| You want to… | On your own | In Shellby |
|---|---|---|
| **Run two tasks in one repo at once** | Make a worktree, open another terminal, remember to merge it and clean up | Every tab can get its own copy of the project on its own branch. **Bring it home** merges it back, never force-pushes, and stops cleanly if it would clash |
| **Try two approaches and keep the better one** | Resume the session twice, keep track of which is which, diff by hand | **⑂ branch** from any turn, compare the tries file by file, **Keep this one** |
| **See what a turn changed, and take it back** | `git diff`, `git stash`, hope nothing else touched the tree | Every turn ends with its files changed. **Undo** puts them back, including what a script or `npm install` did, and refuses if you've changed them since |
| **Tell Claude "not like that" about specific lines** | Copy the code into a message and describe where it is | Click line numbers in the diff, leave comments across files and turns, send them as one follow-up that quotes the code |
| **Know what your subagents are doing** | Scroll the transcript | Each helper gets its own lane (task, activity, tools, tokens, time) and its own crab on your desktop. Permission cards say which helper is asking |
| **Find out what a conversation costs before you type** | Read every plugin's manifest and guess | **Toolbox → Lean** measures it, prices each plugin, and marks the ones idle for 21 days with an undoable **Turn off** |
| **Manage skills, hooks, MCP servers, rules and `CLAUDE.md`** | Edit JSON and Markdown in five places | One **Toolbox** with an editor for each. Anything that lets Claude do more asks first in an isolated window, with a backup |
| **Run something heavy when your limit resets** | Set an alarm, or a scheduled task wrapping `claude -p` | Queue it on **Routines**. It starts at the reset, keeps the PC awake, carries on after the next reset if it runs out, and tells your phone |
| **React to a red build, a release or a new file** | Write the glue: a watcher, a script, a notifier | **Workflows**: a trigger and a list of steps (Claude, PowerShell, web requests, a question for you, a message to your phone) |
| **Not push a secret by accident** | A pre-commit hook, if you set one up | Every push he makes checks the commits for keys, tokens and files like `.env` first, and asks |
| **Notice Claude needs you while you're in another window** | Keep an eye on the terminal | He raises a claw on your desktop, or your phone buzzes, and you can answer Allow or Deny from there |
| **Share your setup with the team** | A README section nobody follows | **Toolbox → Team** saves snippets, workflows, hooks and rules to `.shellby/team.json`. Nothing in it runs on its own |

<table>
<tr>
<td width="50%"><img src="screenshot-crew.png" alt="Three helper agents in crew lanes; one asks to run a script it wrote"></td>
<td width="50%"><img src="screenshot-lean.png" alt="Toolbox → Lean: every new conversation carries about 24k tokens; plugins priced, with two marked idle"></td>
</tr>
<tr>
<td align="center"><sub>Helpers in parallel lanes</sub></td>
<td align="center"><sub>What every conversation carries, priced</sub></td>
</tr>
</table>

## You don't have to choose

Keep your terminal and your editor. The [Shellby plugin](../claude-plugin/) makes him react to Claude Code sessions in VS Code, Cursor, Windsurf, Zed, JetBrains and Windows Terminal: he scuttles while Claude works, raises a claw when it needs permission, and sends out helper crabs for subagents. Add the status line and he sits right under the prompt.

```text
/plugin marketplace add x-salmon/shellby
/plugin install shellby@shellby
```

Going the other way, `shellby do "write tests for src/app.js"` starts a task in Shellby from any terminal. Most people end up using both: the editor for focused work on the file in front of them, Shellby for the parallel, long-running and scheduled work they'd rather not babysit.

## Stick with the CLI or your editor if…

- **You're on macOS or Linux.** Shellby is Windows 10 and 11 only.
- **You want diffs inline in your editor.** The official IDE extensions show changes in the file you're editing. Shellby has its own diff view, which is good for reviewing a whole turn but isn't your editor.
- **It's headless:** CI, a server, an SSH session. `claude -p` is the right tool there.
- **You want every new Claude Code feature the day it ships.** Shellby drives the CLI, so new features reach the terminal first, and now and then a CLI change needs a Shellby update to catch up.
- **You want the lightest possible footprint.** Shellby is an Electron app with a desktop layer. [What he costs when idle](DEVELOPMENT.md#what-he-costs-when-idle) has the numbers.

## Questions developers ask

**Does it use my plan or an API key?** Your plan. Shellby never sees your Claude sign-in. If `ANTHROPIC_API_KEY` or another provider is set on your PC, Settings warns that Claude Code may bill that instead, and **Always use my Claude plan** leaves them out.

**Is it allowed?** Shellby automates the official Claude Code CLI you installed and signed in to yourself, and your use is under [Anthropic's terms](https://www.anthropic.com/legal/consumer-terms). It's an independent project, not affiliated with or endorsed by Anthropic.

**What does it send, and where?** Nothing to any server of Shellby's: there aren't any, and there's no telemetry. The [privacy policy](../PRIVACY.md) lists every connection.

**How much freedom does Claude get?** As much as you choose: five [permission modes](../README.md#permission-modes), from Ask first to a fenced-off Autonomous that's never the default and can't be reached from a terminal. Your own allow and deny rules apply in every mode.

**Can I read the code?** All of it, under the GPL-3.0. [How Shellby drives Claude Code](DEVELOPMENT.md#how-shellby-drives-claude-code) is the place to start.

**[⬇ Download for Windows](https://github.com/x-salmon/shellby/releases/latest)** · [Everything he does with Claude Code](CLAUDE-CODE.md)
