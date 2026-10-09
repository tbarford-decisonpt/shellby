### Changed

- Bug battles have more going on. A bug now strikes back when Claude re-runs a command and it fails just as before (each type has its own move), and the fix that catches it is a finishing blow you watch land, so the HP bar no longer vanishes in one go.
- Re-running a type check, linter or build now wears a bug down as the error count falls, the way failing tests already did. Before, every re-run of one missed.
- Reading round and editing count for a little more, and keep counting for 20 minutes after the bug last showed itself instead of 10.
- Opening a battle that's under way replays its last few moves from the past 10 minutes, so there's something to see.
