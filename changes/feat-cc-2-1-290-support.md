### New
- **Compact long conversations while they're idle.** A new switch in Settings, Claude Code (off unless you turn it on). A conversation of 200K tokens or more that sits quiet for 54 minutes is compacted just before its hour-long prompt cache runs out, so your next message doesn't send all of it again at full price. Claude Code does this in a terminal; now Shellby's tabs can too. It respects `"idleCompaction": false` and `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`, and it's quiet: no toast, phone ping or XP, just a line in the conversation saying so.

### Changed
- **Mods that can read your attachments say so.** Before you turn one on, the Toolbox now lists "Reads the pictures and documents you attach" for a mod that asks Claude Code for the images and documents on your messages.
