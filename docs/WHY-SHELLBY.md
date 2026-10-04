# Why Shellby, if you already use Claude Code?

> **Same Claude. Less babysitting.**
> Shellby isn't a smarter Claude. It's everything you'd otherwise build *around* Claude Code yourself, already built, plus a crab.

**[⬇ Download for Windows](https://github.com/x-salmon/shellby/releases/latest)** · [Back to the README](../README.md)

## The 10-second version

- 🧠 **It's the real `claude`.** The official CLI you installed and signed in to, on your own Pro or Max plan. No model of its own, no fork.
- 🔁 **Nothing to migrate.** Your skills, agents, hooks, MCP servers, `CLAUDE.md` files and permission rules carry over, and anything you set up in Shellby works in your terminal too.
- 🛠️ **The difference is the tooling.** Parallel work, undo, review, scheduling and alerts, so you don't have to script them yourself.

<sub>Under the hood: Shellby drives the CLI over the same stream-json protocol the Claude Agent SDK uses.</sub>

---

## 🌿 Do more at once

- **Two tasks, one repo, no collisions.** Every tab can get its own copy of the project on its own branch. **Bring it home** merges it back, never force-pushes, and stops cleanly if it would clash.
  <br><sub>Instead of: making a worktree, opening another terminal, remembering to merge and clean up.</sub>
- **Try two approaches, keep the winner.** **⑂ Branch** from any turn, compare the tries file by file, then click **Keep this one**.
  <br><sub>Instead of: resuming the session twice, tracking which is which, diffing by hand.</sub>
- **See what your subagents are up to.** Each helper gets its own lane (task, activity, tools, tokens, time) and its own crab on your desktop. Permission cards tell you which helper is asking.
  <br><sub>Instead of: scrolling the transcript.</sub>

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

## ↩️ Review it, undo it

- **Undo any turn.** Every turn ends with a list of the files it changed. **Undo** puts them back, including whatever a script or `npm install` did, and refuses if you've edited them since.
  <br><sub>Instead of: <code>git diff</code>, <code>git stash</code>, and hoping nothing else touched the tree.</sub>
- **Say "not like that" to specific lines.** Click line numbers in the diff, leave comments across files and turns, and send them all as one follow-up that quotes the code.
  <br><sub>Instead of: pasting code into a message and describing where it is.</sub>

## ⏰ Let it run while you're away

- **Use your limit the moment it resets.** Queue heavy work on **Routines**. It starts at the reset, keeps the PC awake, picks up after the next reset if it runs out, and tells your phone.
  <br><sub>Instead of: setting an alarm, or a scheduled task wrapping <code>claude -p</code>.</sub>
- **React to a red build, a release or a new file.** **Workflows** pair a trigger with a list of steps: Claude, PowerShell, web requests, a question for you, a message to your phone.
  <br><sub>Instead of: writing the watcher, the script and the notifier yourself.</sub>
- **Never miss a permission prompt.** He raises a claw on your desktop, or your phone buzzes, and you can answer **Allow** or **Deny** right there.
  <br><sub>Instead of: keeping one eye on the terminal.</sub>

## 🧰 One home for your setup

- **Everything in one Toolbox.** Skills, hooks, MCP servers, rules and `CLAUDE.md` each get an editor. Anything that lets Claude do more asks first in an isolated window, with a backup.
  <br><sub>Instead of: editing JSON and Markdown in five places.</sub>
- **Know what a conversation costs before you type.** **Toolbox → Lean** measures it, prices each plugin, and flags plugins that have sat idle for 21 days, with an undoable **Turn off**.
  <br><sub>Instead of: reading every plugin's manifest and guessing.</sub>
- **Share your setup with the team.** **Toolbox → Team** saves snippets, workflows, hooks and rules to `.shellby/team.json`. Nothing in it runs on its own.
  <br><sub>Instead of: a README section nobody follows.</sub>

## 🔒 Safer by default

- **No accidental secrets.** Before every push he makes, he scans the commits for keys, tokens and files like `.env`, and asks first.
  <br><sub>Instead of: a pre-commit hook, if you remembered to set one up.</sub>

---

## 🤝 You don't have to choose

Keep your terminal and your editor. With the [Shellby plugin](../claude-plugin/), he reacts to Claude Code sessions in **VS Code, Cursor, Windsurf, Zed, JetBrains and Windows Terminal**: he scuttles while Claude works, raises a claw when it needs permission, and sends out helper crabs for subagents. Add the status line and he sits right under the prompt.

```text
/plugin marketplace add x-salmon/shellby
/plugin install shellby@shellby
```

It works the other way too. `shellby do "write tests for src/app.js"` starts a task in Shellby from any terminal.

> **Most people use both:** the editor for focused work on the file in front of them, and Shellby for the parallel, long-running and scheduled work they'd rather not babysit.

## 🚦 Honestly, stick with the CLI or your editor if…

| If… | Because… |
|---|---|
| 🍎 You're on **macOS or Linux** | Shellby is Windows 10 and 11 only. |
| 📝 You want **diffs inline in your editor** | The official IDE extensions show changes in the file you're editing. Shellby's diff view is great for reviewing a whole turn, but it isn't your editor. |
| 🖥️ It's **headless**: CI, a server, SSH | `claude -p` is the right tool there. |
| 🚀 You want **every new feature on day one** | Shellby drives the CLI, so new features reach the terminal first. Now and then a CLI change needs a Shellby update to catch up. |
| 🪶 You want the **lightest footprint** | Shellby is an Electron app with a desktop layer. [What he costs when idle](DEVELOPMENT.md#what-he-costs-when-idle) has the numbers. |

## ❓ Questions developers ask

<details>
<summary><b>Does it use my plan or an API key?</b></summary>

Your plan. Shellby never sees your Claude sign-in. If `ANTHROPIC_API_KEY` or another provider is set on your PC, Settings warns that Claude Code may bill that instead, and **Always use my Claude plan** leaves them out.
</details>

<details>
<summary><b>Is it allowed?</b></summary>

Shellby automates the official Claude Code CLI you installed and signed in to yourself, and your use falls under [Anthropic's terms](https://www.anthropic.com/legal/consumer-terms). It's an independent project, not affiliated with or endorsed by Anthropic.
</details>

<details>
<summary><b>What does it send, and where?</b></summary>

Nothing goes to Shellby: it has no servers and no telemetry. The [privacy policy](../PRIVACY.md) lists every connection.
</details>

<details>
<summary><b>How much freedom does Claude get?</b></summary>

As much as you choose. There are five [permission modes](../README.md#permission-modes), from Ask first up to a fenced-off Autonomous mode that's never the default and can't be reached from a terminal. Your own allow and deny rules apply in every mode.
</details>

<details>
<summary><b>Can I read the code?</b></summary>

All of it, under the GPL-3.0. Start with [How Shellby drives Claude Code](DEVELOPMENT.md#how-shellby-drives-claude-code).
</details>

---

<p align="center">
  <b><a href="https://github.com/x-salmon/shellby/releases/latest">⬇ Download Shellby for Windows</a></b><br>
  <sub><a href="CLAUDE-CODE.md">Everything he does with Claude Code</a> · <a href="../README.md">Back to the README</a></sub>
</p>
