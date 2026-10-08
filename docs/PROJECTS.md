# Your projects and your day

The repos you work in, the dev servers in them, the hours you spend, the tests that flake and the dependencies that age. Back to the [README](../README.md).

## Projects and dev servers

<table>
<tr>
<td width="50%"><img src="screenshot-projects.png" alt="The Projects page: 3 need you, and each repo with what Shellby knows about it: unpushed commits, a flaky test, failing CI, a vulnerability, time this week, a dev server up on :5173 and one down"></td>
<td width="50%"><img src="screenshot-project-page.png" alt="One project's page: New conversation here, this week's hours with a bar for each day, the last commit, and Health with its pull request, dependencies and a flaky test to fix"></td>
</tr>
<tr>
<td align="center"><sub>What needs you, at a glance</sub></td>
<td align="center"><sub>Everything Shellby knows about one project</sub></td>
</tr>
<tr>
<td width="50%"><img src="screenshot-devserver.png" alt="A crashed dev server: npm run dev crashed 3 minutes ago, exit code 1, with the error lines marked in red"></td>
<td width="50%"><img src="screenshot-devserver-fix.png" alt="Ask Claude to fix it?: exactly what will be sent, a box for a note of your own, and Send to Claude or Not now"></td>
</tr>
<tr>
<td align="center"><sub>He reads the crash and marks the errors</sub></td>
<td align="center"><sub>Nothing goes to Claude until you've read it</sub></td>
</tr>
</table>

- **Projects** (<kbd>Ctrl</kbd>+<kbd>7</kbd>) lists your repos: the ones Shellby has seen you work in, plus any you add. **Add a repo…** takes one folder; **Scan a folder…** looks through a folder you pick and lists the repos in it for you to tick, adding nothing by itself. Sign in to GitHub and turn on **Show my repositories** to see those too. A clone and its GitHub repository are one project, however many clones you have.
- **What needs you.** Each row says what Shellby already knows about the project, in a few words: failing CI on a pull request, vulnerable or outdated packages, commits no remote has, tests that flaked this week, the hours you've spent on it this week, and how long it's been quiet. Trouble is coloured, the rest stays grey. The line at the top counts them (*"3 need you"*), and **Needs you** shows only those projects, worst first. **Recent** and **A–Z** order the rest, and the dropdown narrows it to the ones on this PC, running, or only on GitHub.
- **The inbox**, at the top of the page, is one list across every repo of what's waiting on you:
  - **Waiting on your review:** pull requests where you've been asked to review, with who opened them and when they last changed. **Read it with Claude** starts a conversation (in Ask first, whatever mode you're in) that reads the pull request and tells you what it changes, what looks risky, and what you might ask the author. It posts, approves and pushes nothing.
  - **New on your pull requests:** your own pull requests where someone has commented or reviewed since you last had your say, with who it was and whether they approved or asked for changes. Answering on github.com clears it by itself, and so do **Open** and **Mark read**. A new one makes him raise a claw and sends a notification. Comments from bots on the conversation (deploy previews, coverage reports) don't count. A bot's review of the code does.
  - **Stale branches:** local branches that are merged (by commit, or by patch after a rebase merge) or haven't had a commit in three weeks. Each one says what deleting it would lose. A merged branch has a plain **Delete**. A branch with commits that no other branch or remote has gets **What's on it?** (a question for Claude, put in the box for you to send) and **Delete…**, which asks first in Shellby's own window.
  - **Copies left behind:** copies Shellby made for a conversation that no open tab is working in and nobody has touched for three days. An empty one (nothing uncommitted, every commit somewhere else too) has **Remove**, which still asks if it would take files git ignores, like a `.env.local`, with it. One with work has **Open conversation**, so you can bring it home, and **Throw away…**, which asks first.
  - **Keep** takes a branch or copy off the inbox until it changes again (a new commit, more work). The pull-request half needs **Watch CI on my pull requests** (Settings → GitHub). The branches and copies are read from git a few repos at a time, every ten minutes or when you press **Refresh**.
- **Quick actions.** Point at a row (or tab to it) for **New conversation here** and **Start** (or **Open** a server that's up) without opening the project. **⋯** or a right-click has the rest: **Open folder**, **Open on GitHub**, **Clone…**.
- **A project's page** starts with **New conversation here**, then:
  - **Next up:** what to work on, ranked: your to-do list, its GitHub issues and milestones, and the TODOs in its code, each with **Do this** (see [Next up](#next-up)). The row on the list shows **3 to do**.
  - **Pulse:** hours this week with a bar for each day (while History → Time is on), the last commit, the last time you were in it, and whether he nudges you when it goes quiet.
  - **Health:** its pull requests' checks (**Fix this build** or **Ask why** on a red one, **Address the review** when reviewers left comments), its dependency check (**Bump & open a PR**) and its flaky tests (**Fix it**, **Quarantine**), the same tasks as on their own pages.
  - **Releases:** what's waiting to go out, e.g. *"v0.70.2 · 3 days ago · 14 commits since"*. The commits are grouped by kind (**New**, **Fixed**, **Faster**, **Changed**, with chores, tests and CI folded under **Behind the scenes**), read from conventional commit subjects (`feat:`, `fix(scope):`, `feat!:` for a breaking change). A line says whether CI passed on the commit you'd release. **Draft release** suggests the next version (a feature makes it a minor, a breaking change a major, or a minor before 1.0) with Patch / Minor / Major to pick from, and drafts the CHANGELOG entry in the style your CHANGELOG already uses (`## 1.2.0: Title`, Keep a Changelog's `## [1.2.0] - date`, or a plain `## 1.2.0`). It also lists, step by step, what **Cut release** will do:
    1. set `package.json` and `package-lock.json` to the new version
    2. add the entry to the top of the CHANGELOG
    3. make one commit (`1.2.0: Title`)
    4. add an annotated tag (`v1.2.0`)
    5. push the branch and the tag together, if **Push it** is ticked. If not, the card keeps a **Push v1.2.0** button until you do.

    It won't start if the clone is on another branch, has uncommitted changes besides the release files, is behind its remote, or has moved since you read the draft. A red or unfinished CI run needs a tick first. The repository's own git hooks never run. **Write it with Claude** puts an ask in a new conversation's box: Claude reads your earlier entries and writes this one in the same voice. You read it, send it, then cut the release; an entry that's already in the CHANGELOG goes in exactly as written. A release you prepared by hand and never tagged is simply tagged. A pushed release counts toward the project's sticker.
  - **Conversations:** the last few you had in it, including ones in a copy Shellby made, to pick back up, and **Where did we leave off?**.
  - Each clone's branch, uncommitted and unpushed work and stashes, with **Tidy up…** (the same ask as *Is it safe to leave?*, put in the box for you to read before it goes) and the copies Shellby made of it.
- **From a terminal.** Ask Claude Code *"what's next on this repo?"* and, with the Shellby plugin, it asks Shellby (`next_up`): anything broken first (a crashed dev server, a red build, a serious vulnerability), then your to-dos, then the housekeeping (review comments, unpushed or uncommitted work, flaky tests, outdated packages), and where you left off. `server_log` lets it read why a dev server fell over, secrets blanked out and fenced as output, and `projects` lists them all. Without Claude, `shellby next` prints the same answer for the repo you're in (`shellby next web`, or `--all` for every project), and `shellby projects` lists them. It works from a subfolder and from a copy Shellby made, too. Nothing here can start, stop or change a server or touch your code: the only thing a terminal can change is the to-do list.
- **Remove from Projects** only takes it off the list; the folder is never touched. Git is read a few repos at a time after the list is drawn, so a big list opens straight away and its rows fill in.
- **Dev servers.** Each clone's dev scripts (`dev`, `start`, `serve`, `preview`, `watch`) are listed with the framework they start, and **Start** runs one with the project's own package manager (npm, pnpm, Yarn or Bun). Shellby reads where it's serving, so the card says **Up on :5173** with an **Open** button, and a little `:5173` pill sits by the crab.
- **When one crashes** he puts down what he was holding and raises a red sign, the pill turns red, and a notification says what died. The server's card shows the error lines marked in its log and an **Ask Claude to fix it?** sheet with exactly what would be sent, secrets blanked out. Nothing goes to Claude until you press **Send to Claude**, and when Claude's done, **Restart** is one click.
- **Fix this build** and **Address the review** start from what's already on GitHub. The first takes the failing job's name and the part of its log where it failed (trimmed to that step, capped, secrets blanked out); the second quotes each unresolved review comment with its file, line and author. Either way a sheet shows exactly what would go to Claude, with room for a note, and nothing is sent until you press **Send to Claude**. Claude then works in a copy of your clone started from the pull request's latest commit, and pushes the fix to its branch. Claude Code reads its instructions, hooks and MCP servers from the folder it works in, so if the pull request changes `CLAUDE.md`, anything under `.claude/` or `.mcp.json`, or has commits from anyone but you, the sheet names those files and people, and **Send** stays off until you tick **I've looked at these**. The copy starts from exactly the commit that was checked. If GitHub won't share a log with your sign-in (a private repository needs "Let Claude tasks push"), the sheet says so and sends the job's name and link instead. The repository needs to be cloned on this PC.
- **Servers keep running when Shellby quits**, and are picked back up, log and all, when it starts again. Or choose **On quit: stop them** on the line the Projects page shows while any run, or in **Settings → Claude → Dev servers**.
- **Clone.** A GitHub repository that isn't on this PC has a **Clone…** button. Nothing is downloaded until you've chosen where it goes, it won't clone over a folder that's already there, and nothing is installed or run afterwards.
- **Safe with any repo:** only a script's plain name ever reaches a command line, programs are never run from the project folder itself, and a server's output reaches Claude fenced and labelled as output, never as instructions.

## Next up

The first card on a project's page answers "what now?" with one ranked list, drawn from three places:

- **Your to-do list**, kept in the repository as `.shellby/tasks.md` (a project that's only on GitHub keeps it in Shellby): plain Markdown checkboxes, so they're version-controlled, travel with the clone, and read fine on GitHub. **+ Add a task…** puts one at the end of `## Next`. Put things under `## Now` to have them first and `## Later` to have them last; lines indented under a task are its notes. Your order is never reshuffled.
- **Its GitHub issues and milestones**, read when you open the page (signed in, with **Show my repositories** on). The nearest milestone gets a strip at the top: *"v0.71 · due in 4 days · 6 of 9 closed"*.
- **Loose ends:** the TODO, FIXME and HACK comments in its tracked files (anything .gitignore'd or untracked is left out).

Each row says why it's where it is: *Assigned to you*, *v0.71 · due in 2 days*, *Bug · 4 👍*, *FIXME in src/sync.js*. **Now** holds your `## Now` tasks and issues that are urgent or due within three days. **Up next** holds your other tasks, then issues assigned to you, in the nearest milestone or labelled `shellby`, then FIXMEs. Everything else comes **Later**. A task that says `#42` stands in for issue 42 and puts it where you want it. A `TODO(#42)` in the code is folded into issue 42 and quoted when you start on it.

**Do this** makes a copy of the project on a branch of its own (an issue's copy starts from its main branch as GitHub has it, the same as the [Issue helper](WORKFLOWS.md#from-an-issue-to-a-pull-request)'s) and opens a conversation there with the prompt waiting in the box. **Nothing goes to Claude until you send it**: issue text is someone else's words, so it's quoted and fenced, and Shellby says so when you didn't write the issue. Close that conversation without sending anything and the empty copy goes with it. While a conversation is on it, the row says **Open conversation** instead.

When it's done:

- **Open a draft pull request** in the copy's branch menu pushes the branch and opens a draft (*Closes #42* for an issue, with the commits listed). It needs **Let Claude tasks push** on in Settings → GitHub.
- When the copy is brought home or its pull request merges, he offers to **tick the task off**. Tick, edit, move or remove tasks from **⋯** on any row too.
- **Commit it** under the card commits `.shellby/tasks.md` and nothing else you have staged. It never pushes. Shellby only ever edits the list in your checkout, never in a copy, so a branch coming home can't collide with it.
- **⋯ → Hand it to the Issue helper** gives an issue to your Issue helper workflow, which works on it by itself and opens the draft pull request, without asking you first again. It runs without you reading its prompt, so when someone else wrote the issue Shellby checks with you first.

Hide what you'll never get to (**⋯ → Hide**, kept on this PC). The to-do list is the same one Claude Code (`add_task`, `finish_task`) and the terminal (`shellby next add`, `shellby next done`) keep: what they add lands in `.shellby/tasks.md` marked *(from Claude Code)* or *(from the terminal)*, and the card says so. `next_up` and `shellby next` read the to-dos back, with the issues and TODOs from this card after the rest of their answer.

## Notes

Somewhere to put ideas before they're tasks. **Notes** on the bar (<kbd>Ctrl</kbd>+<kbd>8</kbd>, or **New note** in <kbd>Ctrl</kbd>+<kbd>K</kbd>) keeps a list for each project and one **General** list, and opens on the project you're working in. Type a note and press <kbd>Enter</kbd> (<kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line). Each one has three buttons:

- **Plan:** Claude plans it, and nothing changes until you approve the plan.
- **Build:** it goes to Claude as written, in your current mode.
- **Ask:** Claude reads round and says whether it's a good idea, changing nothing.

Afterwards the note says *Planned*, *Built* or *Asked*, with a link back to that conversation. Tick a note off when it's done (with Undo), click its text to edit it, or move it to another list from its menu. General notes run in the folder you're working in. Notes stay on this PC: up to 100 a list, and they don't sync. Notes turns up on the bar after his first task.

## Time on each project

<p align="center"><img src="screenshot-time.png" width="420" alt="History → Time: hours and what they come to this week, a bar for each day, and each project with its client and rate"></p>

- **History → Time** keeps track of how long you spend on each project, for timesheets and invoices. Shellby works it out from what he already sees: an editor or terminal showing a project's folder, the project's page on GitHub or GitLab, Claude working in it, and git moving in it. The clock stops when you're away from the keyboard or the screen is locked. It's off until you turn it on.
- **Clients and rates.** Give each project a client and an hourly rate, mark it billable or not, and round each day to the nearest (or next) 6, 10, 15, 30 or 60 minutes.
- **Time by hand.** Add a meeting or take off a break on any day, with a note for the invoice.
- **From your commits.** Days you committed but weren't keeping time can be filled in from the commits, marked as estimates wherever they show.
- **Timesheets.** **Save PDF** makes a clean timesheet for a client, one project or everything, **Save CSV** gives one row per project per day for your invoicing tool, and **Copy as text** is ready to paste into an email. `shellby time last-week` prints the same summary in a terminal.
- **Send to your time tracker.** Under the timesheet, connect Toggl Track, Clockify or Harvest with an API token. Each project is matched to one of yours there, by its name or else its client, and you can change the match in the project's details. Pick a day and **Send**: each project's billed hours go over as one entry, with the day's note (or your commit messages) as its description. Sending a day again updates those entries rather than adding more. Nothing goes until you press it, and the token is kept encrypted by Windows.
- **Private:** everything stays on this PC and is never synced, except the days you send to your time tracker. The title of the window in front is read only to tell which project it shows, and then forgotten: all that's kept is the project, the day and the minutes.

## Flaky tests

- **Spotted for you.** When a test fails and then passes with the code exactly as it was, Shellby notices. A test that went green because you fixed it never counts. The second time one does it in a week, he says so: *"auth.spec › signs in flaked 2 times this week"*.
- **Routines → Flaky tests** lists each one, its project and runner, and how often it flaked. He reads node's test runner, Jest, Vitest, Mocha, pytest, Go, Rust, Playwright, RSpec, .NET and PHPUnit.
- **Fix it:** one button starts a task in a copy of the project on its own branch. Claude finds the cause (timing, shared state, test order, a real network or clock), fixes that rather than adding retries, runs the test 20 times to prove it, and commits. Or **Quarantine** it the runner's own way, with a note saying why, and he offers to try again in two weeks.
- **File an issue:** with **Let Claude tasks push** on in Settings → GitHub, a flaky test in a project on GitHub can become an issue there, after Shellby asks: what he saw (the test, how often it flaked and when, the command with any values left out) and how to go about fixing it. It's labelled `shellby` and assigned to you, so the [Issue helper](WORKFLOWS.md#from-an-issue-to-a-pull-request) can offer to take a crack at it, and anyone else on the project can see it. The row then links to the issue.

## Dependencies

- **Dependency watch.** Once a week Shellby checks the projects you work in for outdated packages and known vulnerabilities, himself, without Claude. It's on the **Routines** page under Dependency health, off until you switch it on. He goes by each project's lockfile:

    | Lockfile | What he runs | Needs |
    |---|---|---|
    | `package-lock.json` | `npm outdated`, `npm audit` | Node.js |
    | `pnpm-lock.yaml` | `pnpm outdated`, `pnpm audit` | pnpm |
    | `yarn.lock` (Yarn 1) | `yarn outdated`, `yarn audit` | Yarn 1, or Corepack |
    | `yarn.lock` (Yarn 2+) | `yarn npm audit` (Yarn 2+ has no outdated check) | Corepack |
    | `uv.lock`, `poetry.lock`, `pylock.toml`, `Pipfile.lock` or `requirements.txt` | `pip-audit`, over the exact versions pinned there | pip-audit |
    | `Cargo.lock` | `cargo-audit` | cargo-audit |
    | `go.mod` | `go list -m -u` and `govulncheck` | Go, and govulncheck for vulnerabilities |

    A project whose checker isn't installed says what to install, and the rest are checked as usual. A folder with two (a Rust app with a web front end) gets a row for each. Nothing a project ships gets to run: no install scripts, no `.pnpmfile.cjs`, no Yarn release or plugins from the project, no pnpm or Go it names for itself, and Python packages are never installed or built. **Bump & open a PR** asks Claude to use that project's own commands and lockfile.
- **Bump & open a PR.** One button opens a task in a copy of the project on its own branch. It bumps what's safe, then the major versions one at a time, runs the tests, and opens a pull request listing what changed. If the tests won't pass, it stops and tells you what broke instead of pushing.
- **Any language:** the **Dependency checkup** routine has Claude run the outdated and audit checks for pnpm, Yarn, Bun, pip, Poetry, Cargo, Go, Bundler, Composer or .NET too. A clean audit earns the project's sticker its 🧼 **Fresh** mark.

## Is it safe to leave?

- **One click in his menu** checks the projects you've worked in lately for commits no remote has, uncommitted changes (in Shellby's copies too), stashes and anything that looks like a secret in work that's still to go out, plus running dev servers and anything Claude is still working on or waiting for: *"2 projects have unpushed work."*
- **Tidy up** hands it to Claude, who is told never to commit or push a `.env` file, a key or anything Shellby flagged as a secret.
- **Lock the PC** checks first and locks straight away when it's all clear.
- **Shutdowns wait:** a shutdown or sign-out with unpushed or uncommitted work, or with Claude mid-task, is held up with the reason and Windows' **Shut down anyway**. Turn that off under **Settings → System**.

## Streaks and nudges

- **Streaks:** finish a Claude task on consecutive days for a 🔥 streak (it's in the status line too). It lives on **Time**, with how long since each project's last commit and the nudge setting.
- **Nudges:** when a repo you work in goes quiet, he says so: *"You haven't committed to 3d-rack in 5 days 🐚"*. **Pick it up** opens a tab there with a "where did we leave off?" prompt. At most one nudge a day, only in the daytime, and each project can be muted.
