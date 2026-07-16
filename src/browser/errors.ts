import type { BrowserStatus } from "../domain/states.js";

export class BrowserLifecycleError extends Error {
  public override readonly cause: unknown;

  public constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "BrowserLifecycleError";
    this.cause = cause;
  }
}

export class BrowserOperationBlockedError extends BrowserLifecycleError {
  public constructor(
    public readonly status: Exclude<BrowserStatus, "ready">,
    message: string,
  ) {
    super(message);
    this.name = "BrowserOperationBlockedError";
  }
}

export class PagePoolClosedError extends BrowserLifecycleError {
  public constructor() {
    super("The browser page pool is closed");
    this.name = "PagePoolClosedError";
  }
}

export class PageLeaseAbortedError extends BrowserLifecycleError {
  public constructor() {
    super("The browser page lease was aborted");
    this.name = "PageLeaseAbortedError";
  }
}
