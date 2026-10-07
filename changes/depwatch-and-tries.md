### New
- **Dependency watch beyond npm.** The weekly check now reads pnpm, Yarn (1 and 2+), Python (`uv.lock`, `poetry.lock`, `pylock.toml`, `Pipfile.lock` or pinned `requirements.txt`, through pip-audit), Rust (cargo-audit) and Go (`go list` and govulncheck) projects too, each by its own lockfile, and names the package manager on every row. A project whose checker isn't installed says what to install instead of failing, and **Bump & open a PR** asks Claude to use that project's own commands. Nothing a project ships gets to run while it's checked: no install scripts, no `.pnpmfile.cjs`, no Yarn release or plugins of its own, and Python packages are never installed or built.

### Changed
- **Try it N ways takes attachments.** Screenshots and files attached to the message go to every try. A file from the project points at each try's own copy of it, and one your last commit doesn't have goes to each try as a copy of its own, so no try edits your checkout.
