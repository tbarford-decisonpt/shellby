// Shellby on your desk lighting, through OpenRGB's SDK protocol.
//
// OpenRGB is not installed on CI, so the client is driven against a fake server
// that builds the controller struct the way OpenRGB's own serialiser does, over
// a real TCP socket. That covers the parts most likely to be wrong in practice:
// framing, replies split across packets, two replies in one packet, request
// ordering, and what happens when the thing on the port is not OpenRGB.
//
// What it cannot prove is the byte layout itself -- that comes from the
// documented SDK, and wants one check against real hardware.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const {
  OpenRgbClient, colorFor, encodePacket, decodeHeader,
  encodeUpdateLeds, parseControllerData, packColor,
  PACKET, OUR_PROTOCOL, HEADER_SIZE,
} = require('../src/main/rgb');

// ------------------------------------------------------------------ the wire

test('a packet is the magic, the ids, the length, then the data', () => {
  const p = encodePacket(3, PACKET.RGBCONTROLLER_UPDATELEDS, Buffer.from([1, 2, 3]));
  assert.equal(p.length, HEADER_SIZE + 3);
  assert.equal(p.subarray(0, 4).toString('ascii'), 'ORGB');
  assert.equal(p.readUInt32LE(4), 3);
  assert.equal(p.readUInt32LE(8), 1050);
  assert.equal(p.readUInt32LE(12), 3);
  assert.deepEqual([...p.subarray(16)], [1, 2, 3]);
  assert.equal(encodePacket(0, 0).length, HEADER_SIZE, 'a packet with no data is just a header');
});

test('decodeHeader waits for a whole header and rejects a stranger', () => {
  assert.equal(decodeHeader(Buffer.alloc(0)), null);
  assert.equal(decodeHeader(Buffer.alloc(15)), null);
  assert.deepEqual(decodeHeader(encodePacket(1, 2, Buffer.alloc(5))), { deviceId: 1, packetId: 2, size: 5 });
  // Something else listening on 6742 must be noticed, not parsed.
  assert.deepEqual(decodeHeader(Buffer.from('HTTP/1.1 200 OK\r\n\r\n')), { bad: true });
  // An absurd length is a refusal, not an allocation.
  const huge = encodePacket(0, 0);
  huge.writeUInt32LE(0xffffffff, 12);
  assert.deepEqual(decodeHeader(huge), { bad: true });
});

test('colours are packed as OpenRGB stores them (bytes r, g, b, 0)', () => {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(packColor({ r: 255, g: 122, b: 92 }), 0);
  assert.deepEqual([...buf], [255, 122, 92, 0]);
  assert.equal(packColor({ r: 0, g: 0, b: 0 }), 0);
  // Out-of-range and junk values are clamped rather than wrapping to a random colour.
  buf.writeUInt32LE(packColor({ r: 300, g: -20, b: 1.6 }), 0);
  assert.deepEqual([...buf], [255, 0, 2, 0]);
  buf.writeUInt32LE(packColor({ r: NaN, g: undefined, b: 'x' }), 0);
  assert.deepEqual([...buf], [0, 0, 0, 0]);
});

test('an UPDATELEDS payload carries its own size, the count, then one colour each', () => {
  const data = encodeUpdateLeds(3, { r: 1, g: 2, b: 3 });
  assert.equal(data.length, 4 + 2 + 12);
  assert.equal(data.readUInt32LE(0), data.length, 'the size field counts itself');
  assert.equal(data.readUInt16LE(4), 3);
  for (let i = 0; i < 3; i++) assert.deepEqual([...data.subarray(6 + i * 4, 10 + i * 4)], [1, 2, 3, 0]);
  assert.equal(encodeUpdateLeds(0, { r: 1, g: 1, b: 1 }).length, 6);
  assert.equal(encodeUpdateLeds(-5, { r: 1, g: 1, b: 1 }).readUInt16LE(4), 0);
});

// ------------------------------------------------------------------ the struct

// Serialise a controller the way OpenRGB does, so the parser is tested against
// something built independently of it rather than against its own output.
function buildControllerData({ name = 'Fake Keyboard', numLeds = 3, numModes = 2, numZones = 1, version = OUR_PROTOCOL } = {}) {
  const parts = [];
  const u16 = v => { const b = Buffer.alloc(2); b.writeUInt16LE(v, 0); parts.push(b); };
  const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32LE(v, 0); parts.push(b); };
  const i32 = v => { const b = Buffer.alloc(4); b.writeInt32LE(v, 0); parts.push(b); };
  const str = s => { const body = Buffer.from(`${s}\0`, 'utf8'); u16(body.length); parts.push(body); };

  u32(0);              // data_size, patched below
  u32(1);              // device type
  str(name);
  if (version >= 1) str('Fakevendor');   // vendor
  str('a description');
  str('1.2.3');        // version
  str('SERIAL123');    // serial
  str('HID: /dev/x');  // location

  u16(numModes);
  u32(0);              // active mode
  for (let i = 0; i < numModes; i++) {
    str(`Mode ${i}`);
    i32(-1);           // value
    u32(0x20);         // flags
    u32(0); u32(100);  // speed min/max
    if (version >= 3) { u32(0); u32(100); }   // brightness min/max
    u32(1); u32(2);    // colors min/max
    u32(50);           // speed
    if (version >= 3) u32(100);               // brightness
    u32(0);            // direction
    u32(1);            // color mode
    u16(1); u32(0x00112233);                  // one mode colour
  }

  u16(numZones);
  for (let i = 0; i < numZones; i++) {
    str(`Zone ${i}`);
    u32(1);            // zone type
    u32(0); u32(numLeds); u32(numLeds);       // leds min / max / count
    u16(0);            // no matrix
  }

  u16(numLeds);
  for (let i = 0; i < numLeds; i++) { str(`LED ${i}`); u32(0); }
  u16(numLeds);
  for (let i = 0; i < numLeds; i++) u32(0);

  const out = Buffer.concat(parts);
  out.writeUInt32LE(out.length, 0);
  return out;
}

test('parseControllerData walks the struct and finds the name and LED count', () => {
  const data = buildControllerData({ name: 'Corsair K95', numLeds: 110, numModes: 7, numZones: 3 });
  assert.deepEqual(parseControllerData(data, 3), { name: 'Corsair K95', numLeds: 110 });
});

test('parseControllerData handles the older protocols with different mode fields', () => {
  // Protocol 2 and below have no brightness fields; reading them would misalign
  // everything after the modes.
  for (const version of [0, 1, 2, 3]) {
    const data = buildControllerData({ name: `v${version}`, numLeds: 8, version });
    assert.deepEqual(parseControllerData(data, version), { name: `v${version}`, numLeds: 8 }, `protocol ${version}`);
  }
});

test('parseControllerData reads a real OpenRGB 1.0 reply (vendor string and all)', () => {
  // Captured from OpenRGB 1.0 (server protocol 6, asked for 3): Corsair DDR4 on PawnIO SMBus.
  const data = require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'openrgb-corsair-dram-v3.bin'));
  const { name, numLeds } = parseControllerData(data, 3);
  assert.equal(name, 'Corsair Vengeance RGB Pro DDR4');
  assert.ok(numLeds > 0 && numLeds < 100, `numLeds ${numLeds}`);
});

test('a device with no LEDs parses rather than failing', () => {
  assert.deepEqual(parseControllerData(buildControllerData({ numLeds: 0, numZones: 0 }), 3).numLeds, 0);
});

test('a truncated or nonsense struct throws instead of inventing LEDs', () => {
  const good = buildControllerData({ numLeds: 4 });
  // Cut into the modes, which is where a short read would misalign everything
  // after it. (Bytes past the LED count are never read, so losing those is fine.)
  assert.throws(() => parseControllerData(good.subarray(0, Math.floor(good.length / 2)), 3), /ended early/);
  assert.throws(() => parseControllerData(Buffer.alloc(8), 3), /ended early/);
  // A mode count that cannot be real must not become a million-iteration loop.
  const silly = buildControllerData({ numLeds: 1 });
  silly.writeUInt16LE(60000, findModeCountOffset(silly));
  assert.throws(() => parseControllerData(silly, 3), /implausible|ended early/);
});

// The mode count sits right after the five strings at the front.
function findModeCountOffset(buf) {
  let at = 8;
  for (let i = 0; i < 5; i++) at += 2 + buf.readUInt16LE(at);
  return at;
}

// ------------------------------------------------------------------ the colours

test('what the room does: health first, then CI, then what he is doing', () => {
  assert.deepEqual(colorFor({ state: 'working' }), { r: 255, g: 122, b: 92 }, 'his own coral');
  assert.deepEqual(colorFor({ state: 'idle' }), { r: 127, g: 214, b: 194 });
  assert.equal(colorFor({ state: 'asking' }).g, 196);
  // An overheating GPU wins over a running task.
  assert.deepEqual(colorFor({ state: 'working', mood: 'scorching' }), { r: 255, g: 40, b: 0 });
  assert.deepEqual(colorFor({ state: 'idle', mood: 'hot' }), { r: 255, g: 90, b: 20 });
  // ...and a red build wins over everything but the hardware.
  assert.deepEqual(colorFor({ state: 'idle', ciFailing: 2 }), { r: 230, g: 57, b: 70 });
  assert.deepEqual(colorFor({ state: 'working', mood: 'hot', ciFailing: 2 }), { r: 255, g: 90, b: 20 });
  // Nothing to say: leave the lights alone rather than blanking them.
  assert.equal(colorFor({}), null);
  assert.equal(colorFor(), null);
  assert.equal(colorFor({ state: 'molting' }), null);
});

// ------------------------------------------------------------------ the client

/**
 * A fake OpenRGB. Answers the three requests that have replies, records every
 * packet it was sent, and can be told to behave badly.
 */
function fakeOpenRgb({ devices = [{ name: 'Fake Keyboard', numLeds: 3 }], serverProtocol = OUR_PROTOCOL, mode = 'normal' } = {}) {
  const seen = [];
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    if (mode === 'garbage') { socket.write(Buffer.from('HTTP/1.1 400 Bad Request\r\n\r\n')); return; }
    if (mode === 'hangup') { socket.destroy(); return; }
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const head = decodeHeader(buffer);
        if (!head || head.bad || buffer.length < HEADER_SIZE + head.size) return;
        const data = buffer.subarray(HEADER_SIZE, HEADER_SIZE + head.size);
        buffer = buffer.subarray(HEADER_SIZE + head.size);
        seen.push({ deviceId: head.deviceId, packetId: head.packetId, data: Buffer.from(data) });

        if (head.packetId === PACKET.REQUEST_PROTOCOL_VERSION) {
          const v = Buffer.alloc(4);
          v.writeUInt32LE(serverProtocol, 0);
          socket.write(encodePacket(0, PACKET.REQUEST_PROTOCOL_VERSION, v));
        } else if (head.packetId === PACKET.REQUEST_CONTROLLER_COUNT) {
          const c = Buffer.alloc(4);
          c.writeUInt32LE(devices.length, 0);
          socket.write(encodePacket(0, PACKET.REQUEST_CONTROLLER_COUNT, c));
        } else if (head.packetId === PACKET.REQUEST_CONTROLLER_DATA) {
          const want = data.length >= 4 ? data.readUInt32LE(0) : 0;
          const d = devices[head.deviceId] || devices[0];
          const body = buildControllerData({ ...d, version: Math.min(want || OUR_PROTOCOL, serverProtocol) });
          if (mode === 'dribble') {
            // Reply split across three writes: the client must reassemble it.
            socket.write(encodePacket(head.deviceId, PACKET.REQUEST_CONTROLLER_DATA, body).subarray(0, 7));
            setTimeout(() => socket.write(encodePacket(head.deviceId, PACKET.REQUEST_CONTROLLER_DATA, body).subarray(7, 30)), 5);
            setTimeout(() => socket.write(encodePacket(head.deviceId, PACKET.REQUEST_CONTROLLER_DATA, body).subarray(30)), 10);
          } else {
            socket.write(encodePacket(head.deviceId, PACKET.REQUEST_CONTROLLER_DATA, body));
          }
        }
        // SET_CLIENT_NAME, SETCUSTOMMODE and UPDATELEDS have no reply.
      }
    });
    socket.on('error', () => {});
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      seen,
      port: server.address().port,
      // UPDATELEDS has no reply, so setAll resolves once the packets are written,
      // not once they have been read. Tests that assert on them wait here.
      until: (predicate, what = 'the packets to arrive') => waitFor(() => predicate(seen), what),
    }));
  });
}

async function waitFor(predicate, what, { ms = 4000, step = 10 } = {}) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, step));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('setAll introduces itself, finds the devices and paints every LED', async t => {
  const rgb = await fakeOpenRgb({ devices: [{ name: 'Keyboard', numLeds: 3 }, { name: 'Strip', numLeds: 2 }] });
  t.after(() => rgb.server.close());
  const client = new OpenRgbClient({ port: rgb.port });

  const result = await client.setAll({ r: 255, g: 122, b: 92 });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.devices.map(d => [d.id, d.name, d.numLeds]), [[0, 'Keyboard', 3], [1, 'Strip', 2]]);

  await rgb.until(seen => seen.filter(p => p.packetId === PACKET.RGBCONTROLLER_UPDATELEDS).length === 2,
    'both devices to be painted');

  // It says who it is, so OpenRGB's own window shows "Shellby".
  const named = rgb.seen.find(p => p.packetId === PACKET.SET_CLIENT_NAME);
  assert.equal(named.data.toString('utf8').replace(/\0$/, ''), 'Shellby');

  // Each device: custom mode first, then the colours. The order matters, or the
  // device keeps running its own effect over the top.
  for (const id of [0, 1]) {
    const forDevice = rgb.seen.filter(p => p.deviceId === id && p.packetId >= 1050);
    assert.deepEqual(forDevice.map(p => p.packetId),
      [PACKET.RGBCONTROLLER_SETCUSTOMMODE, PACKET.RGBCONTROLLER_UPDATELEDS], `device ${id}`);
  }
  const leds = rgb.seen.find(p => p.deviceId === 0 && p.packetId === PACKET.RGBCONTROLLER_UPDATELEDS);
  assert.equal(leds.data.readUInt16LE(4), 3);
  assert.deepEqual([...leds.data.subarray(6, 10)], [255, 122, 92, 0]);
});

test('a reply split across several packets is reassembled', async t => {
  const rgb = await fakeOpenRgb({ mode: 'dribble' });
  t.after(() => rgb.server.close());
  const result = await new OpenRgbClient({ port: rgb.port }).setAll({ r: 1, g: 2, b: 3 });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.devices[0].numLeds, 3);
});

test('the protocol is negotiated down to whatever the server speaks', async t => {
  const rgb = await fakeOpenRgb({ serverProtocol: 2 });
  t.after(() => rgb.server.close());
  const client = new OpenRgbClient({ port: rgb.port });
  const probe = await client.probe();
  assert.equal(probe.ok, true, probe.error);
  assert.equal(probe.version, 2, 'an older OpenRGB is spoken to in its own version');
  assert.equal(probe.devices[0].numLeds, 3);
});

test('a newer server is still spoken to in the version we know', async t => {
  const rgb = await fakeOpenRgb({ serverProtocol: 9 });
  t.after(() => rgb.server.close());
  const probe = await new OpenRgbClient({ port: rgb.port }).probe();
  assert.equal(probe.version, OUR_PROTOCOL, 'never above what we can parse');
});

test('a device with no LEDs is skipped rather than sent an empty update', async t => {
  const rgb = await fakeOpenRgb({ devices: [{ name: 'Motherboard', numLeds: 0 }, { name: 'Fan', numLeds: 4 }] });
  t.after(() => rgb.server.close());
  const result = await new OpenRgbClient({ port: rgb.port }).setAll({ r: 9, g: 9, b: 9 });
  assert.equal(result.ok, true, result.error);
  await rgb.until(seen => seen.some(p => p.deviceId === 1 && p.packetId === PACKET.RGBCONTROLLER_UPDATELEDS),
    'the fan to be painted');
  assert.equal(rgb.seen.some(p => p.deviceId === 0 && p.packetId === PACKET.RGBCONTROLLER_UPDATELEDS), false,
    'the LED-less motherboard was left alone');
});

test('OpenRGB not running is a readable message, not a stack trace', async () => {
  // Port 1 has nothing on it.
  const result = await new OpenRgbClient({ port: 1 }).setAll({ r: 1, g: 1, b: 1 });
  assert.equal(result.ok, false);
  assert.match(result.error, /OpenRGB is not running|ECONNREFUSED|did not answer/);
});

test('something else on the port is noticed instead of parsed', async t => {
  const rgb = await fakeOpenRgb({ mode: 'garbage' });
  t.after(() => rgb.server.close());
  const result = await new OpenRgbClient({ port: rgb.port }).setAll({ r: 1, g: 1, b: 1 });
  assert.equal(result.ok, false);
  assert.match(result.error, /not OpenRGB|closed the connection/);
});

test('a server that hangs up mid-handshake is reported, not hung on', async t => {
  const rgb = await fakeOpenRgb({ mode: 'hangup' });
  t.after(() => rgb.server.close());
  const result = await new OpenRgbClient({ port: rgb.port }).setAll({ r: 1, g: 1, b: 1 });
  assert.equal(result.ok, false);
  assert.ok(result.error.length > 0);
});

test('setAll with no colour does nothing at all', async () => {
  const result = await new OpenRgbClient({ port: 1 }).setAll(null);
  assert.deepEqual(result, { ok: false, error: 'No colour to set.' });
});

test('a burst of mood changes does not open a pile of connections', async t => {
  const rgb = await fakeOpenRgb();
  t.after(() => rgb.server.close());
  const client = new OpenRgbClient({ port: rgb.port });
  const results = await Promise.all([
    client.setAll({ r: 1, g: 0, b: 0 }),
    client.setAll({ r: 0, g: 1, b: 0 }),
    client.setAll({ r: 0, g: 0, b: 1 }),
  ]);
  for (const r of results) assert.equal(r.ok, true, r.error);
  await rgb.until(seen => seen.filter(p => p.packetId === PACKET.RGBCONTROLLER_UPDATELEDS).length === 3,
    'all three updates to arrive');
  // Three conversations, one after another: three client-name packets, not a race.
  assert.equal(rgb.seen.filter(p => p.packetId === PACKET.SET_CLIENT_NAME).length, 3);
  const updates = rgb.seen.filter(p => p.packetId === PACKET.RGBCONTROLLER_UPDATELEDS);
  assert.deepEqual([...updates.at(-1).data.subarray(6, 10)], [0, 0, 1, 0], 'the last colour asked for is the one left on');
});
