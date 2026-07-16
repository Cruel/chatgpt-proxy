import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type {
  ArtifactRecord,
  ArtifactType,
} from "../domain/models.js";
import type { TimestampProvider } from "./connection.js";
import {
  mapArtifactRow,
  type ArtifactRow,
} from "./row-mappers.js";

export interface CreateArtifactInput {
  readonly id?: string;
  readonly runId: string;
  readonly artifactType: ArtifactType;
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export class ArtifactRepository {
  public constructor(
    private readonly database: Database.Database,
    private readonly now: TimestampProvider,
  ) {}

  public create(input: CreateArtifactInput): ArtifactRecord {
    if (!/^[a-f\d]{64}$/i.test(input.sha256)) {
      throw new Error("Artifact SHA-256 must contain 64 hexadecimal characters");
    }
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
      throw new Error("Artifact size must be a non-negative safe integer");
    }

    const id = input.id ?? randomUUID();
    this.database
      .prepare<{
        id: string;
        runId: string;
        artifactType: ArtifactType;
        path: string;
        sha256: string;
        sizeBytes: number;
        createdAt: string;
      }>(`
        INSERT INTO artifacts(
          id, run_id, artifact_type, path, sha256, size_bytes, created_at
        ) VALUES (
          @id, @runId, @artifactType, @path, @sha256, @sizeBytes, @createdAt
        )
      `)
      .run({
        id,
        runId: input.runId,
        artifactType: input.artifactType,
        path: input.path,
        sha256: input.sha256.toLowerCase(),
        sizeBytes: input.sizeBytes,
        createdAt: this.now(),
      });
    return this.getRequiredById(id);
  }

  public getRequiredById(id: string): ArtifactRecord {
    const row = this.database
      .prepare<{ id: string }, ArtifactRow>(`
        SELECT * FROM artifacts WHERE id = @id
      `)
      .get({ id });
    if (row === undefined) {
      throw new Error(`Artifact '${id}' was not found`);
    }
    return mapArtifactRow(row);
  }

  public listByRun(runId: string): readonly ArtifactRecord[] {
    return this.database
      .prepare<{ runId: string }, ArtifactRow>(`
        SELECT * FROM artifacts
        WHERE run_id = @runId
        ORDER BY created_at, id
      `)
      .all({ runId })
      .map(mapArtifactRow);
  }

  public countByThread(threadId: string): number {
    const row = this.database
      .prepare<{ threadId: string }, { count: number }>(`
        SELECT COUNT(*) AS count
        FROM artifacts
        INNER JOIN runs ON runs.id = artifacts.run_id
        WHERE runs.thread_id = @threadId
      `)
      .get({ threadId });
    return row?.count ?? 0;
  }
}
