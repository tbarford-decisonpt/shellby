### Faster
- **He's much lighter on your PC while nothing's happening.** He only draws a new frame when he actually moves: the breathe and the claw snap now go a whole pixel at a time, and the still moments in between cost nothing. Alone on the desktop with no seasonal outfit he's down from about 7% of one core to about 1.5–3%.
- **He holds still when you're away.** After five minutes without the keyboard or mouse he and the panel stop animating, the seasonal bats too, and pick up again the moment you're back: about 0.1% of a core while you're gone.
- **No more reg.exe every 20 seconds.** Checking whether you're on a call now reads Windows' list directly instead of starting a program that cost about a third of a second of CPU each time.
- **Health checks your GPU a third as often while all is well and the panel is closed,** and goes back to every five seconds the moment a reading turns or you open the panel.
- **The sound device rests between sounds.** With sounds on, it used to keep running for good after the first chirp; now it sleeps a few seconds after the last one and wakes for the next.

### Fixed
- **A panel that opened behind your windows (a task from the terminal, a routine) no longer animates its decorations until you click it.** Behind your windows it's about 0.6% of a core now, down from 3.8%.
- **He stays still while the screen is locked or a game covers him,** instead of starting to move again with the next thing that happened.
