# Health

Shellby watches your PC's temperatures, memory and drives, and his mood follows them. Open the **Health** view (**Health** in the bar at the bottom of the panel, or in the tray menu) to see everything live.

## What he reads, and from where

Nothing here needs administrator rights, and nothing leaves your PC.

| Reading | Source | Notes |
|---|---|---|
| GPU temperature, load, VRAM | `nvidia-smi`, which comes with every NVIDIA driver | Read every 5 seconds while a reading is off or the panel is open, otherwise every 15; takes about 50 ms |
| CPU temperature | [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor)'s local web server | See below. Windows doesn't expose CPU temperature to normal apps |
| AMD / Intel GPU temperature | LibreHardwareMonitor | Used when there's no NVIDIA card |
| Fans, drive temperatures, battery | LibreHardwareMonitor or HWiNFO | Shown when your sensor app reports them |
| CPU load | Windows (per-core time counters) | |
| Memory | Windows ("available" memory) | |
| Drives | Windows: local fixed drives only | The drive list refreshes every 15 minutes; free space every minute |

### Setting up CPU temperature

The quick way: press **Let Claude set it up** in the Health view. It fills in a task asking Claude to install LibreHardwareMonitor, switch on its web server on your port and start it as administrator (you accept the Windows prompt). It isn't sent until you press Enter, so you can read it first. Claude asks before making LHM start with Windows. To do it by hand:

1. Install LibreHardwareMonitor: `winget install LibreHardwareMonitor.LibreHardwareMonitor`, or download it from its [releases page](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases/latest).
2. Run it **as administrator**. It needs that to read the CPU's sensors. Shellby doesn't, because it only reads what LHM publishes.
3. In LHM, turn on **Options → Remote Web Server → Run**. The default port is `8085`. If you change it, set the same port in Shellby's Health view.
4. Optional: **Options → Run On Windows Startup** and **Start Minimized**, so it's always there.
5. In Shellby, press **I've done it, check again**.

Shellby only ever asks `http://127.0.0.1:<port>/data.json`, which is your own PC. If LHM's web server has authentication turned on, Shellby will tell you to turn it off. When LHM isn't running, Shellby tries again once a minute.

For AMD CPUs, Shellby uses the `Core (Tctl/Tdie)` sensor. For Intel CPUs it uses `CPU Package`. Otherwise it uses the hottest core.

### Already run HWiNFO?

Then you don't need LibreHardwareMonitor. Run HWiNFO's companion **Remote Sensor Monitor** on its default port, `60000`, and Shellby reads the same sensors from it at `http://127.0.0.1:60000`. When LHM isn't answering he tries HWiNFO, and **Sensors** in the Health view says which one he's reading.

The graphs under each gauge cover the last 10 minutes or the last hour: switch with **10 min / 1 hour** above them. The figures beside a graph are the lowest and highest over that time.

## When he reacts

| Mood | When | On the desktop |
|---|---|---|
| **Hot** | A GPU, CPU or drive temperature is over your line (default **GPU 80°C**, **CPU 85°C**, **drive 70°C**) | Sweat drips, his cheeks flush, and he fans himself with his claw. The bubble shows the temperature |
| **Scorching** | 8°C past your line | Faster sweat, panting, heat shimmer over his shell. Wakes him up if he was asleep |
| **Dizzy** | Memory use over your line (default **90%**; very high is 6 points more) | Stars circle his eyes and his eye stalks wobble |
| **Stuffed** | A drive's free space under your line (default **50 GB**, or 10% on small drives; very low is a quarter of that, or 4%) | Boxes, papers, a sock and a floppy disk jammed in his shell, and one keeps popping out |

If more than one thing is wrong, the worst one wins: scorching, then hot, then dizzy, then stuffed.

Once you've put something in [his tank](TANK.md), the picture of him at the top of the Health view is a window into it, and his moods show on top as usual.

So Shellby doesn't panic at every spike:

- **Temperatures** must stay over the line for **20 seconds** before he reacts, and back under it for 30 seconds (by at least 3°C) before he calms down.
- **Memory** must stay high for **45 seconds**.
- **Drives** react straight away, because they don't fill up in a blip.

## Notifications

You get one Windows notification when a reading crosses its warning line, and another if it gets very bad. The same warning won't repeat for 30 minutes, though going from warning to very bad always notifies. Clicking the notification opens the Health view.

The Health view keeps a log of the last 40 alerts, including when things went back to normal.

Turn notifications off in the Health view, or turn all notifications off in Settings.

## Ask Shellby why

Every warning has an **Ask Shellby why** button. It opens a new conversation with a ready-made task:

- **Hot GPU or CPU:** find what's using it most, say whether the temperature is actually a problem for that chip, and suggest fixes.
- **Memory:** list the processes using the most memory, flag likely leaks, and suggest what to close.
- **Full drive:** find the largest folders and files, and list cleanup candidates with sizes and how safe each one is.

Each task tells Claude not to delete, kill, close or change anything, only to report back. It runs in your current permission mode, so anything it does want to run still goes through your approval as usual.

## What's hogging it

While Shellby is sweating or dizzy, the Health view lists the busiest processes right under the warning, so "your GPU is at 84°C" comes with the answer to "why?". It's sorted by whatever explains the mood: GPU use when the GPU is hot, CPU use when the CPU is hot, memory when memory is full. Switch between **GPU**, **CPU** and **Memory** to see the others. The list refreshes every 30 seconds, or when you press **Refresh**.

Each row has an **End task** button. It does the same as End task in Task Manager, but asks first, in Shellby's separate confirmation window, showing the process and what it's using. A few things can't be ended from here: Windows' own processes (including Explorer and Defender) and Shellby himself. They say **protected** instead. If the process closes while the question is open and Windows gives its number to something else, Shellby notices and leaves the new one alone.

Processes that run as administrator can't be ended without admin rights, and Shellby tells you so.

**Ask Shellby what's running and what I don't need** starts a task with everything running right now, not just the busiest few. Processes are added up by app and sorted by memory. Claude explains what each one is and who makes it, gives you a table of what to keep, close or stop from starting, and says where the ones you don't need come from (a startup entry, a service, a scheduled task, another app's helper). Then it asks which ones you want dealt with, and changes nothing until you say. Like the startup task, it always runs in **Ask** mode, because any program can choose its own process name. So every command Claude wants to run, including ending a process, still asks you first. The list holds names and usage only, never command lines, which can contain tokens.

### What Shellby himself costs

Above the list, one line owns up to his share: **Shellby himself: 1% CPU, 450 MB**. It adds up every process he runs (his window, the panel, and the helpers Electron starts for them), counts CPU as a share of your whole PC like Task Manager does, and updates every 5 seconds. Hover it to see how many processes that is and what it comes to as a share of one core.

Mostly that's the panel: its animations run while you're looking at it, and calm down when another window is in front. If he's using 5% or more of your PC, or over 1 GB, a hint says what helps. With the panel closed he settles to almost nothing, and once he's been measured that way on your PC the hint tells you the actual figure. Fewer pals and less wandering (**Settings → Moving around**) make him lighter still.

GPU use per process needs Windows 10 1709 or later. Reading the list takes a second or two, so it's only read while the Health view is open and something is wrong.

## Starts with Windows

The Health view lists what launches when you sign in: the Run entries in the registry and the Startup folders, yours and everyone's. Anything you've switched off in Task Manager is crossed out and doesn't count toward the total.

**Switch off / Switch on** next to an entry flips the same switch as Task Manager → Startup apps (the `StartupApproved` value under your account). The entry and the app stay where they are, so switching it back on puts things as they were, and Task Manager shows the change too. Shellby only switches your own entries. These stay **locked**, and hovering the tag says why:

- Entries for everyone (HKLM, the shared Startup folder) need an administrator. Use Task Manager.
- Shellby's own entry is controlled by **Start with Windows** in Settings.
- RunOnce and the system accounts' entries have no switch.

**Ask Shellby which ones I need** starts a task with that list. Claude explains what each one is, also looks (read-only) at scheduled tasks that run at logon and at non-Microsoft services that start automatically, and gives you a table of what to keep, what to switch off, and how to do it yourself. Like the other Ask Shellby tasks, it's told not to disable or change anything. It always runs in **Ask** mode, whatever mode you're in, because the list comes from the registry and any installer can write there. So anything Claude wants to run still asks you first.

## Developer clutter

On a developer's PC, the biggest things on the drive are often ones you can't point at in Explorer. Every few hours Shellby measures:

- **Docker:** what `docker system df` says is in use and how much of it could be freed.
- **Virtual disks:** Docker Desktop's and each WSL distro's `ext4.vhdx`. Freeing space inside them doesn't shrink these files, so they're listed apart.
- **Package caches:** npm, pnpm, Yarn, pip, uv, Cargo, Go modules, NuGet, Gradle, Electron, electron-builder, Playwright and Puppeteer.

Once **40 GB** or more could come back (set it under **Alert settings**), he overstuffs his shell as he does for a full drive, and the **Developer clutter** card says where it is. **Ask Shellby what's safe to clear** starts a task that plans the cleanup and gives you the exact commands, without running them. Pruning Docker or wiping a cache is your call.

Measuring is read-only, and each cache walk stops after 2 seconds, so the sizes are a floor rather than exact. Turn it off with **Measure Docker, WSL and package caches** under **Alert settings**.

## Trophies

| Trophy | How | Reward |
|---|---|---|
| 🩺 Check-Up | Open the Health view | Stethoscope + Scanner Visor |
| 🧊 Keep Your Cool (secret) | Shellby cools down after a heat warning | Sweatband + Handheld Fan + Fire Extinguisher |
| 🧹 Spring Cleaning | Free up space after a low-disk warning | Broom + Toadstool |

## Turning it off

In the Health view:

- **Watch my PC's health:** stops all polling.
- **Shellby reacts on the desktop:** keeps the dashboard and notifications, but no desktop moods.
- **Notify me when something's off:** desktop moods only.

## For developers

- `src/main/health/rules.js`: thresholds, hysteresis, timing, moods, alert text and prompts. All pure, and covered in `test/health.test.js`.
- `src/main/health/sensors.js`: the readers and their parsers.
- `src/main/health/monitor.js`: the poll loop and an hour of history.
- `src/main/health/service.js`: settings, notifications, the alert log, trophies and IPC.
- `src/main/health/hogs.js`: the process list, sorting and the End task guards. Covered in `test/hogs.test.js`.
- `src/main/health/startup.js`: the startup list, its on/off switch and the audit prompt. Also covered in `test/hogs.test.js`.
- `src/main/health/hwinfo.js`: HWiNFO's readings through Remote Sensor Monitor.
- `src/main/health/space.js`: Docker, WSL and the package caches, and the cleanup prompt.
- **Fake sensors.** `SHELLBY_FAKE_HEALTH=hot|scorching|dizzy|stuffed|calm|nocpu|hotdrive|cluttered npm start` runs a dev build with scripted sensors and no waiting. It's ignored by installed builds.
- **End-to-end check.** `node scripts/e2e-health.js` launches each scenario and checks the desktop mood, the bubble, the Health view and the badge on Health in the panel's bottom bar.
