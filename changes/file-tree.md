### New
- **All files, beside the chat.** The Trail's drawer is now the File manager, with two tabs on its header line: All files (Ctrl+Shift+F), which it opens on, and Trail. All files shows the whole project of the conversation you're in. Each file has its git mark and +/− since the last commit, and each folder sums up what's under it, so a closed folder still tells you where the work is. As Claude works, files light up purple when read, orange when written and green when a commit lands, and their folders open while they're lit. The branch row shows how far ahead or behind you are and opens the worktree and branch menu.
- **Pick a file to talk about.** Click a file in All files and a chip above the box says it goes with your messages, so "this" means that file. Claude is told which file it is; nothing is read from it. The × clears it, and typing `@` and a path finds that file in the tree.

### Changed
- **Trail rows open in the file viewer.** A row's open button, a double-click or Shift+Enter shows the file in the viewer, as a file link in the chat does. Hold Ctrl to open your editor instead.

### Fixed
- **An empty Trail no longer slides its header down.** With nothing on it yet, the drawer picked up the welcome screen's spacing and its header sat partway down; it now stays at the top.
