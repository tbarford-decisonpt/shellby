// A stand-in dev server for test/devservers-runner.test.js: says where it is
// the way Vite does, listens, and dies with exit code 3 once the flag file
// named on its command line appears. Spawns a child of its own, so a stop that
// leaves the tree half-alive shows up.
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');

const flag = process.argv[2];
const pidFile = process.argv[3];

if (process.argv[4] === 'child') {
  setInterval(() => {}, 1000);
} else {
  const kid = spawn(process.execPath, [__filename, flag, pidFile, 'child'], { stdio: 'ignore' });
  if (pidFile) fs.writeFileSync(pidFile, String(kid.pid));
  const server = http.createServer((_req, res) => res.end('ok'));
  server.listen(0, '127.0.0.1', () => {
    console.log('');
    console.log('  \u001b[32mVITE\u001b[0m v6.0.0  ready in 123 ms');
    console.log('');
    console.log(`  \u001b[32m➜\u001b[0m  \u001b[1mLocal\u001b[0m:   http://localhost:${server.address().port}/`);
  });
  setInterval(() => {
    if (flag && fs.existsSync(flag)) {
      console.error('Error: something broke');
      console.error('    at boom (src/main.ts:1:1)');
      kid.kill();
      process.exit(3);
    }
  }, 100);
}
