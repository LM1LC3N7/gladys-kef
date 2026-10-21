// -----------------------------------------------------------------------------
// KefApp with the SDK's fake Gladys, the exact handlers of the container
// (src/handlers.js), a memory store and the fake KEF speaker on the loopback
// interface. The background round never fires: the tests drive it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { KefApp, parseVolumeCommand } from '../src/app.js';
import { NOTHING, TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { MemoryStore, emptyData } from '../src/store.js';
import { MAC, startFakeKef } from './fixtures/fakeKef.js';

const SELECTOR = 'kef';
const id = (key, mac = MAC) => `ext:${SELECTOR}:kef:${mac}${key ? `:${key}` : ''}`;

/** No background round; real (short) timeouts. */
const timers = {
  setInterval: () => 1,
  clearInterval: () => {},
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
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

async function waitFor(predicate, what, timeout = 3_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup(
  t,
  { speaker, fake, config, store = new MemoryStore(), timings = {}, ...rest } = {},
) {
  const device = fake ?? (await startFakeKef(speaker));
  if (!fake) {
    t.after(() => device.close());
  }
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: config ?? { addresses: `127.0.0.1:${device.port}` },
  });
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.message ?? a).join(' ')}`),
    ]),
  );
  const app = new KefApp({
    gladys,
    logger,
    store,
    timers,
    timings: { ...FAST, ...timings },
    ...rest,
  });
  registerHandlers(gladys, app, logger);
  t.after(() => app.stop());
  await gladys.connect();
  return { device, gladys, app, logs, store };
}

async function discovered(gladys, mac = MAC) {
  await waitFor(
    () => gladys.fake.discoveredDevices.some((d) => d.external_id === id(undefined, mac)),
    'the speaker in the Discovery tab',
  );
  return gladys.fake.discoveredDevices.find((d) => d.external_id === id(undefined, mac));
}

async function createDevice(gladys, mac = MAC) {
  const device = await discovered(gladys, mac);
  await gladys.fake.deviceCreated(device);
  await waitFor(() => gladys.fake.lastState(id('power', mac)) !== undefined, 'the power state');
  return device;
}

const set = (gladys, device, key, value = 1) =>
  gladys.fake.setValue(
    device,
    device.features.find((f) => f.external_id === id(key)),
    value,
  );

const writesTo = (fake, path) => fake.writes.filter((w) => w.path === path);

test('a typed address becomes a Gladys device; its states once created', async (t) => {
  const { gladys, device: fake } = await setup(t);
  const device = await discovered(gladys);
  assert.equal(device.name, 'Living room (LSXII)');
  assert.deepEqual(device.params, [{ name: 'IP_ADDRESS', value: '127.0.0.1' }]);
  const keys = device.features.map((f) => f.external_id.slice(id().length + 1));
  assert.deepEqual(keys, [
    'power',
    'power_on',
    'standby',
    'volume',
    'mute',
    'play',
    'pause',
    'next',
    'previous',
    'playback',
    'source',
    'title',
  ]);
  const byKey = Object.fromEntries(device.features.map((f) => [f.external_id.split(':').pop(), f]));
  // No switch, nothing an "everything on / off" could command; the power is read only.
  assert.ok(device.features.every((f) => f.category !== 'switch'));
  assert.deepEqual([byKey.power.category, byKey.power.read_only], ['unknown', true]);
  assert.deepEqual([byKey.power_on.category, byKey.power_on.type], ['button', 'push']);
  assert.deepEqual([byKey.standby.category, byKey.standby.type], ['button', 'push']);
  assert.deepEqual([byKey.volume.category, byKey.volume.type], ['music', 'volume']);
  assert.ok(
    device.features.every((f) => f.unit === undefined),
    'no unit',
  );
  assert.equal(byKey.source.supported_options.length, 6);
  assert.equal(gladys.fake.states.length, 0, 'no state before the device is created');

  await createDevice(gladys);
  await waitFor(() => gladys.fake.lastState(id('title')) !== undefined, 'the title');
  assert.equal(gladys.fake.lastState(id('power')), 1);
  assert.equal(gladys.fake.lastState(id('volume')), 30);
  assert.equal(gladys.fake.lastState(id('mute')), 0);
  assert.equal(gladys.fake.lastState(id('playback')), 1);
  assert.equal(gladys.fake.lastState(id('title')), 'Daft Punk - Get Lucky');
  assert.equal(gladys.fake.lastState(id('source')), 'wifi');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(gladys.fake.connectionStatus.message, undefined);
  assert.ok(fake.reads('settings:/system/primaryMacAddress') >= 1);
  for (const state of gladys.fake.states) {
    assert.ok(Number.isFinite(state.state) || typeof state.text === 'string', 'never NaN');
  }
});

test('a speaker is never read sooner than the interval: buttons, Discovery, reconnection, same config', async (t) => {
  const { gladys, device: fake } = await setup(t);
  const device = await discovered(gladys);
  await gladys.fake.deviceCreated(device);
  const reads = fake.reads('settings:/system/primaryMacAddress');
  assert.equal(reads, 1);
  await gladys.fake.action('find_devices');
  await gladys.fake.action('check_devices');
  await gladys.fake.scanRequest();
  gladys.emit('connected');
  await settle();
  await gladys.fake.configUpdated({ addresses: `127.0.0.1:${fake.port}` });
  await settle(60);
  assert.equal(fake.reads('settings:/system/primaryMacAddress'), reads, 'no read added');
  // The status and the Discovery list were published again on `connected`.
  const statuses = gladys.fake.connectionStatuses.length;
  gladys.emit('connected');
  await settle();
  assert.ok(gladys.fake.connectionStatuses.length > statuses, 'status republished');
  const check = await gladys.fake.action('check_devices');
  assert.match(check.data.message.en, /Living room \(LSXII\) \(127\.0\.0\.1\): on, volume 30/);
});

test('a restart never reads sooner than the interval (the last read is kept in /data)', async (t) => {
  const fake = await startFakeKef();
  t.after(() => fake.close());
  const store = new MemoryStore();
  const first = await setup(t, { fake, store });
  await discovered(first.gladys);
  await first.app.stop();
  assert.ok(store.data.attempts[`127.0.0.1:${fake.port}`] > 0, 'kept in /data');
  const reads = fake.reads('settings:/system/primaryMacAddress');
  const second = await setup(t, { fake, store });
  await settle(80);
  assert.equal(fake.reads('settings:/system/primaryMacAddress'), reads, 'no read at the restart');
  // The speaker is known from /data all the same.
  assert.ok(second.gladys.fake.discoveredDevices.some((d) => d.external_id === id()));
});

test('volume: capped by the configuration, confirmed by the value read back, validated first', async (t) => {
  const { gladys, device: fake, app } = await setup(t);
  const device = await createDevice(gladys);
  assert.equal((await set(gladys, device, 'volume', 25)).success, true);
  assert.equal(fake.state.volume, 25);
  // Default cap: 40 %.
  assert.equal((await set(gladys, device, 'volume', 90)).success, true);
  assert.equal(fake.state.volume, 40);
  await gladys.fake.configUpdated({ addresses: `127.0.0.1:${fake.port}`, max_volume: 20 });
  assert.equal(app.config.maxVolume, 20);
  assert.equal((await set(gladys, device, 'volume', '35')).success, true);
  assert.equal(fake.state.volume, 20);
  const before = fake.writes.length;
  for (const bad of [null, '', ' ', -1, 101, 12.5, '12abc', true, NaN, Infinity, '1e2', {}]) {
    assert.equal((await set(gladys, device, 'volume', bad)).success, false, String(bad));
  }
  assert.equal(fake.writes.length, before, 'no invalid volume reached the speaker');
  // The model decides POST (LSX II) as pykefcontrol does.
  assert.equal(writesTo(fake, 'player:volume')[0].method, 'POST');
  assert.deepEqual(writesTo(fake, 'player:volume')[0].value, { type: 'i32_', i32_: 25 });
});

test('a write accepted and ignored is "sent, without confirmation", then the cap is checked again', async (t) => {
  const { gladys, device: fake } = await setup(t);
  const device = await createDevice(gladys);
  fake.state.volume = 80; // set on the speaker itself
  fake.ignore.add('player:volume');
  const result = await set(gladys, device, 'volume', 30);
  assert.equal(result.success, false);
  assert.match(result.error ?? JSON.stringify(result), /without confirmation/);
  // The checks keep lowering it: once the speaker obeys, it is brought under the cap.
  fake.ignore.delete('player:volume');
  await waitFor(() => fake.state.volume <= 40, 'the volume lowered by the checks');
});

test('parseVolumeCommand accepts integers 0..100 only', () => {
  assert.equal(parseVolumeCommand(0), 0);
  assert.equal(parseVolumeCommand(100), 100);
  assert.equal(parseVolumeCommand(' 7 '), 7);
  for (const bad of [null, undefined, '', -1, 101, 1.5, '1.5', '0x10', true, [], {}]) {
    assert.equal(parseVolumeCommand(bad), undefined, String(bad));
  }
});

test('Power on: confirmed by the power read back, the volume brought back to the cap', async (t) => {
  const { gladys, device: fake } = await setup(t, { speaker: { on: false, volume: 85 } });
  const device = await createDevice(gladys);
  assert.equal(gladys.fake.lastState(id('power')), 0);
  assert.equal(gladys.fake.lastState(id('title')), NOTHING);
  assert.equal((await set(gladys, device, 'power_on')).success, true);
  assert.equal(fake.state.on, true);
  await waitFor(() => fake.state.volume === 40, 'the volume at the cap');
  assert.deepEqual(writesTo(fake, 'settings:/kef/play/physicalSource')[0].value, {
    type: 'kefPhysicalSource',
    kefPhysicalSource: 'powerOn',
  });
});

test('Power on: a slow wake-up, a lowering ignored, a volume raised during the window: all capped', async (t) => {
  const { gladys, device: fake } = await setup(t, { speaker: { on: false, volume: 20 } });
  const device = await createDevice(gladys);
  fake.wakeDelay = 200;
  fake.wakeVolume = 90;
  fake.ignore.add('player:volume');
  const result = await set(gladys, device, 'power_on');
  // Woken up within the budget, but the volume is not confirmed under the cap yet.
  assert.equal(result.success, true);
  assert.equal(fake.state.volume, 90);
  fake.ignore.delete('player:volume');
  await waitFor(() => fake.state.volume === 40, 'the volume lowered by the checks');
  // Raised on the speaker while the checks still run: lowered again.
  fake.state.volume = 70;
  await waitFor(() => fake.state.volume === 40, 'the volume lowered again in the window');
});

test('Standby: never queued, cancels the waking commands waiting, not blocked by a slow command', async (t) => {
  const { gladys, device: fake } = await setup(t);
  const device = await createDevice(gladys);
  // A slow read keeps the source command busy in the queue.
  fake.delays['settings:/kef/host/speakerStatus'] = 300;
  const source = set(gladys, device, 'source', 'tv');
  await settle(20);
  const play = set(gladys, device, 'play');
  const next = set(gladys, device, 'next');
  delete fake.delays['settings:/kef/host/speakerStatus'];
  const started = Date.now();
  const standby = await set(gladys, device, 'standby');
  assert.equal(standby.success, true, JSON.stringify(standby));
  assert.ok(Date.now() - started < 300, 'Standby did not wait for the source command');
  assert.equal(fake.state.on, false);
  const [sourceResult, playResult, nextResult] = await Promise.all([source, play, next]);
  assert.equal(sourceResult.success, false, 'the waking command running is not sent after Standby');
  assert.match(JSON.stringify(sourceResult), /cancelled by Standby/);
  assert.match(JSON.stringify(playResult), /cancelled by Standby/);
  assert.match(JSON.stringify(nextResult), /cancelled by Standby/);
  assert.equal(writesTo(fake, 'settings:/kef/play/physicalSource').length, 1, 'only the standby');
  assert.equal(fake.state.on, false);
});

test('Standby during a wake-up: "sent, without confirmation", and asserted again by the guard', async (t) => {
  const { gladys, device: fake } = await setup(t, { speaker: { on: false } });
  const device = await createDevice(gladys);
  fake.wakeDelay = 150;
  const power = set(gladys, device, 'power_on');
  await settle(30);
  const standby = await set(gladys, device, 'standby');
  assert.equal(standby.success, false);
  assert.match(JSON.stringify(standby), /without confirmation/);
  await power;
  // The speaker woke up after the Standby: the guard puts it back in standby.
  await waitFor(
    () =>
      fake.state.on === false && writesTo(fake, 'settings:/kef/play/physicalSource').length >= 3,
    'the standby asserted again',
  );
});

test('Standby works right after a restart, before the first read (speaker kept in /data)', async (t) => {
  const fake = await startFakeKef();
  t.after(() => fake.close());
  const store = new MemoryStore(emptyData());
  const first = await setup(t, { fake, store });
  const device = await createDevice(first.gladys);
  await first.app.stop();
  const reads = fake.reads('settings:/kef/host/speakerStatus');
  const second = await setup(t, { fake, store, config: { addresses: '' } });
  // The address is not typed any more: the speaker is known from /data only.
  second.gladys.fake.devices = [device];
  await second.app.refreshCreated();
  const result = await set(second.gladys, device, 'standby');
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(fake.state.on, false);
  assert.ok(fake.reads('settings:/kef/host/speakerStatus') > reads);
});

test('another speaker at the address (DHCP): nothing sent, the address forgotten; unreadable: kept', async (t) => {
  const { gladys, device: fake, app } = await setup(t);
  const device = await createDevice(gladys);
  fake.raw['settings:/system/primaryMacAddress'] = '[{"string_":"not a mac"}]';
  const unreadable = await set(gladys, device, 'standby');
  assert.equal(unreadable.success, false);
  assert.match(JSON.stringify(unreadable), /identity not read/);
  assert.equal(app.data.devices[MAC].host, '127.0.0.1', 'an unreadable answer keeps the address');
  delete fake.raw['settings:/system/primaryMacAddress'];
  fake.state.mac = '11:22:33:44:55:66';
  const before = fake.writes.length;
  const other = await set(gladys, device, 'volume', 10);
  assert.equal(other.success, false);
  assert.match(JSON.stringify(other), /another speaker answers/);
  assert.equal(fake.writes.length, before, 'nothing sent to the other speaker');
  assert.equal(app.data.devices[MAC].host, '');
  await waitFor(() => gladys.fake.lastState(id('power')) === 0, 'power 0 for the lost speaker');
});

test('mute keeps the previous volume; unmute restores it at most at the cap', async (t) => {
  const { gladys, device: fake } = await setup(t, { speaker: { volume: 35 } });
  const device = await createDevice(gladys);
  assert.equal((await set(gladys, device, 'mute')).success, true);
  assert.equal(fake.state.volume, 0);
  await waitFor(() => gladys.fake.lastState(id('mute')) === 1, 'muted');
  assert.equal((await set(gladys, device, 'mute')).success, true);
  assert.equal(fake.state.volume, 35);
  // Muted at 35, cap lowered to 20 meanwhile: unmuted at 20.
  assert.equal((await set(gladys, device, 'mute')).success, true);
  await gladys.fake.configUpdated({ addresses: `127.0.0.1:${fake.port}`, max_volume: 20 });
  assert.equal((await set(gladys, device, 'mute')).success, true);
  assert.equal(fake.state.volume, 20);
  // Muted by the speaker's own remote: left alone.
  fake.state.mute = true;
  const before = fake.writes.length;
  const result = await set(gladys, device, 'mute');
  assert.equal(result.success, false);
  assert.equal(fake.writes.length, before);
});

test('play and pause: the toggle only from the right state, confirmed; refused in standby', async (t) => {
  const { gladys, device: fake } = await setup(t, { speaker: { playState: 'paused' } });
  const device = await createDevice(gladys);
  assert.equal((await set(gladys, device, 'play')).success, true);
  assert.equal(fake.state.playState, 'playing');
  // Already playing: nothing sent.
  const controls = writesTo(fake, 'player:player/control').length;
  assert.equal((await set(gladys, device, 'play')).success, true);
  assert.equal(writesTo(fake, 'player:player/control').length, controls);
  assert.equal((await set(gladys, device, 'pause')).success, true);
  assert.equal(fake.state.playState, 'paused');
  fake.state.playState = 'buffering';
  assert.equal((await set(gladys, device, 'pause')).success, false);
  fake.state.on = false;
  const result = await set(gladys, device, 'next');
  assert.equal(result.success, false);
  assert.match(JSON.stringify(result), /in standby/);
});

test('Pause is never queued and cancels the Play still waiting', async (t) => {
  const { gladys, device: fake } = await setup(t, { speaker: { playState: 'paused' } });
  const device = await createDevice(gladys);
  fake.delays['player:volume'] = 250;
  const volume = set(gladys, device, 'volume', 10);
  await settle(20);
  const play = set(gladys, device, 'play');
  await settle(10);
  delete fake.delays['player:volume'];
  assert.equal((await set(gladys, device, 'pause')).success, true);
  assert.match(JSON.stringify(await play), /cancelled by Pause/);
  await volume;
  assert.equal(fake.state.playState, 'paused');
});

test('a command still queued at its deadline is dropped, never sent late', async (t) => {
  const { gladys, device: fake } = await setup(t, { timings: { commandBudget: 600 } });
  const device = await createDevice(gladys);
  fake.delays['player:volume'] = 450;
  // Two slow commands take the whole budget: the third is dropped when its turn comes.
  const first = set(gladys, device, 'volume', 10);
  await settle(5);
  const second = set(gladys, device, 'volume', 11);
  await settle(5);
  const third = set(gladys, device, 'source', 'tv');
  const results = await Promise.all([first, second, third]);
  assert.match(JSON.stringify(results[2]), /nothing sent/);
  await settle(600);
  assert.equal(writesTo(fake, 'settings:/kef/play/physicalSource').length, 0, 'never sent late');
  assert.equal(fake.state.source, 'wifi');
});

test('an unreachable speaker shows power 0 and is named in the status', async (t) => {
  const fake = await startFakeKef();
  const { gladys, app } = await setup(t, { fake });
  await createDevice(gladys);
  await fake.close();
  const link = [...app.links.values()][0];
  link.lastAttempt = -Infinity;
  await app.read(link);
  link.lastAttempt = -Infinity;
  await app.read(link);
  await waitFor(() => gladys.fake.lastState(id('power')) === 0, 'power 0');
  await waitFor(
    () => /Not answering/.test(gladys.fake.connectionStatus?.message?.en ?? ''),
    'the status message',
  );
  const set_ = await set(gladys, await discovered(gladys), 'standby');
  assert.equal(set_.success, false);
  assert.match(JSON.stringify(set_), /nothing sent/);
});

test('a 5xx on a secondary value never stops the read; a spaced-out speaker still takes Standby', async (t) => {
  const { gladys, device: fake, app } = await setup(t);
  const device = await createDevice(gladys);
  fake.failures['player:player/data'] = 503;
  fake.state.volume = 22;
  const link = [...app.links.values()][0];
  link.lastAttempt = -Infinity;
  await app.read(link);
  await waitFor(() => gladys.fake.lastState(id('volume')) === 22, 'the volume read anyway');
  // Reads spaced out after failures: Standby does not look at that.
  link.failures = 6;
  link.lastAttempt = Date.now();
  const before = fake.reads('settings:/system/primaryMacAddress');
  assert.equal((await set(gladys, device, 'standby')).success, true);
  assert.equal(fake.state.on, false);
  assert.equal(fake.reads('settings:/system/primaryMacAddress'), before + 1, 'identity read');
});

test('a late read of a removed address publishes nothing', async (t) => {
  const { gladys, device: fake, app } = await setup(t);
  await createDevice(gladys);
  const link = [...app.links.values()][0];
  fake.delays['settings:/kef/host/speakerStatus'] = 200;
  fake.state.volume = 12;
  link.lastAttempt = -Infinity;
  const reading = app.read(link);
  await settle(50);
  // The address is removed from the configuration while the read waits.
  await gladys.fake.configUpdated({ addresses: '' });
  app.data.devices[MAC].host = '';
  app.syncLinks();
  const count = gladys.fake.states.length;
  await reading;
  await settle(40);
  assert.ok(
    !gladys.fake.states.slice(count).some((s) => s.device_feature_external_id === id('volume')),
    'the late answer is not published',
  );
});

test('answers are bounded and checked: too large, junk, prototype keys', async (t) => {
  const { gladys, device: fake, app } = await setup(t);
  const device = await createDevice(gladys);
  fake.raw['player:volume'] = `[{"i32_": 10, "pad": "${'x'.repeat(70 * 1024)}"}]`;
  const result = await set(gladys, device, 'mute');
  assert.equal(result.success, false, 'an oversized answer is refused');
  fake.raw['player:volume'] = '[{"__proto__": {"polluted": true}, "i32_": "10"}]';
  assert.equal((await set(gladys, device, 'mute')).success, false, 'a string is not a volume');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(app.data.devices), null);
});

test('the state budget holds with simultaneous publications', async (t) => {
  const { gladys, app } = await setup(t);
  await createDevice(gladys);
  app.publisher.sent = [];
  const before = gladys.fake.states.length;
  const states = Array.from({ length: 200 }, (_, i) => ({
    device_feature_external_id: id('volume'),
    state: i,
  })).map((s, i) => ({ ...s, device_feature_external_id: `${id()}:x${i}` }));
  await Promise.all([
    app.publisher.publish(states),
    app.publisher.publish(states.map((s) => ({ ...s, state: s.state + 1 }))),
  ]);
  assert.ok(gladys.fake.states.length - before <= 250, 'at most 250 a minute');
});
