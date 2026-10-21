// -----------------------------------------------------------------------------
// The races and gaps found by review 1, as tests of the corrected behaviour:
// the order of the requests between Standby and a wake-up, a Standby maybe
// sent, Pause on a toggle API, Mute and an older volume, the cap when a
// source wakes the speaker, cap checks that never starve the queue, and the
// minor points (model unknown, stale read, duplicate address, 4xx, full
// table, /data).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { KefApp } from '../src/app.js';
import { TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { KefError, httpRequest } from '../src/kef/http.js';
import { MemoryStore, emptyData } from '../src/store.js';
import { MAC, startFakeKef } from './fixtures/fakeKef.js';

const SELECTOR = 'kef';
const id = (key, mac = MAC) => `ext:${SELECTOR}:kef:${mac}${key ? `:${key}` : ''}`;
const timers = {
  setInterval: () => 1,
  clearInterval: () => {},
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h),
};
const FAST = {
  ...TIMINGS,
  requestTimeout: 400,
  minRequest: 30,
  commandBudget: 1_500,
  preRead: 400,
  confirmEvery: 20,
  wakeCheckDelay: 60,
  wakeChecks: 5,
  guardDelay: 60,
  guardChecks: 5,
  publishDelay: 5,
  persistDelay: 5,
};
const sleep = (ms = 40) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, what, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await pred()) return;
    await sleep(10);
  }
  assert.fail(`timed out: ${what}`);
}
const ack = (a) => (a?.success ? 'ok' : `FAIL: ${a?.error ?? JSON.stringify(a)}`);

/** The value of a write, whatever POST or GET. */
function writeOf(opts) {
  if (!opts.path.startsWith('/api/setData')) return undefined;
  if (opts.body) return JSON.parse(opts.body);
  const q = new URL(`http://x${opts.path}`).searchParams;
  return { path: q.get('path'), value: JSON.parse(q.get('value') ?? 'null') };
}

async function setup(
  t,
  { speaker, timings = {}, request = httpRequest, config, store = new MemoryStore() } = {},
) {
  const fake = await startFakeKef(speaker);
  t.after(() => fake.close());
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: config?.(fake) ?? { addresses: `127.0.0.1:${fake.port}` },
  });
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const app = new KefApp({
    gladys,
    logger,
    store,
    timers,
    timings: { ...FAST, ...timings },
    request,
  });
  registerHandlers(gladys, app, logger);
  t.after(() => app.stop());
  await gladys.connect();
  await waitFor(
    () => gladys.fake.discoveredDevices.some((d) => d.external_id === id()),
    'discovered',
  );
  const device = gladys.fake.discoveredDevices.find((d) => d.external_id === id());
  await gladys.fake.deviceCreated(device);
  await waitFor(() => gladys.fake.lastState(id('power')) !== undefined, 'power state');
  const set = (key, value = 1) =>
    gladys.fake
      .setValue(
        device,
        device.features.find((f) => f.external_id === id(key)),
        value,
      )
      .then(ack);
  return { fake, gladys, app, set, device };
}
const writes = (fake, path) => fake.writes.filter((w) => w.path === path);
const standbys = (fake) =>
  writes(fake, 'settings:/kef/play/physicalSource').filter(
    (w) => w.value.kefPhysicalSource === 'standby',
  );

test('1a. a Power on asked BEFORE a Standby never ends its guard: the speaker ends in standby', async (t) => {
  let slow = true;
  const request = async (opts) => {
    if (slow && writeOf(opts)?.value?.kefPhysicalSource === 'powerOn') {
      slow = false;
      await sleep(250);
    }
    return httpRequest(opts);
  };
  const { fake, set, app } = await setup(t, { speaker: { on: false }, request });
  const power = set('power_on');
  await sleep(40);
  assert.match(await set('standby'), /without confirmation/);
  assert.ok(app.guards.has(MAC));
  await power;
  await waitFor(() => fake.state.on === false, 'the standby asserted again by the guard');
  assert.ok(standbys(fake).length >= 2);
});

test('1b. a Power on asked AFTER a Standby wins: the older guard never starts nor writes', async (t) => {
  let slow = true;
  const request = async (opts) => {
    const res = await httpRequest(opts);
    if (slow && writeOf(opts)?.value?.kefPhysicalSource === 'standby') {
      slow = false;
      await sleep(80);
    }
    return res;
  };
  const { fake, set, app } = await setup(t, { speaker: { on: true }, request });
  const standby = set('standby');
  await sleep(20);
  assert.equal(await set('power_on'), 'ok');
  await standby;
  await sleep(500);
  assert.equal(fake.state.on, true, 'the last request (Power on) wins');
  assert.equal(app.guards.has(MAC), false);
  assert.equal(standbys(fake).length, 1);
});

test('2. a Standby maybe sent (500) starts the guard, reads the power, and says so', async (t) => {
  let fail = true;
  const request = async (opts) => {
    if (fail && writeOf(opts)?.value?.kefPhysicalSource === 'standby') {
      fail = false;
      throw new KefError('http', 'HTTP 500', { status: 500, maybeSent: true });
    }
    return httpRequest(opts);
  };
  const { fake, set } = await setup(t, { speaker: { on: true }, request });
  const before = fake.reads('settings:/kef/host/speakerStatus');
  assert.match(await set('standby'), /without confirmation/);
  assert.ok(fake.reads('settings:/kef/host/speakerStatus') > before, 'power read after the write');
  await waitFor(() => fake.state.on === false, 'the guard puts it in standby');
});

test('3a. two Pause presses at once: one toggle, the speaker paused', async (t) => {
  const { fake, set } = await setup(t, { speaker: { playState: 'playing' } });
  const [a, b] = await Promise.all([set('pause'), set('pause')]);
  assert.equal(writes(fake, 'player:player/control').length, 1);
  assert.equal(fake.state.playState, 'paused');
  assert.deepEqual([a, b], ['ok', 'ok']);
});

test('3b. a Pause after a Play whose toggle is in flight pauses the speaker', async (t) => {
  let slow = true;
  const request = async (opts) => {
    if (slow && writeOf(opts)?.value?.control === 'pause') {
      slow = false;
      await sleep(200);
    }
    return httpRequest(opts);
  };
  const { fake, set } = await setup(t, { speaker: { playState: 'paused' }, request });
  const play = set('play');
  await sleep(60);
  assert.equal(await set('pause'), 'ok');
  await play;
  await sleep(100);
  assert.equal(fake.state.playState, 'paused', 'paused after the Pause acked OK');
});

test('3c. Pause while buffering waits for a settled state, then pauses', async (t) => {
  const { fake, set } = await setup(t, { speaker: { playState: 'buffering' } });
  setTimeout(() => {
    fake.state.playState = 'playing';
  }, 150);
  assert.equal(await set('pause'), 'ok');
  assert.equal(fake.state.playState, 'paused');
});

test('4. a Mute cancels the older volume still waiting: the speaker stays muted', async (t) => {
  const { fake, set } = await setup(t, { speaker: { volume: 35 } });
  fake.delays['settings:/kef/host/speakerStatus'] = 250;
  const source = set('source', 'tv');
  await sleep(20);
  const volume = set('volume', 25);
  await sleep(10);
  const mute = set('mute');
  delete fake.delays['settings:/kef/host/speakerStatus'];
  const results = await Promise.all([source, volume, mute]);
  assert.match(results[1], /cancelled by Mute/);
  assert.equal(results[2], 'ok');
  assert.equal(fake.state.volume, 0);
  assert.deepEqual(
    writes(fake, 'player:volume').map((w) => w.value.i32_),
    [0],
  );
});

test('5. a source chosen in standby: the volume is at the cap when the command is acked', async (t) => {
  const { fake, set } = await setup(t, { speaker: { on: false, volume: 85 } });
  assert.equal(await set('source', 'tv'), 'ok');
  assert.equal(fake.state.on, true);
  assert.equal(fake.state.volume, 40, 'lowered within the command, as Power on');
});

test('6. a cap check never holds the queue past preRead: a command still gets through', async (t) => {
  const { fake, set } = await setup(t, {
    speaker: { volume: 80 },
    timings: { requestTimeout: 1_000, commandBudget: 1_500, wakeCheckDelay: 50, wakeChecks: 2 },
  });
  fake.ignore.add('player:volume');
  assert.match(await set('volume', 30), /without confirmation/);
  await sleep(150);
  assert.equal(await set('source', 'tv'), 'ok');
  assert.equal(fake.state.source, 'tv');
});

test('7. model unknown and release text failing: Standby is sent anyway (POST, then GET on a 4xx)', async (t) => {
  const request = async (opts) => {
    if (opts.path.includes('releasetext')) {
      throw new KefError('http', 'HTTP 503', { status: 503, maybeSent: true });
    }
    if (opts.body && writeOf(opts)?.value?.kefPhysicalSource === 'standby') {
      throw new KefError('http', 'HTTP 405', { status: 405, maybeSent: true });
    }
    return httpRequest(opts);
  };
  const { fake, set, app } = await setup(t, { request });
  assert.equal(app.data.devices[MAC].model, undefined);
  assert.equal(await set('standby'), 'ok');
  assert.equal(fake.state.on, false);
  assert.equal(app.data.devices[MAC].writeMethod, 'GET', 'the method that worked is kept');
});

test('9. a read begun before a command never republishes the older value', async (t) => {
  const { fake, set, app, gladys } = await setup(t, { speaker: { volume: 30 } });
  const link = [...app.links.values()][0];
  fake.delays['player:player/data'] = 200;
  link.lastAttempt = -Infinity;
  const reading = app.read(link);
  await sleep(60);
  assert.equal(await set('volume', 20), 'ok');
  await reading;
  await sleep(40);
  assert.equal(gladys.fake.lastState(id('volume')), 20);
});

test('10. the same speaker at two typed addresses: one loop, the address never flips', async (t) => {
  const { app } = await setup(t, {
    config: (f) => ({ addresses: `127.0.0.1:${f.port}, localhost:${f.port}` }),
  });
  const hosts = new Set();
  for (let i = 0; i < 3; i += 1) {
    for (const link of app.links.values()) {
      link.lastAttempt = -Infinity;
      await app.read(link);
      hosts.add(app.data.devices[MAC].host);
    }
  }
  assert.equal(hosts.size, 1);
  assert.equal([...app.links.values()].filter((l) => l.duplicateOf).length, 1);
});

test('11. a write refused with a 4xx is "refused", not "sent, without confirmation"', async (t) => {
  const request = async (opts) => {
    if (writeOf(opts)?.path === 'player:volume') {
      throw new KefError('http', 'HTTP 400', { status: 400, maybeSent: true });
    }
    return httpRequest(opts);
  };
  const { set } = await setup(t, { request });
  assert.match(await set('volume', 10), /refused by the speaker \(HTTP 400\)/);
});

test('12. a full table and a new speaker at a known address: the old one loses it', async (t) => {
  const store = new MemoryStore(emptyData());
  for (let i = 0; i < 20; i += 1) {
    const mac = `0000000000${String(i).padStart(2, '0')}`.replace(/^0/, '1');
    store.data.devices[mac] = { id: mac, host: `10.9.9.${i + 1}`, port: 80 };
  }
  const fake = await startFakeKef({ mac: '22:33:44:55:66:77' });
  t.after(() => fake.close());
  const gladys = createFakeGladys({ selector: SELECTOR, config: { addresses: '' } });
  const app = new KefApp({
    gladys,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    store,
    timers,
    timings: FAST,
  });
  registerHandlers(gladys, app);
  t.after(() => app.stop());
  await gladys.connect();
  const known = app.devices[0];
  known.host = '127.0.0.1';
  known.port = fake.port;
  app.syncLinks();
  const link = app.links.get(`127.0.0.1:${fake.port}`);
  link.lastAttempt = -Infinity;
  await app.read(link);
  assert.equal(known.host, '', 'the old speaker lost the address');
  assert.equal(link.state, null);
});

test('13. a command arrived while /data loads waits for it; old addresses are pruned', async (t) => {
  const fake = await startFakeKef();
  t.after(() => fake.close());
  const data = emptyData();
  data.devices[MAC] = { id: MAC, host: '127.0.0.1', port: fake.port, model: 'LSXII' };
  data.attempts['10.1.1.1'] = 5;
  let release;
  const store = new MemoryStore(data);
  const load = store.load.bind(store);
  store.load = () => new Promise((resolve) => (release = () => resolve(load())));
  const gladys = createFakeGladys({ selector: SELECTOR, config: { addresses: '' } });
  const app = new KefApp({
    gladys,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    store,
    timers,
    timings: FAST,
  });
  registerHandlers(gladys, app);
  t.after(() => app.stop());
  const connecting = gladys.connect();
  const second = app.start({});
  await sleep(20);
  const device = { external_id: id(), features: [{ external_id: id('standby') }] };
  const pending = app.setValue(device, device.features[0], 1);
  release();
  await Promise.all([connecting, second, pending]);
  assert.equal(fake.state.on, false, 'the Standby waited for /data and was sent');
  assert.equal(app.data.attempts['10.1.1.1'], undefined, 'an address no longer used is pruned');
});

// --- Review 2 ------------------------------------------------------------------------------

test('R1a. a Play ignored once: later, Pause on the paused speaker is "nothing to send", OK', async (t) => {
  const { fake, set } = await setup(t, { speaker: { playState: 'paused' } });
  fake.ignore.add('player:player/control');
  assert.match(await set('play'), /without confirmation/);
  fake.ignore.delete('player:player/control');
  await sleep(300);
  assert.equal(await set('pause'), 'ok');
  assert.equal(fake.state.playState, 'paused');
});

test('R1b. a Play refused with a 4xx never marks a Play as maybe sent', async (t) => {
  let refuse = true;
  const request = async (opts) => {
    if (refuse && writeOf(opts)?.value?.control === 'pause') {
      refuse = false;
      throw new KefError('http', 'HTTP 400', { status: 400, maybeSent: true });
    }
    return httpRequest(opts);
  };
  const { set, app } = await setup(t, { speaker: { playState: 'paused' }, request });
  assert.match(await set('play'), /refused by the speaker \(HTTP 400\)/);
  assert.equal(app.playUnconfirmed.has(MAC), false);
  const started = Date.now();
  assert.equal(await set('pause'), 'ok');
  assert.ok(Date.now() - started < 500, 'answered at once');
});

test('R1c. Play unconfirmed, then Standby: Pause on the silent speaker succeeds at once', async (t) => {
  const { fake, set } = await setup(t, { speaker: { playState: 'paused' } });
  fake.ignore.add('player:player/control');
  await set('play');
  fake.ignore.delete('player:player/control');
  assert.equal(await set('standby'), 'ok');
  const started = Date.now();
  assert.equal(await set('pause'), 'ok');
  assert.ok(Date.now() - started < 500);
});

test('R2. a slow speaker (400 ms an answer) waking up late is still brought back to the cap', async (t) => {
  const { fake, set } = await setup(t, {
    speaker: { on: false, volume: 20 },
    timings: { ...TIMINGS, wakeCheckDelay: 100, wakeChecks: 6, publishDelay: 5, persistDelay: 5 },
  });
  fake.wakeVolume = 85;
  fake.wakeDelay = 3_000;
  for (const path of [
    'settings:/system/primaryMacAddress',
    'settings:/kef/host/speakerStatus',
    'player:volume',
  ]) {
    fake.delays[path] = 400;
  }
  await set('power_on');
  await waitFor(() => fake.state.volume === 40, 'lowered by the cap checks', 15_000);
});

test('R3. Standby ignored, then a source asked last while on: the older guard stops', async (t) => {
  let drop = true;
  const request = async (opts) => {
    if (drop && writeOf(opts)?.value?.kefPhysicalSource === 'standby') {
      drop = false;
      return { status: 200, text: '[]' };
    }
    return httpRequest(opts);
  };
  const { fake, set, app } = await setup(t, { speaker: { on: true }, request });
  assert.match(await set('standby'), /without confirmation/);
  assert.equal(await set('source', 'tv'), 'ok');
  await sleep(500);
  assert.equal(fake.state.on, true, 'the last request (the source) wins');
  assert.equal(app.guards.has(MAC), false);
});
