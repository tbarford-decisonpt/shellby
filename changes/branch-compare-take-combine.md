### New
- **Take one file from the other try.** Comparing two tries now has **Take theirs** on every file, so you can keep this one but use the other's version of a single file. It never overwrites a file you've changed since you compared.
- **Combine them.** One button asks Claude to read the other try and bring its best parts into this one, then say what it took and why.
- **See how each try went.** A comparison shows each try's turns, time, last test run and the last thing Claude said, and marks every file as changed here, changed there, or changed by both since they split.

### Fixed
- **The original can compare with its branches.** A conversation in your own checkout now shows an **other tries** chip once it has been branched, so you can compare and keep one from there too, not only from a branch.
- **Branches get their packages.** A branch's copy now gets `node_modules` the way a conversation's own copy does, so its tests run straight away.
- **Shared folders are marked.** When a branch has to share the original's folder, both tabs show ⚠, since each sees the other's changes.
- **Every other try is listed.** The branch chip no longer stops at seven.
