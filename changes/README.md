# Change notes

What's coming in the next release, one file per branch, so branches never
edit the same lines of the CHANGELOG.

When your branch changes something people who use Shellby would notice, add
`changes/<short-name>.md` (the branch's name is a good one):

```markdown
### New
- **The headline.** A sentence or two on what it does for them.

### Fixed
- **What was wrong, now right.** How it shows up for them.
```

- Use `### New`, `### Fixed`, `### Faster` or `### Changed`. Any other heading
  (`### Removed`, say) is kept as it is.
- Write in the CHANGELOG's own voice: short, friendly, concrete, for the people
  who use Shellby rather than its developers. Work they'd never see (tests, CI,
  refactors) needs no note.
- Don't touch `version` in package.json or add a `## X.Y.Z` heading. That
  happens once, on main, when the release is cut.

`npm run release:cut -- X.Y.Z "Title"` on main gathers every note into one
CHANGELOG entry, deletes them, bumps the version, and commits and tags. The
Releases card on a project's page in Shellby does the same, for any project
with a `changes/` folder. `--dry-run` shows the entry without changing
anything.
