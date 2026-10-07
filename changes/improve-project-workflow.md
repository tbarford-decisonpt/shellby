### New
- **Change notes for your releases.** Keep what's coming next as one small file per branch in a `changes/` folder, and the Releases card drafts the CHANGELOG entry from them (and suggests a minor version when one has something new). Cutting the release folds them in and tidies them away, so branches worked on side by side never fight over the top of the CHANGELOG.
- **Copies get their packages.** When a conversation moves into its own copy of a Node project, and your checkout already has exactly those packages installed from the npm registry, Shellby installs the same ones in the copy first, with install scripts skipped, so tests and lint work straight away.

### Changed
- **Work brought home has a commit message worth reading.** The commit for what a copy left uncommitted is named after the branch Claude chose ("fix: tall menu overflow"), not the first words of your prompt, so your history and release drafts say what changed.
