// Shellby on your desk lighting, through OpenRGB.
//
// His mood already shows on the wallpaper layer; this puts it on the keyboard,
// the fans and the strip behind the monitor. CI goes red and so does the room.
//
// OpenRGB runs its SDK server on this PC (127.0.0.1:6742 by default) and speaks
// a small binary protocol: no account, no cloud, no vendor software. The same
// goes for the alternatives people use it instead of, which is why this is the
// one worth supporting.
//
// The wire format below is OpenRGB's documented SDK protocol. The codec is pure
// and tested both ways round, and the client is tested against a fake server
// that serialises a controller the way OpenRGB does, over a real socket -- so
// framing, partial reads and the request order are all exercised.
const net = require('net');
const { EventEmitter } = require('events');

const DEFAULT_PORT = 6742;
const MAGIC = Buffer.from('ORGB', 'ascii');
const HEADER_SIZE = 16;
const CONNECT_TIMEOUT_MS = 2000;
const REPLY_TIMEOUT_MS = 4000;
const MAX_PACKET = 8 * 1024 * 1024;   // a 1000-LED board's controller data is ~100 KB
const MAX_DEVICES = 64;
const MAX_LEDS = 20000;

// We speak protocol 3. Version 4 added per-zone segments to the controller
// struct; asking for 3 means a newer OpenRGB serialises the older shape for us,
// rather than us guessing at a layout we cannot test.
const OUR_PROTOCOL = 3;

const PACKET = {
  REQUEST_CONTROLLER_COUNT: 0,
  REQUEST_CONTROLLER_DATA: 1,
  REQUEST_PROTOCOL_VERSION: 40,
  SET_CLIENT_NAME: 50,
  RGBCONTROLLER_UPDATELEDS: 1050,
  RGBCONTROLLER_SETCUSTOMMODE: 1053,
  RGBCONTROLLER_UPDATEMODE: 1101,
};

// ------------------------------------------------------------------ the wire

/** One packet: the 16-byte header, then its data. */
function encodePacket(deviceId, packetId, data = Buffer.alloc(0)) {
  const head = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(head, 0);
  head.writeUInt32LE(deviceId >>> 0, 4);
  head.writeUInt32LE(packetId >>> 0, 8);
  head.writeUInt32LE(data.length, 12);
  return Buffer.concat([head, data]);
}

/** The header of a packet, or null if there isn't a whole one yet. */
function decodeHeader(buf) {
  if (!buf || buf.length < HEADER_SIZE) return null;
  if (!buf.subarray(0, 4).equals(MAGIC)) return { bad: true };
  const size = buf.readUInt32LE(12);
  if (size > MAX_PACKET) return { bad: true };
  return { deviceId: buf.readUInt32LE(4), packetId: buf.readUInt32LE(8), size };
}

/** OpenRGB's colour word: 0x00BBGGRR, so the bytes land as r, g, b, 0. */
const packColor = ({ r, g, b }) => ((clamp255(b) << 16) | (clamp255(g) << 8) | clamp255(r)) >>> 0;
const clamp255 = v => Math.max(0, Math.min(255, Math.round(Number(v) || 0)));

/** A length-prefixed string: u16 length including the null, then the bytes. */
function encodeString(s) {
  const body = Buffer.from(`${s}\0`, 'utf8');
  const out = Buffer.alloc(2 + body.length);
  out.writeUInt16LE(body.length, 0);
  body.copy(out, 2);
  return out;
}

/**
 * A cursor over a controller-data buffer. Every read is bounds-checked, because
 * this is a struct from another program and a short read must fail loudly here
 * rather than silently return nonsense colours later.
 */
function reader(buf) {
  let at = 0;
  const need = n => { if (at + n > buf.length) throw new Error(`controller data ended early at ${at}`); };
  return {
    get offset() { return at; },
    u8() { need(1); return buf.readUInt8(at++); },
    u16() { need(2); const v = buf.readUInt16LE(at); at += 2; return v; },
    u32() { need(4); const v = buf.readUInt32LE(at); at += 4; return v; },
    i32() { need(4); const v = buf.readInt32LE(at); at += 4; return v; },
    skip(n) { need(n); at += n; },
    string() {
      const len = this.u16();
      need(len);
      const s = buf.toString('utf8', at, at + Math.max(0, len - 1));  // drop the null
      at += len;
      return s;
    },
  };
}

const MODE_COLORS_PER_LED = 1;

/**
 * REQUEST_CONTROLLER_DATA's reply -> { name, numLeds, saved }.
 *
 * Everything before the LED count is variable length, so the whole struct has to
 * be walked even though only two fields are wanted. Laid out as OpenRGB
 * serialises it; `version` is the negotiated protocol, which decides whether the
 * mode struct carries the brightness fields.
 *
 * `saved` is how the device was before we touched it: the active mode's bytes
 * exactly as OpenRGB sent them (UPDATEMODE takes the same layout back), and the
 * LED colours if that mode is a per-LED one. Switching the lighting off hands
 * these back, so the room returns to the user's colours rather than staying
 * on Shellby's last one (or whatever a device falls back to out of direct mode).
 */
function parseControllerData(buf, version = OUR_PROTOCOL) {
  const r = reader(buf);
  r.u32();            // data_size, which we already have
  r.u32();            // device type
  const name = r.string();
  if (version >= 1) r.string();   // vendor
  r.string();         // description
  r.string();         // version
  r.string();         // serial
  r.string();         // location

  const numModes = r.u16();
  const activeMode = r.i32();
  if (numModes > 4096) throw new Error(`implausible mode count ${numModes}`);
  let mode = null;
  for (let i = 0; i < numModes; i++) {
    const start = r.offset;
    r.string();       // mode name
    r.i32();          // value
    r.u32();          // flags
    r.u32();          // speed_min
    r.u32();          // speed_max
    if (version >= 3) { r.u32(); r.u32(); }   // brightness_min, brightness_max
    r.u32();          // colors_min
    r.u32();          // colors_max
    r.u32();          // speed
    if (version >= 3) r.u32();                // brightness
    r.u32();          // direction
    const colorMode = r.u32();
    const modeColors = r.u16();
    r.skip(modeColors * 4);
    if (i === activeMode) mode = { index: i, colorMode, bytes: buf.toString('base64', start, r.offset) };
  }

  const numZones = r.u16();
  if (numZones > 4096) throw new Error(`implausible zone count ${numZones}`);
  for (let i = 0; i < numZones; i++) {
    r.string();       // zone name
    r.u32();          // zone type
    r.u32();          // leds_min
    r.u32();          // leds_max
    r.u32();          // leds_count
    const matrixLen = r.u16();
    r.skip(matrixLen);
  }

  const numLeds = r.u16();
  if (numLeds > MAX_LEDS) throw new Error(`implausible LED count ${numLeds}`);
  return { name, numLeds, saved: mode && { mode: mode.index, modeBytes: mode.bytes, colors: mode.colorMode === MODE_COLORS_PER_LED ? ledColors(r, numLeds) : null } };
}

/**
 * The colour array after the LED names. Only wanted for a restore, so a short
 * struct here costs the colours rather than the whole device.
 */
function ledColors(r, numLeds) {
  try {
    for (let i = 0; i < numLeds; i++) { r.string(); r.u32(); }   // LED name, value
    const count = r.u16();
    if (count !== numLeds) return null;
    const words = [];
    for (let i = 0; i < count; i++) words.push(r.u32());
    return words;
  } catch {
    return null;
  }
}

/** UPDATEMODE: its own size, the mode index, then the mode struct as OpenRGB serialised it. */
function encodeUpdateMode(index, modeBase64) {
  const modeBytes = Buffer.from(modeBase64, 'base64');
  const head = Buffer.alloc(8);
  head.writeUInt32LE(8 + modeBytes.length, 0);
  head.writeInt32LE(index, 4);
  return Buffer.concat([head, modeBytes]);
}

/** UPDATELEDS with each LED's own colour word, as read back from the device. */
function encodeLedWords(words) {
  const data = Buffer.alloc(4 + 2 + words.length * 4);
  data.writeUInt32LE(data.length, 0);
  data.writeUInt16LE(words.length, 4);
  words.forEach((w, i) => data.writeUInt32LE(w >>> 0, 6 + i * 4));
  return data;
}

/** The UPDATELEDS payload: every LED on one device set to the same colour. */
function encodeUpdateLeds(numLeds, color) {
  const count = Math.max(0, Math.min(MAX_LEDS, numLeds | 0));
  const data = Buffer.alloc(4 + 2 + count * 4);
  data.writeUInt32LE(data.length, 0);
  data.writeUInt16LE(count, 4);
  const word = packColor(color);
  for (let i = 0; i < count; i++) data.writeUInt32LE(word, 6 + i * 4);
  return data;
}

// ------------------------------------------------------------------ colours

// Shellby's own palette, so the desk matches the crab.
const CORAL = { r: 255, g: 122, b: 92 };
const GLASS = { r: 127, g: 214, b: 194 };

/**
 * What the room should be, given what Shellby is doing and how the PC is.
 * Health beats work: an overheating GPU matters more than a running task.
 *   -> { r, g, b } | null (null: leave the lights alone)
 */
function colorFor({ state, mood, ciFailing = 0 } = {}) {
  if (mood === 'scorching') return { r: 255, g: 40, b: 0 };
  if (mood === 'hot') return { r: 255, g: 90, b: 20 };
  if (mood === 'dizzy' || mood === 'stuffed') return { r: 255, g: 180, b: 40 };
  if (ciFailing > 0) return { r: 230, g: 57, b: 70 };
  switch (state) {
    case 'working': return CORAL;
    case 'asking': return { r: 255, g: 196, b: 0 };
    case 'success': return { r: 80, g: 220, b: 120 };
    case 'error': return { r: 230, g: 57, b: 70 };
    case 'sleeping': return { r: 20, g: 40, b: 70 };
    case 'idle': return GLASS;
    default: return null;
  }
}

// ------------------------------------------------------------------ the client

/**
 * Talks to OpenRGB's SDK server. One short-lived connection per update: the
 * server is happy with that, it costs nothing at the rate the crab changes
 * mood, and it means a restarted OpenRGB is picked up without reconnect logic.
 */
class OpenRgbClient extends EventEmitter {
  constructor({ host = '127.0.0.1', port = DEFAULT_PORT, clientName = 'Shellby' } = {}) {
    super();
    Object.assign(this, { host, port, clientName });
    this.lastError = null;
    this.devices = null;       // [{ id, name, numLeds }] from the last successful talk
    this.busy = null;
  }

  /** Paint every device. Resolves { ok, devices } | { ok: false, error }. */
  /**
   * Paint every device. Resolves { ok, devices } | { ok: false, error }; each
   * device carries `saved`, how it was just before this paint.
   */
  setAll(color) {
    if (!color) return Promise.resolve({ ok: false, error: 'No colour to set.' });
    return this.oneAtATime(() => this.talk((session, id, info) => {
      if (!info.numLeds) return;
      // Custom (direct) mode first, or the device keeps running its own
      // effect and ignores the colours we send.
      session.send(id, PACKET.RGBCONTROLLER_SETCUSTOMMODE);
      session.send(id, PACKET.RGBCONTROLLER_UPDATELEDS, encodeUpdateLeds(info.numLeds, color));
    }));
  }

  /**
   * Put devices back how setAll found them: their own mode, and their own
   * colours if that mode is per-LED. `saved` is [{ id, name, saved }] from an
   * earlier setAll. A device is only touched if the same one is still at that
   * id, so a replugged keyboard doesn't get the RAM's mode.
   */
  restore(saved) {
    const byId = new Map((saved || []).filter(d => d?.saved?.modeBytes).map(d => [d.id, d]));
    if (!byId.size) return Promise.resolve({ ok: true, devices: this.devices || [] });
    return this.oneAtATime(() => this.talk((session, id, info) => {
      const was = byId.get(id);
      if (!was || was.name !== info.name) return;
      session.send(id, PACKET.RGBCONTROLLER_UPDATEMODE, encodeUpdateMode(was.saved.mode, was.saved.modeBytes));
      const colors = was.saved.colors;
      if (Array.isArray(colors) && colors.length === info.numLeds) {
        session.send(id, PACKET.RGBCONTROLLER_UPDATELEDS, encodeLedWords(colors));
      }
    }));
  }

  // One conversation at a time: a burst of mood changes must not open five,
  // and a restore must not interleave with a paint.
  async oneAtATime(run) {
    while (this.busy) { try { await this.busy; } catch { /* its own caller hears it */ } }
    this.busy = run().finally(() => { this.busy = null; });
    return this.busy;
  }

  /** Connect, read every device, and let `each` send it whatever it needs. */
  async talk(each) {
    let session;
    try {
      session = await this.connect();
      const version = await session.negotiate(this.clientName);
      const count = await session.controllerCount();
      const devices = [];
      for (let id = 0; id < Math.min(count, MAX_DEVICES); id++) {
        const info = await session.controller(id, version);
        devices.push({ id, ...info });
        each(session, id, info);
      }
      this.devices = devices.map(({ saved: _saved, ...d }) => d);
      this.lastError = null;
      return { ok: true, devices };
    } catch (e) {
      this.lastError = short(e);
      return { ok: false, error: this.lastError };
    } finally {
      session?.close();
    }
  }

  /** Is OpenRGB there? Used by Settings to show a green tick. */
  async probe() {
    let session;
    try {
      session = await this.connect();
      const version = await session.negotiate(this.clientName);
      const count = await session.controllerCount();
      const devices = [];
      for (let id = 0; id < Math.min(count, MAX_DEVICES); id++) {
        const { saved: _saved, ...info } = await session.controller(id, version);
        devices.push({ id, ...info });
      }
      this.devices = devices;
      this.lastError = null;
      return { ok: true, version, devices };
    } catch (e) {
      this.lastError = short(e);
      return { ok: false, error: this.lastError };
    } finally {
      session?.close();
    }
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      socket.setNoDelay(true);
      const giveUp = setTimeout(() => { socket.destroy(); reject(new Error('OpenRGB did not answer')); }, CONNECT_TIMEOUT_MS);
      socket.once('error', e => { clearTimeout(giveUp); reject(e); });
      socket.once('connect', () => { clearTimeout(giveUp); resolve(session(socket)); });
    });
  }
}

/**
 * One open connection. Replies have no request ids, so they are taken in order:
 * every request waits for its own reply before the next goes out.
 */
function session(socket) {
  let buffer = Buffer.alloc(0);
  const waiters = [];
  let failure = null;

  const fail = err => {
    failure = err;
    while (waiters.length) waiters.shift().reject(err);
  };

  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const head = decodeHeader(buffer);
      if (!head) return;
      if (head.bad) { fail(new Error('That is not OpenRGB on the other end')); socket.destroy(); return; }
      if (buffer.length < HEADER_SIZE + head.size) return;   // the rest is still coming
      const data = buffer.subarray(HEADER_SIZE, HEADER_SIZE + head.size);
      buffer = buffer.subarray(HEADER_SIZE + head.size);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve({ ...head, data });
    }
  });
  socket.on('error', e => fail(e));
  socket.on('close', () => fail(new Error('OpenRGB closed the connection')));

  const expect = () => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const timer = setTimeout(() => reject(new Error('OpenRGB went quiet')), REPLY_TIMEOUT_MS);
    waiters.push({
      resolve: v => { clearTimeout(timer); resolve(v); },
      reject: e => { clearTimeout(timer); reject(e); },
    });
  });

  const api = {
    send(deviceId, packetId, data) {
      if (failure) throw failure;
      socket.write(encodePacket(deviceId, packetId, data));
    },

    async negotiate(clientName) {
      // The name shows up in OpenRGB's own UI, so it is obvious who is driving.
      api.send(0, PACKET.SET_CLIENT_NAME, Buffer.from(`${clientName}\0`, 'utf8'));
      const ours = Buffer.alloc(4);
      ours.writeUInt32LE(OUR_PROTOCOL, 0);
      api.send(0, PACKET.REQUEST_PROTOCOL_VERSION, ours);
      const reply = await expect();
      const theirs = reply.data.length >= 4 ? reply.data.readUInt32LE(0) : 0;
      return Math.min(OUR_PROTOCOL, theirs);
    },

    async controllerCount() {
      api.send(0, PACKET.REQUEST_CONTROLLER_COUNT);
      const reply = await expect();
      if (reply.data.length < 4) throw new Error('OpenRGB sent no device count');
      return reply.data.readUInt32LE(0);
    },

    async controller(id, version) {
      // From protocol 1 on, the request carries the version it wants back.
      const want = Buffer.alloc(4);
      want.writeUInt32LE(version, 0);
      api.send(id, PACKET.REQUEST_CONTROLLER_DATA, version >= 1 ? want : undefined);
      const reply = await expect();
      return parseControllerData(reply.data, version);
    },

    // end(), never destroy(): UPDATELEDS has no reply, so the last device's
    // colours are still in the socket's buffer when we are done. destroy()
    // throws those away, and the last device keeps its old colour.
    close() { socket.end(); },
  };
  return api;
}

const short = e => String(e?.message || e).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 120)
  .replace(/^connect ECONNREFUSED.*/, 'OpenRGB is not running (or its SDK server is off)');

module.exports = {
  OpenRgbClient, colorFor, encodePacket, decodeHeader, encodeString,
  encodeUpdateLeds, encodeUpdateMode, encodeLedWords, parseControllerData, packColor,
  PACKET, DEFAULT_PORT, OUR_PROTOCOL, HEADER_SIZE, MAGIC,
};
