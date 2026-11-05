import { persistentAtom, persistentMap } from '@nanostores/persistent';

/**
 * @template T
 * @typedef {Object} PersistentStoreOptions
 * @property {(raw: unknown) => T | null} parse Validates parsed JSON; `null` (old format, hand-edited data)
 *   falls back to the initial value.
 * @property {(value: T) => unknown} [serialize] What to store, e.g. the value minus runtime-only fields.
 * @property {boolean} [listen] Follow changes made by other windows (`storage` events). Default `true`;
 *   turn it off for per-window state.
 */

/**
 * Atom kept as JSON in `localStorage` under `key`.
 * @template T
 * @param {string} key Prefixed `brama:`.
 * @param {T} initial
 * @param {PersistentStoreOptions<T>} options
 * @returns {import('nanostores').WritableAtom<T>}
 */
export function persistentStore(key, initial, { parse, serialize = (value) => value, listen = true }) {
  return persistentAtom(key, initial, {
    listen,
    encode: (value) => JSON.stringify(serialize(value)),
    decode: (raw) => {
      try {
        return parse(JSON.parse(raw)) ?? initial;
      } catch {
        return initial;
      }
    },
  });
}

/**
 * Map kept in `localStorage` as one JSON item per key, `prefix` + key. Only `setKey()` writes, and it
 * writes just that key, so windows sharing the prefix never overwrite each other's other entries.
 * Per window unless `listen`: other windows' writes are then picked up on the next mount only.
 * @template T
 * @param {string} prefix Prefixed `brama:`, ending in `:`.
 * @param {(raw: unknown) => T | null} parse Validates one entry; `null` drops it.
 * @param {{ listen?: boolean }} [options] `listen`: follow other windows' writes (`storage` events; an entry
 *   they remove becomes `undefined`). Default `false`.
 * @returns {import('nanostores').MapStore<Record<string, T | undefined>>}
 */
export function persistentMapStore(prefix, parse, { listen = false } = {}) {
  return persistentMap(prefix, /** @type {Record<string, T | undefined>} */ ({}), {
    listen,
    encode: (/** @type {T | undefined} */ value) => JSON.stringify(value),
    // An entry decoded to `undefined` reads as missing.
    decode: (/** @type {string} */ raw) => {
      try {
        return parse(JSON.parse(raw)) ?? undefined;
      } catch {
        return undefined;
      }
    },
  });
}

/**
 * What `localStorage` holds under `key` right now (a map store's entry is `prefix` + key), whatever a
 * store has heard of other windows; `null` when nothing or when storage is unavailable.
 * @param {string} key
 * @returns {string | null}
 */
export function storedItem(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
