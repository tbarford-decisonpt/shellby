# Health

Shellby watches your PC's temperatures, memory and drives, and his mood follows them. Open the **Health** view (**Health** in the bar at the bottom of the panel, or in the tray menu) to see everything live.

## What he reads, and from where

Nothing here needs administrator rights, and nothing leaves your PC.

| Reading | Source | Notes |
|---|---|---|
| GPU temperature, load, VRAM | `nvidia-smi`, which comes with every NVIDIA driver | Read every 5 seconds; takes about 50 ms |
| CPU temperature | [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor)'s local web server | See below. Windows doesn't expose CPU temperature to normal apps |
| AMD / Intel GPU temperature | LibreHardwareMonitor | Used when there's no NVIDIA card |
| CPU load | Windows (per-core time counters) | |
| Memory | Windows ("available" memory) | |
| Drives | Windows: local fixed drives only | The drive list refreshes every 15 minutes; free space every minute |

### Setting up CPU temperature

1. Install LibreHardwareMonitor: `winget install LibreHardwareMonitor.LibreHardwareMonitor`, or download it from its [releases page](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases/latest).
2. Run it **as administrator**. It needs that to read the CPU's sensors. Shellby doesn't, because it only reads what LHM publishes.
3. In LHM, turn on **Options → Remote Web Server → Run**. The default port is `8085`. If you change it, set the same port in Shellby's Health view.
4. Optional: **Options → Run On Windows Startup** and **Start Minimized**, so it's always there.
5. In Shellby, press **I've done it, check again**.

Shellby only ever asks `http://127.0.0.1:<port>/data.json`, which is your own PC. If LHM's web server has authentication turned on, Shellby will tell you to turn it off. When LHM isn't running, Shellby tries again once a minute.

For AMD CPUs, Shellby uses the `Core (Tctl/Tdie)` sensor. For Intel CPUs it uses `CPU Package`. Otherwise it uses the hottest core.

## When he reacts

| Mood | When | On the desktop |
|---|---|---|
| **Hot** | A GPU or CPU temperature is over your line (default **GPU 80°C**, **CPU 85°C**) | Sweat drips, his cheeks flush, and he fans himself with his claw. The bubble shows the temperature |
| **Scorching** | 8°C past your line | Faster sweat, panting, heat shimmer over his shell. Wakes him up if he was asleep |
| **Dizzy** | Memory use over your line (default **90%**; very high is 6 points more) | Stars circle his eyes and his eye stalks wobble |
| **Stuffed** | A drive's free space under your line (default **50 GB**, or 10% on small drives; very low is a quarter of that, or 4%) | Boxes, papers, a sock and a floppy disk jammed in his shell, and one keeps popping out |

If more than one thing is wrong, the worst one wins: scorching, then hot, then dizzy, then stuffed.

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

## Trophies

| Trophy | How | Reward |
|---|---|---|
| 🩺 Check-Up | Open the Health view | Stethoscope |
| 🧊 Keep Your Cool (secret) | Shellby cools down after a heat warning | Sweatband + Handheld Fan |
| 🧹 Spring Cleaning | Free up space after a low-disk warning | Broom |

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
- **Fake sensors.** `SHELLBY_FAKE_HEALTH=hot|scorching|dizzy|stuffed|calm|nocpu npm start` runs a dev build with scripted sensors and no waiting. It's ignored by installed builds.
- **End-to-end check.** `node scripts/e2e-health.js` launches each scenario and checks the desktop mood, the bubble, the Health view and the badge on Health in the panel's bottom bar.
