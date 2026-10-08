// What Shellby may cost before CI calls it a regression (scripts/perf-budget.js).
//
// Each budget is the measured figure with a lot of room: CI runs on shared
// Windows runners with two to four slow cores, no GPU (Chromium composites in
// software there) and reduced motion on, so the same build reads several times
// slower than on a desktop and moves from run to run. A budget here catches the
// change that doubles a number, not the one that adds 5%. When the artifacts of
// a few CI runs show where the runner really sits, tighten towards ~1.5x that.
//
// "Local" is a Ryzen 9 3950X desktop with other apps open (October 2026).
// max: null reports a number without judging it.
module.exports = {
  // Over a budget by up to this share is "near": printed as a warning, still a
  // pass. Past it, the phase is measured once more, and fails if it's over again.
  tolerance: 0.15,

  metrics: {
    // Spawn to the frame after his first drawing. Local: 0.8-1.6 s (the first
    // launch after a build is the slow one). Runners start Electron from a cold
    // disk on slow cores: 8 s is ~5x local.
    coldStartMs: { label: 'Cold start to crab painted', unit: 'ms', max: 8000 },

    // Spawn to the panel booted, tabs restored (hidden until you click him).
    // Local: 1.1-1.5 s. Same headroom as the crab.
    appReadyMs: { label: 'Cold start to panel ready', unit: 'ms', max: 10000 },

    // Click the crab -> the panel visible, focused and painted. Local: ~20 ms.
    // 500 ms is where it stops feeling instant even on a slow machine, and
    // anything synchronous added to showPanel() lands here.
    panelOpenMs: { label: 'Crab clicked to panel shown', unit: 'ms', max: 500 },

    // The very first open: a panel nobody has seen gets laid out and painted.
    // Local: ~1.2 s. Reported, not judged: it's dominated by the runner's GPU-less
    // first paint, and the warm opens above are what you feel all day.
    panelFirstOpenMs: { label: 'First panel open after start', unit: 'ms', max: null },

    // Enter -> Claude's first words painted in the feed, minus the fake CLI's
    // scripted 100 ms: Shellby's own share. Local: ~90 ms, most of it the per-turn
    // snapshot of the folder (wiring/sessions.js beginTurn) taken before the
    // message goes out. 600 ms leaves room for a slow runner's git.
    firstTokenMs: { label: "Shellby's first-token overhead", unit: 'ms', max: 600 },

    // The first message of a tab, which also starts the CLI (node, for the fake).
    // Local: ~215 ms. Reported, not judged: most of it is the CLI starting.
    firstTurnColdMs: { label: 'First turn, CLI starting', unit: 'ms', max: null },

    // Doing nothing with the panel closed, % of ONE core, every process.
    // DEVELOPMENT.md's figure is ~1%; local runs read 1-11% with a busy desktop
    // around them. Software compositing on a runner costs more per frame he
    // presents, so 25%: a crab animating at full rate again would blow it.
    idleClosedCpu: { label: 'Idle CPU, panel closed', unit: '% core', max: 25 },

    // Panel open with another window in front (the calm class). DEVELOPMENT.md:
    // ~37%; local runs 5-37%. 60% catches calm stopping working, which sends it
    // to the focused figure (~75%).
    idleOpenCpu: { label: 'Idle CPU, panel open, unfocused', unit: '% core', max: 60 },

    // Resident memory, working sets added up. DEVELOPMENT.md: ~450 MB closed,
    // ~560 MB open; local ~500 MB. Working sets swing with what Windows trims,
    // and a runner has less RAM to keep them in, so ~1.8x.
    memClosedMB: { label: 'Memory, panel closed', unit: 'MB', max: 900 },
    memOpenMB: { label: 'Memory, panel open', unit: 'MB', max: 1000 },
  },
};
