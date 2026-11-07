/** Runs an async job one at a time, a request during a run running it again afterwards; only a superseded run can overlap the next. */
export class SerialTask {
  /** @type {(isCurrent: () => boolean) => Promise<void>} */
  #job;
  /** Longest ms a run waits while requests keep coming. */
  #maxWait;
  /** @type {number | null} When the oldest request not yet run came in. */
  #asked = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #timer;
  /** The job is running. */
  #running = false;
  /** A request came in while it ran. */
  #again = false;
  /** Bumped by `supersede()`: a run from an older one is dead. */
  #generation = 0;

  /**
   * @param {(isCurrent: () => boolean) => Promise<void>} job Handles its own errors; `isCurrent` turns false once it is superseded.
   * @param {number} [maxWait] Longest ms a run waits while requests keep coming.
   */
  constructor(job, maxWait = Infinity) {
    this.#job = job;
    this.#maxWait = maxWait;
  }

  /** @param {number} delay Ms to wait for more requests; a pending run is replaced. */
  schedule(delay) {
    clearTimeout(this.#timer);
    this.#asked ??= Date.now();
    const left = this.#maxWait - (Date.now() - this.#asked);
    this.#timer = setTimeout(() => this.run(), Math.max(0, Math.min(delay, left)));
  }

  /** Drops a pending run; one in progress finishes, and its caller fences the result. */
  cancel() {
    clearTimeout(this.#timer);
    this.#asked = null;
    this.#again = false;
  }

  /** Drops a pending run and makes the one in progress dead, so the next run needn't wait for it. */
  supersede() {
    this.cancel();
    this.#generation++;
    this.#running = false;
  }

  /** Runs now, in place of a pending run; if one is in progress, again right after it. */
  async run() {
    clearTimeout(this.#timer);
    this.#asked = null;
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = true;
    const generation = this.#generation;
    try {
      await this.#job(() => generation === this.#generation);
    } finally {
      if (generation === this.#generation) {
        this.#running = false;
        if (this.#again) {
          this.#again = false;
          this.run();
        }
      }
    }
  }
}
