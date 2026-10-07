### Fixed
- **Shellby follows Claude Code when its installer moves it.** If Claude Code updated itself to a new place while Shellby was open (the native installer replacing an npm copy, say), every turn failed with "Shellby can't find Claude Code on this PC" until you restarted Shellby. It now finds the new copy on the next turn, open conversations included. Thanks to @tbarford-decisonpt (#26).
