/**
 * Tiny FIFO semaphore for bounding concurrent async operations. Used to cap
 * the number of `dv` processes we spawn at once — clicking around in the SCM
 * Graph can easily try to issue many `dv diff` calls in parallel, and on a
 * cold daemon each one is meaningfully expensive.
 *
 * The capacity is mutable so settings changes can take effect without an
 * extension reload: increasing it drains queued waiters immediately, and
 * decreasing it just leaves in-flight calls alone (they release naturally).
 */
export class Semaphore {
  private capacity: number;
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity | 0);
  }

  setCapacity(n: number): void {
    this.capacity = Math.max(1, n | 0);
    // If we just got more headroom, wake waiters until we hit the new cap.
    while (this.inFlight < this.capacity && this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      this.inFlight++;
      next();
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.capacity) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.inFlight++;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.inFlight--;
    }
  }

  /** For diagnostics only. */
  stats(): { inFlight: number; queued: number; capacity: number } {
    return { inFlight: this.inFlight, queued: this.waiters.length, capacity: this.capacity };
  }
}
