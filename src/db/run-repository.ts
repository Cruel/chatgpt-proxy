import { createHash, randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import {
  canTransitionRunState,
  isCompletedRunState,
} from "../domain/run-transitions.js";
import type {
  RunRecord,
  ThreadMessageRecord,
} from "../domain/models.js";
import type {
  OperationType,
  RunState,
  SubmissionState,
  ThinkingLevel,
} from "../domain/states.js";
import {
  IdempotencyConflictError,
  InvalidRunTransitionError,
  RunNotFoundError,
} from "./errors.js";
import {
  mapRunRow,
  type RunRow,
} from "./row-mappers.js";
import type { TimestampProvider } from "./connection.js";

export interface CreateRunInput {
  readonly id?: string;
  readonly threadId: string;
  readonly operationType: OperationType;
  readonly inputText?: string | null;
  readonly idempotencyKey?: string | null;
  readonly thinkingLevel?: ThinkingLevel;
  readonly deleteRemoteRequested?: boolean;
  readonly deleteRemotePermitted?: boolean;
}

export interface CreateRunResult {
  readonly run: RunRecord;
  readonly created: boolean;
}

export interface RunTransitionInput {
  readonly state: RunState;
  readonly phase: string;
  readonly submissionState?: SubmissionState;
  readonly finalResponse?: string | null;
  readonly errorCode?: string | null;
  readonly errorMessage?: string | null;
}

function hashInput(inputText: string | null): string | null {
  return inputText === null
    ? null
    : createHash("sha256").update(inputText, "utf8").digest("hex");
}

function normalizeIdempotencyKey(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const key = value.trim();
  if (key.length === 0 || key.length > 255) {
    throw new Error("Idempotency key must contain between 1 and 255 characters");
  }
  return key;
}

export class RunRepository {
  public constructor(
    private readonly database: Database.Database,
    private readonly now: TimestampProvider,
  ) {}

  public createOrGet(input: CreateRunInput): CreateRunResult {
    const inputText = input.inputText ?? null;
    const inputSha256 = hashInput(inputText);
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const thinkingLevel = input.thinkingLevel ?? "medium";
    const deleteRemoteRequested = input.deleteRemoteRequested ?? false;
    const deleteRemotePermitted = input.deleteRemotePermitted ?? false;

    return this.database.transaction(() => {
      if (idempotencyKey !== null) {
        const existing = this.findByIdempotency(
          input.threadId,
          input.operationType,
          idempotencyKey,
        );
        if (existing !== null) {
          if (
            existing.inputSha256 !== inputSha256 ||
            existing.thinkingLevel !== thinkingLevel ||
            existing.deleteRemoteRequested !== deleteRemoteRequested ||
            existing.deleteRemotePermitted !== deleteRemotePermitted
          ) {
            throw new IdempotencyConflictError(idempotencyKey);
          }
          return { run: existing, created: false };
        }
      }

      const id = input.id ?? randomUUID();
      this.database
        .prepare<{
          id: string;
          threadId: string;
          operationType: OperationType;
          inputText: string | null;
          inputSha256: string | null;
          idempotencyKey: string | null;
          thinkingLevel: ThinkingLevel;
          deleteRemoteRequested: number;
          deleteRemotePermitted: number;
          createdAt: string;
        }>(`
          INSERT INTO runs(
            id,
            thread_id,
            operation_type,
            input_text,
            input_sha256,
            idempotency_key,
            thinking_level,
            state,
            phase,
            submission_state,
            delete_remote_requested,
            delete_remote_permitted,
            created_at
          ) VALUES (
            @id,
            @threadId,
            @operationType,
            @inputText,
            @inputSha256,
            @idempotencyKey,
            @thinkingLevel,
            'queued',
            'queued',
            'not_started',
            @deleteRemoteRequested,
            @deleteRemotePermitted,
            @createdAt
          )
        `)
        .run({
          id,
          threadId: input.threadId,
          operationType: input.operationType,
          inputText,
          inputSha256,
          idempotencyKey,
          thinkingLevel,
          deleteRemoteRequested: deleteRemoteRequested ? 1 : 0,
          deleteRemotePermitted: deleteRemotePermitted ? 1 : 0,
          createdAt: this.now(),
        });

      return { run: this.getRequiredById(id), created: true };
    }).immediate();
  }

  public getById(id: string): RunRecord | null {
    const row = this.database
      .prepare<{ id: string }, RunRow>("SELECT * FROM runs WHERE id = @id")
      .get({ id });
    return row === undefined ? null : mapRunRow(row);
  }

  public getRequiredById(id: string): RunRecord {
    const run = this.getById(id);
    if (run === null) {
      throw new RunNotFoundError(id);
    }
    return run;
  }

  public findByIdempotency(
    threadId: string,
    operationType: OperationType,
    idempotencyKey: string,
  ): RunRecord | null {
    const row = this.database
      .prepare<
        {
          threadId: string;
          operationType: OperationType;
          idempotencyKey: string;
        },
        RunRow
      >(`
        SELECT * FROM runs
        WHERE thread_id = @threadId
          AND operation_type = @operationType
          AND idempotency_key = @idempotencyKey
      `)
      .get({ threadId, operationType, idempotencyKey });
    return row === undefined ? null : mapRunRow(row);
  }

  public listQueued(limit = 100): readonly RunRecord[] {
    return this.database
      .prepare<{ limit: number }, RunRow>(`
        SELECT * FROM runs
        WHERE state = 'queued'
        ORDER BY created_at, id
        LIMIT @limit
      `)
      .all({ limit })
      .map(mapRunRow);
  }

  public countQueued(): number {
    const row = this.database
      .prepare<[], { count: number }>(`
        SELECT COUNT(*) AS count FROM runs WHERE state = 'queued'
      `)
      .get();
    return row?.count ?? 0;
  }

  public listActive(): readonly RunRecord[] {
    return this.database
      .prepare<[], RunRow>(`
        SELECT * FROM runs
        WHERE state IN ('navigating', 'submitting', 'running')
        ORDER BY created_at, id
      `)
      .all()
      .map(mapRunRow);
  }

  public listByThread(threadId: string): readonly RunRecord[] {
    return this.database
      .prepare<{ threadId: string }, RunRow>(`
        SELECT * FROM runs
        WHERE thread_id = @threadId
        ORDER BY created_at, id
      `)
      .all({ threadId })
      .map(mapRunRow);
  }

  public listMessagesByThread(
    threadId: string,
  ): readonly ThreadMessageRecord[] {
    return this.database
      .prepare<{ threadId: string }, RunRow>(`
        SELECT * FROM runs
        WHERE thread_id = @threadId
          AND operation_type IN ('create_thread', 'send_message')
          AND input_text IS NOT NULL
        ORDER BY created_at, id
      `)
      .all({ threadId })
      .map(mapRunRow)
      .map((run) => ({
        runId: run.id,
        operationType: run.operationType as Extract<
          OperationType,
          "create_thread" | "send_message"
        >,
        inputText: run.inputText as string,
        finalResponse: run.finalResponse,
        state: run.state,
        createdAt: run.createdAt,
        completedAt: run.completedAt,
      }));
  }

  public claimQueued(runId: string, phase = "navigating"): RunRecord | null {
    const result = this.database
      .prepare<{ runId: string; phase: string; startedAt: string }>(`
        UPDATE runs
        SET state = 'navigating',
            phase = @phase,
            started_at = COALESCE(started_at, @startedAt),
            completed_at = NULL,
            error_code = NULL,
            error_message = NULL
        WHERE id = @runId AND state = 'queued'
      `)
      .run({ runId, phase, startedAt: this.now() });
    return result.changes === 1 ? this.getRequiredById(runId) : null;
  }

  public releaseClaim(runId: string): RunRecord {
    const result = this.database
      .prepare<{ runId: string }>(`
        UPDATE runs
        SET state = 'queued',
            phase = 'queued',
            submission_state = 'not_started',
            started_at = NULL,
            completed_at = NULL,
            error_code = NULL,
            error_message = NULL
        WHERE id = @runId
          AND state = 'navigating'
          AND submission_state = 'not_started'
      `)
      .run({ runId });
    if (result.changes !== 1) {
      const current = this.getRequiredById(runId);
      throw new InvalidRunTransitionError(runId, current.state, "queued");
    }
    return this.getRequiredById(runId);
  }

  public transition(runId: string, input: RunTransitionInput): RunRecord {
    return this.database.transaction(() => {
      const current = this.getRequiredById(runId);
      if (!canTransitionRunState(current.state, input.state)) {
        throw new InvalidRunTransitionError(runId, current.state, input.state);
      }

      const timestamp = this.now();
      const startedAt =
        input.state === "queued"
          ? null
          : (current.startedAt ?? timestamp);
      const completedAt = isCompletedRunState(input.state) ? timestamp : null;
      const submissionState =
        input.state === "queued"
          ? "not_started"
          : (input.submissionState ?? current.submissionState);

      this.database
        .prepare<{
          runId: string;
          state: RunState;
          phase: string;
          submissionState: SubmissionState;
          finalResponse: string | null;
          errorCode: string | null;
          errorMessage: string | null;
          startedAt: string | null;
          completedAt: string | null;
        }>(`
          UPDATE runs
          SET state = @state,
              phase = @phase,
              submission_state = @submissionState,
              final_response = @finalResponse,
              error_code = @errorCode,
              error_message = @errorMessage,
              started_at = @startedAt,
              completed_at = @completedAt
          WHERE id = @runId
        `)
        .run({
          runId,
          state: input.state,
          phase: input.phase,
          submissionState,
          finalResponse: input.finalResponse ?? null,
          errorCode: input.errorCode ?? null,
          errorMessage: input.errorMessage ?? null,
          startedAt,
          completedAt,
        });

      return this.getRequiredById(runId);
    }).immediate();
  }
}
