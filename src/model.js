// -----------------------------------------------------------------------------
// Known speakers -> Gladys devices and states (pure). One Gladys device per
// speaker, keyed by its MAC address: the IP address may change, the MAC
// address does not.
//
// The categories and types are the ones of the Gladys core: `music` like the
// core Sonos service (volume, play, pause, next, previous, playback state),
// `television/volume-mute` for the mute press (music has no mute type),
// `text/select` for the source, `text/text` for the title, `button/push` for
// "Power on" and "Standby", and the power state read only (`unknown/binary`):
// no switch, nothing an "everything on / off" (voice assistants, scenes) could
// turn into a command. No unit: the core lists none for these categories.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { DEVICE_TYPE, FEATURES, NOTHING, SOURCES } from './constants.js';
import { nowPlaying } from './kef/parse.js';

/** The feature definitions, by frozen key, in their frozen order. */
export const FEATURE_SPECS = Object.freeze({
  [FEATURES.POWER]: {
    name: 'Power',
    category: C.UNKNOWN,
    type: T.SENSOR.BINARY,
    min: 0,
    max: 1,
    read_only: true,
    keep_history: true,
  },
  [FEATURES.POWER_ON]: {
    name: 'Power on',
    category: C.BUTTON,
    type: T.BUTTON.PUSH,
    min: 0,
    max: 1,
  },
  [FEATURES.STANDBY]: { name: 'Standby', category: C.BUTTON, type: T.BUTTON.PUSH, min: 0, max: 1 },
  [FEATURES.VOLUME]: {
    name: 'Volume',
    category: C.MUSIC,
    type: T.MUSIC.VOLUME,
    min: 0,
    max: 100,
    has_feedback: true,
  },
  [FEATURES.MUTE]: {
    name: 'Mute',
    category: C.TELEVISION,
    type: T.TELEVISION.VOLUME_MUTE,
    min: 0,
    max: 1,
    has_feedback: true,
  },
  [FEATURES.PLAY]: { name: 'Play', category: C.MUSIC, type: T.MUSIC.PLAY, min: 1, max: 1 },
  [FEATURES.PAUSE]: { name: 'Pause', category: C.MUSIC, type: T.MUSIC.PAUSE, min: 1, max: 1 },
  [FEATURES.NEXT]: { name: 'Next', category: C.MUSIC, type: T.MUSIC.NEXT, min: 1, max: 1 },
  [FEATURES.PREVIOUS]: {
    name: 'Previous',
    category: C.MUSIC,
    type: T.MUSIC.PREVIOUS,
    min: 1,
    max: 1,
  },
  [FEATURES.PLAYBACK]: {
    name: 'Playback',
    category: C.MUSIC,
    type: T.MUSIC.PLAYBACK_STATE,
    min: 0,
    max: 1,
    read_only: true,
  },
  [FEATURES.SOURCE]: {
    name: 'Source',
    category: C.TEXT,
    type: T.TEXT.SELECT,
    min: 0,
    max: 0,
    has_feedback: true,
  },
  [FEATURES.TITLE]: {
    name: 'Now playing',
    category: C.TEXT,
    type: T.TEXT.TEXT,
    min: 0,
    max: 0,
    read_only: true,
  },
});

export const isSource = (value) => SOURCES.some((s) => s.value === value);

export function deviceName(device) {
  const name = device.name || `KEF ${device.id}`;
  return device.model && !name.includes(device.model) ? `${name} (${device.model})` : name;
}

export function buildDevice(gladys, device) {
  const ids = gladys.externalIds(DEVICE_TYPE, device.id);
  return {
    name: deviceName(device),
    external_id: ids.device,
    should_poll: false,
    params: [{ name: 'IP_ADDRESS', value: device.host || '' }],
    // Always the full, fixed list: a device published again never loses a feature.
    features: Object.entries(FEATURE_SPECS).map(([key, { name, ...spec }]) => ({
      name,
      external_id: ids.feature(key),
      read_only: false,
      has_feedback: false,
      keep_history: false,
      ...spec,
      ...(key === FEATURES.SOURCE
        ? { supported_options: SOURCES.map(({ value, label }) => ({ value, label })) }
        : {}),
    })),
  };
}

/** The feature key of a feature external id of `device`, or undefined. */
export function featureKey(deviceExternalId, featureExternalId) {
  const prefix = `${deviceExternalId}:`;
  return String(featureExternalId ?? '').startsWith(prefix)
    ? String(featureExternalId).slice(prefix.length)
    : undefined;
}

/**
 * The states of a speaker. `state` is the last read ({ on, source, volume,
 * mute, player }), `null` for a speaker that does not answer (power 0 only),
 * undefined for "nothing known" (nothing published). Never undefined nor NaN
 * in a state: a value not read is left out.
 */
export function stateList(gladys, device, state) {
  if (state === undefined) {
    return [];
  }
  const ids = gladys.externalIds(DEVICE_TYPE, device.id);
  const id = (key) => ids.feature(key);
  if (state === null) {
    return [{ device_feature_external_id: id(FEATURES.POWER), state: 0 }];
  }
  const states = [];
  if (typeof state.on === 'boolean') {
    states.push({ device_feature_external_id: id(FEATURES.POWER), state: state.on ? 1 : 0 });
  }
  if (Number.isInteger(state.volume)) {
    states.push({ device_feature_external_id: id(FEATURES.VOLUME), state: state.volume });
  }
  if (typeof state.mute === 'boolean' || Number.isInteger(state.volume)) {
    const muted = state.mute === true || state.volume === 0;
    states.push({ device_feature_external_id: id(FEATURES.MUTE), state: muted ? 1 : 0 });
  }
  if (isSource(state.source)) {
    states.push({ device_feature_external_id: id(FEATURES.SOURCE), text: state.source });
  }
  if (state.on === false) {
    states.push({ device_feature_external_id: id(FEATURES.PLAYBACK), state: 0 });
    states.push({ device_feature_external_id: id(FEATURES.TITLE), text: NOTHING });
  } else if (state.player) {
    if (state.player.state !== undefined) {
      states.push({
        device_feature_external_id: id(FEATURES.PLAYBACK),
        state: state.player.state === 'playing' ? 1 : 0,
      });
    }
    states.push({
      device_feature_external_id: id(FEATURES.TITLE),
      text: nowPlaying(state.player) ?? NOTHING,
    });
  }
  return states;
}

/** The priority of a feature under the state budget: power first, the title last. */
export const statePriority = (externalId) =>
  externalId.endsWith(`:${FEATURES.POWER}`) ? 0 : externalId.endsWith(`:${FEATURES.TITLE}`) ? 2 : 1;
