import type { BrowserAdapter } from "../browser/adapter.js";
import type { AppConfig } from "../config/schema.js";
import {
  IdempotencyConflictError,
  RunNotFoundError,
  ThreadNameConflictError,
} from "../db/errors.js";
import type { Persistence } from "../db/persistence.js";
import type { RunRecord, ThreadRecord } from "../domain/models.js";
import { decideDeletionPolicy } from "../domain/deletion-policy.js";
import type { DurableRunQueue } from "../scheduler/durable-run-queue.js";
import { QueueFullError } from "../scheduler/errors.js";
import { runOperationalDiagnostics } from "../operations/index.js";
import {
  presentDeletionStatus,
  presentRun,
  presentThread,
  presentThreadDetail,
} from "../api/presenters.js";
import { ProxyServiceError } from "./errors.js";

const WAIT_TERMINAL_STATES = new Set([
  "needs_attention",
  "succeeded",
  "failed",
  "timed_out",
  "interrupted",
  "cancelled",
]);

export interface MutationOptions {
  readonly wait: boolean;
  readonly idempotencyKey: string | undefined;
}

export interface ServiceCreateThreadInput extends MutationOptions {
  readonly name: string;
  readonly message: string;
}

export interface ServiceSendMessageInput extends MutationOptions {
  readonly name: string;
  readonly message: string;
}

export interface ServiceDeleteThreadInput extends MutationOptions {
  readonly name: string;
  readonly deleteRemote: boolean;
}

export interface MutationResult {
  readonly run: ReturnType<typeof presentRun>;
  readonly thread: ReturnType<typeof presentThread>;
  readonly completed: boolean;
}

export class ProxyService {
  public constructor(
    private readonly config: AppConfig,
    private readonly persistence: Persistence,
    private readonly queue: DurableRunQueue,
    private readonly adapter: BrowserAdapter,
  ) {}

  public async getBrowserStatus() {
    const status = await this.adapter.getStatus();
    return {
      ...status,
      queuedRunCount: this.persistence.runs.countQueued(),
    };
  }

  public getDoctorReport() {
    return runOperationalDiagnostics({
      config: this.config,
      persistence: this.persistence,
      queue: this.queue,
      adapter: this.adapter,
    });
  }

  public listThreads(includeDeleted: boolean) {
    return {
      threads: this.persistence.threads.list(includeDeleted).map((thread) =>
        presentThread(thread, this.persistence.runs.listByThread(thread.id)),
      ),
    };
  }

  public getThread(name: string) {
    const thread = this.requireThread(name);
    return presentThreadDetail(this.persistence, thread);
  }

  public getRun(runId: string) {
    try {
      const run = this.persistence.runs.getRequiredById(runId);
      const events = this.persistence.runEvents.listByRun(run.id);
      return {
        run: presentRun(run),
        deletion: presentDeletionStatus(run, events),
      };
    } catch (error) {
      if (error instanceof RunNotFoundError) {
        throw new ProxyServiceError("run_not_found", 404, error.message);
      }
      throw error;
    }
  }

  public async createThread(
    input: ServiceCreateThreadInput,
  ): Promise<MutationResult> {
    this.validateMessage(input.message);
    const existing = this.persistence.threads.getByName(input.name);
    if (existing !== null) {
      if (input.idempotencyKey === undefined) {
        throw new ProxyServiceError(
          "thread_already_exists",
          409,
          `A thread named '${input.name}' already exists`,
        );
      }
      const priorRun = this.persistence.runs.findByIdempotency(
        existing.id,
        "create_thread",
        input.idempotencyKey,
      );
      if (priorRun === null) {
        throw new ProxyServiceError(
          "thread_already_exists",
          409,
          `A thread named '${input.name}' already exists`,
        );
      }
      const result = this.enqueueSafely({
        threadId: existing.id,
        operationType: "create_thread",
        inputText: input.message,
        idempotencyKey: input.idempotencyKey ?? null,
      });
      return this.finishMutation(existing.id, result.run, input.wait);
    }

    let thread: ThreadRecord;
    let run: RunRecord;
    try {
      ({ thread, run } = this.persistence.transaction(() => {
        const reserved = this.persistence.threads.create({ name: input.name });
        const result = this.enqueueSafely({
          threadId: reserved.id,
          operationType: "create_thread",
          inputText: input.message,
          idempotencyKey: input.idempotencyKey ?? null,
        });
        return { thread: reserved, run: result.run };
      }));
    } catch (error) {
      if (error instanceof ThreadNameConflictError) {
        throw new ProxyServiceError(
          "thread_already_exists",
          409,
          error.message,
        );
      }
      throw error;
    }

    return this.finishMutation(thread.id, run, input.wait);
  }

  public async sendMessage(
    input: ServiceSendMessageInput,
  ): Promise<MutationResult> {
    this.validateMessage(input.message);
    const thread = this.requireThread(input.name);
    if (input.idempotencyKey !== undefined) {
      const priorRun = this.persistence.runs.findByIdempotency(
        thread.id,
        "send_message",
        input.idempotencyKey,
      );
      if (priorRun !== null) {
        const retried = this.enqueueSafely({
          threadId: thread.id,
          operationType: "send_message",
          inputText: input.message,
          idempotencyKey: input.idempotencyKey,
        });
        return this.finishMutation(thread.id, retried.run, input.wait);
      }
    }
    this.assertMutableThread(thread);
    const result = this.enqueueSafely({
      threadId: thread.id,
      operationType: "send_message",
      inputText: input.message,
      idempotencyKey: input.idempotencyKey ?? null,
    });
    if (result.created && thread.state === "idle") {
      this.persistence.threads.setState(thread.id, "running");
    }
    return this.finishMutation(thread.id, result.run, input.wait);
  }

  public async deleteThread(
    input: ServiceDeleteThreadInput,
  ): Promise<MutationResult> {
    const thread = this.requireThread(input.name);
    if (input.idempotencyKey !== undefined) {
      const priorRun = this.persistence.runs.findByIdempotency(
        thread.id,
        "delete_thread",
        input.idempotencyKey,
      );
      if (priorRun !== null) {
        const retried = this.enqueueSafely({
          threadId: thread.id,
          operationType: "delete_thread",
          idempotencyKey: input.idempotencyKey,
          deleteRemoteRequested: input.deleteRemote,
          deleteRemotePermitted: priorRun.deleteRemotePermitted,
        });
        return this.finishMutation(thread.id, retried.run, input.wait);
      }
    }
    if (thread.state === "delete_pending") {
      throw new ProxyServiceError(
        "thread_busy",
        409,
        `Thread '${thread.name}' already has a deletion operation pending`,
      );
    }
    if (
      input.deleteRemote &&
      (thread.state === "deleted_local" || thread.state === "deleted_remote")
    ) {
      throw new ProxyServiceError(
        "thread_deleted",
        409,
        "A remotely deleting request cannot act on a tombstoned local thread",
      );
    }

    const policy = decideDeletionPolicy({
      remoteDeletionConfigured: this.config.chatGpt.deleteRemoteThread,
      remoteDeletionRequested: input.deleteRemote,
    });
    if (policy.kind === "rejected") {
      throw new ProxyServiceError(
        policy.errorCode,
        409,
        "Remote thread deletion is disabled by server configuration",
      );
    }

    const result = this.enqueueSafely({
      threadId: thread.id,
      operationType: "delete_thread",
      idempotencyKey: input.idempotencyKey ?? null,
      deleteRemoteRequested: input.deleteRemote,
      deleteRemotePermitted: policy.kind === "remote_allowed",
    });
    if (
      result.created &&
      thread.state !== "deleted_local" &&
      thread.state !== "deleted_remote"
    ) {
      this.persistence.threads.setState(thread.id, "delete_pending");
    }
    return this.finishMutation(thread.id, result.run, input.wait);
  }

  private enqueueSafely(
    input: Parameters<DurableRunQueue["enqueue"]>[0],
  ) {
    try {
      return this.queue.enqueue(input);
    } catch (error) {
      if (error instanceof QueueFullError) {
        throw new ProxyServiceError("queue_full", 429, error.message);
      }
      if (error instanceof IdempotencyConflictError) {
        throw new ProxyServiceError("idempotency_conflict", 409, error.message);
      }
      throw error;
    }
  }

  private async finishMutation(
    threadId: string,
    initialRun: RunRecord,
    wait: boolean,
  ): Promise<MutationResult> {
    const run = wait ? await this.waitForRun(initialRun.id) : initialRun;
    const thread = this.persistence.threads.getRequiredById(threadId);
    return {
      run: presentRun(run),
      thread: presentThread(
        thread,
        this.persistence.runs.listByThread(thread.id),
      ),
      completed: WAIT_TERMINAL_STATES.has(run.state),
    };
  }

  private async waitForRun(runId: string): Promise<RunRecord> {
    return this.queue.waitForRun(runId);
  }

  private requireThread(name: string): ThreadRecord {
    const thread = this.persistence.threads.getByName(name);
    if (thread === null) {
      throw new ProxyServiceError(
        "thread_not_found",
        404,
        `Thread '${name}' was not found`,
      );
    }
    return thread;
  }

  private assertMutableThread(thread: ThreadRecord): void {
    if (thread.state === "deleted_local" || thread.state === "deleted_remote") {
      throw new ProxyServiceError(
        "thread_deleted",
        409,
        `Thread '${thread.name}' has been deleted locally`,
      );
    }
    if (
      thread.state === "delete_pending" ||
      thread.state === "delete_failed" ||
      thread.state === "needs_attention" ||
      thread.state === "orphaned" ||
      thread.state === "error"
    ) {
      throw new ProxyServiceError(
        "thread_busy",
        409,
        `Thread '${thread.name}' is not ready for a new message (${thread.state})`,
      );
    }
  }

  private validateMessage(message: string): void {
    const characterCount = [...message].length;
    const byteCount = Buffer.byteLength(message, "utf8");
    if (
      characterCount > this.config.limits.maxInputCharacters ||
      byteCount > this.config.limits.maxInputBytes
    ) {
      throw new ProxyServiceError(
        "input_too_large",
        413,
        "Input exceeds the configured character or byte limit",
        {
          characterCount,
          byteCount,
          maxCharacterCount: this.config.limits.maxInputCharacters,
          maxByteCount: this.config.limits.maxInputBytes,
        },
      );
    }
  }
}
