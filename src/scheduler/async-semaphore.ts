export type SemaphoreRelease = () => void;

export class AsyncSemaphore {
  private available: number;
  private readonly waiters: Array<(release: SemaphoreRelease) => void> = [];

  public constructor(public readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error("Semaphore capacity must be a positive safe integer");
    }
    this.available = capacity;
  }

  public get availablePermits(): number {
    return this.available;
  }

  public async acquire(): Promise<SemaphoreRelease> {
    if (this.available > 0) {
      this.available -= 1;
      return this.createRelease();
    }

    return new Promise<SemaphoreRelease>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  public async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await work();
    } finally {
      release();
    }
  }

  private createRelease(): SemaphoreRelease {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;

      const next = this.waiters.shift();
      if (next === undefined) {
        this.available += 1;
        return;
      }
      next(this.createRelease());
    };
  }
}
