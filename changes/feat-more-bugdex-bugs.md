### New
- **Seventeen new bugs for the Bugdex.** The book now has 83 bugs to catch, up from 66, and every habitat that had a gap gets something new. Look out for broken JSON, React render loops, hydration mismatches, duplicate keys, missing database tables, rate limits, git without a repo, overwritten local changes, branches that aren't there, a sulking Docker daemon, garbled text encodings, unused Go variables, tests that time out or never run, 401s and 403s, missing env vars, and SSH keys git won't accept. Each one has its own portrait and field notes.

### Fixed
- **Some errors were filed as the wrong bug.** Broken JSON was caught as a Syntax Slug, an SSH key rejection as a Locked Limpet, a missing `os.environ` key as a Keyless Krill, and a test timeout as a Dawdling Snail. Each one now has its own bug. Raising a test's timeout no longer counts as fixing it.
