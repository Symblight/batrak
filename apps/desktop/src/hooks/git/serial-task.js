/** Runs an async job at most once at a time; a request while it runs runs it again afterwards. */
export class SerialTask {
  /** @type {() => Promise<void>} */
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

  /**
   * @param {() => Promise<void>} job Handles its own errors.
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
    this.#timer = setTimeout(() => this.#run(), Math.max(0, Math.min(delay, left)));
  }

  /** Drops a pending run; one in progress finishes, and its caller fences the result. */
  cancel() {
    clearTimeout(this.#timer);
    this.#asked = null;
    this.#again = false;
  }

  async #run() {
    this.#asked = null;
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = true;
    try {
      await this.#job();
    } finally {
      this.#running = false;
      if (this.#again) {
        this.#again = false;
        this.#run();
      }
    }
  }
}
