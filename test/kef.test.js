// -----------------------------------------------------------------------------
// The KEF layer alone: the parsers of untrusted answers (pure), the HTTP
// transport bounds (size, time, redirects) against a server on the loopback
// interface, and the client (POST or GET writes by model), against the fake
// speaker.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { KefClient } from '../src/kef/client.js';
import { httpRequest } from '../src/kef/http.js';
import {
  cleanText,
  isSafeId,
  nowPlaying,
  parseItem,
  parseMac,
  parsePlayer,
  parseRelease,
  parseSource,
  parseStatus,
  parseVolume,
} from '../src/kef/parse.js';
import { sanitizeData } from '../src/store.js';
import { startFakeKef } from './fixtures/fakeKef.js';

test('parsers keep only the expected shapes', () => {
  assert.deepEqual(parseItem('[{"i32_": 5}]'), { i32_: 5 });
  for (const bad of ['', 'null', '{}', '[]', '[1]', '[null]', '[[1]]', 'not json']) {
    assert.equal(parseItem(bad), undefined, bad);
  }
  assert.equal(parseMac({ string_: 'AA:BB:CC:DD:EE:FF' }), 'aabbccddeeff');
  for (const bad of [
    { string_: '00:00:00:00:00:00' },
    { string_: 'aabbcc' },
    { string_: 12 },
    {},
  ]) {
    assert.equal(parseMac(bad), undefined);
  }
  assert.deepEqual(parseRelease({ string_: 'LS50W2_3.1' }), { model: 'LS50WII', firmware: '3.1' });
  assert.deepEqual(parseRelease({ string_: 'lsx2_1' }), { model: 'LSXII', firmware: '1' });
  assert.equal(parseRelease({ string_: '<script>_1' }).model, undefined);
  assert.equal(parseStatus({ kefSpeakerStatus: 'powerOn' }), true);
  assert.equal(parseStatus({ kefSpeakerStatus: 'standby' }), false);
  assert.equal(parseStatus({ kefSpeakerStatus: 'other' }), undefined);
  assert.equal(parseSource({ kefPhysicalSource: 'optic' }), 'optic');
  assert.equal(parseSource({ kefPhysicalSource: '__proto__' }), undefined);
  assert.equal(parseVolume({ i32_: 100 }), 100);
  for (const bad of [{ i32_: 101 }, { i32_: -1 }, { i32_: 1.5 }, { i32_: '5' }, {}]) {
    assert.equal(parseVolume(bad), undefined);
  }
  // A key inherited from the prototype is never read.
  assert.equal(parseVolume(Object.create({ i32_: 5 })), undefined);
  const player = parsePlayer({
    state: 'playing',
    trackRoles: { title: 'Ti‮tle\u0007', mediaData: { metaData: { artist: 'Art' } } },
  });
  assert.deepEqual(player, { state: 'playing', title: 'Ti tle', artist: 'Art' });
  assert.equal(nowPlaying(player), 'Art - Ti tle');
  assert.equal(parsePlayer({ state: 'weird' }).state, 'other');
  assert.equal(cleanText('x'.repeat(500), 10).length, 10);
  assert.equal(isSafeId('constructor'), false);
});

test('the store keeps only clean entries, in tables without prototype', () => {
  const data = sanitizeData({
    devices: {
      aabbccddeeff: {
        id: 'aabbccddeeff',
        host: '10.0.0.2',
        port: 80,
        model: 'LSXII',
        mutedVolume: 30,
      },
      __proto__: { id: '__proto__' },
      bad: { id: 'bad' },
      112233445566: { id: 'other', host: 'x' },
    },
    attempts: { '10.0.0.2': 123, 'bad key!': 5, '10.0.0.3': 'x' },
  });
  assert.deepEqual(Object.keys(data.devices), ['aabbccddeeff']);
  assert.equal(Object.getPrototypeOf(data.devices), null);
  assert.equal(data.devices.aabbccddeeff.mutedVolume, 30);
  assert.deepEqual(Object.keys(data.attempts), ['10.0.0.2']);
});

async function server(t, handler) {
  const srv = http.createServer(handler);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => srv.close(resolve)));
  srv.unref();
  return srv.address().port;
}

test('the transport bounds the size, the time, and refuses redirects and errors', async (t) => {
  const port = await server(t, (req, res) => {
    if (req.url === '/big') {
      res.writeHead(200);
      res.write('x'.repeat(40 * 1024));
      res.end('y'.repeat(40 * 1024));
    } else if (req.url === '/redirect') {
      res.writeHead(302, { Location: 'http://example.invalid/' }).end();
    } else if (req.url === '/error') {
      res.writeHead(503).end();
    } else if (req.url === '/slow') {
      res.writeHead(200);
      res.write('[');
      // never ends: the deadline covers the body too
    } else {
      res.writeHead(200).end('[{"i32_":1}]');
    }
  });
  const ask = (path, options = {}) =>
    httpRequest({ host: '127.0.0.1', port, path, timeout: 300, ...options });
  assert.equal((await ask('/ok')).text, '[{"i32_":1}]');
  await assert.rejects(ask('/big'), { code: 'too_large' });
  await assert.rejects(ask('/redirect'), { code: 'redirect' });
  await assert.rejects(ask('/error'), { code: 'http', status: 503 });
  const started = Date.now();
  await assert.rejects(ask('/slow'), { code: 'timeout', maybeSent: true });
  assert.ok(Date.now() - started < 1_000);
  await assert.rejects(httpRequest({ host: '127.0.0.1', port: 1, path: '/', timeout: 300 }), {
    unreachable: true,
    maybeSent: false,
  });
});

test('writes: POST of JSON for the models pykefcontrol lists, GET for the others', async (t) => {
  const fake = await startFakeKef();
  t.after(() => fake.close());
  const client = new KefClient({ host: '127.0.0.1', port: fake.port });
  await client.setVolume(12, { model: 'LS60', timeout: 500 });
  await client.setVolume(13, { model: undefined, timeout: 500 });
  await client.control('next', { model: 'LSXII', timeout: 500 });
  const [post, get, control] = fake.writes;
  assert.deepEqual([post.method, post.value], ['POST', { type: 'i32_', i32_: 12 }]);
  assert.deepEqual([get.method, get.value], ['GET', { type: 'i32_', i32_: 13 }]);
  assert.deepEqual(control.value, { control: 'next' });
  assert.equal(fake.state.volume, 13);
  assert.equal(await client.mac({ timeout: 500 }), 'aabbccddeeff');
  assert.deepEqual(await client.release({ timeout: 500 }), { model: 'LSXII', firmware: '4.2.1' });
});
