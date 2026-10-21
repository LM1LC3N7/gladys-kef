// -----------------------------------------------------------------------------
// Untrusted answers of a speaker -> clean values (pure). The KEF API is not
// documented: every answer is checked for the exact shape pykefcontrol reads
// (`[ { "<type>": <value>, ... } ]`), one JSON.parse per answer (bounded by
// the transport), only the expected fields of the expected types kept,
// strings cleaned and cut. Anything else is "unreadable" (undefined), never
// a guess.
// -----------------------------------------------------------------------------

import { LIMITS, MODEL_ALIASES } from '../constants.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Control characters (C0, DEL, C1) and bidirectional overrides.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** A display string: control and bidi characters removed, spaces folded, cut. */
export function cleanText(value, max = LIMITS.name) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value
    .slice(0, max * 4)
    .replace(UNSAFE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text === '' ? undefined : [...text].slice(0, max).join('');
}

/** A plain identifier, never a prototype key. */
export const isSafeId = (value) =>
  typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value) &&
  !['__proto__', 'constructor', 'prototype'].includes(value);

/** The first item of an answer `[ {...} ]`, or undefined. */
export function parseItem(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const item = Array.isArray(json) ? json[0] : undefined;
  return isObject(item) ? item : undefined;
}

/** The value of `field` of an item when it has the expected type. */
const field = (item, name, type) =>
  isObject(item) && Object.hasOwn(item, name) && typeof item[name] === type
    ? item[name]
    : undefined;

/** A MAC address as 12 lowercase hex digits (the identity of a speaker), or undefined. */
export function parseMac(item) {
  const raw = field(item, 'string_', 'string');
  if (raw === undefined || raw.length > 40) {
    return undefined;
  }
  const hex = raw.toLowerCase().replace(/[:\-. ]/g, '');
  return /^[0-9a-f]{12}$/.test(hex) && !/^0{12}$|^f{12}$/.test(hex) ? hex : undefined;
}

export const parseName = (item) => cleanText(field(item, 'string_', 'string'), LIMITS.name);

/**
 * `settings:/releasetext`, "<model>_<firmware>" (e.g. "LSXII_4.2.1"): the
 * model, with the aliases of pykefcontrol, and the firmware.
 */
export function parseRelease(item) {
  const raw = field(item, 'string_', 'string');
  if (raw === undefined || raw.length > 200) {
    return {};
  }
  const [model, firmware] = raw.split('_');
  const clean = /^[A-Za-z0-9]{2,20}$/.test(model ?? '') ? model.toUpperCase() : undefined;
  return {
    model: clean ? (MODEL_ALIASES[clean] ?? clean) : undefined,
    firmware: cleanText(firmware, 32),
  };
}

/** `settings:/kef/host/speakerStatus`: true on ("powerOn"), false in standby, else undefined. */
export function parseStatus(item) {
  const raw = field(item, 'kefSpeakerStatus', 'string');
  return raw === 'powerOn' ? true : raw === 'standby' ? false : undefined;
}

/** `settings:/kef/play/physicalSource`: a plain identifier ("wifi", "standby"...), else undefined. */
export function parseSource(item) {
  const raw = field(item, 'kefPhysicalSource', 'string');
  return isSafeId(raw) ? raw : undefined;
}

/** `player:volume`: an integer 0..100, else undefined. */
export function parseVolume(item) {
  const raw = field(item, 'i32_', 'number');
  return Number.isInteger(raw) && raw >= 0 && raw <= 100 ? raw : undefined;
}

/** `settings:/mediaPlayer/mute`: a boolean, else undefined. */
export const parseMute = (item) => field(item, 'bool_', 'boolean');

const PLAY_STATES = new Set(['playing', 'paused', 'stopped', 'buffering', 'transitioning']);

/** `player:player/data`: { state, title, artist } with what is readable. */
export function parsePlayer(item) {
  if (!isObject(item)) {
    return undefined;
  }
  const state = field(item, 'state', 'string');
  const track = isObject(item.trackRoles) ? item.trackRoles : {};
  const media = isObject(track.mediaData) ? track.mediaData : {};
  const meta = isObject(media.metaData) ? media.metaData : {};
  return {
    state: PLAY_STATES.has(state) ? state : state === undefined ? undefined : 'other',
    title: cleanText(field(track, 'title', 'string'), LIMITS.title),
    artist: cleanText(field(meta, 'artist', 'string'), LIMITS.title),
  };
}

/** "Artist - Title", or the title alone, or undefined. */
export function nowPlaying(player) {
  if (!player?.title) {
    return undefined;
  }
  const text = player.artist ? `${player.artist} - ${player.title}` : player.title;
  return [...text].slice(0, LIMITS.title).join('');
}
