// Shellby on your Discord profile, through Rich Presence (src/main/discord.js).
//
// Discord isn't on CI, so the client is driven against a fake one listening on
// a real named pipe: the handshake, framing split across reads, PING/PONG, the
// rate limit, being turned down, and Discord opening after Shellby did.
//
// What it can't prove is that Discord shows what we send the way we expect:
// that wants one look at a real profile.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const os = require('os');
const path = require('path');
const {
  DiscordPresence, activityFor, clientId, clip, decodeFrames, encodeFrame, phaseOf, pipePaths,
  HEADER_SIZE, HOMEPAGE, MAX_FRAME, OP,
} = require('../src/main/discord');

const ID = '123456789012345678';

// ------------------------------------------------------------------ the wire

test('a frame is op and length (int32 LE), then the JSON', () => {
  const f = encodeFrame(OP.FRAME, { cmd: 'X' });
  assert.equal(f.readInt32LE(0), 1);
  assert.equal(f.readInt32LE(4), f.length - HEADER_SIZE);
  assert.deepEqual(JSON.parse(f.subarray(HEADER_SIZE).toString()), { cmd: 'X' });
});

test('decodeFrames waits for whole frames and takes several at once', () => {
  const two = Buffer.concat([encodeFrame(OP.FRAME, { a: 1 }), encodeFrame(OP.PING, { b: 2 })]);
  const all = decodeFrames(two);
  assert.deepEqual(all.frames, [{ op: 1, data: { a: 1 } }, { op: 3, data: { b: 2 } }]);
  assert.equal(all.rest.length, 0);
  const part = decodeFrames(two.subarray(0, two.length - 3));
  assert.deepEqual(part.frames, [{ op: 1, data: { a: 1 } }]);
  assert.equal(part.rest.length, encodeFrame(OP.PING, { b: 2 }).length - 3, 'the half frame is kept for the next read');
  assert.deepEqual(decodeFrames(Buffer.alloc(5)).frames, [], 'not even a header yet');
});

test('decodeFrames refuses what is not Discord', () => {
  const huge = encodeFrame(OP.FRAME, {});
  huge.writeInt32LE(MAX_FRAME + 1, 4);
  assert.deepEqual(decodeFrames(huge), { bad: true });
  const junk = Buffer.concat([Buffer.alloc(8), Buffer.from('nope')]);
  junk.writeInt32LE(4, 4);
  assert.deepEqual(decodeFrames(junk), { bad: true });
});

test('pipePaths tries discord-ipc-0 to -9 on Windows', () => {
  const p = pipePaths('win32', {});
  assert.equal(p.length, 10);
  assert.equal(p[0], '\\\\?\\pipe\\discord-ipc-0');
  assert.equal(p[9], '\\\\?\\pipe\\discord-ipc-9');
  assert.equal(pipePaths('linux', { XDG_RUNTIME_DIR: '/run/user/1000' })[0], path.join('/run/user/1000', 'discord-ipc-0'));
});

test('clientId takes a dev override only if it looks like a Discord snowflake', () => {
  assert.equal(clientId({ SHELLBY_DISCORD_CLIENT_ID: ID }), ID);
  assert.notEqual(clientId({ SHELLBY_DISCORD_CLIENT_ID: 'x; rm -rf' }), 'x; rm -rf');
});

// ------------------------------------------------------------------ what it says

test('clip keeps lines between 2 and 128 characters, on one line', () => {
  assert.equal(clip('a'), null);
  assert.equal(clip('  fix\nthe   test  '), 'fix the test');
  const long = clip('x'.repeat(300));
  assert.equal(long.length, 128);
  assert.ok(long.endsWith('…'));
});

test('activityFor: his level and title, then what he is doing', () => {
  const a = activityFor({ state: 'idle', level: 12, title: 'Abyssal Admin', since: 1000 });
  assert.equal(a.details, 'Lv 12 Abyssal Admin');
  assert.equal(a.state, 'pottering about the desk');
  assert.deepEqual(a.timestamps, { start: 1000 });
  assert.equal(a.assets.large_image, 'shellby');
  assert.deepEqual(a.buttons, [{ label: 'Get Shellby', url: HOMEPAGE }]);
  assert.equal(activityFor({ state: 'idle' }).details, 'a hermit crab');
});

test('activityFor: the task title only when there is one task and it was shared', () => {
  assert.equal(activityFor({ state: 'working', busy: 1, task: 'fix the flaky test' }).state, 'fix the flaky test');
  assert.equal(activityFor({ state: 'working', busy: 1 }).state, 'working with Claude Code');
  assert.equal(activityFor({ state: 'working', busy: 3, task: 'secret' }).state, '3 tasks with Claude Code');
  assert.ok(activityFor({ state: 'working', busy: 1, task: 'y'.repeat(200) }).state.length <= 100);
});

test('activityFor: asking, napping and his health', () => {
  assert.equal(activityFor({ state: 'asking' }).state, 'waiting for your OK');
  assert.equal(activityFor({ state: 'sleeping' }).state, 'napping');
  assert.equal(activityFor({ state: 'idle', health: { mood: 'hot' } }).state, 'running hot');
  assert.equal(activityFor({ state: 'petted' }).state, 'pottering about the desk', 'a passing state reads as idle');
  assert.equal(phaseOf('petted'), 'idle');
  assert.equal(phaseOf('working'), 'working');
});

test('activityFor: a calling card button, for a gist link only', () => {
  const card = 'https://gist.github.com/abc123';
  assert.deepEqual(activityFor({ state: 'idle', cardUrl: card }).buttons[0], { label: 'Visit my crab', url: card });
  assert.equal(activityFor({ state: 'idle', cardUrl: 'https://evil.example/x' }).buttons.length, 1);
  assert.equal(activityFor({ state: 'idle', cardUrl: null }).buttons.length, 1);
});

// ------------------------------------------------------------------ a fake Discord

let pipeN = 0;
const pipeName = () => (process.platform === 'win32'
  ? `\\\\.\\pipe\\shellby-discord-test-${process.pid}-${++pipeN}`
  : path.join(os.tmpdir(), `shellby-discord-test-${process.pid}-${++pipeN}`));

/** Listens like Discord: READY after the handshake, records every frame. */
function fakeDiscord(name, { refuse = false } = {}) {
  const got = [];
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    let buf = Buffer.alloc(0);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      const r = decodeFrames(buf);
      buf = r.rest;
      for (const f of r.frames) {
        got.push(f);
        if (f.op !== OP.HANDSHAKE) continue;
        if (refuse || f.data.client_id !== ID) { socket.write(encodeFrame(OP.CLOSE, { code: 4000, message: 'Invalid Client ID' })); continue; }
        // Split across two writes, as a pipe may deliver it.
        const ready = encodeFrame(OP.FRAME, { cmd: 'DISPATCH', evt: 'READY', data: { v: 1, user: { username: 'crabfan', global_name: 'Crab Fan' } } });
        socket.write(ready.subarray(0, 5));
        setTimeout(() => socket.write(ready.subarray(5)), 10);
      }
    });
  });
  return {
    got, sockets,
    activities: () => got.filter(f => f.data?.cmd === 'SET_ACTIVITY').map(f => f.data.args.activity ?? null),
    listen: () => new Promise(resolve => server.listen(name, resolve)),
    close: () => new Promise(resolve => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
  };
}

const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise(r => setTimeout(r, 10));
  }
};

const act = state => ({ details: 'Lv 3 Shell Seeker', state });

test('it skips a pipe nobody is on, shakes hands and shows the activity', async () => {
  const name = pipeName();
  const discord = fakeDiscord(name);
  await discord.listen();
  const p = new DiscordPresence({ id: ID, pipes: [pipeName(), name], minGapMs: 0 });
  try {
    p.set(act('napping'));
    p.start();
    await until(() => p.status === 'on');
    assert.equal(p.user, 'Crab Fan');
    assert.deepEqual(discord.got[0], { op: OP.HANDSHAKE, data: { v: 1, client_id: ID } });
    await until(() => discord.activities().length === 1);
    const sent = discord.got.find(f => f.data?.cmd === 'SET_ACTIVITY').data;
    assert.equal(sent.args.pid, process.pid);
    assert.deepEqual(sent.args.activity, act('napping'));
    // The same again is not sent again.
    p.set(act('napping'));
    await new Promise(r => setTimeout(r, 50));
    assert.equal(discord.activities().length, 1);
  } finally {
    p.stop();
    await discord.close();
  }
});

test('it sends at most one activity per gap, and the latest wins', async () => {
  const name = pipeName();
  const discord = fakeDiscord(name);
  await discord.listen();
  const p = new DiscordPresence({ id: ID, pipes: [name], minGapMs: 200 });
  try {
    p.set(act('one'));
    p.start();
    await until(() => discord.activities().length === 1);
    p.set(act('two'));
    p.set(act('three'));
    await new Promise(r => setTimeout(r, 80));
    assert.equal(discord.activities().length, 1, 'held back inside the gap');
    await until(() => discord.activities().length === 2);
    assert.deepEqual(discord.activities()[1], act('three'));
    await new Promise(r => setTimeout(r, 250));
    assert.equal(discord.activities().length, 2, '"two" never went out');
  } finally {
    p.stop();
    await discord.close();
  }
});

test('set(null) clears the activity, and PING gets a PONG', async () => {
  const name = pipeName();
  const discord = fakeDiscord(name);
  await discord.listen();
  const p = new DiscordPresence({ id: ID, pipes: [name], minGapMs: 0 });
  try {
    p.set(act('x'));
    p.start();
    await until(() => discord.activities().length === 1);
    p.set(null);
    await until(() => discord.activities().length === 2);
    assert.equal(discord.activities()[1], null);
    for (const s of discord.sockets) s.write(encodeFrame(OP.PING, { n: 7 }));
    await until(() => discord.got.some(f => f.op === OP.PONG));
    assert.deepEqual(discord.got.find(f => f.op === OP.PONG).data, { n: 7 });
  } finally {
    p.stop();
    await discord.close();
  }
});

test('turned down, it says why', async () => {
  const name = pipeName();
  const discord = fakeDiscord(name, { refuse: true });
  await discord.listen();
  const p = new DiscordPresence({ id: ID, pipes: [name], retryMs: 60000 });
  try {
    p.start();
    await until(() => p.status === 'refused');
    assert.equal(p.view().error, 'Invalid Client ID');
  } finally {
    p.stop();
    await discord.close();
  }
});

test('with no application ID it never touches a pipe', () => {
  const p = new DiscordPresence({ id: '', pipes: [pipeName()] });
  p.start();
  assert.equal(p.status, 'refused');
  assert.equal(p.socket, null);
  assert.equal(p.view().configured, false);
  p.stop();
});

test('Discord opening after Shellby: it keeps looking, then shows up', async () => {
  const name = pipeName();
  const p = new DiscordPresence({ id: ID, pipes: [name], retryMs: 50, minGapMs: 0 });
  const discord = fakeDiscord(name);
  try {
    p.set(act('hello'));
    p.start();
    await until(() => p.status === 'looking');
    await discord.listen();
    await until(() => discord.activities().length === 1);
    assert.equal(p.status, 'on');
    // Discord quits: back to looking, and it comes back with Discord.
    for (const s of discord.sockets) s.destroy();
    await until(() => p.status === 'looking');
    await until(() => discord.activities().length === 2);
  } finally {
    p.stop();
    await discord.close();
  }
});

test('stop() hangs up and goes quiet', async () => {
  const name = pipeName();
  const discord = fakeDiscord(name);
  await discord.listen();
  const p = new DiscordPresence({ id: ID, pipes: [name], minGapMs: 0 });
  const seen = [];
  p.on('change', v => seen.push(v.status));
  try {
    p.start();
    await until(() => p.status === 'on');
    p.stop();
    await until(() => discord.sockets.size === 0);
    assert.equal(p.status, 'off');
    assert.equal(seen.at(-1), 'off');
    p.set(act('after'));
    await new Promise(r => setTimeout(r, 50));
    assert.equal(discord.activities().length, 0);
  } finally {
    p.stop();
    await discord.close();
  }
});
