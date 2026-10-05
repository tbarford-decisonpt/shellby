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
- **Quick actions.** Point at a row (or tab to it) for **New conversation here** and **Start** (or **Open** a server that's up) without opening the project. **⋯** or a right-click has the rest: **Open folder**, **Open on GitHub**, **Clone…**.
- **A project's page** starts with **New conversation here**, then:
  - **Pulse:** hours this week with a bar for each day (while History → Time is on), the last commit, the last time you were in it, and whether he nudges you when it goes quiet.
  - **Health:** its pull requests' checks (**Fix this build** or **Ask why** on a red one, **Address the review** when reviewers left comments), its dependency check (**Bump & open a PR**) and its flaky tests (**Fix it**, **Quarantine**), the same tasks as on their own pages.
  - **Conversations:** the last few you had in it, including ones in a copy Shellby made, to pick back up, and **Where did we leave off?**.
  - **Loose ends:** the TODO, FIXME and HACK comments in its tracked files (a quick search that leaves out anything .gitignore'd or untracked), five at a time. **Do this** opens a new conversation with the file, the line and the code around it in the box, for you to read and send.
  - Each clone's branch, uncommitted and unpushed work and stashes, with **Tidy up…** (the same ask as *Is it safe to leave?*, put in the box for you to read before it goes) and the copies Shellby made of it.
- **Remove from Projects** only takes it off the list; the folder is never touched. Git is read a few repos at a time after the list is drawn, so a big list opens straight away and its rows fill in.
- **Dev servers.** Each clone's dev scripts (`dev`, `start`, `serve`, `preview`, `watch`) are listed with the framework they start, and **Start** runs one with the project's own package manager (npm, pnpm, Yarn or Bun). Shellby reads where it's serving, so the card says **Up on :5173** with an **Open** button, and a little `:5173` pill sits by the crab.
- **When one crashes** he puts down what he was holding and raises a red sign, the pill turns red, and a notification says what died. The server's card shows the error lines marked in its log and an **Ask Claude to fix it?** sheet with exactly what would be sent, secrets blanked out. Nothing goes to Claude until you press **Send to Claude**, and when Claude's done, **Restart** is one click.
- **Fix this build** and **Address the review** start from what's already on GitHub. The first takes the failing job's name and the part of its log where it failed (trimmed to that step, capped, secrets blanked out); the second quotes each unresolved review comment with its file, line and author. Either way a sheet shows exactly what would go to Claude, with room for a note, and nothing is sent until you press **Send to Claude**. Claude then works in a copy of your clone started from the pull request's latest commit, and pushes the fix to its branch. Claude Code reads its instructions, hooks and MCP servers from the folder it works in, so if the pull request changes `CLAUDE.md`, anything under `.claude/` or `.mcp.json`, or has commits from anyone but you, the sheet names those files and people, and **Send** stays off until you tick **I've looked at these**. The copy starts from exactly the commit that was checked. If GitHub won't share a log with your sign-in (a private repository needs "Let Claude tasks push"), the sheet says so and sends the job's name and link instead. The repository needs to be cloned on this PC.
- **Servers keep running when Shellby quits**, and are picked back up, log and all, when it starts again. Or choose **On quit: stop them** on the line the Projects page shows while any run, or in **Settings → Claude → Dev servers**.
- **Clone.** A GitHub repository that isn't on this PC has a **Clone…** button. Nothing is downloaded until you've chosen where it goes, it won't clone over a folder that's already there, and nothing is installed or run afterwards.
- **Safe with any repo:** only a script's plain name ever reaches a command line, programs are never run from the project folder itself, and a server's output reaches Claude fenced and labelled as output, never as instructions.

## Time on each project

<p align="center"><img src="screenshot-time.png" width="420" alt="History → Time: hours and what they come to this week, a bar for each day, and each project with its client and rate"></p>

- **History → Time** keeps track of how long you spend on each project, for timesheets and invoices. Shellby works it out from what he already sees: an editor or terminal showing a project's folder, the project's page on GitHub or GitLab, Claude working in it, and git moving in it. The clock stops when you're away from the keyboard or the screen is locked. It's off until you turn it on.
- **Clients and rates.** Give each project a client and an hourly rate, mark it billable or not, and round each day to the nearest (or next) 6, 10, 15, 30 or 60 minutes.
- **Time by hand.** Add a meeting or take off a break on any day, with a note for the invoice.
- **From your commits.** Days you committed but weren't keeping time can be filled in from the commits, marked as estimates wherever they show.
- **Timesheets.** **Save PDF** makes a clean timesheet for a client, one project or everything, **Save CSV** gives one row per project per day for your invoicing tool, and **Copy as text** is ready to paste into an email. `shellby time last-week` prints the same summary in a terminal.
- **Private:** everything stays on this PC and is never synced. The title of the window in front is read only to tell which project it shows, and then forgotten: all that's kept is the project, the day and the minutes.

## Flaky tests

- **Spotted for you.** When a test fails and then passes with the code exactly as it was, Shellby notices. A test that went green because you fixed it never counts. The second time one does it in a week, he says so: *"auth.spec › signs in flaked 2 times this week"*.
- **Routines → Flaky tests** lists each one, its project and runner, and how often it flaked. He reads node's test runner, Jest, Vitest, Mocha, pytest, Go, Rust, Playwright, RSpec, .NET and PHPUnit.
- **Fix it:** one button starts a task in a copy of the project on its own branch. Claude finds the cause (timing, shared state, test order, a real network or clock), fixes that rather than adding retries, runs the test 20 times to prove it, and commits. Or **Quarantine** it the runner's own way, with a note saying why, and he offers to try again in two weeks.
- **File an issue:** with **Let Claude tasks push** on in Settings → GitHub, a flaky test in a project on GitHub can become an issue there, after Shellby asks: what he saw (the test, how often it flaked and when, the command with any values left out) and how to go about fixing it. It's labelled `shellby` and assigned to you, so the [Issue helper](WORKFLOWS.md#from-an-issue-to-a-pull-request) can offer to take a crack at it, and anyone else on the project can see it. The row then links to the issue.

## Dependencies

- **Dependency watch.** Once a week Shellby checks the npm projects you work in for outdated packages and known vulnerabilities, himself, without Claude. It's on the **Routines** page under Dependency health, off until you switch it on.
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
