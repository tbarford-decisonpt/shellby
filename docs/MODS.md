# Making Shellby react from a Claude Code mod

A [Claude Code mod](CLAUDE-CODE.md) is a TypeScript module that runs inside every Claude Code conversation on your PC. It can watch what Claude does and, with the Shellby plugin installed, make the crab on your desktop react: say something, celebrate, put on a hat, or tell it how he and the PC are doing.

This works for every conversation: Shellby's own tabs, your terminal, VS Code, Cursor and anywhere else Claude Code runs.

## What you need

- Claude Code 2.1.288 or newer (mods are new).
- The **Shellby plugin** installed and up to date (`/plugin install shellby@shellby`, or `/plugin update shellby@shellby`). Its MCP server is what the mod talks to.
- Shellby running. When he isn't, the calls fail quietly and the mod should carry on.

## The call

```ts
await $.mcp.call('plugin:shellby:shellby', 'say', { text: 'Build done.', mood: 'proud' })
```

`plugin:shellby:shellby` is the plugin's MCP server as `/mcp` lists it. The tools a mod should use:

| Tool | Arguments | What he does |
|---|---|---|
| `say` | `text` (up to 120 characters), `mood`: `happy` (default), `worried`, `thinking`, `proud` or `sleepy` | A line in his speech bubble. |
| `celebrate` | `reason` (optional, up to 120 characters) | Confetti and a little dance. Save it for real news: a red build gone green, a release. |
| `wear` | `item`, such as `"party hat"` | Puts on an accessory you've unlocked. The answer says what he actually put on. |
| `status` | none | His level and what he's up to, plus CPU/GPU/memory/disk if Health is on, as text. |

The answer is MCP's own shape: `{ content: [{ type: 'text', text }], isError }`.

The plugin has other tools (`add_routine`, `add_workflow`, `run_workflow`…). Leave those to Claude: they open a confirmation window and wait for you.

## Let the mod make the call

`$.mcp.call` goes through Claude Code's permission rules like any other MCP tool. Without an allow rule it can be refused: in `claude -p`, where there's nobody to ask, it is. So allow the tools your mod uses. In `~/.claude/settings.json`, or with **Toolbox → Rules** in Shellby:

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_shellby_shellby__say",
      "mcp__plugin_shellby_shellby__celebrate",
      "mcp__plugin_shellby_shellby__wear",
      "mcp__plugin_shellby_shellby__status"
    ]
  }
}
```

These four only make the crab react or read his status. They don't start anything, spend your plan or change files. A rule covers every caller, not just one mod: Claude and any other mod can then make him talk, dress him up or read your PC's temperatures without asking.

## Never let the crab break the mod

Shellby might be closed, the plugin missing or the rule not added yet. All of those end in a rejected call or `isError: true`. Catch the error, write it to the debug log and return the tool's result as it was. Don't make Claude wait on him either: start the call and don't `await` it in the hook's path.

```ts
async function tell($, tool: string, args: Record<string, unknown>) {
  try {
    const r = await $.mcp.call('plugin:shellby:shellby', tool, args)
    if (r.isError) $.ui.log(`Shellby didn't ${tool}: ${(r.content ?? []).map(c => c.text ?? '').join(' ')}`, { to: 'debug' })
  } catch (err) {
    $.ui.log(`Shellby didn't ${tool}: ${String(err?.message ?? err)}`, { to: 'debug' })
  }
}
```

The function takes `$` and sits at the top level of the module, because the mod engine only lets `$` be passed to top-level functions.

## A whole example: shellby-cheer

[`docs/mods/shellby-cheer`](mods/shellby-cheer/) is a complete mod. When a test run (`npm test`, `pytest`, `cargo test`, `go test`…) goes red, he says so, worried. When it's green again, he celebrates. Runs that don't change the colour stay quiet, so he doesn't cheer every passing test. Each folder keeps its own colour, and a run that was interrupted or whose runner isn't installed doesn't count.

To try it, copy the folder into `~/.claude/skills/`. Claude Code loads it in every session, and **Toolbox → Mods** in Shellby lists it with its switch and its tests. To check it from a terminal:

```bash
claude plugin validate docs/mods/shellby-cheer
claude plugin test docs/mods/shellby-cheer
```

The test stands in for both the engine and Shellby (`on('mcp.call', …)` beneath the mod), so it runs without the app.

## Or let Claude write one

**Toolbox → Mods → New mod** in Shellby opens a conversation that builds a mod from a sentence ("make Shellby put his hard hat on while a deploy runs"). The request already tells Claude how to reach the crab and to catch the errors.

## What Shellby shows about it

In **Toolbox → Mods**, a mod that calls `$.mcp.call` lists *Uses tools from your MCP servers* among what it can do. Claude Code's checker reports the call but not which server it reaches, so Shellby can't tell a mod that only talks to the crab from one that uses your GitHub server. Read the mod, or its `register.ts`, before you switch it on.
