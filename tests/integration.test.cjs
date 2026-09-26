'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');

function harness() {
  const elements = new Map();
  const downloads = [];
  const document = {
    body: { appendChild() {} },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, {
        textContent: '', dataset: {}, style: {}, value: '20', innerHTML: '',
        addEventListener() {}, appendChild() {}, setAttribute() {}
      });
      return elements.get(id);
    },
    createElement() {
      return {
        className: '', textContent: '', style: {}, href: '', download: '',
        click() { downloads.push(this.download); },
        remove() {}
      };
    }
  };
  class Chart { constructor(_, config) { this.data = config.data; } update() {} }
  class Worker {
    constructor(url) { this.url = url; this.messages = []; }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
    emit(type, result) { this.onmessage({ data: { type, sessionId: this.messages[0].sessionId, result } }); }
  }
  let clock = 100000;
  const context = vm.createContext({
    document, Chart, Worker, Date: class extends Date { static now() { return clock; } },
    navigator: {}, console: { log() {}, warn() {}, error() {} },
    Uint8Array, DataView, TextEncoder, setTimeout() {}, clearTimeout() {},
    setInterval() {}, addEventListener() {}, alert() {},
    Blob: class { constructor(parts) { this.parts = parts; } },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} }
  });
  context.window = context;
  vm.runInContext(fs.readFileSync(path.join(root, 'imu-vitals.js'), 'utf8'), context);
  return {
    context, elements, downloads, run: code => vm.runInContext(code, context),
    advance: ms => { clock += ms; },
    controller: () => new context.ImuVitals()
  };
}

// A parsed v2 frame, shaped exactly like parseTelemetryFrame() output.
function telemetryFrame(overrides = {}) {
  return {
    receivedAtMs: 100000, rawFrame: new Uint8Array(42), sequence: 1, mac: 'AABBCCDDEEFF',
    tmp: 25, ax: 0.04, ay: 0.03, az: 9.81, gx: 0.01, gy: 0.02, gz: 0,
    roll: 1, pitch: 2, yaw: 3, v1: 3.7, status: 0,
    magActive: false, magRejected: false, sixAxis: false, ready: true,
    magStale: false, imuStale: false, calibrated: false,
    battery: 100, ms: 0, ...overrides
  };
}

// Drives real frames through the recording path. rawFrame is dropped because it does not survive
// serialization into the vm and the recording path never reads it.
function feedFrames(h, count, { startSequence = 0, startMs = 100000 } = {}) {
  for (let i = 0; i < count; i++) {
    const { rawFrame, ...tele } = telemetryFrame({ sequence: startSequence + i, ms: startMs + i * 20 });
    h.run(`acceptTelemetryFrame(${JSON.stringify(tele)})`);
  }
}

// Lets an async chain advance until it parks on a never-settling promise.
function flushMicrotasks() {
  return new Promise(resolve => setImmediate(resolve));
}

// BLE side of the page, with setTimeout accounting so tests can inspect pending timers.
function bleEnvironment(h) {
  const scheduled = new Map();
  const listeners = new Map();
  let nextTimerId = 1;
  h.context.setTimeout = h.context.window.setTimeout = (callback, delay) => {
    const id = nextTimerId++;
    scheduled.set(id, { callback, delay });
    return id;
  };
  h.context.clearTimeout = h.context.window.clearTimeout = id => scheduled.delete(id);

  const notify = {
    uuid: '0000fff1-0000-1000-8000-00805f9b34fb',
    addEventListener() {},
    async startNotifications() {}
  };
  const write = { uuid: '0000fff2-0000-1000-8000-00805f9b34fb' };
  const service = {
    uuid: '0000fff0-0000-1000-8000-00805f9b34fb',
    async getCharacteristics() { return [notify, write]; }
  };
  let connectCount = 0;
  const device = {
    name: 'CityU-C1-01', id: 'cityu-01',
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    }
  };
  const gatt = {
    connected: false,
    async connect() { this.connected = true; connectCount++; return this; },
    async getPrimaryServices() { return [service]; },
    disconnect() { this.connected = false; drop(); }
  };
  device.gatt = gatt;
  function drop() {
    const listener = listeners.get('gattserverdisconnected');
    if (listener) listener({ target: device });
  }
  let requestOptions;
  h.context.navigator.bluetooth = {
    async requestDevice(options) { requestOptions = options; return device; },
    async getDevices() { return [device]; }
  };

  return {
    scheduled, listeners, device, gatt, drop,
    connectCount: () => connectCount,
    requestOptions: () => requestOptions,
    searchTimers: () => [...scheduled.values()].filter(timer => timer.delay === 3000)
  };
}
function sample(index, period = 20, overrides = {}) {
  return { sequence: index % 65536, ms: (index * period) >>> 0,
    ax: 0.04, ay: 0.03, az: 9.81, gx: 0.01, gy: 0.02, gz: 0, ...overrides };
}
function feed(controller, from, to, period = 20) {
  for (let i = from; i < to; i++) controller.pushSample(sample(i, period));
}
const prediction = {
  HR_bpm: 90, RR_bpm: 18, heart_valid: true, respiratory_valid: true,
  quality_gate_passed: true, HR_confidence: 0.8, RR_confidence: 0.9,
  session_elapsed_s: 10, available_windows: [10], warmup_progress: 1 / 6
};

test('all samples survive calibration; MCU time determines fs and radian input', () => {
  const h = harness(), c = h.controller();
  c.startSession();
  feed(c, 0, 100);
  const messages = c.worker.messages;
  assert.equal(messages[0].options.sampleRateHz, 50);
  assert.equal(messages[0].options.accelUnit, 'mps2');
  assert.equal(messages[0].options.gyroUnit, 'rad');
  assert.equal(messages.filter(m => m.type === 'sample').length, 100);
  assert.equal(messages[1].sample.gx, 0.01);
  assert.equal(messages.at(-1).sample.timestamp_s, 99 / 50);
  c.pushSample(sample(99));
  assert.equal(c.sampleCount, 100, 'duplicate notification must not double count');
});

test('counter rollover continues, packet loss and clock reset restart history', () => {
  const h = harness(), c = h.controller();
  c.startSession();
  for (let i = 0; i < 60; i++) c.pushSample(sample(i, 20, {
    sequence: (65520 + i) % 65536, ms: (4294967200 + i * 20) >>> 0
  }));
  assert.equal(c.sampleCount, 60);
  const old = c.worker;
  c.pushSample(sample(62, 20, { sequence: (65520 + 62) % 65536, ms: (4294967200 + 62 * 20) >>> 0 }));
  assert.equal(old.terminated, true);
  assert.equal(c.pending.length, 1);
  feed(c, 0, 40);
  assert.equal(c.sampleCount, 40, 'new device uptime must start a fresh session');
});

test('actual period changes recalibrate; unsupported fs reports an error', () => {
  const h = harness(), c = h.controller();
  c.startSession(); feed(c, 0, 60);
  const old = c.worker;
  for (let i = 60; i < 130; i++) c.pushSample(sample(i, 20, { ms: 1180 + (i - 59) * 40 }));
  assert.equal(old.terminated, true);
  assert.equal(c.sampleRateHz, 25);
  c.startSession(); feed(c, 0, 8, 200);
  assert.equal(c.active, false);
  assert.match(h.elements.get('vitalsStatus').textContent, /采样率不支持/);
});

test('quality flags do not hide finite results; invalid numbers and disconnect clear values', () => {
  const h = harness(), c = h.controller();
  c.startSession(); feed(c, 0, 50);
  const worker = c.worker;
  worker.emit('prediction', prediction);
  assert.equal(h.elements.get('vitalsHR').textContent, '90.0');
  assert.equal(h.elements.get('vitalsRR').textContent, '18.0');
  worker.emit('prediction', { ...prediction, quality_gate_passed: false, heart_valid: false, respiratory_valid: false });
  assert.equal(h.elements.get('vitalsHR').textContent, '90.0');
  assert.equal(h.elements.get('vitalsRR').textContent, '18.0');
  assert.equal(c.chart.data.datasets[0].data.at(-1).y, 90);
  worker.emit('prediction', { ...prediction, HR_bpm: null, RR_bpm: NaN });
  assert.equal(h.elements.get('vitalsHR').textContent, '--');
  assert.equal(h.elements.get('vitalsRR').textContent, '--');
  c.reset('蓝牙已断开');
  worker.emit('prediction', prediction);
  assert.equal(h.elements.get('vitalsHR').textContent, '--');
  assert.equal(c.chart.data.datasets[0].data.length, 0);
});

test('silent data loss, worker error and backlog cannot leave stale readings', () => {
  const h = harness(), c = h.controller();
  c.startSession(); feed(c, 0, 50);
  c.worker.emit('prediction', prediction);
  h.advance(3001); c.checkFreshness();
  assert.equal(h.elements.get('vitalsHR').textContent, '--');
  assert.equal(c.active, true);
  feed(c, 50, 100);
  c.worker.onerror({ message: 'test failure' });
  assert.equal(c.active, false);
  assert.equal(h.elements.get('vitalsHR').textContent, '--');
  c.startSession(); feed(c, 0, 1100);
  assert.equal(c.active, false);
  assert.match(h.elements.get('vitalsStatus').textContent, /处理滞后/);
});

function frame(sequence) {
  const bytes = new Uint8Array(42), view = new DataView(bytes.buffer);
  bytes.set([0xA5, 0x5A, 2, 42]);
  view.setUint16(4, sequence, true);
  view.setInt16(18, 981, true);
  view.setInt16(20, 100, true);
  view.setUint16(34, 0x49, true);
  view.setUint32(36, sequence * 20, true);
  let crc = 0xFFFF;
  for (const byte of bytes.subarray(0, 40)) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = ((crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1) & 0xFFFF;
  }
  view.setUint16(40, crc, true);
  return bytes;
}

test('fragmented and batched v2 42-byte Notify frames reach the algorithm only after CRC verification', () => {
  const h = harness();
  h.run(fs.readFileSync(path.join(root, 'app.js'), 'utf8'));
  h.run('imuVitals.startSession();');
  const good = Array.from({ length: 50 }, (_, i) => frame(i));
  const bad = frame(50); bad[18] ^= 0x01;
  const stream = new Uint8Array(42 * 51);
  [...good, bad].forEach((bytes, index) => stream.set(bytes, index * 42));
  for (let offset = 0; offset < stream.length; offset += 73) {
    const chunk = stream.slice(offset, offset + 73);
    h.context.event = { target: { value: new DataView(chunk.buffer) } };
    h.run('handleNotify(event)');
  }
  assert.equal(h.run('totalFrameCount'), 50);
  assert.equal(h.run('imuVitals.sampleCount'), 50);
  assert.equal(h.run('imuVitals.worker.messages[1].sample.gx'), 1);
  assert.equal(h.run('latestTele.magActive'), true);
  assert.equal(h.run('latestTele.ready'), true);
  assert.equal(h.run('latestTele.calibrated'), true);
  assert.equal(h.run('latestTele.ms'), 49 * 20);
  h.run('onDisconnected()');
  assert.equal(h.run('imuVitals.active'), false);
});

test('CityU devices are filtered, retained-device reconnect works without getDevices, and manual disconnect stops it', async () => {
  const h = harness();
  h.run(fs.readFileSync(path.join(root, 'app.js'), 'utf8'));

  const scheduled = new Map();
  let nextTimerId = 1;
  h.context.setTimeout = h.context.window.setTimeout = (callback, delay) => {
    const id = nextTimerId++;
    scheduled.set(id, { callback, delay });
    return id;
  };
  h.context.clearTimeout = h.context.window.clearTimeout = id => scheduled.delete(id);
  // Recording timers share this stub, so assert on the 3s reconnect timer specifically.
  const searchTimers = () => [...scheduled.values()].filter(timer => timer.delay === 3000);
  h.run('stopAutoSearch()');

  const listeners = new Map();
  const notify = {
    uuid: '0000fff1-0000-1000-8000-00805f9b34fb',
    addEventListener() {},
    async startNotifications() {}
  };
  const write = { uuid: '0000fff2-0000-1000-8000-00805f9b34fb' };
  const service = {
    uuid: '0000fff0-0000-1000-8000-00805f9b34fb',
    async getCharacteristics() { return [notify, write]; }
  };
  let connectCount = 0;
  const gatt = {
    connected: false,
    async connect() { this.connected = true; connectCount++; return this; },
    async getPrimaryServices() { return [service]; },
    disconnect() {
      this.connected = false;
      const listener = listeners.get('gattserverdisconnected');
      if (listener) listener({ target: device });
    }
  };
  const device = {
    name: 'CityU-C1-01', id: 'cityu-01', gatt,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    }
  };
  let requestOptions;
  h.context.navigator.bluetooth = {
    async requestDevice(options) { requestOptions = options; return device; },
    async getDevices() { return [{ name: 'Other-device' }, device]; }
  };

  await h.run('connectBle()');
  assert.equal(requestOptions.filters.length, 1);
  assert.equal(requestOptions.filters[0].namePrefix, 'CityU');
  assert.equal(connectCount, 1);
  assert.equal(h.elements.get('btState').textContent, '已连接');
  assert.equal(searchTimers().length, 0, 'search timer must stop after connection');

  gatt.connected = false;
  listeners.get('gattserverdisconnected')({ target: device });
  assert.equal(searchTimers().length, 1);
  assert.equal(searchTimers()[0].delay, 3000);
  delete h.context.navigator.bluetooth.getDevices;
  await h.run('autoSearchCityUDevices()');
  assert.equal(connectCount, 2);
  assert.equal(h.elements.get('deviceName').textContent, 'CityU-C1-01');
  assert.equal(searchTimers().length, 0, 'reconnect must cancel the pending search');

  await h.run('disconnectBle()');
  assert.equal(h.run('autoConnectEnabled'), false);
  assert.equal(searchTimers().length, 0, 'manual disconnect must pause automatic reconnect');
});

test('connecting starts recording without a click', async () => {
  const h = harness();
  h.run(fs.readFileSync(path.join(root, 'app.js'), 'utf8'));
  bleEnvironment(h);

  await h.run('connectBle()');

  assert.equal(h.run('isRecording'), true);
  assert.equal(h.run('recordRunActive'), true);
  assert.equal(h.elements.get('btnRecord').textContent, '停止记录（每5分钟自动保存）');
});

test('a dropped link keeps the recording intent and saves the partial chunk', async () => {
  const h = harness();
  h.run(fs.readFileSync(path.join(root, 'app.js'), 'utf8'));
  const ble = bleEnvironment(h);

  await h.run('connectBle()');
  feedFrames(h, 40);
  assert.equal(h.run('recordBuffer.length'), 40);

  ble.drop();

  assert.equal(h.run('isRecording'), false, 'link loss ends the current chunk');
  assert.equal(h.run('recordRunActive'), true, 'but the intent to record survives');
  assert.equal(h.run('recordChunkIndex'), 2, 'the saved chunk consumed part 001');
  assert.equal(h.downloads.length, 1);
  assert.match(h.downloads[0], /part001\.csv$/);
});

test('reconnecting resumes recording and continues the part numbering', async () => {
  const h = harness();
  h.run(fs.readFileSync(path.join(root, 'app.js'), 'utf8'));
  const ble = bleEnvironment(h);

  await h.run('connectBle()');
  feedFrames(h, 40);
  ble.drop();
  assert.equal(h.downloads.length, 1);

  await h.run('autoSearchCityUDevices()');

  assert.equal(h.run('isRecording'), true, 'reconnect must resume recording without a click');
  assert.equal(h.run('recordChunkIndex'), 2, 'numbering must continue, not restart at part 1');

  feedFrames(h, 40, { startSequence: 40, startMs: 100800 });
  ble.drop();
  assert.equal(h.downloads.length, 2);
  assert.match(h.downloads[1], /part002\.csv$/, 'the resumed chunk must be part 002');
});

test('a manual stop ends the run so the next connection starts a fresh part 1', async () => {
  const h = harness();
  h.run(fs.readFileSync(path.join(root, 'app.js'), 'utf8'));
  const ble = bleEnvironment(h);

  await h.run('connectBle()');
  feedFrames(h, 40);
  h.run('toggleRecord()');

  assert.equal(h.run('isRecording'), false);
  assert.equal(h.run('recordRunActive'), false, 'a manual stop is an explicit end of the run');

  ble.drop();
  await h.run('autoSearchCityUDevices()');

  assert.equal(h.run('isRecording'), true, 'a new connection still auto-starts recording');
  assert.equal(h.run('recordChunkIndex'), 1, 'a fresh run restarts numbering at part 1');
});

test('a chunk below the jitter threshold is dropped without consuming a part number', async () => {
  const h = harness();
  h.run(fs.readFileSync(path.join(root, 'app.js'), 'utf8'));
  const ble = bleEnvironment(h);

  await h.run('connectBle()');
  feedFrames(h, 5);
  ble.drop();

  assert.equal(h.downloads.length, 0, 'a 5-row fragment must not become a file');
  assert.equal(h.run('recordChunkIndex'), 1, 'a dropped fragment must not consume part 001');
  assert.equal(h.run('recordRunActive'), true, 'dropping a fragment must not end the run');
});

// Reproduces the field report "stuck at 正在连接 CityU_..., only a refresh recovers".
// The four BLE handshake awaits have no upper bound; the diagnostic run proved that one
// never-settling await leaves connectionAttemptInProgress true forever, which starves both
// the manual button (app.js connectBle) and automatic reconnect (app.js autoSearchCityUDevices).
test('a hanging gatt.connect() times out and releases the page for retries', async () => {
  const h = harness();
  h.run(fs.readFileSync(path.join(root, 'app.js'), 'utf8'));
  const ble = bleEnvironment(h);

  // Device is in range but the handshake never settles: neither resolve nor reject.
  ble.gatt.connect = () => new Promise(() => {});

  h.run('connectBle()'); // deliberately not awaited — it never settles
  await flushMicrotasks();
  assert.equal(h.run('connectionAttemptInProgress'), true, 'the attempt is in flight');

  const timeoutMs = h.run('CONNECT_TIMEOUT_MS');
  const timer = [...ble.scheduled.values()].find(entry => entry.delay === timeoutMs);
  assert.ok(timer, 'a connection timeout must be armed while the handshake is outstanding');

  timer.callback();
  await flushMicrotasks();

  assert.equal(h.run('connectionAttemptInProgress'), false, 'the timeout must release the guard');
  assert.equal(h.elements.get('btState').textContent, '等待 CityU 设备', 'the stuck state must move on');

  // With the guard released, a retry has to actually dial again.
  ble.gatt.connect = async function () { this.connected = true; return this; };
  await h.run('autoSearchCityUDevices()');
  assert.equal(h.run('connectionAttemptInProgress'), false);
  assert.equal(h.elements.get('btState').textContent, '已连接', 'the retry must be able to succeed');
});

test('a handshake that resolves after the timeout is cleaned up instead of dangling', async () => {
  const h = harness();
  h.run(fs.readFileSync(path.join(root, 'app.js'), 'utf8'));
  const ble = bleEnvironment(h);

  let resolveConnect;
  const lateServer = { connected: true, disconnected: false, disconnect() { this.disconnected = true; } };
  ble.gatt.connect = () => new Promise(resolve => { resolveConnect = resolve; });

  h.run('connectBle()');
  await flushMicrotasks();

  const timeoutMs = h.run('CONNECT_TIMEOUT_MS');
  [...ble.scheduled.values()].find(entry => entry.delay === timeoutMs).callback();
  await flushMicrotasks();
  assert.equal(h.run('connectionAttemptInProgress'), false);

  // The dial finally comes back, long after we gave up on it.
  resolveConnect(lateServer);
  await flushMicrotasks();

  assert.equal(lateServer.disconnected, true, 'a late success must not leave a dangling GATT link');
});

test('bundled browser worker matches source estimator without quality gating', () => {
  const { RealtimeImuVitalsEstimator } = require('../imu/src/realtime');
  const options = { sampleRateHz: 50, accelUnit: 'mps2', gyroUnit: 'rad' };
  const source = new RealtimeImuVitalsEstimator(options);
  const replies = [];
  const self = { postMessage: message => replies.push(message) };
  const context = vm.createContext({ self, performance });
  vm.runInContext(fs.readFileSync(path.join(root, 'imu/dist/imu-vitals.worker.js'), 'utf8'), context);
  self.onmessage({ data: { type: 'init', sessionId: 1, options } });
  let expected;
  for (let i = 0; i < 550; i++) {
    const t = i / 50;
    const input = { timestamp_s: t,
      ax: 0.01 * Math.sin(2 * Math.PI * 1.5 * t),
      ay: 0.008 * Math.cos(2 * Math.PI * 1.5 * t),
      az: 9.81 + 0.02 * Math.sin(2 * Math.PI * 0.3 * t),
      gx: 0.0001 * Math.sin(t), gy: 0.0001 * Math.cos(t), gz: 0 };
    expected = source.pushSample(input) || expected;
    self.onmessage({ data: { type: 'sample', sessionId: 1, sample: input } });
  }
  const predictions = replies.filter(message => message.type === 'prediction');
  assert.equal(predictions.length, 2);
  const actual = predictions.at(-1).result;
  for (const key of ['HR_bpm', 'RR_bpm', 'heart_valid', 'respiratory_valid', 'session_elapsed_s']) {
    assert.equal(actual[key], expected[key], key);
  }
  assert.ok(Math.abs(source.samples[0].gy - 0.0001 * 180 / Math.PI) < 1e-12, 'radians must convert exactly once');
});
