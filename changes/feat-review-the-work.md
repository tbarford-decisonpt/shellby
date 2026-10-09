### New

- A turn's changes read as a story. When Claude works in steps (edit, run the tests, fix, edit again), the files it changed come in numbered steps titled by what it said it was doing, each with its own line counts, and anything a command changed on its own is listed last.
- Rewind is a timeline. Esc Esc shows your messages as stops down a line, each one "before turn N", with how many files and lines going back there undoes.

### Fixed

- Rewinding or undoing an old turn no longer fails with "tidied away by git". Each turn's before and after are kept under Shellby's own private git refs (never a branch or the stash), the newest 200 turns per project.
