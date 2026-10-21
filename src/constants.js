// -----------------------------------------------------------------------------
// Frozen keys (external ids, features, manifest actions), limits and timings.
// Every key here is stored by Gladys or by its users: never rename one.
// -----------------------------------------------------------------------------

/** `gladys.externalIds(DEVICE_TYPE, <MAC address of the speaker, 12 hex digits>)`. */
export const DEVICE_TYPE = 'kef';

export const FEATURES = Object.freeze({
  /** Read only: 1 on, 0 in standby (or unreachable). */
  POWER: 'power',
  /** Push button: wakes the speaker up. */
  POWER_ON: 'power_on',
  /** Push button: puts the speaker in standby. Never queued, never blocked. */
  STANDBY: 'standby',
  /** 0..100, capped by the `max_volume` option. */
  VOLUME: 'volume',
  /** Push button: mutes (volume 0, the previous volume kept), or unmutes at most at the cap. */
  MUTE: 'mute',
  PLAY: 'play',
  /** Protective: never queued. */
  PAUSE: 'pause',
  NEXT: 'next',
  PREVIOUS: 'previous',
  /** Read only: 1 playing, 0 otherwise. */
  PLAYBACK: 'playback',
  SOURCE: 'source',
  /** Read only: "Artist - Title" of what plays. */
  TITLE: 'title',
});

export const ACTIONS = Object.freeze({
  FIND: 'find_devices',
  CHECK: 'check_devices',
});

/** The KEF API listens on plain HTTP. */
export const DEFAULT_PORT = 80;

/** The paths of the speaker API (`/api/getData`, `/api/setData`), as pykefcontrol uses them. */
export const PATHS = Object.freeze({
  MAC: 'settings:/system/primaryMacAddress',
  NAME: 'settings:/deviceName',
  RELEASE: 'settings:/releasetext',
  STATUS: 'settings:/kef/host/speakerStatus',
  SOURCE: 'settings:/kef/play/physicalSource',
  VOLUME: 'player:volume',
  MUTE: 'settings:/mediaPlayer/mute',
  PLAYER: 'player:player/data',
  CONTROL: 'player:player/control',
});

/**
 * The inputs pykefcontrol names (`set_source`). Fixed: they are the select
 * options, frozen at creation (the speaker gives no list).
 */
export const SOURCES = Object.freeze([
  { value: 'wifi', label: 'Wi-Fi' },
  { value: 'bluetooth', label: 'Bluetooth' },
  { value: 'tv', label: 'TV (HDMI eARC)' },
  { value: 'optic', label: 'Optical' },
  { value: 'coaxial', label: 'Coaxial' },
  { value: 'analog', label: 'Analog' },
]);

/** The models pykefcontrol 0.9.3 writes to with POST; the others get GET (query string). */
export const POST_MODELS = Object.freeze(['LS50WII', 'LSXIILT', 'LSXII', 'LS60']);
export const MODEL_ALIASES = Object.freeze({
  LS50W2: 'LS50WII',
  LSX2LT: 'LSXIILT',
  LSX2: 'LSXII',
});

/** The volume cap of the configuration, in percent. */
export const MAX_VOLUME = Object.freeze({ min: 1, max: 100, default: 40 });

/** The poll interval of the configuration, in seconds. */
export const POLL_INTERVAL = Object.freeze({ min: 5, max: 300, default: 10 });

/** Volume set by "unmute" when no previous volume is known (pykefcontrol uses 15), capped too. */
export const UNMUTE_DEFAULT = 15;

export const TIMINGS = Object.freeze({
  /** One HTTP request to a speaker. */
  requestTimeout: 2_500,
  /** No request is started with less time left than this. */
  minRequest: 150,
  /**
   * Gladys waits 5 s for the ack of a command: the whole command (wait in the
   * queue, identity read, write and read-back included) gets `commandBudget`;
   * a read made before the write gets `preRead` at most.
   */
  commandBudget: 3_500,
  preRead: 1_200,
  /** Between two read-backs of a value being confirmed. */
  confirmEvery: 250,
  /** After this many failed reads in a row, the speaker shows as off (power 0). */
  offlineAfter: 2,
  /** Then the reads are spaced: doubled from the interval up to `backoffMax`. */
  backoffMax: 5 * 60_000,
  /**
   * After a wake-up asked by Gladys (Power on, a source chosen in standby, a
   * volume left above the cap): the cap is checked `wakeChecks` times, every
   * `wakeCheckDelay`, whatever the first checks found (a volume raised while
   * the speaker wakes up is lowered too).
   */
  wakeCheckDelay: 2_500,
  wakeChecks: 6,
  /**
   * After a Standby not confirmed: the standby is asserted again, every
   * `guardDelay`, `guardChecks` times, whenever the speaker reads "on".
   */
  guardDelay: 2_500,
  guardChecks: 8,
  /** The states of one device are published at most this often. */
  publishDelay: 1_000,
  /** Writes to /data of the device table are grouped. */
  persistDelay: 1_000,
  /** The time of the last read of each address is written to /data at most this often. */
  attemptPersistEvery: 60_000,
  /** The background round: status, created devices read again. */
  tick: 30_000,
});

export const LIMITS = Object.freeze({
  devices: 20,
  addresses: 20,
  /** Size of one answer of a speaker (the player data is the largest, a few KB). */
  answerBytes: 64 * 1024,
  /** Length of a published title, and of a name. */
  title: 200,
  name: 64,
  /** POST /state admits 300 states per minute per integration: this one stays under. */
  statesPerMinute: 250,
  /** Commands waiting for one device. */
  queue: 16,
});

/** What a text feature shows when nothing plays. */
export const NOTHING = '—';
