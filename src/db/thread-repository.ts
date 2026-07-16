import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type { ThreadRecord } from "../domain/models.js";
import type { ThreadState } from "../domain/states.js";
import { normalizeThreadName } from "../domain/thread-name.js";
import {
  isSqliteConstraintError,
  ThreadNameConflictError,
  ThreadNotFoundError,
} from "./errors.js";
import {
  mapThreadRow,
  type ThreadRow,
} from "./row-mappers.js";
import type { TimestampProvider } from "./connection.js";

export interface CreateThreadInput {
  readonly id?: string;
  readonly name: string;
  readonly state?: ThreadState;
}

export interface RemoteThreadMapping {
  readonly conversationId: string;
  readonly url: string;
  readonly title: string | null;
}

export class ThreadRepository {
  public constructor(
    private readonly database: Database.Database,
    private readonly now: TimestampProvider,
  ) {}

  public create(input: CreateThreadInput): ThreadRecord {
    const name = input.name.trim();
    const normalizedName = normalizeThreadName(name);
    if (normalizedName.length === 0) {
      throw new Error("Thread name must not be empty");
    }

    const timestamp = this.now();
    const id = input.id ?? randomUUID();

    try {
      this.database
        .prepare<{
          id: string;
          name: string;
          normalizedName: string;
          state: ThreadState;
          timestamp: string;
        }>(`
          INSERT INTO threads(
            id, name, normalized_name, state, created_at, updated_at
          ) VALUES (
            @id, @name, @normalizedName, @state, @timestamp, @timestamp
          )
        `)
        .run({
          id,
          name,
          normalizedName,
          state: input.state ?? "provisioning",
          timestamp,
        });
    } catch (error) {
      if (isSqliteConstraintError(error) && this.getByName(name) !== null) {
        throw new ThreadNameConflictError(name, error);
      }
      throw error;
    }

    return this.getRequiredById(id);
  }

  public getById(id: string): ThreadRecord | null {
    const row = this.database
      .prepare<{ id: string }, ThreadRow>("SELECT * FROM threads WHERE id = @id")
      .get({ id });
    return row === undefined ? null : mapThreadRow(row);
  }

  public getRequiredById(id: string): ThreadRecord {
    const thread = this.getById(id);
    if (thread === null) {
      throw new ThreadNotFoundError(id);
    }
    return thread;
  }

  public getByName(name: string): ThreadRecord | null {
    const normalizedName = normalizeThreadName(name);
    const row = this.database
      .prepare<{ normalizedName: string }, ThreadRow>(`
        SELECT * FROM threads WHERE normalized_name = @normalizedName
      `)
      .get({ normalizedName });
    return row === undefined ? null : mapThreadRow(row);
  }

  public list(includeDeleted = false): readonly ThreadRecord[] {
    const sql = includeDeleted
      ? "SELECT * FROM threads ORDER BY created_at, id"
      : `
          SELECT * FROM threads
          WHERE state NOT IN ('deleted_local', 'deleted_remote')
          ORDER BY created_at, id
        `;
    return this.database
      .prepare<[], ThreadRow>(sql)
      .all()
      .map(mapThreadRow);
  }

  public setRemoteMapping(
    threadId: string,
    mapping: RemoteThreadMapping,
  ): ThreadRecord {
    const result = this.database
      .prepare<{
        threadId: string;
        conversationId: string;
        url: string;
        title: string | null;
        updatedAt: string;
      }>(`
        UPDATE threads
        SET remote_conversation_id = @conversationId,
            remote_url = @url,
            remote_title = @title,
            updated_at = @updatedAt
        WHERE id = @threadId
      `)
      .run({
        threadId,
        conversationId: mapping.conversationId,
        url: mapping.url,
        title: mapping.title,
        updatedAt: this.now(),
      });
    if (result.changes !== 1) {
      throw new ThreadNotFoundError(threadId);
    }
    return this.getRequiredById(threadId);
  }

  public setState(
    threadId: string,
    state: ThreadState,
    errorCode: string | null = null,
    errorMessage: string | null = null,
  ): ThreadRecord {
    const timestamp = this.now();
    const deletedAt =
      state === "deleted_local" || state === "deleted_remote"
        ? timestamp
        : null;
    const remoteDeletedAt = state === "deleted_remote" ? timestamp : null;
    const result = this.database
      .prepare<{
        threadId: string;
        state: ThreadState;
        updatedAt: string;
        deletedAt: string | null;
        remoteDeletedAt: string | null;
        errorCode: string | null;
        errorMessage: string | null;
      }>(`
        UPDATE threads
        SET state = @state,
            updated_at = @updatedAt,
            deleted_at = COALESCE(@deletedAt, deleted_at),
            remote_deleted_at = COALESCE(@remoteDeletedAt, remote_deleted_at),
            last_error_code = @errorCode,
            last_error_message = @errorMessage
        WHERE id = @threadId
      `)
      .run({
        threadId,
        state,
        updatedAt: timestamp,
        deletedAt,
        remoteDeletedAt,
        errorCode,
        errorMessage,
      });
    if (result.changes !== 1) {
      throw new ThreadNotFoundError(threadId);
    }
    return this.getRequiredById(threadId);
  }
}
