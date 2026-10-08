// The doctor's reading (doctor.js decides): who holds a port, a port that's
// free, the project's .env files and the Node on this PC. Never throws; every
// answer is something to show, so a failure is just less to say.
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { SYSTEM32 } = require('../system32');
const doctor = require('./doctor');

const NETSTAT = path.join(SYSTEM32, 'NETSTAT.EXE');
const MAX_ENV_BYTES = 64 * 1024;
const NODE_TTL_MS = 60 * 1000;
const FREE_TRIES = 40;

/** A small text file in `root`, or null. Only a plain file, never one a link points elsewhere. */
function readSmall(root, name, max = MAX_ENV_BYTES) {
  try {
    const file = path.join(root, name);
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > max) return null;
    return fs.readFileSync(file, 'utf8');
  } catch { return null; }
}

/**
 * Who's listening on `port`. info(pid) -> { alive, createdAt }, image(pid) ->
 * { name, full } (native-windows). -> [{ pid, name, createdAt, canStop }]
 */
function whoHasPort(port, { info, image, run = execFile } = {}) {
  return new Promise(resolve => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return resolve([]);
    run(NETSTAT, ['-ano', '-p', 'TCP'], { windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (err4, out4) => {
      run(NETSTAT, ['-ano', '-p', 'TCPv6'], { windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (err6, out6) => {
        const pids = [...new Set([...doctor.listenersOn(err4 ? '' : out4, port), ...doctor.listenersOn(err6 ? '' : out6, port)])];
        resolve(pids.slice(0, 5).map(pid => {
          const name = image?.(pid)?.name || '';
          return { pid, name, createdAt: info?.(pid)?.createdAt || null, canStop: doctor.canStop(pid, name) };
        }));
      });
    });
  });
}

// Can something listen on `port` here? Asked of the IPv4 loopback and of
// every address, since a server on "localhost" may take either. Only "taken"
// or "not allowed" count as no: a PC without IPv6 can't say about "::".
function tryListen(port, host) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', e => resolve(e?.code !== 'EADDRINUSE' && e?.code !== 'EACCES'));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

/** The first port after `from` that nothing is using. -> number | null */
async function freePort(from, { listen = tryListen } = {}) {
  for (let port = Math.max(1024, from + 1), n = 0; n < FREE_TRIES && port <= 65535; port++, n++) {
    if (await listen(port, '127.0.0.1') && await listen(port, '::')) return port;
  }
  return null;
}

let nodeCache = null; // { at, version }

/**
 * The Node on PATH ("v20.11.1"), or null. Asked from your home folder, so a
 * node.exe in a project folder is never the one run.
 */
function nodeVersion({ run = execFile, now = Date.now() } = {}) {
  if (nodeCache && now - nodeCache.at < NODE_TTL_MS) return Promise.resolve(nodeCache.version);
  return new Promise(resolve => {
    run('node', ['--version'], { cwd: os.homedir(), windowsHide: true, timeout: 5000, env: { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' } }, (err, out) => {
      const v = !err && /^v?\d+\.\d+\.\d+/.test(String(out).trim()) ? String(out).trim().split(/\s/)[0] : null;
      nodeCache = { at: now, version: v };
      resolve(v);
    });
  });
}

/**
 * Everything the doctor checks before a start, for one clone.
 * -> { notes: [{ kind, text, keys? }], example: string | null, canMakeEnv: bool }
 */
async function checkProject(root, { node = nodeVersion } = {}) {
  const exampleFile = doctor.EXAMPLE_FILES.find(f => readSmall(root, f) != null) || null;
  const example = exampleFile ? { file: exampleFile, text: readSmall(root, exampleFile) } : null;
  const present = doctor.ENV_FILES.map(f => ({ file: f, text: readSmall(root, f) })).filter(p => p.text != null);
  const env = doctor.missingEnv(example, present, Object.keys(process.env));
  const wanted = doctor.nodeWanted({
    nvmrc: readSmall(root, '.nvmrc', 1024),
    nodeVersion: readSmall(root, '.node-version', 1024),
    packageJson: readSmall(root, 'package.json', 512 * 1024),
  });
  const have = wanted ? await node() : null;
  return {
    notes: doctor.notes({ env, node: wanted ? { wanted, have } : null }),
    example: exampleFile,
    canMakeEnv: !!example && !present.some(p => p.file === '.env') && !fs.existsSync(path.join(root, '.env')),
  };
}

/**
 * ".env from the example": a copy of it, only where there's no .env at all.
 * -> { ok, file } | { ok: false, error }
 */
function makeEnv(root) {
  const exampleFile = doctor.EXAMPLE_FILES.find(f => readSmall(root, f) != null);
  if (!exampleFile) return { ok: false, error: 'There\'s no example to copy.' };
  try {
    fs.copyFileSync(path.join(root, exampleFile), path.join(root, '.env'), fs.constants.COPYFILE_EXCL);
    return { ok: true, file: path.join(root, '.env') };
  } catch (e) {
    return { ok: false, error: e.code === 'EEXIST' ? 'There\'s a .env already, so it was left alone.' : 'Couldn\'t write the .env.' };
  }
}

module.exports = { whoHasPort, freePort, nodeVersion, checkProject, makeEnv, readSmall };
