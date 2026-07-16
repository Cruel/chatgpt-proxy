import type { RunState } from "../domain/states.js";

export class PersistenceError extends Error {
  public override readonly cause: unknown;

  public constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "PersistenceError";
    this.cause = cause;
  }
}

export class ThreadNameConflictError extends PersistenceError {
  public constructor(name: string, cause?: unknown) {
    super(`A thread named '${name}' already exists`, cause);
    this.name = "ThreadNameConflictError";
  }
}

export class ThreadNotFoundError extends PersistenceError {
  public constructor(threadId: string) {
    super(`Thread '${threadId}' was not found`);
    this.name = "ThreadNotFoundError";
  }
}

export class RunNotFoundError extends PersistenceError {
  public constructor(runId: string) {
    super(`Run '${runId}' was not found`);
    this.name = "RunNotFoundError";
  }
}

export class IdempotencyConflictError extends PersistenceError {
  public constructor(key: string) {
    super(`Idempotency key '${key}' was already used with different input`);
    this.name = "IdempotencyConflictError";
  }
}

export class InvalidRunTransitionError extends PersistenceError {
  public constructor(runId: string, currentState: RunState, nextState: RunState) {
    super(
      `Run '${runId}' cannot transition from '${currentState}' to '${nextState}'`,
    );
    this.name = "InvalidRunTransitionError";
  }
}

export function isSqliteConstraintError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  return String(error.code).startsWith("SQLITE_CONSTRAINT");
}
