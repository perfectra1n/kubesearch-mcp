/** Bound how many async operations run at the same time. */
export class Semaphore {
  private available: number;
  private waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.available = Math.max(1, limit);
  }

  private acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    // Hand the permit straight to the next waiter rather than incrementing —
    // otherwise a caller arriving before the waiter resumes could take it and
    // push us over the limit.
    const next = this.waiters.shift();
    if (next) next();
    else this.available++;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
