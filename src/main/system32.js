// Windows' own programs, by full path. A bare name ("powershell.exe") is looked
// up in the working folder before PATH, and Shellby often works in a project
// folder, where a program of the same name could be waiting.
const fs = require('fs');
const path = require('path');

const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

// Windows Terminal's own launcher, where the Store and winget both put it, or
// null. lstat, not existsSync: wt.exe is an app execution alias, a reparse
// point Node can't follow, so existsSync calls it missing.
function windowsTerminal(env = process.env, lstat = fs.lstatSync) {
  const wt = env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'wt.exe');
  try { return wt && lstat(wt) ? wt : null; } catch { return null; }
}

module.exports = {
  SYSTEM32,
  windowsTerminal,
  POWERSHELL: path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  REG: path.join(SYSTEM32, 'reg.exe'),
  TASKKILL: path.join(SYSTEM32, 'taskkill.exe'),
  CMD: path.join(SYSTEM32, 'cmd.exe'),
};
