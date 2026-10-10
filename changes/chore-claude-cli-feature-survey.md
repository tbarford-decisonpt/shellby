### New
- **Replies appear as Claude writes them.** Words now stream into the conversation as Claude writes them, instead of the whole reply landing at once.
- **What you might ask next.** When Claude Code has a guess at your next message, it shows above the box. Tab or a click puts it in the box. Nothing is sent until you press Enter.
- **Helper crabs say what they're doing.** A helper's own words show in its lane and in a speech bubble over its crab on the desktop.
- **Your goal, pinned.** `/goal` pins the goal above the box until Claude meets it or you clear it with the ×.
- **Keep going when the model is busy.** Settings → Model → When it's busy can switch to another model when yours is overloaded, instead of failing the turn.
- **Claude in Chrome.** Settings → Model → Let Claude use Chrome lets new conversations work in your own Chrome through the extension.
- **Try it in safe mode.** Right-click a tab to run that conversation without your CLAUDE.md, skills, plugins, hooks or MCP servers. It's a quick way to check whether one of them is causing trouble. The tab wears a 🛟 until you turn it off.
- **Chat as one of your agents.** Toolbox → Chat as opens a conversation that one of your agents runs from its first message, with its own instructions, tools and model.
- **Cloud sessions from the palette.** Ctrl+Shift+P can pick up a cloud session here, start one from what's in the box, or reopen the conversation behind a pull request. Each opens in a terminal, where Claude Code asks first.
- **Conversations keep their names in Claude Code.** A tab's title is now the conversation's name in `claude --resume` and on claude.ai.

### Changed
- **Shellby checks what your Claude Code supports.** Newer options are only passed to a Claude Code that lists them, so an older install keeps working until it updates.
