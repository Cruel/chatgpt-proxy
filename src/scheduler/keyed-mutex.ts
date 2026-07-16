import { AsyncSemaphore } from "./async-semaphore.js";

interface MutexEntry {
  readonly semaphore: AsyncSemaphore;
  references: number;
}

export class KeyedMutex {
  private readonly entries = new Map<string, MutexEntry>();

  public get activeKeyCount(): number {
    return this.entries.size;
  }

  public async runExclusive<T>(
    key: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const entry = this.getOrCreateEntry(key);
    entry.references += 1;
    try {
      return await entry.semaphore.runExclusive(work);
    } finally {
      entry.references -= 1;
      if (entry.references === 0) {
        this.entries.delete(key);
      }
    }
  }

  private getOrCreateEntry(key: string): MutexEntry {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const created: MutexEntry = {
      semaphore: new AsyncSemaphore(1),
      references: 0,
    };
    this.entries.set(key, created);
    return created;
  }
}
