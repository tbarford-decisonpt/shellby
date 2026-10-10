### Changed

- **Releases wait for CI.** When a project's branch has commits that aren't pushed yet, CI has never checked them, so the Releases card no longer cuts over them without asking. **Push them first** sends just the branch, and once CI is green you cut the release. To go ahead without CI, tick "Release anyway".
