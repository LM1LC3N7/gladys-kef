// -----------------------------------------------------------------------------
// The integration: the KEF speakers it knows (typed addresses, the speakers
// already found, kept in /data by MAC address), one read loop per address
// (the API is plain HTTP, polled at the configured interval, never sooner),
// the Gladys devices built from them, the commands (validated before
// anything is sent, the identity of the speaker read again first, the
// volume capped by the configuration, confirmed only by a value read back,
// each within the 5 s Gladys waits for its ack) and the configuration
// buttons. index.js only wires the SDK handlers to it (src/handlers.js).
//
// Standby and Pause quiet a speaker down: they never wait in the command
// queue, never wait behind a read, and cancel the commands still waiting
// that would wake it or make it play.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, normalizeConfig } from './config.js';
import {
  DEFAULT_PORT,
  DEVICE_TYPE,
  FEATURES,
  LIMITS,
  TIMINGS,
  UNMUTE_DEFAULT,
} from './constants.js';
import { T } from './i18n.js';
import { KefClient } from './kef/client.js';
import { httpRequest } from './kef/http.js';
import { buildDevice, deviceName, featureKey, isSource, stateList } from './model.js';
import { StatePublisher } from './publisher.js';
import { FileStore, emptyData } from './store.js';

const BUTTONS = new Set([
  FEATURES.POWER_ON,
  FEATURES.STANDBY,
  FEATURES.MUTE,
  FEATURES.PLAY,
  FEATURES.PAUSE,
  FEATURES.NEXT,
  FEATURES.PREVIOUS,
]);

/** Commands that can take a speaker out of standby: a Standby asked after them wins. */
const WAKES = new Set([
  FEATURES.POWER_ON,
  FEATURES.SOURCE,
  FEATURES.PLAY,
  FEATURES.NEXT,
  FEATURES.PREVIOUS,
]);

/** Commands that make a speaker play: a Pause asked after them wins. */
const PLAYS = new Set([FEATURES.PLAY, FEATURES.NEXT, FEATURES.PREVIOUS]);

/** Commands that never wait in the queue. */
const PROTECTIVE = new Set([FEATURES.STANDBY, FEATURES.PAUSE]);

/**
 * The volume of a command, validated strictly: an integer 0..100 given as a
 * number or as a string of digits. null, '', true, 12.5, '12abc' are refused.
 * @returns {number | undefined}
 */
export function parseVolumeCommand(value) {
  let volume;
  if (typeof value === 'number') {
    volume = value;
  } else if (typeof value === 'string' && /^\s*\d{1,3}\s*$/.test(value)) {
    volume = Number(value);
  } else {
    return undefined;
  }
  return Number.isInteger(volume) && volume >= 0 && volume <= 100 ? volume : undefined;
}

/** A command error that tells exactly what happened to the request. */
export class CommandError extends Error {
  constructor(message, { sent = false } = {}) {
    super(message);
    this.name = 'CommandError';
    this.sent = sent;
  }
}

const short = (value) => String(value).slice(0, 32);
const unconfirmed = (device, what = 'Sent') =>
  new CommandError(`${deviceName(device)}: ${what}, without confirmation from the speaker`, {
    sent: true,
  });

export class KefApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'kef' }),
    store = new FileStore(),
    now = Date.now,
    timers = globalThis,
    timings = TIMINGS,
    request = httpRequest,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.now = now;
    this.timers = timers;
    this.timings = timings;
    this.request = request;
    this.config = normalizeConfig();
    this.data = undefined;
    this.publisher = new StatePublisher({ gladys, logger, now });
    /** addressKey -> link (see newLink) */
    this.links = new Map();
    /** device id -> { running, items } */
    this.queues = new Map();
    /** ids of the speakers created in Gladys */
    this.created = new Set();
    this.createdStale = false;
    /** device id -> timer of the grouped publication of its states */
    this.publishTimers = new Map();
    /** device id -> the wake-up chain (cap checks) */
    this.wakeChains = new Map();
    /** device id -> the standby guard chain (after a Standby not confirmed) */
    this.guards = new Map();
    /** device id -> until when a Power on sent may still be waking the speaker */
    this.awaitingWake = new Map();
    /** device id -> number of Standby / Pause asked (an older waking / playing command is not sent) */
    this.standbySeq = new Map();
    this.pauseSeq = new Map();
    this.generation = 0;
    this.tickTimer = undefined;
    this.persistTimer = undefined;
    this.lastAttemptSave = -Infinity;
    this.lastStatus = undefined;
    this.warned = new Set();
    this.started = false;
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * (Re)start with a configuration: on every connection to Gladys and on
   * every configuration save. The read loops are kept: neither a
   * reconnection to Gladys nor a configuration saved again ever makes a
   * speaker read sooner than its interval. What was "already published" is
   * forgotten on a reconnection (the core forgot it too): the status, the
   * Discovery list and the states are published again.
   */
  async start(raw = {}, { connected = false } = {}) {
    this.config = normalizeConfig(raw);
    this.started = true;
    this.timers.clearInterval(this.tickTimer);
    this.tickTimer = this.timers.setInterval(() => this.tick(), this.timings.tick);
    if (connected) {
      this.lastStatus = undefined;
      this.publisher.forget();
    }
    if (!this.data) {
      try {
        this.data = await this.store.load();
      } catch {
        this.data = emptyData();
      }
      if (this.store.corrupted) {
        this.logger.warn('Unreadable /data/kef.json moved to kef.json.bad');
      }
    }
    await this.step('read the Gladys devices', () => this.refreshCreated());
    await this.step('open the read loops', () => this.syncLinks());
    await this.step('publish the devices', () => this.publishDevices());
    await this.step('publish the states', () => this.publishAllStates());
    await this.step('publish the status', () => this.updateStatus());
  }

  async step(name, task) {
    try {
      await task();
    } catch (err) {
      this.logger.warn(`Start: could not ${name}: ${err.message}`);
    }
  }

  stop() {
    this.started = false;
    this.generation += 1;
    this.timers.clearInterval(this.tickTimer);
    this.tickTimer = undefined;
    for (const link of this.links.values()) {
      this.timers.clearTimeout(link.timer);
    }
    this.links.clear();
    for (const handle of this.publishTimers.values()) {
      this.timers.clearTimeout(handle);
    }
    this.publishTimers.clear();
    for (const map of [this.wakeChains, this.guards]) {
      for (const chain of map.values()) {
        this.timers.clearTimeout(chain.timer);
      }
      map.clear();
    }
    this.timers.clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    return this.data ? this.store.save(this.data).catch(() => {}) : Promise.resolve();
  }

  tick() {
    if (!this.data) {
      return Promise.resolve();
    }
    return Promise.resolve()
      .then(() => (this.createdStale ? this.refreshCreated() : undefined))
      .then(() => this.updateStatus())
      .catch((err) => this.logger.warn(`Background round failed: ${err.message}`));
  }

  persist() {
    if (this.persistTimer || !this.data) {
      return;
    }
    this.persistTimer = this.timers.setTimeout(() => {
      this.persistTimer = undefined;
      this.store
        .save(this.data)
        .catch((err) => this.logger.warn(`Could not save /data: ${err.message}`));
    }, this.timings.persistDelay);
  }

  /** The time of a read of `key`: kept in /data, written at most once a minute for this alone. */
  markAttempt(key) {
    if (!this.data) {
      return;
    }
    this.data.attempts[key] = this.now();
    if (this.now() - this.lastAttemptSave >= this.timings.attemptPersistEvery) {
      this.lastAttemptSave = this.now();
      this.persist();
    }
  }

  warnOnce(key, message) {
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.logger.warn(message);
    }
  }

  // --- Known speakers ------------------------------------------------------------

  get devices() {
    return Object.values(this.data?.devices ?? {});
  }

  deviceOf(gladysDevice) {
    return this.devices.find(
      (d) => this.gladys.externalIds(DEVICE_TYPE, d.id).device === gladysDevice?.external_id,
    );
  }

  linkOf(device) {
    return device.host ? this.links.get(addressKey(device)) : undefined;
  }

  clientOf(device) {
    return new KefClient({ host: device.host, port: device.port, request: this.request });
  }

  /**
   * What is known of a speaker: its last read, null when it does not answer
   * (or its address is unknown), undefined when nothing is known yet.
   */
  deviceState(device) {
    if (!device.host) {
      return null;
    }
    const link = this.linkOf(device);
    return link && link.deviceId === device.id ? link.state : undefined;
  }

  /** One read loop per typed address and per known speaker address. */
  syncLinks() {
    if (!this.started || !this.data) {
      return;
    }
    const wanted = new Map();
    for (const address of this.config.addresses) {
      wanted.set(addressKey(address), address);
    }
    for (const device of this.devices) {
      if (device.host) {
        wanted.set(addressKey(device), { host: device.host, port: device.port ?? DEFAULT_PORT });
      }
    }
    for (const [key, link] of this.links) {
      if (!wanted.has(key)) {
        this.timers.clearTimeout(link.timer);
        this.links.delete(key);
      }
    }
    for (const [key, address] of wanted) {
      const existing = this.links.get(key);
      if (existing) {
        // The interval may have changed: the next read follows it, never sooner.
        if (!existing.reading) {
          this.scheduleRead(existing);
        }
        continue;
      }
      const saved = this.data.attempts[key];
      const link = {
        key,
        host: address.host,
        port: address.port,
        timer: undefined,
        reading: undefined,
        lastAttempt: -Infinity,
        failures: 0,
        deviceId: this.devices.find((d) => addressKey(d) === key)?.id,
        state: undefined,
        lastError: undefined,
        readAt: undefined,
      };
      // After a restart: a read made shortly before it may not be in /data
      // yet (written at most once a minute), so a recent one waits a whole
      // interval. Never a burst of reads from a container restarting.
      if (
        Number.isFinite(saved) &&
        this.now() - saved < this.timings.attemptPersistEvery + this.config.pollInterval
      ) {
        link.lastAttempt = this.now();
      }
      this.links.set(key, link);
      this.scheduleRead(link);
    }
  }

  /** The wait between two reads of an address: the interval, longer for a silent one. */
  readDelay(link) {
    const extra = link.failures - this.timings.offlineAfter;
    if (extra < 0) {
      return this.config.pollInterval;
    }
    return Math.min(
      Math.max(this.timings.backoffMax, this.config.pollInterval),
      this.config.pollInterval * 2 ** (extra + 1),
    );
  }

  /** The next read of `link`, at its due time (never sooner than its delay after the last one). */
  scheduleRead(link) {
    this.timers.clearTimeout(link.timer);
    if (!this.started || this.links.get(link.key) !== link) {
      return;
    }
    const delay = Math.max(0, link.lastAttempt + this.readDelay(link) - this.now());
    link.timer = this.timers.setTimeout(() => {
      link.timer = undefined;
      this.read(link);
    }, delay);
  }

  /** Whether a read of `link` is due now. */
  isDue(link) {
    return !link.reading && this.now() - link.lastAttempt >= this.readDelay(link);
  }

  /** One read at a time per address: asked again while reading, it joins the running one. */
  read(link) {
    if (!link.reading) {
      link.reading = this.readLink(link)
        .catch((err) => this.logger.warn(`Read of ${link.key} failed: ${err.message}`))
        .finally(() => {
          link.reading = undefined;
          this.scheduleRead(link);
        });
    }
    return link.reading;
  }

  /**
   * Reads one address: the MAC address first (the identity, every time: an
   * address may now be another speaker's), then the state. Only the MAC
   * address and the power are needed; the other values may fail alone (an
   * unreadable source or title never stops the rest). A late answer of a
   * loop removed or stopped meanwhile publishes nothing.
   */
  async readLink(link) {
    const generation = this.generation;
    const alive = () => generation === this.generation && this.links.get(link.key) === link;
    link.lastAttempt = this.now();
    this.markAttempt(link.key);
    const client = new KefClient({ host: link.host, port: link.port, request: this.request });
    const options = { timeout: this.timings.requestTimeout };
    const soft = (promise) => promise.catch(() => undefined);
    try {
      const mac = await client.mac(options);
      if (!alive()) return;
      const known = this.data.devices[mac];
      let info;
      if (!known || !known.model || !known.name) {
        const name = await soft(client.name(options));
        const release = (await soft(client.release(options))) ?? {};
        info = { name, model: release.model };
        if (!alive()) return;
      }
      const on = await client.status(options);
      if (!alive()) return;
      const source = await soft(client.source(options));
      const volume = await soft(client.volume(options));
      const mute = await soft(client.mute(options));
      const player = on ? await soft(client.player(options)) : undefined;
      if (!alive()) return;
      const device = this.remember(mac, info, link);
      if (!device) {
        return;
      }
      const wasLost = link.state === null || link.deviceId !== mac;
      link.failures = 0;
      link.lastError = undefined;
      link.deviceId = mac;
      link.readAt = this.now();
      link.state = { on, source, volume, mute, player };
      if (on) {
        this.awaitingWake.delete(mac);
      }
      this.schedulePublish(mac, wasLost ? 0 : undefined);
      if (wasLost) {
        this.logger.info(`${deviceName(device)} answers at ${link.key}`);
        this.updateStatus().catch(() => {});
      }
    } catch (err) {
      if (!alive()) return;
      link.failures += 1;
      link.lastError = err.message;
      // An unreadable identity is not "another speaker": the address is kept.
      if (link.failures >= this.timings.offlineAfter && link.state !== null) {
        this.logger.info(
          `${link.key} does not answer (${err.message}); read again at spaced intervals`,
        );
        link.state = null;
        if (link.deviceId) {
          this.schedulePublish(link.deviceId, 0);
        }
        this.updateStatus().catch(() => {});
      }
    }
  }

  /**
   * Remembers the speaker answering at the address of `link` by its MAC
   * address. Another speaker that had this address lost it (DHCP): it is
   * never commanded at an address that is no longer its own.
   */
  remember(mac, info, link) {
    const table = this.data.devices;
    let device = Object.hasOwn(table, mac) ? table[mac] : undefined;
    let changed = false;
    if (!device) {
      if (Object.keys(table).length >= LIMITS.devices) {
        this.warnOnce('devices', `More than ${LIMITS.devices} speakers: the next ones are ignored`);
        return undefined;
      }
      device = { id: mac, host: '', port: DEFAULT_PORT };
      table[mac] = device;
      changed = true;
    }
    for (const other of this.devices) {
      if (other.id !== mac && other.host === link.host && other.port === link.port) {
        this.loseAddress(other);
      }
    }
    if (device.host !== link.host || device.port !== link.port) {
      device.host = link.host;
      device.port = link.port;
      changed = true;
    }
    if (info?.name && info.name !== device.name) {
      device.name = info.name;
      changed = true;
    }
    if (info?.model && info.model !== device.model) {
      device.model = info.model;
      changed = true;
    }
    if (changed) {
      this.persist();
      this.publishDevices().catch((err) =>
        this.logger.warn(`Could not publish the devices: ${err.message}`),
      );
    }
    return device;
  }

  /** Another speaker answers at the address of `device`: the address is forgotten. */
  loseAddress(device) {
    if (!device.host) {
      return;
    }
    this.logger.warn(`${deviceName(device)} no longer answers at ${addressKey(device)}`);
    device.host = '';
    this.persist();
    this.schedulePublish(device.id, 0);
    this.publishDevices().catch(() => {});
    this.updateStatus().catch(() => {});
  }

  async publishDevices() {
    if (!this.data) {
      return;
    }
    await this.gladys.publishDiscoveredDevices(
      this.devices.map((d) => buildDevice(this.gladys, d)),
    );
  }

  /** The speakers created in Gladys (the last list the SDK keeps when the call fails). */
  async refreshCreated() {
    let list;
    try {
      list = await this.gladys.getDevices();
      this.createdStale = false;
    } catch (err) {
      this.createdStale = true;
      if (!Array.isArray(this.gladys.devices)) {
        throw err;
      }
      this.logger.warn(`Could not read the Gladys devices (${err.message}): using the last list`);
      list = this.gladys.devices;
    }
    const byExternalId = new Map(
      this.devices.map((d) => [this.gladys.externalIds(DEVICE_TYPE, d.id).device, d.id]),
    );
    this.created = new Set(
      (Array.isArray(list) ? list : [])
        .map((d) => byExternalId.get(d?.external_id))
        .filter(Boolean),
    );
  }

  // --- States --------------------------------------------------------------------

  /** The states of a speaker, grouped: at most one publication per `publishDelay`. */
  schedulePublish(id, delay = this.timings.publishDelay) {
    if (this.publishTimers.has(id)) {
      if (delay > 0) {
        return;
      }
      this.timers.clearTimeout(this.publishTimers.get(id));
    }
    const generation = this.generation;
    const handle = this.timers.setTimeout(() => {
      this.publishTimers.delete(id);
      const device = this.data?.devices?.[id];
      if (generation === this.generation && device) {
        this.publishStates(device).catch(() => {});
      }
    }, delay);
    this.publishTimers.set(id, handle);
  }

  async publishStates(device) {
    if (!this.created.has(device.id)) {
      return;
    }
    await this.publisher.publish(stateList(this.gladys, device, this.deviceState(device)));
  }

  async publishAllStates() {
    // One publication for all of them: the budget sees the whole picture.
    const states = this.devices
      .filter((d) => this.created.has(d.id))
      .flatMap((d) => stateList(this.gladys, d, this.deviceState(d)));
    await this.publisher.publish(states);
  }

  /** A value read back by a command: kept as the last read, published (never awaited). */
  noteState(device, values) {
    const link = this.linkOf(device);
    if (link && link.deviceId === device.id && link.state) {
      Object.assign(link.state, values);
      if (values.on === true) {
        this.awaitingWake.delete(device.id);
      }
      this.schedulePublish(device.id, 0);
    }
  }

  // --- Command queue -----------------------------------------------------------------

  /**
   * The command queue of one speaker: one command at a time. Mute goes
   * before the commands still waiting, never before the one running.
   * Standby and Pause are never queued.
   */
  enqueue(id, task, { urgent = false, key } = {}) {
    let queue = this.queues.get(id);
    if (!queue) {
      queue = { running: false, items: [] };
      this.queues.set(id, queue);
    }
    if (queue.items.length >= LIMITS.queue) {
      return Promise.reject(new CommandError('Too many commands waiting, nothing sent'));
    }
    return new Promise((resolve, reject) => {
      const item = { task, resolve, reject, urgent, key };
      if (urgent) {
        const index = queue.items.findIndex((i) => !i.urgent);
        queue.items.splice(index === -1 ? queue.items.length : index, 0, item);
      } else {
        queue.items.push(item);
      }
      this.drain(queue);
    });
  }

  async drain(queue) {
    if (queue.running) {
      return;
    }
    queue.running = true;
    while (queue.items.length > 0) {
      const item = queue.items.shift();
      try {
        item.resolve(await item.task());
      } catch (err) {
        item.reject(err);
      }
    }
    queue.running = false;
  }

  /** The commands of `keys` still waiting for a speaker: answered `err`, never run. */
  dropQueued(id, keys, err) {
    const queue = this.queues.get(id);
    if (!queue) {
      return;
    }
    const dropped = queue.items.filter((item) => keys.has(item.key));
    queue.items = queue.items.filter((item) => !keys.has(item.key));
    dropped.forEach((item) => item.reject(err));
  }

  // --- Commands --------------------------------------------------------------------

  validate(key, value) {
    if (key === FEATURES.VOLUME) {
      const volume = parseVolumeCommand(value);
      if (volume === undefined) {
        throw new CommandError(`Invalid volume "${short(value)}": an integer from 0 to 100`);
      }
      return volume;
    }
    if (key === FEATURES.SOURCE) {
      if (!isSource(value)) {
        throw new CommandError(`Unknown source "${short(value)}"`);
      }
      return value;
    }
    if (BUTTONS.has(key)) {
      return undefined;
    }
    throw new CommandError(`Feature "${short(key)}" cannot be commanded`);
  }

  remaining(started) {
    return this.timings.commandBudget - (this.now() - started);
  }

  /**
   * A command from Gladys. Validated before anything is sent; Standby and
   * Pause run at once (outside the queue), the others in the queue of the
   * speaker; refused, never sent late, when it could not start within the
   * budget. The ack never waits for a publication to Gladys.
   */
  async setValue(gladysDevice, feature, value) {
    const device = this.deviceOf(gladysDevice);
    if (!device) {
      throw new CommandError(`Unknown speaker ${short(gladysDevice?.external_id)}`);
    }
    const key = featureKey(gladysDevice.external_id, feature?.external_id);
    const checked = this.validate(key, value);
    const started = this.now();
    const id = device.id;
    const standbySeq = this.standbySeq.get(id) ?? 0;
    const pauseSeq = this.pauseSeq.get(id) ?? 0;
    const context = {
      // Set just before a write leaves: from then on it may have reached the
      // speaker, whatever happens next.
      mayHaveSent: false,
      late: false,
      // A Standby (or a Pause) asked after this command arrived wins: a
      // command that would wake the speaker (or make it play) is then not
      // sent; checked when its turn comes and again right before each write.
      shouldSend: () =>
        !context.late &&
        (!WAKES.has(key) || (this.standbySeq.get(id) ?? 0) === standbySeq) &&
        (!PLAYS.has(key) || (this.pauseSeq.get(id) ?? 0) === pauseSeq),
      /** Why `shouldSend` said no. */
      refusal: () =>
        context.late
          ? new CommandError(`${deviceName(device)}: no time left for this command, nothing sent`)
          : this.cancelled(
              device,
              WAKES.has(key) && (this.standbySeq.get(id) ?? 0) !== standbySeq ? 'Standby' : 'Pause',
            ),
    };
    let run;
    if (PROTECTIVE.has(key)) {
      if (key === FEATURES.STANDBY) {
        this.standbySeq.set(id, standbySeq + 1);
        this.dropQueued(id, WAKES, this.cancelled(device, 'Standby'));
      } else {
        this.pauseSeq.set(id, pauseSeq + 1);
        this.dropQueued(id, PLAYS, this.cancelled(device, 'Pause'));
      }
      run = this.command(device, key, checked, started, context);
    } else {
      run = this.enqueue(
        id,
        () => {
          if (!context.shouldSend()) {
            throw context.refusal();
          }
          if (this.remaining(started) < this.timings.minRequest) {
            // Gladys stopped waiting while this command was queued: dropped, never sent late.
            context.late = true;
            throw new CommandError(
              `${deviceName(device)}: no time left for this command, nothing sent`,
            );
          }
          return this.command(device, key, checked, started, context);
        },
        { urgent: key === FEATURES.MUTE, key },
      );
    }
    // Wall-clock deadline (not the injectable timers): the ack Gladys waits for.
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(
        () => {
          context.late = true;
          reject(
            context.mayHaveSent
              ? unconfirmed(device)
              : new CommandError(
                  `${deviceName(device)}: no time left for this command (speaker busy), nothing sent`,
                ),
          );
        },
        Math.max(0, this.remaining(started)) + 100,
      );
    });
    run.catch(() => {});
    try {
      return await Promise.race([run, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  cancelled(device, by) {
    return new CommandError(`${deviceName(device)}: cancelled by ${by}, nothing sent`);
  }

  /** A read before a write: whatever goes wrong, nothing was sent. */
  async readBefore(device, started, what, job) {
    const budget = Math.min(
      this.timings.preRead,
      this.remaining(started) - this.timings.minRequest,
    );
    if (budget < this.timings.minRequest) {
      throw new CommandError(`${deviceName(device)}: no time left for this command, nothing sent`);
    }
    try {
      return await job({ timeout: budget });
    } catch (err) {
      throw new CommandError(
        `${deviceName(device)}: ${what} not read (${err.message}), nothing sent`,
      );
    }
  }

  /**
   * The identity of the speaker at the address, read again before every
   * command: another speaker there (DHCP) is never commanded, and the
   * address is forgotten; an unreadable answer only refuses the command
   * (it does not mean another speaker).
   */
  async verify(device, client, started) {
    if (!device.host) {
      throw new CommandError(
        `${deviceName(device)}: address unknown, type its new address in the configuration`,
      );
    }
    const mac = await this.readBefore(device, started, 'identity', (o) => client.mac(o));
    if (mac !== device.id) {
      this.loseAddress(device);
      throw new CommandError(
        `${deviceName(device)}: another speaker answers at its address, nothing sent`,
      );
    }
    if (!device.model) {
      const release = await this.readBefore(device, started, 'model', (o) => client.release(o));
      if (release.model) {
        device.model = release.model;
        this.persist();
      }
    }
  }

  /**
   * One write. The deadline is checked just before it leaves (after a slow
   * read too); a write that may have reached the speaker is never reported
   * as "not sent".
   */
  async write(device, started, context, job) {
    if (!context.shouldSend()) {
      throw context.refusal();
    }
    const left = this.remaining(started);
    if (left < this.timings.minRequest) {
      throw new CommandError(`${deviceName(device)}: no time left for this command, nothing sent`);
    }
    context.mayHaveSent = true;
    try {
      await job({ timeout: Math.min(this.timings.requestTimeout, left), model: device.model });
    } catch (err) {
      if (err.maybeSent) {
        throw unconfirmed(device);
      }
      context.mayHaveSent = false;
      throw new CommandError(`${deviceName(device)}: not sent (${err.message})`);
    }
  }

  /**
   * Whether `read` gives back a value for which `check` holds, within
   * `budget()`: read again every `confirmEvery`. An answer to a write alone
   * never confirms anything: a speaker may accept a write and ignore it.
   */
  async confirm(read, check, budget) {
    for (;;) {
      const left = budget();
      if (left < this.timings.minRequest) {
        return false;
      }
      const value = await read({ timeout: Math.min(this.timings.requestTimeout, left) }).catch(
        () => undefined,
      );
      if (value !== undefined && check(value)) {
        return true;
      }
      const wait = Math.min(this.timings.confirmEvery, budget() - this.timings.minRequest);
      if (wait <= 0) {
        return false;
      }
      await new Promise((resolve) => this.timers.setTimeout(resolve, wait));
    }
  }

  async command(device, key, value, started, context) {
    const client = this.clientOf(device);
    const budget = () => this.remaining(started) - 100;
    const write = (job) => this.write(device, started, context, job);
    await this.verify(device, client, started);
    switch (key) {
      case FEATURES.POWER_ON:
        return this.powerOn(device, client, started, context, budget);
      case FEATURES.STANDBY: {
        await write((o) => client.standby(o));
        const off = await this.confirm(
          (o) => client.status(o),
          (on) => on === false,
          budget,
        );
        // A speaker still waking up from a Power on says "standby" too: not a confirmation.
        if (!off || this.wakingUp(device.id)) {
          this.guardStandby(device);
          throw unconfirmed(device);
        }
        this.noteState(device, { on: false });
        return undefined;
      }
      case FEATURES.VOLUME: {
        // The cap is read here, just before the write: a configuration saved
        // while the command waited applies.
        const cap = this.config.maxVolume;
        const target = Math.min(value, cap);
        if (target < value) {
          this.logger.info(`${deviceName(device)}: volume ${value} capped to ${cap}`);
        }
        await write((o) => client.setVolume(target, o));
        if (
          !(await this.confirm(
            (o) => client.volume(o),
            (v) => v === target,
            budget,
          ))
        ) {
          // Accepted and ignored, or above the cap: the checks bring it back.
          this.capChain(device);
          throw unconfirmed(device);
        }
        this.noteState(device, { volume: target });
        return undefined;
      }
      case FEATURES.MUTE:
        return this.mute(device, client, started, context, budget);
      case FEATURES.SOURCE: {
        const on = await this.readBefore(device, started, 'power state', (o) => client.status(o));
        // Choosing a source wakes a speaker in standby: the cap is checked after.
        const restore = on ? undefined : this.expectWake(device);
        try {
          await write((o) => client.setSource(value, o));
        } catch (err) {
          restore?.(err.sent);
          throw err;
        }
        if (!on) {
          this.afterWakeSent(device);
        }
        if (
          !(await this.confirm(
            (o) => client.source(o),
            (s) => s === value,
            budget,
          ))
        ) {
          throw unconfirmed(device);
        }
        this.noteState(device, { source: value, ...(on ? {} : { on: true }) });
        return undefined;
      }
      case FEATURES.PLAY:
      case FEATURES.PAUSE:
        return this.playPause(device, client, key, started, context, budget);
      case FEATURES.NEXT:
      case FEATURES.PREVIOUS: {
        const on = await this.readBefore(device, started, 'power state', (o) => client.status(o));
        if (!on) {
          throw new CommandError(
            `${deviceName(device)}: in standby, nothing sent (Power on first)`,
          );
        }
        await write((o) => client.control(key === FEATURES.NEXT ? 'next' : 'previous', o));
        return undefined;
      }
      default:
        throw new CommandError(`Feature "${short(key)}" cannot be commanded`);
    }
  }

  /**
   * Power on: confirmed by the power read back within the whole budget (a
   * slow wake-up is not an error); the volume is brought back to the cap
   * within what is left, then checked again in the background for the
   * wake-up window, whatever happens.
   */
  async powerOn(device, client, started, context, budget) {
    const restore = this.expectWake(device);
    try {
      await this.write(device, started, context, (o) => client.powerOn(o));
    } catch (err) {
      restore(err.sent);
      throw err;
    }
    this.afterWakeSent(device);
    const on = await this.confirm(
      (o) => client.status(o),
      (value) => value === true,
      budget,
    );
    if (!on) {
      throw unconfirmed(device);
    }
    this.noteState(device, { on: true });
    await this.capVolume(device, client, () => Math.min(this.timings.preRead, budget())).catch(
      () => false,
    );
    return undefined;
  }

  /**
   * Mute: the volume set to 0, the previous one kept (as pykefcontrol does).
   * Unmute: the previous volume, at most the cap read just before the write,
   * confirmed by the volume read back. A speaker muted by its own remote or
   * app (its mute flag) is left as it is: the integration does not know
   * how to unmute that safely.
   */
  async mute(device, client, started, context, budget) {
    const volume = await this.readBefore(device, started, 'volume', (o) => client.volume(o));
    // The mute flag only explains a refusal: unreadable, it is not needed.
    const flag = await this.readBefore(device, started, 'mute state', (o) => client.mute(o)).catch(
      () => undefined,
    );
    if (flag === true) {
      throw new CommandError(
        `${deviceName(device)}: muted on the speaker itself (remote or app), unmute it there; nothing sent`,
      );
    }
    if (volume > 0) {
      device.mutedVolume = volume;
      this.persist();
      await this.write(device, started, context, (o) => client.setVolume(0, o));
      if (
        !(await this.confirm(
          (o) => client.volume(o),
          (v) => v === 0,
          budget,
        ))
      ) {
        throw unconfirmed(device);
      }
      this.noteState(device, { volume: 0 });
      return undefined;
    }
    // Unmuting never makes the speaker play above the cap.
    const cap = this.config.maxVolume;
    const target = Math.min(device.mutedVolume ?? UNMUTE_DEFAULT, cap);
    await this.write(device, started, context, (o) => client.setVolume(target, o));
    if (
      !(await this.confirm(
        (o) => client.volume(o),
        (v) => v === target,
        budget,
      ))
    ) {
      this.capChain(device);
      throw unconfirmed(device);
    }
    this.noteState(device, { volume: target });
    return undefined;
  }

  /**
   * Play and Pause through the only control the API has, the toggle
   * ("pause"), sent only after the play state read again says it is needed
   * (a toggle on a stale state would do the opposite): Play from "paused",
   * Pause from "playing". Already as asked: nothing to send. Any other state:
   * refused, the toggle could do anything. Confirmed by the play state read
   * back.
   */
  async playPause(device, client, key, started, context, budget) {
    if (key === FEATURES.PLAY) {
      const on = await this.readBefore(device, started, 'power state', (o) => client.status(o));
      if (!on) {
        throw new CommandError(`${deviceName(device)}: in standby, nothing sent (Power on first)`);
      }
    }
    const player = await this.readBefore(device, started, 'play state', (o) => client.player(o));
    const wanted = key === FEATURES.PLAY ? 'playing' : 'paused';
    const from = key === FEATURES.PLAY ? 'paused' : 'playing';
    if (player.state === wanted || (key === FEATURES.PAUSE && player.state === 'stopped')) {
      return undefined;
    }
    if (player.state !== from) {
      throw new CommandError(
        `${deviceName(device)}: play state ${player.state ?? 'unknown'}, nothing sent`,
      );
    }
    await this.write(device, started, context, (o) => client.control('pause', o));
    if (
      !(await this.confirm(
        (o) => client.player(o),
        (p) => p.state === wanted,
        budget,
      ))
    ) {
      throw unconfirmed(device);
    }
    this.noteState(device, { player: { ...player, state: wanted } });
    return undefined;
  }

  // --- The cap after a wake-up, the standby guard ------------------------------------

  /**
   * Before a waking write: the speaker is "waking up" (a Standby read back
   * meanwhile is not a confirmation). Returns how to put it back when the
   * write did not leave.
   */
  expectWake(device) {
    const before = this.awaitingWake.get(device.id);
    this.awaitingWake.set(
      device.id,
      this.now() + this.timings.wakeChecks * this.timings.wakeCheckDelay,
    );
    return (sent) => {
      if (sent) {
        this.afterWakeSent(device);
      } else if (before === undefined) {
        this.awaitingWake.delete(device.id);
      } else {
        this.awaitingWake.set(device.id, before);
      }
    };
  }

  /** A waking write may have left: the guard of a Standby stops, the cap checks start over. */
  afterWakeSent(device) {
    this.stopChain(this.guards, device.id);
    this.capChain(device);
  }

  wakingUp(id) {
    const until = this.awaitingWake.get(id);
    if (until === undefined) {
      return false;
    }
    if (until < this.now()) {
      this.awaitingWake.delete(id);
      return false;
    }
    return true;
  }

  /**
   * Reads the identity, the power and the volume, and lowers the volume to
   * the cap when the speaker is on and above it. True when settled (at or
   * under the cap, read back), false otherwise (still waking up, or a
   * lowering ignored).
   */
  async capVolume(device, client, budget, alive = () => true) {
    const options = () => ({ timeout: Math.min(this.timings.requestTimeout, budget()) });
    if (budget() < this.timings.minRequest || !alive()) return false;
    if ((await client.mac(options())) !== device.id) return false;
    if (budget() < this.timings.minRequest || !alive()) return false;
    if ((await client.status(options())) !== true) return false;
    if (budget() < this.timings.minRequest || !alive()) return false;
    const volume = await client.volume(options());
    const cap = this.config.maxVolume;
    if (volume <= cap) {
      return true;
    }
    if (budget() < this.timings.minRequest || !alive()) return false;
    this.logger.info(`${deviceName(device)}: volume ${volume} above the cap, lowered to ${cap}`);
    await client.setVolume(cap, { ...options(), model: device.model });
    // Settled only on the volume read back, never on the answer alone.
    const done = await this.confirm(
      (o) => client.volume(o),
      (v) => v <= this.config.maxVolume,
      budget,
    );
    if (done) {
      this.noteState(device, { volume: Math.min(volume, cap) });
    }
    return done;
  }

  stopChain(map, id) {
    const chain = map.get(id);
    if (chain) {
      this.timers.clearTimeout(chain.timer);
      map.delete(id);
    }
  }

  /**
   * The cap checks after a wake-up (or a volume left above the cap): every
   * `wakeCheckDelay`, `wakeChecks` times, through the queue of the speaker,
   * each one lowering a volume found above the cap (a lowering ignored is
   * tried again at the next one). One chain per speaker: a new one replaces
   * the running one. A Standby does not stop it: it only lowers a speaker
   * that says it is on.
   */
  capChain(device) {
    const id = device.id;
    this.stopChain(this.wakeChains, id);
    const chain = { timer: undefined, attempt: 0 };
    this.wakeChains.set(id, chain);
    const current = () => this.wakeChains.get(id) === chain && this.started;
    const next = () => {
      if (!current()) return;
      chain.attempt += 1;
      if (chain.attempt > this.timings.wakeChecks) {
        this.wakeChains.delete(id);
        return;
      }
      chain.timer = this.timers.setTimeout(() => {
        if (!current()) return;
        this.enqueue(id, () => {
          const deadline = this.now() + 3 * this.timings.requestTimeout;
          return device.host && current()
            ? this.capVolume(device, this.clientOf(device), () => deadline - this.now(), current)
            : false;
        })
          .catch(() => false)
          .then(next);
      }, this.timings.wakeCheckDelay);
    };
    next();
  }

  /**
   * After a Standby not confirmed: for `guardChecks` × `guardDelay`, a
   * speaker read "on" is put in standby again (outside the queue, never
   * blocked). A write that fails keeps the guard going. A waking command of
   * Gladys that may have left ends it.
   */
  guardStandby(device) {
    const id = device.id;
    this.stopChain(this.guards, id);
    const chain = { timer: undefined, attempt: 0 };
    this.guards.set(id, chain);
    const current = () => this.guards.get(id) === chain && this.started;
    const next = () => {
      if (!current()) return;
      chain.attempt += 1;
      if (chain.attempt > this.timings.guardChecks) {
        this.guards.delete(id);
        return;
      }
      chain.timer = this.timers.setTimeout(async () => {
        if (!current() || !device.host) return next();
        const client = this.clientOf(device);
        const options = { timeout: this.timings.requestTimeout };
        try {
          if ((await client.mac(options)) === device.id && current()) {
            if ((await client.status(options)) === true && current()) {
              this.logger.info(
                `${deviceName(device)}: still on after Standby, standby asked again`,
              );
              await client.standby({ ...options, model: device.model });
            }
          }
        } catch (err) {
          this.logger.debug?.(`${deviceName(device)}: standby guard: ${err.message}`);
        }
        next();
      }, this.timings.guardDelay);
    };
    next();
  }

  // --- Device lifecycle --------------------------------------------------------------

  async deviceCreated(gladysDevice) {
    const device = this.deviceOf(gladysDevice);
    if (!device) {
      return;
    }
    this.created.add(device.id);
    // Gladys forgot what was published for this device: everything again.
    this.publisher.forget(this.gladys.externalIds(DEVICE_TYPE, device.id).device);
    await this.publishStates(device);
    await this.updateStatus();
  }

  async deviceDeleted(gladysDevice) {
    const device = this.deviceOf(gladysDevice);
    if (device) {
      this.created.delete(device.id);
      await this.updateStatus();
    }
  }

  // --- Configuration screen buttons and Discovery ------------------------------------

  /**
   * "Find the speakers" and the Discovery scan: the addresses whose read is
   * due are read now, the others keep their pace (a button pressed again
   * never reads a speaker sooner than the interval); then the Discovery
   * list is published.
   */
  async scan() {
    if (!this.started || !this.data) {
      return this.devices;
    }
    const due = [...this.links.values()].filter((link) => this.isDue(link));
    const running = [...this.links.values()].filter((link) => link.reading).map((l) => l.reading);
    await Promise.all([...due.map((link) => this.read(link)), ...running]);
    await this.publishDevices();
    return this.devices;
  }

  async findDevices() {
    const devices = await this.scan();
    await this.updateStatus();
    return T.found(devices.map((d) => `${deviceName(d)} (${d.host || '?'})`));
  }

  /** The last read of each speaker, never a new one. */
  checkDevices() {
    if (this.devices.length === 0) {
      return T.noDevice;
    }
    const lines = this.devices.map((device) => {
      const link = this.linkOf(device);
      const age = link?.readAt === undefined ? undefined : this.now() - link.readAt;
      return T.checkLine(
        `${deviceName(device)} (${device.host || '?'})`,
        this.deviceState(device),
        age,
      );
    });
    return T.check(lines, this.config.maxVolume);
  }

  // --- Status ---------------------------------------------------------------------

  async updateStatus() {
    if (!this.started || !this.data) {
      return;
    }
    const notes = [];
    if (this.store.corrupted) {
      notes.push(T.dataReset);
    }
    if (this.config.invalid.length > 0) {
      notes.push(T.invalidEntries(this.config.invalid));
    }
    const silent = this.config.addresses
      .map(addressKey)
      .filter((key) => !this.devices.some((d) => d.host && addressKey(d) === key))
      .filter((key) => this.links.get(key)?.lastError);
    if (silent.length > 0) {
      notes.push(T.noAnswerAt(silent));
    }
    const lost = this.devices.filter((d) => this.created.has(d.id) && !d.host).map(deviceName);
    if (lost.length > 0) {
      notes.push(T.addressUnknown(lost));
    }
    const off = this.devices
      .filter((d) => this.created.has(d.id) && d.host && this.deviceState(d) === null)
      .map(deviceName);
    if (off.length > 0) {
      notes.push(T.unreachable(off));
    }
    // A local integration without an account: "connected" means running; what
    // does not answer is said in the message.
    const message =
      notes.length > 0
        ? { en: notes.map((n) => n.en).join(' '), fr: notes.map((n) => n.fr).join(' ') }
        : undefined;
    const key = JSON.stringify(message ?? null);
    if (key === this.lastStatus) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(true, message);
      this.lastStatus = key;
    } catch (err) {
      this.logger.warn(`Could not publish the status: ${err.message}`);
    }
  }
}
