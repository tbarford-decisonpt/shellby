# Your projects and your day

The repos you work in, the dev servers in them, the hours you spend, the tests that flake and the dependencies that age. Back to the [README](../README.md).

## Projects and dev servers

<p align="center"><img src="screenshot-projects.png" width="420" alt="The Projects page: five repos, one with a dev server up on :5173 and one down"></p>

<table>
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
- **A project's page** shows each clone's branch and whether it has uncommitted or unpushed work, with **Open folder**, **New conversation here** and **Open on GitHub**. **Remove from Projects** only takes it off the list; the folder is never touched.
- **Dev servers.** Each clone's dev scripts (`dev`, `start`, `serve`, `preview`, `watch`) are listed with the framework they start, and **Start** runs one with the project's own package manager (npm, pnpm, Yarn or Bun). Shellby reads where it's serving, so the card says **Up on :5173** with an **Open** button, and a little `:5173` pill sits by the crab.
- **When one crashes** he puts down what he was holding and raises a red sign, the pill turns red, and a notification says what died. The server's card shows the error lines marked in its log and an **Ask Claude to fix it?** sheet with exactly what would be sent, secrets blanked out. Nothing goes to Claude until you press **Send to Claude**, and when Claude's done, **Restart** is one click.
- **Servers keep running when Shellby quits**, and are picked back up, log and all, when it starts again. Or choose **Stop them** on the Projects page or in **Settings → Claude → Dev servers**.
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

- **Streaks:** finish a Claude task on consecutive days for a 🔥 streak (it's in the status line too).
- **Nudges:** when a repo you work in goes quiet, he says so: *"You haven't committed to 3d-rack in 5 days 🐚"*. **Pick it up** opens a tab there with a "where did we leave off?" prompt. At most one nudge a day, only in the daytime, and each project can be muted.
