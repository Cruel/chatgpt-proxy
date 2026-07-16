export class SchedulerError extends Error {
  public override readonly cause: unknown;

  public constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "SchedulerError";
    this.cause = cause;
  }
}

export class QueueFullError extends SchedulerError {
  public constructor(maxQueueDepth: number) {
    super(`Durable run queue has reached its limit of ${maxQueueDepth}`);
    this.name = "QueueFullError";
  }
}

export class QueueClosedError extends SchedulerError {
  public constructor() {
    super("Durable run queue is closed");
    this.name = "QueueClosedError";
  }
}
