import { persistentAtom } from '@nanostores/persistent';

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
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
