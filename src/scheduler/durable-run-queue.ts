import type { Logger } from "pino";

import type { RunRecord } from "../domain/models.js";
import { isCompletedRunState } from "../domain/run-transitions.js";
import type {
  ApiErrorCode,
  SubmissionState,
} from "../domain/states.js";
import type { Persistence } from "../db/persistence.js";
import type {
  CreateRunInput,
  CreateRunResult,
} from "../db/run-repository.js";
import { AsyncSemaphore } from "./async-semaphore.js";
import { QueueClosedError, QueueFullError } from "./errors.js";
import { KeyedMutex } from "./keyed-mutex.js";
import {
  reconcileInterruptedRuns,
  type ReconciledRun,
} from "./restart-reconciliation.js";

export type ActiveExecutionState = "navigating" | "submitting" | "running";

export interface ExecutionProgress {
  readonly state: ActiveExecutionState;
  readonly phase: string;
  readonly submissionState?: SubmissionState;
}

export interface RunExecutionContext {
  readonly signal: AbortSignal;
  readonly persistence: Persistence;
  updateProgress(progress: ExecutionProgress): RunRecord;
  recordEvent(
    eventType: string,
    payload?: Readonly<Record<string, unknown>>,
  ): void;
}

export type RunExecutionResult =
  | {
      readonly outcome: "succeeded";
      readonly finalResponse: string | null;
    }
  | {
      readonly outcome: "failed" | "timed_out" | "needs_attention";
      readonly errorCode: ApiErrorCode;
      readonly errorMessage: string;
    }
  | {
      readonly outcome: "cancelled";
      readonly errorCode: ApiErrorCode | null;
      readonly errorMessage: string | null;
    };

export interface RunExecutor {
  execute(
    run: RunRecord,
    context: RunExecutionContext,
  ): Promise<RunExecutionResult>;
}

export interface DurableRunQueueOptions {
  readonly persistence: Persistence;
  readonly executor: RunExecutor;
  readonly maxConcurrentRuns: number;
  readonly maxQueueDepth: number;
  readonly logger?: Pick<Logger, "debug" | "error" | "info" | "warn">;
}

const NOOP_LOGGER: Pick<Logger, "debug" | "error" | "info" | "warn"> = {
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
};

export class DurableRunQueue {
  private readonly persistence: Persistence;
  private readonly executor: RunExecutor;
  private readonly maxConcurrentRuns: number;
  private readonly maxQueueDepth: number;
  private readonly logger: Pick<Logger, "debug" | "error" | "info" | "warn">;
  private readonly semaphore: AsyncSemaphore;
  private readonly threadLocks = new KeyedMutex();
  private readonly inFlight = new Map<string, {
    readonly threadId: string;
    readonly promise: Promise<void>;
  }>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly runWaiters = new Map<
    string,
    Set<{
      readonly resolve: (run: RunRecord) => void;
      readonly reject: (error: Error) => void;
    }>
  >();
  private started = false;
  private closed = false;
  private pumpScheduled = false;

  public constructor(options: DurableRunQueueOptions) {
    if (
      !Number.isSafeInteger(options.maxConcurrentRuns) ||
      options.maxConcurrentRuns < 1
    ) {
      throw new Error("maxConcurrentRuns must be a positive safe integer");
    }
    if (
      !Number.isSafeInteger(options.maxQueueDepth) ||
      options.maxQueueDepth < 1
    ) {
      throw new Error("maxQueueDepth must be a positive safe integer");
    }

    this.persistence = options.persistence;
    this.executor = options.executor;
    this.maxConcurrentRuns = options.maxConcurrentRuns;
    this.maxQueueDepth = options.maxQueueDepth;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.semaphore = new AsyncSemaphore(options.maxConcurrentRuns);
  }

  public start(): readonly ReconciledRun[] {
    if (this.closed) {
      throw new QueueClosedError();
    }
    if (this.started) {
      return [];
    }

    const reconciled = reconcileInterruptedRuns(this.persistence);
    this.started = true;
    this.schedulePump();
    return reconciled;
  }

  public enqueue(input: CreateRunInput): CreateRunResult {
    if (this.closed) {
      throw new QueueClosedError();
    }

    const idempotencyKey = input.idempotencyKey?.trim();
    if (idempotencyKey !== undefined && idempotencyKey.length > 0) {
      const existing = this.persistence.runs.findByIdempotency(
        input.threadId,
        input.operationType,
        idempotencyKey,
      );
      if (existing !== null) {
        return this.persistence.runs.createOrGet(input);
      }
    }

    if (this.persistence.runs.countQueued() >= this.maxQueueDepth) {
      throw new QueueFullError(this.maxQueueDepth);
    }

    const result = this.persistence.runs.createOrGet(input);
    if (result.created) {
      this.persistence.runEvents.append(result.run.id, "run_queued", {
        operation_type: result.run.operationType,
      });
      this.schedulePump();
    }
    return result;
  }

  public async waitForIdle(): Promise<void> {
    if (!this.started) {
      throw new Error("Durable run queue must be started before waiting for idle");
    }
    if (this.isIdle()) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.idleWaiters.add(resolve);
      this.resolveIdleWaiters();
    });
  }

  public waitForRun(runId: string): Promise<RunRecord> {
    const current = this.persistence.runs.getRequiredById(runId);
    if (this.isWaitTerminal(current)) {
      return Promise.resolve(current);
    }
    if (this.closed) {
      return Promise.reject(new QueueClosedError());
    }

    return new Promise<RunRecord>((resolve, reject) => {
      const waiter = { resolve, reject };
      const waiters = this.runWaiters.get(runId) ?? new Set();
      waiters.add(waiter);
      this.runWaiters.set(runId, waiters);

      const rechecked = this.persistence.runs.getRequiredById(runId);
      if (this.isWaitTerminal(rechecked)) {
        waiters.delete(waiter);
        if (waiters.size === 0) {
          this.runWaiters.delete(runId);
        }
        resolve(rechecked);
      }
    });
  }

  public async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.inFlight.values()].map((entry) => entry.promise));
    const closeError = new QueueClosedError();
    for (const waiters of this.runWaiters.values()) {
      for (const waiter of waiters) {
        waiter.reject(closeError);
      }
    }
    this.runWaiters.clear();
    this.resolveIdleWaiters();
  }

  private schedulePump(): void {
    if (!this.started || this.closed || this.pumpScheduled) {
      return;
    }

    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    if (!this.started || this.closed) {
      return;
    }

    const activeThreadIds = new Set(
      [...this.inFlight.values()].map((entry) => entry.threadId),
    );
    const candidates = this.persistence.runs.listQueued(this.maxQueueDepth);

    for (const run of candidates) {
      if (this.inFlight.size >= this.maxConcurrentRuns) {
        break;
      }
      if (activeThreadIds.has(run.threadId)) {
        continue;
      }

      activeThreadIds.add(run.threadId);
      this.launch(run);
    }

    this.resolveIdleWaiters();
  }

  private launch(run: RunRecord): void {
    const promise = Promise.resolve()
      .then(() =>
        this.semaphore.runExclusive(() =>
          this.threadLocks.runExclusive(run.threadId, () =>
            this.executeClaimedRun(run.id),
          ),
        ),
      )
      .catch((error: unknown) => {
        this.logger.error({ error, runId: run.id }, "scheduled run failed");
      })
      .finally(() => {
        this.inFlight.delete(run.id);
        this.schedulePump();
        this.resolveIdleWaiters();
      });

    this.inFlight.set(run.id, { threadId: run.threadId, promise });
  }

  private async executeClaimedRun(runId: string): Promise<void> {
    const claimed = this.persistence.runs.claimQueued(runId);
    if (claimed === null) {
      return;
    }

    this.persistence.runEvents.append(runId, "run_started", {
      state: claimed.state,
      phase: claimed.phase,
    });

    const controller = new AbortController();
    const context: RunExecutionContext = {
      signal: controller.signal,
      persistence: this.persistence,
      updateProgress: (progress) => {
        const updated = this.persistence.runs.transition(
          runId,
          progress.submissionState === undefined
            ? { state: progress.state, phase: progress.phase }
            : {
                state: progress.state,
                phase: progress.phase,
                submissionState: progress.submissionState,
              },
        );
        this.persistence.runEvents.append(runId, "run_progress", {
          state: updated.state,
          phase: updated.phase,
          submission_state: updated.submissionState,
        });
        return updated;
      },
      recordEvent: (eventType, payload = {}) => {
        this.persistence.runEvents.append(runId, eventType, payload);
      },
    };

    try {
      const result = await this.executor.execute(claimed, context);
      this.persistOutcome(runId, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.persistence.runs.transition(runId, {
        state: "failed",
        phase: "executor_failed",
        errorCode: "unexpected_state",
        errorMessage: message,
      });
      this.persistence.runEvents.append(runId, "run_failed_unexpectedly", {
        message,
      });
      this.notifyRunWaiters(runId);
      this.logger.error({ error, runId }, "run executor threw unexpectedly");
    }
  }

  private persistOutcome(runId: string, result: RunExecutionResult): void {
    if (result.outcome === "succeeded") {
      this.persistence.runs.transition(runId, {
        state: "succeeded",
        phase: "completed",
        finalResponse: result.finalResponse,
      });
    } else {
      this.persistence.runs.transition(runId, {
        state: result.outcome,
        phase: result.outcome,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
      });
    }

    this.persistence.runEvents.append(runId, "run_finished", {
      outcome: result.outcome,
    });
    this.notifyRunWaiters(runId);
  }

  private isIdle(): boolean {
    return this.inFlight.size === 0 && this.persistence.runs.countQueued() === 0;
  }

  private resolveIdleWaiters(): void {
    if (!this.isIdle()) {
      return;
    }

    for (const resolve of this.idleWaiters) {
      resolve();
    }
    this.idleWaiters.clear();
  }

  private isWaitTerminal(run: RunRecord): boolean {
    return run.state === "needs_attention" || isCompletedRunState(run.state);
  }

  private notifyRunWaiters(runId: string): void {
    const waiters = this.runWaiters.get(runId);
    if (waiters === undefined) {
      return;
    }
    const run = this.persistence.runs.getRequiredById(runId);
    if (!this.isWaitTerminal(run)) {
      return;
    }

    this.runWaiters.delete(runId);
    for (const waiter of waiters) {
      waiter.resolve(run);
    }
  }
}
