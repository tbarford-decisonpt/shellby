# Team packs

A team pack is your Shellby setup for one repository, saved as a file **in the repo**: `.shellby/team.json`. Commit it, and everyone who works on the repo gets the same snippets, workflows, hooks, rules and MCP servers when they open it in Shellby, without copying anything across by hand. A new starter takes the lot with **Set it all up** and one confirmation.

[Community packs](https://x-salmon.github.io/shellby-packs/) are public and dress Shellby up. A team pack is about work, and it's only as public as your repo.

## Making one

1. Pick the repo's folder in Shellby (the folder button by the box).
2. Open **Toolbox → Team** and choose **Make a team pack**.
3. Tick what to share: your snippets, your workflows, the hooks and rules in your Claude Code settings, and your own MCP servers.
4. **Make it**, then commit `.shellby/team.json` and push.

**Edit pack** opens the same form later, with what's already in the pack ticked.

Shellby won't save a pack with anything in it that looks like a password, token or key. An MCP server goes in with its command or address and the *names* of its environment variables and headers (`GITHUB_TOKEN`, say), never their values: each teammate types their own when they add it. In workflows, the repo's own folder is written as `{repo}`, so the same file works wherever each teammate has cloned it. Shellby tells you if a workflow uses any other folder, and web hook addresses are never shared: each PC gets its own.

## Using one

When you open a repo with a team pack you haven't seen yet, Shellby says so ("acme has a team pack: 4 snippets, 2 workflows and a hook"), with **Set it up**. He says it again when the pack changes. **Toolbox → Team** lists everything in it and shows what you already have.

### Set it all up

The first time, the Team tab opens with a welcome card: what the team set the repo up with, and **Set it all up**. One confirmation window then lists every part in full (each snippet's text, each hook's exact command, each rule, each MCP server's command or address, and what each workflow can do on its own), and when you say yes it all goes in at once:

- snippets switch on for this repo,
- hooks and rules go in your own settings for this project (`.claude/settings.local.json`),
- MCP servers are added with `claude mcp add`, for just you in this project,
- workflows go on your Automate page, approved as if you'd saved them.

An MCP server that needs a token has a box for it on the card. What you type goes straight to Claude Code and isn't kept by Shellby. Leave a server's boxes empty and it waits for later; it stays on the list below with an **Add** button.

If the team changes the pack after you've set it up, the card comes back: "The team changed this pack since you set it up on Sat 3 Oct", with only what's new or different and **Set up the changes**. If the file changes while the confirmation window is open, nothing is added and Shellby asks you to have another look. A pack too long to show in one window is set up a part at a time instead.

### Already in the repo

Some of a team's setup needs no pack, because Claude Code already reads it from the repo: `CLAUDE.md`, and the agents, skills and commands in `.claude/`, and the servers in `.mcp.json` (Claude Code asks before starting those). The Team tab lists them under **Already in the repo for Claude Code**, so a new starter sees the whole setup in one place. Commit them rather than putting them in the pack.

| In the pack | What happens |
|---|---|
| **Snippets** | **Use these snippets** turns them all on for this repo: `/name` in the box, or `shellby do @name` in a terminal inside the repo. They stay up to date with the file, but if the team changes them they switch off until you've looked at the new ones. If you have your own snippet with the same name, yours runs. **Keep a copy** makes one yours to change. |
| **Workflows** | **Add** puts a copy on your Automate page, after the confirmation window has shown everything it can do on its own. If the team's version changes, **Update** does the same again. |
| **Hooks** | Suggestions. **Add** puts one in your Claude Code settings, either for just this project (`.claude/settings.local.json`) or for every project. The confirmation window shows the exact command first. |
| **Rules** | The same as hooks: added to your settings for this project or for everywhere. An allow rule asks first. |
| **MCP servers** | **Add** runs `claude mcp add` for just you in this project, after the confirmation window has shown the command or address. Fill in its tokens first: they're yours, and never come from the pack. If you already have a server by that name, yours stays. |

### What a team pack can't do

A pack is a file from a repository, and you might have cloned that repository from anyone, so nothing in it runs or switches on by itself:

- Snippets are only prompts, and they're sent only when you use one. They're off until you've read them and said yes, and any change switches them off again.
- Workflows, hooks, MCP servers and allow rules go through a confirmation window that shows each one in full, either one at a time or all together with **Set it all up**. A workflow added from a pack is approved and signed like one you saved.
- A pack can't hand you a token or a setting for an MCP server. If the file has values in it, Shellby leaves them out and says so.
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
  ],
  "mcpServers": [
    { "name": "github", "command": "npx -y @modelcontextprotocol/server-github", "env": ["GITHUB_PERSONAL_ACCESS_TOKEN"] },
    { "name": "linear", "url": "https://mcp.linear.app/mcp", "headers": ["Authorization"] }
  ]
}
```

- **snippets**: up to 50, the same as in **Toolbox → Snippets** (`name`, `text`, optional `hint` and `newTab`).
- **workflows**: up to 20, the `workflow` part of what a workflow's **Export** on the Automate page copies. `{repo}` stands for the repo's folder.
- **hooks**: up to 20, each one line: `event`, `matcher` (for events that take one), `command`, optional `timeout` in seconds, and an optional `about` that's shown instead of the event.
- **rules**: up to 50: `list` is `allow`, `ask` or `deny`, and `rule` is written the way Claude Code writes permission rules.
- **mcpServers**: up to 10, each with a `name` and either a `command` (one line, as you'd type it) or a `url` (`https://`, or `http://` for one on the same PC) with an optional `transport` of `http` or `sse`. `env` (for a command) and `headers` (for a url) are lists of names only. An optional `about` is shown beside it.

The file can be up to 512 KB. Anything in it that doesn't fit is left out, and **Toolbox → Team** says what and why. The rest still works.
