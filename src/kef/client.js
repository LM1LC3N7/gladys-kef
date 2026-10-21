// -----------------------------------------------------------------------------
// One speaker address: the reads (`/api/getData`) and writes (`/api/setData`)
// of the KEF API, as pykefcontrol 0.9.3 makes them. A write is a POST of JSON
// for the models pykefcontrol lists (LS50 Wireless II, LSX II, LSX II LT,
// LS60), a GET with the value in the query string for the others.
// Every call takes { timeout, signal } and throws a KefError.
// -----------------------------------------------------------------------------

import { PATHS, POST_MODELS } from '../constants.js';
import { KefError, httpRequest } from './http.js';
import {
  parseItem,
  parseMac,
  parseMute,
  parseName,
  parsePlayer,
  parseRelease,
  parseSource,
  parseStatus,
  parseVolume,
} from './parse.js';

const query = (params) =>
  Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

export class KefClient {
  constructor({ host, port = 80, request = httpRequest }) {
    this.host = host;
    this.port = port;
    this.request = request;
  }

  /** The first item of the answer to a read of `path`; a KefError 'bad_answer' when unreadable. */
  async get(path, { timeout, signal } = {}) {
    const { text } = await this.request({
      host: this.host,
      port: this.port,
      path: `/api/getData?${query({ path, roles: 'value' })}`,
      timeout,
      signal,
    });
    const item = parseItem(text);
    if (!item) {
      throw new KefError('bad_answer', `unreadable answer for ${path}`, { maybeSent: true });
    }
    return item;
  }

  /** A read whose value goes through `parse`; undefined value = a KefError 'bad_answer'. */
  async read(path, parse, options) {
    const value = parse(await this.get(path, options));
    if (value === undefined) {
      throw new KefError('bad_answer', `unexpected value for ${path}`, { maybeSent: true });
    }
    return value;
  }

  mac(options) {
    return this.read(PATHS.MAC, parseMac, options);
  }

  async name(options) {
    return parseName(await this.get(PATHS.NAME, options));
  }

  async release(options) {
    return parseRelease(await this.get(PATHS.RELEASE, options));
  }

  /** true on, false in standby. */
  status(options) {
    return this.read(PATHS.STATUS, parseStatus, options);
  }

  source(options) {
    return this.read(PATHS.SOURCE, parseSource, options);
  }

  volume(options) {
    return this.read(PATHS.VOLUME, parseVolume, options);
  }

  mute(options) {
    return this.read(PATHS.MUTE, parseMute, options);
  }

  player(options) {
    return this.read(PATHS.PLAYER, parsePlayer, options);
  }

  /**
   * One write. `model` decides POST or GET, as pykefcontrol does; the answer
   * body is not used (it carries no state: a write is confirmed by a read).
   */
  async set(path, value, { model, method, roles = 'value', timeout, signal } = {}) {
    const payload = { path, roles, value };
    // `method` forces POST or GET (a model not read yet); otherwise the model decides.
    if (method === 'POST' || (method === undefined && POST_MODELS.includes(model))) {
      await this.request({
        host: this.host,
        port: this.port,
        path: '/api/setData',
        body: JSON.stringify(payload),
        timeout,
        signal,
      });
      return;
    }
    await this.request({
      host: this.host,
      port: this.port,
      path: `/api/setData?${query({ path, roles, value: JSON.stringify(value) })}`,
      timeout,
      signal,
    });
  }

  setSource(source, options) {
    return this.set(
      PATHS.SOURCE,
      { type: 'kefPhysicalSource', kefPhysicalSource: source },
      options,
    );
  }

  powerOn(options) {
    return this.setSource('powerOn', options);
  }

  standby(options) {
    return this.setSource('standby', options);
  }

  setVolume(volume, options) {
    return this.set(PATHS.VOLUME, { type: 'i32_', i32_: volume }, options);
  }

  /** "pause" toggles play / pause, "next", "previous" (pykefcontrol `_track_control`). */
  control(command, options) {
    return this.set(PATHS.CONTROL, { control: command }, { ...options, roles: 'activate' });
  }
}
