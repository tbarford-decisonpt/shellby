### Fixed
- **Nothing he started outlives him.** Quitting now ends every task still running in the background (a one-off Claude Code run, a workflow's MCP server, a sign-in), and the packages a new copy installs are stopped, along with everything npm started, if they take too long or you quit.
- **Closing a tab mid-turn no longer muddles other tabs' changes.** A conversation closed while it was working kept claiming the files it had touched, so other conversations' diffs and Undo could leave them out.
- **A copy that can't be made says why.** With no git on the PC he used to say the folder wasn't a repository; and a folder of copies he couldn't write to (no permission, a full disk, too long a path) now gets a sentence instead of silence.
- **Long conversations stay light.** Helpers that finished long ago are let go instead of piling up for the life of the conversation.
