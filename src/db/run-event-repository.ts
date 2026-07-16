import type Database from "better-sqlite3";

import type { RunEventRecord } from "../domain/models.js";
import type { TimestampProvider } from "./connection.js";
import {
  mapRunEventRow,
  type RunEventRow,
} from "./row-mappers.js";

export class RunEventRepository {
  public constructor(
    private readonly database: Database.Database,
    private readonly now: TimestampProvider,
  ) {}

  public append(
    runId: string,
    eventType: string,
    payload: Readonly<Record<string, unknown>> = {},
  ): RunEventRecord {
    const payloadJson = JSON.stringify(payload);
    const result = this.database
      .prepare<{
        runId: string;
        eventType: string;
        payloadJson: string;
        createdAt: string;
      }>(`
        INSERT INTO run_events(run_id, event_type, payload_json, created_at)
        VALUES (@runId, @eventType, @payloadJson, @createdAt)
      `)
      .run({ runId, eventType, payloadJson, createdAt: this.now() });

    const row = this.database
      .prepare<{ id: number }, RunEventRow>(`
        SELECT * FROM run_events WHERE id = @id
      `)
      .get({ id: Number(result.lastInsertRowid) });
    if (row === undefined) {
      throw new Error("Inserted run event could not be reloaded");
    }
    return mapRunEventRow(row);
  }

  public listByRun(runId: string): readonly RunEventRecord[] {
    return this.database
      .prepare<{ runId: string }, RunEventRow>(`
        SELECT * FROM run_events WHERE run_id = @runId ORDER BY id
      `)
      .all({ runId })
      .map(mapRunEventRow);
  }
}
