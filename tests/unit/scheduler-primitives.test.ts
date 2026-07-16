import { describe, expect, it } from "vitest";

import { AsyncSemaphore, KeyedMutex } from "../../src/scheduler/index.js";

describe("scheduler concurrency primitives", () => {
  it("bounds work with a fair semaphore", async () => {
    const semaphore = new AsyncSemaphore(1);
    const firstRelease = await semaphore.acquire();
    const order: string[] = [];
    const second = semaphore.runExclusive(() => {
      order.push("second");
      return Promise.resolve();
    });
    const third = semaphore.runExclusive(() => {
      order.push("third");
      return Promise.resolve();
    });

    await Promise.resolve();
    expect(order).toEqual([]);
    firstRelease();
    await Promise.all([second, third]);
    expect(order).toEqual(["second", "third"]);
    expect(semaphore.availablePermits).toBe(1);
  });

  it("serializes only matching mutex keys and cleans up entries", async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = mutex.runExclusive("one", async () => {
      order.push("one:start");
      await firstGate;
      order.push("one:end");
    });
    const second = mutex.runExclusive("one", () => {
      order.push("one:second");
      return Promise.resolve();
    });
    const other = mutex.runExclusive("two", () => {
      order.push("two");
      return Promise.resolve();
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toContain("one:start");
    expect(order).toContain("two");
    expect(order).not.toContain("one:second");

    releaseFirst?.();
    await Promise.all([first, second, other]);
    expect(order.indexOf("one:second")).toBeGreaterThan(order.indexOf("one:end"));
    expect(mutex.activeKeyCount).toBe(0);
  });
});
