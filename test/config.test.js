import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseAddress } from '../src/config.js';

test('addresses: IPv4 or host name, optional port, junk refused', () => {
  assert.deepEqual(parseAddress('192.168.1.50'), { host: '192.168.1.50', port: 80 });
  assert.deepEqual(parseAddress(' http://192.168.1.50:8080/api '), {
    host: '192.168.1.50',
    port: 8080,
  });
  assert.deepEqual(parseAddress('LSX-Kitchen.local'), { host: 'lsx-kitchen.local', port: 80 });
  for (const bad of ['', '999.1.1.1', '1.2.3', 'a b', 'host:0', 'host:70000', '-bad.local']) {
    assert.equal(parseAddress(bad), undefined, bad);
  }
});

test('the configuration is normalized: duplicates, invalid entries, bounds', () => {
  const config = normalizeConfig({
    addresses: '192.168.1.50, 192.168.1.50;bad_host!, 192.168.1.51:80',
    max_volume: '250',
    poll_interval: 1,
  });
  assert.deepEqual(
    config.addresses.map((a) => a.host),
    ['192.168.1.50', '192.168.1.51'],
  );
  assert.deepEqual(config.invalid, ['bad_host!']);
  assert.equal(config.maxVolume, 100);
  assert.equal(config.pollInterval, 5_000);
  const defaults = normalizeConfig({ max_volume: '', poll_interval: true });
  assert.equal(defaults.maxVolume, 40);
  assert.equal(defaults.pollInterval, 10_000);
  assert.equal(normalizeConfig({ max_volume: 0 }).maxVolume, 1);
});
