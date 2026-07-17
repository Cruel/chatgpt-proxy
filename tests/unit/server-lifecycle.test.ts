import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  installGracefulShutdown,
  type ProcessSignalSource,
} from "../../src/operations/index.js";
import type { ProxyRuntime } from "../../src/runtime.js";

class TestSignalSource extends EventEmitter implements ProcessSignalSource {
  public override on(event: NodeJS.Signals, listener: () => void): this {
    return super.on(event, listener);
  }

  public override off(event: NodeJS.Signals, listener: () => void): this {
    return super.off(event, listener);
  }
}

function runtime(close: () => Promise<void>): ProxyRuntime {
  return {
    close,
    queue: {
      getSnapshot: () => ({
        state: "running",
        activeRunCount: 1,
        queuedRunCount: 2,
        dispatchEnabled: true,
      }),
    },
  } as unknown as ProxyRuntime;
}

describe("graceful shutdown", () => {
  it("ignores wrapper signal cascades and forces only a repeated signal", async () => {
    let finishShutdown: (() => void) | undefined;
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishShutdown = resolve;
        }),
    );
    const signalSource = new TestSignalSource();
    const forceExit = vi.fn();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const controller = installGracefulShutdown({
      runtime: runtime(close),
      logger,
      signalSource,
      forceExit,
    });

    signalSource.emit("SIGTERM");
    expect(close).toHaveBeenCalledTimes(1);
    expect(forceExit).not.toHaveBeenCalled();
    signalSource.emit("SIGINT");
    expect(close).toHaveBeenCalledTimes(1);
    expect(forceExit).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: "SIGINT",
        initiatingSignal: "SIGTERM",
      }),
      expect.stringContaining("wrapper shutdown signal ignored"),
    );
    signalSource.emit("SIGTERM");
    expect(forceExit).toHaveBeenCalledWith(1);

    finishShutdown?.();
    await controller.request("manual");
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        activeRunCount: 1,
        queuedRunCount: 2,
      }),
      expect.stringContaining("graceful shutdown started"),
    );
    controller.dispose();
    expect(signalSource.listenerCount("SIGINT")).toBe(0);
    expect(signalSource.listenerCount("SIGTERM")).toBe(0);
    expect(signalSource.listenerCount("SIGHUP")).toBe(0);
  });

  it("reports shutdown failures without invoking the forced-exit path", async () => {
    const failure = new Error("synthetic close failure");
    const forceExit = vi.fn();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const controller = installGracefulShutdown({
      runtime: runtime(() => Promise.reject(failure)),
      logger,
      signalSource: new TestSignalSource(),
      forceExit,
    });

    await expect(controller.request("manual")).rejects.toBe(failure);
    expect(logger.error).toHaveBeenCalled();
    expect(forceExit).not.toHaveBeenCalled();
    controller.dispose();
  });
});
