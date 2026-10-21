// -----------------------------------------------------------------------------
// What the integration keeps across restarts, in /data (the one writable
// volume, file mode 0600): the known speakers by MAC address, their address,
// name and model (so Standby works right after a restart, before the first
// read), the volume a mute replaced, and the time of the last read of each
// address (so a restart never reads a speaker sooner than the interval). No
// secret: the KEF API has none.
//
// The tables come from the network and from a file: they have no prototype,
// and a key that is not a plain identifier is never used.
// -----------------------------------------------------------------------------

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LIMITS } from './constants.js';
import { cleanText } from './kef/parse.js';

export const emptyData = () => ({
  devices: Object.create(null),
  attempts: Object.create(null),
});

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const MAC = /^[0-9a-f]{12}$/;
const ADDRESS_KEY = /^[a-z0-9.-]{1,253}(?::\d{1,5})?$/;

function sanitize(data) {
  const base = emptyData();
  if (!isObject(data)) {
    return base;
  }
  if (isObject(data.devices)) {
    for (const [id, device] of Object.entries(data.devices).slice(0, LIMITS.devices)) {
      if (!MAC.test(id) || !isObject(device) || device.id !== id) {
        continue;
      }
      base.devices[id] = {
        id,
        host: typeof device.host === 'string' ? device.host.slice(0, 253) : '',
        port:
          Number.isInteger(device.port) && device.port > 0 && device.port < 65536
            ? device.port
            : 80,
        name: cleanText(device.name, LIMITS.name),
        model: /^[A-Z0-9]{2,20}$/.test(device.model ?? '') ? device.model : undefined,
        writeMethod: ['POST', 'GET'].includes(device.writeMethod) ? device.writeMethod : undefined,
        mutedVolume:
          Number.isInteger(device.mutedVolume) &&
          device.mutedVolume >= 1 &&
          device.mutedVolume <= 100
            ? device.mutedVolume
            : undefined,
      };
    }
  }
  if (isObject(data.attempts)) {
    for (const [key, at] of Object.entries(data.attempts).slice(0, LIMITS.addresses * 3)) {
      if (ADDRESS_KEY.test(key) && Number.isFinite(at) && at > 0) {
        base.attempts[key] = at;
      }
    }
  }
  return base;
}

export class FileStore {
  constructor({ dir = process.env.DATA_DIR || '/data', name = 'kef.json' } = {}) {
    this.dir = dir;
    this.path = join(dir, name);
    this.corrupted = false;
  }

  /**
   * The saved data. An unreadable file is moved aside to `kef.json.bad` and
   * `corrupted` is set, so the app says so instead of silently starting over.
   */
  async load() {
    let text;
    try {
      text = await readFile(this.path, 'utf8');
    } catch {
      return emptyData();
    }
    try {
      return sanitize(JSON.parse(text));
    } catch {
      this.corrupted = true;
      const bad = `${this.path}.bad`;
      await rename(this.path, bad).catch(() => {});
      await chmod(bad, 0o600).catch(() => {});
      return emptyData();
    }
  }

  async save(data) {
    await mkdir(this.dir, { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

/** For the tests. */
export class MemoryStore {
  constructor(data = emptyData()) {
    this.data = JSON.parse(JSON.stringify(data));
    this.saves = 0;
    this.corrupted = false;
  }

  async load() {
    return sanitize(JSON.parse(JSON.stringify(this.data)));
  }

  async save(data) {
    // Through JSON, as the file store: what a restart would read back.
    this.data = JSON.parse(JSON.stringify(data));
    this.saves += 1;
  }
}

export { sanitize as sanitizeData };
