### Fixed

- Clicking a file link that points at a network share (`\\server\share\...`) no longer opens it. Just looking at one made Windows sign in to that computer with your account.
- Importing a tools file now skips any skill or agent that sets up hooks or MCP servers in its header, the same way it already skipped hook files. Those run commands, so they go through Mods and its own question.
- Only programs running as you can list or start your routines and workflows through Shellby's local port. The Shellby plugin now sends his token for them.
- The Downloads sorter and Red build fixer workflows mark file names and build-log text as something to read, not instructions to follow.
- More kinds of file that run when opened (`.jnlp`, `.wsc`, `.dll`, certificates and others) are shown in their folder instead of opened.
- Problem reports and the log hide GitLab tokens and Discord or Slack webhook addresses.
