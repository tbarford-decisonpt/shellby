// Windows' own programs, by full path. A bare name ("powershell.exe") is looked
// up in the working folder before PATH, and Shellby often works in a project
// folder, where a program of the same name could be waiting.
const path = require('path');

const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

module.exports = {
  SYSTEM32,
  POWERSHELL: path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  REG: path.join(SYSTEM32, 'reg.exe'),
  TASKKILL: path.join(SYSTEM32, 'taskkill.exe'),
  CMD: path.join(SYSTEM32, 'cmd.exe'),
};
