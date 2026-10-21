// -----------------------------------------------------------------------------
// Every state sent to Gladys goes through here. POST /state admits 300
// states per minute per integration: a sliding one-minute window, shared by
// every device and every caller, keeps this one under LIMITS.statesPerMinute.
// Publications run one after the other (the room is taken before the
// request, never after), so two publications at the same time can never
// both spend the same room. Only the changed values are sent; what does not
// fit is held back and goes with a later publication (power first, the
// title last). The ack of a command never waits for this.
// -----------------------------------------------------------------------------

import { LIMITS } from './constants.js';
import { statePriority } from './model.js';

const WINDOW_MS = 60_000;

const valueOf = (s) => (s.text === undefined ? `n:${s.state}` : `t:${s.text}`);

export class StatePublisher {
  constructor({ gladys, logger, now = Date.now, perMinute = LIMITS.statesPerMinute }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.perMinute = perMinute;
    /** [at, count] of what was sent in the last minute */
    this.sent = [];
    /** feature external id -> value last accepted by Gladys */
    this.published = new Map();
    this.chain = Promise.resolve();
  }

  used() {
    const since = this.now() - WINDOW_MS;
    while (this.sent.length > 0 && this.sent[0][0] <= since) {
      this.sent.shift();
    }
    return this.sent.reduce((sum, [, count]) => sum + count, 0);
  }

  /** Gladys forgot what it had (a reconnection, a device created): everything again. */
  forget(prefix) {
    if (prefix === undefined) {
      this.published.clear();
      this.gladys.forgetPublishedStates?.();
      return;
    }
    for (const id of [...this.published.keys()]) {
      if (id.startsWith(`${prefix}:`)) {
        this.published.delete(id);
      }
    }
    this.gladys.forgetPublishedStates?.(prefix);
  }

  /** Publishes what changed in `states`, within the room left. Resolves the count sent. */
  publish(states) {
    const run = this.chain.then(() => this.run(states));
    this.chain = run.catch(() => {});
    return run;
  }

  async run(states) {
    const changed = states
      .filter(
        (s) =>
          (Number.isFinite(s.state) || typeof s.text === 'string') &&
          this.published.get(s.device_feature_external_id) !== valueOf(s),
      )
      .sort(
        (a, b) =>
          statePriority(a.device_feature_external_id) - statePriority(b.device_feature_external_id),
      );
    const room = Math.max(0, this.perMinute - this.used());
    const batch = changed.slice(0, room);
    if (changed.length > batch.length) {
      this.logger.debug?.(`${changed.length - batch.length} state(s) held back (state budget)`);
    }
    if (batch.length === 0) {
      return 0;
    }
    // Counted before the request: Gladys may count them even when it fails.
    this.sent.push([this.now(), batch.length]);
    // At most 100 states per request (the SDK refuses more).
    for (let start = 0; start < batch.length; start += 100) {
      const part = batch.slice(start, start + 100);
      try {
        await this.gladys.publishStates(part);
        part.forEach((s) => this.published.set(s.device_feature_external_id, valueOf(s)));
      } catch (err) {
        this.logger.warn(`States not published: ${err.message}`);
      }
    }
    return batch.length;
  }
}
