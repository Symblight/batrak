/** Runs an async job at most once at a time; a request while it runs runs it again afterwards. */
export class SerialTask {
  /** @type {() => Promise<void>} */
  #job;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #timer;
  /** The job is running. */
  #running = false;
  /** A request came in while it ran. */
  #again = false;

  /** @param {() => Promise<void>} job Handles its own errors. */
  constructor(job) {
    this.#job = job;
  }

  /** @param {number} delay Ms to wait for more requests; a pending run is replaced. */
  schedule(delay) {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#run(), delay);
  }

  /** Drops a pending run; one in progress finishes, and its caller fences the result. */
  cancel() {
    clearTimeout(this.#timer);
    this.#again = false;
  }

  async #run() {
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
