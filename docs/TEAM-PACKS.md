# Team packs

A team pack is your Shellby setup for one repository, saved as a file **in the repo**: `.shellby/team.json`. Commit it, and everyone who works on the repo gets the same snippets, workflows, hooks and rules when they open it in Shellby, without copying anything across by hand.

[Community packs](https://x-salmon.github.io/shellby-packs/) are public and dress Shellby up. A team pack is about work, and it's only as public as your repo.

## Making one

1. Pick the repo's folder in Shellby (the folder button by the box).
2. Open **Toolbox → Team** and choose **Make a team pack**.
3. Tick what to share: your snippets, your workflows, and the hooks and rules in your Claude Code settings.
4. **Make it**, then commit `.shellby/team.json` and push.

**Edit pack** opens the same form later, with what's already in the pack ticked.

Shellby won't save a pack with anything in it that looks like a password, token or key. In workflows, the repo's own folder is written as `{repo}`, so the same file works wherever each teammate has cloned it. Shellby tells you if a workflow uses any other folder, and web hook addresses are never shared: each PC gets its own.

## Using one

When you open a repo with a team pack you haven't seen yet, Shellby says so ("acme has a team pack: 4 snippets, 2 workflows and a hook"). He says it again when the pack changes. **Toolbox → Team** lists everything in it and shows what you already have.

| In the pack | What happens |
|---|---|
| **Snippets** | **Use these snippets** turns them all on for this repo: `/name` in the box, or `shellby do @name` in a terminal inside the repo. They stay up to date with the file, but if the team changes them they switch off until you've looked at the new ones. If you have your own snippet with the same name, yours runs. **Keep a copy** makes one yours to change. |
| **Workflows** | **Add** puts a copy on your Automate page, after the confirmation window has shown everything it can do on its own. If the team's version changes, **Update** does the same again. |
| **Hooks** | Suggestions. **Add** puts one in your Claude Code settings, either for just this project (`.claude/settings.local.json`) or for every project. The confirmation window shows the exact command first. |
| **Rules** | The same as hooks: added to your settings for this project or for everywhere. An allow rule asks first. |

### What a team pack can't do

A pack is a file from a repository, and you might have cloned that repository from anyone, so nothing in it runs or switches on by itself:

- Snippets are only prompts, and they're sent only when you use one. They're off until you've read them and said yes, and any change switches them off again.
- Workflows, hooks and allow rules go through the same confirmation windows as when you add them yourself, and each one is shown in full. A workflow added from a pack is approved and signed like one you saved.
- The pack can't pick where things go or point at files outside the repo. Shellby reads the file and decides.

### Hooks every teammate must run

If the whole team should always run a hook (a formatter, say), put it in the project's shared Claude Code settings, `.claude/settings.json`, instead: **Toolbox → Hooks**, *This project, shared*. Claude Code already shares that file through the repo. The team pack is for hooks each person can choose, like a sound when Claude finishes.

## The file

You don't have to write it by hand, but it's plain JSON and fine to edit or review in a pull request:

```json
{
  "kind": "shellby-team-pack",
  "version": 1,
  "name": "Acme web",
  "about": "How we work on the web app",
  "snippets": [
    { "name": "ship", "text": "Get $ARGUMENTS ready to merge: rebase on main, run npm test, and write the PR description.", "hint": "a branch" }
  ],
  "workflows": [
    {
      "name": "Check before a release",
      "cwd": "{repo}",
      "steps": [{ "id": "test", "type": "run", "command": "npm test" }]
    }
  ],
  "hooks": [
    { "event": "Stop", "command": "bash -c 'echo done'", "about": "Says when Claude is done" }
  ],
  "rules": [
    { "list": "deny", "rule": "Bash(git push --force:*)" }
  ]
}
```

- **snippets**: up to 50, the same as in **Toolbox → Snippets** (`name`, `text`, optional `hint` and `newTab`).
- **workflows**: up to 20, the `workflow` part of what a workflow's **Export** on the Automate page copies. `{repo}` stands for the repo's folder.
- **hooks**: up to 20, each one line: `event`, `matcher` (for events that take one), `command`, optional `timeout` in seconds, and an optional `about` that's shown instead of the event.
- **rules**: up to 50: `list` is `allow`, `ask` or `deny`, and `rule` is written the way Claude Code writes permission rules.

The file can be up to 512 KB. Anything in it that doesn't fit is left out, and **Toolbox → Team** says what and why. The rest still works.
