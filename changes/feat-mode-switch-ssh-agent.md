### New
- **Switch modes in one click.** Right-click him (or the tray icon) and pick Mode: Claude Code, Work mode or Just the crab. The same three sit at the top of Settings → Claude Code and in Ctrl+K. Leaving just the crab without Claude Code set up goes straight to its setup.

### Changed
- **Windows' ssh agent is optional.** When a key with a passphrase won't sign in, the first button is now Type my passphrase. A PC that can't run the agent (a work PC without admin rights) can choose Do without it, and Shellby stops suggesting it there. If turning the agent on fails, the message says you don't need it.

### Fixed
- **A passphrase box that couldn't open no longer looks like a wrong password.** On a PC that blocks Shellby's little passphrase helper, the sign-in step says so, instead of "it didn't accept the sign-in".
