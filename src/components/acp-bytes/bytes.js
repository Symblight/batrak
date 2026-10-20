const UNITS = ['B', 'KB', 'MB', 'GB'];

/**
 * A byte count that coerces to a plain number for comparisons (`size > maxUpload`)
 * and to a formatted string for display (`` `${size}` ``).
 */
export class Bytes {
  /** @param {number} n */
  constructor(n) {
    this.n = n;
  }

  /**
   * @param {"number" | "string" | "default"} hint
   * @returns {number | string}
   */
  [Symbol.toPrimitive](hint) {
    if (hint === 'number') return this.n;
    let i = 0;
    let v = this.n;
    while (v >= 1024 && i < UNITS.length - 1) {
      v /= 1024;
      i += 1;
    }
    return `${v.toFixed(1)} ${UNITS[i]}`;
  }

  /** @param {Bytes} other */
  equals(other) {
    return this.n === other.n;
  }
}
